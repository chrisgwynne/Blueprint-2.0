import { Router } from 'express';
import type { Request, Response } from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import db, { generateId } from '../db/db.js';
import { encrypt, decrypt } from '../crypto.js';
import { isAuthenticated } from '../middleware/auth.js';
import { readGoogleOAuthConfig } from '../lib/google-oauth-config.js';

const router = Router();

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const GOOGLE_FAMILY = 'google';
const GOOGLE_CONNECTOR_SCOPES: Record<string, string[]> = {
  gsc: ['https://www.googleapis.com/auth/webmasters.readonly'],
  ga4: ['https://www.googleapis.com/auth/analytics.readonly'],
  gbp: ['https://www.googleapis.com/auth/business.manage'],
  'google-ads': ['https://www.googleapis.com/auth/adwords'],
  'google-merchant': ['https://www.googleapis.com/auth/content'],
};
const GOOGLE_CONNECTOR_NAMES: Record<string, string> = {
  gsc: 'Google Search Console',
  ga4: 'Google Analytics 4',
  gbp: 'Google Business Profile',
  'google-ads': 'Google Ads',
  'google-merchant': 'Google Merchant Center',
};
const GOOGLE_CONNECTOR_CALLBACKS: Record<string, string> = {
  google: '/api/oauth/google/callback',
  gbp: '/api/oauth/gbp/callback',
  'google-ads': '/api/oauth/google-ads/callback',
  'google-merchant': '/api/oauth/google-merchant/callback',
};

// Self-heal: an old typo in .env.example shipped /api/auth/google/callback
// instead of /api/oauth/google/callback. Anyone who installed before the fix
// has the wrong value in DB and/or process.env. Force-correct on startup so
// they don't keep hitting redirect_uri_mismatch from Google.
function healWrongRedirectUri(uri: string): string {
  if (typeof uri !== 'string') return uri;
  return uri.replace('/api/auth/google/callback', '/api/oauth/google/callback')
            .replace('/api/auth/gbp/callback', '/api/oauth/gbp/callback')
            .replace('/api/auth/google-ads/callback', '/api/oauth/google-ads/callback')
            .replace('/api/auth/google-merchant/callback', '/api/oauth/google-merchant/callback');
}

(function autoHealRedirectUri() {
  try {
    // Heal env (in-memory only — doesn't write back to .env on disk)
    if (process.env.GOOGLE_REDIRECT_URI) {
      const fixed = healWrongRedirectUri(process.env.GOOGLE_REDIRECT_URI);
      if (fixed !== process.env.GOOGLE_REDIRECT_URI) {
        console.warn(`[oauth] Auto-corrected GOOGLE_REDIRECT_URI from '${process.env.GOOGLE_REDIRECT_URI}' to '${fixed}' — please update .env to match.`);
        process.env.GOOGLE_REDIRECT_URI = fixed;
      }
    }
    // Heal DB-stored config
    const row = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get() as { value: string } | null;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { redirect_uri?: string };
      if (parsed.redirect_uri && parsed.redirect_uri.includes('/api/auth/google/callback')) {
        parsed.redirect_uri = healWrongRedirectUri(parsed.redirect_uri);
        db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'google_oauth_config'")
          .run(JSON.stringify(parsed));
        console.warn(`[oauth] Auto-corrected stored google_oauth_config.redirect_uri to ${parsed.redirect_uri}`);
      }
    }
  } catch (err) {
    console.warn('[oauth] auto-heal failed:', (err as Error).message);
  }
})();

// Local helpers (mirrors private functions in google-oauth-config.ts)
const PLACEHOLDER_PATTERNS = [/^your-/i, /GOCSPX-your-client-secret/i, /your-client/i];
function isPlaceholder(v: unknown): boolean {
  if (!v || typeof v !== 'string') return true;
  return PLACEHOLDER_PATTERNS.some(r => r.test(v));
}
function defaultRedirectUri(): string {
  const port = process.env['PORT'] ?? '4000';
  return `http://localhost:${port}/api/oauth/google/callback`;
}

function isGoogleOAuthConfigured(): boolean {
  const { clientId, clientSecret, redirectUri } = readGoogleOAuthConfig();
  return !!(clientId && clientSecret && redirectUri);
}

function sessionHash(req: Request): string | undefined {
  const sid = req.sessionID;
  if (!sid) return undefined;
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'blueprint-dev-secret-please-set-in-env')
    .update(sid)
    .digest('base64url');
}

function clientIdFingerprint(clientId: string | null | undefined): string | null {
  if (!clientId) return null;
  return crypto.createHash('sha256').update(clientId).digest('base64url').slice(0, 16);
}

function getGoogleRedirectUri(routeKey: keyof typeof GOOGLE_CONNECTOR_CALLBACKS): string {
  const { redirectUri: googleRedirect } = readGoogleOAuthConfig();
  const path = GOOGLE_CONNECTOR_CALLBACKS[routeKey]!;
  if (routeKey === 'gbp' && process.env.GBP_REDIRECT_URI) return process.env.GBP_REDIRECT_URI;
  if (routeKey === 'google-ads' && process.env.GOOGLE_ADS_REDIRECT_URI) return process.env.GOOGLE_ADS_REDIRECT_URI;
  if (routeKey === 'google-merchant' && process.env.GOOGLE_MERCHANT_REDIRECT_URI) return process.env.GOOGLE_MERCHANT_REDIRECT_URI;
  if (routeKey === 'google') return googleRedirect;
  return googleRedirect.replace('/api/oauth/google/callback', path);
}

