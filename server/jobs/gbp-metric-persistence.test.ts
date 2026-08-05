import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import crypto from 'crypto';

const ORIGINAL_ENV = Object.fromEntries([
  'ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalLog = console.log;

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '33'.repeat(32);
process.env.GOOGLE_CLIENT_ID = 'gbp-persistence-client';
process.env.GOOGLE_CLIENT_SECRET = 'gbp-persistence-secret';

mock.module('../agents/self-healer.js', () => ({ healConnectorError: mock(async () => undefined) }));

const { default: db } = await import('../db/db.js');
const { encrypt } = await import('../crypto.js');
const { runConnectorSync } = await import('../routes/connectors.js');
const { syncConnector } = await import('./scheduler.js');

const BUSINESS_ID = 'biz_gbp_metric_persistence';
const CONNECTOR_ID = 'connector_gbp_metric_persistence';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function seedConnector(): any {
  const oauthClientIdFingerprint = crypto.createHash('sha256')
    .update(process.env.GOOGLE_CLIENT_ID!)
    .digest('base64url')
    .slice(0, 16);
  const credentials = {
    accessToken: 'persistence-access-token',
    refreshToken: 'persistence-refresh-token',
    expiresAt: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/business.manage',
    oauthClientIdFingerprint,
  };
  db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'GBP Persistence', 'gbp-persistence');
  db.prepare(`INSERT INTO connectors (id, business_id, type, name, status, credentials, config, created_at)
    VALUES (?, ?, 'gbp', 'GBP persistence', 'connected', ?, ?, CURRENT_TIMESTAMP)`)
    .run(CONNECTOR_ID, BUSINESS_ID, encrypt(JSON.stringify(credentials)), JSON.stringify({ accountId: '123', locationId: 'locations/456' }));
  return db.prepare('SELECT * FROM connectors WHERE id = ?').get(CONNECTOR_ID);
}

function persistedMetrics(): Map<string, number | null> {
  const rows = db.prepare(`SELECT metric_name, metric_value FROM metrics
    WHERE connector_id = ? AND metric_name != 'gbp_sync'`).all(CONNECTOR_ID) as Array<{ metric_name: string; metric_value: number | null }>;
  return new Map(rows.map(row => [row.metric_name, row.metric_value]));
}

function expectUnavailableAbsentAndObservedZerosPresent(): void {
  const metrics = persistedMetrics();
  expect(metrics.has('gbp.avg_rating')).toBe(false);
  expect(metrics.has('gbp.total_reviews')).toBe(false);
  expect(metrics.has('gbp.reviews_data')).toBe(false);
  expect(metrics.has('gbp.actions_website')).toBe(false);
  expect(metrics.get('gbp.actions_phone')).toBe(0);
  expect(metrics.get('gbp.posts_live')).toBe(0);
  expect(metrics.get('gbp.photos_data')).toBe(0);
}

beforeEach(() => {
  db.exec('BEGIN');
  console.warn = mock(() => undefined) as typeof console.warn;
  console.log = mock(() => undefined) as typeof console.log;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('mybusinessbusinessinformation.googleapis.com')) return jsonResponse({ name: 'locations/456' });
    if (url.includes('/reviews')) return new Response('provider-body-secret', { status: 404, statusText: 'Not Found' });
    if (url.includes('/localPosts')) return jsonResponse({ localPosts: [] });
    if (url.includes('/media')) return jsonResponse({ mediaItems: [] });
    if (url.includes('businessprofileperformance.googleapis.com')) {
      return jsonResponse({
        multiDailyMetricTimeSeries: [{
          dailyMetricTimeSeries: [{ dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{}] } }],
        }],
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  db.exec('ROLLBACK');
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  console.log = originalLog;
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GBP metric persistence availability', () => {
  test('manual sync omits unavailable rows and persists genuine observed zeros', async () => {
    seedConnector();
    await runConnectorSync(CONNECTOR_ID);
    expectUnavailableAbsentAndObservedZerosPresent();
  });

  test('scheduled sync omits unavailable rows and persists genuine observed zeros', async () => {
    const connector = seedConnector();
    const result = await syncConnector(connector);
    expect(result.ok).toBe(true);
    expectUnavailableAbsentAndObservedZerosPresent();
  });
});
