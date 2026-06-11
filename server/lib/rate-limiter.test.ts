import { describe, test, expect } from 'bun:test';
import { withRetry } from './rate-limiter.ts';

function httpError(status: number, retryAfterMs?: number): Error {
  const err = new Error(`HTTP ${status}`) as Error & { status: number; retryAfterMs?: number };
  err.status = status;
  err.retryAfterMs = retryAfterMs;
  return err;
}

describe('withRetry', () => {
  test('returns the result on first success', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'ok'; });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries 429 and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw httpError(429);
      return 'ok';
    }, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('retries 502/503/504 gateway errors', async () => {
    for (const status of [502, 503, 504]) {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        if (calls === 1) throw httpError(status);
        return 'ok';
      }, { baseDelayMs: 1 });
      expect(result).toBe('ok');
      expect(calls).toBe(2);
    }
  });

  test('does not retry non-transient errors (400, 401, 404, 500)', async () => {
    for (const status of [400, 401, 404, 500]) {
      let calls = 0;
      await expect(withRetry(async () => {
        calls++;
        throw httpError(status);
      }, { baseDelayMs: 1 })).rejects.toThrow(`HTTP ${status}`);
      expect(calls).toBe(1);
    }
  });

  test('does not retry plain errors without a status', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new Error('boom');
    }, { baseDelayMs: 1 })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  test('gives up after maxRetries and rethrows the last error', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw httpError(429);
    }, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow('HTTP 429');
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  test('honours retryAfterMs hint from the error', async () => {
    let calls = 0;
    const started = Date.now();
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw httpError(429, 30);
      return 'ok';
    }, { baseDelayMs: 5000 }); // backoff would be 5s — Retry-After should win
    expect(result).toBe('ok');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
