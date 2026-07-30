import { afterEach, describe, expect, test } from 'bun:test';
import db from '../../db/db.js';
import { encrypt } from '../../crypto.js';
import { resolveAuth, runStrategy } from './index.js';

const BUSINESS_ID = 'biz-pagespeed-auth-priority';
const CONNECTOR_ID = 'connector-pagespeed-google-oauth';
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY;

function seedGoogleOAuth(): void {
  process.env.ENCRYPTION_KEY = '00'.repeat(32);
  db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'PageSpeed Auth Test', 'pagespeed-auth-test');
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, credentials)
    VALUES (?, ?, 'gsc', 'Google Search Console', 'active', ?)
  `).run(CONNECTOR_ID, BUSINESS_ID, encrypt(JSON.stringify({
    refreshToken: 'test-refresh-token',
    accessToken: 'test-oauth-token',
    expiresAt: Date.now() + 3_600_000,
  })));
}

afterEach(() => {
  db.prepare('DELETE FROM connectors WHERE id = ?').run(CONNECTOR_ID);
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
