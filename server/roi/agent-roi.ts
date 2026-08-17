/**
 * Agent ROI — per-agent cost vs. estimated value produced.
 *
 * Reads:
 *   cost_daily         — LLM spend per agent per day
 *   tasks              — what each agent proposed
 *   task_outcomes      — what those tasks actually did
 *   agent_calibration  — how well the agent's stated confidence predicted reality
 *
 * Writes nothing. This is a read-only rollup consumed by /api/roi routes
 * and (eventually) injected back into agent prompts so each agent knows
 * its own performance.
 *
 * Does NOT hide underperforming agents. An agent whose tasks consistently
 * flat-line or regress is exactly what the operator needs to see.
 */

import db from '../db/db.js';
import { estimateMonthlyValue } from './value-estimator.js';
import { classifyOutcomeTaxonomy, emptyTaxonomyCounts, type TaxonomyResult } from '../tasks/outcome-taxonomy.js';

const DEFAULT_WINDOW_DAYS = 90;

export interface AgentROIRow {
  agent_id: string;
  agent_name: string;
  window_days: number;
  total_cost_usd: number;
  total_tokens: number;
  tasks_proposed: number;
  tasks_approved: number;
  tasks_rejected: number;
  tasks_with_outcomes: number;
  outcomes_improved: number;
  outcomes_worsened: number;
  outcomes_no_change: number;
  improvement_rate_pct: number | null;
  estimated_monthly_value_usd: number;
  roi_ratio: number | null;
  roi_confidence: string;
  calibration_score: number | null;
  calibration_trend: string | null;
  top_win: any | null;
  biggest_miss: any | null;
  status: string;
  /** Issue #63: honest activity/verified_action/outcome_measured/roi_not_measurable
   *  breakdown across every task this agent proposed in the window. */
  taxonomy_counts: Record<'activity' | 'verified_action' | 'outcome_measured' | 'roi_not_measurable', number>;
}

/**
 * Compute an ROI row for a single agent.
 */
