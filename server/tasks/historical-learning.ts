/**
 * Phase 3 — Historical Learning.
 *
 * Answers "have we seen this before, what happened, did it work, should we
 * repeat or avoid it" from structured evidence (task_outcomes, action_memory)
 * rather than embeddings/semantic search. This is deliberately the single
 * shared implementation of that question — server/routes/bap-outcomes.ts's
 * Phase 2 `actionTypeRecommendation()` and server/brain/goal-reasoner.ts's
 * Phase 3 strategy-scoring both call into this module instead of each
 * keeping their own copy of the same aggregation.
 */
import db from '../db/db.js';
import { computeOutcomeStatus } from './outcome-status.js';

export interface ActionTypeTrackRecord {
  action_type: string;
  sample_size: number;
  success_count: number;
  success_rate: number | null;
}

/**
 * Historical hit-rate for an action_type across this business's already-
 * final outcomes (checks with a >=4-week-after verdict — see
 * outcome-status.ts). `sample_size` counts only *final* outcomes; tasks
 * still mid-measurement are excluded rather than counted as failures.
 */
export function actionTypeTrackRecord(businessId: string, actionType: string | null): ActionTypeTrackRecord | null {
  if (!actionType) return null;
  const rows = db.prepare(
    `SELECT t.id, t.status, t.completed_at, o.weeks_after, o.verdict
     FROM tasks t LEFT JOIN task_outcomes o ON o.task_id = t.id
     WHERE t.business_id = ? AND t.action_type = ? AND t.target_metric IS NOT NULL`
  ).all(businessId, actionType) as Array<{ id: string; status: string; completed_at: string | null; weeks_after: number | null; verdict: string | null }>;

  const byTask = new Map<string, Array<{ weeks_after: number; verdict: string | null }>>();
  const meta = new Map<string, { status: string; completed_at: string | null }>();
  for (const r of rows) {
    meta.set(r.id, { status: r.status, completed_at: r.completed_at });
    if (r.weeks_after != null) {
      if (!byTask.has(r.id)) byTask.set(r.id, []);
      byTask.get(r.id)!.push({ weeks_after: r.weeks_after, verdict: r.verdict });
    }
  }

  let successful = 0;
  let finalCount = 0;
  for (const [taskId, m] of meta) {
    const checks = (byTask.get(taskId) ?? []).sort((a, b) => a.weeks_after - b.weeks_after);
    const result = computeOutcomeStatus({ task_status: m.status, target_metric: 'x', completed_at: m.completed_at, checks });
    if (!result.is_final) continue;
    finalCount++;
    if (result.status === 'successful') successful++;
  }

  return {
    action_type: actionType,
    sample_size: finalCount,
    success_count: successful,
    success_rate: finalCount > 0 ? Math.round((successful / finalCount) * 1000) / 1000 : null,
  };
}

export interface SeenBeforeQuery {
  action_type?: string | null;
  target_url?: string | null;
  target_entity?: string | null;
}

export interface SeenBeforeResult {
  seen_before: boolean;
  prior_instances: Array<{
    task_id: string | null;
    action_memory_id: string;
    title: string;
    completed_at: string | null;
    outcome_measured: boolean;
    outcome_summary: string | null;
  }>;
  track_record: ActionTypeTrackRecord | null;
  recommendation: 'repeat' | 'avoid' | 'insufficient_data';
  recommendation_reasoning: string;
}

/**
 * "Have we seen this before?" — the exact question the spec asks Blueprint
 * to answer continuously. Combines action_memory (has this area/action
 * type been touched before, and when) with task_outcomes (did it work).
 * At least one of action_type / target_url / target_entity is required.
 */
export function haveWeSeenThisBefore(businessId: string, query: SeenBeforeQuery): SeenBeforeResult {
  const { action_type = null, target_url = null, target_entity = null } = query;

  const conditions = ['business_id = ?'];
  const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const matchClauses: string[] = [];
  if (action_type) { matchClauses.push('action_type = ?'); params.push(action_type); }
  if (target_url) { matchClauses.push('target_url = ?'); params.push(target_url); }
  if (target_entity) { matchClauses.push('target_entity = ?'); params.push(target_entity); }
  if (!matchClauses.length) {
    return {
      seen_before: false, prior_instances: [], track_record: null,
      recommendation: 'insufficient_data',
      recommendation_reasoning: 'No action_type, target_url, or target_entity was supplied to search on.',
    };
  }
  conditions.push(`(${matchClauses.join(' OR ')})`);

  const priorRows = db.prepare(
    `SELECT id, task_id, title, outcome_measured, outcome_summary, measurement_window_start
     FROM action_memory WHERE ${conditions.join(' AND ')}
     ORDER BY measurement_window_start DESC LIMIT 20`
  ).all(...params) as Array<{ id: string; task_id: string | null; title: string; outcome_measured: number; outcome_summary: string | null; measurement_window_start: string }>;

  const trackRecord = actionTypeTrackRecord(businessId, action_type);

  let recommendation: SeenBeforeResult['recommendation'] = 'insufficient_data';
  let reasoning = 'No prior instances found — this would be the first time.';
  if (priorRows.length > 0) {
    if (trackRecord && trackRecord.sample_size >= 2 && trackRecord.success_rate != null) {
      if (trackRecord.success_rate >= 0.6) {
        recommendation = 'repeat';
        reasoning = `${trackRecord.success_count}/${trackRecord.sample_size} prior "${action_type}" actions succeeded (${Math.round(trackRecord.success_rate * 100)}%) — worth repeating.`;
      } else if (trackRecord.success_rate <= 0.3) {
        recommendation = 'avoid';
        reasoning = `Only ${trackRecord.success_count}/${trackRecord.sample_size} prior "${action_type}" actions succeeded (${Math.round(trackRecord.success_rate * 100)}%) — avoid repeating without changing the approach.`;
      } else {
        recommendation = 'insufficient_data';
        reasoning = `Mixed results: ${trackRecord.success_count}/${trackRecord.sample_size} prior "${action_type}" actions succeeded — no clear signal either way.`;
      }
    } else {
      recommendation = 'insufficient_data';
      reasoning = `Found ${priorRows.length} prior instance(s) but too few have final measured outcomes to recommend repeating or avoiding.`;
    }
  }

  return {
    seen_before: priorRows.length > 0,
    prior_instances: priorRows.map((r) => ({
      task_id: r.task_id, action_memory_id: r.id, title: r.title,
      completed_at: r.measurement_window_start, outcome_measured: Boolean(r.outcome_measured),
      outcome_summary: r.outcome_summary,
    })),
    track_record: trackRecord,
    recommendation,
    recommendation_reasoning: reasoning,
  };
}
