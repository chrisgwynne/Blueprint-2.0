/**
 * Google OAuth access token helper.
 *
 * Google APIs (PageSpeed, Search Console, Analytics, etc.) all accept the
 * same OAuth bearer token. Once the user has connected GSC or GA4 we already
 * have a refresh_token on file — so APIs that historically required a
 * separate api key (PageSpeed) can authenticate using that same OAuth token,
 * sparing the user a second setup step.
 *
 * Public:
 *   getValidGoogleAccessToken(businessId) → { accessToken, expiresAt }
 *     Picks the freshest available Google connector for this business,
 *     refreshes the access token if expired, persists the new expiry back
 *     to the connector row, and returns the live token. Returns null when
 *     no Google connector is connected.
 */

import fetch from 'node-fetch';
import db from '../db/db.js';
import { encrypt, decrypt } from '../crypto.js';
import { readGoogleOAuthConfig } from '../routes/oauth.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function loadCredentials(connectorRow) {
  if (!connectorRow?.credentials) return null;
  try { return JSON.parse(decrypt(connectorRow.credentials)); }
  catch { return null; }
}

function saveCredentials(connectorId, creds) {
  db.prepare('UPDATE connectors SET credentials = ? WHERE id = ?')
    .run(encrypt(JSON.stringify(creds)), connectorId);
}

/**
 * Refresh an access token using the refresh_token + the app's OAuth client
 * credentials. Returns the new { accessToken, expiresAt } or throws on
 * failure.
 */
async function refreshAccessToken(refreshToken) {
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
  const data = await res.json();
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/**
 * Picks any connected Google connector (GSC, GA4) for this business that
 * has a refresh_token, and returns a live access token. Refreshes if expired.
 *
 * @returns {Promise<{accessToken: string, expiresAt: number}|null>}
 */
export async function getValidGoogleAccessToken(businessId) {
  if (!businessId) return null;

  // Pick any Google connector for this business that has tokens. Don't
  // require status='connected' — a connector can be in 'error' (e.g. wrong
  // siteUrl) but its OAuth refresh_token is still valid and usable for
  // sibling APIs like PageSpeed.
  const candidates = db.prepare(
    `SELECT id, type, credentials FROM connectors
     WHERE business_id = ?
       AND type IN ('gsc', 'ga4', 'gbp', 'pagespeed')
       AND status != 'disconnected'
     ORDER BY last_sync DESC NULLS LAST, created_at DESC`
  ).all(businessId);

  for (const connector of candidates) {
    const creds = loadCredentials(connector);
    if (!creds?.refreshToken) continue;

    const fresh = creds.expiresAt && creds.expiresAt > Date.now() + 60_000;
    if (fresh && creds.accessToken) {
      return { accessToken: creds.accessToken, expiresAt: creds.expiresAt };
    }

    try {
      const refreshed = await refreshAccessToken(creds.refreshToken);
      saveCredentials(connector.id, { ...creds, ...refreshed });
      return refreshed;
    } catch (err) {
      console.warn(`[google-auth] refresh failed for connector ${connector.id}:`, err.message);
      // Try the next candidate
    }
  }

  return null;
}
