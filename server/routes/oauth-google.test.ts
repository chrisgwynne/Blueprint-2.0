import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import crypto from 'crypto';

const ORIGINAL_ENV = Object.fromEntries([
  'SESSION_SECRET', 'ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI', 'CLIENT_URL',
].map(key => [key, process.env[key]]));

process.env.SESSION_SECRET = 'g'.repeat(64);
process.env.ENCRYPTION_KEY = '11'.repeat(32);
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/oauth/google/callback';
process.env.CLIENT_URL = 'http://localhost:5173';

let tokenResponse: Record<string, unknown> | undefined;
const fetchMock = mock(async (input: string, init?: { body?: URLSearchParams }) => {
  if (String(input).includes('/revoke')) {
    return new Response('', { status: 200 });
  }
  const body = init?.body;
  if (body?.get('grant_type') === 'authorization_code') {
    return new Response(JSON.stringify(tokenResponse ?? {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
      scope: body.get('redirect_uri')?.includes('google-ads')
        ? 'https://www.googleapis.com/auth/adwords'
        : 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly',
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ access_token: 'refreshed-token', expires_in: 3600 }), { status: 200 });
});

mock.module('node-fetch', () => ({ default: fetchMock }));

const { default: db } = await import('../db/db.js');
const { encrypt, decrypt } = await import('../crypto.js');
const { default: oauthRouter } = await import('./oauth.js');
const { createOAuthState } = await import('../connectors/social/oauth-state.js');

const BIZ = 'biz_google_oauth_secure';
const USER = 'user_google_oauth_secure';
const CLIENT_FINGERPRINT = crypto.createHash('sha256').update(process.env.GOOGLE_CLIENT_ID!).digest('base64url').slice(0, 16);

function makeApp(userId?: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false, cookie: { sameSite: 'lax' } }));
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
  const app = makeApp(USER);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  tokenResponse = undefined;
  fetchMock.mockClear();
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
  db.prepare('DELETE FROM oauth_nonces').run();
  db.prepare("DELETE FROM settings WHERE key = 'google_oauth_config'").run();
});

