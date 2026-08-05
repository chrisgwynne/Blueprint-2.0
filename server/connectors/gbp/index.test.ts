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
  if (url.includes('businessprofileperformance.googleapis.com')) {
    return jsonResponse({
      multiDailyMetricTimeSeries: [{
        dailyMetricTimeSeries: [
          { dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', timeSeries: { datedValues: [{ value: '2' }] } },
          { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', timeSeries: { datedValues: [{ value: '3' }] } },
          { dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', timeSeries: { datedValues: [{ value: '5' }] } },
          { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', timeSeries: { datedValues: [{ value: '7' }] } },
          { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ value: '11' }] } },
          { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ value: '0' }] } },
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
  test('does not request discontinued Q&A or fabricate Q&A metrics', async () => {
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
    }) as Record<string, unknown> & { partial_failures: Array<{ section: string; error: string }> };

    expect(urls.some((url) => url.includes('mybusinessqanda.googleapis.com'))).toBe(false);
    expect(urls.some((url) => url.includes('/questions'))).toBe(false);
    expect(data).not.toHaveProperty('qa');
    expect(data.partial_failures).toContainEqual({
      section: 'qa',
      error: 'GBP provider unavailable (provider=qanda status=unsupported)',
    });

    const metricNames = connector.extractMetrics(data).map((metric) => metric.name);
    expect(metricNames).not.toContain('gbp.unanswered_qa');
    expect(metricNames).not.toContain('gbp.qa_data');
    expect(connector.signalTypes).not.toContain('gbp_unanswered_questions');
  });

  test('omits unsupported legacy metrics while preserving an observed supported zero', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => successFor(String(input))) as unknown as typeof fetch;

    const data = await connector.fetch('all', {
      accessToken: 'access-token',
      accountId: '123',
      locationId: 'locations/456',
    });
    const metrics = Object.fromEntries(connector.extractMetrics(data).map(metric => [metric.name, metric.value]));

    expect(metrics['gbp.actions_phone']).toBe(0);
    expect(metrics['gbp.views_maps']).toBe(5);
    expect(metrics['gbp.views_search']).toBe(12);
    for (const name of [
      'gbp.queries_direct',
      'gbp.queries_indirect',
      'gbp.queries_total',
      'gbp.photo_views',
      'gbp.photo_count',
    ]) expect(name in metrics).toBe(false);
  });

  test('requests exactly 28 inclusive Performance dates with the documented metrics', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      urls.push(String(input));
      return successFor(String(input));
    }) as unknown as typeof fetch;

    await connector.fetch('all', {
      accessToken: 'access-token',
      accountId: '123',
      locationId: 'locations/456',
    });

    const rawUrl = urls.find(url => url.includes('businessprofileperformance.googleapis.com'));
    expect(rawUrl).toBeDefined();
    const url = new URL(rawUrl!);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://businessprofileperformance.googleapis.com/v1/locations/456:fetchMultiDailyMetricsTimeSeries',
    );
    expect(url.searchParams.getAll('dailyMetrics')).toEqual([
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'WEBSITE_CLICKS',
      'CALL_CLICKS',
      'BUSINESS_DIRECTION_REQUESTS',
    ]);
    expect([...new Set(url.searchParams.keys())].sort()).toEqual([
      'dailyMetrics',
      'dailyRange.end_date.day',
      'dailyRange.end_date.month',
      'dailyRange.end_date.year',
      'dailyRange.start_date.day',
      'dailyRange.start_date.month',
      'dailyRange.start_date.year',
    ]);
    const readDate = (prefix: string) => Date.UTC(
      Number(url.searchParams.get(`${prefix}.year`)),
      Number(url.searchParams.get(`${prefix}.month`)) - 1,
      Number(url.searchParams.get(`${prefix}.day`)),
    );
    const start = readDate('dailyRange.start_date');
    const end = readDate('dailyRange.end_date');
    expect((end - start) / 86_400_000 + 1).toBe(28);
  });

  test('omits Performance scalars when the section fails and sanitizes diagnostics', async () => {
    const leaked = 'location-456-secret-token';
    const warnings: string[] = [];
    const urls: string[] = [];
    console.warn = mock((...args: unknown[]) => warnings.push(args.map(String).join(' '))) as typeof console.warn;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('businessprofileperformance.googleapis.com')) {
        return new Response(`<html>${leaked}${'x'.repeat(2_000)}</html>`, { status: 404, statusText: 'Not Found' });
      }
      return successFor(url);
    }) as unknown as typeof fetch;

    const data = await connector.fetch('all', {
      accessToken: 'access-token',
      accountId: '123',
      locationId: 'locations/456',
    }) as { insights: unknown; partial_failures: Array<{ section: string; error: string }> };

    expect(urls.some((url) => url.includes('mybusinessqanda.googleapis.com'))).toBe(false);
    expect(data.partial_failures.map((failure) => failure.section).sort()).toEqual(['insights', 'qa']);
    const metricNames = connector.extractMetrics(data).map((metric) => metric.name);
    for (const name of [
      'gbp.views_maps',
      'gbp.views_search',
      'gbp.views_total',
      'gbp.actions_website',
      'gbp.actions_phone',
      'gbp.actions_directions',
    ]) expect(metricNames).not.toContain(name);

    const diagnosticText = JSON.stringify(data.partial_failures) + warnings.join('\n');
    expect(diagnosticText).not.toContain(leaked);
    expect(diagnosticText).not.toContain('<html>');
    expect(diagnosticText).not.toContain('https://');
    expect(diagnosticText).not.toContain('locations/456');
    expect(diagnosticText).not.toContain('access-token');
    expect(diagnosticText.length).toBeLessThan(500);
    expect(diagnosticText).toContain('status=404');
  });

  test('omits Performance scalars when the section is absent', () => {
    const metricNames = connector.extractMetrics({
      reviews: { reviews: [], averageRating: 4.5, totalReviewCount: 2 },
      posts: [],
      photos: [],
    }).map(metric => metric.name);

    for (const name of [
      'gbp.views_maps',
      'gbp.views_search',
      'gbp.views_total',
      'gbp.actions_website',
      'gbp.actions_phone',
      'gbp.actions_directions',
    ]) expect(metricNames).not.toContain(name);
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
