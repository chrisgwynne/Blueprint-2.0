import { describe, test, expect } from 'bun:test';
import { rules } from './rules.ts';
import type { SignalRule } from './rules.ts';

function getRule(id: string): SignalRule {
  const rule = rules.find(r => r.id === id);
  if (!rule) throw new Error(`Rule '${id}' not found`);
  return rule;
}

describe('signal rules — defensive behaviour', () => {
  test('no rule throws or raises a false alarm when there is no data yet', () => {
    // The signal engine normalises null → undefined before calling evaluate()
    // (so rules' `= {}` parameter defaults apply). Under that convention every
    // rule must (a) not throw and (b) not trigger on empty input — a rule
    // that triggers on missing data creates false alarms (e.g. "balance low:
    // £0.00") the moment a connector syncs with no data.
    for (const rule of rules) {
      for (const [current, previous] of [
        [undefined, undefined],
        [null, null],
        [{}, {}],
      ] as const) {
        let result;
        try {
          result = rule.evaluate(current ?? undefined, previous ?? undefined);
        } catch (err) {
          throw new Error(`Rule '${rule.id}' threw on empty input ${JSON.stringify(current)}: ${(err as Error).message}`);
        }
        if (result.triggered) {
          throw new Error(`Rule '${rule.id}' triggered on empty input ${JSON.stringify(current)}: "${result.title}"`);
        }
      }
    }
  });

  test('does not advertise GBP rules whose source metrics are unsupported', () => {
    const gbpRuleIds = rules.filter(rule => rule.connectorType === 'gbp').map(rule => rule.id);
    expect(gbpRuleIds).not.toContain('gbp_search_drop');
    expect(gbpRuleIds).not.toContain('gbp_unanswered_questions');
  });

  test('traffic_drop_7day does not divide by zero when previous sessions are 0', () => {
    const rule = getRule('traffic_drop_7day');
    const result = rule.evaluate({ sessions: 100 }, { sessions: 0 });
    expect(result.triggered).toBe(false);
    expect(Number.isNaN(result.confidence)).toBe(false);
  });

  test('traffic_drop_7day triggers on a 20%+ drop with sane confidence', () => {
    const rule = getRule('traffic_drop_7day');
    const result = rule.evaluate({ sessions: 50 }, { sessions: 100 });
    expect(result.triggered).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
    expect(result.data.dropPct).toBe(50);
  });

  test('traffic_drop_7day does not trigger on a small drop', () => {
    const rule = getRule('traffic_drop_7day');
    const result = rule.evaluate({ sessions: 95 }, { sessions: 100 });
    expect(result.triggered).toBe(false);
  });

  test('ranking_drop_keyword handles non-array input without throwing', () => {
    const rule = getRule('ranking_drop_keyword');
    expect(rule.evaluate({ not: 'an array' }, 42).triggered).toBe(false);
  });

  test('ranking_drop_keyword triggers when a keyword drops 5+ positions', () => {
    const rule = getRule('ranking_drop_keyword');
    const previous = [{ query: 'best widgets', position: 3, clicks: 100, impressions: 1000 }];
    const current = [{ query: 'best widgets', position: 9, clicks: 20, impressions: 900 }];
    const result = rule.evaluate(current, previous);
    expect(result.triggered).toBe(true);
  });

  test('merchant_products_disapproved triggers only for products newly disapproved this sync', () => {
    const rule = getRule('merchant_products_disapproved');
    const previous = { products: [{ id: 'p1', title: 'Widget', disapprovedDestinations: [] }] };
    const current = {
      products: [
        { id: 'p1', title: 'Widget', disapprovedDestinations: ['shoppingAds'], issues: [{ code: 'missing_gtin' }] },
        { id: 'p2', title: 'Gadget', disapprovedDestinations: [] },
      ],
    };
    const result = rule.evaluate(current, previous);
    expect(result.triggered).toBe(true);
    expect(result.data.totalCount).toBe(1);
  });

  test('merchant_products_disapproved does not re-trigger for a product still disapproved from before', () => {
    const rule = getRule('merchant_products_disapproved');
    const previous = { products: [{ id: 'p1', title: 'Widget', disapprovedDestinations: ['shoppingAds'] }] };
    const current = { products: [{ id: 'p1', title: 'Widget', disapprovedDestinations: ['shoppingAds'] }] };
    expect(rule.evaluate(current, previous).triggered).toBe(false);
  });

  // Issue #42 — a product disapproved ONLY on Demand Gen/Discover must not
  // read as a Shopping-blocking disapproval, and vice versa: the two must be
  // reported under separate destination keys, not one generic bucket.
  test('merchant_products_disapproved keeps Demand Gen/Discover disapprovals out of the Shopping Ads bucket', () => {
    const rule = getRule('merchant_products_disapproved');
    const previous = { products: [] };
    const current = {
      products: [
        { id: 'p1', title: 'Approved for Shopping, restricted on Demand Gen', disapprovedDestinations: ['demandGen', 'discover'], issues: [] },
      ],
    };
    const result = rule.evaluate(current, previous);
    expect(result.triggered).toBe(true);
    const byDestination = result.data.byDestination as Record<string, { count: number }>;
    expect(byDestination.shoppingAds).toBeUndefined();
    expect(byDestination.freeListings).toBeUndefined();
    expect(byDestination.demandGen?.count).toBe(1);
    expect(byDestination.discover?.count).toBe(1);
    expect(result.title).not.toMatch(/shopping/i);
    expect(result.title).toMatch(/demand gen/i);
  });

  test('merchant_products_disapproved names the destination and issue-type evidence in its description', () => {
    const rule = getRule('merchant_products_disapproved');
    const previous = { products: [] };
    const current = {
      products: [
        { id: 'p1', title: 'Widget', disapprovedDestinations: ['shoppingAds'], issues: [{ code: 'missing_gtin' }] },
      ],
    };
    const result = rule.evaluate(current, previous);
    expect(result.description).toMatch(/Shopping Ads/);
    expect(result.description).toMatch(/missing_gtin/);
    // Never a bare, unattributed "resolve disapproved products" claim.
    expect(result.title.toLowerCase()).not.toBe('disapproved products');
  });

  test('merchant_products_disapproved flags incomplete scan coverage instead of implying a clean full account', () => {
    const rule = getRule('merchant_products_disapproved');
    const previous = { products: [] };
    const current = {
      products: [{ id: 'p1', title: 'Widget', disapprovedDestinations: ['shoppingAds'], issues: [] }],
      offersScanned: 5000,
      coverageComplete: false,
    };
    const result = rule.evaluate(current, previous);
    expect(result.triggered).toBe(true);
    expect(result.data.coverageComplete).toBe(false);
    expect(result.data.offersScanned).toBe(5000);
    expect(result.description).toMatch(/incomplete/i);
  });

  test('merchant_feed_data_quality_issues triggers when error-level issues increase', () => {
    const rule = getRule('merchant_feed_data_quality_issues');
    const previous = { products: [{ id: 'p1', hasErrorIssues: false }] };
    const current = { products: [{ id: 'p1', hasErrorIssues: true }, { id: 'p2', hasErrorIssues: true }] };
    const result = rule.evaluate(current, previous);
    expect(result.triggered).toBe(true);
    expect(result.data.increase).toBe(2);
  });

  test('merchant_product_count_drop does not divide by zero when previous count is 0', () => {
    const rule = getRule('merchant_product_count_drop');
    const result = rule.evaluate({ totalProductCount: 100 }, { totalProductCount: 0 });
    expect(result.triggered).toBe(false);
    expect(Number.isNaN(result.confidence)).toBe(false);
  });

  test('merchant_product_count_drop triggers on a 20%+ drop', () => {
    const rule = getRule('merchant_product_count_drop');
    const result = rule.evaluate({ totalProductCount: 400 }, { totalProductCount: 1000 });
    expect(result.triggered).toBe(true);
    expect(result.data.dropPct).toBe(60);
  });

  // Issue #42 — a pagination safety-ceiling cutoff shrinks the scanned count
  // without the real catalogue changing at all; that must never be reported
  // as a "product count drop", in either direction of the comparison.
  test('merchant_product_count_drop does not fire when the current scan is incomplete', () => {
    const rule = getRule('merchant_product_count_drop');
    const result = rule.evaluate(
      { totalProductCount: 5000, coverageComplete: false },
      { totalProductCount: 90042, coverageComplete: true }
    );
    expect(result.triggered).toBe(false);
  });

  test('merchant_product_count_drop does not fire when the previous scan was incomplete', () => {
    const rule = getRule('merchant_product_count_drop');
    const result = rule.evaluate(
      { totalProductCount: 90042, coverageComplete: true },
      { totalProductCount: 5000, coverageComplete: false }
    );
    expect(result.triggered).toBe(false);
  });

  test('every rule result has the required shape', () => {
    for (const rule of rules) {
      let result;
      try {
        result = rule.evaluate({}, {});
      } catch {
        continue; // engine skips throwing rules
      }
      expect(typeof result.triggered).toBe('boolean');
      expect(typeof result.confidence).toBe('number');
      expect(Number.isNaN(result.confidence)).toBe(false);
      expect(typeof result.title).toBe('string');
      expect(typeof result.description).toBe('string');
    }
  });
});
