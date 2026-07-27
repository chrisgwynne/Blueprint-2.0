/**
 * Regression tests for the SSRF guard used on BAP webhook URLs (F-16/F-17).
 *
 * Only literal-IP cases are tested here — no real DNS lookups are made, so
 * these tests are hermetic and network-independent (safe in a sandboxed or
 * offline CI runner).
 */
import { describe, test, expect } from 'bun:test';
import { isPrivateOrReservedAddress, assertSafeWebhookUrl, UnsafeWebhookUrlError } from './ssrf-guard.ts';

describe('isPrivateOrReservedAddress', () => {
  test('flags loopback', () => {
    expect(isPrivateOrReservedAddress('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedAddress('127.255.255.255')).toBe(true);
    expect(isPrivateOrReservedAddress('::1')).toBe(true);
  });

  test('flags RFC1918 private ranges', () => {
    expect(isPrivateOrReservedAddress('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedAddress('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedAddress('172.31.255.254')).toBe(true);
    expect(isPrivateOrReservedAddress('192.168.1.1')).toBe(true);
  });

  test('flags the link-local / cloud metadata range (169.254.169.254)', () => {
    expect(isPrivateOrReservedAddress('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedAddress('169.254.0.1')).toBe(true);
  });

  test('flags 0.0.0.0 and CGNAT', () => {
    expect(isPrivateOrReservedAddress('0.0.0.0')).toBe(true);
    expect(isPrivateOrReservedAddress('100.64.0.1')).toBe(true);
  });

  test('flags IPv6 unique-local and link-local', () => {
    expect(isPrivateOrReservedAddress('fe80::1')).toBe(true);
    expect(isPrivateOrReservedAddress('fd00::1')).toBe(true);
    expect(isPrivateOrReservedAddress('fc00::1')).toBe(true);
  });

  test('flags IPv4-mapped IPv6 private addresses', () => {
    expect(isPrivateOrReservedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  test('does not flag public addresses', () => {
    expect(isPrivateOrReservedAddress('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedAddress('1.1.1.1')).toBe(false);
    expect(isPrivateOrReservedAddress('93.184.216.34')).toBe(false);
  });

  test('non-IP input is not flagged (not its job — assertSafeWebhookUrl handles hostnames)', () => {
    expect(isPrivateOrReservedAddress('example.com')).toBe(false);
    expect(isPrivateOrReservedAddress('not-an-ip')).toBe(false);
  });
});

describe('assertSafeWebhookUrl', () => {
  test('rejects the cloud metadata address', async () => {
    await expect(assertSafeWebhookUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(UnsafeWebhookUrlError);
  });

  test('rejects loopback', async () => {
    await expect(assertSafeWebhookUrl('http://127.0.0.1:8080/hook')).rejects.toThrow(UnsafeWebhookUrlError);
    await expect(assertSafeWebhookUrl('http://localhost/hook')).rejects.toThrow(UnsafeWebhookUrlError);
  });

  test('rejects RFC1918 private ranges', async () => {
    await expect(assertSafeWebhookUrl('http://10.0.0.5/hook')).rejects.toThrow(UnsafeWebhookUrlError);
    await expect(assertSafeWebhookUrl('https://192.168.1.50:9000/hook')).rejects.toThrow(UnsafeWebhookUrlError);
    await expect(assertSafeWebhookUrl('http://172.16.5.5/hook')).rejects.toThrow(UnsafeWebhookUrlError);
  });

  test('rejects 0.0.0.0', async () => {
    await expect(assertSafeWebhookUrl('http://0.0.0.0/hook')).rejects.toThrow(UnsafeWebhookUrlError);
  });

  test('rejects non-http(s) protocols', async () => {
    await expect(assertSafeWebhookUrl('file:///etc/passwd')).rejects.toThrow(UnsafeWebhookUrlError);
    await expect(assertSafeWebhookUrl('gopher://8.8.8.8/hook')).rejects.toThrow(UnsafeWebhookUrlError);
  });

  test('rejects malformed URLs', async () => {
    await expect(assertSafeWebhookUrl('not a url')).rejects.toThrow(UnsafeWebhookUrlError);
    await expect(assertSafeWebhookUrl('')).rejects.toThrow(UnsafeWebhookUrlError);
  });

  test('allows a public literal IP', async () => {
    await expect(assertSafeWebhookUrl('https://8.8.8.8/hook')).resolves.toBeUndefined();
  });
});
