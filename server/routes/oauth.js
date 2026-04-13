import { Router } from 'express';
import fetch from 'node-fetch';
import db, { generateId } from '../db/db.js';
import { encrypt, decrypt } from '../crypto.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Combined scopes: GSC + GA4 in one OAuth consent
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'email',
  'profile',
].join(' ');

// ─── OAuth config resolution ──────────────────────────────────────────────────
// Config is loaded from the DB (settings.google_oauth_config) first, then
// falls back to environment variables. The DB form lets non-technical users
// paste credentials into the Settings UI without editing .env.
const PLACEHOLDER_PATTERNS = [/^your-/i, /GOCSPX-your-client-secret/i, /your-client/i];
function isPlaceholder(v) {
  if (!v || typeof v !== 'string') return true;
  return PLACEHOLDER_PATTERNS.some((r) => r.test(v));
}

// Self-heal: an old typo in .env.example shipped /api/auth/google/callback
// instead of /api/oauth/google/callback. Anyone who installed before the fix
// has the wrong value in DB and/or process.env. Force-correct on startup so
// they don't keep hitting redirect_uri_mismatch from Google.
function healWrongRedirectUri(uri) {
  if (typeof uri !== 'string') return uri;
  return uri.replace('/api/auth/google/callback', '/api/oauth/google/callback')
            .replace('/api/auth/gbp/callback', '/api/oauth/gbp/callback')
            .replace('/api/auth/google-ads/callback', '/api/oauth/google-ads/callback');
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
    const row = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (parsed.redirect_uri && parsed.redirect_uri.includes('/api/auth/google/callback')) {
        parsed.redirect_uri = healWrongRedirectUri(parsed.redirect_uri);
        db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'google_oauth_config'")
          .run(JSON.stringify(parsed));
        console.warn(`[oauth] Auto-corrected stored google_oauth_config.redirect_uri to ${parsed.redirect_uri}`);
      }
    }
  } catch (err) {
    console.warn('[oauth] auto-heal failed:', err.message);
  }
})();

function defaultRedirectUri() {
  // Blueprint lives at PORT (default 4000) on the local machine. Anyone
  // running this on a remote host sets GOOGLE_REDIRECT_URI in .env.
  const port = process.env.PORT || 4000;
  return `http://localhost:${port}/api/oauth/google/callback`;
}

export function readGoogleOAuthConfig() {
  let fromDb = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      // The secret is encrypted at rest
      fromDb = {
        client_id: parsed.client_id ?? null,
        client_secret: parsed.client_secret_enc
          ? (() => { try { return decrypt(parsed.client_secret_enc); } catch { return null; } })()
          : null,
        redirect_uri: parsed.redirect_uri ?? null,
      };
    }
  } catch (err) {
    console.warn('[oauth] reading google_oauth_config failed:', err.message);
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

function isGoogleOAuthConfigured() {
  const { clientId, clientSecret, redirectUri } = readGoogleOAuthConfig();
  return !!(clientId && clientSecret && redirectUri);
}

/**
 * GET /api/oauth/google
 * Initiates Google OAuth flow. Redirects the browser to Google consent screen.
 *
 * Query params:
 *   businessId  — required
 *   types       — comma-separated connector types to create (default: gsc,ga4)
 */
router.get('/google', (req, res) => {
  const { businessId, types = 'gsc,ga4', debug } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required.' });
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

  const state = Buffer.from(JSON.stringify({ businessId, types })).toString('base64url');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // always ask to ensure refresh_token is returned
    state,
  });

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
      scopes: SCOPES.split(' '),
      instructions: 'Open https://console.cloud.google.com/apis/credentials → click your OAuth client → confirm this EXACT string is in Authorised redirect URIs. Not Authorised JavaScript origins. Must be Web application client type, not Desktop.',
    });
  }

  return res.redirect(fullUrl);
});

