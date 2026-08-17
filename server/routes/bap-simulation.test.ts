/**
 * Safe simulation/preview mode over BAP (issue #86) — server/routes/bap-simulation.ts,
 * exercised against a real Express instance mounting the actual router.
 *
 * The load-bearing property is the same one #67's own tests prove for the
 * dashboard route, extended to this one: a task-approval preview produces
 * ZERO real side effects, provable both structurally (the guard the route
 * runs through) and behaviourally (row counts across every operational
 * table are asserted unchanged before/after the call, not merely "the
 * response looked read-only"). Permission gating (both `simulations:read`
 * AND `tasks:approve`), business-access scoping, not-found handling, and a
 * policy-blocked preview surfacing its block rather than silently
 * succeeding are covered alongside it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.ts';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapSimulationRouter from './bap-simulation.ts';
import { createTask } from '../tasks/task-queue.ts';
import { savePolicyVersion } from '../policy/operating-policy.ts';

const BIZ_A = 'biz_bap_sim_a';
const BIZ_B = 'biz_bap_sim_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyFull: string;      // scoped to BIZ_A, holds simulations:read + tasks:approve
let keyNoSim: string;     // scoped to BIZ_A, holds tasks:approve but NOT simulations:read
let keyNoApprove: string; // scoped to BIZ_A, holds simulations:read but NOT tasks:approve
let keyB: string;         // scoped to BIZ_B, holds simulations:read + tasks:approve

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Every table a real approval could write to, scoped to one business. */
const OPERATIONAL_TABLES = ['tasks', 'execution_jobs', 'action_receipts', 'notifications', 'system_issues', 'decisions'];

function operationalCounts(businessId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of OPERATIONAL_TABLES) {
    out[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id = ?`).get(businessId) as { n: number }).n;
  }
  return out;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Sim A', 'bap-sim-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Sim B', 'bap-sim-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  for (const id of ['agt_sim_full', 'agt_sim_nosim', 'agt_sim_noapprove', 'agt_sim_b']) {
    db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);
  }
  keyFull = generateApiKey();
  keyNoSim = generateApiKey();
  keyNoApprove = generateApiKey();
  keyB = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_sim_full', 'Sim Agent Full', await hashApiKey(keyFull), keyPrefix(keyFull), JSON.stringify(['simulations:read', 'tasks:approve', 'tasks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_sim_nosim', 'Sim Agent No-Sim-Grant', await hashApiKey(keyNoSim), keyPrefix(keyNoSim), JSON.stringify(['tasks:approve', 'tasks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_sim_noapprove', 'Sim Agent No-Approve-Grant', await hashApiKey(keyNoApprove), keyPrefix(keyNoApprove), JSON.stringify(['simulations:read', 'tasks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_sim_b', 'Sim Agent B', await hashApiKey(keyB), keyPrefix(keyB), JSON.stringify(['simulations:read', 'tasks:approve']), JSON.stringify([BIZ_B]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapSimulationRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM simulation_previews WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM operating_policies WHERE scope_key = ?`).run(BIZ_A);
  db.prepare(`DELETE FROM operating_policy_events WHERE scope_key = ?`).run(BIZ_A);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_sim_full', 'agt_sim_nosim', 'agt_sim_noapprove', 'agt_sim_b')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_sim_full', 'agt_sim_nosim', 'agt_sim_noapprove', 'agt_sim_b')`).run();
});

function makeManualTask(businessId: string, title: string) {
  return createTask({
    business_id: businessId, title, proposed_by: 'test:bap-sim',
    action_type: null, action_payload: {},
  })!;
}

/**
 * createTask() kicks off its own fire-and-forget "cost of inaction"
 * enrichment (task-queue.ts) that later back-fills `description` — nothing
 * to do with simulation, but a real HTTP round trip (unlike an in-process
 * call) leaves enough wall-clock time for it to land mid-test and look like
 * a side effect OF the preview. Settling it before taking a baseline snapshot
 * isolates what the simulate call itself changed, which is what these tests
 * are actually about.
 */
async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('simulations:read grant', () => {
  test('is offered as a grantable permission', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('simulations:read');
  });

  test('an unauthenticated request is rejected outright', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`, { task_id: 'anything' });
    expect(status).toBe(401);
  });
});

