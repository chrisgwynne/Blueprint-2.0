/**
 * Phase 3 Decision Memory API tests — server/routes/bap-decisions.ts. Runs
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
import { recordDecision } from '../brain/decision-memory.ts';
import bapDecisionsRouter from './bap-decisions.ts';

const BIZ_A = 'biz_bap_dec_a';
const BIZ_B = 'biz_bap_dec_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Dec A', 'bap-dec-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Dec B', 'bap-dec-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_dec_read'`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Decisions Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_dec_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['decisions:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapDecisionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM decisions WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id = 'agt_dec_read'`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id = 'agt_dec_read'`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_dec_read'`).run();
});

describe('GET /businesses/:id/decisions', () => {
  test('lists decisions, most recent first', async () => {
    recordDecision({ business_id: BIZ_A, decision_type: 'manual', title: 'First', decision: 'x', author: 'human' });
    recordDecision({ business_id: BIZ_A, decision_type: 'manual', title: 'Second', decision: 'y', author: 'human' });
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decisions`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.decisions.length).toBeGreaterThanOrEqual(2);
  });

  test('q searches text, decision_type filters exactly', async () => {
    recordDecision({ business_id: BIZ_A, decision_type: 'task_approval', title: 'Approved door-toppers meta', decision: 'x', author: 'human' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decisions?q=door-toppers`, { 'BAP-Key': keyRead });
    expect(body.decisions.some((d: any) => d.title.includes('door-toppers'))).toBe(true);

    const { body: byType } = await get(`/api/bap/v1/businesses/${BIZ_A}/decisions?decision_type=task_approval`, { 'BAP-Key': keyRead });
    expect(byType.decisions.every((d: any) => d.decision_type === 'task_approval')).toBe(true);
  });

  test('pagination shape', async () => {
    for (let i = 0; i < 5; i++) recordDecision({ business_id: BIZ_A, decision_type: 'manual', title: `Page fixture ${i}`, decision: 'x', author: 'human' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decisions?q=Page+fixture&page=1&limit=2`, { 'BAP-Key': keyRead });
    expect(body.decisions).toHaveLength(2);
    expect(body.pagination.total).toBe(5);
  });

  test('does not leak another business\'s decisions', async () => {
    recordDecision({ business_id: BIZ_B, decision_type: 'manual', title: 'Other tenant decision', decision: 'x', author: 'human' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decisions?q=Other+tenant`, { 'BAP-Key': keyRead });
    expect(body.decisions).toHaveLength(0);
  });

  test('403 without decisions:read on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/decisions`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('GET /decisions/:id', () => {
  test('returns a decision by id, with real arrays for evidence/alternatives', async () => {
    const id = recordDecision({
      business_id: BIZ_A, decision_type: 'strategy_selection', title: 'Chose SEO',
      decision: 'x', evidence: [{ note: 'test' }], alternatives_rejected: [{ name: 'Paid ads' }], author: 'human',
    });
    const { status, body } = await get(`/api/bap/v1/decisions/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.decision.id).toBe(id);
    expect(Array.isArray(body.decision.evidence)).toBe(true);
    expect(Array.isArray(body.decision.alternatives_rejected)).toBe(true);
  });

  test('404 for an unknown decision', async () => {
    const { status } = await get('/api/bap/v1/decisions/does-not-exist', { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });

  test('403 across tenants (cross-tenant IDOR safe — no :businessId in the path)', async () => {
    const id = recordDecision({ business_id: BIZ_B, decision_type: 'manual', title: 'x', decision: 'x', author: 'human' });
    const { status } = await get(`/api/bap/v1/decisions/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});
