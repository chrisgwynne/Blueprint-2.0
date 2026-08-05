import { afterEach, describe, expect, mock, test } from 'bun:test';
import connector from './index.ts';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function successFor(url: string): Response {
  if (url.includes('mybusinessbusinessinformation.googleapis.com')) return jsonResponse({ name: 'locations/456', title: 'Test location' });
  if (url.includes('/reviews')) return jsonResponse({ reviews: [], averageRating: 4.5, totalReviewCount: 2 });
  if (url.includes('/localPosts')) return jsonResponse({ localPosts: [] });
  if (url.includes('/media')) return jsonResponse({ mediaItems: [] });
  if (url.includes('mybusinessqanda.googleapis.com')) return jsonResponse({ questions: [] });
  if (url.includes('businessprofileperformance.googleapis.com')) {
    return jsonResponse({
      multiDailyMetricTimeSeries: [{
        dailyMetricTimeSeries: [
          { dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', timeSeries: { datedValues: [{ value: '2' }] } },
          { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', timeSeries: { datedValues: [{ value: '3' }] } },
          { dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', timeSeries: { datedValues: [{ value: '5' }] } },
          { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', timeSeries: { datedValues: [{ value: '7' }] } },
          { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ value: '11' }] } },
          { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ value: '13' }] } },
          { dailyMetric: 'BUSINESS_DIRECTION_REQUESTS', timeSeries: { datedValues: [{ value: '17' }] } },
        ],
      }],
    });
  }
  throw new Error(`Unexpected test URL: ${url}`);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

describe('GBP optional API compatibility', () => {
  test('uses the v1 Performance and Q&A APIs while preserving existing metric names', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return successFor(url);
    }) as unknown as typeof fetch;

    const data = await connector.fetch('all', {
      accessToken: 'access-token',
      accountId: '123',
      locationId: 'locations/456',
    }) as Record<string, unknown>;

    expect(urls.some((url) => url.startsWith('https://businessprofileperformance.googleapis.com/v1/locations/456:fetchMultiDailyMetricsTimeSeries?'))).toBe(true);
    expect(urls.some((url) => url.startsWith('https://mybusinessqanda.googleapis.com/v1/locations/456/questions?'))).toBe(true);
    expect(urls.some((url) => url.includes('locations:reportInsights'))).toBe(false);
    expect(urls.some((url) => url.includes('mybusiness.googleapis.com/v4/locations/456/questions'))).toBe(false);

    const metrics = Object.fromEntries(connector.extractMetrics(data).map((metric) => [metric.name, metric.value]));
    expect(metrics['gbp.views_maps']).toBe(5);
    expect(metrics['gbp.views_search']).toBe(12);
    expect(metrics['gbp.actions_website']).toBe(11);
    expect(metrics['gbp.actions_phone']).toBe(13);
    expect(metrics['gbp.actions_directions']).toBe(17);
  });

  test('keeps optional 404 failures partial and excludes provider bodies and request URLs', async () => {
    const leaked = 'secret-token-value';
    const warnings: string[] = [];
    console.warn = mock((...args: unknown[]) => warnings.push(args.map(String).join(' '))) as typeof console.warn;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('businessprofileperformance.googleapis.com') || url.includes('mybusinessqanda.googleapis.com')) {
        return new Response(`<html>${leaked}${'x'.repeat(2_000)}</html>`, { status: 404, statusText: 'Not Found' });
      }
      return successFor(url);
    }) as unknown as typeof fetch;

    const data = await connector.fetch('all', {
      accessToken: 'access-token',
      accountId: '123',
      locationId: 'locations/456',
    }) as { insights: unknown; qa: unknown[]; partial_failures: Array<{ section: string; error: string }> };

    expect(data.qa).toEqual([]);
    expect(data.insights).toEqual({ multiDailyMetricTimeSeries: [] });
    expect(data.partial_failures.map((failure) => failure.section).sort()).toEqual(['insights', 'qa']);
    const diagnosticText = JSON.stringify(data.partial_failures) + warnings.join('\n');
    expect(diagnosticText).not.toContain(leaked);
    expect(diagnosticText).not.toContain('<html>');
    expect(diagnosticText).not.toContain('https://');
    expect(diagnosticText.length).toBeLessThan(500);
    expect(diagnosticText).toContain('status=404');
  });

  test('returns only a bounded provider/status classification from health checks', async () => {
    const leaked = 'provider-body-secret';
    globalThis.fetch = mock(async () => new Response(`<html>${leaked}${'x'.repeat(5_000)}</html>`, {
      status: 403,
      statusText: 'Forbidden',
    })) as unknown as typeof fetch;

    const result = await connector.healthCheck(
      { accessToken: 'access-token' },
      { accountId: 'accounts/123', locationId: 'locations/456' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('provider=account-management');
    expect(result.error).toContain('status=403');
    expect(result.error).not.toContain(leaked);
    expect(result.error).not.toContain('<html>');
    expect(result.error!.length).toBeLessThan(120);
  });
});