afterAll(async () => {
  try {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function seedBusiness(): void {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Google OAuth Secure', 'google-oauth-secure')`).run(BIZ);
}

async function initiate(path: string): Promise<{ location: URL; cookie: string }> {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  const location = new URL(res.headers.get('location')!);
  return { location, cookie };
}

function decodeState(state: string): any {
  return JSON.parse(Buffer.from(state.slice(0, state.lastIndexOf('.')), 'base64url').toString('utf8'));
}

function signRawState(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = crypto.createHash('sha256').update(process.env.SESSION_SECRET!).digest();
  const signature = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  db.prepare('INSERT INTO oauth_nonces (nonce, expires_at) VALUES (?, ?)').run(String(payload.nonce), new Date(Number(payload.expiresAt)).toISOString());
  return `${encoded}.${signature}`;
}

describe('Google OAuth initiation', () => {
  test('requires an authenticated session', async () => {
    seedBusiness();
    const other = makeApp();
    const otherServer = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
      const s = other.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = otherServer.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/oauth/google?businessId=${BIZ}`, { redirect: 'manual' });
    await new Promise((resolve) => otherServer.close(resolve));
    expect(res.status).toBe(401);
  });

  test('uses signed state and exact least scopes without identity scopes', async () => {
    seedBusiness();
    const { location } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc,ga4`);
    const scopes = location.searchParams.get('scope')?.split(' ') ?? [];
    expect(scopes).toEqual([
      'https://www.googleapis.com/auth/webmasters.readonly',
      'https://www.googleapis.com/auth/analytics.readonly',
    ]);
    expect(scopes).not.toContain('email');
    expect(scopes).not.toContain('profile');
    expect(location.searchParams.get('state')).toContain('.');
    expect(location.searchParams.get('prompt')).toBe('consent');
  });

  test('rejects a request that mixes supported and unsupported connector types', async () => {
    seedBusiness();
    const res = await fetch(`${baseUrl}/api/oauth/google?businessId=${BIZ}&types=gsc,evil`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  test('rejects empty and duplicate Google connector type sets before creating state', async () => {
    seedBusiness();
    const empty = await fetch(`${baseUrl}/api/oauth/google?businessId=${BIZ}&types=`, { redirect: 'manual' });
    const duplicate = await fetch(`${baseUrl}/api/oauth/google?businessId=${BIZ}&types=gsc,gsc`, { redirect: 'manual' });
    expect(empty.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM oauth_nonces').get()).toMatchObject({ count: 0 });
  });

  test('omits prompt=consent when an existing grant has refresh token and scopes', async () => {
    seedBusiness();
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, status, credentials, created_at)
      VALUES ('existing-gsc', ?, 'gsc', 'GSC', 'connected', ?, CURRENT_TIMESTAMP),
             ('existing-ga4', ?, 'ga4', 'GA4', 'connected', ?, CURRENT_TIMESTAMP)
    `).run(
      BIZ,
      encrypt(JSON.stringify({ refreshToken: 'r1', scope: 'https://www.googleapis.com/auth/webmasters.readonly', oauthClientIdFingerprint: CLIENT_FINGERPRINT })),
      BIZ,
      encrypt(JSON.stringify({ refreshToken: 'r2', scope: 'https://www.googleapis.com/auth/analytics.readonly', oauthClientIdFingerprint: CLIENT_FINGERPRINT })),
    );
    const { location } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc,ga4`);
    expect(location.searchParams.get('prompt')).toBeNull();
  });

  test('forces consent when the stored refresh token belongs to another OAuth client', async () => {
    seedBusiness();
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, status, credentials, created_at)
      VALUES ('old-client-gsc', ?, 'gsc', 'GSC', 'connected', ?, CURRENT_TIMESTAMP)
    `).run(BIZ, encrypt(JSON.stringify({
      refreshToken: 'old-client-refresh',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      oauthClientIdFingerprint: 'different-client',
    })));
    const { location } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    expect(location.searchParams.get('prompt')).toBe('consent');
  });
});

describe('Google OAuth callback state validation', () => {
  test('rejects tampered state before token exchange', async () => {
    seedBusiness();
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    const state = `${location.searchParams.get('state')}x`;
    const res = await fetch(`${baseUrl}/api/oauth/google/callback?code=fake&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    expect(res.headers.get('location')).toContain('state_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects replay before token exchange', async () => {
    seedBusiness();
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    const state = location.searchParams.get('state')!;
    const first = await fetch(`${baseUrl}/api/oauth/google/callback?code=fake&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    expect(first.headers.get('location')).toContain('connected=google');
    fetchMock.mockClear();
    const second = await fetch(`${baseUrl}/api/oauth/google/callback?code=fake&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    expect(second.headers.get('location')).toContain('state_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects expired, wrong family, wrong user, and wrong session state before token exchange', async () => {
    seedBusiness();
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    const live = decodeState(location.searchParams.get('state')!);
    db.prepare('DELETE FROM oauth_nonces').run();

    const states = [
      await createOAuthState({ businessId: BIZ, userId: USER, type: 'google', family: 'google', types: ['gsc'], sessionHash: live.sessionHash }, -1),
      await createOAuthState({ businessId: BIZ, userId: USER, type: 'google', family: 'social', types: ['gsc'], sessionHash: live.sessionHash }),
      await createOAuthState({ businessId: BIZ, userId: 'other-user', type: 'google', family: 'google', types: ['gsc'], sessionHash: live.sessionHash }),
      await createOAuthState({ businessId: BIZ, userId: USER, type: 'google', family: 'google', types: ['gsc'], sessionHash: 'wrong-session' }),
    ];
    for (const candidate of states) {
      const response = await fetch(`${baseUrl}/api/oauth/google/callback?code=fake&state=${encodeURIComponent(candidate)}`, {
        redirect: 'manual', headers: { Cookie: cookie },
      });
      expect(response.headers.get('location')).toContain('state_invalid');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM connectors WHERE business_id = ?').get(BIZ)).toMatchObject({ count: 0 });
  });

  test('rejects wrong route, unknown business, empty, duplicate, and malformed signed type sets without exchange or connector mutation', async () => {
    seedBusiness();
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    const live = decodeState(location.searchParams.get('state')!);
    db.prepare('DELETE FROM oauth_nonces').run();
    const states = [
      { route: 'gbp/callback', state: await createOAuthState({ businessId: BIZ, userId: USER, type: 'google', family: 'google', types: ['gsc'], sessionHash: live.sessionHash }) },
      { route: 'google/callback', state: await createOAuthState({ businessId: 'other-business', userId: USER, type: 'google', family: 'google', types: ['gsc'], sessionHash: live.sessionHash }) },
      { route: 'google/callback', state: signRawState({ ...live, nonce: crypto.randomUUID(), expiresAt: Date.now() + 60_000, types: [] }) },
      { route: 'google/callback', state: signRawState({ ...live, nonce: crypto.randomUUID(), expiresAt: Date.now() + 60_000, types: ['gsc', 'gsc'] }) },
      { route: 'google/callback', state: signRawState({ ...live, nonce: crypto.randomUUID(), expiresAt: Date.now() + 60_000, types: ['gsc', 7] }) },
    ];
    for (const item of states) {
      const response = await fetch(`${baseUrl}/api/oauth/${item.route}?code=fake&state=${encodeURIComponent(item.state)}`, {
        redirect: 'manual', headers: { Cookie: cookie },
      });
      expect(response.status === 400 || (response.headers.get('location') ?? '').includes('state_invalid')).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM connectors WHERE business_id IN (?, ?)').get(BIZ, 'other-business')).toMatchObject({ count: 0 });
  });

  test('preserves existing refresh token when Google omits one', async () => {
    seedBusiness();
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, status, credentials, config, created_at)
      VALUES ('existing-gsc', ?, 'gsc', 'GSC', 'connected', ?, '{"siteUrl":"sc-domain:example.com"}', CURRENT_TIMESTAMP)
    `).run(BIZ, encrypt(JSON.stringify({ refreshToken: 'existing-refresh-token', accessToken: 'old-token', scope: 'https://www.googleapis.com/auth/webmasters.readonly', oauthClientIdFingerprint: CLIENT_FINGERPRINT })));
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    tokenResponse = {
      access_token: 'new-access-token', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    };
    const res = await fetch(`${baseUrl}/api/oauth/google/callback?code=fake&state=${encodeURIComponent(location.searchParams.get('state')!)}`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    expect(res.headers.get('location')).toContain('connected=google');
    const row = db.prepare("SELECT credentials, config FROM connectors WHERE id = 'existing-gsc'").get() as { credentials: string; config: string };
    const creds = JSON.parse(decrypt(row.credentials));
    const config = JSON.parse(row.config);
    expect(creds.refreshToken).toBe('existing-refresh-token');
    expect(creds.accessToken).toBe('new-access-token');
    expect(creds.oauthClientIdFingerprint).toBeTruthy();
    expect(config.siteUrl).toBe('sc-domain:example.com');
    expect(config.requiredScopes).toEqual(['https://www.googleapis.com/auth/webmasters.readonly']);
  });

  test('does not report a new grant connected without a refresh token', async () => {
    seedBusiness();
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    tokenResponse = {
      access_token: 'temporary-access', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    };
    const callback = await fetch(`${baseUrl}/api/oauth/google/callback?code=ok&state=${encodeURIComponent(location.searchParams.get('state')!)}`, {
      redirect: 'manual', headers: { Cookie: cookie },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('error=google_grant_incomplete');
    const row = db.prepare("SELECT status, last_error FROM connectors WHERE business_id = ? AND type = 'gsc'").get(BIZ) as any;
    expect(row.status).toBe('error');
    expect(row.last_error).toContain('refresh token');
  });

  test('does not report a connector connected when its required scope was not granted', async () => {
    seedBusiness();
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc,ga4`);
    tokenResponse = {
      access_token: 'partial-access', refresh_token: 'partial-refresh', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    };
    const callback = await fetch(`${baseUrl}/api/oauth/google/callback?code=ok&state=${encodeURIComponent(location.searchParams.get('state')!)}`, {
      redirect: 'manual', headers: { Cookie: cookie },
    });
    expect(callback.headers.get('location')).toContain('error=google_grant_incomplete');
    const rows = db.prepare("SELECT type, status, last_error FROM connectors WHERE business_id = ? ORDER BY type").all(BIZ) as any[];
    expect(rows.find(row => row.type === 'gsc').status).toBe('connected');
    expect(rows.find(row => row.type === 'ga4').status).toBe('error');
    expect(rows.find(row => row.type === 'ga4').last_error).toContain('analytics.readonly');
  });

  test('rejects an invalid token success payload without mutating connectors or leaking it', async () => {
    seedBusiness();
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    tokenResponse = { access_token: '', expires_in: 0, scope: 'https://www.googleapis.com/auth/webmasters.readonly' };
    const callback = await fetch(`${baseUrl}/api/oauth/google/callback?code=ok&state=${encodeURIComponent(location.searchParams.get('state')!)}`, {
      redirect: 'manual', headers: { Cookie: cookie },
    });
    expect(callback.headers.get('location')).toContain('error=invalid_token_response');
    expect(callback.headers.get('location')).not.toContain('access_token');
    expect(db.prepare('SELECT COUNT(*) AS count FROM connectors WHERE business_id = ?').get(BIZ)).toMatchObject({ count: 0 });
  });

  test('rejects a callback for a business deleted after initiation before token exchange', async () => {
    seedBusiness();
    const { location, cookie } = await initiate(`/api/oauth/google?businessId=${BIZ}&types=gsc`);
    db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
    const callsBefore = fetchMock.mock.calls.length;
    const callback = await fetch(`${baseUrl}/api/oauth/google/callback?code=ok&state=${encodeURIComponent(location.searchParams.get('state')!)}`, {
      redirect: 'manual', headers: { Cookie: cookie },
    });
    expect(callback.status).toBe(400);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('Dedicated Google grants', () => {
  test('Google Ads requires customerId and persists it through callback', async () => {
    seedBusiness();
    const missing = await fetch(`${baseUrl}/api/oauth/google-ads?businessId=${BIZ}`, { redirect: 'manual' });
    expect(missing.status).toBe(400);

    const { location, cookie } = await initiate(`/api/oauth/google-ads?businessId=${BIZ}&customerId=123-456-7890&managerAccountId=999-888-7777`);
    expect(location.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
    const res = await fetch(`${baseUrl}/api/oauth/google-ads/callback?code=fake&state=${encodeURIComponent(location.searchParams.get('state')!)}`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    expect(res.headers.get('location')).toContain('connected=google-ads');
    const row = db.prepare("SELECT config FROM connectors WHERE business_id = ? AND type = 'google-ads'").get(BIZ) as { config: string };
    expect(JSON.parse(row.config).customerId).toBe('1234567890');
    expect(JSON.parse(row.config).managerAccountId).toBe('9998887777');
  });

  test('Google Ads rejects non-10-digit customer and manager IDs before creating state', async () => {
    seedBusiness();
    for (const query of [
      'customerId=123456789',
      'customerId=12345678901',
      'customerId=abcdefghij',
      'customerId=123-456-7890&managerAccountId=not-an-id',
      'customerId=123-456-7890&managerAccountId=123456789',
    ]) {
      const res = await fetch(`${baseUrl}/api/oauth/google-ads?businessId=${BIZ}&${query}`, { redirect: 'manual' });
      expect(res.status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM oauth_nonces').get()).toMatchObject({ count: 0 });
  });

  test('revokes only the requested Google grant family with form-body token revoke', async () => {
    seedBusiness();
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, status, credentials, created_at)
      VALUES ('gsc-revoke', ?, 'gsc', 'GSC', 'connected', ?, CURRENT_TIMESTAMP),
             ('ads-revoke', ?, 'google-ads', 'Ads', 'connected', ?, CURRENT_TIMESTAMP)
    `).run(
      BIZ,
      encrypt(JSON.stringify({ refreshToken: 'gsc-refresh', accessToken: 'gsc-access' })),
      BIZ,
      encrypt(JSON.stringify({ refreshToken: 'ads-refresh', accessToken: 'ads-access' })),
    );
    const res = await fetch(`${baseUrl}/api/oauth/google/${BIZ}?type=google-ads`, { method: 'DELETE' });
    expect(await res.json()).toMatchObject({ ok: true, disconnected: 1 });
    const gsc = db.prepare("SELECT status FROM connectors WHERE id = 'gsc-revoke'").get() as { status: string };
    const ads = db.prepare("SELECT status FROM connectors WHERE id = 'ads-revoke'").get() as { status: string };
    expect(gsc.status).toBe('connected');
    expect(ads.status).toBe('disconnected');
    expect((fetchMock.mock.calls[0]?.[1] as { body?: URLSearchParams }).body?.get('token')).toBe('ads-refresh');
  });

  test('does not erase local credentials when Google revocation fails', async () => {
    seedBusiness();
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, status, credentials, created_at)
      VALUES ('ads-revoke-fail', ?, 'google-ads', 'Ads', 'connected', ?, CURRENT_TIMESTAMP)
    `).run(BIZ, encrypt(JSON.stringify({ refreshToken: 'fail-revoke', accessToken: 'ads-access' })));
    fetchMock.mockImplementationOnce(async () => new Response('revocation failed', { status: 500 }));
    const res = await fetch(`${baseUrl}/api/oauth/google/${BIZ}?type=google-ads`, { method: 'DELETE' });
    expect(res.status).toBe(502);
    const row = db.prepare("SELECT status, credentials FROM connectors WHERE id = 'ads-revoke-fail'").get() as { status: string; credentials: string };
    expect(row.status).toBe('connected');
    expect(JSON.parse(decrypt(row.credentials)).refreshToken).toBe('fail-revoke');
  });

  test('sanitizes Google revocation bodies from response JSON and logs while retaining local credentials', async () => {
    seedBusiness();
    const fakeSecret = 'fake-secret-token-do-not-reflect';
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, status, credentials, created_at)
      VALUES ('ads-revoke-secret', ?, 'google-ads', 'Ads', 'connected', ?, CURRENT_TIMESTAMP)
    `).run(BIZ, encrypt(JSON.stringify({ refreshToken: 'retained-refresh-token', accessToken: 'ads-access' })));
    fetchMock.mockImplementationOnce(async () => new Response(`provider says ${fakeSecret}`, { status: 500 }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const res = await fetch(`${baseUrl}/api/oauth/google/${BIZ}?type=google-ads`, { method: 'DELETE' });
      const responseText = await res.text();
      expect(res.status).toBe(502);
      expect(JSON.parse(responseText)).toMatchObject({
        ok: false,
        revoke: [{ type: 'google-ads', ok: false, error: 'remote_revoke_failed' }],
      });
      expect(responseText).not.toContain(fakeSecret);
      expect(warnings.join('\n')).not.toContain(fakeSecret);
      expect(warnings.join('\n')).not.toContain('retained-refresh-token');
    } finally {
      console.warn = originalWarn;
    }
    const row = db.prepare("SELECT status, credentials FROM connectors WHERE id = 'ads-revoke-secret'").get() as { status: string; credentials: string };
    expect(row.status).toBe('connected');
    expect(JSON.parse(decrypt(row.credentials)).refreshToken).toBe('retained-refresh-token');
  });

  test('disconnects every connector sharing a successfully revoked grant token', async () => {
    seedBusiness();
    const shared = encrypt(JSON.stringify({ refreshToken: 'shared-refresh', accessToken: 'shared-access' }));
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, status, credentials, created_at)
      VALUES ('shared-gsc', ?, 'gsc', 'GSC', 'connected', ?, CURRENT_TIMESTAMP),
             ('shared-ga4', ?, 'ga4', 'GA4', 'connected', ?, CURRENT_TIMESTAMP)
    `).run(BIZ, shared, BIZ, shared);
    const res = await fetch(`${baseUrl}/api/oauth/google/${BIZ}?type=gsc`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = db.prepare("SELECT status FROM connectors WHERE id IN ('shared-gsc','shared-ga4') ORDER BY id").all() as Array<{ status: string }>;
    expect(rows.map(row => row.status)).toEqual(['disconnected', 'disconnected']);
  });

  test('retains only grants whose remote revoke failed when a family revoke is partial', async () => {
    seedBusiness();
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, status, credentials, created_at)
      VALUES ('partial-gsc', ?, 'gsc', 'GSC', 'connected', ?, CURRENT_TIMESTAMP),
             ('partial-ga4', ?, 'ga4', 'GA4', 'connected', ?, CURRENT_TIMESTAMP)
    `).run(
      BIZ, encrypt(JSON.stringify({ refreshToken: 'success-token' })),
      BIZ, encrypt(JSON.stringify({ refreshToken: 'failure-token' })),
    );
    fetchMock
      .mockImplementationOnce(async () => new Response('', { status: 200 }))
      .mockImplementationOnce(async () => new Response('failed', { status: 500 }));
    const res = await fetch(`${baseUrl}/api/oauth/google/${BIZ}?type=google`, { method: 'DELETE' });
    expect(res.status).toBe(502);
    const rows = db.prepare("SELECT id, status FROM connectors WHERE id LIKE 'partial-%' ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual([
      { id: 'partial-ga4', status: 'connected' },
      { id: 'partial-gsc', status: 'disconnected' },
    ]);
  });
});
