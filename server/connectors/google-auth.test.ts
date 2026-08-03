import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';

const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ORIGINAL_GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
process.env.ENCRYPTION_KEY = '00'.repeat(32);
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';

const tokenFetch = mock(async (_input: string, init?: { body?: URLSearchParams }) => {
  const body = init?.body;
  if (body?.get('refresh_token') !== 'compatible-refresh-token') {
    return new Response(JSON.stringify({ error: 'unexpected refresh token' }), { status: 400 });
  }
  return new Response(JSON.stringify({
    access_token: 'refreshed-compatible-token',
    expires_in: 3600,
  }), { status: 200 });
});

mock.module('node-fetch', () => ({ default: tokenFetch }));

const { default: db } = await import('../db/db.js');
const { encrypt, decrypt } = await import('../crypto.js');
const { getValidGoogleAccessToken } = await import('./google-auth.js');

const BUSINESS_ID = 'biz-google-auth-scope-test';

function insertConnector(input: {
  id: string;
  type: string;
  credentials: Record<string, unknown>;
  lastSync: string;
}): void {
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, credentials, last_sync, created_at)
    VALUES (?, ?, ?, ?, 'connected', ?, ?, ?)
  `).run(
    input.id,
    BUSINESS_ID,
    input.type,
    input.type,
    encrypt(JSON.stringify(input.credentials)),
    input.lastSync,
    input.lastSync,
  );
}

afterEach(() => {
  tokenFetch.mockClear();
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BUSINESS_ID);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BUSINESS_ID);
});

afterAll(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  if (ORIGINAL_GOOGLE_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = ORIGINAL_GOOGLE_CLIENT_ID;
  if (ORIGINAL_GOOGLE_CLIENT_SECRET === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = ORIGINAL_GOOGLE_CLIENT_SECRET;
});

describe('getValidGoogleAccessToken scope filtering', () => {
  test('preserves latest-connector selection when no required scope is requested', async () => {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    insertConnector({
      id: 'newer-gbp',
      type: 'gbp',
      lastSync: '2026-08-03T12:00:00.000Z',
      credentials: {
        refreshToken: 'gbp-refresh-token',
        accessToken: 'newer-gbp-token',
        expiresAt: Date.now() + 3_600_000,
        scope: 'https://www.googleapis.com/auth/business.manage',
      },
    });
    insertConnector({
      id: 'older-gsc',
      type: 'gsc',
      lastSync: '2026-08-02T12:00:00.000Z',
      credentials: {
        refreshToken: 'compatible-refresh-token',
        accessToken: 'older-gsc-token',
        expiresAt: Date.now() + 3_600_000,
        scope: 'openid https://www.googleapis.com/auth/webmasters.readonly',
      },
    });

    const token = await getValidGoogleAccessToken(BUSINESS_ID);

    expect(token?.accessToken).toBe('newer-gbp-token');
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  test('skips incompatible fresher credentials and refreshes a compatible credential', async () => {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    insertConnector({
      id: 'newer-gbp',
      type: 'gbp',
      lastSync: '2026-08-03T12:00:00.000Z',
      credentials: {
        refreshToken: 'gbp-refresh-token',
        accessToken: 'newer-gbp-token',
        expiresAt: Date.now() - 3_600_000,
        scope: 'https://www.googleapis.com/auth/business.manage',
      },
    });
    insertConnector({
      id: 'older-gsc',
      type: 'gsc',
      lastSync: '2026-08-02T12:00:00.000Z',
      credentials: {
        refreshToken: 'compatible-refresh-token',
        accessToken: 'expired-gsc-token',
        expiresAt: Date.now() - 3_600_000,
        scopes: ['openid', 'https://www.googleapis.com/auth/webmasters.readonly'],
      },
    });

    const token = await getValidGoogleAccessToken(BUSINESS_ID, { requiredScope: 'openid' });

    expect(token?.accessToken).toBe('refreshed-compatible-token');
    expect(tokenFetch).toHaveBeenCalledTimes(1);

    const row = db.prepare("SELECT credentials FROM connectors WHERE id = 'older-gsc'").get() as { credentials: string };
    const saved = JSON.parse(decrypt(row.credentials)) as { accessToken?: string; refreshToken?: string; scopes?: string[] };
    expect(saved.accessToken).toBe('refreshed-compatible-token');
    expect(saved.refreshToken).toBe('compatible-refresh-token');
    expect(saved.scopes).toEqual(['openid', 'https://www.googleapis.com/auth/webmasters.readonly']);
  });

  test('keeps a credential with unknown stored scopes eligible when a required scope is requested', async () => {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    insertConnector({
      id: 'newer-gbp',
      type: 'gbp',
      lastSync: '2026-08-03T12:00:00.000Z',
      credentials: {
        refreshToken: 'gbp-refresh-token',
        accessToken: 'newer-gbp-token',
        expiresAt: Date.now() + 3_600_000,
        scope: 'https://www.googleapis.com/auth/business.manage',
      },
    });
    insertConnector({
      id: 'older-legacy-gsc',
      type: 'gsc',
      lastSync: '2026-08-02T12:00:00.000Z',
      credentials: {
        refreshToken: 'legacy-refresh-token',
        accessToken: 'legacy-gsc-token',
        expiresAt: Date.now() + 3_600_000,
      },
    });

    const token = await getValidGoogleAccessToken(BUSINESS_ID, { requiredScope: 'openid' });

    expect(token?.accessToken).toBe('legacy-gsc-token');
    expect(tokenFetch).not.toHaveBeenCalled();
  });
});
