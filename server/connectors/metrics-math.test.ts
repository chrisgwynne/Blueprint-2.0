import { test, expect, describe } from 'bun:test';
import { previousPeriodRange, sessionsWeightedAverage } from './metrics-math.js';

describe('previousPeriodRange', () => {
  test('returns the 30 days immediately before the trailing-30 window (not a hardcoded date)', () => {
    const now = new Date('2026-05-29T00:00:00Z');
    expect(previousPeriodRange(now, 30)).toEqual({ start: '2026-03-30', end: '2026-04-28' });
  });

  test('is relative to "now" — different month yields a different range', () => {
    const r = previousPeriodRange(new Date('2026-01-15T00:00:00Z'), 30);
    expect(r.start).toBe('2025-11-16');
    expect(r.end).toBe('2025-12-15');
    // The old bug returned March 2025 regardless of date — guard against regressing to any fixed year.
    expect(r.start.startsWith('2025-03')).toBe(false);
  });

  test('honours a custom window length', () => {
    expect(previousPeriodRange(new Date('2026-05-29T00:00:00Z'), 7)).toEqual({ start: '2026-05-15', end: '2026-05-21' });
  });
});

describe('sessionsWeightedAverage', () => {
  test('weights ratios by their weight, not a flat mean', () => {
    // Flat mean would be 0.5; sessions-weighted is (0.2*100 + 0.8*900)/1000 = 0.74
    const v = sessionsWeightedAverage([{ value: 0.2, weight: 100 }, { value: 0.8, weight: 900 }]);
    expect(v).toBeCloseTo(0.74, 5);
  });

  test('ignores zero / negative / non-finite weights and values', () => {
    expect(sessionsWeightedAverage([{ value: 0.5, weight: 0 }, { value: 0.9, weight: -3 }, { value: 1, weight: 50 }])).toBeCloseTo(1, 5);
    expect(sessionsWeightedAverage([{ value: NaN, weight: 10 }, { value: 0.4, weight: 10 }])).toBeCloseTo(0.4, 5);
  });

  test('returns 0 when there is no positive weight', () => {
    expect(sessionsWeightedAverage([])).toBe(0);
    expect(sessionsWeightedAverage([{ value: 0.9, weight: 0 }])).toBe(0);
  });
});
