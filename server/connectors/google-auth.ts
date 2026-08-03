/**
 * Google OAuth access token helper.
 */

import fetch from 'node-fetch';
import db from '../db/db.js';
import { encrypt, decrypt } from '../crypto.js';
import { readGoogleOAuthConfig } from '../lib/google-oauth-config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface Credentials {
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  scope?: string | string[];
  scopes?: string[];
  [key: string]: any;
}

interface ConnectorRow {
  id: string;
  type: string;
  credentials: string;
}

interface TokenResult {
  accessToken: string;
  expiresAt: number;
}

interface GoogleAccessTokenOptions {
  requiredScope?: string;
}

function loadCredentials(connectorRow: ConnectorRow | undefined): Credentials | null {
  if (!connectorRow?.credentials) return null;
  try { return JSON.parse(decrypt(connectorRow.credentials)); }
  catch { return null; }
}

function saveCredentials(connectorId: string, creds: Credentials): void {
  db.prepare('UPDATE connectors SET credentials = ? WHERE id = ?')
    .run(encrypt(JSON.stringify(creds)), connectorId);
}

function credentialScopes(creds: Credentials): Set<string> {
  const values = [
    ...(Array.isArray(creds.scope) ? creds.scope : typeof creds.scope === 'string' ? creds.scope.split(/\s+/) : []),
    ...(Array.isArray(creds.scopes) ? creds.scopes : []),
  ];
  return new Set(values.map(scope => scope.trim()).filter(Boolean));
}

function hasStoredScopeMetadata(creds: Credentials): boolean {
  return creds.scope != null || creds.scopes != null;
}

function scopeCompatibility(creds: Credentials, requiredScope: string): 'compatible' | 'unknown' | 'incompatible' {
  if (!hasStoredScopeMetadata(creds)) return 'unknown';
  const scopes = credentialScopes(creds);
  return scopes.has(requiredScope) ? 'compatible' : 'incompatible';
}

/**
 * Refresh an access token using the refresh_token + the app's OAuth client
 * credentials.
 */
async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  const { clientId, clientSecret } = readGoogleOAuthConfig();
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth app credentials not configured (Settings → Google OAuth).');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { access_token: string; expires_in?: number };
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in ?? 3600)) * 1000,
  };
}

/**
 * Picks any connected Google connector for this business that has a
 * refresh_token, and returns a live access token. Refreshes if expired.
 * When requiredScope is supplied, prefers credentials whose stored OAuth scopes
 * include it. Credentials with no stored scope metadata remain eligible for
 * legacy rows; only credentials with explicit scope metadata that lacks the
 * required scope are skipped.
 */
export async function getValidGoogleAccessToken(businessId: string, options: GoogleAccessTokenOptions = {}): Promise<TokenResult | null> {
  if (!businessId) return null;

  const candidates = db.prepare(
    `SELECT id, type, credentials FROM connectors
     WHERE business_id = ?
       AND type IN ('gsc', 'ga4', 'gbp', 'pagespeed')
       AND status != 'disconnected'
     ORDER BY last_sync DESC NULLS LAST, created_at DESC`
  ).all(businessId) as ConnectorRow[];

  const orderedCandidates = options.requiredScope
    ? [
        ...candidates.filter(connector => {
          const creds = loadCredentials(connector);
          return Boolean(creds?.refreshToken && scopeCompatibility(creds, options.requiredScope as string) === 'compatible');
        }),
        ...candidates.filter(connector => {
          const creds = loadCredentials(connector);
          return Boolean(creds?.refreshToken && scopeCompatibility(creds, options.requiredScope as string) === 'unknown');
        }),
      ]
    : candidates;

  for (const connector of orderedCandidates) {
    const creds = loadCredentials(connector);
    if (!creds?.refreshToken) continue;

    const fresh = creds.expiresAt && creds.expiresAt > Date.now() + 60_000;
    if (fresh && creds.accessToken) {
      return { accessToken: creds.accessToken, expiresAt: creds.expiresAt as number };
    }

    try {
      const refreshed = await refreshAccessToken(creds.refreshToken);
      saveCredentials(connector.id, { ...creds, ...refreshed });
      return refreshed;
    } catch (err: any) {
      console.warn(`[google-auth] refresh failed for connector ${connector.id}:`, err.message);
      // Try the next candidate
    }
  }

  return null;
}
