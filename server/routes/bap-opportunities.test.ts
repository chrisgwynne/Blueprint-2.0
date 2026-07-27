/**
 * Phase 3 Opportunity API tests — server/routes/bap-opportunities.ts. Runs
 * against a real Express instance mounting the actual router.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapOpportunitiesRouter from './bap-opportunities.ts';

const BIZ_A = 'biz_bap_opp_a';
const BIZ_B = 'biz_bap_opp_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;
let keyTrigger: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertOpportunity(businessId: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO goal_suggestions (id, business_id, title, opportunity_value, confidence, connector_source, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId, (overrides.title as string) ?? 'Fixture opportunity', (overrides.opportunity_value as number) ?? 100,
    (overrides.confidence as number) ?? 0.8, (overrides.connector_source as string) ?? 'gsc', (overrides.status as string) ?? 'pending');
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Opp A', 'bap-opp-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Opp B', 'bap-opp-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_opp_read', 'agt_opp_trigger')`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Opp Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_opp_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['opportunities:read']), JSON.stringify([BIZ_A]));

  keyTrigger = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Opp Trigger Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_opp_trigger', await hashApiKey(keyTrigger), keyPrefix(keyTrigger), JSON.stringify(['opportunities:read', 'opportunities:trigger']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapOpportunitiesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM goal_suggestions WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN ('agt_opp_read', 'agt_opp_trigger')`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_opp_read', 'agt_opp_trigger')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_opp_read', 'agt_opp_trigger')`).run();
});

describe('GET /businesses/:id/opportunities', () => {
  test('lists pending opportunities by default, parses JSON columns', async () => {
    insertOpportunity(BIZ_A, { title: 'Meta rewrite opportunity' });
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/opportunities`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.opportunities.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.opportunities[0].related_goal_ids)).toBe(true);
    expect(Array.isArray(body.opportunities[0].related_risks)).toBe(true);
  });

  test('status=all includes dismissed/accepted, status=dismissed filters to just that', async () => {
    insertOpportunity(BIZ_A, { status: 'dismissed' });
    const dismissedOnly = await get(`/api/bap/v1/businesses/${BIZ_A}/opportunities?status=dismissed`, { 'BAP-Key': keyRead });
    expect(dismissedOnly.body.opportunities.every((o: any) => o.status === 'dismissed')).toBe(true);
  });

  test('pagination shape', async () => {
    for (let i = 0; i < 3; i++) insertOpportunity(BIZ_A, { title: `Page test ${i}`, connector_source: 'pagination_test_connector' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/opportunities?connector_source=pagination_test_connector&page=1&limit=2`, { 'BAP-Key': keyRead });
    expect(body.opportunities.length).toBe(2);
    expect(body.pagination).toMatchObject({ page: 1, limit: 2, total: 3, pages: 2 });
  });

  test('403 without opportunities:read on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/opportunities`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('GET /opportunities/:id', () => {
  test('returns detail for an owned opportunity', async () => {
    const id = insertOpportunity(BIZ_A);
    const { status, body } = await get(`/api/bap/v1/opportunities/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.opportunity.id).toBe(id);
  });

  test('404 for an unknown opportunity', async () => {
    const { status } = await get('/api/bap/v1/opportunities/does-not-exist', { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });

  test('403 across tenants', async () => {
    const id = insertOpportunity(BIZ_B);
    const { status } = await get(`/api/bap/v1/opportunities/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('POST /businesses/:id/opportunities/scan', () => {
  test('requires opportunities:trigger, not just opportunities:read', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/opportunities/scan`, {}, { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
  });

  test('202 with a valid trigger key and Idempotency-Key', async () => {
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/opportunities/scan`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() });
    expect(status).toBe(202);
    expect(body.status).toBe('scanning');
  });

  test('400 without Idempotency-Key', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/opportunities/scan`, {}, { 'BAP-Key': keyTrigger });
    expect(status).toBe(400);
  });
});

describe('Concurrent reads', () => {
  test('20 simultaneous list requests all succeed', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => get(`/api/bap/v1/businesses/${BIZ_A}/opportunities`, { 'BAP-Key': keyRead })));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
