import { afterEach, describe, expect, mock, test } from 'bun:test';
import { callConnectorHealth, enforceGoogleHealthDurability } from './connectors.js';

const ORIGINAL_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

afterEach(() => {
  if (ORIGINAL_GOOGLE_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = ORIGINAL_GOOGLE_CLIENT_ID;
});

describe('connector health route helper', () => {
  test('passes stored connector config separately from OAuth credentials', async () => {
    const healthCheck = mock(async (_credentials: Record<string, unknown>, config?: Record<string, unknown>) => ({
      ok: config?.accountId === 'merchant-123',
    }));
    const credentials = { accessToken: 'valid-access', expiresAt: Date.now() + 3_600_000 };
    const config = { accountId: 'merchant-123' };

    const result = await callConnectorHealth({ healthCheck }, credentials, config);

    expect(result.ok).toBe(true);
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(healthCheck.mock.calls[0]?.[0]).toBe(credentials);
    expect(healthCheck.mock.calls[0]?.[1]).toBe(config);
  });

  test('cannot report healthy for access-only, under-scoped, or wrong-client Google grants', () => {
    process.env.GOOGLE_CLIENT_ID = 'health-client';
    for (const credentials of [
      { accessToken: 'temporary', expiresAt: Date.now() + 3_600_000, scope: 'https://www.googleapis.com/auth/webmasters.readonly' },
      { refreshToken: 'refresh', accessToken: 'access', scope: 'openid', oauthClientIdFingerprint: 'wrong' },
      { refreshToken: 'refresh', accessToken: 'access', scope: 'https://www.googleapis.com/auth/webmasters.readonly', oauthClientIdFingerprint: 'wrong' },
    ]) {
      expect(enforceGoogleHealthDurability('gsc', credentials, { ok: true })).toMatchObject({ ok: false });
    }
  });

  test('preserves a connector health failure instead of promoting it connected', () => {
    expect(enforceGoogleHealthDurability('gsc', {}, { ok: false, error: 'refresh failed' }))
      .toEqual({ ok: false, error: 'refresh failed' });
  });
});
