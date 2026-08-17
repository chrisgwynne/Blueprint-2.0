/**
 * server/lib/redaction.ts — the sanitiser durable records (action receipts,
 * issue #70) run everything through on the way in and on the way out.
 */
import { describe, test, expect } from 'bun:test';
import { redactSensitive, redactSensitiveText, redactRecord, containsSensitiveText, REDACTED, OMITTED } from './redaction.js';

describe('key-shaped redaction', () => {
  test('replaces credential-shaped keys whatever the value is', () => {
    const out = redactSensitive<Record<string, any>>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      api_key: 'plain-looking-value',
      credentials: { shopDomain: 'acme.myshopify.com' }, // whole object goes
      connector: { shopDomain: 'acme.myshopify.com', access_token: 'abc' },
      client_secret: 12345,
      authorization: ['a', 'b'],
      product_id: '5001',
    });
    expect(out.api_key).toBe(REDACTED);
    expect(out.credentials).toBe(REDACTED); // a credential-shaped key takes its whole subtree with it
    expect(out.connector.access_token).toBe(REDACTED); // nested secrets are found by recursion
    expect(out.connector.shopDomain).toBe('acme.myshopify.com'); // not a secret — kept
    expect(out.client_secret).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.product_id).toBe('5001');
  });

  test('keeps benign accounting fields that merely contain the word token', () => {
    const out = redactSensitive<Record<string, unknown>>({ total_tokens: 1200, token_count: 40 });
    expect(out.total_tokens).toBe(1200);
    expect(out.token_count).toBe(40);
  });

  test('drops raw provider bodies rather than mirroring them into the record', () => {
    const out = redactSensitive<Record<string, unknown>>({
      body_html: '<p>an entire document body</p>',
      response_body: '{"lots":"of provider wire format"}',
      headers: { authorization: 'Bearer x' },
      stack: 'Error: at foo',
      outcome: 'kept',
    });
    expect(out.body_html).toBe(OMITTED);
    expect(out.response_body).toBe(OMITTED);
    expect(out.headers).toBe(OMITTED);
    expect(out.stack).toBe(OMITTED);
    expect(out.outcome).toBe('kept');
  });
});

describe('value-shaped redaction', () => {
  test('scrubs known credential formats wherever they appear in text', () => {
    const cases: Array<[string, string]> = [
      ['Authorization: Bearer abcdef1234567890', 'Bearer '],
      ['token ghp_abcdefghijklmnopqrstuvwxyz012345', 'ghp_'],
      ['shop token shpat_abcdefghijklmnop', 'shpat_'],
      ['key sk-abcdefghijklmnop', 'sk-'],
      ['google AIzaSyABCDEFGHIJKLMNOPQRST', 'AIza'],
      ['slack xoxb-123456789012-abcdef', 'xoxb-'],
    ];
    for (const [input, marker] of cases) {
      const out = redactSensitiveText(input);
      expect(out).toContain('redacted');
      expect(out.replace(/\[redacted[^\]]*\]/g, '')).not.toContain(marker + 'a');
      expect(containsSensitiveText(input)).toBe(true);
    }
  });

  test('scrubs secrets smuggled through a URL query string but keeps the URL readable', () => {
    const out = redactSensitiveText('called https://api.example.com/v1/items?api_key=supersecret123&page=2');
    expect(out).not.toContain('supersecret123');
    expect(out).toContain('https://api.example.com/v1/items');
    expect(out).toContain('page=2');
  });

  test('strips PEM private key blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----';
    expect(redactSensitiveText(`key: ${pem}`)).not.toContain('MIIEowIBAAKCAQ');
  });

  test('leaves ordinary text untouched', () => {
    const text = 'GitHub issue #412 created in acme/widgets';
    expect(redactSensitiveText(text)).toBe(text);
    expect(containsSensitiveText(text)).toBe(false);
  });
});

describe('shape bounds', () => {
  test('truncates very long strings instead of storing a whole payload', () => {
    const out = redactSensitive<string>('x'.repeat(2000));
    expect(out.length).toBeLessThan(600);
    expect(out).toContain('truncated');
  });

  test('caps depth, array length and key count', () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(JSON.stringify(redactSensitive(deep))).toContain('[truncated]');

    const longArray = redactSensitive<unknown[]>(Array.from({ length: 120 }, (_, i) => i));
    expect(longArray.length).toBeLessThanOrEqual(51);
    expect(String(longArray[longArray.length - 1])).toContain('more omitted');

    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = i;
    expect(redactSensitive<Record<string, unknown>>(wide).__omitted_keys).toBe(40);
  });

  test('survives cycles, dates and errors without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const out = redactSensitive<Record<string, unknown>>({
      cyclic, when: new Date('2026-01-01T00:00:00Z'), err: new Error('boom'),
    });
    expect(JSON.stringify(out)).toContain('[circular]');
    expect(out.when).toBe('2026-01-01T00:00:00.000Z');
    expect(out.err).toBe('boom');
  });

  test('a repeated (non-cyclic) sibling reference is not mislabelled as circular', () => {
    const shared = { id: 'shared' };
    const out = redactSensitive<Record<string, unknown>>({ a: shared, b: shared });
    expect(out.a).toEqual({ id: 'shared' });
    expect(out.b).toEqual({ id: 'shared' });
  });

  test('redactRecord returns null for nothing and wraps scalars', () => {
    expect(redactRecord(null)).toBeNull();
    expect(redactRecord(undefined)).toBeNull();
    expect(redactRecord('plain')).toEqual({ value: 'plain' });
  });
});
