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

/**
 * GET /api/oauth/google
 * Initiates Google OAuth flow. Redirects the browser to Google consent screen.
 *
 * Query params:
 *   businessId  — required
 *   types       — comma-separated connector types to create (default: gsc,ga4)
 */
router.get('/google', (req, res) => {
  const { businessId, types = 'gsc,ga4' } = req.query;

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required.' });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID is not configured on the server.' });
  }
  if (!redirectUri) {
    return res.status(500).json({ error: 'GOOGLE_REDIRECT_URI is not configured on the server.' });
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

  return res.redirect(`${AUTH_BASE}?${params.toString()}`);
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

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

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

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GBP_REDIRECT_URI ||
    process.env.GOOGLE_REDIRECT_URI?.replace('/google/callback', '/gbp/callback') ||
    'http://localhost:4000/api/oauth/gbp/callback';
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID is not configured.' });

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

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GBP_REDIRECT_URI ||
    process.env.GOOGLE_REDIRECT_URI?.replace('/google/callback', '/gbp/callback') ||
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

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI || `${process.env.GOOGLE_REDIRECT_URI?.replace('/google/callback', '/google-ads/callback')}`;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID is not configured.' });

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

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI || `${process.env.GOOGLE_REDIRECT_URI?.replace('/google/callback', '/google-ads/callback')}`;

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

export default router;