/**
 * GET /api/oauth/google/callback
 * OAuth callback from Google. Exchanges code for tokens, creates/updates connectors.
 */
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) {
    console.error('[oauth] Google returned error:', error);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);
  }

  let parsedState;
  try {
    parsedState = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return res.redirect(`${clientUrl}/connectors?error=invalid_state`);
  }

  const { businessId, types = 'gsc,ga4' } = parsedState;
  const connectorTypes = types.split(',').map(t => t.trim()).filter(t => ['gsc', 'ga4'].includes(t));

  const { clientId, clientSecret, redirectUri } = readGoogleOAuthConfig();

  if (!clientId || !clientSecret || !redirectUri) {
    return res.redirect(`${clientUrl}/connectors?error=server_misconfigured`);
  }

  try {
    // Exchange authorisation code for tokens
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
      const err = await tokenRes.text();
      console.error('[oauth] Token exchange failed:', err.substring(0, 300));
      return res.redirect(`${clientUrl}/connectors?error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      console.warn('[oauth] No refresh_token returned — user may need to revoke access and reconnect.');
    }

    const credentials = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
    };

    // Fetch user profile to store email
    let userEmail = null;
    try {
      const userRes = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (userRes.ok) {
        const info = await userRes.json();
        userEmail = info.email ?? null;
      }
    } catch { /* non-fatal */ }

    // Upsert connector records for each requested type
    const CONNECTOR_NAMES = { gsc: 'Google Search Console', ga4: 'Google Analytics 4' };

    for (const type of connectorTypes) {
      const encryptedCreds = encrypt(JSON.stringify({ ...credentials, userEmail }));

      const existing = db.prepare(
        'SELECT id FROM connectors WHERE business_id = ? AND type = ?'
      ).get(businessId, type);

      if (existing) {
        db.prepare(`
          UPDATE connectors
          SET credentials = ?, status = 'connected', last_error = NULL
          WHERE id = ?
        `).run(encryptedCreds, existing.id);
        console.log(`[oauth] Updated ${type} connector for business ${businessId}`);
      } else {
        const id = generateId();
        db.prepare(`
          INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
          VALUES (?, ?, ?, ?, ?, 'connected', '{}', CURRENT_TIMESTAMP)
        `).run(id, businessId, type, CONNECTOR_NAMES[type] || type, encryptedCreds);
        console.log(`[oauth] Created ${type} connector for business ${businessId}`);
      }
    }

    const emailParam = userEmail ? `&email=${encodeURIComponent(userEmail)}` : '';
    return res.redirect(`${clientUrl}/connectors?connected=google${emailParam}`);
  } catch (err) {
    console.error('[oauth] Callback error:', err);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(err.message.substring(0, 100))}`);
  }
});

/**
 * GET /api/oauth/todoist
 * Initiates Todoist OAuth flow.
 *
 * Query params:
 *   businessId — required
 */