function normalizeGoogleTypes(types: unknown, allowed: string[]): string[] {
  const raw = Array.isArray(types)
    ? types.map(type => typeof type === 'string' ? type.trim() : '')
    : typeof types === 'string' ? types.split(',').map(type => type.trim()) : [];
  if (raw.length === 0 || raw.some(type => !type) || new Set(raw).size !== raw.length) return [];
  return raw.every(type => allowed.includes(type)) ? raw : [];
}

function businessExists(businessId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId));
}

function parseScopes(scope: unknown): Set<string> {
  const values = Array.isArray(scope) ? scope : typeof scope === 'string' ? scope.split(/\s+/) : [];
  return new Set(values.map(s => String(s).trim()).filter(Boolean));
}

function connectorNeedsConsent(businessId: string, type: string, scopes: string[], explicitRepair: boolean): boolean {
  if (explicitRepair) return true;
  const row = db.prepare(
    'SELECT credentials FROM connectors WHERE business_id = ? AND type = ? AND status != ?'
  ).get(businessId, type, 'disconnected') as { credentials: string } | null;
  if (!row?.credentials) return true;
  try {
    const creds = JSON.parse(decrypt(row.credentials));
    if (!creds.refreshToken) return true;
    const currentFingerprint = clientIdFingerprint(readGoogleOAuthConfig().clientId);
    if (!currentFingerprint || creds.oauthClientIdFingerprint !== currentFingerprint) return true;
    const granted = parseScopes(creds.scope);
    for (const s of parseScopes(creds.scopes)) granted.add(s);
    return scopes.some(scope => !granted.has(scope));
  } catch {
    return true;
  }
}

function shouldPromptConsent(businessId: string, types: string[], explicitRepair: boolean): boolean {
  return types.some(type => connectorNeedsConsent(businessId, type, GOOGLE_CONNECTOR_SCOPES[type] ?? [], explicitRepair));
}

async function createGoogleOAuthState(req: Request, input: { businessId: string; routeType: string; types: string[]; config?: Record<string, unknown> }) {
  const { createOAuthState } = await import('../connectors/social/oauth-state.js');
  const userId = (req.session as any).userId as string;
  const liveSessionHash = sessionHash(req);
  if (!liveSessionHash) throw new Error('OAuth session is unavailable. Please log in again.');
  return createOAuthState({
    businessId: input.businessId,
    userId,
    type: input.routeType,
    types: input.types,
    family: GOOGLE_FAMILY,
    sessionHash: liveSessionHash,
    config: input.config,
  });
}

async function validateGoogleOAuthState(req: Request, state: string, routeType: string, allowedTypes: string[]) {
  const { validateOAuthState, OAuthStateError } = await import('../connectors/social/oauth-state.js');
  const userId = (req.session as any)?.userId as string | undefined;
  const liveSessionHash = sessionHash(req);
  if (!userId || !liveSessionHash) throw new OAuthStateError('Session expired. Please log in and restart OAuth.');
  const rawState = String(state);
  const dotIdx = rawState.lastIndexOf('.');
  if (dotIdx < 1) throw new OAuthStateError('Invalid state format.');
  let prelimPayload: { businessId?: string; types?: unknown };
  try {
    prelimPayload = JSON.parse(Buffer.from(rawState.slice(0, dotIdx), 'base64url').toString('utf8'));
  } catch {
    throw new OAuthStateError('Could not decode state payload.');
  }
  if (!prelimPayload.businessId) throw new OAuthStateError('State missing businessId.');
  const exactTypes = normalizeGoogleTypes(prelimPayload.types, allowedTypes);
  if (exactTypes.length === 0) throw new OAuthStateError('State connector types are malformed, empty, duplicated, or unsupported.');
  return validateOAuthState(rawState, userId, prelimPayload.businessId, {
    expectedType: routeType,
    expectedFamily: GOOGLE_FAMILY,
    expectedTypes: exactTypes,
    expectedSessionHash: liveSessionHash,
  });
}

function mergeCredentialPayload(existingCredentials: string | null | undefined, tokens: any, metadata: Record<string, unknown>, preserveExistingRefresh = true) {
  let prev: Record<string, unknown> = {};
  if (existingCredentials) {
    try { prev = JSON.parse(decrypt(existingCredentials)); } catch {}
  }
  const previousScopes = parseScopes(prev.scope);
  for (const scope of parseScopes(prev.scopes)) previousScopes.add(scope);
  const grantedScopes = tokens.scope ? [...parseScopes(tokens.scope)] : [...previousScopes];
  return {
    ...prev,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || (preserveExistingRefresh ? prev.refreshToken : null) || null,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scope: grantedScopes.join(' '),
    scopes: grantedScopes,
    ...metadata,
  };
}

function mergeConfig(existingConfig: string | null | undefined, metadata: Record<string, unknown>) {
  let prev: Record<string, unknown> = {};
  if (existingConfig) {
    try { prev = JSON.parse(existingConfig); } catch {}
  }
  return JSON.stringify({ ...prev, ...metadata });
}

async function exchangeGoogleCode(code: string, clientId: string, clientSecret: string, redirectUri: string) {
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    await tokenRes.text().catch(() => '');
    console.error(`[oauth] Google token exchange failed (${tokenRes.status}).`);
    throw new Error('token_exchange_failed');
  }
  const tokens = await tokenRes.json() as any;
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  const expiresIn = Number(tokens.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('invalid_token_response');
  return { ...tokens, access_token: accessToken, expires_in: expiresIn };
}

