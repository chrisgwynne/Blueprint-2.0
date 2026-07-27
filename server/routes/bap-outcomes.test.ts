/**
 * Phase 2 Outcome API tests — server/routes/bap-outcomes.ts. Runs against
 * a real Express instance mounting the actual router.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapOutcomesRouter from './bap-outcomes.ts';

const BIZ_A = 'biz_bap_out_a';
const BIZ_B = 'biz_bap_out_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, confidence, target_metric, target_metric_baseline, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'yellow', 'requires_approval', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, (overrides.business_id as string) ?? BIZ_A, (overrides.title as string) ?? 'Fixture task',
    (overrides.proposed_by as string) ?? 'agent:seo-sentinel', (overrides.status as string) ?? 'complete',
    (overrides.action_type as string) ?? 'meta_update',
    'confidence' in overrides ? (overrides.confidence as number | null) : 0.8,
    'target_metric' in overrides ? (overrides.target_metric as string | null) : 'gsc.avg_ctr',
    (overrides.target_metric_baseline as number) ?? 2.1,
    (overrides.completed_at as string) ?? null,
  );
  return id;
}

function insertCheck(taskId: string, weeksAfter: number, verdict: string, overrides: Partial<Record<string, unknown>> = {}): void {
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(generateId(), taskId, weeksAfter, (overrides.metric_value as number) ?? 2.5, (overrides.baseline_value as number) ?? 2.1, (overrides.change_pct as number) ?? 19, verdict);
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Out A', 'bap-out-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Out B', 'bap-out-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_out_read'`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Outcomes Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_out_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['outcomes:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapOutcomesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (?, ?))`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id = 'agt_out_read'`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_out_read'`).run();
});

describe('GET /businesses/:id/outcomes', () => {
  test('lists tasks with a target_metric, mapping verdicts to the wider status vocabulary', async () => {
    const successTask = insertTask({ title: 'Successful one', status: 'verified' });
    insertCheck(successTask, 4, 'improved');
    const worseTask = insertTask({ title: 'Worse one', status: 'verified' });
    insertCheck(worseTask, 4, 'worsened');
    const pendingTask = insertTask({ title: 'Still executing', status: 'executing' });

    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/outcomes`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    const byId: Record<string, any> = Object.fromEntries(body.outcomes.map((o: any) => [o.task_id, o]));
    expect(byId[successTask].status).toBe('successful');
    expect(byId[successTask].is_final).toBe(true);
    expect(byId[worseTask].status).toBe('unsuccessful');
    expect(byId[pendingTask].status).toBe('pending');
  });

  test('excludes tasks without a target_metric entirely', async () => {
    insertTask({ title: 'No metric task', target_metric: null });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/outcomes`, { 'BAP-Key': keyRead });
    expect(body.outcomes.every((o: any) => o.task_title !== 'No metric task')).toBe(true);
  });

  test('filters by mapped status', async () => {
    const t = insertTask({ title: 'Filter target', status: 'verified' });
    insertCheck(t, 4, 'no_change');
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/outcomes?status=neutral`, { 'BAP-Key': keyRead });
    expect(body.outcomes.every((o: any) => o.status === 'neutral')).toBe(true);
    expect(body.outcomes.some((o: any) => o.task_id === t)).toBe(true);
  });

  test('filters by action_type and proposed_by', async () => {
    insertTask({ title: 'GH task', action_type: 'github_issue', proposed_by: 'agent:x', status: 'verified' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/outcomes?action_type=github_issue&proposed_by=agent:x`, { 'BAP-Key': keyRead });
    expect(body.outcomes.every((o: any) => o.action_type === 'github_issue' && o.proposed_by === 'agent:x')).toBe(true);
  });

  test('pagination applied after in-memory status mapping', async () => {
    for (let i = 0; i < 3; i++) insertTask({ title: `Pending page ${i}`, status: 'approved' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/outcomes?status=pending&page=1&limit=2`, { 'BAP-Key': keyRead });
    expect(body.outcomes.length).toBeLessThanOrEqual(2);
    expect(body.pagination.limit).toBe(2);
  });

  test('403 without outcomes:read on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/outcomes`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('GET /tasks/:taskId/outcome', () => {
  test('returns confidence, recommendation, and checks for a single task', async () => {
    const t1 = insertTask({ title: 'History task 1', action_type: 'meta_update', status: 'verified' });
    insertCheck(t1, 4, 'improved');
    const t2 = insertTask({ title: 'History task 2', action_type: 'recommendation_test_type', status: 'verified' });
    insertCheck(t2, 4, 'improved');
    const t3 = insertTask({ title: 'Target task', action_type: 'recommendation_test_type', status: 'verified' });
    insertCheck(t3, 2, 'improved');
    insertCheck(t3, 4, 'improved');

    const { status, body } = await get(`/api/bap/v1/tasks/${t3}/outcome`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.status).toBe('successful');
    expect(body.is_final).toBe(true);
    expect(body.checks.length).toBe(2);
    expect(body.confidence.stated).toBe(0.8);
    expect(body.recommendation.action_type).toBe('recommendation_test_type');
    expect(body.recommendation.sample_size).toBe(2); // t2, t3 share the unique action_type used only in this test
    expect(body.recommendation.success_rate).toBe(1);
  });

  test('404 for unknown task', async () => {
    const { status } = await get('/api/bap/v1/tasks/does-not-exist/outcome', { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });

  test('403 across tenants', async () => {
    const t = insertTask({ business_id: BIZ_B, title: 'B task' });
    const { status } = await get(`/api/bap/v1/tasks/${t}/outcome`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});
