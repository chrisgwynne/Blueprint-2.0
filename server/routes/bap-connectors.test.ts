/**
 * Phase 2 Connector API tests — server/routes/bap-connectors.ts, the new
 * BAP surface for connector status/health/freshness/sync history/trigger.
 * Runs against a real Express instance mounting the actual router.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapConnectorsRouter from './bap-connectors.ts';

const BIZ_A = 'biz_bap_conn_a';
const BIZ_B = 'biz_bap_conn_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;
let keySync: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertConnector(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, status, last_sync, last_error, config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, (overrides.business_id as string) ?? BIZ_A, (overrides.type as string) ?? 'gsc',
    (overrides.name as string) ?? 'Fixture Connector',
    JSON.stringify({ iv: 'fake', tag: 'fake', data: 'super-secret-should-never-leak' }),
    (overrides.status as string) ?? 'connected', (overrides.last_sync as string) ?? null,
    (overrides.last_error as string) ?? null, (overrides.config as string) ?? JSON.stringify({ siteUrl: 'https://example.com' }),
  );
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Conn A', 'bap-conn-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Conn B', 'bap-conn-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_conn_read', 'agt_conn_sync')`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Conn Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_conn_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['connectors:read']), JSON.stringify([BIZ_A]));

  keySync = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Conn Sync Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_conn_sync', await hashApiKey(keySync), keyPrefix(keySync), JSON.stringify(['connectors:read', 'connectors:sync']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapConnectorsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM connector_syncs WHERE connector_id IN (SELECT id FROM connectors WHERE business_id IN (?, ?))`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM connectors WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN ('agt_conn_read', 'agt_conn_sync')`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_conn_read', 'agt_conn_sync')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_conn_read', 'agt_conn_sync')`).run();
});

describe('GET /businesses/:id/connectors', () => {
  test('lists connectors with computed freshness, never exposes credentials', async () => {
    insertConnector({ type: 'gsc', status: 'connected', last_sync: new Date().toISOString() });
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/connectors`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.connectors.length).toBeGreaterThanOrEqual(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('super-secret-should-never-leak');
    expect(body.connectors[0]).not.toHaveProperty('credentials');
    expect(body.connectors[0].status).toBe('live'); // freshly synced -> "live" via computeConnectorStatus
  });

  test('a stale connector (last_sync past its threshold) is reported as stale', async () => {
    const staleTime = new Date(Date.now() - 100 * 3600000).toISOString(); // 100h ago, gsc threshold is 24h
    insertConnector({ type: 'gsc', status: 'connected', last_sync: staleTime });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/connectors?type=gsc`, { 'BAP-Key': keyRead });
    expect(body.connectors.some((c: any) => c.status === 'stale')).toBe(true);
  });

  test('a connector with no last_sync ever is reported honestly (not stale, not live)', async () => {
    const id = insertConnector({ type: 'shopify', status: 'disconnected', last_sync: null });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/connectors?type=shopify`, { 'BAP-Key': keyRead });
    const conn = body.connectors.find((c: any) => c.id === id);
    expect(conn.status).toBe('disconnected');
    expect(conn.hours_since_sync).toBeNull();
  });

  test('config_summary only whitelists known-safe fields', async () => {
    insertConnector({ type: 'github', config: JSON.stringify({ owner: 'acme', repos: 'acme/widgets', somethingUnexpected: 'zzz' }) });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/connectors?type=github`, { 'BAP-Key': keyRead });
    const conn = body.connectors.find((c: any) => c.type === 'github');
    expect(conn.config_summary).not.toHaveProperty('somethingUnexpected');
    expect(conn.config_summary.owner).toBe('acme');
  });

  test('403 without connectors:read on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/connectors`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('GET /connectors/:id (detail)', () => {
  test('returns sync_stats and metrics_stored', async () => {
    const id = insertConnector({ type: 'ga4' });
    db.prepare(`INSERT INTO connector_syncs (id, connector_id, status, duration_ms, created_at) VALUES (?, ?, 'complete', 500, CURRENT_TIMESTAMP)`).run(generateId(), id);
    db.prepare(`INSERT INTO connector_syncs (id, connector_id, status, error, duration_ms, created_at) VALUES (?, ?, 'failed', 'timeout', 200, CURRENT_TIMESTAMP)`).run(generateId(), id);

    const { status, body } = await get(`/api/bap/v1/connectors/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.sync_stats.total_syncs).toBe(2);
    expect(body.sync_stats.failed_syncs).toBe(1);
    expect(body.sync_stats.complete_syncs).toBe(1);
  });

  test('404 for unknown connector', async () => {
    const { status } = await get('/api/bap/v1/connectors/does-not-exist', { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });

  test('403 across tenants', async () => {
    const id = insertConnector({ business_id: BIZ_B });
    const { status } = await get(`/api/bap/v1/connectors/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('GET /connectors/:id/syncs', () => {
  test('lists sync history, filterable by status, paginated', async () => {
    const id = insertConnector({ type: 'shopify' });
    for (let i = 0; i < 3; i++) db.prepare(`INSERT INTO connector_syncs (id, connector_id, status, created_at) VALUES (?, ?, 'complete', CURRENT_TIMESTAMP)`).run(generateId(), id);
    db.prepare(`INSERT INTO connector_syncs (id, connector_id, status, error, created_at) VALUES (?, ?, 'failed', 'boom', CURRENT_TIMESTAMP)`).run(generateId(), id);

    const all = await get(`/api/bap/v1/connectors/${id}/syncs`, { 'BAP-Key': keyRead });
    expect(all.body.total).toBe(4);

    const failedOnly = await get(`/api/bap/v1/connectors/${id}/syncs?status=failed`, { 'BAP-Key': keyRead });
    expect(failedOnly.body.syncs.length).toBe(1);
    expect(failedOnly.body.syncs[0].error).toBe('boom');
  });
});

describe('POST /connectors/:id/sync', () => {
  test('requires connectors:sync (not just connectors:read)', async () => {
    const id = insertConnector();
    const { status } = await post(`/api/bap/v1/connectors/${id}/sync`, {}, { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
  });

  test('requires Idempotency-Key', async () => {
    const id = insertConnector();
    const { status } = await post(`/api/bap/v1/connectors/${id}/sync`, {}, { 'BAP-Key': keySync });
    expect(status).toBe(400);
  });

  test('returns 202 with syncing status for an authorized caller', async () => {
    const id = insertConnector({ type: 'uptimerobot' }); // a type whose syncConnector() path will fail fast on a missing/fake connector but the endpoint itself should still 202
    const { status, body } = await post(`/api/bap/v1/connectors/${id}/sync`, {}, { 'BAP-Key': keySync, 'Idempotency-Key': generateId() });
    expect(status).toBe(202);
    expect(body.status).toBe('syncing');
    expect(body.connector_id).toBe(id);
  });

  test('cross-tenant sync trigger is rejected with 403', async () => {
    const id = insertConnector({ business_id: BIZ_B });
    const { status } = await post(`/api/bap/v1/connectors/${id}/sync`, {}, { 'BAP-Key': keySync, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
  });
});
