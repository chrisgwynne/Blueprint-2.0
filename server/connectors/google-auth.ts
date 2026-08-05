/** Google OAuth access-token durability and refresh helper. */
import fetch from 'node-fetch';
import crypto from 'crypto';
import db from '../db/db.js';
import { encrypt, decrypt } from '../crypto.js';
import { readGoogleOAuthConfig, type GoogleOAuthConfig } from '../lib/google-oauth-config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DURABLE_GOOGLE_SCOPES: Record<string, string[]> = {
  gsc: ['https://www.googleapis.com/auth/webmasters.readonly'],
  ga4: ['https://www.googleapis.com/auth/analytics.readonly'],
  gbp: ['https://www.googleapis.com/auth/business.manage'],
  'google-ads': ['https://www.googleapis.com/auth/adwords'],
  'google-merchant': ['https://www.googleapis.com/auth/content'],
};

interface Credentials {
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  scope?: string | string[];
  scopes?: string[];
  grantedScopes?: string[];
  oauthClientIdFingerprint?: string;
  oauthFamily?: string;
  [key: string]: any;
}
interface ConnectorRow { id: string; type: string; credentials: string; business_id?: string }
interface TokenResult { accessToken: string; expiresAt: number }
interface GoogleAccessTokenOptions { requiredScope?: string; connectorTypes?: string[]; googleOAuthConfig?: GoogleOAuthConfig }

const refreshInFlight = new Map<string, Promise<Credentials>>();

function oauthClientFingerprint(config: GoogleOAuthConfig): string | null {
  return config.clientId ? crypto.createHash('sha256').update(config.clientId).digest('base64url').slice(0, 16) : null;
}

function credentialScopes(creds: Credentials): Set<string> {
  const values = [creds.scope, creds.scopes, creds.grantedScopes];
  const scopes = new Set<string>();
  for (const value of values) {
    const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : [];
    for (const scope of entries) if (String(scope).trim()) scopes.add(String(scope).trim());
  }
  return scopes;
}

export function isDurableGoogleCredential(
  type: string,
  credentials: Credentials,
  config: GoogleOAuthConfig = readGoogleOAuthConfig(),
): boolean {
  const required = DURABLE_GOOGLE_SCOPES[type];
  if (!required) return true;
  const currentFingerprint = oauthClientFingerprint(config);
  if (!credentials.refreshToken?.trim() || !currentFingerprint || credentials.oauthClientIdFingerprint !== currentFingerprint) return false;
  const granted = credentialScopes(credentials);
  return required.every(scope => granted.has(scope));
}

function grantFingerprint(credentials: Credentials): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    refreshToken: credentials.refreshToken ?? null,
    oauthClientIdFingerprint: credentials.oauthClientIdFingerprint ?? null,
    oauthFamily: credentials.oauthFamily ?? null,
    scopes: [...credentialScopes(credentials)].sort(),
  })).digest('base64url');
}

function credentialSnapshotFingerprint(credentials: Credentials): string {
  return crypto.createHash('sha256').update(JSON.stringify(credentials)).digest('base64url');
}

function loadCredentials(connectorRow: Pick<ConnectorRow, 'credentials'> | undefined): Credentials | null {
  if (!connectorRow?.credentials) return null;
  try { return JSON.parse(decrypt(connectorRow.credentials)); } catch { return null; }
}

function isFresh(credentials: Credentials): boolean {
  const expiresAt = Number(credentials.expiresAt ?? 0);
  return Boolean(credentials.accessToken?.trim() && Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000);
}

function hasRequiredScope(credentials: Credentials, requiredScope?: string): boolean {
  return !requiredScope || credentialScopes(credentials).has(requiredScope);
}