async function upsertGoogleConnector(input: {
  businessId: string;
  type: string;
  tokens: any;
  clientId: string;
  redirectUri: string;
  extraConfig?: Record<string, unknown>;
}) {
  const existing = db.prepare(
    'SELECT id, credentials, config FROM connectors WHERE business_id = ? AND type = ?'
  ).get(input.businessId, input.type) as { id: string; credentials: string | null; config: string | null } | null;
  const scopes = GOOGLE_CONNECTOR_SCOPES[input.type] ?? [];
  const fingerprint = clientIdFingerprint(input.clientId);
  let previousFingerprint: string | null = null;
  if (existing?.credentials) {
    try { previousFingerprint = JSON.parse(decrypt(existing.credentials)).oauthClientIdFingerprint ?? null; } catch {}
  }
  const preserveExistingRefresh = Boolean(previousFingerprint && fingerprint && previousFingerprint === fingerprint);
  const credentialMetadata = {
    oauthFamily: GOOGLE_FAMILY,
    oauthClientIdFingerprint: fingerprint,
    grantedScopes: String(input.tokens.scope || '').split(/\s+/).filter(Boolean),
    requiredScopes: scopes,
    redirectUri: input.redirectUri,
  };
  const mergedCredentials = mergeCredentialPayload(existing?.credentials, input.tokens, credentialMetadata, preserveExistingRefresh);
  const granted = parseScopes(mergedCredentials.scope);
  for (const scope of parseScopes(mergedCredentials.scopes)) granted.add(scope);
  const missingScopes = scopes.filter(scope => !granted.has(scope));
  const connectionError = !mergedCredentials.refreshToken
    ? 'Google did not return a refresh token; reconnect with explicit repair/consent.'
    : missingScopes.length
      ? `Google did not grant required scope(s): ${missingScopes.join(', ')}`
      : null;
  const status = connectionError ? 'error' : 'connected';
  const encryptedCreds = encrypt(JSON.stringify(mergedCredentials));
  const config = mergeConfig(existing?.config, {
    oauthFamily: GOOGLE_FAMILY,
    requiredScopes: scopes,
    oauthClientIdFingerprint: fingerprint,
    resourceBinding: input.extraConfig ?? {},
    ...(input.extraConfig ?? {}),
  });
  if (existing) {
    db.prepare(`
      UPDATE connectors
      SET credentials = ?, config = ?, status = ?, last_error = ?
      WHERE id = ?
    `).run(encryptedCreds, config, status, connectionError, existing.id);
    return { id: existing.id, status };
  }
  const id = generateId();
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, status, last_error, config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, input.businessId, input.type, GOOGLE_CONNECTOR_NAMES[input.type] || input.type, encryptedCreds, status, connectionError, config);
  return { id, status };
}

async function initiateDedicatedGoogleOAuth(req: Request, res: Response, input: {
  routeKey: 'gbp' | 'google-ads' | 'google-merchant';
  connectorType: 'gbp' | 'google-ads' | 'google-merchant';
  config?: Record<string, unknown>;
}) {
  const { businessId, repair } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });
  if (!businessExists(String(businessId))) return res.status(404).json({ error: 'Business not found.' });

  const { clientId, clientSecret } = readGoogleOAuthConfig();
  const redirectUri = getGoogleRedirectUri(input.routeKey);
  if (!clientId || !clientSecret || !redirectUri) {
    return res.redirect(`${clientUrl}/connectors?error=google_oauth_not_configured&detail=${encodeURIComponent('Configure Google OAuth in Settings → Google OAuth first.')}`);
  }

  const state = await createGoogleOAuthState(req, {
    businessId: String(businessId),
    routeType: input.connectorType,
    types: [input.connectorType],
    config: input.config,
  });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: (GOOGLE_CONNECTOR_SCOPES[input.connectorType] ?? []).join(' '),
    access_type: 'offline',
    state,
  });
  if (shouldPromptConsent(String(businessId), [input.connectorType], repair === '1' || repair === 'true')) {
    params.set('prompt', 'consent');
  }
  return res.redirect(`${AUTH_BASE}?${params.toString()}`);
}

async function handleDedicatedGoogleCallback(req: Request, res: Response, input: {
  routeKey: 'gbp' | 'google-ads' | 'google-merchant';
  connectorType: 'gbp' | 'google-ads' | 'google-merchant';
  connected: string;
}) {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) return res.redirect(`${clientUrl}/connectors?error=provider_oauth_error`);
  if (!code || !state) return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);

  let parsedState: { businessId: string; config?: Record<string, unknown> };
  try {
    parsedState = await validateGoogleOAuthState(req, String(state), input.connectorType, [input.connectorType]) as { businessId: string; config?: Record<string, unknown> };
  } catch (err) {
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(`state_invalid: ${(err as Error).message.substring(0, 120)}`)}`);
  }
  if (!businessExists(parsedState.businessId)) {
    return res.status(400).json({ error: 'OAuth business no longer exists.' });
  }

  const { clientId, clientSecret } = readGoogleOAuthConfig();
  const redirectUri = getGoogleRedirectUri(input.routeKey);
  if (!clientId || !clientSecret || !redirectUri) {
    return res.redirect(`${clientUrl}/connectors?error=server_misconfigured`);
  }

  try {
    const tokens = await exchangeGoogleCode(String(code), clientId, clientSecret, redirectUri);
    if (!tokens.refresh_token) {
      console.warn(`[oauth] No refresh_token returned for ${input.connectorType} — preserving any existing refresh token.`);
    }
    const result = await upsertGoogleConnector({
      businessId: parsedState.businessId,
      type: input.connectorType,
      tokens,
      clientId,
      redirectUri,
      extraConfig: parsedState.config ?? {},
    });
    return result.status === 'connected'
      ? res.redirect(`${clientUrl}/connectors?connected=${input.connected}`)
      : res.redirect(`${clientUrl}/connectors?error=google_grant_incomplete`);
  } catch (err) {
    const safeError = ['token_exchange_failed', 'invalid_token_response'].includes((err as Error).message) ? (err as Error).message : 'internal_error';
    console.error(`[oauth] ${input.connectorType} callback failed: ${safeError}`);
    const message = safeError === 'internal_error' ? 'google_callback_failed' : safeError;
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(message)}`);
  }
}

