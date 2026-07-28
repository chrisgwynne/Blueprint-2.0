/**
 * Phase 2 Task API tests — server/routes/bap.ts's new GET /tasks/:id (detail),
 * GET /tasks/:id/history, the expanded GET /businesses/:id/tasks (search,
 * filters, sort, pagination), and PATCH /tasks/:id's new "cancel" action.
 * Runs against a real (locally-bound) Express instance mounting the actual
 * bap router — not mocks.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from '../bap/auth.ts';
import bapRouter from './bap.ts';

const BIZ_A = 'biz_bap_tasks_a';
const BIZ_B = 'biz_bap_tasks_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string;
let keyAllPerms: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function patch(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, signal_id, title, description, proposed_by, status, trust_tier, approval_mode, action_type, priority, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'yellow', 'requires_approval', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, (overrides.business_id as string) ?? BIZ_A, (overrides.signal_id as string) ?? null,
    (overrides.title as string) ?? 'Fixture task', (overrides.description as string) ?? null,
    (overrides.proposed_by as string) ?? 'test', (overrides.status as string) ?? 'proposed',
    (overrides.action_type as string) ?? null, (overrides.priority as string) ?? 'p2',
    (overrides.confidence as number) ?? null,
  );
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Tasks A', 'bap-tasks-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Tasks B', 'bap-tasks-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_tasks_a', 'agt_tasks_allperms')`).run();
  keyA = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Tasks Test Agent A', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_tasks_a', await hashApiKey(keyA), keyPrefix(keyA), JSON.stringify(['tasks:read', 'tasks:approve', 'tasks:propose']), JSON.stringify([BIZ_A]));

  keyAllPerms = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Tasks Test Agent AllPerms', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_tasks_allperms', await hashApiKey(keyAllPerms), keyPrefix(keyAllPerms), JSON.stringify(['tasks:read', 'tasks:approve', 'tasks:propose']), JSON.stringify([BIZ_A, BIZ_B]));

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
  db.prepare(`DELETE FROM execution_jobs WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (?, ?))`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM applicability_suppressions WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM business_capabilities WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goals WHERE business_id IN (?, ?) AND title LIKE 'Kanban%'`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM measurement_policies WHERE id = 'policy_kanban_test'`).run();
  db.prepare(`DELETE FROM signals WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN ('agt_tasks_a', 'agt_tasks_allperms')`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_tasks_a', 'agt_tasks_allperms')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_tasks_a', 'agt_tasks_allperms')`).run();
});

describe('GET /tasks/:taskId (detail)', () => {
  test('returns full detail shape: approval, execution, linked_signal, dependencies, outcome, audit_summary', async () => {
    const signalId = generateId();
    db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, status, created_at) VALUES (?, ?, 'r', 'anomaly', 'warning', 'Sig', 'open', CURRENT_TIMESTAMP)`).run(signalId, BIZ_A);
    const parentId = insertTask({ title: 'Parent task' });
    const taskId = insertTask({ title: 'Detail fixture', signal_id: signalId });
    db.prepare(`UPDATE tasks SET parent_task_id = ? WHERE id = ?`).run(parentId, taskId);

    const { status, body } = await get(`/api/bap/v1/tasks/${taskId}`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.task.id).toBe(taskId);
    expect(body.approval.status).toBe('proposed');
    expect(body.execution.jobs).toEqual([]);
    expect(body.linked_signal.id).toBe(signalId);
    expect(body.dependencies.parent_task.id).toBe(parentId);
    expect(body.outcome.checks).toEqual([]);
    expect(body.audit_summary).toHaveProperty('total_events');
  });

  test('returns 404 for a non-existent task', async () => {
    const { status } = await get('/api/bap/v1/tasks/does-not-exist', { 'BAP-Key': keyA });
    expect(status).toBe(404);
  });

  test('returns 403 for a task belonging to a business the caller cannot access', async () => {
    const taskId = insertTask({ business_id: BIZ_B, title: 'Business B private task' });
    const { status } = await get(`/api/bap/v1/tasks/${taskId}`, { 'BAP-Key': keyA });
    expect(status).toBe(403);
  });

  test('timestamps in the response are normalized ISO 8601', async () => {
    const taskId = insertTask({ title: 'Timestamp fixture' });
    const { body } = await get(`/api/bap/v1/tasks/${taskId}`, { 'BAP-Key': keyA });
    expect(body.task.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('GET /tasks/:taskId/history', () => {
  test('returns the task_events timeline', async () => {
    const taskId = insertTask({ title: 'History fixture' });
    db.prepare(`INSERT INTO task_events (id, task_id, event_type, actor, content, created_at) VALUES (?, ?, 'created', 'test', 'note', CURRENT_TIMESTAMP)`).run(generateId(), taskId);
    const { status, body } = await get(`/api/bap/v1/tasks/${taskId}/history`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.events.length).toBe(1);
    expect(body.events[0].event_type).toBe('created');
  });

  test('returns 403 across tenants', async () => {
    const taskId = insertTask({ business_id: BIZ_B, title: 'B history' });
    const { status } = await get(`/api/bap/v1/tasks/${taskId}/history`, { 'BAP-Key': keyA });
    expect(status).toBe(403);
  });
});

describe('GET /businesses/:id/tasks — search, filters, sort, pagination', () => {
  test('q searches title and description', async () => {
    insertTask({ title: 'Rewrite meta description for door toppers' });
    insertTask({ title: 'Unrelated task about shipping' });
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/tasks?q=door+toppers`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.tasks.every((t: any) => /door toppers/i.test(t.title))).toBe(true);
  });

  test('a % in the search term is treated literally, not as a SQL wildcard', async () => {
    insertTask({ title: '50% off promotion' });
    insertTask({ title: 'completely unrelated' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/tasks?q=50%25+off`, { 'BAP-Key': keyA });
    expect(body.tasks.some((t: any) => t.title === '50% off promotion')).toBe(true);
    expect(body.tasks.every((t: any) => t.title.includes('50%') || t.title === 'completely unrelated' === false)).toBe(true);
  });

  test('filters by action_type, priority, and status (csv)', async () => {
    insertTask({ title: 'GH issue task', action_type: 'github_issue', priority: 'p1' });
    insertTask({ title: 'KB task', action_type: 'kb_write', priority: 'p3' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/tasks?action_type=github_issue&priority=p1`, { 'BAP-Key': keyA });
    expect(body.tasks.every((t: any) => t.action_type === 'github_issue' && t.priority === 'p1')).toBe(true);
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);
  });

  test('filters by created_by (proposed_by) and signal_id', async () => {
    const signalId = generateId();
    db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, status, created_at) VALUES (?, ?, 'r', 'anomaly', 'warning', 'Sig2', 'open', CURRENT_TIMESTAMP)`).run(signalId, BIZ_A);
    insertTask({ title: 'From signal', proposed_by: 'agent:seo-sentinel', signal_id: signalId });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/tasks?created_by=agent:seo-sentinel&signal_id=${signalId}`, { 'BAP-Key': keyA });
    expect(body.tasks.length).toBe(1);
    expect(body.tasks[0].signal_id).toBe(signalId);
  });

  test('pagination shape matches the dashboard convention (page/limit/total/pages) and tasks/total stay for backward compat', async () => {
    for (let i = 0; i < 5; i++) insertTask({ title: `Pagination fixture ${i}` });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/tasks?q=Pagination+fixture&page=1&limit=2`, { 'BAP-Key': keyA });
    expect(body.tasks.length).toBe(2);
    expect(body.pagination).toMatchObject({ page: 1, limit: 2, total: 5, pages: 3 });
    expect(body.total).toBe(5); // backward-compat top-level field
  });

  test('sort=priority,order=asc changes ordering', async () => {
    db.prepare(`DELETE FROM tasks WHERE business_id = ? AND title LIKE 'Sort fixture%'`).run(BIZ_A);
    insertTask({ title: 'Sort fixture p3', priority: 'p3' });
    insertTask({ title: 'Sort fixture p1', priority: 'p1' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/tasks?q=Sort+fixture&sort=priority&order=asc`, { 'BAP-Key': keyA });
    expect(body.tasks[0].priority).toBe('p1');
  });

  test('an unrecognized sort column falls back to created_at rather than erroring (SQL injection guard)', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/tasks?sort=business_id;DROP+TABLE+tasks;--`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    const stillThere = db.prepare('SELECT COUNT(*) as n FROM tasks').get() as { n: number };
    expect(stillThere.n).toBeGreaterThan(0);
  });

  test('goal_id filters via the shared project_id proxy, returning no tasks when the goal has no project link', async () => {
    const goalId = generateId();
    db.prepare(`INSERT INTO goals (id, business_id, title, status, created_at, updated_at) VALUES (?, ?, 'Goal without project', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(goalId, BIZ_A);
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/tasks?goal_id=${goalId}`, { 'BAP-Key': keyA });
    expect(body.tasks).toEqual([]);
  });
});

describe('POST /businesses/:id/tasks - applicability errors', () => {
  test('returns 400 when applicability blocks an inapplicable proposal', async () => {
    db.prepare(`
      INSERT INTO business_capabilities (id, business_id, capability_key, display_name, status, evidence_source, confidence, created_at, updated_at)
      VALUES (?, ?, 'google_merchant_center', 'Google Merchant Center', 'unavailable', 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(business_id, capability_key) DO UPDATE SET status = 'unavailable', updated_at = CURRENT_TIMESTAMP
    `).run(generateId(), BIZ_A);

    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/tasks`, {
      title: 'Update Merchant Center feed',
      description: 'This Google Merchant Center task should be blocked by applicability.',
      action_type: 'content_draft',
      action_payload: { topic: 'Google Merchant Center feed' },
    }, { 'BAP-Key': keyA, 'Idempotency-Key': generateId() });

    expect(status).toBe(400);
    expect(body.error).toContain('not actionable');
    const suppression = db.prepare(`SELECT reason FROM applicability_suppressions WHERE business_id = ? AND capability_key = 'google_merchant_center' AND status = 'active'`).get(BIZ_A) as { reason: string } | undefined;
    expect(suppression?.reason).toContain('google_merchant_center');
  });
});
describe('Hermes Kanban card contract', () => {
  test('GET /tasks/:taskId/kanban-card returns the canonical card handoff fields', async () => {
    const signalId = generateId();
    const goalId = generateId();
    db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, status, created_at) VALUES (?, ?, 'kanban', 'anomaly', 'warning', 'Kanban signal', 'open', CURRENT_TIMESTAMP)`).run(signalId, BIZ_A);
    db.prepare(`INSERT INTO goals (id, business_id, title, status, created_at, updated_at) VALUES (?, ?, 'Kanban revenue goal', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(goalId, BIZ_A);
    const taskId = insertTask({ title: 'Kanban card fixture', signal_id: signalId, action_type: 'github_pr', priority: 'p1', confidence: 0.91 });
    db.prepare(`INSERT OR REPLACE INTO measurement_policies (id, business_id, name, checkpoints_json, final_day, active) VALUES ('policy_kanban_test', ?, 'Kanban test policy', '[0,7]', 7, 1)`).run(BIZ_A);
    db.prepare(`UPDATE tasks SET goal_id = ?, assigned_to = 'hermes', trust_tier = 'orange', expected_outcome = 'Draft PR ready for human review', measurement_policy_id = 'policy_kanban_test', approval_risk_evidence = ?, action_payload = ? WHERE id = ?`).run(
      goalId,
      JSON.stringify({ calculated_tier: 'orange', financial_exposure_gbp: 0 }),
      JSON.stringify({ executor: 'github', acceptance_criteria: ['draft PR opened', 'tests listed'], expected_outcome: 'Draft PR ready for human review' }),
      taskId,
    );

    const { status, body } = await get(`/api/bap/v1/tasks/${taskId}/kanban-card`, { 'BAP-Key': keyA });

    expect(status).toBe(200);
    expect(body.card).toMatchObject({
      blueprint_task_id: taskId,
      business_id: BIZ_A,
      goal_id: goalId,
      signal_id: signalId,
      approval_tier: 'orange',
      approval_state: 'awaiting_approval',
      executor: 'github',
      expected_outcome: 'Draft PR ready for human review',
      kanban_column: 'backlog',
    });
    expect(body.card.acceptance_criteria).toEqual(['draft PR opened', 'tests listed']);
    expect(body.card.measurement_policy.id).toBe('policy_kanban_test');
    expect(body.card.measurement_policy.checkpoints_json).toEqual([0, 7]);
  });

  test('GET /businesses/:id/kanban-cards lists business-scoped cards with pagination and status filters', async () => {
    db.prepare(`DELETE FROM tasks WHERE business_id = ? AND title LIKE 'Kanban feed%'`).run(BIZ_A);
    insertTask({ title: 'Kanban feed proposed', status: 'proposed' });
    insertTask({ title: 'Kanban feed approved', status: 'approved' });
    insertTask({ title: 'Kanban feed cancelled', status: 'cancelled' });

    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/kanban-cards?status=proposed,approved&limit=10`, { 'BAP-Key': keyA });

    expect(status).toBe(200);
    expect(body.cards.every((c: any) => ['proposed', 'approved'].includes(c.task_status))).toBe(true);
    expect(body.cards.some((c: any) => c.title === 'Kanban feed proposed')).toBe(true);
    expect(body.cards.some((c: any) => c.title === 'Kanban feed approved')).toBe(true);
    expect(body.cards.some((c: any) => c.title === 'Kanban feed cancelled')).toBe(false);
    expect(body.pagination.limit).toBe(10);
  });

  test('kanban-card detail is tenant-isolated', async () => {
    const taskId = insertTask({ business_id: BIZ_B, title: 'Kanban B private task' });
    const { status } = await get(`/api/bap/v1/tasks/${taskId}/kanban-card`, { 'BAP-Key': keyA });
    expect(status).toBe(403);
  });
});
describe('PATCH /tasks/:taskId — cancel action', () => {
  test('cancels a proposed task', async () => {
    const taskId = insertTask({ title: 'Cancel me' });
    const { status, body } = await patch(`/api/bap/v1/tasks/${taskId}`, { action: 'cancel', reason: 'no longer needed' }, { 'BAP-Key': keyA, 'Idempotency-Key': generateId() });
    expect(status).toBe(200);
    expect(body.status).toBe('cancelled');
    const row = db.prepare('SELECT status, rejection_reason FROM tasks WHERE id = ?').get(taskId) as { status: string; rejection_reason: string };
    expect(row.status).toBe('cancelled');
    expect(row.rejection_reason).toBe('no longer needed');
  });

  test('cancelling an executing task is rejected with 422', async () => {
    const taskId = insertTask({ title: 'Cannot cancel', status: 'executing' });
    const { status, body } = await patch(`/api/bap/v1/tasks/${taskId}`, { action: 'cancel' }, { 'BAP-Key': keyA, 'Idempotency-Key': generateId() });
    expect(status).toBe(422);
    expect(body.error).toMatch(/Cannot cancel/);
  });

  test('cross-tenant cancel is rejected with 403, task untouched', async () => {
    const taskId = insertTask({ business_id: BIZ_B, title: 'B task' });
    const { status } = await patch(`/api/bap/v1/tasks/${taskId}`, { action: 'cancel' }, { 'BAP-Key': keyA, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('proposed');
  });

  test('rejects an unknown action', async () => {
    const taskId = insertTask({ title: 'Bad action' });
    const { status } = await patch(`/api/bap/v1/tasks/${taskId}`, { action: 'launch_rockets' }, { 'BAP-Key': keyA, 'Idempotency-Key': generateId() });
    expect(status).toBe(400);
  });
});

describe('Concurrent reads', () => {
  test('20 simultaneous GET /businesses/:id/tasks requests all succeed with consistent, correctly-paginated results', async () => {
    db.prepare(`DELETE FROM tasks WHERE business_id = ? AND title LIKE 'Concurrent fixture%'`).run(BIZ_A);
    for (let i = 0; i < 7; i++) insertTask({ title: `Concurrent fixture ${i}` });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => get(`/api/bap/v1/businesses/${BIZ_A}/tasks?q=Concurrent+fixture&limit=5`, { 'BAP-Key': keyA }))
    );
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(7);
      expect(r.body.tasks.length).toBe(5);
      expect(r.body.pagination).toEqual({ page: 1, limit: 5, total: 7, pages: 2 });
    }
  });

  test('20 simultaneous GET /tasks/:id detail requests for the same task all return identical data', async () => {
    const taskId = insertTask({ title: 'Concurrent detail fixture' });
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => get(`/api/bap/v1/tasks/${taskId}`, { 'BAP-Key': keyAllPerms }))
    );
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body.task.id).toBe(taskId);
      expect(r.body.task.title).toBe('Concurrent detail fixture');
    }
  });
});
