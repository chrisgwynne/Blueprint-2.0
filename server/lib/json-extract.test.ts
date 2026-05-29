import { test, expect, describe } from 'bun:test';
import { extractFirstJson } from './json-extract.js';

// extractFirstJson returns `T | null`; bun's expect().toEqual resolves to a
// null-only overload on a nullable received value, so cast to a concrete object
// for the equality assertions (these cases are all expected to be non-null).
const obj = (s: string): Record<string, unknown> => extractFirstJson(s) as Record<string, unknown>;

describe('extractFirstJson', () => {
  test('parses clean JSON', () => {
    expect(obj('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  test('extracts from a ```json fence```', () => {
    expect(obj('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('extracts a JSON object embedded in prose', () => {
    expect(obj('Here is the result: {"a":1} — done.')).toEqual({ a: 1 });
  });

  // Regression for C1: truncation repair must recover, not return null.
  test('repairs truncation inside an unterminated string', () => {
    const r = extractFirstJson<{ done?: boolean; findings?: { summary?: string } }>(
      '{"done":true,"findings":{"summary":"partial cause was',
    );
    expect(r).not.toBeNull();
    expect(r?.done).toBe(true);
  });

  test('repairs truncation with unclosed nested braces', () => {
    expect(obj('{"a":1,"b":{"c":2')).toEqual({ a: 1, b: { c: 2 } });
  });

  test('repairs truncation with an unclosed array', () => {
    expect(obj('{"e":["a","b"')).toEqual({ e: ['a', 'b'] });
  });

  test('recovers the last complete value past a dangling key', () => {
    expect(obj('{"a":1,"b":')).toEqual({ a: 1 });
  });

  test('returns null for non-JSON', () => {
    expect(extractFirstJson('no json here at all')).toBeNull();
    expect(extractFirstJson('')).toBeNull();
  });
});
