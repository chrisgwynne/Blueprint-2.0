/**
 * Decision Centre API — authorization and cross-business isolation (#61).
 *
 * Run against a real, locally-bound Express instance mounting the actual
 * router (same harness as operating-policies.security.test.ts), because the
 * properties under test are properties of the HTTP surface rather than of
 * the engine:
 *
 *   - no session, no access, and no state change left behind
 *   - a reviewer working business A cannot read business B's queue
 *   - a reviewer working business A cannot approve, reject, defer or amend
 *     business B's decisions by pointing at them from A's URL
 *   - a policy hold cannot be overridden through the API without a reason
 *   - review outcomes are attributed to the logged-in human
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db from '../db/db.js';
import decisionQueueRouter from './decision-queue.ts';
import { createTask, getTask } from '../tasks/task-queue.js';

const BIZ_A = 'biz_decq_sec_a';
const BIZ_B = 'biz_decq_sec_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let sessionUserId: string | null = null;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function propose(businessId: string, title: string, payload: Record<string, unknown> = {}) {
  return createTask({
    business_id: businessId, title, description: 'fixture',
    proposed_by: 'agent:test', action_type: null, action_payload: payload,
    approval_mode: 'requires_approval',
  })!;
}

function futureIso(days = 7): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Decision Sec A', 'decq-sec-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Decision Sec B', 'decq-sec-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  // Stand-in for the real login flow: isAuthenticated only checks that
  // req.session.userId is set, so setting/clearing it here exercises the
  // exact same authorization branch the real app uses.
  app.use((req, _res, next) => {
    if (sessionUserId) (req.session as unknown as { userId: string }).userId = sessionUserId;
    next();
  });
  app.use('/api/decision-queue', decisionQueueRouter);

  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server?.close(); });

afterEach(() => {
  sessionUserId = null;
  for (const id of [BIZ_A, BIZ_B]) {
    db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(id);
    db.prepare('DELETE FROM execution_jobs WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM system_issues WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM decisions WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM action_receipts WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(id);
    db.prepare('DELETE FROM operating_policy_events WHERE scope_key = ?').run(id);
  }
});

// ─── Authentication ─────────────────────────────────────────────────────────

describe('dashboard authorization', () => {
  test('every decision-centre route rejects an unauthenticated caller', async () => {
    sessionUserId = null;
    const task = propose(BIZ_A, 'A task');

    expect((await get(`/api/decision-queue/${BIZ_A}`)).status).toBe(401);
    expect((await get(`/api/decision-queue/${BIZ_A}/classes`)).status).toBe(401);
    expect((await post(`/api/decision-queue/${BIZ_A}/${task.id}/review`, { outcome: 'approve' })).status).toBe(401);
    expect((await post(`/api/decision-queue/${BIZ_A}/${task.id}/propose-rule`, { rule_kind: 'always_require_human' })).status).toBe(401);
  });

  test('an unauthenticated review changes nothing', async () => {
    const task = propose(BIZ_A, 'A task');
    sessionUserId = null;
    await post(`/api/decision-queue/${BIZ_A}/${task.id}/review`, { outcome: 'approve' });
    expect(getTask(task.id)!.status).toBe('proposed');
  });

  test('the outcome is attributed to the logged-in human', async () => {
    sessionUserId = 'operator-1';
    const task = propose(BIZ_A, 'A task');
    const res = await post(`/api/decision-queue/${BIZ_A}/${task.id}/review`, { outcome: 'approve' });
    expect(res.status).toBe(200);

    const decision = db.prepare(
      "SELECT * FROM decisions WHERE related_task_id = ? AND decision_type = 'task_approval'"
    ).get(task.id) as Record<string, unknown>;
    // The 'dashboard:' prefix is what tells the #68 autonomy gate a human,
    // not Blueprint, made this call.
    expect(decision.author).toBe('dashboard:operator-1');
    expect(decision.effective_policy_version).not.toBeNull();
  });
});

// ─── Cross-business isolation over HTTP ─────────────────────────────────────

describe('a reviewer scoped to business A cannot see or act on business B', () => {
  test('A\'s queue contains only A\'s decisions', async () => {
    sessionUserId = 'operator-1';
    propose(BIZ_A, 'A task');
    propose(BIZ_B, 'B task');

    const res = await get(`/api/decision-queue/${BIZ_A}`);
    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0].title).toBe('A task');
    expect(res.body.decisions.every((d: { business_id: string }) => d.business_id === BIZ_A)).toBe(true);
  });

  test('approving B\'s task from A\'s URL is a 404, and B\'s task is untouched', async () => {
    sessionUserId = 'operator-1';
    const taskB = propose(BIZ_B, 'B task');

    const res = await post(`/api/decision-queue/${BIZ_A}/${taskB.id}/review`, { outcome: 'approve' });
    expect(res.status).toBe(404);
    expect(getTask(taskB.id)!.status).toBe('proposed');
  });

  test('reject, defer and amend are blocked across the boundary too', async () => {
    sessionUserId = 'operator-1';
    const taskB = propose(BIZ_B, 'B task');

    for (const body of [
      { outcome: 'reject', reason: 'crossing the boundary' },
      { outcome: 'defer', reason: 'crossing the boundary', defer_until: futureIso() },
      { outcome: 'amend', reason: 'crossing the boundary', amended_payload: { x: 1 } },
    ]) {
      const res = await post(`/api/decision-queue/${BIZ_A}/${taskB.id}/review`, body);
      expect(res.status).toBe(404);
    }
    expect(getTask(taskB.id)!.status).toBe('proposed');
    // No decision was recorded against B by A's reviewer.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE related_task_id = ?')
      .get(taskB.id) as { n: number };
    expect(rows.n).toBe(0);
  });

  test('a standing rule cannot be proposed from another business\'s decision', async () => {
    sessionUserId = 'operator-1';
    const taskB = propose(BIZ_B, 'B task');
    const res = await post(`/api/decision-queue/${BIZ_A}/${taskB.id}/propose-rule`, {
      rule_kind: 'always_require_human',
    });
    expect(res.status).toBe(404);
  });

  test('an unknown business is a 404, not an empty queue', async () => {
    sessionUserId = 'operator-1';
    const res = await get('/api/decision-queue/biz_does_not_exist');
    expect(res.status).toBe(404);
  });
});

// ─── The override rule is enforced server-side ──────────────────────────────

describe('a policy hold cannot be overridden through the API without a reason', () => {
  test('approving a red-tier item with no override reason is refused', async () => {
    sessionUserId = 'operator-1';
    const task = propose(BIZ_A, 'Big spend', { financial_exposure_gbp: 5000 });

    const res = await post(`/api/decision-queue/${BIZ_A}/${task.id}/review`, { outcome: 'approve' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('override_reason_required');
    expect(getTask(task.id)!.status).toBe('proposed');
  });

  test('with a written reason it proceeds and the override is recorded', async () => {
    sessionUserId = 'operator-1';
    const task = propose(BIZ_A, 'Big spend', { financial_exposure_gbp: 5000 });

    const res = await post(`/api/decision-queue/${BIZ_A}/${task.id}/review`, {
      outcome: 'approve',
      override_reason: 'Board pre-approved this spend; minutes are attached to the goal.',
    });
    expect(res.status).toBe(200);
    expect(res.body.override).toBe(true);
    expect(getTask(task.id)!.status).toBe('approved');

    const decision = db.prepare(
      "SELECT * FROM decisions WHERE related_task_id = ? AND decision_type = 'task_approval'"
    ).get(task.id) as Record<string, unknown>;
    expect(String(decision.reasoning)).toContain('POLICY OVERRIDE');
    expect(decision.effective_policy_version).not.toBeNull();
  });

  test('an unknown outcome is rejected before anything happens', async () => {
    sessionUserId = 'operator-1';
    const task = propose(BIZ_A, 'A task');
    const res = await post(`/api/decision-queue/${BIZ_A}/${task.id}/review`, { outcome: 'yolo' });
    expect(res.status).toBe(400);
    expect(getTask(task.id)!.status).toBe('proposed');
  });
});