router.get('/todoist', async (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });

  try {
    const { default: todoistConnector } = await import('../connectors/todoist/index.js');
    const state = Buffer.from(JSON.stringify({ businessId, type: 'todoist' })).toString('base64url');
    const authUrl = await todoistConnector.getAuthUrl(state);
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[oauth] Todoist init error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/oauth/todoist/callback
 * OAuth callback from Todoist.
 */
router.get('/todoist/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);

  let parsedState;
  try {
    parsedState = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return res.redirect(`${clientUrl}/connectors?error=invalid_state`);
  }

  const { businessId } = parsedState;

  try {
    const { default: todoistConnector } = await import('../connectors/todoist/index.js');
    const credentials = await todoistConnector.exchangeCode(code);
    const encryptedCreds = encrypt(JSON.stringify(credentials));

    const existing = db.prepare(
      "SELECT id FROM connectors WHERE business_id = ? AND type = 'todoist'"
    ).get(businessId);

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
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(err.message.substring(0, 100))}`);
  }
});

/**
 * GET /api/oauth/gbp
 * Initiates Google Business Profile OAuth flow.
 */
router.get('/gbp', (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });

  const { clientId, redirectUri: googleRedirect } = readGoogleOAuthConfig();
  const redirectUri = process.env.GBP_REDIRECT_URI ||
    googleRedirect?.replace('/google/callback', '/gbp/callback') ||
    'http://localhost:4000/api/oauth/gbp/callback';
  if (!clientId) {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    return res.redirect(`${clientUrl}/connectors?error=google_oauth_not_configured&detail=${encodeURIComponent('Configure Google OAuth in Settings → Google OAuth first.')}`);
  }

  const state = Buffer.from(JSON.stringify({ businessId, type: 'gbp' })).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'https://www.googleapis.com/auth/business.manage',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return res.redirect(`${AUTH_BASE}?${params.toString()}`);
});

/**
 * GET /api/oauth/gbp/callback
 */
router.get('/gbp/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);

  let parsedState;
  try {
    parsedState = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return res.redirect(`${clientUrl}/connectors?error=invalid_state`);
  }
  const { businessId } = parsedState;

  const { clientId, clientSecret, redirectUri: googleRedirect } = readGoogleOAuthConfig();
  const redirectUri = process.env.GBP_REDIRECT_URI ||
    googleRedirect?.replace('/google/callback', '/gbp/callback') ||
    'http://localhost:4000/api/oauth/gbp/callback';

  try {
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
      const err = await tokenRes.text();
      console.error('[oauth] GBP token exchange failed:', err.substring(0, 300));
      return res.redirect(`${clientUrl}/connectors?error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json();
    const credentials = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
    };
    const encryptedCreds = encrypt(JSON.stringify(credentials));

    const existing = db.prepare(
      "SELECT id FROM connectors WHERE business_id = ? AND type = 'gbp'"
    ).get(businessId);

    if (existing) {
      db.prepare(`
        UPDATE connectors SET credentials = ?, status = 'connected', last_error = NULL WHERE id = ?
      `).run(encryptedCreds, existing.id);
    } else {
      const id = generateId();
      db.prepare(`
        INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
        VALUES (?, ?, 'gbp', 'Google Business Profile', ?, 'connected', '{}', CURRENT_TIMESTAMP)
      `).run(id, businessId, encryptedCreds);
    }

    return res.redirect(`${clientUrl}/connectors?connected=gbp`);
  } catch (err) {
    console.error('[oauth] GBP callback error:', err);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(err.message.substring(0, 100))}`);
  }
});

/**
 * GET /api/oauth/google-ads
 * Initiates Google Ads OAuth flow (uses Google OAuth with adwords scope).
 */
router.get('/google-ads', (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });

  const { clientId, redirectUri: googleRedirect } = readGoogleOAuthConfig();
  const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI ||
    googleRedirect?.replace('/google/callback', '/google-ads/callback') ||
    'http://localhost:4000/api/oauth/google-ads/callback';
  if (!clientId) {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    return res.redirect(`${clientUrl}/connectors?error=google_oauth_not_configured&detail=${encodeURIComponent('Configure Google OAuth in Settings → Google OAuth first.')}`);
  }

  const state = Buffer.from(JSON.stringify({ businessId, type: 'google-ads' })).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return res.redirect(`${AUTH_BASE}?${params.toString()}`);
});

/**
 * GET /api/oauth/google-ads/callback
 */
router.get('/google-ads/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);

  let parsedState;
  try {
    parsedState = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return res.redirect(`${clientUrl}/connectors?error=invalid_state`);
  }
  const { businessId } = parsedState;

  const { clientId, clientSecret, redirectUri: googleRedirect } = readGoogleOAuthConfig();
  const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI ||
    googleRedirect?.replace('/google/callback', '/google-ads/callback') ||
    'http://localhost:4000/api/oauth/google-ads/callback';

  try {
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
      const err = await tokenRes.text();
      console.error('[oauth] Google Ads token exchange failed:', err.substring(0, 300));
      return res.redirect(`${clientUrl}/connectors?error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json();
    const credentials = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
    };
    const encryptedCreds = encrypt(JSON.stringify(credentials));

    const existing = db.prepare(
      "SELECT id FROM connectors WHERE business_id = ? AND type = 'google-ads'"
    ).get(businessId);

    if (existing) {
      db.prepare(`
        UPDATE connectors SET credentials = ?, status = 'connected', last_error = NULL WHERE id = ?
      `).run(encryptedCreds, existing.id);
    } else {
      const id = generateId();
      db.prepare(`
        INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
        VALUES (?, ?, 'google-ads', 'Google Ads', ?, 'connected', '{}', CURRENT_TIMESTAMP)
      `).run(id, businessId, encryptedCreds);
    }

    return res.redirect(`${clientUrl}/connectors?connected=google-ads`);
  } catch (err) {
    console.error('[oauth] Google Ads callback error:', err);
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(err.message.substring(0, 100))}`);
  }
});

/**
 * GET /api/oauth/meta
 * Initiates Meta (Facebook) OAuth flow for Meta Ads connector.
 */
router.get('/meta', async (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId is required.' });

  try {
    const { default: metaConnector } = await import('../connectors/meta-ads/index.js');
    const state = Buffer.from(JSON.stringify({ businessId, type: 'meta-ads' })).toString('base64url');
    const authUrl = await metaConnector.getAuthUrl(state);
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[oauth] Meta init error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/oauth/meta/callback
 * OAuth callback from Meta. Exchanges code for long-lived token, stores encrypted.
 */
router.get('/meta/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error) {
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(error_description || error)}`);
  }
  if (!code || !state) {
    return res.redirect(`${clientUrl}/connectors?error=missing_oauth_params`);
  }

  let parsedState;
  try {
    parsedState = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return res.redirect(`${clientUrl}/connectors?error=invalid_state`);
  }
  const { businessId } = parsedState;

  try {
    const { default: metaConnector } = await import('../connectors/meta-ads/index.js');
    const credentials = await metaConnector.exchangeCode(code);
    const encryptedCreds = encrypt(JSON.stringify(credentials));

    const existing = db.prepare(
      "SELECT id FROM connectors WHERE business_id = ? AND type = 'meta-ads'"
    ).get(businessId);

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
    return res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(err.message.substring(0, 100))}`);
  }
});

/**
 * DELETE /api/oauth/meta/:businessId
 * Disconnect the Meta Ads connector.
 */
router.delete('/meta/:businessId', isAuthenticated, (req, res) => {
  const { businessId } = req.params;
  db.prepare(`
    UPDATE connectors
    SET status = 'disconnected', credentials = ?, last_error = NULL
    WHERE business_id = ? AND type = 'meta-ads'
  `).run(encrypt(JSON.stringify({})), businessId);
  return res.json({ ok: true });
});

/**
 * DELETE /api/oauth/google/:businessId
 * Revokes Google access and sets GSC + GA4 connectors to disconnected.
 */
router.delete('/google/:businessId', isAuthenticated, async (req, res) => {
  const { businessId } = req.params;

  const connectors = db.prepare(
    "SELECT * FROM connectors WHERE business_id = ? AND type IN ('gsc', 'ga4')"
  ).all(businessId);

  // Attempt token revocation (best-effort)
  for (const connector of connectors) {
    if (!connector.credentials) continue;
    try {
      const creds = JSON.parse(decrypt(connector.credentials));
      const tokenToRevoke = creds.accessToken || creds.refreshToken;
      if (tokenToRevoke) {
        await fetch(`${REVOKE_URL}?token=${encodeURIComponent(tokenToRevoke)}`, {
          method: 'POST',
        }).catch(() => {});
      }
    } catch { /* non-fatal */ }
  }

  // Disconnect all Google connectors for this business
  db.prepare(`
    UPDATE connectors
    SET status = 'disconnected', credentials = ?, last_error = NULL
    WHERE business_id = ? AND type IN ('gsc', 'ga4')
  `).run(encrypt(JSON.stringify({})), businessId);

  console.log(`[oauth] Revoked Google access for business ${businessId} (${connectors.length} connectors)`);
  return res.json({ ok: true, disconnected: connectors.length });
});

// ─── Google OAuth app credentials (Client ID / Secret / redirect URI) ─────────
// Stored in settings.google_oauth_config with the secret encrypted. This lets
// the user paste credentials into the Settings UI instead of editing .env.

/**
 * GET /api/oauth/google/config
 * Returns the current Google OAuth configuration. The secret is NEVER returned
 * in plain text — only a boolean `has_secret` flag.
 */
router.get('/google/config', isAuthenticated, (req, res) => {
  try {
    const cfg = readGoogleOAuthConfig();
    // Expose whether the *live* config resolves (via DB or env), and the
    // storage source so the user can tell if they're overriding env.
    const storedRow = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get();
    let stored = null;
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
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/oauth/google/config
 * Body: { client_id, client_secret, redirect_uri }
 *   - Pass an empty string or omit a field to delete that slot (falls back to env).
 *   - Pass `null` for client_secret to leave it unchanged (so the UI can edit
 *     client_id without re-entering the secret).
 */
router.put('/google/config', isAuthenticated, (req, res) => {
  try {
    const { client_id, client_secret, redirect_uri } = req.body ?? {};

    // Read existing so we can preserve the secret when not re-submitted.
    let existing = {};
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'google_oauth_config'").get();
      existing = row?.value ? JSON.parse(row.value) : {};
    } catch {}

    const next = {
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
    return res.status(500).json({ error: err.message });
  }
});

export default router;