/**
 * GET /api/oauth/google
 * Initiates Google OAuth flow. Redirects the browser to Google consent screen.
 *
 * Query params:
 *   businessId  — required
 *   types       — comma-separated connector types to create (default: gsc,ga4)
 */
router.get('/google', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId, debug, repair } = req.query;
  const types = req.query.types === undefined ? 'gsc,ga4' : req.query.types;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required.' });
  }
  if (!businessExists(String(businessId))) {
    return res.status(404).json({ error: 'Business not found.' });
  }
  const connectorTypes = normalizeGoogleTypes(types, ['gsc', 'ga4']);
  if (connectorTypes.length === 0) {
    return res.status(400).json({ error: 'No supported Google connector types requested.' });
  }

  const { clientId, clientSecret, redirectUri } = readGoogleOAuthConfig();

  if (!clientId || !clientSecret || !redirectUri) {
    if (debug) {
      return res.json({
        ok: false,
        reason: 'not_configured',
        client_id: clientId ?? null,
        has_client_secret: !!clientSecret,
        redirect_uri: redirectUri ?? null,
      });
    }
    return res.redirect(
      `${clientUrl}/connectors?error=google_oauth_not_configured&detail=${encodeURIComponent(
        'Google OAuth is not configured. Open Settings → Google OAuth and paste your Client ID + Client Secret from Google Cloud Console (APIs & Services → Credentials).'
      )}`
    );
  }

  let state: string;
  try {
    state = await createGoogleOAuthState(req, { businessId: String(businessId), routeType: 'google', types: connectorTypes });
  } catch (err) {
    return res.status(401).json({ error: (err as Error).message });
  }
  const scopes = [...new Set(connectorTypes.flatMap(type => GOOGLE_CONNECTOR_SCOPES[type] ?? []))];

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    access_type: 'offline',
    state,
  });
  if (shouldPromptConsent(String(businessId), connectorTypes, repair === '1' || repair === 'true')) {
    params.set('prompt', 'consent');
  }

  const fullUrl = `${AUTH_BASE}?${params.toString()}`;

  // ?debug=1 — returns the exact URL + params instead of redirecting to
  // Google, so the user can eyeball what Blueprint is sending and diff it
  // against what's registered in Cloud Console. Useful when Google keeps
  // returning redirect_uri_mismatch despite the fields looking right.
  if (debug) {
    return res.json({
      ok: true,
      oauth_url: fullUrl,
      redirect_uri_blueprint_sends: redirectUri,
      redirect_uri_bytes: Array.from(redirectUri).map((c, i) => ({
        index: i,
        char: c,
        codepoint: c.codePointAt(0),
      })),
      client_id: clientId,
      client_id_length: clientId.length,
      scopes,
      instructions: 'Open https://console.cloud.google.com/apis/credentials → click your OAuth client → confirm this EXACT string is in Authorised redirect URIs. Not Authorised JavaScript origins. Must be Web application client type, not Desktop.',
    });
  }

  return res.redirect(fullUrl);
});

/**
 * GET /api/oauth/google/callback
 * OAuth callback from Google. Exchanges code for tokens, creates/updates connectors.
 */
router.get('/google/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) {
    console.error('[oauth] Google returned an OAuth error.');
    return res.redirect(`${clientUrl}/connectors?error=provider_oauth_error`);
  }

  if (!code || !state) {
    return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);
  }

  let parsedState: { businessId: string; types?: string[] };
  try {
    parsedState = await validateGoogleOAuthState(req, String(state), 'google', ['gsc', 'ga4']) as { businessId: string; types?: string[] };
  } catch (err) {
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(`state_invalid: ${(err as Error).message.substring(0, 120)}`)}`);
  }

  const { businessId } = parsedState;
  const connectorTypes = normalizeGoogleTypes(parsedState.types, ['gsc', 'ga4']);
  if (connectorTypes.length === 0) return res.redirect(`${clientUrl}/connectors?error=state_invalid`);
  if (!businessExists(businessId)) {
    return res.status(400).json({ error: 'OAuth business no longer exists.' });
  }

  const { clientId, clientSecret, redirectUri } = readGoogleOAuthConfig();

  if (!clientId || !clientSecret || !redirectUri) {
    return res.redirect(`${clientUrl}/connectors?error=server_misconfigured`);
  }

  try {
    const tokens = await exchangeGoogleCode(String(code), clientId, clientSecret, redirectUri);

    if (!tokens.refresh_token) {
      console.warn('[oauth] No refresh_token returned — preserving any existing refresh token.');
    }

    const results = [];
    for (const type of connectorTypes) {
      results.push(await upsertGoogleConnector({ businessId, type, tokens, clientId, redirectUri }));
      console.log(`[oauth] Upserted ${type} connector for business ${businessId}`);
    }

    return results.every(result => result.status === 'connected')
      ? res.redirect(`${clientUrl}/connectors?connected=google`)
      : res.redirect(`${clientUrl}/connectors?error=google_grant_incomplete`);
  } catch (err) {
    console.error(`[oauth] Google callback failed: ${['token_exchange_failed', 'invalid_token_response'].includes((err as Error).message) ? (err as Error).message : 'internal_error'}`);
    const message = ['token_exchange_failed', 'invalid_token_response'].includes((err as Error).message) ? (err as Error).message : 'google_callback_failed';
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(message)}`);
  }
});

