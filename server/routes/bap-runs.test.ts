/**
 * Phase 2 Agent Run API tests â€” server/routes/bap-runs.ts (list/cancel/retry).
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
import bapRunsRouter from './bap-runs.ts';

const BIZ_A = 'biz_bap_runs_a';
const BIZ_B = 'biz_bap_runs_b';
const AGENT_ID = 'conductor';

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

function insertRun(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at, completed_at, error)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
  `).run(
    id, (overrides.agent_id as string) ?? AGENT_ID, (overrides.business_id as string) ?? BIZ_A,
    (overrides.trigger as string) ?? 'manual', (overrides.status as string) ?? 'running',
    (overrides.completed_at as string) ?? null, (overrides.error as string) ?? null,
  );
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Runs A', 'bap-runs-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Runs B', 'bap-runs-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);
  db.prepare(`INSERT INTO agents (id, profile_path, name, status, created_at) VALUES ('conductor', 'server/agents/conductor/profile.yaml', 'Conductor', 'active', CURRENT_TIMESTAMP) ON CONFLICT(id) DO NOTHING`).run();

  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN ('agt_runs_read', 'agt_runs_trigger')`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_runs_read', 'agt_runs_trigger')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_runs_read', 'agt_runs_trigger')`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Runs Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_runs_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['agents:read']), JSON.stringify([BIZ_A]));

  keyTrigger = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Runs Trigger Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_runs_trigger', await hashApiKey(keyTrigger), keyPrefix(keyTrigger), JSON.stringify(['agents:read', 'agents:trigger']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapRunsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM agent_runs WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN ('agt_runs_read', 'agt_runs_trigger')`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_runs_read', 'agt_runs_trigger')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_runs_read', 'agt_runs_trigger')`).run();
});

describe('GET /businesses/:id/runs', () => {
  test('lists runs, filterable by status/trigger/agent_id', async () => {
    insertRun({ status: 'running' });
    insertRun({ status: 'failed', completed_at: new Date().toISOString(), error: 'boom' });
    insertRun({ status: 'complete', completed_at: new Date().toISOString() });

    const all = await get(`/api/bap/v1/businesses/${BIZ_A}/runs`, { 'BAP-Key': keyRead });
    expect(all.status).toBe(200);
    expect(all.body.runs.length).toBeGreaterThanOrEqual(3);

    const failedOnly = await get(`/api/bap/v1/businesses/${BIZ_A}/runs?status=failed`, { 'BAP-Key': keyRead });
    expect(failedOnly.body.runs.every((r: any) => r.status === 'failed')).toBe(true);
  });

  test('pagination shape', async () => {
    for (let i = 0; i < 3; i++) insertRun({ trigger: 'pagination_test' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/runs?trigger=pagination_test&page=1&limit=2`, { 'BAP-Key': keyRead });
    expect(body.runs.length).toBe(2);
    expect(body.pagination).toMatchObject({ page: 1, limit: 2, total: 3, pages: 2 });
  });

  test('403 without agents:read on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/runs`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('POST /runs/:runId/cancel', () => {
  test('cancels a running run', async () => {
    const runId = insertRun({ status: 'running' });
    const { status, body } = await post(`/api/bap/v1/runs/${runId}/cancel`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() });
    expect(status).toBe(202);
    expect(body.status).toBe('cancellation_requested');
    const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('cancellation_requested');
  });

  test('409 for a run that already finished', async () => {
    const runId = insertRun({ status: 'complete', completed_at: new Date().toISOString() });
    const { status } = await post(`/api/bap/v1/runs/${runId}/cancel`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() });
    expect(status).toBe(409);
  });

  test('requires agents:trigger, not just agents:read', async () => {
    const runId = insertRun({ status: 'running' });
    const { status } = await post(`/api/bap/v1/runs/${runId}/cancel`, {}, { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
  });

  test('404 for unknown run', async () => {
    const { status } = await post('/api/bap/v1/runs/does-not-exist/cancel', {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() });
    expect(status).toBe(404);
  });

  test('cross-tenant cancel is rejected with 403', async () => {
    const runId = insertRun({ business_id: BIZ_B, status: 'running' });
    const { status } = await post(`/api/bap/v1/runs/${runId}/cancel`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
  });
});

describe('POST /runs/:runId/retry', () => {
  test('re-triggers a failed run, creating a new run row', async () => {
    const runId = insertRun({ status: 'failed', completed_at: new Date().toISOString(), error: 'LLM timeout' });
    const { status, body } = await post(`/api/bap/v1/runs/${runId}/retry`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() });
    expect(status).toBe(202);
    expect(body.retried_from).toBe(runId);
    expect(body.run_id).not.toBe(runId);
    const newRow = db.prepare('SELECT status, agent_id FROM agent_runs WHERE id = ?').get(body.run_id) as { status: string; agent_id: string };
    expect(newRow.status).toBe('running');
    expect(newRow.agent_id).toBe(AGENT_ID);
  });

  test('422 for a run that is not failed', async () => {
    const runId = insertRun({ status: 'complete', completed_at: new Date().toISOString() });
    const { status } = await post(`/api/bap/v1/runs/${runId}/retry`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() });
    expect(status).toBe(422);
  });

  test('same Idempotency-Key twice does not create two new runs', async () => {
    const runId = insertRun({ status: 'failed', completed_at: new Date().toISOString() });
    const idemKey = generateId();
    const r1 = await post(`/api/bap/v1/runs/${runId}/retry`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': idemKey });
    const r2 = await post(`/api/bap/v1/runs/${runId}/retry`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': idemKey });
    expect(r1.body.run_id).toBe(r2.body.run_id);
  });
});
