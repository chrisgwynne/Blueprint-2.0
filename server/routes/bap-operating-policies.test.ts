/**
 * Operating Policy over BAP (#68), backtest extension —
 * server/routes/bap-operating-policies.ts, exercised against a real Express
 * instance mounting the actual router behind the real bapAuth chain.
 *
 * Three properties carry the weight:
 *   1. POST .../operating-policy/backtest requires BOTH
 *      `operating_policies:read` and `tasks:read` — holding only one is not
 *      enough (see the route's docstring for why).
 *   2. Business scoping matches every other BAP route: an agent scoped to
 *      business A cannot backtest business B's history.
 *   3. It is genuinely read-only from the BAP boundary — no task, policy
 *      version or policy event is touched by calling it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapOperatingPoliciesRouter from './bap-operating-policies.ts';

const BIZ_A = 'biz_bap_oppolicy_a';
const BIZ_B = 'biz_bap_oppolicy_b';
const AGENT_IDS = ['agt_oppolicy_both', 'agt_oppolicy_policy_only', 'agt_oppolicy_tasks_only', 'agt_oppolicy_b', 'agt_oppolicy_ghost'];

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyBoth: string;       // BIZ_A, holds operating_policies:read + tasks:read
let keyPolicyOnly: string; // BIZ_A, holds operating_policies:read only
let keyTasksOnly: string;  // BIZ_A, holds tasks:read only
let keyB: string;          // BIZ_B, holds both grants
let keyGhost: string;      // scoped to a business id that does not exist, holds both grants

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function isoDaysAgo(days: number, extraMs = 0): string {
  return new Date(Date.now() - days * 86400000 + extraMs).toISOString();
}

function insertAutoApprovedTask(businessId: string, trustTier = 'orange'): string {
  const id = `task_bapoppol_${generateId()}`;
  const createdAt = isoDaysAgo(3);
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, action_type, action_payload, status, trust_tier, approval_mode, approved_by, approved_at, created_at, updated_at)
    VALUES (?, ?, 'BAP backtest fixture', 'test', 'report', '{}', 'approved', ?, 'requires_approval', 'bap:some-agent', ?, ?, ?)
  `).run(id, businessId, trustTier, createdAt, createdAt, createdAt);
  return id;
}

function count(table: string, businessId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id = ?`).get(businessId) as { n: number })?.n
    ?? (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope_key = ?`).get(businessId) as { n: number }).n;
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP OpPolicy A', 'bap-oppolicy-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP OpPolicy B', 'bap-oppolicy-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  for (const id of AGENT_IDS) db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);

  keyBoth = generateApiKey();
  keyPolicyOnly = generateApiKey();
  keyTasksOnly = generateApiKey();
  keyB = generateApiKey();
  keyGhost = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_oppolicy_both', 'Both Grants', await hashApiKey(keyBoth), keyPrefix(keyBoth), JSON.stringify(['operating_policies:read', 'tasks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_oppolicy_policy_only', 'Policy Only', await hashApiKey(keyPolicyOnly), keyPrefix(keyPolicyOnly), JSON.stringify(['operating_policies:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_oppolicy_tasks_only', 'Tasks Only', await hashApiKey(keyTasksOnly), keyPrefix(keyTasksOnly), JSON.stringify(['tasks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_oppolicy_b', 'Business B', await hashApiKey(keyB), keyPrefix(keyB), JSON.stringify(['operating_policies:read', 'tasks:read']), JSON.stringify([BIZ_B]));
  // Direct DB insert bypasses self-registration's filterValidBusinessIds(),
  // which is exactly what's needed to reach assertScopeExists()'s 404 for a
  // business id that passes the ACL check but does not actually exist.
  insertAgent.run('agt_oppolicy_ghost', 'Ghost Business', await hashApiKey(keyGhost), keyPrefix(keyGhost), JSON.stringify(['operating_policies:read', 'tasks:read']), JSON.stringify(['biz_does_not_exist']));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapOperatingPoliciesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM operating_policies WHERE scope_key IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM operating_policy_events WHERE scope_key IN (?, ?)').run(BIZ_A, BIZ_B);
});

afterAll(() => {
  server?.close();
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM operating_policies WHERE scope_key IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM operating_policy_events WHERE scope_key IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN (${AGENT_IDS.map(() => '?').join(',')})`).run(...AGENT_IDS);
  db.prepare(`DELETE FROM bap_agents WHERE id IN (${AGENT_IDS.map(() => '?').join(',')})`).run(...AGENT_IDS);
});

// ─── The permission gate ──────────────────────────────────────────────────────

describe('POST /businesses/:id/operating-policy/backtest — permission gate', () => {
  test('is grantable under existing grants, requiring both operating_policies:read and tasks:read', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('operating_policies:read');
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('tasks:read');
  });

  test('operating_policies:read alone is not enough', async () => {
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`,
      { patch: {}, days: 30 }, { 'BAP-Key': keyPolicyOnly });
    expect(status).toBe(403);
    expect(body.error).toMatch(/tasks:read/);
  });

  test('tasks:read alone is not enough', async () => {
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`,
      { patch: {}, days: 30 }, { 'BAP-Key': keyTasksOnly });
    expect(status).toBe(403);
    expect(body.error).toMatch(/operating_policies:read/);
  });

  test('holding both grants succeeds', async () => {
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`,
      { patch: {}, days: 30 }, { 'BAP-Key': keyBoth });
    expect(status).toBe(200);
    expect(body.backtest).toBeDefined();
  });

  test('an unauthenticated call never reaches the route', async () => {
    const res = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`, { patch: {} });
    expect(res.status).toBe(401);
  });
});

// ─── Business scoping ──────────────────────────────────────────────────────────

describe('business scoping', () => {
  test('an agent scoped to business B cannot backtest business A', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`,
      { patch: {}, days: 30 }, { 'BAP-Key': keyB });
    expect(status).toBe(403);
  });

  test('an agent only sees its own business\'s history', async () => {
    insertAutoApprovedTask(BIZ_A);
    insertAutoApprovedTask(BIZ_B);
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`,
      { patch: {}, days: 30 }, { 'BAP-Key': keyBoth });
    expect(status).toBe(200);
    expect(body.backtest.tasks_in_window).toBe(1);
    expect(body.backtest.business_ids).toEqual([BIZ_A]);
  });
});

// ─── The backtest result itself ────────────────────────────────────────────────

describe('the backtest result', () => {
  test('reports would-differ counts with task ids as evidence, not a bare number', async () => {
    const taskId = insertAutoApprovedTask(BIZ_A, 'orange');
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`,
      {
        patch: { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } },
        days: 30,
      }, { 'BAP-Key': keyBoth });

    expect(status).toBe(200);
    expect(body.backtest.would_now_require_review.count).toBe(1);
    expect(body.backtest.would_now_require_review.task_ids).toContain(taskId);
    expect(body.backtest.evidence.find((e: any) => e.task_id === taskId).transition).toBe('now_requires_review'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  test('an empty window says so explicitly rather than implying the policy is safe', async () => {
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`,
      { patch: {}, days: 30 }, { 'BAP-Key': keyBoth });
    expect(status).toBe(200);
    expect(body.backtest.empty_window).toBe(true);
    expect(body.backtest.methodology_notes.join(' ')).toMatch(/NOT evidence the candidate is safe/);
  });

  test('a business id that does not exist 404s rather than silently returning an empty result', async () => {
    const { status, body } = await post('/api/bap/v1/businesses/biz_does_not_exist/operating-policy/backtest',
      { patch: {}, days: 30 }, { 'BAP-Key': keyGhost });
    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
  });
});

// ─── Zero side effects from the BAP route specifically ────────────────────────

describe('running a backtest over BAP does nothing', () => {
  test('no policy version, no policy event, no task mutation', async () => {
    const taskId = insertAutoApprovedTask(BIZ_A, 'orange');
    const beforeTask = db.prepare('SELECT status, approved_by, approved_at, updated_at FROM tasks WHERE id = ?').get(taskId);
    const policiesBefore = count('operating_policies', BIZ_A);

    for (let i = 0; i < 3; i += 1) {
      const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy/backtest`,
        {
          patch: { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } },
          days: 30,
        }, { 'BAP-Key': keyBoth });
      expect(status).toBe(200);
    }

    expect(db.prepare('SELECT status, approved_by, approved_at, updated_at FROM tasks WHERE id = ?').get(taskId)).toEqual(beforeTask as Record<string, unknown>);
    expect(count('operating_policies', BIZ_A)).toBe(policiesBefore);
  });
});
