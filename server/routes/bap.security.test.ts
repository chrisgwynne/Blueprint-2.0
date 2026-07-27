/**
 * End-to-end regression tests for the Phase 0 BAP security fixes, run
 * against a real (locally-bound, random-port) Express instance mounting
 * the actual bap router — not mocks. Covers:
 *
 *   F-01 — unauthenticated self-registration must be rejected, and even
 *          an authorized registration can never self-grant a wildcard
 *          permission or wildcard business_access.
 *   F-03 — PATCH /signals/:id and PATCH /tasks/:id must not allow an
 *          agent scoped to business A to mutate business B's rows.
 *   F-04 — GET /runs/:id must not leak another business's run data to an
 *          agent with no access to that business.
 *   F-07 — GET /businesses/:id/agents must not leak another business's
 *          aggregate agent run-count/cost.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from '../bap/auth.ts';
import bapRouter from './bap.ts';

const BIZ_A = 'biz_bap_sec_a';
const BIZ_B = 'biz_bap_sec_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string; // scoped to BIZ_A only, full permission set
let runIdB: string;
let runIdA: string;
let taskIdB: string;
let signalIdB: string;

interface TestResponse {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper, response shape varies per route
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function patch(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Sec A', 'bap-sec-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Sec B', 'bap-sec-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  // Agent A: full permission set, scoped ONLY to business A. Delete then
  // re-insert (rather than INSERT OR IGNORE) so a rerun against a
  // non-fresh DB gets the freshly-generated key, not a stale one.
  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_test_a'`).run();
  keyA = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Test Agent A', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run(
    'agt_test_a', await hashApiKey(keyA), keyPrefix(keyA),
    JSON.stringify(['signals:read', 'signals:create', 'tasks:read', 'tasks:propose', 'tasks:approve', 'agents:read']),
    JSON.stringify([BIZ_A])
  );

  // agent_runs.agent_id has a FK to agents(id) — seed the shared
  // 'conductor' template row (idempotent) before inserting runs against it.
  db.prepare(`
    INSERT INTO agents (id, profile_path, name, status, created_at)
    VALUES ('conductor', 'server/agents/conductor/profile.yaml', 'Conductor', 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `).run();

  // Fixture data that belongs to business B — agent A must never be able
  // to read or mutate any of this.
  runIdB = generateId();
  db.prepare(`
    INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, reasoning, cost_usd, started_at)
    VALUES (?, 'conductor', ?, 'manual', 'complete', 'sensitive business-B reasoning', 1.23, CURRENT_TIMESTAMP)
  `).run(runIdB, BIZ_B);

  taskIdB = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, created_at)
    VALUES (?, ?, 'Business B private task', 'test', 'proposed', 'yellow', 'requires_approval', CURRENT_TIMESTAMP)
  `).run(taskIdB, BIZ_B);

  signalIdB = generateId();
  db.prepare(`
    INSERT INTO signals (id, business_id, rule_id, type, severity, title, status, created_at)
    VALUES (?, ?, 'test_rule', 'anomaly', 'warning', 'Business B private signal', 'open', CURRENT_TIMESTAMP)
  `).run(signalIdB, BIZ_B);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();

  // This test suite is the only one that inserts agent_runs rows against
  // the shared 'conductor' agents-table row. Other test files' fixtures
  // (e.g. agentLifecycle.test.ts) do `DELETE FROM agents` between tests —
  // leaving our agent_runs rows behind would make that fail on a foreign
  // key violation when those files run later in the same process.
  db.prepare('DELETE FROM agent_runs WHERE id IN (?, ?)').run(runIdB, runIdA ?? '');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskIdB);
  db.prepare('DELETE FROM signals WHERE id = ?').run(signalIdB);
  // bapAuth's audit logging (bap_audit) FK-references bap_agents — clear
  // the child rows before the agent row itself.
  db.prepare(`DELETE FROM bap_audit WHERE agent_id = 'agt_test_a'`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_test_a'`).run();
});

describe('F-01 — POST /register requires authorization', () => {
  test('an unauthenticated request is rejected outright', async () => {
    const { status } = await post('/api/bap/v1/register', {
      name: 'AttackerAgent',
      requested_permissions: ['*:*'],
      business_access: ['*'],
    });
    expect(status).toBe(401);
  });

  test('reproduces the audit PoC and confirms it is now blocked: no api_key is issued', async () => {
    const { status, body } = await post('/api/bap/v1/register', {
      name: 'AuditPoC',
      requested_permissions: ['*:*'],
      business_access: ['*'],
    });
    expect(status).toBe(401);
    expect(body?.api_key).toBeUndefined();
  });

  test('even a valid X-Registration-Secret cannot self-grant a wildcard permission or business access', async () => {
    const prev = process.env.BAP_REGISTRATION_SECRET;
    process.env.BAP_REGISTRATION_SECRET = 'test-registration-secret';
    try {
      const { status, body } = await post(
        '/api/bap/v1/register',
        { name: 'TrustedButBounded', requested_permissions: ['*:*', 'signals:read'], business_access: ['*', BIZ_A] },
        { 'X-Registration-Secret': 'test-registration-secret' }
      );
      expect(status).toBe(201);
      expect(body.permissions).toEqual(['signals:read']);
      expect(body.business_access).toEqual([BIZ_A]);
      expect(body.api_key).toStartWith('bap_');
    } finally {
      if (prev === undefined) delete process.env.BAP_REGISTRATION_SECRET;
      else process.env.BAP_REGISTRATION_SECRET = prev;
    }
  });
});

describe('F-03 — cross-tenant IDOR on PATCH /signals/:id and PATCH /tasks/:id', () => {
  test('an agent scoped to business A cannot approve a business-B task', async () => {
    const { status } = await patch(`/api/bap/v1/tasks/${taskIdB}`, { action: 'approve' }, { 'BAP-Key': keyA });
    expect(status).toBe(403);

    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskIdB) as { status: string };
    expect(row.status).toBe('proposed'); // unchanged
  });

  test('an agent scoped to business A cannot resolve a business-B signal', async () => {
    const { status } = await patch(`/api/bap/v1/signals/${signalIdB}`, { status: 'resolved' }, { 'BAP-Key': keyA });
    expect(status).toBe(403);

    const row = db.prepare('SELECT status FROM signals WHERE id = ?').get(signalIdB) as { status: string };
    expect(row.status).toBe('open'); // unchanged
  });
});

describe('F-04 — GET /runs/:id no longer leaks cross-tenant data', () => {
  test('an agent scoped to business A cannot read business B\'s run', async () => {
    const { status, body } = await get(`/api/bap/v1/runs/${runIdB}`, { 'BAP-Key': keyA });
    expect(status).toBe(403);
    expect(body?.reasoning).toBeUndefined();
    expect(body?.cost_usd).toBeUndefined();
  });
});

describe('F-07 — GET /businesses/:id/agents no longer leaks cross-tenant aggregates', () => {
  test('the response for business A does not include business B\'s run against the same agent template', async () => {
    // Attribute a run to the shared 'conductor' agent template under
    // business A too, so we can prove the counts returned are scoped to
    // A and don't include B's run recorded in beforeAll.
    db.prepare(`
      INSERT INTO agents (id, profile_path, name, status, created_at)
      VALUES ('conductor', 'server/agents/conductor/profile.yaml', 'Conductor', 'active', CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO NOTHING
    `).run();
    runIdA = generateId();
    db.prepare(`
      INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, cost_usd, started_at)
      VALUES (?, 'conductor', ?, 'manual', 'complete', 0.5, CURRENT_TIMESTAMP)
    `).run(runIdA, BIZ_A);

    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/agents`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    const conductor = (body.agents as Array<{ id: string; run_count: number }>).find((a) => a.id === 'conductor');
    expect(conductor).toBeDefined();
    // Business A has exactly 1 run recorded against conductor. If B's run
    // leaked in, this would be 2.
    expect(conductor!.run_count).toBe(1);
  });
});
