/**
 * Shared Google OAuth config resolver.
 */

import db from '../db/db.js';
import { decrypt } from '../crypto.js';

export interface GoogleOAuthConfig {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string;
}

interface StoredOAuthConfig {
  client_id?: string | null;
  client_secret_enc?: string | null;
  redirect_uri?: string | null;
}

function defaultRedirectUri(): string {
  const port = process.env['PORT'] ?? '4000';
  return `http://localhost:${port}/api/oauth/google/callback`;
}

const PLACEHOLDER_PATTERNS = [/^your-/i, /GOCSPX-your-client-secret/i, /your-client/i];

function isPlaceholder(v: unknown): boolean {
  if (!v || typeof v !== 'string') return true;
  return PLACEHOLDER_PATTERNS.some(r => r.test(v));
}

export function readGoogleOAuthConfig(): GoogleOAuthConfig {
  let fromDb: { client_id?: string | null; client_secret?: string | null; redirect_uri?: string | null } = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get() as
      | { value: string }
      | null;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as StoredOAuthConfig;
      fromDb = {
        client_id: parsed.client_id ?? null,
        client_secret: parsed.client_secret_enc
          ? (() => { try { return decrypt(parsed.client_secret_enc!); } catch { return null; } })()
          : null,
        redirect_uri: parsed.redirect_uri ?? null,
      };
    }
  } catch (err) {
    console.warn('[google-oauth-config] reading google_oauth_config failed:', (err as Error).message);
  }

  const clientId = !isPlaceholder(fromDb.client_id) ? (fromDb.client_id ?? null)
    : !isPlaceholder(process.env['GOOGLE_CLIENT_ID']) ? (process.env['GOOGLE_CLIENT_ID'] ?? null)
    : null;
  const clientSecret = !isPlaceholder(fromDb.client_secret) ? (fromDb.client_secret ?? null)
    : !isPlaceholder(process.env['GOOGLE_CLIENT_SECRET']) ? (process.env['GOOGLE_CLIENT_SECRET'] ?? null)
    : null;
  const redirectUri = !isPlaceholder(fromDb.redirect_uri) ? (fromDb.redirect_uri ?? defaultRedirectUri())
    : !isPlaceholder(process.env['GOOGLE_REDIRECT_URI']) ? (process.env['GOOGLE_REDIRECT_URI'] ?? defaultRedirectUri())
    : defaultRedirectUri();

  return { clientId, clientSecret, redirectUri };
}
