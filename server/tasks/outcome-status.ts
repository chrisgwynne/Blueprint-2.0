/**
 * Maps the DB's actual outcome vocabulary (task_outcomes.verdict:
 * 'improved' | 'worsened' | 'no_change', see server/tasks/outcomes.ts) onto
 * the wider status set Phase 2's BAP surface needs — 'pending', 'measuring',
 * 'successful', 'neutral', 'unsuccessful', 'abandoned' — none of which the
 * DB stores directly. Pure function, no DB access, so it's usable from both
 * the outcomes routes and task-detail's outcome summary without either one
 * re-deriving the mapping differently.
 */

export type OutcomeStatus = 'pending' | 'measuring' | 'successful' | 'neutral' | 'unsuccessful' | 'abandoned';

export interface OutcomeCheckLike {
  weeks_after: number;
  verdict: string | null;
}

export interface OutcomeStatusInput {
  task_status: string;
  target_metric: string | null;
  completed_at: string | null;
  checks: OutcomeCheckLike[]; // ordered ascending by weeks_after
}

const ABANDONED_TASK_STATUSES = new Set(['rejected', 'cancelled', 'failed']);
const MEASURED_TASK_STATUSES = new Set(['complete', 'verified']);
const PENDING_GRACE_MS = 14 * 24 * 60 * 60 * 1000; // matches the 2-week check cadence in outcomes.ts

/**
 * `is_final` is true once a 4-week (or later) check exists — outcomes.ts
 * runs checks at 2 and 4 weeks, so a 2-week-only verdict is real data but
 * not yet the last word on this action.
 */
export function computeOutcomeStatus(input: OutcomeStatusInput): { status: OutcomeStatus | null; is_final: boolean } {
  if (ABANDONED_TASK_STATUSES.has(input.task_status)) {
    return { status: 'abandoned', is_final: true };
  }
  if (!input.target_metric) {
    // Not eligible for outcome tracking at all (setTaskTargetMetric never
    // found a mapping/baseline for this action_type) — not the same as
    // "pending", which implies tracking is in progress.
    return { status: null, is_final: false };
  }

  if (input.checks.length === 0) {
    if (!MEASURED_TASK_STATUSES.has(input.task_status)) return { status: 'pending', is_final: false };
    const completedMs = input.completed_at ? new Date(input.completed_at).getTime() : null;
    if (completedMs != null && Date.now() - completedMs < PENDING_GRACE_MS) return { status: 'pending', is_final: false };
    // Past the first check's due date but the scheduled job hasn't produced
    // a row yet (job hasn't run this cycle, or the metric had no data to
    // compare against) — genuinely "in progress", not stuck.
    return { status: 'measuring', is_final: false };
  }

  const latest = input.checks[input.checks.length - 1]!;
  const isFinal = input.checks.some((c) => c.weeks_after >= 4);
  switch (latest.verdict) {
    case 'improved': return { status: 'successful', is_final: isFinal };
    case 'worsened': return { status: 'unsuccessful', is_final: isFinal };
    case 'no_change': return { status: 'neutral', is_final: isFinal };
    default: return { status: 'measuring', is_final: false };
  }
}
