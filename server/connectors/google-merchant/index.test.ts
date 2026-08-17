import { afterEach, describe, expect, mock, test } from 'bun:test';
import connector, { summarizeProduct } from './index.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('summarizeProduct', () => {
  test('flags the Shopping Ads destination when it has disapproved countries', () => {
    const summary = summarizeProduct({
      name: 'accounts/123/products/p1',
      productAttributes: { title: 'Widget' },
      productStatus: {
        destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'], disapprovedCountries: ['GB'] }],
      },
    });
    expect(summary.disapprovedDestinations).toEqual(['shoppingAds']);
    expect(summary.title).toBe('Widget');
  });

  test('does not flag any destination when all destinations are fully approved', () => {
    const summary = summarizeProduct({
      productStatus: { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['US', 'GB'], disapprovedCountries: [] }] },
    });
    expect(summary.disapprovedDestinations).toEqual([]);
  });

  // Issue #42 — a product disapproved ONLY on Demand Gen/Discover (not
  // Shopping Ads or Free Listings) must not be indistinguishable from one
  // actually blocked from showing as a shopping result.
  test('separates a Demand Gen/Discover-only disapproval from a Shopping Ads disapproval', () => {
    const shoppingBlocked = summarizeProduct({
      name: 'p-shopping-blocked',
      productStatus: {
        destinationStatuses: [
          { reportingContext: 'SHOPPING_ADS', approvedCountries: [], disapprovedCountries: ['US'] },
        ],
      },
    });
    const demandGenOnly = summarizeProduct({
      name: 'p-demand-gen-only',
      productStatus: {
        destinationStatuses: [
          { reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'], disapprovedCountries: [] },
          { reportingContext: 'DEMAND_GEN_ADS', approvedCountries: [], disapprovedCountries: ['US'] },
          { reportingContext: 'DEMAND_GEN_ADS_DISCOVER_SURFACE', approvedCountries: [], disapprovedCountries: ['US'] },
        ],
      },
    });

    expect(shoppingBlocked.disapprovedDestinations).toEqual(['shoppingAds']);
    expect(demandGenOnly.disapprovedDestinations.sort()).toEqual(['demandGen', 'discover']);
    expect(demandGenOnly.disapprovedDestinations).not.toContain('shoppingAds');
  });

  test('tracks Free Listings, Display, and Video/YouTube as distinct destinations', () => {
    const summary = summarizeProduct({
      name: 'p1',
      productStatus: {
        destinationStatuses: [
          { reportingContext: 'FREE_LISTINGS', disapprovedCountries: ['US'] },
          { reportingContext: 'DISPLAY_ADS', disapprovedCountries: ['US'] },
          { reportingContext: 'YOUTUBE_SHOPPING', disapprovedCountries: ['US'] },
        ],
      },
    });
    expect(summary.disapprovedDestinations.sort()).toEqual(['display', 'freeListings', 'videoYoutube']);
  });

  test('preserves an unrecognised reportingContext in otherDisapprovedContexts instead of dropping it', () => {
    const summary = summarizeProduct({
      name: 'p1',
      productStatus: {
        destinationStatuses: [{ reportingContext: 'LOCAL_INVENTORY_ADS', disapprovedCountries: ['US'] }],
      },
    });
    expect(summary.disapprovedDestinations).toEqual([]);
    expect(summary.otherDisapprovedContexts).toEqual(['LOCAL_INVENTORY_ADS']);
  });

  test('flags error-level and warning-level issues independently', () => {
    const summary = summarizeProduct({
      productStatus: {
        itemLevelIssues: [
          { code: 'missing_gtin', severity: 'error', description: 'GTIN required' },
          { code: 'low_quality_image', severity: 'warning', description: 'Image below recommended resolution' },
        ],
      },
    });
    expect(summary.hasErrorIssues).toBe(true);
    expect(summary.hasWarningIssues).toBe(true);
    expect(summary.issues).toHaveLength(2);
  });

  test('handles a product with no productStatus at all (feed not yet processed)', () => {
    const summary = summarizeProduct({ name: 'accounts/123/products/p2' });
    expect(summary.disapprovedDestinations).toEqual([]);
    expect(summary.hasErrorIssues).toBe(false);
    expect(summary.issues).toEqual([]);
  });

  test('falls back to offerId then "unknown" when name is missing', () => {
    expect(summarizeProduct({ offerId: 'sku-42' }).id).toBe('sku-42');
    expect(summarizeProduct({}).id).toBe('unknown');
  });
});