/**
 * GET /api/oauth/todoist
 * Initiates Todoist OAuth flow.
 *
 * Query params:
 *   businessId — required
 */
router.get('/todoist', async (req: Request, res: Response) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });

  try {
    const { default: todoistConnector } = await import('../connectors/todoist/index.js') as unknown as { default: { getAuthUrl: (state: string) => Promise<string> } };
    const state = Buffer.from(JSON.stringify({ businessId, type: 'todoist' })).toString('base64url');
    const authUrl = await todoistConnector.getAuthUrl(state);
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[oauth] Todoist init error:', err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/oauth/todoist/callback
 * OAuth callback from Todoist.
 */
router.get('/todoist/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(String(error))}`);
  if (!code || !state) return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);

  let parsedState: { businessId: string };
  try {
    parsedState = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
  } catch {
    return res.redirect(`${clientUrl}/connectors?error=invalid_state`);
  }

  const { businessId } = parsedState;

  try {
    const { default: todoistConnector } = await import('../connectors/todoist/index.js') as unknown as { default: { exchangeCode: (code: string) => Promise<any> } };
    const credentials = await todoistConnector.exchangeCode(String(code));
    const encryptedCreds = encrypt(JSON.stringify(credentials));

    const existing = db.prepare(
      "SELECT id FROM connectors WHERE business_id = ? AND type = 'todoist'"
    ).get(businessId) as { id: string } | null;

    if (existing) {
      db.prepare(`
        UPDATE connectors SET credentials = ?, status = 'connected', last_error = NULL WHERE id = ?
      `).run(encryptedCreds, existing.id);
    } else {
      const id = generateId();
      db.prepare(`
        INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
        VALUES (?, ?, 'todoist', 'Todoist', ?, 'connected', '{}', CURRENT_TIMESTAMP)
      `).run(id, businessId, encryptedCreds);
    }

    return res.redirect(`${clientUrl}/connectors?connected=todoist`);
  } catch (err) {
    console.error('[oauth] Todoist callback error:', err);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent((err as Error).message.substring(0, 100))}`);
  }
});

/**
 * GET /api/oauth/gbp
 * Initiates Google Business Profile OAuth flow.
 */
router.get('/gbp', isAuthenticated, async (req: Request, res: Response) => {
  return initiateDedicatedGoogleOAuth(req, res, { routeKey: 'gbp', connectorType: 'gbp' });
});

/**
 * GET /api/oauth/gbp/callback
 */
router.get('/gbp/callback', async (req: Request, res: Response) => {
  return handleDedicatedGoogleCallback(req, res, { routeKey: 'gbp', connectorType: 'gbp', connected: 'gbp' });
});

/**
 * GET /api/oauth/google-ads
 * Initiates Google Ads OAuth flow (uses Google OAuth with adwords scope).
 */
router.get('/google-ads', isAuthenticated, async (req: Request, res: Response) => {
  const customerId = String(req.query.customerId ?? '').replace(/-/g, '').trim();
  const managerAccountId = String(req.query.managerAccountId ?? '').replace(/-/g, '').trim();
  if (!/^\d{10}$/.test(customerId)) return res.status(400).json({ error: 'customerId must contain exactly 10 digits.' });
  if (managerAccountId && !/^\d{10}$/.test(managerAccountId)) return res.status(400).json({ error: 'managerAccountId must contain exactly 10 digits.' });
  return initiateDedicatedGoogleOAuth(req, res, {
    routeKey: 'google-ads',
    connectorType: 'google-ads',
    config: { customerId, ...(managerAccountId ? { managerAccountId } : {}) },
  });
});

/**
 * GET /api/oauth/google-ads/callback
 */
router.get('/google-ads/callback', async (req: Request, res: Response) => {
  return handleDedicatedGoogleCallback(req, res, { routeKey: 'google-ads', connectorType: 'google-ads', connected: 'google-ads' });
});

/**
 * GET /api/oauth/google-merchant
 * Initiates Google Merchant Center OAuth flow (uses Google OAuth with the
 * content scope — a dedicated flow, same reasoning as google-ads above:
 * bundling this into the shared GSC/GA4 consent would force those users to
 * also grant Merchant Center access).
 */
router.get('/google-merchant', isAuthenticated, async (req: Request, res: Response) => {
  const accountId = String(req.query.accountId ?? '').replace(/-/g, '').trim();
  const config = accountId ? { accountId } : undefined;
  return initiateDedicatedGoogleOAuth(req, res, { routeKey: 'google-merchant', connectorType: 'google-merchant', config });
});

/**
 * GET /api/oauth/google-merchant/callback
 */
router.get('/google-merchant/callback', async (req: Request, res: Response) => {
  return handleDedicatedGoogleCallback(req, res, { routeKey: 'google-merchant', connectorType: 'google-merchant', connected: 'google-merchant' });
});

/**
 * GET /api/oauth/meta
 * Initiates Meta (Facebook) OAuth flow for Meta Ads connector.
 */
router.get('/meta', async (req: Request, res: Response) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });

  try {
    const { default: metaConnector } = await import('../connectors/meta-ads/index.js') as unknown as { default: { getAuthUrl: (state: string) => Promise<string> } };
    const state = Buffer.from(JSON.stringify({ businessId, type: 'meta-ads' })).toString('base64url');
    const authUrl = await metaConnector.getAuthUrl(state);
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[oauth] Meta init error:', err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/oauth/meta/callback
 * OAuth callback from Meta. Exchanges code for long-lived token, stores encrypted.
 */
router.get('/meta/callback', async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) {
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(String(error_description || error))}`);
  }
  if (!code || !state) {
    return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);
  }

  let parsedState: { businessId: string };
  try {
    parsedState = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
  } catch {
    return res.redirect(`${clientUrl}/connectors?error=invalid_state`);
  }
  const { businessId } = parsedState;

  try {
    const { default: metaConnector } = await import('../connectors/meta-ads/index.js') as unknown as { default: { exchangeCode: (code: string) => Promise<any> } };
    const credentials = await metaConnector.exchangeCode(String(code));
    const encryptedCreds = encrypt(JSON.stringify(credentials));

    const existing = db.prepare(
      "SELECT id FROM connectors WHERE business_id = ? AND type = 'meta-ads'"
    ).get(businessId) as { id: string } | null;

    if (existing) {
      db.prepare(`
        UPDATE connectors SET credentials = ?, status = 'connected', last_error = NULL WHERE id = ?
      `).run(encryptedCreds, existing.id);
    } else {
      const id = generateId();
      db.prepare(`
        INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
        VALUES (?, ?, 'meta-ads', 'Meta Ads', ?, 'connected', '{}', CURRENT_TIMESTAMP)
      `).run(id, businessId, encryptedCreds);
    }

    return res.redirect(`${clientUrl}/connectors?connected=meta`);
  } catch (err) {
    console.error('[oauth] Meta callback error:', err);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent((err as Error).message.substring(0, 100))}`);
  }
});

/**
 * DELETE /api/oauth/meta/:businessId
 * Disconnect the Meta Ads connector.
 */
router.delete('/meta/:businessId', isAuthenticated, (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  db.prepare(`
    UPDATE connectors
    SET status = 'disconnected', credentials = ?, last_error = NULL
    WHERE business_id = ? AND type = 'meta-ads'
  `).run(encrypt(JSON.stringify({})), businessId);
  return res.json({ ok: true });
});

/**
 * GET /api/oauth/social
 * Initiates Facebook/Instagram (organic social) OAuth flow.
 *
 * State is HMAC-signed (see connectors/social/oauth-state.ts):
 * - Cryptographically bound to the initiating user session
 * - Cryptographically bound to the businessId
 * - Carries a one-time nonce (replay prevention)
 * - Expires in 10 minutes
 */
router.get('/social', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });

  const userId = (req.session as any).userId as string;
  if (!userId) {
    return res.status(401).json({ error: 'Session userId is required to initiate OAuth.' });
  }

  try {
    const { default: socialConnector } = await import('../connectors/social/index.js') as unknown as { default: { getAuthUrl: (state: string) => Promise<string> } };
    const { createOAuthState } = await import('../connectors/social/oauth-state.js');
    const state = await createOAuthState({
      businessId: String(businessId),
      userId,
      type: 'social',
      family: 'social',
      sessionHash: sessionHash(req),
    });
    const authUrl = await socialConnector.getAuthUrl(state);
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[oauth] Social init error:', err);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent((err as Error).message.substring(0, 100))}`);
  }
});

