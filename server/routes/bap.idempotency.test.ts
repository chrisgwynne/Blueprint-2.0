/**
 * End-to-end regression tests for Phase 1's BAP-level idempotency wiring
 * (server/routes/bap.ts's withRequiredIdempotency, backed by
 * server/lib/idempotency.ts), run against a real Express instance mounting
 * the actual bap router. Covers two of the Phase 1 exit criteria directly:
 *
 *   - "an agent proposes the same task 10 times with the same
 *     Idempotency-Key -> exactly 1 task is created"
 *   - "a reused Idempotency-Key with a different payload -> 409"
 *
 * and the precondition every other mutating endpoint shares: no
 * Idempotency-Key header -> 400, not a silent unprotected write.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from '../bap/auth.ts';
import bapRouter from './bap.ts';

const BIZ = 'biz_bap_idem_test';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let key: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'BAP-Key': key, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Idem Test', 'bap-idem-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);

  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_idem_e2e'`).run();
  key = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Idempotency Test Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run(
    'agt_idem_e2e', await hashApiKey(key), keyPrefix(key),
    JSON.stringify(['tasks:propose', 'tasks:read', 'signals:create']),
    JSON.stringify([BIZ])
  );

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRouter);

  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id = 'agt_idem_e2e'`).run();
  // POST /tasks fires createTaskEvent() for every proposal (task_events.task_id
  // FK-references tasks(id), NOT NULL) — clear child rows before the parents.
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM signals WHERE business_id = ?`).run(BIZ);
  // bapAuth's audit logging (bap_audit) FK-references bap_agents — clear
  // the child rows before the agent row itself (same pattern as
  // bap.security.test.ts).
  db.prepare(`DELETE FROM bap_audit WHERE agent_id = 'agt_idem_e2e'`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_idem_e2e'`).run();
});

describe('POST /businesses/:id/tasks requires Idempotency-Key', () => {
  test('a request with no Idempotency-Key header is rejected with 400, and no task is created', async () => {
    const before = (db.prepare('SELECT COUNT(*) as n FROM tasks WHERE business_id = ?').get(BIZ) as { n: number }).n;
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ}/tasks`, { title: 'Should not be created' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Idempotency-Key/);
    const after = (db.prepare('SELECT COUNT(*) as n FROM tasks WHERE business_id = ?').get(BIZ) as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('Phase 1 exit criterion — duplicate proposal dedup', () => {
  test('proposing the same task 10 times in a row with the same Idempotency-Key creates exactly 1 task', async () => {
    // Sequential, not parallel: this models the real failure mode an
    // autonomous caller retries against — "the response was lost/timed
    // out, so try again" — where each retry only starts once the previous
    // attempt has resolved. (A genuinely concurrent double-send, covered
    // separately below, is a different — and correctly distinct — case:
    // withIdempotency reports 409/in-progress for a request that arrives
    // while an identical one is still being handled, rather than
    // guessing at a response that doesn't exist yet.)
    const idempotencyKey = generateId();
    const payload = { title: 'Duplicate-prone proposal', action_type: 'kb_write', action_payload: { note: 'x' } };

    const responses: TestResponse[] = [];
    for (let i = 0; i < 10; i++) {
      responses.push(await post(`/api/bap/v1/businesses/${BIZ}/tasks`, payload, { 'Idempotency-Key': idempotencyKey }));
    }

    for (const r of responses) {
      expect(r.status).toBe(201);
      expect(r.body.task_id).toBeTruthy();
    }
    const taskIds = new Set(responses.map((r) => r.body.task_id));
    expect(taskIds.size).toBe(1); // every retry got back the SAME task_id

    const count = (db.prepare(
      `SELECT COUNT(*) as n FROM tasks WHERE business_id = ? AND title = 'Duplicate-prone proposal'`
    ).get(BIZ) as { n: number }).n;
    expect(count).toBe(1); // exactly one row actually exists
  });

  test('firing the same proposal concurrently never produces two different task_ids or two rows, regardless of interleaving', async () => {
    // Real interleaving between requests hitting the same in-process
    // synchronous SQLite claim is exercised deterministically at the unit
    // level (lib/idempotency.test.ts's "in_progress" test, using an
    // explicit gate). At the HTTP layer this only asserts the invariant
    // that must hold no matter how the 5 requests happen to interleave:
    // every response is either the created result or a clear 409 (never a
    // second distinct task), and only one row ever lands in the DB.
    const idempotencyKey = generateId();
    const payload = { title: 'Concurrent-duplicate proposal' };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => post(`/api/bap/v1/businesses/${BIZ}/tasks`, payload, { 'Idempotency-Key': idempotencyKey }))
    );

    for (const r of responses) expect([201, 409]).toContain(r.status);
    const created = responses.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    const taskIds = new Set(created.map((r) => r.body.task_id));
    expect(taskIds.size).toBe(1); // never two different task_ids from the same key

    const count = (db.prepare(
      `SELECT COUNT(*) as n FROM tasks WHERE business_id = ? AND title = 'Concurrent-duplicate proposal'`
    ).get(BIZ) as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('Phase 1 exit criterion — reused key with a different payload', () => {
  test('the same Idempotency-Key reused for a different task payload is rejected with 409, and no second task is created', async () => {
    const idempotencyKey = generateId();
    const first = await post(`/api/bap/v1/businesses/${BIZ}/tasks`, { title: 'Original proposal' }, { 'Idempotency-Key': idempotencyKey });
    expect(first.status).toBe(201);

    const second = await post(`/api/bap/v1/businesses/${BIZ}/tasks`, { title: 'A completely different proposal' }, { 'Idempotency-Key': idempotencyKey });
    expect(second.status).toBe(409);

    const count = (db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE business_id = ? AND title = 'A completely different proposal'`).get(BIZ) as { n: number }).n;
    expect(count).toBe(0);
  });
});

describe('Idempotency-Key scoping', () => {
  test('the same key is safe to reuse across different endpoints (signals vs tasks) without cross-contamination', async () => {
    const idempotencyKey = generateId();
    const taskRes = await post(`/api/bap/v1/businesses/${BIZ}/tasks`, { title: 'Cross-scope task' }, { 'Idempotency-Key': idempotencyKey });
    const signalRes = await post(
      `/api/bap/v1/businesses/${BIZ}/signals`,
      { type: 'anomaly', severity: 'warning', title: 'Cross-scope signal' },
      { 'Idempotency-Key': idempotencyKey }
    );
    expect(taskRes.status).toBe(201);
    expect(signalRes.status).toBe(201);
    expect(taskRes.body.task_id).toBeTruthy();
    expect(signalRes.body.signal_id).toBeTruthy();
  });
});