describe('connector.extractMetrics', () => {
  test('counts total, active, per-destination disapproved, and data-quality-issue products correctly', () => {
    const data = {
      totalProductCount: 3,
      offersScanned: 3,
      coverageComplete: true,
      coveragePercent: 100,
      products: [
        { id: 'p1', title: 'A', disapprovedDestinations: [], otherDisapprovedContexts: [], hasErrorIssues: false, hasWarningIssues: false, issues: [] },
        { id: 'p2', title: 'B', disapprovedDestinations: ['shoppingAds'], otherDisapprovedContexts: [], hasErrorIssues: false, hasWarningIssues: false, issues: [] },
        { id: 'p3', title: 'C', disapprovedDestinations: ['demandGen'], otherDisapprovedContexts: [], hasErrorIssues: true, hasWarningIssues: false, issues: [] },
      ],
    };
    const metrics = connector.extractMetrics!(data);
    const byName = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    expect(byName['google-merchant.total_products']).toBe(3);
    expect(byName['google-merchant.offers_scanned']).toBe(3);
    expect(byName['google-merchant.coverage_complete']).toBe(1);
    expect(byName['google-merchant.active_products']).toBe(1);
    expect(byName['google-merchant.disapproved_products_any_destination']).toBe(2);
    expect(byName['google-merchant.products_with_data_quality_issues']).toBe(1);
    // Per-destination metrics — a Demand Gen disapproval must not count
    // toward Shopping Ads (issue #42).
    expect(byName['google-merchant.disapproved_products.shoppingAds']).toBe(1);
    expect(byName['google-merchant.disapproved_products.demandGen']).toBe(1);
    expect(byName['google-merchant.disapproved_products.freeListings']).toBe(0);
    expect(byName['google-merchant.disapproved_products.display']).toBe(0);
    expect(byName['google-merchant.disapproved_products.videoYoutube']).toBe(0);
    expect(byName['google-merchant.disapproved_products.discover']).toBe(0);
  });

  test('reports coverage_complete = 0 when the connector marked the scan incomplete', () => {
    const metrics = connector.extractMetrics!({
      totalProductCount: 250000,
      offersScanned: 250000,
      coverageComplete: false,
      coveragePercent: null,
      products: [],
    });
    const byName = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    expect(byName['google-merchant.coverage_complete']).toBe(0);
    expect(byName['google-merchant.offers_scanned']).toBe(250000);
  });

  test('handles null data without throwing', () => {
    const metrics = connector.extractMetrics!(null);
    expect(metrics.every((m) => m.value === 0 || Array.isArray(m.data))).toBe(true);
  });
});

describe('connector shape', () => {
  test('declares the expected id, category, authType, and signal types', () => {
    expect(connector.id).toBe('google-merchant');
    expect(connector.category).toBe('commerce');
    expect(connector.authType).toBe('oauth2');
    expect(connector.signalTypes).toEqual(
      expect.arrayContaining(['merchant_products_disapproved', 'merchant_feed_data_quality_issues', 'merchant_product_count_drop'])
    );
  });

  test('healthCheck fails cleanly with a clear error when accountId is missing', async () => {
    const result = await connector.healthCheck({ accessToken: 'tok' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/accountId/i);
  });

  test('healthCheck fails cleanly with a clear error when access token is missing', async () => {
    const result = await connector.healthCheck({ accountId: '123' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/[Aa]ccess token/);
  });
});

// ─── Pagination (issue #42) ────────────────────────────────────────────────
//
// Builds a fake Merchant API `products.list` that serves `total` synthetic
// products across pages of `pageSize`, optionally planting a
// Shopping-Ads-disapproved product at a given offset (e.g. beyond the old
// 5,000-offer cap) so pagination continuing past that point is provable.

function mockProductsApi(opts: { total: number; pageSize?: number; blockerOffset?: number }) {
  const { total, pageSize = 1000, blockerOffset } = opts;
  const requestedUrls: string[] = [];

  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url.includes('/accounts/v1/accounts/')) {
      return new Response(JSON.stringify({ accountId: 'acct-1', accountName: 'Test Account' }), { status: 200 });
    }

    const parsed = new URL(url);
    const pageToken = parsed.searchParams.get('pageToken');
    const offset = pageToken ? Number(pageToken) : 0;
    const end = Math.min(offset + pageSize, total);

    const products = [];
    for (let i = offset; i < end; i++) {
      const isBlocker = blockerOffset != null && i === blockerOffset;
      products.push({
        name: `accounts/acct-1/products/p${i}`,
        offerId: `sku-${i}`,
        productAttributes: { title: isBlocker ? 'Blocked Product' : `Product ${i}` },
        productStatus: isBlocker
          ? { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['US'] }] }
          : { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'] }] },
      });
    }

    const body: Record<string, unknown> = { products };
    if (end < total) body.nextPageToken = String(end);

    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  return { requestedUrls };
}