describe('POST /businesses/:id/simulate/task-approval — permission gating', () => {
  test('requires simulations:read even when the agent holds tasks:approve', async () => {
    const task = makeManualTask(BIZ_A, 'Denied without simulations:read');
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`,
      { task_id: task.id },
      { 'BAP-Key': keyNoSim },
    );
    expect(status).toBe(403);
    expect(body.error).toMatch(/simulations:read/);
  });

  test('requires tasks:approve even when the agent holds simulations:read — a preview cannot probe an action the agent could not otherwise approve', async () => {
    const task = makeManualTask(BIZ_A, 'Denied without tasks:approve');
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`,
      { task_id: task.id },
      { 'BAP-Key': keyNoApprove },
    );
    expect(status).toBe(403);
    expect(body.error).toMatch(/tasks:approve/);
  });

  test('an agent scoped to business B cannot simulate a business A task', async () => {
    const task = makeManualTask(BIZ_A, 'Denied cross-business');
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`,
      { task_id: task.id },
      { 'BAP-Key': keyB },
    );
    expect(status).toBe(403);
  });
});

describe('POST /businesses/:id/simulate/task-approval — not found', () => {
  test('an unknown task_id is a 404', async () => {
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`,
      { task_id: 'does-not-exist' },
      { 'BAP-Key': keyFull },
    );
    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
  });

  test('a task belonging to a different business is a 404, not a cross-tenant leak', async () => {
    const task = makeManualTask(BIZ_B, 'Belongs to B');
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`,
      { task_id: task.id },
      { 'BAP-Key': keyFull },
    );
    expect(status).toBe(404);
  });

  test('task_id is required', async () => {
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`, {}, { 'BAP-Key': keyFull });
    expect(status).toBe(400);
    expect(body.code).toBe('validation_error');
  });
});

describe('POST /businesses/:id/simulate/task-approval — a successful preview, with zero real side effects', () => {
  test('returns the full envelope, evaluated as this agent\'s own approval', async () => {
    const task = makeManualTask(BIZ_A, 'Would approve cleanly');
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`,
      { task_id: task.id },
      { 'BAP-Key': keyFull },
    );
    expect(status).toBe(200);
    expect(body.kind).toBe('task_approval');
    expect(body.actor).toBe('bap:agt_sim_full');
    expect(body.detail.would_approve).toBe(true);
    expect(body.detail.task_id).toBe(task.id);
    expect(Array.isArray(body.planned_changes)).toBe(true);
    expect(body.planned_changes.length).toBeGreaterThan(0);
    expect(Array.isArray(body.skipped_work)).toBe(true);
    expect(body.data_freshness.length).toBeGreaterThan(0);
    expect(body.assumptions.length).toBeGreaterThan(0);
    expect(body.unsupported_operations.length).toBeGreaterThan(0);
    expect(body.side_effects_performed).toBe('none');
    expect(body.blocked_side_effects).toEqual([]);
    expect(body.preview_id).toBeTruthy();
    // No execute-from-preview route exists over BAP — see the router's
    // docstring for why. The envelope must say so rather than imply one.
    expect(body.executable).toBe(false);
  });

  test('creates zero rows in tasks, execution_jobs, receipts, notifications, system_issues or decisions', async () => {
    const task = makeManualTask(BIZ_A, 'Zero side effects sweep');
    await settle();
    const before = operationalCounts(BIZ_A);
    // tasks was just incremented by makeManualTask's own real write — capture
    // the exact row, not just the count, to prove the PREVIEW itself changes nothing.
    const taskRowBefore = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);

    await post(`/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`, { task_id: task.id }, { 'BAP-Key': keyFull });
    await post(`/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`, { task_id: task.id }, { 'BAP-Key': keyFull });

    const after = operationalCounts(BIZ_A);
    expect(after.tasks).toBe(before.tasks);
    expect(after.execution_jobs).toBe(before.execution_jobs);
    expect(after.action_receipts).toBe(before.action_receipts);
    expect(after.notifications).toBe(before.notifications);
    expect(after.system_issues).toBe(before.system_issues);
    expect(after.decisions).toBe(before.decisions);
    expect(before.execution_jobs).toBe(0);
    expect(before.action_receipts).toBe(0);

    const taskRowAfter = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    expect(taskRowAfter).toEqual(taskRowBefore);
  });

  test('the only rows produced are the stored preview and its own audit-log entry', async () => {
    const task = makeManualTask(BIZ_A, 'Audit sweep');
    const auditBefore = (db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE business_id = ? AND action NOT LIKE 'simulation.%'",
    ).get(BIZ_A) as { n: number }).n;
    const previewsBefore = (db.prepare('SELECT COUNT(*) AS n FROM simulation_previews WHERE business_id = ?').get(BIZ_A) as { n: number }).n;

    const { body } = await post(`/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`, { task_id: task.id }, { 'BAP-Key': keyFull });

    const auditAfter = (db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE business_id = ? AND action NOT LIKE 'simulation.%'",
    ).get(BIZ_A) as { n: number }).n;
    const previewsAfter = (db.prepare('SELECT COUNT(*) AS n FROM simulation_previews WHERE business_id = ?').get(BIZ_A) as { n: number }).n;

    expect(auditAfter).toBe(auditBefore); // no approve/reject/etc. audit rows
    expect(previewsAfter).toBe(previewsBefore + 1);
    expect(body.preview_id).toBeTruthy();
  });
});

describe('a policy-blocked approval is surfaced, not silently allowed', () => {
  test('when the operating policy disables autonomous execution, the preview reports would_approve: false and names the blocker', async () => {
    savePolicyVersion({
      key: BIZ_A, actor: 'test:setup',
      patch: { autonomy: { allow_autonomous_execution: false } },
    });

    const task = makeManualTask(BIZ_A, 'Blocked by operating policy');
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`,
      { task_id: task.id },
      { 'BAP-Key': keyFull },
    );

    // The HTTP call itself still succeeds — a refusal is a FINDING the
    // preview reports, not an error simulating it.
    expect(status).toBe(200);
    expect(body.detail.would_approve).toBe(false);
    expect(body.detail.blockers.some((b: { gate: string }) => b.gate === 'operating_policy_autonomy')).toBe(true);
    expect(body.detail.execution_route).toBe('blocked');
    expect(body.skipped_work.some((s: { kind: string }) => s.kind === 'task.approve')).toBe(true);
    // And, of course, nothing was actually approved.
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(row.status).toBe('proposed');

    db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(BIZ_A);
    db.prepare('DELETE FROM operating_policy_events WHERE scope_key = ?').run(BIZ_A);
  });
});

