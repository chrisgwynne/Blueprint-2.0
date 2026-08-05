import { afterEach, describe, expect, mock, test } from 'bun:test';
import { complete } from './google.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Google provider error sanitization', () => {
  test('HTTP failures expose only bounded classification, never raw body, key, or full URL', async () => {
    const secret = 'AIzaSySECRET_SHOULD_NOT_ESCAPE';
    const bodyMarker = 'RAW_PROVIDER_BODY_SHOULD_NOT_ESCAPE';
    const seen: string[] = [];

    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          error: {
            message: `${bodyMarker} quota exhausted for key ${secret}`,
            details: [{ debug: 'sensitive-query-value=abc123' }],
          },
        }),
        { status: 429, headers: { 'retry-after': '7' } },
      );
    }) as unknown as typeof fetch;

    await expect(complete({
      apiKey: secret,
      model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toThrow(/provider google http_429 retryable/);

    try {
      await complete({
        apiKey: secret,
        model: 'gemini-3.5-flash-lite',
        messages: [{ role: 'user', content: 'hello' }],
      });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(bodyMarker);
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain('sensitive-query-value');
      expect(msg).not.toContain('generativelanguage.googleapis.com');
      expect((err as { status?: number }).status).toBe(429);
      expect((err as { retryable?: boolean }).retryable).toBe(true);
      expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(7000);
    }

    expect(seen[0]).toContain(secret);
  });
});
