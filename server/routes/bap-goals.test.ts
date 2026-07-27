/**
 * Phase 2 Goal API tests — server/routes/bap-goals.ts, the new BAP surface
 * for goals (previously session-auth-only, F-20 in AUDIT-BAP-GAPS.md).
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
import bapGoalsRouter from './bap-goals.ts';

const BIZ_A = 'biz_bap_goals_a';
const BIZ_B = 'biz_bap_goals_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;
let keyFull: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function patch(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertGoal(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO goals (id, business_id, title, description, status, metric_name, metric_baseline, metric_target, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, (overrides.business_id as string) ?? BIZ_A, (overrides.title as string) ?? 'Fixture goal',
    (overrides.description as string) ?? null, (overrides.status as string) ?? 'active',
    (overrides.metric_name as string) ?? null, (overrides.metric_baseline as number) ?? null,
    (overrides.metric_target as number) ?? null, (overrides.project_id as string) ?? null,
  );
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Goals A', 'bap-goals-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Goals B', 'bap-goals-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_goals_read', 'agt_goals_full')`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Goals Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_goals_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['goals:read']), JSON.stringify([BIZ_A]));

  keyFull = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Goals Full Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_goals_full', await hashApiKey(keyFull), keyPrefix(keyFull), JSON.stringify(['goals:read', 'goals:propose', 'goals:update']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  // Replicates bap.ts's own auth chain (bapRequestContext -> bapAuth ->
  // bapRateLimit) since bap-goals.ts no longer applies it itself — see
  // bap-goals.ts's docstring on why it's mounted as a sub-router of bap.ts
  // in production instead.
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapGoalsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM conflicts WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goal_checks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  // Phase 3 child tables — populated only if a real LLM provider caused
  // goal-reasoner's fire-and-forget planning pass to actually persist
  // anything during this test run (it fails silently otherwise), but
  // cleaned up unconditionally so this test never depends on that.
  db.prepare(`DELETE FROM goal_strategies WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goal_assessments WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goal_milestones WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goal_dependencies WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM decisions WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goals WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN ('agt_goals_read', 'agt_goals_full')`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_goals_read', 'agt_goals_full')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_goals_read', 'agt_goals_full')`).run();
});

describe('GET /businesses/:id/goals', () => {
  test('lists active goals by default (excludes cancelled)', async () => {
    insertGoal({ title: 'Active goal' });
    insertGoal({ title: 'Cancelled goal', status: 'cancelled' });
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/goals`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.goals.every((g: any) => g.status !== 'cancelled')).toBe(true);
  });

  test('q searches title/description', async () => {
    insertGoal({ title: 'Increase organic traffic by 20%' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/goals?q=organic+traffic`, { 'BAP-Key': keyRead });
    expect(body.goals.some((g: any) => /organic traffic/.test(g.title))).toBe(true);
  });

  test('pagination shape matches convention', async () => {
    for (let i = 0; i < 3; i++) insertGoal({ title: `Pagey goal ${i}` });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/goals?q=Pagey+goal&page=1&limit=2`, { 'BAP-Key': keyRead });
    expect(body.goals.length).toBe(2);
    expect(body.pagination).toMatchObject({ page: 1, limit: 2, total: 3, pages: 2 });
  });

  test('403 without goals:read permission on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/goals`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('POST /businesses/:id/goals (propose)', () => {
  test('creates a goal, auto-fills baseline from latest metric', async () => {
    const connectorId = generateId();
    db.prepare(`INSERT INTO connectors (id, business_id, type, name, status, created_at) VALUES (?, ?, 'gsc', 'GSC', 'connected', CURRENT_TIMESTAMP)`).run(connectorId, BIZ_A);
    db.prepare(`INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, recorded_at) VALUES (?, ?, ?, 'gsc.total_clicks', 1200, CURRENT_TIMESTAMP)`).run(generateId(), BIZ_A, connectorId);

    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, {
      title: 'Grow GSC clicks', metric_name: 'gsc.total_clicks', metric_target: 2000,
    }, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });

    expect(status).toBe(201);
    expect(body.goal.title).toBe('Grow GSC clicks');
    expect(body.goal.metric_baseline).toBe(1200);
    expect(body.goal.status).toBe('active');
    expect(body.goal.created_by).toBe('bap:agt_goals_full');
  });

  test('requires title', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, {}, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(400);
  });

  test('requires goals:propose, not just goals:read', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, { title: 'x' }, { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
  });

  test('requires Idempotency-Key', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, { title: 'no key' }, { 'BAP-Key': keyFull });
    expect(status).toBe(400);
  });

  test('same Idempotency-Key twice creates exactly one goal', async () => {
    const idemKey = generateId();
    const r1 = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, { title: 'Dedup goal' }, { 'BAP-Key': keyFull, 'Idempotency-Key': idemKey });
    const r2 = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, { title: 'Dedup goal' }, { 'BAP-Key': keyFull, 'Idempotency-Key': idemKey });
    expect(r1.body.goal.id).toBe(r2.body.goal.id);
    const count = (db.prepare(`SELECT COUNT(*) as n FROM goals WHERE business_id = ? AND title = 'Dedup goal'`).get(BIZ_A) as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('GET /goals/:goalId (detail)', () => {
  test('returns linked_metrics, linked_tasks/signals via project_id, progress, blockers, conflicts', async () => {
    const projectId = 'proj_shared';
    const goalId = insertGoal({ title: 'Detail goal', metric_name: 'x', metric_baseline: 10, metric_target: 20, project_id: projectId });
    const taskId = generateId();
    db.prepare(`INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, project_id, created_at, updated_at) VALUES (?, ?, 'Linked task', 'test', 'proposed', 'yellow', 'requires_approval', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(taskId, BIZ_A, projectId);
    db.prepare(`INSERT INTO goal_checks (id, goal_id, business_id, metric_value, progress_pct, checked_at) VALUES (?, ?, ?, 15, 50, CURRENT_TIMESTAMP)`).run(generateId(), goalId, BIZ_A);
    db.prepare(`
      INSERT INTO conflicts (id, business_id, conflict_type, entity_a_type, entity_a_id, entity_b_type, entity_b_id, description, status, detected_at)
      VALUES (?, ?, 'goal_vs_goal', 'goal', ?, 'goal', 'other', 'conflict desc', 'open', CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ_A, goalId);

    const { status, body } = await get(`/api/bap/v1/goals/${goalId}`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.goal.id).toBe(goalId);
    expect(body.linked_metrics.metric_name).toBe('x');
    expect(body.linked_tasks.some((t: any) => t.id === taskId)).toBe(true);
    expect(body.progress.checks.length).toBe(1);
    expect(body.blockers.open_conflicts.length).toBe(1);
    expect(body.conflicts.length).toBe(1);
  });

  test('404 for unknown goal', async () => {
    const { status } = await get('/api/bap/v1/goals/does-not-exist', { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });

  test('403 across tenants', async () => {
    const goalId = insertGoal({ business_id: BIZ_B, title: 'B goal' });
    const { status } = await get(`/api/bap/v1/goals/${goalId}`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('PATCH /goals/:goalId', () => {
  test('updates allowed scalar and JSON fields', async () => {
    const goalId = insertGoal({ title: 'Update me' });
    const { status, body } = await patch(`/api/bap/v1/goals/${goalId}`, {
      status: 'paused', tags: ['q1', 'seo'],
    }, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(200);
    expect(body.goal.status).toBe('paused');
    expect(body.goal.tags).toEqual(['q1', 'seo']);
  });

  test('rejects an invalid status value', async () => {
    const goalId = insertGoal({ title: 'Bad status' });
    const { status } = await patch(`/api/bap/v1/goals/${goalId}`, { status: 'not_a_real_status' }, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(400);
  });

  test('requires goals:update, not just goals:read', async () => {
    const goalId = insertGoal({ title: 'No perm' });
    const { status } = await patch(`/api/bap/v1/goals/${goalId}`, { status: 'paused' }, { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
  });
});

describe('POST /goals/:goalId/archive', () => {
  test('soft-cancels the goal', async () => {
    const goalId = insertGoal({ title: 'Archive me' });
    const { status, body } = await post(`/api/bap/v1/goals/${goalId}/archive`, {}, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(200);
    expect(body.status).toBe('cancelled');
    const row = db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string };
    expect(row.status).toBe('cancelled');
  });
});

describe('GET /goals/:goalId/conflicts', () => {
  test('lists conflicts referencing this goal on either side', async () => {
    const goalId = insertGoal({ title: 'Conflicted goal' });
    db.prepare(`
      INSERT INTO conflicts (id, business_id, conflict_type, entity_a_type, entity_a_id, entity_b_type, entity_b_id, description, status, detected_at)
      VALUES (?, ?, 'task_vs_goal', 'task', 'tsk_x', 'goal', ?, 'desc', 'open', CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ_A, goalId);
    const { status, body } = await get(`/api/bap/v1/goals/${goalId}/conflicts`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.conflicts.length).toBe(1);
  });
});

describe('Phase 3: goal engine FKs — owner/confidence/priority/depends_on', () => {
  test('POST accepts owner, confidence, priority, and depends_on', async () => {
    const depGoalId = insertGoal({ title: 'Dependency target' });
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, {
      title: 'Strategic goal', owner: 'human:chris', confidence: 0.65, priority: 'p1', depends_on: [depGoalId],
    }, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(201);
    expect(body.goal.owner).toBe('human:chris');
    expect(body.goal.confidence).toBe(0.65);
    expect(body.goal.priority).toBe('p1');
    expect(body.goal.dependencies.some((d: any) => d.goal_id === depGoalId)).toBe(true);
  });

  test('rejects an invalid priority value', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, {
      title: 'Bad priority', priority: 'urgent',
    }, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(400);
  });

  test('rejects a confidence value outside 0-1', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/goals`, {
      title: 'Bad confidence', confidence: 70,
    }, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(400);
  });

  test('PATCH updates owner/confidence/priority and replaces depends_on', async () => {
    const depGoalId = insertGoal({ title: 'New dependency target' });
    const goalId = insertGoal({ title: 'Patchable goal' });
    const { status, body } = await patch(`/api/bap/v1/goals/${goalId}`, {
      owner: 'human:jamie', confidence: 0.4, priority: 'p3', depends_on: [depGoalId],
    }, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(200);
    expect(body.goal.owner).toBe('human:jamie');
    expect(body.goal.priority).toBe('p3');
    expect(body.goal.dependencies).toHaveLength(1);
    expect(body.goal.dependencies[0].goal_id).toBe(depGoalId);
  });
});

describe('Phase 3: strategic assessment + strategies', () => {
  function insertAssessment(goalId: string, overrides: Partial<Record<string, unknown>> = {}): string {
    const id = generateId();
    db.prepare(`
      INSERT INTO goal_assessments (id, goal_id, business_id, feasibility_verdict, feasibility_confidence, assumptions, risks, dependencies, success_criteria, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id, goalId, BIZ_A, (overrides.feasibility_verdict as string) ?? 'feasible', 0.7,
      JSON.stringify(['Traffic stays stable']), JSON.stringify(['Algorithm update risk']),
      JSON.stringify(['Content team availability']), JSON.stringify(['Reach target metric within deadline']),
    );
    return id;
  }
  function insertStrategy(goalId: string, assessmentId: string, overrides: Partial<Record<string, unknown>> = {}): string {
    const id = generateId();
    db.prepare(`
      INSERT INTO goal_strategies (id, goal_id, business_id, assessment_id, name, summary, confidence, estimated_effort, is_recommended, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id, goalId, BIZ_A, assessmentId, (overrides.name as string) ?? 'Fixture strategy',
      'Do the thing', 0.6, 'medium', (overrides.is_recommended as number) ?? 0, 'candidate',
    );
    return id;
  }

  test('GET /goals/:id/assessment returns the latest, with parsed arrays', async () => {
    const goalId = insertGoal({ title: 'Assessed goal' });
    insertAssessment(goalId, { feasibility_verdict: 'stale' });
    const latestId = insertAssessment(goalId, { feasibility_verdict: 'feasible' });
    const { status, body } = await get(`/api/bap/v1/goals/${goalId}/assessment`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.assessment.id).toBe(latestId);
    expect(Array.isArray(body.assessment.assumptions)).toBe(true);
    expect(Array.isArray(body.assessment.success_criteria)).toBe(true);
  });

  test('GET /goals/:id/assessment 404s when none exists yet', async () => {
    const goalId = insertGoal({ title: 'Unassessed goal' });
    const { status } = await get(`/api/bap/v1/goals/${goalId}/assessment`, { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });

  test('GET /goals/:id/assessments returns full history, paginated', async () => {
    const goalId = insertGoal({ title: 'History goal' });
    insertAssessment(goalId);
    insertAssessment(goalId);
    const { status, body } = await get(`/api/bap/v1/goals/${goalId}/assessments`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.assessments).toHaveLength(2);
  });

  test('GET /goals/:id/strategies returns candidates, recommended first', async () => {
    const goalId = insertGoal({ title: 'Multi-strategy goal' });
    const assessmentId = insertAssessment(goalId);
    insertStrategy(goalId, assessmentId, { name: 'Plan B' });
    const recommendedId = insertStrategy(goalId, assessmentId, { name: 'Plan A', is_recommended: 1 });
    const { status, body } = await get(`/api/bap/v1/goals/${goalId}/strategies`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.strategies[0].id).toBe(recommendedId);
    expect(body.strategies[0].is_recommended).toBe(true);
  });

  test('GET detail exposes strategic_planning block', async () => {
    const goalId = insertGoal({ title: 'Detail with planning' });
    const assessmentId = insertAssessment(goalId);
    insertStrategy(goalId, assessmentId);
    const { body } = await get(`/api/bap/v1/goals/${goalId}`, { 'BAP-Key': keyRead });
    expect(body.strategic_planning.latest_assessment.id).toBe(assessmentId);
    expect(body.strategic_planning.strategy_count).toBe(1);
  });
});

describe('POST /goals/:goalId/plan', () => {
  test('202s and requires goals:update + Idempotency-Key', async () => {
    const goalId = insertGoal({ title: 'Plan me' });
    const noPerm = await post(`/api/bap/v1/goals/${goalId}/plan`, {}, { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() });
    expect(noPerm.status).toBe(403);

    const noKey = await post(`/api/bap/v1/goals/${goalId}/plan`, {}, { 'BAP-Key': keyFull });
    expect(noKey.status).toBe(400);

    const { status, body } = await post(`/api/bap/v1/goals/${goalId}/plan`, {}, { 'BAP-Key': keyFull, 'Idempotency-Key': generateId() });
    expect(status).toBe(202);
    expect(body.status).toBe('planning');
  });
});

describe('GET /goals/:goalId/timeline', () => {
  test('merges goal_created, progress checks, and decisions into one chronological list', async () => {
    const goalId = insertGoal({ title: 'Timeline goal' });
    db.prepare(`INSERT INTO goal_checks (id, goal_id, business_id, metric_value, progress_pct, checked_at) VALUES (?, ?, ?, 15, 50, CURRENT_TIMESTAMP)`).run(generateId(), goalId, BIZ_A);
    db.prepare(`
      INSERT INTO decisions (id, business_id, decision_type, title, decision, author, related_goal_id, created_at)
      VALUES (?, ?, 'strategy_selection', 'Chose SEO-first', 'x', 'human', ?, CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ_A, goalId);

    const { status, body } = await get(`/api/bap/v1/goals/${goalId}/timeline`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.goal_id).toBe(goalId);
    const types = body.events.map((e: any) => e.type);
    expect(types).toContain('goal_created');
    expect(types).toContain('progress_check');
    expect(types).toContain('decision');
  });

  test('403 across tenants', async () => {
    const goalId = insertGoal({ business_id: BIZ_B, title: 'B timeline goal' });
    const { status } = await get(`/api/bap/v1/goals/${goalId}/timeline`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});