/**
 * GET /api/oauth/social/callback
 * OAuth callback from Facebook for the social connector.
 *
 * Validates the signed state token before processing the callback:
 * - Signature check (HMAC-SHA256)
 * - Expiry check (10 minute TTL)
 * - One-time nonce check (replay prevention)
 * - Session binding check (userId must match the initiating session)
 * - Business binding check (businessId must match)
 */
router.get('/social/callback', async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  if (error) return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(String(error_description || error))}`);
  if (!code || !state) return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);

  const { validateOAuthState, OAuthStateError } = await import('../connectors/social/oauth-state.js');

  // Validate signed state: signature, expiry, nonce, user binding
  // userId is extracted from the signed state token itself (safe — HMAC-verified)
  // so the callback works even when the session cookie isn't present (e.g. via ngrok).
  let parsedState: { businessId: string; type: string };
  try {
    const rawState = String(state);
    const dotIdx = rawState.lastIndexOf('.');
    if (dotIdx < 1) throw new OAuthStateError('Invalid state format.');
    const encoded = rawState.slice(0, dotIdx);
    let prelimPayload: { businessId?: string; userId?: string };
    try {
      prelimPayload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new OAuthStateError('Could not decode state payload.');
    }
    if (!prelimPayload.businessId) throw new OAuthStateError('State missing businessId.');
    if (!prelimPayload.userId) throw new OAuthStateError('State missing userId.');

    const liveUserId = (req.session as any)?.userId as string | undefined;
    const liveSessionHash = sessionHash(req);
    if (!liveUserId || !liveSessionHash) throw new OAuthStateError('Session expired. Please log in and restart OAuth.');
    parsedState = await validateOAuthState(rawState, liveUserId, prelimPayload.businessId, {
      expectedType: 'social',
      expectedFamily: 'social',
      expectedSessionHash: liveSessionHash,
    });
  } catch (err) {
    const msg = (err as Error).message || 'invalid_state';
    console.warn('[oauth] Social callback state validation failed:', msg);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(`state_invalid: ${msg.substring(0, 120)}`)}`);
  }

  const { businessId } = parsedState;
  try {
    const { default: socialConnector } = await import('../connectors/social/index.js') as unknown as { default: { exchangeCode: (code: string) => Promise<any> } };
    const credentials = await socialConnector.exchangeCode(String(code));
    const encryptedCreds = encrypt(JSON.stringify(credentials));
    const existing = db.prepare(
      "SELECT id FROM connectors WHERE business_id = ? AND type = 'social'"
    ).get(businessId) as { id: string } | null;
    if (existing) {
      db.prepare(`
        UPDATE connectors SET credentials = ?, status = 'connected', last_error = NULL WHERE id = ?
      `).run(encryptedCreds, existing.id);
    } else {
      const id = generateId();
      db.prepare(`
        INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
        VALUES (?, ?, 'social', 'Facebook & Instagram', ?, 'connected', '{}', CURRENT_TIMESTAMP)
      `).run(id, businessId, encryptedCreds);
    }
    return res.redirect(`${clientUrl}/connectors?connected=social`);
  } catch (err) {
    console.error('[oauth] Social callback error:', err);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent((err as Error).message.substring(0, 100))}`);
  }
});

router.delete('/social/:businessId', isAuthenticated, (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  db.prepare(`
    UPDATE connectors SET status = 'disconnected', credentials = ?, last_error = NULL
    WHERE business_id = ? AND type = 'social'
  `).run(encrypt(JSON.stringify({})), businessId);
  return res.json({ ok: true });
});

/**
 * GET /api/oauth/buffer
 * Initiates Buffer OAuth flow.
 */
router.get('/buffer', async (req: Request, res: Response) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });
  try {
    const { default: bufferConnector } = await import('../connectors/buffer/index.js') as unknown as { default: { getAuthUrl: (state: string) => Promise<string> } };
    const state = Buffer.from(JSON.stringify({ businessId, type: 'buffer' })).toString('base64url');
    const authUrl = await bufferConnector.getAuthUrl(state);
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[oauth] Buffer init error:', err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/oauth/buffer/callback
 */
router.get('/buffer/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  if (error) return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(String(error))}`);
  if (!code || !state) return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);
  let parsedState: { businessId: string };
  try {
    parsedState = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
  } catch {
    return res.redirect(`${clientUrl}/connectors?error=invalid_state`);
  }
  const { businessId } = parsedState;
  try {
    const { default: bufferConnector } = await import('../connectors/buffer/index.js') as unknown as { default: { exchangeCode: (code: string) => Promise<any> } };
    const credentials = await bufferConnector.exchangeCode(String(code));
    const encryptedCreds = encrypt(JSON.stringify(credentials));
    const existing = db.prepare(
      "SELECT id FROM connectors WHERE business_id = ? AND type = 'buffer'"
    ).get(businessId) as { id: string } | null;
    if (existing) {
      db.prepare(`
        UPDATE connectors SET credentials = ?, status = 'connected', last_error = NULL WHERE id = ?
      `).run(encryptedCreds, existing.id);
    } else {
      const id = generateId();
      db.prepare(`
        INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
        VALUES (?, ?, 'buffer', 'Buffer', ?, 'connected', '{}', CURRENT_TIMESTAMP)
      `).run(id, businessId, encryptedCreds);
    }
    return res.redirect(`${clientUrl}/connectors?connected=buffer`);
  } catch (err) {
    console.error('[oauth] Buffer callback error:', err);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent((err as Error).message.substring(0, 100))}`);
  }
});

/**
 * DELETE /api/oauth/google/:businessId
 * Revokes Google access and sets GSC + GA4 connectors to disconnected.
 */
router.delete('/google/:businessId', isAuthenticated, async (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  if (!businessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const requestedType = String(req.query.type ?? 'google');
  const types = requestedType === 'google'
    ? ['gsc', 'ga4']
    : requestedType === 'gsc' || requestedType === 'ga4'
      ? [requestedType]
    : ['gbp', 'google-ads', 'google-merchant'].includes(requestedType)
      ? [requestedType]
      : [];
  if (types.length === 0) return res.status(400).json({ error: 'Unsupported Google connector type.' });
  const placeholders = types.map(() => '?').join(', ');

  const connectors = db.prepare(
    `SELECT * FROM connectors WHERE business_id = ? AND type IN (${placeholders})`
  ).all(businessId, ...types) as any[];

  const allGoogleConnectors = db.prepare(
    `SELECT id, type, credentials FROM connectors WHERE business_id = ? AND type IN ('gsc','ga4','gbp','google-ads','google-merchant')`
  ).all(businessId) as any[];
  const rowsByToken = new Map<string, Set<string>>();
  for (const row of allGoogleConnectors) {
    if (!row.credentials) continue;
    try {
      const creds = JSON.parse(decrypt(row.credentials));
      const token = creds.refreshToken || creds.accessToken;
      if (!token) continue;
      const ids = rowsByToken.get(token) ?? new Set<string>();
      ids.add(row.id);
      rowsByToken.set(token, ids);
    } catch {}
  }

  const revokeResults: Array<{ type: string; ok: boolean; error?: string }> = [];
  const revokedTokens = new Set<string>();
  const affectedIds = new Set<string>();
  for (const connector of connectors) {
    if (!connector.credentials) {
      affectedIds.add(connector.id);
      continue;
    }
    try {
      const creds = JSON.parse(decrypt(connector.credentials));
      const tokenToRevoke = creds.refreshToken || creds.accessToken;
      if (!tokenToRevoke) affectedIds.add(connector.id);
      if (tokenToRevoke && !revokedTokens.has(tokenToRevoke)) {
        revokedTokens.add(tokenToRevoke);
        const revokeRes = await fetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokenToRevoke }),
        });
        if (!revokeRes.ok) {
          revokeResults.push({ type: connector.type, ok: false, error: 'remote_revoke_failed' });
          console.warn(`[oauth] Google revocation failed: remote_revoke_failed status=${revokeRes.status}`);
        } else {
          revokeResults.push({ type: connector.type, ok: true });
          for (const id of rowsByToken.get(tokenToRevoke) ?? []) affectedIds.add(id);
        }
      }
    } catch {
      revokeResults.push({ type: connector.type, ok: false, error: 'remote_revoke_failed' });
      console.warn('[oauth] Google revocation failed: remote_revoke_failed classification=exception');
    }
  }

  const disconnectAffected = () => {
    if (affectedIds.size === 0) return;
    const affectedPlaceholders = [...affectedIds].map(() => '?').join(', ');
    db.prepare(`
      UPDATE connectors
      SET status = 'disconnected', credentials = ?, last_error = NULL
      WHERE business_id = ? AND id IN (${affectedPlaceholders})
    `).run(encrypt(JSON.stringify({})), businessId, ...affectedIds);
  };

  const failed = revokeResults.filter(r => !r.ok);
  if (failed.length > 0) {
    disconnectAffected();
    console.warn(`[oauth] Google revocation partially failed for business ${businessId}; failed grants were retained.`);
    return res.status(502).json({ ok: false, disconnected: affectedIds.size, revoke: revokeResults });
  }

  disconnectAffected();

  console.log(`[oauth] Revoked Google access for business ${businessId} types=${types.join(',')} (${affectedIds.size} connectors, ${failed.length} revoke failures)`);
  return res.json({ ok: failed.length === 0, disconnected: affectedIds.size, revoke: revokeResults });
});

// ─── Google OAuth app credentials (Client ID / Secret / redirect URI) ─────────
// Stored in settings.google_oauth_config with the secret encrypted. This lets
// the user paste credentials into the Settings UI instead of editing .env.

/**
 * GET /api/oauth/google/config
 * Returns the current Google OAuth configuration. The secret is NEVER returned
 * in plain text — only a boolean `has_secret` flag.
 */
router.get('/google/config', isAuthenticated, (req: Request, res: Response) => {
  try {
    const cfg = readGoogleOAuthConfig();
    // Expose whether the *live* config resolves (via DB or env), and the
    // storage source so the user can tell if they're overriding env.
    const storedRow = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get() as { value: string } | null;
    let stored: Record<string, unknown> | null = null;
    try { stored = storedRow?.value ? JSON.parse(storedRow.value) : null; } catch {}
    const envPresent = {
      client_id: !isPlaceholder(process.env.GOOGLE_CLIENT_ID),
      client_secret: !isPlaceholder(process.env.GOOGLE_CLIENT_SECRET),
      redirect_uri: !isPlaceholder(process.env.GOOGLE_REDIRECT_URI),
    };
    return res.json({
      configured: !!(cfg.clientId && cfg.clientSecret && cfg.redirectUri),
      client_id: cfg.clientId ?? '',
      redirect_uri: cfg.redirectUri ?? defaultRedirectUri(),
      has_secret: !!cfg.clientSecret,
      source: {
        client_id: stored?.client_id ? 'settings' : (envPresent.client_id ? 'env' : 'none'),
        client_secret: stored?.client_secret_enc ? 'settings' : (envPresent.client_secret ? 'env' : 'none'),
        redirect_uri: stored?.redirect_uri ? 'settings' : (envPresent.redirect_uri ? 'env' : 'default'),
      },
      default_redirect_uri: defaultRedirectUri(),
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PUT /api/oauth/google/config
 * Body: { client_id, client_secret, redirect_uri }
 *   - Pass an empty string or omit a field to delete that slot (falls back to env).
 *   - Pass `null` for client_secret to leave it unchanged (so the UI can edit
 *     client_id without re-entering the secret).
 */
router.put('/google/config', isAuthenticated, (req: Request, res: Response) => {
  try {
    const { client_id, client_secret, redirect_uri } = req.body ?? {};

    // Read existing so we can preserve the secret when not re-submitted.
    let existing: Record<string, unknown> = {};
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get() as { value: string } | null;
      existing = row?.value ? JSON.parse(row.value) : {};
    } catch {}

    const next: Record<string, unknown> = {
      client_id: typeof client_id === 'string' ? client_id.trim() : (existing.client_id ?? null),
      redirect_uri: typeof redirect_uri === 'string' ? redirect_uri.trim() : (existing.redirect_uri ?? null),
      client_secret_enc: existing.client_secret_enc ?? null,
    };
    if (typeof client_secret === 'string') {
      next.client_secret_enc = client_secret.trim()
        ? encrypt(client_secret.trim())
        : null;
    }

    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('google_oauth_config', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(next));

    const cfg = readGoogleOAuthConfig();
    return res.json({
      ok: true,
      configured: !!(cfg.clientId && cfg.clientSecret && cfg.redirectUri),
      client_id: cfg.clientId ?? '',
      redirect_uri: cfg.redirectUri ?? defaultRedirectUri(),
      has_secret: !!cfg.clientSecret,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
