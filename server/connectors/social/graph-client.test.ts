/**
 * TDD tests for Meta Graph API client.
 * Tests config validation, version resolution, token redaction, and retry behaviour.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { GraphClient, GraphApiError, GRAPH_VERSIONS, DEFAULT_GRAPH_VERSION } from './graph-client.js';

// Minimal placeholder creds
const CREDS = { access_token: 'EAA_test_token', token_expires_at: String(Date.now() + 86400_000) };

describe('GraphClient – configuration', () => {
  test('default version is a known supported version', () => {
    expect(GRAPH_VERSIONS as readonly string[]).toContain(DEFAULT_GRAPH_VERSION);
  });

  test('throws when META_APP_ID is missing', () => {
    const saved = process.env.META_APP_ID;
    delete process.env.META_APP_ID;
    expect(() => new GraphClient(CREDS)).toThrow(/META_APP_ID/);
    process.env.META_APP_ID = saved;
  });

  test('accepts META_GRAPH_VERSION override', () => {
    process.env.META_APP_ID = 'app_123';
    const oldVersion = process.env.META_GRAPH_VERSION;
    process.env.META_GRAPH_VERSION = GRAPH_VERSIONS[0];
    const client = new GraphClient(CREDS);
    expect(client.version).toBe(GRAPH_VERSIONS[0] as string);
    if (oldVersion !== undefined) process.env.META_GRAPH_VERSION = oldVersion;
    else delete process.env.META_GRAPH_VERSION;
    delete process.env.META_APP_ID;
  });

  test('rejects invalid META_GRAPH_VERSION override', () => {
    process.env.META_APP_ID = 'app_123';
    const oldVersion = process.env.META_GRAPH_VERSION;
    process.env.META_GRAPH_VERSION = 'v99.0';
    expect(() => new GraphClient(CREDS)).toThrow(/unsupported.*graph.*version/i);
    if (oldVersion !== undefined) process.env.META_GRAPH_VERSION = oldVersion;
    else delete process.env.META_GRAPH_VERSION;
    delete process.env.META_APP_ID;
  });
});

describe('GraphClient – token redaction', () => {
  test('access token is never included in error messages', async () => {
    process.env.META_APP_ID = 'app_123';
    const client = new GraphClient(CREDS);

    let caughtError: Error | null = null;
    try {
      // Intercept fetch to return an error response
      const mockFetch = mock(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'Bad request', code: 100 } }),
        json: async () => ({ error: { message: 'Bad request', code: 100 } }),
      }));
      await client.get('/me', { fields: 'id,name' }, { fetchFn: mockFetch as any });
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect((caughtError as Error).message).not.toContain('EAA_test_token');
    delete process.env.META_APP_ID;
  });
});

describe('GraphClient – retry behaviour', () => {
  test('retries on 429 and eventually throws GraphApiError', async () => {
    process.env.META_APP_ID = 'app_123';
    const client = new GraphClient(CREDS);
    let callCount = 0;

    const mockFetch = mock(async () => {
      callCount++;
      return {
        ok: false,
        status: 429,
        text: async () => 'rate limited',
        json: async () => ({ error: { message: 'rate limited', code: 4 } }),
      };
    });

    await expect(
      client.get('/me', { fields: 'id' }, { fetchFn: mockFetch as any, retries: 2, backoffMs: 1 }),
    ).rejects.toBeInstanceOf(GraphApiError);

    expect(callCount).toBeGreaterThan(1); // Retried
    delete process.env.META_APP_ID;
  });

  test('does not retry on 400 (permanent error)', async () => {
    process.env.META_APP_ID = 'app_123';
    const client = new GraphClient(CREDS);
    let callCount = 0;

    const mockFetch = mock(async () => {
      callCount++;
      return {
        ok: false,
        status: 400,
        text: async () => 'bad request',
        json: async () => ({ error: { message: 'bad request', code: 100 } }),
      };
    });

    await expect(
      client.get('/me', { fields: 'id' }, { fetchFn: mockFetch as any }),
    ).rejects.toBeInstanceOf(GraphApiError);

    expect(callCount).toBe(1); // No retries
    delete process.env.META_APP_ID;
  });

  test('GraphApiError carries HTTP status and isRetryable flag', async () => {
    process.env.META_APP_ID = 'app_123';
    const client = new GraphClient(CREDS);

    const mockFetch429 = mock(async () => ({
      ok: false, status: 429, text: async () => 'rl', json: async () => ({}),
    }));
    const mockFetch500 = mock(async () => ({
      ok: false, status: 500, text: async () => 'se', json: async () => ({}),
    }));
    const mockFetch400 = mock(async () => ({
      ok: false, status: 400, text: async () => 'br', json: async () => ({}),
    }));

    try {
      await client.get('/me', {}, { fetchFn: mockFetch429 as any, retries: 0 });
    } catch (err) {
      expect(err).toBeInstanceOf(GraphApiError);
      expect((err as GraphApiError).status).toBe(429);
      expect((err as GraphApiError).isRetryable).toBe(true);
    }

    try {
      await client.get('/me', {}, { fetchFn: mockFetch500 as any, retries: 0 });
    } catch (err) {
      expect((err as GraphApiError).isRetryable).toBe(true);
    }

    try {
      await client.get('/me', {}, { fetchFn: mockFetch400 as any, retries: 0 });
    } catch (err) {
      expect((err as GraphApiError).isRetryable).toBe(false);
    }
    delete process.env.META_APP_ID;
  });
});

describe('GraphClient – page discovery', () => {
  test('listManagedPages returns pages array', async () => {
    process.env.META_APP_ID = 'app_123';
    const client = new GraphClient(CREDS);

    const mockFetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: '111', name: 'My Page', category: 'Business', tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT'] },
        ],
        paging: {},
      }),
    }));

    const pages = await client.listManagedPages({ fetchFn: mockFetch as any });
    expect(pages.length).toBe(1);
    expect(pages[0]!.id).toBe('111');
    expect(pages[0]!.name).toBe('My Page');
    delete process.env.META_APP_ID;
  });

  test('listInstagramAccountsForPage returns IG accounts', async () => {
    process.env.META_APP_ID = 'app_123';
    const client = new GraphClient(CREDS);

    const mockFetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        instagram_business_account: {
          id: 'ig_999',
          username: 'mybrand',
          account_type: 'BUSINESS',
          followers_count: 1500,
        },
        id: '111',
      }),
    }));

    const result = await client.getInstagramAccountForPage('111', { fetchFn: mockFetch as any });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('ig_999');
    expect(result!.username).toBe('mybrand');
    expect(result!.account_type).toBe('BUSINESS');
    delete process.env.META_APP_ID;
  });

  test('personal IG accounts (account_type != BUSINESS/CREATOR) are rejected', async () => {
    process.env.META_APP_ID = 'app_123';
    const client = new GraphClient(CREDS);

    const mockFetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        instagram_business_account: {
          id: 'ig_personal',
          username: 'personal_user',
          account_type: 'PERSONAL',
          followers_count: 100,
        },
        id: '111',
      }),
    }));

    const result = await client.getInstagramAccountForPage('111', { fetchFn: mockFetch as any });
    expect(result).toBeNull(); // Personal accounts are filtered out
    delete process.env.META_APP_ID;
  });
});
