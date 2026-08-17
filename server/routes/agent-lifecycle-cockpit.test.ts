/**
 * Coverage for issue #69 — Agent lifecycle cockpit.
 *
 * Runs against a real Express instance mounting the actual agent-status and
 * agents routers (session-authenticated, mirroring routes/connectors-delete.test.ts),
 * so this exercises the same validation/authorization/audit path a real
 * request goes through — not just the underlying functions in isolation.
 *
 * Covers:
 *   - retention verdicts + evidence wired into GET /agents-status/roster,
 *     business-scoped and cross-business isolated
 *   - health derivation on the roster (running / error / stale / paused / retired)
 *   - the "installed/standby vs. verified productive activity" distinction
 *   - failed provisioning (installAgent lands an agent in `pending` / `candidate`
 *     with zero measured evidence)
 *   - POST /agents/:id/retire: validated, authorized, auditable, and its
 *     documented in-flight-work semantics (queued work reassigned, executing
 *     work left alone)
 *   - pause / resume via the existing PATCH /agents/:id
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'agent-lifecycle-cockpit-test-secret';

const { default: db } = await import('../db/db.js');
const { default: agentStatusRouter } = await import('./agent-status.js');
const { default: agentsRouter } = await import('./agents.js');
const { installAgent } = await import('../agents/installer.js');
const { recordInstallation, createTrial, recordTrialOutcome } = await import('../agents/hiring/store.js');

const AGENT_ID = 'cockpit-test-agent';
// Resolved from this file's own location (server/routes/) rather than
// process.cwd(), which varies depending on how `bun test` was invoked (repo
// root vs. server/) — this must always land on server/agents/<id>.
const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agents', AGENT_ID);
const PROFILE_PATH = resolve(AGENT_DIR, 'profile.yaml');
const BIZ_A = 'biz_cockpit_test_a';
const BIZ_B = 'biz_cockpit_test_b';
const USER = 'user_cockpit_test';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function patch(path: string, body: unknown): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function cleanupDb(): void {
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(AGENT_ID);
  db.prepare('DELETE FROM agent_lifecycle_events WHERE agent_id = ?').run(AGENT_ID);
  db.prepare('DELETE FROM audit_log WHERE entity_id = ? OR business_id IN (?, ?)').run(AGENT_ID, BIZ_A, BIZ_B);
  db.prepare('DELETE FROM hiring_trials WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM agent_installations WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare("DELETE FROM agents WHERE id IN (?, 'merchant')").run(AGENT_ID);
  db.prepare('DELETE FROM businesses WHERE id IN (?, ?)').run(BIZ_A, BIZ_B);
}

function ensureAgentRow(status = 'active'): void {
  db.prepare(`
    INSERT INTO agents (id, profile_path, name, status)
    VALUES (?, ?, 'Cockpit Test Agent', ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status
  `).run(AGENT_ID, PROFILE_PATH, status);
}

function insertRun(status: string, startedMinutesAgo: number): void {
  db.prepare(`
    INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, 'test', ?, datetime('now', '-' || ? || ' minutes'))
  `).run(AGENT_ID, BIZ_A, status, startedMinutesAgo);
}

function insertTask(status: string, assignedTo = AGENT_ID): string {
  const id = `task_${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, assigned_to, status)
    VALUES (?, ?, 'Cockpit test task', 'test', ?, ?)
  `).run(id, BIZ_A, assignedTo, status);
  return id;
}

beforeAll(async () => {
  cleanupDb();
  if (existsSync(AGENT_DIR)) rmSync(AGENT_DIR, { recursive: true, force: true });
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(PROFILE_PATH, [
    `id: ${AGENT_ID}`,
    'name: Cockpit Test Agent',
    'avatar: 🧪',
    '',
  ].join('\n'));

  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Cockpit A', 'cockpit-a')`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Cockpit B', 'cockpit-b')`).run(BIZ_B);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    (req.session as any).userId = USER;
    (req.session as any).user = { email: 'tester@example.com', id: USER };
    next();
  });
  app.use('/api/agents-status', agentStatusRouter);
  app.use('/api/agents', agentsRouter);

  await new Promise<void>((resolveListen) => {
    server = app.listen(0, '127.0.0.1', () => resolveListen());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(AGENT_ID);
  db.prepare('DELETE FROM agent_lifecycle_events WHERE agent_id = ?').run(AGENT_ID);
  db.prepare('DELETE FROM audit_log WHERE entity_id = ? OR business_id IN (?, ?)').run(AGENT_ID, BIZ_A, BIZ_B);
  db.prepare('DELETE FROM hiring_trials WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM agent_installations WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
});

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) => server.close((err) => (err ? reject(err) : resolveClose())));
  cleanupDb();
  if (existsSync(AGENT_DIR)) rmSync(AGENT_DIR, { recursive: true, force: true });
});

// ─── Retention wiring on the roster ──────────────────────────────────────────

describe('GET /agents-status/roster — retention wiring (#69)', () => {
  test('surfaces verdict + evidence for an agent with unsuccessful measured trials', async () => {
    ensureAgentRow('active');
    recordInstallation(BIZ_A, AGENT_ID, { installedBy: 'test' });
    const t1 = createTrial(BIZ_A, AGENT_ID, { goal_id: null, signal_id: null, target_metric: 'm', baseline_value: 0, target_value: 1, measurement_window_days: 7, evidence_deliverable: 'x' }, {});
    recordTrialOutcome(BIZ_A, t1, { verdict: 'unsuccessful', costUsd: 3 });
    const t2 = createTrial(BIZ_A, AGENT_ID, { goal_id: null, signal_id: null, target_metric: 'm', baseline_value: 0, target_value: 1, measurement_window_days: 7, evidence_deliverable: 'x' }, {});
    recordTrialOutcome(BIZ_A, t2, { verdict: 'unsuccessful', costUsd: 4, verdictReason: 'did not move the metric' });

    const res = await get(`/api/agents-status/roster?business_id=${BIZ_A}`);
    expect(res.status).toBe(200);
    const entry = res.body.agents.find((a: any) => a.id === AGENT_ID);
    expect(entry).toBeTruthy();
    expect(entry.retention.verdict).toBe('retire');
    expect(entry.retention.evidence.unsuccessful).toBe(2);
    expect(entry.retention.evidence.total_cost_usd).toBe(7);
    expect(entry.retention.evidence.last_verdict).toBe('unsuccessful');
    expect(entry.retention.evidence.last_verdict_reason).toBe('did not move the metric');
    expect(entry.has_verified_outcome).toBe(false);
  });

  test('a successful trial marks the agent as having a verified productive outcome', async () => {
    ensureAgentRow('active');
    recordInstallation(BIZ_A, AGENT_ID, { installedBy: 'test' });
    const t1 = createTrial(BIZ_A, AGENT_ID, { goal_id: null, signal_id: null, target_metric: 'm', baseline_value: 0, target_value: 1, measurement_window_days: 7, evidence_deliverable: 'x' }, {});
    recordTrialOutcome(BIZ_A, t1, { verdict: 'successful', costUsd: 1 });

    const res = await get(`/api/agents-status/roster?business_id=${BIZ_A}`);
    const entry = res.body.agents.find((a: any) => a.id === AGENT_ID);
    expect(entry.retention.verdict).toBe('retain');
    expect(entry.has_verified_outcome).toBe(true);
  });

  test('an installed agent with zero trials reads as standby, not productive', async () => {
    ensureAgentRow('active');
    recordInstallation(BIZ_A, AGENT_ID, { installedBy: 'test' });

    const res = await get(`/api/agents-status/roster?business_id=${BIZ_A}`);
    const entry = res.body.agents.find((a: any) => a.id === AGENT_ID);
    expect(entry.retention.evidence.trials_total).toBe(0);
    expect(entry.has_verified_outcome).toBe(false);
  });

  test('retention never crosses businesses', async () => {
    ensureAgentRow('active');
    recordInstallation(BIZ_A, AGENT_ID, { installedBy: 'test' });
    recordInstallation(BIZ_B, AGENT_ID, { installedBy: 'test' });
    const t1 = createTrial(BIZ_A, AGENT_ID, { goal_id: null, signal_id: null, target_metric: 'm', baseline_value: 0, target_value: 1, measurement_window_days: 7, evidence_deliverable: 'x' }, {});
    recordTrialOutcome(BIZ_A, t1, { verdict: 'unsuccessful' });
    const t2 = createTrial(BIZ_A, AGENT_ID, { goal_id: null, signal_id: null, target_metric: 'm', baseline_value: 0, target_value: 1, measurement_window_days: 7, evidence_deliverable: 'x' }, {});
    recordTrialOutcome(BIZ_A, t2, { verdict: 'unsuccessful' });

    const resA = await get(`/api/agents-status/roster?business_id=${BIZ_A}`);
    const resB = await get(`/api/agents-status/roster?business_id=${BIZ_B}`);
    expect(resA.body.agents.find((a: any) => a.id === AGENT_ID).retention.verdict).toBe('retire');
    // B installed the same agent but has no bad history of its own.
    expect(resB.body.agents.find((a: any) => a.id === AGENT_ID).retention.verdict).not.toBe('retire');
  });

  test('with no business_id, retention is null rather than guessed', async () => {
    ensureAgentRow('active');
    const res = await get('/api/agents-status/roster');
    const entry = res.body.agents.find((a: any) => a.id === AGENT_ID);
    expect(entry.retention).toBeNull();
    expect(entry.has_verified_outcome).toBeNull();
  });
});

// ─── Health derivation on the roster ─────────────────────────────────────────

describe('GET /agents-status/roster — health (#69)', () => {
  test('a currently-running run reports health=running', async () => {
    ensureAgentRow('active');
    insertRun('running', 1);
    const res = await get('/api/agents-status/roster');
    expect(res.body.agents.find((a: any) => a.id === AGENT_ID).health).toBe('running');
  });

  test('3 consecutive failures report health=error', async () => {
    ensureAgentRow('active');
    insertRun('failed', 30);
    insertRun('failed', 20);
    insertRun('failed', 10);
    const res = await get('/api/agents-status/roster');
    expect(res.body.agents.find((a: any) => a.id === AGENT_ID).health).toBe('error');
  });

  test('no run within 2x the poll interval reports health=stale', async () => {
    ensureAgentRow('active');
    insertRun('completed', 24 * 60); // 24h ago — comfortably past the default 60min*2 window
    const res = await get('/api/agents-status/roster');
    expect(res.body.agents.find((a: any) => a.id === AGENT_ID).health).toBe('stale');
  });

  test('a paused agent reports health=paused regardless of run history', async () => {
    ensureAgentRow('paused');
    insertRun('failed', 10);
    const res = await get('/api/agents-status/roster');
    expect(res.body.agents.find((a: any) => a.id === AGENT_ID).health).toBe('paused');
  });

  test('a retired agent reports health=retired', async () => {
    ensureAgentRow('retired');
    const res = await get('/api/agents-status/roster');
    expect(res.body.agents.find((a: any) => a.id === AGENT_ID).health).toBe('retired');
  });
});

// ─── Failed provisioning ──────────────────────────────────────────────────────

describe('failed provisioning surfaces correctly on the cockpit', () => {
  test('an agent hired without its required connector lands pending, with zero evidence', async () => {
    // 'merchant' requires the shopify connector, absent in this test business.
    db.prepare("DELETE FROM agents WHERE id = 'merchant'").run();
    db.prepare("DELETE FROM agent_lifecycle_events WHERE agent_id = 'merchant'").run();
    const result = installAgent('merchant', BIZ_A, 'test');
    expect(result.status).toBe('pending');
    expect(result.lifecycle_state).toBe('candidate');
    expect((result.readiness.missing_required ?? []).length).toBeGreaterThan(0);

    const res = await get(`/api/agents-status/roster?business_id=${BIZ_A}`);
    const entry = res.body.agents.find((a: any) => a.id === 'merchant');
    expect(entry).toBeTruthy();
    expect(entry.health).toBe('pending_hire');
    expect(entry.retention.evidence.trials_total).toBe(0);
    expect(entry.has_verified_outcome).toBe(false);

    db.prepare("DELETE FROM agents WHERE id = 'merchant'").run();
    db.prepare("DELETE FROM agent_lifecycle_events WHERE agent_id = 'merchant'").run();
    db.prepare("DELETE FROM agent_installations WHERE business_id = ? AND agent_id = 'merchant'").run(BIZ_A);
  });
});

// ─── Retire endpoint: validation, authorization, audit, in-flight semantics ──

describe('POST /agents/:id/retire (#69)', () => {
  test('retiring an unknown agent 404s', async () => {
    const res = await post('/api/agents/does-not-exist/retire', {});
    expect(res.status).toBe(404);
  });

  test('retires an active agent: validated + audited transition, excluded from active-roster selection', async () => {
    ensureAgentRow('active');
    const res = await post(`/api/agents/${AGENT_ID}/retire`, { business_id: BIZ_A, reason: 'no verified value' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('retired');
    expect(res.body.lifecycle_state).toBe('archived');

    const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT_ID) as { status: string };
    expect(row.status).toBe('retired');

    // Auditable: a lifecycle event and an audit_log row exist.
    const events = db.prepare('SELECT * FROM agent_lifecycle_events WHERE agent_id = ? AND to_state = ?').all(AGENT_ID, 'archived') as any[];
    expect(events.length).toBeGreaterThan(0);
    const auditRows = db.prepare("SELECT * FROM audit_log WHERE entity_id = ? AND action = 'retire'").all(AGENT_ID) as any[];
    expect(auditRows.length).toBeGreaterThan(0);

    // Prevents new work: every selection query in this codebase gates on
    // status = 'active'; a retired agent must not appear in that set.
    const activeIds = (db.prepare("SELECT id FROM agents WHERE status = 'active'").all() as Array<{ id: string }>).map((r) => r.id);
    expect(activeIds).not.toContain(AGENT_ID);
  });

  test('retiring an already-retired agent 409s (idempotent guard, not a silent no-op)', async () => {
    ensureAgentRow('retired');
    const res = await post(`/api/agents/${AGENT_ID}/retire`, { business_id: BIZ_A });
    expect(res.status).toBe(409);
  });

  test('in-flight semantics: executing work is left to finish, queued work is unassigned for reassignment', async () => {
    ensureAgentRow('active');
    const executingTaskId = insertTask('executing');
    const queuedTaskId = insertTask('approved');

    const res = await post(`/api/agents/${AGENT_ID}/retire`, { business_id: BIZ_A });
    expect(res.status).toBe(200);
    expect(res.body.in_flight_task_ids).toEqual([executingTaskId]);
    expect(res.body.reassigned_task_ids).toEqual([queuedTaskId]);

    const executing = db.prepare('SELECT status, assigned_to FROM tasks WHERE id = ?').get(executingTaskId) as any;
    expect(executing.status).toBe('executing');
    expect(executing.assigned_to).toBe(AGENT_ID);

    const queued = db.prepare('SELECT status, assigned_to FROM tasks WHERE id = ?').get(queuedTaskId) as any;
    expect(queued.status).toBe('proposed');
    expect(queued.assigned_to).toBeNull();
  });
});

// ─── Pause / resume (existing PATCH, regression-covered at the route level) ──

describe('PATCH /agents/:id — pause / resume (#69)', () => {
  test('pauses then resumes an active agent, auditing each transition', async () => {
    ensureAgentRow('active');

    const paused = await patch(`/api/agents/${AGENT_ID}`, { status: 'paused' });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');

    const resumed = await patch(`/api/agents/${AGENT_ID}`, { status: 'active' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('active');

    const auditRows = db.prepare("SELECT action FROM audit_log WHERE entity_id = ? AND entity_type = 'agent'").all(AGENT_ID) as Array<{ action: string }>;
    expect(auditRows.length).toBeGreaterThanOrEqual(2);
  });

  test('PATCH rejects "retired" — retirement must go through the dedicated, audited endpoint', async () => {
    ensureAgentRow('active');
    const res = await patch(`/api/agents/${AGENT_ID}`, { status: 'retired' });
    expect(res.status).toBe(400);
  });
});
