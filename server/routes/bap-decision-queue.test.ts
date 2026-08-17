/**
 * BAP pending-decision queue (issue #77) — server/routes/bap-decision-queue.ts,
 * exercised against a real Express instance mounting the actual routers.
 *
 * Three properties carry the weight here:
 *
 *   1. An authorized agent can see WHY its proposal is pending — lane,
 *      lane_reason, risk tier, evidence and the action that would actually
 *      run — which is the whole point of #77 over polling task status.
 *   2. Cross-business isolation, by business path AND by guessed task ID.
 *   3. This surface is genuinely SEPARATE from bap-decisions.ts's
 *      decision-memory log. Both are called "decisions"; if the paths or
 *      permissions ever converge, an agent asking for its pending work would
 *      silently receive the historical log instead. Both routers are mounted
 *      on the same app below precisely so that confusion would show up here.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapDecisionQueueRouter from './bap-decision-queue.ts';
import bapDecisionsRouter from './bap-decisions.ts';
import { createTask } from '../tasks/task-queue.js';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';

const BIZ_A = 'biz_bap_decq_a';
const BIZ_B = 'biz_bap_decq_b';
const AGENT_IDS = ['agt_decq_a', 'agt_decq_b', 'agt_decq_nogrant', 'agt_decq_memoryonly'];

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string;            // BIZ_A, holds decision_queue:read
let keyB: string;            // BIZ_B, holds decision_queue:read
let keyNoGrant: string;      // BIZ_A, holds tasks:read only
let keyMemoryOnly: string;   // BIZ_A, holds decisions:read only (the OTHER surface)

let taskA = '';
let taskAUnexecutable = '';
let taskB = '';

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function propose(businessId: string, title: string, actionType: string | null, proposedBy = 'agent:test'): string {
  return createTask({
    business_id: businessId,
    title,
    description: 'The connector reported a 40% drop in conversions this week.',
    proposed_by: proposedBy,
    action_type: actionType,
    action_payload: {},
    approval_mode: 'requires_approval',
  })!.id;
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP DecQ A', 'bap-decq-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP DecQ B', 'bap-decq-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  for (const id of AGENT_IDS) db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);
  keyA = generateApiKey();
  keyB = generateApiKey();
  keyNoGrant = generateApiKey();
  keyMemoryOnly = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_decq_a', 'DecQ Agent A', await hashApiKey(keyA), keyPrefix(keyA), JSON.stringify(['decision_queue:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_decq_b', 'DecQ Agent B', await hashApiKey(keyB), keyPrefix(keyB), JSON.stringify(['decision_queue:read']), JSON.stringify([BIZ_B]));
  insertAgent.run('agt_decq_nogrant', 'No Grant Agent', await hashApiKey(keyNoGrant), keyPrefix(keyNoGrant), JSON.stringify(['tasks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_decq_memoryonly', 'Memory Only Agent', await hashApiKey(keyMemoryOnly), keyPrefix(keyMemoryOnly), JSON.stringify(['decisions:read']), JSON.stringify([BIZ_A]));

  // An action type that is registered but has no executor — approving it could
  // never make it run, which is what puts an item in the manual_review lane.
  upsertActionRegistryEntry('decq_bap_unexecutable', {
    description: 'Unexecutable fixture action',
    display_name: 'Unexecutable fixture action',
    dispatched_by_executor: false,
    active: true,
  });

  taskA = propose(BIZ_A, 'Raise the ad budget', null, 'agent:hermes');
  taskAUnexecutable = propose(BIZ_A, 'Call the supplier', 'decq_bap_unexecutable', 'agent:other');
  db.prepare("UPDATE tasks SET status = 'manual_review' WHERE id = ?").run(taskAUnexecutable);
  taskB = propose(BIZ_B, 'Business B proposal', null);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapDecisionQueueRouter, bapDecisionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  for (const id of [BIZ_A, BIZ_B]) {
    db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(id);
    db.prepare('DELETE FROM decisions WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE business_id = ?').run(id);
  }
  db.prepare("DELETE FROM action_registry WHERE action_type = 'decq_bap_unexecutable'").run();
  const placeholders = AGENT_IDS.map(() => '?').join(', ');
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN (${placeholders})`).run(...AGENT_IDS);
  db.prepare(`DELETE FROM bap_agents WHERE id IN (${placeholders})`).run(...AGENT_IDS);
});

// ─── The grant ───────────────────────────────────────────────────────────────

describe('decision_queue:read grant', () => {
  test('is offered as a read-only grant, with no review/write counterpart', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('decision_queue:read');
    expect(GRANTABLE_BAP_PERMISSIONS.some((p) => p.startsWith('decision_queue:') && p !== 'decision_queue:read')).toBe(false);
  });

  test('an agent without the grant cannot read the queue for a business it otherwise has access to', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`, { 'BAP-Key': keyNoGrant });
    expect(status).toBe(403);
  });

  test('an unauthenticated request is rejected outright', async () => {
    expect((await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`)).status).toBe(401);
  });
});

// ─── Listing ─────────────────────────────────────────────────────────────────

describe('GET /businesses/:id/decision-queue', () => {
  test('returns pending items with lane, risk, evidence and the action that would run', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.business_id).toBe(BIZ_A);
    expect(body.counts.total).toBe(2);
    // Policy citation travels with the queue, so an agent can explain which
    // rule set its proposal was judged under.
    expect(typeof body.policy.citation).toBe('string');

    const item = body.decisions.find((d: any) => d.task_id === taskA);
    expect(item.business_id).toBe(BIZ_A);
    expect(item.title).toBe('Raise the ad budget');
    expect(['manual_review', 'policy_gated', 'routine']).toContain(item.lane);
    expect(item.lane_reason.length).toBeGreaterThan(0);
    expect(['green', 'yellow', 'orange', 'red']).toContain(item.risk_tier);
    expect(item.required_action).toBeDefined();
    expect(item.evidence.some((e: any) => e.type === 'risk_assessment')).toBe(true);
    expect(item.evidence.some((e: any) => e.type === 'proposal_rationale')).toBe(true);
  });

  test('an unexecutable action is surfaced as manual_review, not mixed in with routine work', async () => {
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`, { 'BAP-Key': keyA });
    const item = body.decisions.find((d: any) => d.task_id === taskAUnexecutable);
    expect(item.lane).toBe('manual_review');
    expect(item.required_action.executable).toBe(false);
    // Most-urgent-first ordering: manual_review sorts ahead of the rest.
    expect(body.decisions[0].task_id).toBe(taskAUnexecutable);
    expect(body.counts.manual_review).toBe(1);
  });

  test('an agent can narrow the queue to its own proposals', async () => {
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue?proposed_by=agent:hermes`, { 'BAP-Key': keyA });
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].task_id).toBe(taskA);
    // The counts still describe the whole queue, so filtering to your own work
    // never misreports how much is actually pending for the business.
    expect(body.counts.total).toBe(2);
  });

  test('rejects an unknown lane rather than silently returning everything', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue?lane=nonsense`, { 'BAP-Key': keyA });
    expect(status).toBe(400);
    expect(body.code).toBe('validation_error');
  });

  test('an unknown business is denied before existence is ever checked', async () => {
    // 403, not 404: requirePermission resolves :businessId from the path and
    // finds it absent from the agent's business_access, so the request never
    // reaches the existence check. That ordering is deliberate — a 404 here
    // would let an agent probe which business IDs are real.
    const { status } = await get('/api/bap/v1/businesses/biz_does_not_exist/decision-queue', { 'BAP-Key': keyA });
    expect(status).toBe(403);
  });

  test('recurring decision classes are readable under the same grant', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue/classes`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.business_id).toBe(BIZ_A);
    expect(body.classes.some((c: any) => c.decision_class === 'decq_bap_unexecutable')).toBe(true);
  });
});

// ─── Cross-business isolation ────────────────────────────────────────────────

describe('cross-business isolation', () => {
  test('an agent scoped to business B cannot list business A\'s queue', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`, { 'BAP-Key': keyB });
    expect(status).toBe(403);
    expect(body.decisions).toBeUndefined();
  });

  test('an agent scoped to business B cannot read business A\'s classes', async () => {
    expect((await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue/classes`, { 'BAP-Key': keyB })).status).toBe(403);
  });

  test('an agent scoped to business B cannot read business A\'s queue item by guessing the task ID', async () => {
    const { status, body } = await get(`/api/bap/v1/decision-queue/${taskA}`, { 'BAP-Key': keyB });
    expect(status).toBe(403);
    expect(body.code).toBe('permission_denied');
    expect(body.decision).toBeUndefined();
  });

  test('each agent sees only its own business\'s queue', async () => {
    const a = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`, { 'BAP-Key': keyA });
    const b = await get(`/api/bap/v1/businesses/${BIZ_B}/decision-queue`, { 'BAP-Key': keyB });
    expect(a.body.decisions.map((d: any) => d.task_id)).not.toContain(taskB);
    expect(b.body.decisions.map((d: any) => d.task_id)).toEqual([taskB]);
  });
});

// ─── ID-addressed detail ─────────────────────────────────────────────────────

describe('GET /decision-queue/:taskId', () => {
  test('the authorized agent reads the full item, evidence included', async () => {
    const { status, body } = await get(`/api/bap/v1/decision-queue/${taskA}`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.decision.task_id).toBe(taskA);
    expect(body.decision.business_id).toBe(BIZ_A);
    expect(body.decision.evidence.length).toBeGreaterThan(0);
    expect(body.decision.policy.citation).toBeDefined();
  });

  test('an unknown task is a 404, not a leak of existence', async () => {
    expect((await get('/api/bap/v1/decision-queue/does-not-exist', { 'BAP-Key': keyA })).status).toBe(404);
  });

  test('a task that is no longer awaiting review has no pending decision', async () => {
    const settled = propose(BIZ_A, 'Already handled', null);
    db.prepare("UPDATE tasks SET status = 'complete' WHERE id = ?").run(settled);
    const { status, body } = await get(`/api/bap/v1/decision-queue/${settled}`, { 'BAP-Key': keyA });
    expect(status).toBe(404);
    // The 404 points at the surface that DOES hold reviewed outcomes.
    expect(body.error).toMatch(/decision-memory/);
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(settled);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(settled);
  });
});

// ─── Separation from bap-decisions.ts (decision memory) ──────────────────────
//
// The naming collision this whole file exists to pin down. Both routers are
// mounted on the same app, so if either the paths or the permissions ever
// converge, these tests fail rather than an agent silently receiving the wrong
// data model.

describe('the decision QUEUE is a distinct surface from decision MEMORY', () => {
  test('the two permissions are separate grants, neither implying the other', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('decision_queue:read');
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('decisions:read');
    expect('decision_queue:read').not.toBe('decisions:read');
    // Wildcard resolution in hasPermission() splits on ':' — 'decision_queue'
    // and 'decisions' are different resources, so 'decisions:*' can never
    // satisfy the queue grant by accident.
    expect('decision_queue:read'.split(':')[0]).not.toBe('decisions:read'.split(':')[0]);
  });

  test('the queue grant alone does NOT open the decision-memory routes', async () => {
    expect((await get(`/api/bap/v1/businesses/${BIZ_A}/decisions`, { 'BAP-Key': keyA })).status).toBe(403);
    expect((await get('/api/bap/v1/decisions/whatever', { 'BAP-Key': keyA })).status).toBe(403);
  });

  test('the decision-memory grant alone does NOT open the queue routes', async () => {
    expect((await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`, { 'BAP-Key': keyMemoryOnly })).status).toBe(403);
    expect((await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue/classes`, { 'BAP-Key': keyMemoryOnly })).status).toBe(403);
    expect((await get(`/api/bap/v1/decision-queue/${taskA}`, { 'BAP-Key': keyMemoryOnly })).status).toBe(403);
  });

  test('the two list routes return different data models, not the same one twice', async () => {
    const memoryOnly = await get(`/api/bap/v1/businesses/${BIZ_A}/decisions`, { 'BAP-Key': keyMemoryOnly });
    expect(memoryOnly.status).toBe(200);
    // Decision memory answers with `decisions` + pagination and knows nothing
    // about lanes; the queue answers with lanes, counts and a policy citation.
    expect(memoryOnly.body.pagination).toBeDefined();
    expect(memoryOnly.body.counts).toBeUndefined();

    const queue = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`, { 'BAP-Key': keyA });
    expect(queue.body.counts).toBeDefined();
    expect(queue.body.decisions[0].lane).toBeDefined();
    expect(queue.body.decisions[0].task_id).toBeDefined();
  });
});