export function computeAgentROI(agentId: string, businessId: string, opts: { window_days?: number } = {}): AgentROIRow | null {
  const windowDays = Math.max(1, opts.window_days ?? DEFAULT_WINDOW_DAYS);
  const sinceClause = `datetime('now', '-${windowDays} days')`;

  const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(agentId) as { id: string; name: string } | null;
  if (!agent) return null;

  // ─── Cost ────────────────────────────────────────────────────────────────
  const costRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total,
           COALESCE(SUM(prompt_tokens), 0) as prompt,
           COALESCE(SUM(completion_tokens), 0) as completion,
           COALESCE(SUM(run_count), 0) as runs
      FROM cost_daily
     WHERE agent_id = ? AND business_id = ?
       AND date >= date('now', '-${windowDays} days')
  `).get(agentId, businessId) as { total: number; prompt: number; completion: number; runs: number } | null;

  const totalCostUsd = costRow?.total ?? 0;

  // Different code paths use different conventions for `proposed_by`:
  //   agent-runner passes the bare agentId ('quill')
  //   mesh modules use 'agent:<id>' ('agent:quill')
  // Match both so we don't silently under-count an agent's tasks.
  const prefixedAgent = `agent:${agentId}`;

  // ─── Tasks proposed / approved / measured ────────────────────────────────
  const taskCounts = db.prepare(`
    SELECT
      COUNT(*) as proposed,
      SUM(CASE WHEN status NOT IN ('proposed','rejected') THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
    FROM tasks
    WHERE business_id = ? AND proposed_by IN (?, ?) AND created_at >= ${sinceClause}
  `).get(businessId, agentId, prefixedAgent) as { proposed: number; approved: number; rejected: number } | null;

  const tasksProposed = taskCounts?.proposed ?? 0;
  const tasksApproved = taskCounts?.approved ?? 0;
  const tasksRejected = taskCounts?.rejected ?? 0;

  // ─── Outcomes + improvement rate ─────────────────────────────────────────
  const outcomeRows = db.prepare(`
    SELECT o.task_id, o.verdict, o.change_pct, o.metric_value, o.baseline_value,
           o.weeks_after, o.check_date, o.verdict_detail,
           t.title as task_title, t.target_metric, t.action_type
      FROM task_outcomes o
      JOIN tasks t ON t.id = o.task_id
     WHERE t.business_id = ? AND t.proposed_by IN (?, ?)
       AND o.check_date >= ${sinceClause}
     ORDER BY o.check_date DESC
  `).all(businessId, agentId, prefixedAgent) as any[];

  // Dedup to the latest outcome per task (most tasks get both 2w and 4w checks)
  const latestPerTask = new Map<string, any>();
  for (const o of outcomeRows) {
    const prev = latestPerTask.get(o.task_id);
    if (!prev || o.weeks_after > prev.weeks_after) latestPerTask.set(o.task_id, o);
  }
  const outcomes = [...latestPerTask.values()];
  const tasksWithOutcomes = outcomes.length;
  const improved = outcomes.filter((o: any) => o.verdict === 'improved').length;
  const worsened = outcomes.filter((o: any) => o.verdict === 'worsened').length;
  const flat = outcomes.filter((o: any) => o.verdict === 'no_change').length;
  const improvementRate = tasksWithOutcomes > 0
    ? Math.round((improved / tasksWithOutcomes) * 1000) / 10
    : null;

  // ─── Outcome taxonomy (issue #63) ─────────────────────────────────────────
  // Every task this agent proposed in the window, labelled honestly —
  // reused as the citation source for top_win / biggest_miss below.
  const taxonomyTaskRows = db.prepare(`
    SELECT id, status, action_type, target_metric, completed_at
      FROM tasks WHERE business_id = ? AND proposed_by IN (?, ?) AND created_at >= ${sinceClause}
  `).all(businessId, agentId, prefixedAgent) as Array<{ id: string; status: string; action_type: string | null; target_metric: string | null; completed_at: string | null }>;

  const taxonomyCheckRows = db.prepare(`
    SELECT o.id, o.task_id, o.weeks_after, o.verdict, o.check_date
      FROM task_outcomes o JOIN tasks t ON t.id = o.task_id
     WHERE t.business_id = ? AND t.proposed_by IN (?, ?) AND t.created_at >= ${sinceClause}
     ORDER BY o.weeks_after ASC
  `).all(businessId, agentId, prefixedAgent) as Array<{ id: string; task_id: string; weeks_after: number; verdict: string | null; check_date: string }>;

  const taxonomyChecksByTask = new Map<string, typeof taxonomyCheckRows>();
  for (const c of taxonomyCheckRows) {
    const list = taxonomyChecksByTask.get(c.task_id) ?? [];
    list.push(c);
    taxonomyChecksByTask.set(c.task_id, list);
  }

  const taxonomyByTaskId = new Map<string, TaxonomyResult>();
  const taxonomyCounts = emptyTaxonomyCounts();
  for (const t of taxonomyTaskRows) {
    const result = classifyOutcomeTaxonomy({
      task_id: t.id,
      task_status: t.status,
      action_type: t.action_type,
      target_metric: t.target_metric,
      completed_at: t.completed_at,
      checks: taxonomyChecksByTask.get(t.id) ?? [],
    });
    taxonomyCounts[result.state]++;
    taxonomyByTaskId.set(t.id, result);
  }

  // ─── Estimated monthly value ─────────────────────────────────────────────
  // Sum the estimator output for each improved outcome. Worsened outcomes
  // subtract (they genuinely reduce the agent's net value). Flat outcomes
  // contribute 0 — they cost but didn't move anything.
  let estimatedMonthlyValue = 0;
  let topWin: any | null = null;
  let biggestMiss: any | null = null;
  for (const o of outcomes) {
    if (!o.target_metric) continue;
    const est = estimateMonthlyValue({
      metricName: o.target_metric,
      baselineValue: o.baseline_value,
      currentValue: o.metric_value,
      businessId,
    });
    const usd = est.estimated_usd_per_month;
    if (usd == null) continue;

    if (o.verdict === 'improved') {
      estimatedMonthlyValue += usd;
      if (!topWin || usd > (topWin.estimated_monthly_usd ?? 0)) {
        topWin = {
          task_id: o.task_id,
          task_title: o.task_title,
          metric: o.target_metric,
          change_pct: o.change_pct,
          estimated_monthly_usd: Math.round(usd * 100) / 100,
          taxonomy_state: taxonomyByTaskId.get(o.task_id)?.state ?? 'outcome_measured',
          citation: taxonomyByTaskId.get(o.task_id)?.citation ?? null,
        };
      }
    } else if (o.verdict === 'worsened') {
      const negative = -Math.abs(usd);
      estimatedMonthlyValue += negative;
      if (!biggestMiss || usd > (Math.abs(biggestMiss.estimated_monthly_usd) ?? 0)) {
        biggestMiss = {
          task_id: o.task_id,
          task_title: o.task_title,
          metric: o.target_metric,
          change_pct: o.change_pct,
          estimated_monthly_usd: Math.round(negative * 100) / 100,
          taxonomy_state: taxonomyByTaskId.get(o.task_id)?.state ?? 'outcome_measured',
          citation: taxonomyByTaskId.get(o.task_id)?.citation ?? null,
        };
      }
    }
  }

  // ─── ROI ratio ───────────────────────────────────────────────────────────
  // Express as (monthlyValue × (windowDays / 30)) / totalCost so the ratio
  // is comparable across agents with different task-per-day rates.
  const monthsInWindow = Math.max(0.1, windowDays / 30);
  const roiRatio = totalCostUsd > 0
    ? (estimatedMonthlyValue * monthsInWindow) / totalCostUsd
    : null;

  // ─── ROI confidence ──────────────────────────────────────────────────────
  // Based on outcome volume in the window. Spec mapping.
  let roiConfidence = 'insufficient';
  if (tasksWithOutcomes >= 30) roiConfidence = 'high';
  else if (tasksWithOutcomes >= 15) roiConfidence = 'medium';
  else if (tasksWithOutcomes >= 5) roiConfidence = 'low';

  // ─── Calibration ─────────────────────────────────────────────────────────
  const calibration = db.prepare(`
    SELECT calibration_score, trend
      FROM agent_calibration
     WHERE agent_id = ? AND business_id = ?
     ORDER BY calculated_at DESC LIMIT 1
  `).get(agentId, businessId) as { calibration_score: number; trend: string } | null ?? null;

  // ─── Verdict label ───────────────────────────────────────────────────────
  let status = 'unknown';
  if (tasksWithOutcomes < 5) {
    status = 'too_soon';
  } else if (roiRatio == null) {
    status = 'no_cost_yet';
  } else if (roiRatio >= 5) {
    status = 'strong';
  } else if (roiRatio >= 1) {
    status = 'marginal';
  } else {
    status = 'review_needed';
  }

  return {
    agent_id: agentId,
    agent_name: agent.name,
    window_days: windowDays,
    total_cost_usd: Math.round(totalCostUsd * 10000) / 10000,
    total_tokens: (costRow?.prompt ?? 0) + (costRow?.completion ?? 0),
    tasks_proposed: tasksProposed,
    tasks_approved: tasksApproved,
    tasks_rejected: tasksRejected,
    tasks_with_outcomes: tasksWithOutcomes,
    outcomes_improved: improved,
    outcomes_worsened: worsened,
    outcomes_no_change: flat,
    improvement_rate_pct: improvementRate,
    estimated_monthly_value_usd: Math.round(estimatedMonthlyValue * 100) / 100,
    roi_ratio: roiRatio != null ? Math.round(roiRatio * 10) / 10 : null,
    roi_confidence: roiConfidence,
    calibration_score: calibration?.calibration_score ?? null,
    calibration_trend: calibration?.trend ?? null,
    top_win: topWin,
    biggest_miss: biggestMiss,
    status,
    taxonomy_counts: taxonomyCounts,
  };
}

/**
 * Compute ROI for every installed agent that has activity on this business.
 * Sort order: strongest ROI first, but keep `review_needed` visible at the
 * top so underperformers aren't buried.
 */
export function computeAllAgentROI(businessId: string, opts: { window_days?: number } = {}): AgentROIRow[] {
  const agents = db.prepare(`
    SELECT id FROM agents WHERE status IN ('active', 'paused') ORDER BY id
  `).all() as Array<{ id: string }>;
  const rows: AgentROIRow[] = [];
  for (const a of agents) {
    const row = computeAgentROI(a.id, businessId, opts);
    if (row) rows.push(row);
  }
  // Sort: review_needed first, then by ROI descending. Null ROI at the end.
  rows.sort((a, b) => {
    if (a.status === 'review_needed' && b.status !== 'review_needed') return -1;
    if (b.status === 'review_needed' && a.status !== 'review_needed') return 1;
    const ar = a.roi_ratio ?? -Infinity;
    const br = b.roi_ratio ?? -Infinity;
    return br - ar;
  });
  return rows;
}
