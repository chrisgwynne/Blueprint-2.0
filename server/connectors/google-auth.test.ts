import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import crypto from 'crypto';

const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ORIGINAL_GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
process.env.ENCRYPTION_KEY = '00'.repeat(32);
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';

const tokenFetch = mock(async (_input: string, init?: { body?: URLSearchParams }) => {
  const body = init?.body;
  if (body?.get('refresh_token') === 'old-refresh-token') {
    await oldRefreshGate;
    return new Response(JSON.stringify({ access_token: 'old-refreshed-access', expires_in: 3600 }), { status: 200 });
  }
  if (body?.get('refresh_token') === 'new-refresh-token') {
    return new Response(JSON.stringify({ access_token: 'new-refreshed-access', expires_in: 3600 }), { status: 200 });
  }
  if (body?.get('refresh_token') === 'merchant-refresh-token' && body.get('client_id') === 'db-google-client-id') {
    return new Response(JSON.stringify({
      access_token: 'refreshed-merchant-token',
      expires_in: 3600,
    }), { status: 200 });
  }
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
const { getValidGoogleAccessToken, refreshGoogleConnectorCredentials, isDurableGoogleCredential } = await import('./google-auth.js');

const BUSINESS_ID = 'biz-google-auth-scope-test';
const CLIENT_FINGERPRINT = crypto.createHash('sha256').update('test-google-client-id').digest('base64url').slice(0, 16);
let releaseOldRefresh: () => void = () => {};
let oldRefreshGate: Promise<void> = Promise.resolve();

function resetOldRefreshGate(): void {
  oldRefreshGate = new Promise<void>((resolve) => { releaseOldRefresh = resolve; });
}

function durable(credentials: Record<string, unknown>): Record<string, unknown> {
  return { oauthClientIdFingerprint: CLIENT_FINGERPRINT, ...credentials };
}

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
  releaseOldRefresh();
  oldRefreshGate = Promise.resolve();
  tokenFetch.mockClear();
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BUSINESS_ID);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BUSINESS_ID);
  db.prepare("DELETE FROM settings WHERE key = 'google_oauth_config'").run();
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
  test('does not classify temporary or unbound OAuth access as a durable connected grant', () => {
    const currentFingerprint = crypto.createHash('sha256').update(process.env.GOOGLE_CLIENT_ID!).digest('base64url').slice(0, 16);
    expect(isDurableGoogleCredential('gsc', {
      accessToken: 'temporary', expiresAt: Date.now() + 60_000,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    })).toBe(false);
    expect(isDurableGoogleCredential('gsc', {
      accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly', oauthClientIdFingerprint: currentFingerprint,
    })).toBe(true);
    expect(isDurableGoogleCredential('gsc', {
      refreshToken: 'refresh', scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      oauthClientIdFingerprint: 'another-client',
    })).toBe(false);
  });
  test('rejects a still-valid scoped access token when no durable refresh grant exists', async () => {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    insertConnector({
      id: 'access-only-gsc',
      type: 'gsc',
      lastSync: '2026-08-03T12:00:00.000Z',
      credentials: {
        accessToken: 'still-valid-access-token',
        expiresAt: Date.now() + 3_600_000,
        scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      },
    });
    const token = await getValidGoogleAccessToken(BUSINESS_ID, {
      requiredScope: 'https://www.googleapis.com/auth/webmasters.readonly',
      connectorTypes: ['gsc'],
    });
    expect(token).toBeNull();
    expect(tokenFetch).not.toHaveBeenCalled();
  });

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
        oauthClientIdFingerprint: CLIENT_FINGERPRINT,
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
        oauthClientIdFingerprint: CLIENT_FINGERPRINT,
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

  test('rejects legacy credentials with unknown stored scopes when a required scope is requested', async () => {
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

    expect(token).toBeNull();
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  test('refreshes Ads/Merchant connector types with DB-stored OAuth config', async () => {
    process.env.GOOGLE_CLIENT_ID = 'your-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'your-client-secret';
    db.prepare("INSERT INTO settings (key, value) VALUES ('google_oauth_config', ?)")
      .run(JSON.stringify({
        client_id: 'db-google-client-id',
        client_secret_enc: encrypt('db-google-client-secret'),
        redirect_uri: 'http://localhost:4000/api/oauth/google/callback',
      }));
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    insertConnector({
      id: 'merchant-connector',
      type: 'google-merchant',
      lastSync: '2026-08-03T12:00:00.000Z',
      credentials: {
        refreshToken: 'merchant-refresh-token',
        accessToken: 'expired-merchant-token',
        expiresAt: Date.now() - 3_600_000,
        scope: 'https://www.googleapis.com/auth/content',
        oauthClientIdFingerprint: crypto.createHash('sha256').update('db-google-client-id').digest('base64url').slice(0, 16),
      },
    });

    const token = await getValidGoogleAccessToken(BUSINESS_ID, {
      requiredScope: 'https://www.googleapis.com/auth/content',
      connectorTypes: ['google-merchant', 'google-ads'],
    });

    expect(token?.accessToken).toBe('refreshed-merchant-token');
    const body = (tokenFetch.mock.calls[0]?.[1] as { body?: URLSearchParams }).body;
    expect(body?.get('client_id')).toBe('db-google-client-id');
    expect(body?.get('client_secret')).toBe('db-google-client-secret');
  });

  test('central refresh persists merged credentials and coalesces concurrent refreshes', async () => {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    insertConnector({
      id: 'persisted-gsc',
      type: 'gsc',
      lastSync: '2026-08-03T12:00:00.000Z',
      credentials: {
        refreshToken: 'compatible-refresh-token',
        accessToken: 'expired-token',
        expiresAt: Date.now() - 1000,
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        resourceMarker: 'preserve-me',
        oauthClientIdFingerprint: CLIENT_FINGERPRINT,
      },
    });
    const row = db.prepare("SELECT id, business_id, type, credentials FROM connectors WHERE id = 'persisted-gsc'").get() as any;
    const original = JSON.parse(decrypt(row.credentials));
    const [first, second] = await Promise.all([
      refreshGoogleConnectorCredentials(row, original, { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret', redirectUri: '' }),
      refreshGoogleConnectorCredentials(row, original, { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret', redirectUri: '' }),
    ]);
    expect(first.accessToken).toBe('refreshed-compatible-token');
    expect(second.accessToken).toBe('refreshed-compatible-token');
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    const savedRow = db.prepare("SELECT credentials FROM connectors WHERE id = 'persisted-gsc'").get() as { credentials: string };
    const saved = JSON.parse(decrypt(savedRow.credentials));
    expect(saved.refreshToken).toBe('compatible-refresh-token');
    expect(saved.scopes).toEqual(['https://www.googleapis.com/auth/webmasters.readonly']);
    expect(saved.resourceMarker).toBe('preserve-me');
  });

  test('does not let a reauthorized grant join or get overwritten by an old in-flight refresh', async () => {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    const old = durable({
      refreshToken: 'old-refresh-token', accessToken: 'expired-old', expiresAt: Date.now() - 1,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    insertConnector({ id: 'race-gsc', type: 'gsc', lastSync: '2026-08-03T12:00:00.000Z', credentials: old });
    const row = { id: 'race-gsc', type: 'gsc' };
    resetOldRefreshGate();
    const oldCall = refreshGoogleConnectorCredentials(row, old, { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret', redirectUri: '' });
    await Bun.sleep(0);

    const replacement = durable({
      refreshToken: 'new-refresh-token', accessToken: 'expired-new', expiresAt: Date.now() - 1,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'], grantMarker: 'new',
    });
    db.prepare('UPDATE connectors SET credentials = ? WHERE id = ?').run(encrypt(JSON.stringify(replacement)), row.id);
    const newResult = await refreshGoogleConnectorCredentials(row, replacement, { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret', redirectUri: '' });
    expect(newResult.accessToken).toBe('new-refreshed-access');
    releaseOldRefresh();
    await expect(oldCall).rejects.toThrow(/changed.*retry|stale.*retry/i);
    const saved = JSON.parse(decrypt((db.prepare('SELECT credentials FROM connectors WHERE id = ?').get(row.id) as any).credentials));
    expect(saved).toMatchObject({ refreshToken: 'new-refresh-token', accessToken: 'new-refreshed-access', grantMarker: 'new' });
    expect(tokenFetch).toHaveBeenCalledTimes(2);
  });

  test('rejects a stale caller after grant replacement and leaves the replacement usable by a fresh caller', async () => {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    const stale = durable({ refreshToken: 'old-refresh-token', accessToken: 'expired-old', expiresAt: 0, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
    const replacement = durable({
      refreshToken: 'old-refresh-token', accessToken: 'replacement-access', expiresAt: Date.now() + 3_600_000,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'], grantMarker: 'replacement',
    });
    insertConnector({ id: 'stale-gsc', type: 'gsc', lastSync: '2026-08-03T12:00:00.000Z', credentials: replacement });
    await expect(refreshGoogleConnectorCredentials(
      { id: 'stale-gsc', type: 'gsc' }, stale,
      { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret', redirectUri: '' },
    )).rejects.toThrow(/stale.*retry|changed.*retry/i);
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(JSON.parse(decrypt((db.prepare('SELECT credentials FROM connectors WHERE id = ?').get('stale-gsc') as any).credentials)))
      .toEqual(replacement);

    const freshResult = await refreshGoogleConnectorCredentials(
      { id: 'stale-gsc', type: 'gsc' }, replacement,
      { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret', redirectUri: '' },
    );
    expect(freshResult).toEqual(replacement);
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  test('rejects malformed successful token responses before persistence', async () => {
    tokenFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: '', expires_in: 0 }), { status: 200 }));
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Google Auth Scope Test', 'google-auth-scope-test');
    const creds = durable({ refreshToken: 'compatible-refresh-token', accessToken: 'expired', expiresAt: 0, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
    insertConnector({ id: 'malformed-gsc', type: 'gsc', lastSync: '2026-08-03T12:00:00.000Z', credentials: creds });
    await expect(refreshGoogleConnectorCredentials(
      { id: 'malformed-gsc', type: 'gsc' },
      creds,
      { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret', redirectUri: '' },
    )).rejects.toThrow(/invalid token response/i);
    const saved = JSON.parse(decrypt((db.prepare('SELECT credentials FROM connectors WHERE id = ?').get('malformed-gsc') as any).credentials));
    expect(saved.accessToken).toBe('expired');
  });
});
