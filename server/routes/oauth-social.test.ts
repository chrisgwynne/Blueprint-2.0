/**
 * TDD tests for the social connector OAuth flow security.
 * Tests: state tampering, expiry, replay, session binding, CSRF, cross-business.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { encrypt } from '../crypto.js';

process.env.META_APP_ID = 'test_oauth_app';
process.env.META_APP_SECRET = 'test_oauth_secret';
process.env.SESSION_SECRET = 'c'.repeat(64);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SOCIAL_REDIRECT_URI = 'http://localhost:4000/api/oauth/social/callback';
process.env.CLIENT_URL = 'http://localhost:5173';

import oauthRouter from './oauth.js';
import { createOAuthState } from '../connectors/social/oauth-state.js';

const BIZ = 'biz_oauth_test';
const USER = 'user_oauth_test';

function makeApp(userId?: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));
  if (userId) {
    app.use((req, _res, next) => {
      (req.session as any).userId = userId;
      next();
    });
  }
  app.use('/api/oauth', oauthRouter);
  return app;
}

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

beforeAll(async () => {
  db.prepare(`INSERT OR IGNORE INTO businesses (id, name, slug) VALUES (?, 'OAuth Test', 'oauth-test')`).run(BIZ);
  const app = makeApp(USER);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('GET /api/oauth/social — initiate flow', () => {
  test('400 without businessId', async () => {
    const res = await fetch(`${baseUrl}/api/oauth/social`);
    expect(res.status).toBe(400);
  });

  test('redirects to Facebook with valid state when configured', async () => {
    const res = await fetch(`${baseUrl}/api/oauth/social?businessId=${BIZ}`, { redirect: 'manual' });
    // Should redirect (302) to Facebook
    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    expect(location).toContain('facebook.com');
    expect(location).toContain('state=');
  });
});

describe('GET /api/oauth/social/callback — security', () => {
  test('rejects missing code or state', async () => {
    const res = await fetch(`${baseUrl}/api/oauth/social/callback`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('error=');
  });

  test('rejects invalid/tampered state', async () => {
    const res = await fetch(
      `${baseUrl}/api/oauth/social/callback?code=fake_code&state=tampered_state_xyz`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('error=');
  });

  test('rejects expired state', async () => {
    const expiredState = await createOAuthState(
      { businessId: BIZ, userId: USER, type: 'social' },
      -1, // expired
    );
    const res = await fetch(
      `${baseUrl}/api/oauth/social/callback?code=fake_code&state=${encodeURIComponent(expiredState)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('error=');
  });

  test('rejects plaintext base64 state (legacy format)', async () => {
    // Old format: base64(JSON) without HMAC — should be rejected
    const legacyState = Buffer.from(JSON.stringify({ businessId: BIZ, type: 'social' })).toString('base64url');
    const res = await fetch(
      `${baseUrl}/api/oauth/social/callback?code=fake_code&state=${encodeURIComponent(legacyState)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    // Should fail because unsigned state is rejected
    expect(loc).toContain('error=');
  });

  test('user mismatch — callback from different user session is rejected', async () => {
    // Create state for USER
    const state = await createOAuthState({ businessId: BIZ, userId: USER, type: 'social' });

    // Make a request with a different userId in session (no userId = no session binding)
    const otherApp = makeApp('other_user'); // Different user
    const otherServer = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
      const s = otherApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const otherAddr = otherServer.address() as AddressInfo;

    const res = await fetch(
      `http://127.0.0.1:${otherAddr.port}/api/oauth/social/callback?code=fake_code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    await new Promise((r) => otherServer.close(r));
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('error=');
  });
});
