/**
 * Digest watermarks (issue #62) — server/digest/digest-watermark.ts.
 *
 * The watermark is the durable half of "acknowledgement does not replay
 * unchanged items". These tests pin the properties the digest relies on:
 * it persists, it is scoped per operator and per business, it only ever
 * moves forward, and a corrupted item map degrades to replaying rather
 * than to silently suppressing.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import db from '../db/db.js';
import {
  getWatermark, advanceWatermark, resetWatermark, normalizeScope, normalizeOperator,
  ALL_BUSINESSES, DEFAULT_OPERATOR,
} from './digest-watermark.js';

const OP = 'watermark-test-operator';
const OP2 = 'watermark-test-operator-2';
const BIZ = 'biz_watermark_test';
const BIZ2 = 'biz_watermark_test_2';

const T0 = '2026-02-01T00:00:00.000Z';
const T1 = '2026-02-05T00:00:00.000Z';
const T2 = '2026-02-09T00:00:00.000Z';

afterEach(() => {
  for (const op of [OP, OP2, DEFAULT_OPERATOR]) {
    for (const scope of [BIZ, BIZ2, ALL_BUSINESSES]) resetWatermark(op, scope);
  }
});

describe('scope and operator normalisation', () => {
  test('an empty business id means the cross-business digest', () => {
    expect(normalizeScope(null)).toBe(ALL_BUSINESSES);
    expect(normalizeScope('')).toBe(ALL_BUSINESSES);
    expect(normalizeScope('   ')).toBe(ALL_BUSINESSES);
    expect(normalizeScope('*')).toBe(ALL_BUSINESSES);
    expect(normalizeScope(BIZ)).toBe(BIZ);
  });

  test('a missing operator falls back to the single-operator default', () => {
    expect(normalizeOperator(null)).toBe(DEFAULT_OPERATOR);
    expect(normalizeOperator('')).toBe(DEFAULT_OPERATOR);
    expect(normalizeOperator('alice')).toBe('alice');
  });
});

describe('durability', () => {
  test('a watermark is written as a real row and read back intact', () => {
    advanceWatermark({
      operator_key: OP, business_id: BIZ,
      acknowledged_through: T1,
      acknowledged_by: OP,
      acknowledged_digest_id: 'digest_abc',
      items: { 'decision:t1': 'fp1', 'connector:c1': 'fp2' },
    });

    const row = db.prepare(
      'SELECT * FROM digest_watermarks WHERE operator_key = ? AND business_id = ?'
    ).get(OP, BIZ) as Record<string, unknown> | undefined;
    expect(row).toBeTruthy();

    const watermark = getWatermark(OP, BIZ)!;
    expect(watermark.acknowledged_through).toBe(T1);
    expect(watermark.acknowledged_digest_id).toBe('digest_abc');
    expect(watermark.acknowledged_by).toBe(OP);
    expect(watermark.item_count).toBe(2);
    expect(watermark.acknowledged_items).toEqual({ 'decision:t1': 'fp1', 'connector:c1': 'fp2' });
  });

  test('re-acknowledging updates in place rather than creating a second row', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T0, items: {} });
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T1, items: {} });

    const count = db.prepare(
      'SELECT COUNT(*) AS n FROM digest_watermarks WHERE operator_key = ? AND business_id = ?'
    ).get(OP, BIZ) as { n: number };
    expect(count.n).toBe(1);
  });

  test('there is no watermark until something is acknowledged', () => {
    expect(getWatermark(OP, BIZ)).toBeNull();
  });
});

describe('scoping', () => {
  test('watermarks are independent per business', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T1, items: {} });
    expect(getWatermark(OP, BIZ)).toBeTruthy();
    expect(getWatermark(OP, BIZ2)).toBeNull();
  });

  test('watermarks are independent per operator', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T1, items: {} });
    expect(getWatermark(OP2, BIZ)).toBeNull();
  });

  test('the cross-business watermark is separate from a per-business one', () => {
    // Acknowledging an "all businesses" catch-up must not silently mark a
    // single business as read, or vice versa.
    advanceWatermark({ operator_key: OP, business_id: ALL_BUSINESSES, acknowledged_through: T1, items: {} });
    expect(getWatermark(OP, ALL_BUSINESSES)).toBeTruthy();
    expect(getWatermark(OP, BIZ)).toBeNull();
  });
});

describe('monotonicity', () => {
  test('an out-of-order acknowledgement cannot rewind the watermark', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T2, items: {} });
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T0, items: {} });
    expect(getWatermark(OP, BIZ)!.acknowledged_through).toBe(T2);
  });

  test('a stale acknowledgement still contributes its item fingerprints', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T2, items: { a: '1' } });
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T0, items: { b: '2' } });

    const watermark = getWatermark(OP, BIZ)!;
    expect(watermark.acknowledged_through).toBe(T2);
    // Merged, not replaced — so an item that scrolled out of the window
    // keeps its fingerprint and stays suppressed if it resurfaces unchanged.
    expect(watermark.acknowledged_items).toEqual({ a: '1', b: '2' });
  });

  test('a later fingerprint for the same key wins', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T0, items: { a: 'old' } });
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T1, items: { a: 'new' } });
    expect(getWatermark(OP, BIZ)!.acknowledged_items.a).toBe('new');
  });
});

describe('resilience', () => {
  test('a corrupted item map degrades to replaying, never to suppressing everything', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T1, items: { a: '1' } });
    db.prepare('UPDATE digest_watermarks SET acknowledged_items = ? WHERE operator_key = ? AND business_id = ?')
      .run('{not json', OP, BIZ);

    const watermark = getWatermark(OP, BIZ)!;
    // Empty map = "nothing known to be acknowledged" = show it again. The
    // failure mode of a bad blob must be noise, not silence.
    expect(watermark.acknowledged_items).toEqual({});
  });

  test('a non-object item map is rejected the same way', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T1, items: { a: '1' } });
    db.prepare('UPDATE digest_watermarks SET acknowledged_items = ? WHERE operator_key = ? AND business_id = ?')
      .run('["a","b"]', OP, BIZ);
    expect(getWatermark(OP, BIZ)!.acknowledged_items).toEqual({});
  });
});

describe('reset', () => {
  test('resetting removes the watermark entirely', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T1, items: { a: '1' } });
    resetWatermark(OP, BIZ);
    expect(getWatermark(OP, BIZ)).toBeNull();
  });

  test('resetting one scope leaves others alone', () => {
    advanceWatermark({ operator_key: OP, business_id: BIZ, acknowledged_through: T1, items: {} });
    advanceWatermark({ operator_key: OP, business_id: BIZ2, acknowledged_through: T1, items: {} });
    resetWatermark(OP, BIZ);
    expect(getWatermark(OP, BIZ)).toBeNull();
    expect(getWatermark(OP, BIZ2)).toBeTruthy();
  });
});
