/**
 * Regression coverage for issue #92:
 *  - daily_revenue / orders_daily were persisted with a hardcoded value of
 *    null even though the per-day series was computed. They now carry the
 *    most recent day's amount/count.
 *  - history_days (and the legacy days param) control the order-history
 *    lookback window, validated to an integer 1–3650 with a 120-day default.
 */
import { describe, expect, test } from 'bun:test';

// Load the module through a cache-busted dynamic import rather than a plain
// static import: other test files (e.g. tasks/executor.github-review-deploy.test.ts)
// use mock.module() to stub this same connector, and Bun's mock.module rewrites
// module resolution process-wide for the whole `bun test` run — a plain import
// can silently resolve to another file's mock when the whole suite runs
// together. A fresh query string per import gives this file its own real
// module instance regardless of file/run order.
const mod = (await import(`./index.ts?test=${Date.now()}-${Math.random()}`)) as typeof import('./index.ts');
const connector = mod.default;
const { resolveHistoryDays } = mod;

function summaryData(dailySales: Array<{ date: string; amount: number }>, dailyOrders: Array<{ date: string; count: number }>) {
  return {
    current: {
      period: 'last 120 days',
      revenue: 1000,
      orders: 40,
      aov: 25,
      topProducts: [],
      dailySales,
      dailyOrders,
    },
    customerCount: 10,
    recentOrders: [],
    productCount: 5,
    productsSummary: [],
    customersSummary: [],
    inventoryData: [],
  };
}

describe('#92 Part A: daily_revenue / orders_daily carry a real scalar', () => {
  test('daily_revenue is the most recent day amount; orders_daily the most recent day count', () => {
    const metrics = connector.extractMetrics(summaryData(
      [
        { date: '2026-08-17', amount: 50 },
        { date: '2026-08-18', amount: 75 },
      ],
      [
        { date: '2026-08-17', count: 2 },
        { date: '2026-08-18', count: 3 },
      ],
    ));
    const byName = Object.fromEntries(metrics.map(m => [m.name, m.value]));
    expect(byName.daily_revenue).toBe(75);
    expect(byName.orders_daily).toBe(3);
  });

  test('empty daily series keeps the value null (no fabricated numbers)', () => {
    const metrics = connector.extractMetrics(summaryData([], []));
    const byName = Object.fromEntries(metrics.map(m => [m.name, m.value]));
    expect(byName.daily_revenue).toBeNull();
    expect(byName.orders_daily).toBeNull();
  });
});

describe('#92 Part B: history lookback window resolution', () => {
  test('history_days overrides the legacy days param', () => {
    expect(resolveHistoryDays({ history_days: 730, days: 200 })).toBe(730);
  });

  test('legacy days param still works when history_days is absent', () => {
    expect(resolveHistoryDays({ days: 200 })).toBe(200);
  });

  test('defaults to 120 when nothing is provided', () => {
    expect(resolveHistoryDays({})).toBe(120);
    expect(resolveHistoryDays(undefined)).toBe(120);
    expect(resolveHistoryDays(null)).toBe(120);
  });

  test('invalid values fall back to 120', () => {
    expect(resolveHistoryDays({ history_days: 0 })).toBe(120);
    expect(resolveHistoryDays({ history_days: -5 })).toBe(120);
    expect(resolveHistoryDays({ history_days: 'abc' })).toBe(120);
    expect(resolveHistoryDays({ history_days: '3.7' })).toBe(3); // truncated integer
  });

  test('values above the 3650-day cap are clamped', () => {
    expect(resolveHistoryDays({ history_days: 99999 })).toBe(3650);
  });
});
