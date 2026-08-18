/**
 * Regression coverage for issue #92:
 *  - daily_revenue / orders_daily were persisted with a hardcoded value of
 *    null even though the per-day series was computed. They now carry the
 *    most recent day's amount/count.
 *  - history_days (and the legacy days param) control the order-history
 *    lookback window, validated to an integer 1–3650 with a 120-day default.
 *  - revenue_by_source / orders_by_source break down revenue and order count
 *    by Shopify source_name; missing/empty source_name is bucketed as "unknown".
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
const { resolveHistoryDays, buildSummary } = mod;

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

// Minimal ShopifyOrder shape for buildSummary tests
function makeOrder(overrides: {
  id?: number;
  financial_status?: string;
  cancel_reason?: string | null;
  total_price?: string;
  source_name?: string;
}): Parameters<typeof buildSummary>[0][number] {
  return {
    id: overrides.id ?? 1,
    name: `#${overrides.id ?? 1}`,
    created_at: '2026-08-01T00:00:00Z',
    total_price: overrides.total_price ?? '100.00',
    financial_status: overrides.financial_status ?? 'paid',
    fulfillment_status: null,
    cancel_reason: overrides.cancel_reason ?? null,
    source_name: overrides.source_name,
  };
}

describe('#92 Part C: revenue_by_source / orders_by_source breakdowns', () => {
  test('mixed source_names produce correct per-source sums', () => {
    const orders = [
      makeOrder({ id: 1, total_price: '50.00', source_name: 'web' }),
      makeOrder({ id: 2, total_price: '75.00', source_name: 'web' }),
      makeOrder({ id: 3, total_price: '30.00', source_name: 'pos' }),
      makeOrder({ id: 4, total_price: '20.00', source_name: undefined }), // missing → unknown
    ];
    const summary = buildSummary(orders, 'test');
    expect(summary.revenueBySource).toEqual({ web: 125, pos: 30, unknown: 20 });
    expect(summary.ordersBySource).toEqual({ web: 2, pos: 1, unknown: 1 });
  });

  test('empty string source_name is bucketed as unknown', () => {
    const orders = [
      makeOrder({ id: 1, total_price: '40.00', source_name: '' }),
    ];
    const summary = buildSummary(orders, 'test');
    expect(summary.revenueBySource).toEqual({ unknown: 40 });
    expect(summary.ordersBySource).toEqual({ unknown: 1 });
  });

  test('extractMetrics emits revenue_by_source with value = total revenue', () => {
    const orders = [
      makeOrder({ id: 1, total_price: '100.00', source_name: 'web' }),
      makeOrder({ id: 2, total_price: '50.00', source_name: 'pos' }),
    ];
    const summary = buildSummary(orders, 'test');
    const data = {
      current: summary,
      customerCount: 0,
      recentOrders: [],
      productCount: 0,
      productsSummary: [],
      customersSummary: [],
      inventoryData: [],
    };
    const metrics = connector.extractMetrics(data);
    const byName = Object.fromEntries(metrics.map(m => [m.name, m]));

    expect(byName['revenue_by_source']!.value).toBe(150);
    expect(byName['revenue_by_source']!.data).toEqual({ web: 100, pos: 50 });
    expect(byName['orders_by_source']!.value).toBe(2);
    expect(byName['orders_by_source']!.data).toEqual({ web: 1, pos: 1 });
  });

  test('revenue_by_source total matches revenue metric', () => {
    const orders = [
      makeOrder({ id: 1, total_price: '200.00', source_name: 'web' }),
      makeOrder({ id: 2, total_price: '100.00', source_name: undefined }),
    ];
    const summary = buildSummary(orders, 'test');
    const data = {
      current: summary,
      customerCount: 0,
      recentOrders: [],
      productCount: 0,
      productsSummary: [],
      customersSummary: [],
      inventoryData: [],
    };
    const metrics = connector.extractMetrics(data);
    const byName = Object.fromEntries(metrics.map(m => [m.name, m]));

    // revenue_by_source.value must equal the plain revenue metric
    expect(byName['revenue_by_source']!.value).toBe(byName['revenue']!.value);
    expect(byName['orders_by_source']!.value).toBe(byName['orders']!.value);
  });

  test('cancelled and voided orders are excluded from source breakdown', () => {
    const orders = [
      makeOrder({ id: 1, total_price: '100.00', source_name: 'web' }),
      makeOrder({ id: 2, total_price: '50.00', source_name: 'web', financial_status: 'voided' }),
      makeOrder({ id: 3, total_price: '30.00', source_name: 'pos', cancel_reason: 'customer' }),
    ];
    const summary = buildSummary(orders, 'test');
    // Only order 1 is countable
    expect(summary.revenueBySource).toEqual({ web: 100 });
    expect(summary.ordersBySource).toEqual({ web: 1 });
  });

  test('empty orders produce empty source buckets', () => {
    const summary = buildSummary([], 'test');
    expect(summary.revenueBySource).toEqual({});
    expect(summary.ordersBySource).toEqual({});
  });
});