describe('connector.fetch — full-catalogue pagination (issue #42)', () => {
  test('pages past the old 5,000-offer cap and finds a Shopping-blocking product beyond it', async () => {
    mockProductsApi({ total: 6200, pageSize: 1000, blockerOffset: 5500 });

    const data = await connector.fetch('products', { accessToken: 'tok', accountId: 'acct-1' }) as {
      products: Array<{ id: string; title: string | null; disapprovedDestinations: string[] }>;
      totalProductCount: number;
      offersScanned: number;
      coverageComplete: boolean;
    };

    expect(data.totalProductCount).toBe(6200);
    expect(data.offersScanned).toBe(6200);
    expect(data.coverageComplete).toBe(true);

    const blocked = data.products.find((p) => p.disapprovedDestinations.includes('shoppingAds'));
    expect(blocked).toBeDefined();
    expect(blocked?.title).toBe('Blocked Product');
  });

  test('scans a 90,000+ offer catalogue in full and surfaces the single real Shopping blocker', async () => {
    mockProductsApi({ total: 90042, pageSize: 1000, blockerOffset: 89999 });

    const data = await connector.fetch('products', { accessToken: 'tok', accountId: 'acct-1' }) as {
      products: Array<{ disapprovedDestinations: string[] }>;
      totalProductCount: number;
      coverageComplete: boolean;
    };

    expect(data.totalProductCount).toBe(90042);
    expect(data.coverageComplete).toBe(true);
    const blockedForShopping = data.products.filter((p) => p.disapprovedDestinations.includes('shoppingAds'));
    expect(blockedForShopping).toHaveLength(1);
  }, 20000);

  test('a fully-paginated catalogue reports coverageComplete: true and coveragePercent: 100', async () => {
    mockProductsApi({ total: 2500, pageSize: 500 });

    const data = await connector.fetch('products', { accessToken: 'tok', accountId: 'acct-1' }) as {
      totalProductCount: number;
      offersScanned: number;
      coverageComplete: boolean;
      coveragePercent: number | null;
    };

    expect(data.totalProductCount).toBe(2500);
    expect(data.offersScanned).toBe(2500);
    expect(data.coverageComplete).toBe(true);
    expect(data.coveragePercent).toBe(100);
  });

  // Drives the fake feed past the pagination safety ceiling itself (not just
  // the old 5,000 cap) to prove the ceiling is a genuine last-resort guard
  // that degrades honestly, rather than a re-hidden version of the same bug:
  // scanning stops, but the output says so instead of claiming completeness.
  test('marks coverageComplete: false and stops at the safety ceiling for a catalogue that exceeds it', async () => {
    const ceiling = 250_000;
    mockProductsApi({ total: ceiling + 1, pageSize: 1000 });

    const data = await connector.fetch('products', { accessToken: 'tok', accountId: 'acct-1' }) as {
      totalProductCount: number;
      offersScanned: number;
      coverageComplete: boolean;
      coveragePercent: number | null;
    };

    expect(data.coverageComplete).toBe(false);
    expect(data.offersScanned).toBe(ceiling);
    expect(data.totalProductCount).toBe(ceiling);
    expect(data.coveragePercent).toBeNull();
  }, 30000);
});
