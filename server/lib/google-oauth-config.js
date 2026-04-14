/**
 * Shared Google OAuth config resolver.
 *
 * DB-stored credentials (Settings → Google OAuth) take priority over env vars,
 * so non-technical users who paste their credentials into the UI don't need to
 * touch .env. Both the OAuth route and the individual connector refresh-token
 * helpers import from here so they all use the same resolution logic.
 */

import db from '../db/db.js';
import { decrypt } from '../crypto.js';

function defaultRedirectUri() {
  const port = process.env.PORT || 4000;
  return `http://localhost:${port}/api/oauth/google/callback`;
}

const PLACEHOLDER_PATTERNS = [/^your-/i, /GOCSPX-your-client-secret/i, /your-client/i];
function isPlaceholder(v) {
  if (!v || typeof v !== 'string') return true;
  return PLACEHOLDER_PATTERNS.some((r) => r.test(v));
}

export function readGoogleOAuthConfig() {
  let fromDb = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      fromDb = {
        client_id: parsed.client_id ?? null,
        client_secret: parsed.client_secret_enc
          ? (() => { try { return decrypt(parsed.client_secret_enc); } catch { return null; } })()
          : null,
        redirect_uri: parsed.redirect_uri ?? null,
      };
    }
  } catch (err) {
    console.warn('[google-oauth-config] reading google_oauth_config failed:', err.message);
  }

  const clientId = !isPlaceholder(fromDb.client_id) ? fromDb.client_id
    : !isPlaceholder(process.env.GOOGLE_CLIENT_ID) ? process.env.GOOGLE_CLIENT_ID
    : null;
  const clientSecret = !isPlaceholder(fromDb.client_secret) ? fromDb.client_secret
    : !isPlaceholder(process.env.GOOGLE_CLIENT_SECRET) ? process.env.GOOGLE_CLIENT_SECRET
    : null;
  const redirectUri = !isPlaceholder(fromDb.redirect_uri) ? fromDb.redirect_uri
    : !isPlaceholder(process.env.GOOGLE_REDIRECT_URI) ? process.env.GOOGLE_REDIRECT_URI
    : defaultRedirectUri();

  return { clientId, clientSecret, redirectUri };
}
