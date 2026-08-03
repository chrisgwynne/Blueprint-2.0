import { afterEach, describe, expect, test } from 'bun:test';
import db from '../../db/db.js';
import { encrypt } from '../../crypto.js';
import { resolveAuth, runStrategy } from './index.js';

const BUSINESS_ID = 'biz-pagespeed-auth-priority';
const CONNECTOR_ID = 'connector-pagespeed-google-oauth';
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY;

function seedGoogleOAuth(credentials: Record<string, unknown> = {}, overrides: { id?: string; type?: string; lastSync?: string | null; createdAt?: string } = {}): void {
  process.env.ENCRYPTION_KEY = '00'.repeat(32);
  const storedCredentials = {
    refreshToken: 'test-refresh-token',
    accessToken: 'test-oauth-token',
    expiresAt: Date.now() + 3_600_000,
    ...(!('scope' in credentials) && !('scopes' in credentials) ? { scope: 'openid' } : {}),
    ...credentials,
  };
  db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(BUSINESS_ID, 'PageSpeed Auth Test', 'pagespeed-auth-test');
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, credentials, last_sync, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(overrides.id ?? CONNECTOR_ID, BUSINESS_ID, overrides.type ?? 'gsc', overrides.type === 'gbp' ? 'Google Business Profile' : 'Google Search Console', encrypt(JSON.stringify(storedCredentials)), overrides.lastSync ?? null, overrides.createdAt ?? new Date().toISOString());
}

afterEach(() => {
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BUSINESS_ID);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BUSINESS_ID);
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  if (ORIGINAL_PAGESPEED_API_KEY === undefined) delete process.env.PAGESPEED_API_KEY;
  else process.env.PAGESPEED_API_KEY = ORIGINAL_PAGESPEED_API_KEY;
});

describe('PageSpeed authentication selection', () => {
  test('prefers the configured PageSpeed API key over an unrelated Google OAuth token', async () => {
    seedGoogleOAuth();

    const auth = await resolveAuth({ apiKey: 'test-pagespeed-api-key' }, { businessId: BUSINESS_ID });

    expect(auth.apiKey).toBe('test-pagespeed-api-key');
    expect(auth.accessToken).toBeUndefined();
  });

  test('prefers the PageSpeed environment key over an unrelated Google OAuth token', async () => {
    process.env.PAGESPEED_API_KEY = 'test-env-pagespeed-api-key';
    seedGoogleOAuth();

    const auth = await resolveAuth({}, { businessId: BUSINESS_ID });

    expect(auth.apiKey).toBe('test-env-pagespeed-api-key');
    expect(auth.accessToken).toBeUndefined();
  });

  test('falls back to business Google OAuth only when no PageSpeed key is configured', async () => {
    delete process.env.PAGESPEED_API_KEY;
    seedGoogleOAuth();

    const auth = await resolveAuth({}, { businessId: BUSINESS_ID });

    expect(auth.apiKey).toBeUndefined();
    expect(auth.accessToken).toBe('test-oauth-token');
  });

  test('skips a fresher Google OAuth credential that lacks the PageSpeed scope', async () => {
    delete process.env.PAGESPEED_API_KEY;
    seedGoogleOAuth({
      refreshToken: 'gbp-refresh-token',
      accessToken: 'gbp-token',
      scope: 'https://www.googleapis.com/auth/business.manage',
    }, {
      id: 'connector-pagespeed-newer-gbp',
      type: 'gbp',
      lastSync: '2026-08-03T12:00:00.000Z',
      createdAt: '2026-08-03T12:00:00.000Z',
    });
    seedGoogleOAuth({
      refreshToken: 'gsc-refresh-token',
      accessToken: 'gsc-token',
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly', 'openid'],
    }, {
      id: 'connector-pagespeed-older-gsc',
      type: 'gsc',
      lastSync: '2026-08-02T12:00:00.000Z',
      createdAt: '2026-08-02T12:00:00.000Z',
    });

    const auth = await resolveAuth({}, { businessId: BUSINESS_ID });

    expect(auth.apiKey).toBeUndefined();
    expect(auth.accessToken).toBe('gsc-token');
  });

  test('uses anonymous access when neither a PageSpeed key nor business OAuth is available', async () => {
    delete process.env.PAGESPEED_API_KEY;

    const auth = await resolveAuth({});

    expect(auth).toEqual({ apiKey: null });
  });

  test('retries anonymously when a fallback OAuth token lacks PageSpeed scopes', async () => {
    const calls: Array<{ authorization?: string }> = [];
    const fakeFetch = async (_input: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ authorization: init?.headers?.Authorization });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          error: { status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' },
        }), { status: 403 });
      }
      return new Response(JSON.stringify({
        lighthouseResult: {
          categories: { performance: { score: 0.9 } },
          audits: { 'largest-contentful-paint': { numericValue: 1234, score: 0.9 } },
        },
      }), { status: 200 });
    };

    const result = await runStrategy('https://example.com/', 'mobile', { accessToken: 'wrong-scope-token' }, fakeFetch);

    expect(calls).toEqual([
      { authorization: 'Bearer wrong-scope-token' },
      { authorization: undefined },
    ]);
    expect(result.cwv.lcp).toBe(1234);
  });
});
