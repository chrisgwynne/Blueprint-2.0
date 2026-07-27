import { describe, test, expect } from 'bun:test';
import connector, { summarizeProduct } from './index.ts';

describe('summarizeProduct', () => {
  test('flags a product disapproved when any destination has disapproved countries', () => {
    const summary = summarizeProduct({
      name: 'accounts/123/products/p1',
      productAttributes: { title: 'Widget' },
      productStatus: {
        destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'], disapprovedCountries: ['GB'] }],
      },
    });
    expect(summary.disapproved).toBe(true);
    expect(summary.title).toBe('Widget');
  });

  test('does not flag disapproved when all destinations are fully approved', () => {
    const summary = summarizeProduct({
      productStatus: { destinationStatuses: [{ approvedCountries: ['US', 'GB'], disapprovedCountries: [] }] },
    });
    expect(summary.disapproved).toBe(false);
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
    expect(summary.disapproved).toBe(false);
    expect(summary.hasErrorIssues).toBe(false);
    expect(summary.issues).toEqual([]);
  });

  test('falls back to offerId then "unknown" when name is missing', () => {
    expect(summarizeProduct({ offerId: 'sku-42' }).id).toBe('sku-42');
    expect(summarizeProduct({}).id).toBe('unknown');
  });
});

describe('connector.extractMetrics', () => {
  test('counts total, active, disapproved, and data-quality-issue products correctly', () => {
    const data = {
      totalProductCount: 3,
      products: [
        { id: 'p1', title: 'A', disapproved: false, hasErrorIssues: false, hasWarningIssues: false, issues: [] },
        { id: 'p2', title: 'B', disapproved: true, hasErrorIssues: false, hasWarningIssues: false, issues: [] },
        { id: 'p3', title: 'C', disapproved: false, hasErrorIssues: true, hasWarningIssues: false, issues: [] },
      ],
    };
    const metrics = connector.extractMetrics!(data);
    const byName = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    expect(byName['google-merchant.total_products']).toBe(3);
    expect(byName['google-merchant.active_products']).toBe(1);
    expect(byName['google-merchant.disapproved_products']).toBe(1);
    expect(byName['google-merchant.products_with_data_quality_issues']).toBe(1);
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
