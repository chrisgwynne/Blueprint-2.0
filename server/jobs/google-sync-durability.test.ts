import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';

const ORIGINAL_ENV = Object.fromEntries([
  'ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
].map(key => [key, process.env[key]]));

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '22'.repeat(32);
process.env.GOOGLE_CLIENT_ID = 'sync-test-client';
process.env.GOOGLE_CLIENT_SECRET = 'sync-test-secret';

mock.module('../agents/self-healer.js', () => ({ healConnectorError: mock(async () => undefined) }));

const { default: db } = await import('../db/db.js');
const { encrypt } = await import('../crypto.js');
const { runConnectorSync } = await import('../routes/connectors.js');
const { syncConnector } = await import('./scheduler.js');

const BUSINESS_ID = 'biz_google_sync_durability';
const CONNECTOR_ID = 'connector_google_sync_durability';

function seedAccessOnlyConnector(): any {
  db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?)').run(BUSINESS_ID, 'Sync Durability', 'sync-durability');
  db.prepare(`INSERT INTO connectors (id, business_id, type, name, status, credentials, config, created_at)
    VALUES (?, ?, 'gsc', 'GSC durability', 'connected', ?, '{}', CURRENT_TIMESTAMP)`)
    .run(CONNECTOR_ID, BUSINESS_ID, encrypt(JSON.stringify({
      accessToken: 'temporary-access', expiresAt: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    })));
  return db.prepare('SELECT * FROM connectors WHERE id = ?').get(CONNECTOR_ID);
}

function expectFailedWithoutMetrics(): void {
  const row = db.prepare('SELECT status, last_error FROM connectors WHERE id = ?').get(CONNECTOR_ID) as any;
  expect(row.status).toBe('error');
  expect(row.last_error).toMatch(/temporary|under-scoped|OAuth client|reconnect/i);
  expect(db.prepare('SELECT COUNT(*) AS count FROM metrics WHERE connector_id = ?').get(CONNECTOR_ID)).toMatchObject({ count: 0 });
}

afterEach(() => {
  db.prepare('DELETE FROM connector_syncs WHERE connector_id = ?').run(CONNECTOR_ID);
  db.prepare('DELETE FROM metrics WHERE connector_id = ?').run(CONNECTOR_ID);
  db.prepare('DELETE FROM connectors WHERE id = ?').run(CONNECTOR_ID);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BUSINESS_ID);
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Google sync durability gate', () => {
  test('manual sync rejects an access-only grant before API fetch or metric writes', async () => {
    seedAccessOnlyConnector();
    await runConnectorSync(CONNECTOR_ID);
    expectFailedWithoutMetrics();
  });

  test('scheduled sync rejects an access-only grant before API fetch or metric writes', async () => {
    const connector = seedAccessOnlyConnector();
    const result = await syncConnector(connector);
    expect(result.ok).toBe(false);
    expectFailedWithoutMetrics();
  });
});
