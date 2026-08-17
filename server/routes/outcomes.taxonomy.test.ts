/**
 * Issue #63 — Outcome and ROI dashboard: GET /api/outcomes/:businessId now
 * surfaces a `taxonomy_state` + `citation` per outcome item. Covers the
 * acceptance criteria's four required scenarios (missing / delayed /
 * negative / successful outcome data) at the route level, plus the
 * existing :businessId session scoping (cross-business isolation).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import outcomesRouter from './outcomes.js';

const BIZ_A = 'biz_outc_tax_a';
const BIZ_B = 'biz_outc_tax_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function insertTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, target_metric, target_metric_baseline, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'yellow', 'requires_approval', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id,
    (overrides.business_id as string) ?? BIZ_A,
    (overrides.title as string) ?? 'Fixture task',
    (overrides.proposed_by as string) ?? 'agent:outc-tax',
    (overrides.status as string) ?? 'complete',
    (overrides.action_type as string) ?? null,
    'target_metric' in overrides ? (overrides.target_metric as string | null) : 'gsc.total_clicks',
    (overrides.target_metric_baseline as number) ?? 100,
    (overrides.completed_at as string | null) ?? daysAgoIso(30),
  );
  return id;
}

function insertOutcome(taskId: string, weeksAfter: number, verdict: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, taskId, weeksAfter, (overrides.metric_value as number) ?? 130, (overrides.baseline_value as number) ?? 100, (overrides.change_pct as number) ?? 30, verdict);
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Outc Tax A', 'outc-tax-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Outc Tax B', 'outc-tax-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { (req.session as any).userId = 'user_outc_tax'; next(); }); // eslint-disable-line @typescript-eslint/no-explicit-any
  app.use('/api/outcomes', outcomesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (?, ?))`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
});

describe('GET /api/outcomes/:businessId — taxonomy_state + citation (issue #63)', () => {
  test('missing outcome data: no target_metric -> verified_action, no outcome_id citation', async () => {
    const t = insertTask({ title: 'No metric', target_metric: null, status: 'verified' });
    const { status, body } = await get(`/api/outcomes/${BIZ_A}`);
    expect(status).toBe(200);
    const item = body.outcomes.find((o: any) => o.task_id === t);
    expect(item.taxonomy_state).toBe('verified_action');
    expect(item.citation.outcome_id).toBeNull();
    expect(item.final_verdict).toBe('pending'); // legacy field unaffected
  });

  test('delayed outcome (still inside window): target_metric set, no check row -> roi_not_measurable with an expected window', async () => {
    const t = insertTask({ title: 'Still measuring', target_metric: 'gsc.total_clicks', status: 'complete', completed_at: daysAgoIso(5) });
    const { body } = await get(`/api/outcomes/${BIZ_A}`);
    const item = body.outcomes.find((o: any) => o.task_id === t);
    expect(item.taxonomy_state).toBe('roi_not_measurable');
    expect(item.citation.window_end_is_expected).toBe(true);
    expect(item.citation.outcome_id).toBeNull();
  });

  test('negative outcome: worsened verdict -> outcome_measured with a citation to the outcome row', async () => {
    const t = insertTask({ title: 'Went down', target_metric: 'gsc.total_clicks', status: 'verified' });
    const outcomeId = insertOutcome(t, 4, 'worsened', { metric_value: 60, baseline_value: 100, change_pct: -40 });
    const { body } = await get(`/api/outcomes/${BIZ_A}`);
    const item = body.outcomes.find((o: any) => o.task_id === t);
    expect(item.taxonomy_state).toBe('outcome_measured');
    expect(item.final_verdict).toBe('worsened');
    expect(item.citation.outcome_id).toBe(outcomeId);
    expect(item.citation.window_end_is_expected).toBe(false);
  });

  test('successful outcome: improved verdict -> outcome_measured with a citation to the outcome row', async () => {
    const t = insertTask({ title: 'Went up', target_metric: 'gsc.total_clicks', status: 'verified' });
    const outcomeId = insertOutcome(t, 4, 'improved', { metric_value: 150, baseline_value: 100, change_pct: 50 });
    const { body } = await get(`/api/outcomes/${BIZ_A}`);
    const item = body.outcomes.find((o: any) => o.task_id === t);
    expect(item.taxonomy_state).toBe('outcome_measured');
    expect(item.final_verdict).toBe('improved');
    expect(item.citation.outcome_id).toBe(outcomeId);
  });

  test('summary.taxonomy_counts reflects the labelled items returned for this business', async () => {
    const { body } = await get(`/api/outcomes/${BIZ_A}?limit=100`);
    const counts = body.summary.taxonomy_counts;
    const sum = counts.activity + counts.verified_action + counts.outcome_measured + counts.roi_not_measurable;
    expect(sum).toBe(body.outcomes.length);
    expect(counts.outcome_measured).toBeGreaterThanOrEqual(2);
    expect(counts.roi_not_measurable).toBeGreaterThanOrEqual(1);
    expect(counts.verified_action).toBeGreaterThanOrEqual(1);
  });

  test('cross-business isolation: BIZ_B outcomes never appear in BIZ_A response', async () => {
    const otherTask = insertTask({ business_id: BIZ_B, title: 'B-only outcome', target_metric: 'gsc.total_clicks', status: 'verified' });
    insertOutcome(otherTask, 4, 'improved', { metric_value: 999, baseline_value: 100, change_pct: 899 });

    const { body: bodyA } = await get(`/api/outcomes/${BIZ_A}?limit=100`);
    expect(bodyA.outcomes.some((o: any) => o.task_id === otherTask)).toBe(false);

    const { body: bodyB } = await get(`/api/outcomes/${BIZ_B}?limit=100`);
    expect(bodyB.outcomes.some((o: any) => o.task_id === otherTask)).toBe(true);
  });
});
