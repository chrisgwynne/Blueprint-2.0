import { describe, test, expect } from 'bun:test';
import { toIso, parsePagination, paginationMeta, normalizeTimestamps } from './route-helpers.js';

describe('toIso', () => {
  test('normalizes SQLite CURRENT_TIMESTAMP format (space-separated, implicitly UTC)', () => {
    expect(toIso('2026-01-15 07:23:41')).toBe('2026-01-15T07:23:41.000Z');
  });

  test('leaves already-ISO values equivalent after round-trip', () => {
    expect(toIso('2026-01-15T07:23:41.123Z')).toBe('2026-01-15T07:23:41.123Z');
  });

  test('returns null for null/undefined/empty', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso('')).toBeNull();
  });

  test('falls back to the raw string for unparseable input rather than throwing', () => {
    expect(toIso('not-a-date')).toBe('not-a-date');
  });
});

describe('normalizeTimestamps', () => {
  test('normalizes only the specified keys, leaves others untouched', () => {
    const row = { id: 'x', created_at: '2026-01-15 07:23:41', title: 'hello', updated_at: '2026-01-16 00:00:00' };
    const out = normalizeTimestamps(row, ['created_at', 'updated_at']);
    expect(out.created_at).toBe('2026-01-15T07:23:41.000Z');
    expect(out.updated_at).toBe('2026-01-16T00:00:00.000Z');
    expect(out.id).toBe('x');
    expect(out.title).toBe('hello');
  });

  test('does not mutate the original object', () => {
    const row = { created_at: '2026-01-15 07:23:41' };
    normalizeTimestamps(row, ['created_at']);
    expect(row.created_at).toBe('2026-01-15 07:23:41');
  });
});

describe('parsePagination', () => {
  test('defaults to page 1, limit 50', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 50, offset: 0 });
  });

  test('parses page/limit from query strings', () => {
    expect(parsePagination({ page: '3', limit: '25' })).toEqual({ page: 3, limit: 25, offset: 50 });
  });

  test('clamps limit to the max (200 by default)', () => {
    expect(parsePagination({ limit: '9999' }).limit).toBe(200);
  });

  test('clamps page to a minimum of 1 for zero/negative/garbage input', () => {
    expect(parsePagination({ page: '0' }).page).toBe(1);
    expect(parsePagination({ page: '-5' }).page).toBe(1);
    expect(parsePagination({ page: 'garbage' }).page).toBe(1);
  });

  test('respects a custom maxLimit/defaultLimit', () => {
    expect(parsePagination({}, { defaultLimit: 10, maxLimit: 20 })).toEqual({ page: 1, limit: 10, offset: 0 });
    expect(parsePagination({ limit: '999' }, { maxLimit: 20 }).limit).toBe(20);
  });
});

describe('paginationMeta', () => {
  test('computes pages correctly, rounding up', () => {
    expect(paginationMeta(101, 1, 50)).toEqual({ page: 1, limit: 50, total: 101, pages: 3 });
  });

  test('reports at least 1 page even for zero results', () => {
    expect(paginationMeta(0, 1, 50)).toEqual({ page: 1, limit: 50, total: 0, pages: 1 });
  });
});
