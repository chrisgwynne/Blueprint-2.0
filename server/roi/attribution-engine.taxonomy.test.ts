/**
 * Issue #63 — Outcome and ROI dashboard: four-state taxonomy + citations
 * on computeROIReport() and computeAgentROI(). Covers the acceptance
 * criteria's four required scenarios (missing / delayed / negative /
 * successful outcome) plus cross-business isolation.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { computeROIReport } from './attribution-engine.js';
import { computeAgentROI } from './agent-roi.js';

const BIZ_A = 'biz_roi_tax_a';
const BIZ_B = 'biz_roi_tax_b';
const AGENT_ID = 'agent_roi_tax_seo';

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function insertTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, target_metric, target_metric_baseline, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'yellow', 'requires_approval', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id,
    (overrides.business_id as string) ?? BIZ_A,
    (overrides.title as string) ?? 'Fixture task',
    (overrides.proposed_by as string) ?? AGENT_ID,
    (overrides.status as string) ?? 'complete',
    (overrides.action_type as string) ?? null,
    'target_metric' in overrides ? (overrides.target_metric as string | null) : 'gsc.total_clicks',
    (overrides.target_metric_baseline as number) ?? 100,
    (overrides.completed_at as string | null) ?? null,
    (overrides.created_at as string) ?? daysAgoIso(60),
  );
  return id;
}

function insertOutcome(taskId: string, weeksAfter: number, verdict: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, verdict_detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, taskId,
    (overrides.check_date as string) ?? new Date().toISOString(),
    weeksAfter,
    (overrides.metric_value as number) ?? 130,
    (overrides.baseline_value as number) ?? 100,
    (overrides.change_pct as number) ?? 30,
    verdict,
    (overrides.verdict_detail as string) ?? null,
  );
  return id;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug, created_at) VALUES (?, 'ROI Tax A', 'roi-tax-a', ?) ON CONFLICT(id) DO NOTHING`).run(BIZ_A, daysAgoIso(90));
  db.prepare(`INSERT INTO businesses (id, name, slug, created_at) VALUES (?, 'ROI Tax B', 'roi-tax-b', ?) ON CONFLICT(id) DO NOTHING`).run(BIZ_B, daysAgoIso(90));
  db.prepare(`INSERT INTO agents (id, profile_path, name, status) VALUES (?, 'test/agent.md', 'ROI Tax SEO', 'active') ON CONFLICT(id) DO NOTHING`).run(AGENT_ID);
});

afterAll(() => {
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (?, ?))`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM cost_daily WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(AGENT_ID);
});

describe('computeROIReport — outcome taxonomy (issue #63)', () => {
  test('missing outcome data: completed task, no target_metric -> verified_action, not counted as measured', () => {
    const t = insertTask({ title: 'No metric linked', target_metric: null, completed_at: daysAgoIso(10) });
    const report = computeROIReport(BIZ_A)!;
    expect(report.taxonomy.counts.verified_action).toBeGreaterThanOrEqual(1);
    const pending = report.taxonomy.pending_measurement.find((p: any) => p.task_id === t);
    expect(pending).toBeUndefined(); // verified_action is not the same bucket as roi_not_measurable
  });

  test('delayed outcome (still inside window): completed task with target_metric, no check yet -> roi_not_measurable with an expected (not measured) window', () => {
    const t = insertTask({ title: 'Delayed check', target_metric: 'gsc.total_clicks', completed_at: daysAgoIso(5) });
    const report = computeROIReport(BIZ_A)!;
    expect(report.taxonomy.counts.roi_not_measurable).toBeGreaterThanOrEqual(1);
    const pending = report.taxonomy.pending_measurement.find((p: any) => p.task_id === t);
    expect(pending).toBeDefined();
    expect(pending.state).toBe('roi_not_measurable');
    expect(pending.citation.window_end_is_expected).toBe(true);
    expect(pending.citation.outcome_id).toBeNull();
    // No dollar figure should ever be attributed to this task while it's pending.
    const inAttributed = [...report.attributed_improvements, ...report.attributed_declines]
      .some((r: any) => r.task_id === t);
    expect(inAttributed).toBe(false);
  });

  test('negative outcome: worsened verdict -> attributed_declines with taxonomy_state outcome_measured and a full citation', () => {
    const t = insertTask({ title: 'Worsened task', target_metric: 'gsc.total_clicks', completed_at: daysAgoIso(30) });
    const outcomeId = insertOutcome(t, 4, 'worsened', { metric_value: 60, baseline_value: 100, change_pct: -40 });
    const report = computeROIReport(BIZ_A)!;
    const decline = report.attributed_declines.find((r: any) => r.task_id === t);
    expect(decline).toBeDefined();
    expect(decline.taxonomy_state).toBe('outcome_measured');
    expect(decline.citation.task_id).toBe(t);
    expect(decline.citation.outcome_id).toBe(outcomeId);
    expect(decline.citation.window_end_is_expected).toBe(false);
    expect(decline.citation.window_start).not.toBeNull();
    expect(decline.citation.window_end).not.toBeNull();
  });

  test('successful outcome: improved verdict -> attributed_improvements with taxonomy_state outcome_measured and a full citation', () => {
    const t = insertTask({ title: 'Improved task', target_metric: 'gsc.total_clicks', completed_at: daysAgoIso(30) });
    const outcomeId = insertOutcome(t, 4, 'improved', { metric_value: 150, baseline_value: 100, change_pct: 50 });
    const report = computeROIReport(BIZ_A)!;
    const win = report.attributed_improvements.find((r: any) => r.task_id === t);
    expect(win).toBeDefined();
    expect(win.taxonomy_state).toBe('outcome_measured');
    expect(win.citation.outcome_id).toBe(outcomeId);
  });

  test('no_change / inconclusive verdicts still count as outcome_measured taxonomy overall (not roi_not_measurable)', () => {
    const t = insertTask({ title: 'Flat task', target_metric: 'gsc.total_clicks', completed_at: daysAgoIso(30) });
    insertOutcome(t, 4, 'no_change', { metric_value: 101, baseline_value: 100, change_pct: 1 });
    const report = computeROIReport(BIZ_A)!;
    expect(report.taxonomy.counts.outcome_measured).toBeGreaterThanOrEqual(1);
    const stillPending = report.taxonomy.pending_measurement.find((p: any) => p.task_id === t);
    expect(stillPending).toBeUndefined();
  });

  test('cross-business isolation: BIZ_B tasks/outcomes never leak into BIZ_A report totals or citations', () => {
    const otherTask = insertTask({ business_id: BIZ_B, title: 'B-only task', target_metric: 'gsc.total_clicks', completed_at: daysAgoIso(30) });
    insertOutcome(otherTask, 4, 'improved', { metric_value: 999, baseline_value: 100, change_pct: 899 });

    const reportA = computeROIReport(BIZ_A)!;
    const reportB = computeROIReport(BIZ_B)!;

    expect(reportA.business_id).toBe(BIZ_A);
    expect(reportB.business_id).toBe(BIZ_B);

    const aTaskIds = new Set([
      ...reportA.attributed_improvements.map((r: any) => r.task_id),
      ...reportA.attributed_declines.map((r: any) => r.task_id),
      ...reportA.taxonomy.pending_measurement.map((p: any) => p.task_id),
    ]);
    expect(aTaskIds.has(otherTask)).toBe(false);

    const bTaskIds = new Set([
      ...reportB.attributed_improvements.map((r: any) => r.task_id),
    ]);
    expect(bTaskIds.has(otherTask)).toBe(true);
  });
});

describe('computeAgentROI — outcome taxonomy (issue #63)', () => {
  test('taxonomy_counts sums to the agent’s task volume, and top_win/biggest_miss carry citations', () => {
    // shopify.revenue_30d is a direct-revenue metric (server/roi/value-estimator.ts)
    // so estimateMonthlyValue() never needs AOV/traffic baselines to price it —
    // that keeps this test focused on taxonomy citations, not the estimator.
    const winTask = insertTask({ title: 'Agent win', target_metric: 'shopify.revenue_30d', completed_at: daysAgoIso(20), proposed_by: AGENT_ID });
    insertOutcome(winTask, 4, 'improved', { metric_value: 200, baseline_value: 100, change_pct: 100 });
    const missTask = insertTask({ title: 'Agent miss', target_metric: 'shopify.revenue_30d', completed_at: daysAgoIso(20), proposed_by: AGENT_ID });
    insertOutcome(missTask, 4, 'worsened', { metric_value: 40, baseline_value: 100, change_pct: -60 });
    insertTask({ title: 'Agent pending', target_metric: 'gsc.total_clicks', completed_at: daysAgoIso(2), proposed_by: AGENT_ID });
    insertTask({ title: 'Agent no-metric', target_metric: null, completed_at: daysAgoIso(2), proposed_by: AGENT_ID });
    insertTask({ title: 'Agent in-flight', status: 'executing', target_metric: 'gsc.total_clicks', completed_at: null, proposed_by: AGENT_ID });

    const row = computeAgentROI(AGENT_ID, BIZ_A, { window_days: 90 })!;
    expect(row).toBeDefined();
    const counts = row.taxonomy_counts;
    const total = counts.activity + counts.verified_action + counts.outcome_measured + counts.roi_not_measurable;
    expect(total).toBeGreaterThanOrEqual(5); // at least the 5 tasks inserted across this suite
    expect(counts.outcome_measured).toBeGreaterThanOrEqual(2);
    expect(counts.roi_not_measurable).toBeGreaterThanOrEqual(1);
    expect(counts.verified_action).toBeGreaterThanOrEqual(1);
    expect(counts.activity).toBeGreaterThanOrEqual(1);

    expect(row.top_win?.citation?.task_id).toBe(winTask);
    expect(row.top_win?.taxonomy_state).toBe('outcome_measured');
    expect(row.biggest_miss?.citation?.task_id).toBe(missTask);
    expect(row.biggest_miss?.taxonomy_state).toBe('outcome_measured');
  });
});