async function refreshAccessToken(refreshToken: string, config: GoogleOAuthConfig): Promise<TokenResult> {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) throw new Error('Google OAuth app credentials not configured (Settings → Google OAuth).');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) {
    await res.text().catch(() => '');
    throw new Error(`Google token refresh failed (${res.status}).`);
  }
  const data = await res.json() as { access_token?: unknown; expires_in?: unknown };
  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  const expiresIn = Number(data.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Google returned an invalid token response.');
  return { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
}

/** Refresh one exact durable grant and persist only if its encrypted DB generation is unchanged. */
export async function refreshGoogleConnectorCredentials(
  connector: Pick<ConnectorRow, 'id' | 'type'>,
  credentials: Credentials,
  config?: GoogleOAuthConfig,
): Promise<Credentials> {
  const resolvedConfig = config ?? readGoogleOAuthConfig();
  const storedRow = db.prepare('SELECT credentials FROM connectors WHERE id = ?').get(connector.id) as { credentials?: string } | undefined;
  if (!storedRow?.credentials) throw new Error(`Google ${connector.type} credential is missing; reconnect required.`);
  const storedCiphertext = storedRow.credentials;
  const stored = loadCredentials({ credentials: storedCiphertext });
  if (!stored) throw new Error(`Google ${connector.type} credential is unreadable; reconnect required.`);

  // Fail closed when this operation was started against a grant that has since
  // been replaced. The replacement is never returned or refreshed for a stale caller.
  const callerGeneration = credentialSnapshotFingerprint(credentials);
  const storedSnapshotGeneration = credentialSnapshotFingerprint(stored);
  const storedGeneration = grantFingerprint(stored);
  if (callerGeneration !== storedSnapshotGeneration) {
    throw new Error('Google credential changed; reconnect or retry required.');
  }

  const active = stored;
  if (!isDurableGoogleCredential(connector.type, active, resolvedConfig)) {
    throw new Error(`Google ${connector.type} grant is temporary, under-scoped, or bound to another OAuth client; reconnect required.`);
  }
  if (isFresh(active)) return active;

  const generation = storedGeneration;
  const inFlightKey = `${connector.id}:${generation}`;
  const existing = refreshInFlight.get(inFlightKey);
  if (existing) return existing;

  const pending = (async () => {
    const refreshed = await refreshAccessToken(active.refreshToken as string, resolvedConfig);
    const merged = { ...active, ...refreshed };
    const persisted = db.prepare('UPDATE connectors SET credentials = ? WHERE id = ? AND credentials = ?')
      .run(encrypt(JSON.stringify(merged)), connector.id, storedCiphertext);
    if (persisted.changes === 1) return merged;
    throw new Error('Google credential changed during refresh; reconnect or retry required.');
  })();
  refreshInFlight.set(inFlightKey, pending);
  try { return await pending; }
  finally { if (refreshInFlight.get(inFlightKey) === pending) refreshInFlight.delete(inFlightKey); }
}

/** Find a usable Google token; scoped/source-specific callers require an exact durable grant. */
export async function getValidGoogleAccessToken(businessId: string, options: GoogleAccessTokenOptions = {}): Promise<TokenResult | null> {
  if (!businessId) return null;
  const types = options.connectorTypes?.length ? options.connectorTypes : ['gsc', 'ga4', 'gbp', 'google-ads', 'google-merchant'];
  const placeholders = types.map(() => '?').join(', ');
  const candidates = db.prepare(`SELECT id, type, credentials FROM connectors
    WHERE business_id = ? AND type IN (${placeholders}) AND status != 'disconnected'
    ORDER BY last_sync DESC NULLS LAST, created_at DESC`).all(businessId, ...types) as ConnectorRow[];
  const requireDurable = Boolean(options.requiredScope || options.connectorTypes);
  const resolvedConfig = options.googleOAuthConfig ?? readGoogleOAuthConfig();

  for (const connector of candidates) {
    const creds = loadCredentials(connector);
    if (!creds || !hasRequiredScope(creds, options.requiredScope)) continue;
    if (requireDurable && !isDurableGoogleCredential(connector.type, creds, resolvedConfig)) continue;
    if (isFresh(creds)) return { accessToken: creds.accessToken as string, expiresAt: Number(creds.expiresAt) };
    try {
      const refreshed = await refreshGoogleConnectorCredentials(connector, creds, resolvedConfig);
      if (!hasRequiredScope(refreshed, options.requiredScope) || !isFresh(refreshed)) continue;
      return { accessToken: refreshed.accessToken as string, expiresAt: Number(refreshed.expiresAt) };
    } catch (err) {
      console.warn(`[google-auth] refresh failed for connector ${connector.id}: ${(err as Error).message.substring(0, 200)}`);
    }
  }
  return null;
}