describe('GET /simulations/:id — read back a preview with a live currency check', () => {
  test('an authorized agent can read back its own preview, current and not yet consumed', async () => {
    const task = makeManualTask(BIZ_A, 'Read back cleanly');
    const created = await post(`/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`, { task_id: task.id }, { 'BAP-Key': keyFull });
    const previewId = created.body.preview_id as string;

    const { status, body } = await get(`/api/bap/v1/simulations/${previewId}`, { 'BAP-Key': keyFull });
    expect(status).toBe(200);
    expect(body.preview.id).toBe(previewId);
    expect(body.preview.kind).toBe('task_approval');
    expect(body.currency.current).toBe(true);
    expect(body.currency.expired).toBe(false);
    expect(body.currency.consumed).toBe(false);
    expect(body.currency.drift).toEqual([]);
  });

  test('an unknown preview id is a 404', async () => {
    const { status } = await get('/api/bap/v1/simulations/does-not-exist', { 'BAP-Key': keyFull });
    expect(status).toBe(404);
  });

  test('an agent scoped to business B cannot read business A\'s preview', async () => {
    const task = makeManualTask(BIZ_A, 'Not for business B');
    const created = await post(`/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`, { task_id: task.id }, { 'BAP-Key': keyFull });
    const previewId = created.body.preview_id as string;

    const { status } = await get(`/api/bap/v1/simulations/${previewId}`, { 'BAP-Key': keyB });
    expect(status).toBe(403);
  });

  test('a preview whose task changed since is flagged as drifted, not silently trusted', async () => {
    const task = makeManualTask(BIZ_A, 'Will drift');
    const created = await post(`/api/bap/v1/businesses/${BIZ_A}/simulate/task-approval`, { task_id: task.id }, { 'BAP-Key': keyFull });
    const previewId = created.body.preview_id as string;

    db.prepare("UPDATE tasks SET title = 'Changed after preview', updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?").run(task.id);

    const { body } = await get(`/api/bap/v1/simulations/${previewId}`, { 'BAP-Key': keyFull });
    expect(body.currency.current).toBe(false);
    expect(body.currency.drift.length).toBeGreaterThan(0);
    expect(body.currency.note).toMatch(/changed/i);
  });
});
