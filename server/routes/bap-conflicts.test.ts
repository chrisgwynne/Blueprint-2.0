/**
 * Phase 3 general Conflicts API tests — server/routes/bap-conflicts.ts.
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
import bapConflictsRouter from './bap-conflicts.ts';

const BIZ_A = 'biz_bap_conf_a';
const BIZ_B = 'biz_bap_conf_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertConflict(businessId: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO conflicts (id, business_id, conflict_type, category, severity, entity_a_type, entity_a_id, entity_b_type, entity_b_id, description, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, businessId, (overrides.conflict_type as string) ?? 'task_vs_goal', (overrides.category as string) ?? 'direct',
    (overrides.severity as string) ?? 'warning', 'task', (overrides.entity_a_id as string) ?? generateId(),
    'goal', (overrides.entity_b_id as string) ?? generateId(), (overrides.description as string) ?? 'Fixture conflict',
    (overrides.status as string) ?? 'open',
  );
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Conf A', 'bap-conf-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Conf B', 'bap-conf-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_conf_read'`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Conflicts Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_conf_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['conflicts:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapConflictsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM conflicts WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id = 'agt_conf_read'`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id = 'agt_conf_read'`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_conf_read'`).run();
});

describe('GET /businesses/:id/conflicts', () => {
  test('lists open conflicts by default', async () => {
    insertConflict(BIZ_A);
    insertConflict(BIZ_A, { status: 'resolved' });
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/conflicts`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.conflicts.every((c: any) => c.status === 'open')).toBe(true);
  });

  test('status=all includes resolved/dismissed', async () => {
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/conflicts?status=all`, { 'BAP-Key': keyRead });
    expect(body.conflicts.some((c: any) => c.status === 'resolved')).toBe(true);
  });

  test('filters by conflict_type and category', async () => {
    insertConflict(BIZ_A, { conflict_type: 'goal_dependency', category: 'dependency' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/conflicts?status=all&conflict_type=goal_dependency&category=dependency`, { 'BAP-Key': keyRead });
    expect(body.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(body.conflicts.every((c: any) => c.conflict_type === 'goal_dependency' && c.category === 'dependency')).toBe(true);
  });

  test('filters by entity_id (matching either side)', async () => {
    const taskId = generateId();
    insertConflict(BIZ_A, { entity_a_id: taskId });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/conflicts?status=all&entity_id=${taskId}`, { 'BAP-Key': keyRead });
    expect(body.conflicts.some((c: any) => c.entity_a_id === taskId)).toBe(true);
  });

  test('pagination shape', async () => {
    for (let i = 0; i < 3; i++) insertConflict(BIZ_A, { description: `Pagination fixture ${i}` });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/conflicts?status=all&page=1&limit=2`, { 'BAP-Key': keyRead });
    expect(body.conflicts.length).toBe(2);
    expect(body.pagination.limit).toBe(2);
  });

  test('does not leak another business\'s conflicts', async () => {
    insertConflict(BIZ_B);
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/conflicts?status=all`, { 'BAP-Key': keyRead });
    expect(body.conflicts.every((c: any) => c.business_id === BIZ_A)).toBe(true);
  });

  test('403 without conflicts:read on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/conflicts`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('GET /conflicts/:id', () => {
  test('returns detail for an owned conflict', async () => {
    const id = insertConflict(BIZ_A);
    const { status, body } = await get(`/api/bap/v1/conflicts/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.conflict.id).toBe(id);
  });

  test('404 for an unknown conflict', async () => {
    const { status } = await get('/api/bap/v1/conflicts/does-not-exist', { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });

  test('403 across tenants', async () => {
    const id = insertConflict(BIZ_B);
    const { status } = await get(`/api/bap/v1/conflicts/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('Concurrent reads', () => {
  test('20 simultaneous list requests all succeed', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => get(`/api/bap/v1/businesses/${BIZ_A}/conflicts?status=all`, { 'BAP-Key': keyRead })));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
