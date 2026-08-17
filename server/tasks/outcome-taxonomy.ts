/**
 * Four-state outcome taxonomy for the ROI/Outcomes dashboards (issue #63).
 *
 * "Task completed" and "agent was busy" are not evidence of business value.
 * This module labels every task with one of four honest states so the
 * dashboard can never imply more certainty than the data supports:
 *
 *   activity            — the task is still in flight (proposed / approved /
 *                          executing / etc.), or it was abandoned
 *                          (rejected / cancelled / failed) before any
 *                          verified result existed. Nothing beyond "work
 *                          was attempted" can honestly be claimed.
 *   verified_action      — the task completed and Blueprint confirmed the
 *                          work happened, but no target metric is linked to
 *                          it, so no business outcome can ever be measured
 *                          for this specific task.
 *   outcome_measured      — a real measurement was taken and recorded
 *                          (improved, worsened, or no meaningful change).
 *                          Whatever the direction, this is evidence, not
 *                          just activity.
 *   roi_not_measurable    — the task completed and a target metric IS
 *                          linked, but the measurement window hasn't
 *                          produced a result yet (still inside the grace
 *                          period, or the scheduled check hasn't run).
 *                          ROI/£ value must not be claimed here.
 *
 * This is deliberately NOT a new parallel data model. It builds directly on
 * computeOutcomeStatus() (./outcome-status.ts), which already turns the raw
 * task_outcomes verdict vocabulary into a finer-grained status machine
 * (pending/measuring/successful/neutral/unsuccessful/abandoned) used by the
 * BAP outcomes surface. This module only collapses those states into the
 * four coarser buckets the dashboards need, and adds a citation.
 *
 * Every result carries a `citation`: the task id, the specific outcome
 * measurement row it's based on (when one exists), and the exact window
 * dates — so any figure derived from this label can be traced back to its
 * source record, per the issue's "every metric links to its source record
 * and measurement window" acceptance criterion.
 */
import { computeOutcomeStatus, type OutcomeCheckLike } from './outcome-status.js';
import { getActionRegistryEntry } from './action-registry.js';

export type TaxonomyState = 'activity' | 'verified_action' | 'outcome_measured' | 'roi_not_measurable';

export const TAXONOMY_STATES: TaxonomyState[] = [
  'activity', 'verified_action', 'outcome_measured', 'roi_not_measurable',
];

export interface TaxonomyCitation {
  task_id: string;
  /** id of the task_outcomes row this label is based on, if any exists yet. */
  outcome_id: string | null;
  /** ISO timestamp the measurement window opened (task completion). */
  window_start: string | null;
  /** ISO timestamp the window closed (actual check) or is expected to close. */
  window_end: string | null;
  /** true when window_end is a projection (no check has landed yet). */
  window_end_is_expected: boolean;
}

export interface TaxonomyResult {
  state: TaxonomyState;
  reason: string;
  citation: TaxonomyCitation;
}

export interface TaxonomyCheckLike extends OutcomeCheckLike {
  id?: string | null;
  check_date?: string | null;
}

export interface TaxonomyTaskInput {
  task_id: string;
  task_status: string;
  action_type: string | null;
  target_metric: string | null;
  completed_at: string | null;
  /** task_outcomes rows for this task, ascending by weeks_after. */
  checks: TaxonomyCheckLike[];
}

const MEASURED_TASK_STATUSES = new Set(['complete', 'verified']);
const DEFAULT_WINDOW_DAYS = [14, 28];

function measurementWindowDays(actionType: string | null): number[] {
  if (!actionType) return DEFAULT_WINDOW_DAYS;
  const entry = getActionRegistryEntry(actionType);
  return entry?.measurement_window_days?.length ? entry.measurement_window_days : DEFAULT_WINDOW_DAYS;
}

function addDaysIso(iso: string, days: number): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Classify a single task into the four-state taxonomy. Pure function — no
 * DB access — so callers stay in control of scoping (business/agent id)
 * and this can be unit-tested directly.
 */
export function classifyOutcomeTaxonomy(input: TaxonomyTaskInput): TaxonomyResult {
  const { status, is_final } = computeOutcomeStatus({
    task_status: input.task_status,
    target_metric: input.target_metric,
    completed_at: input.completed_at,
    checks: input.checks,
  });

  const latestCheck = input.checks.length ? input.checks[input.checks.length - 1]! : null;

  // ─── Still in flight, or abandoned before any verified result ──────────
  if (status === 'abandoned' || !MEASURED_TASK_STATUSES.has(input.task_status)) {
    return {
      state: 'activity',
      reason: status === 'abandoned'
        ? `Task ended as "${input.task_status}" before any outcome could be verified.`
        : `Task status is "${input.task_status}" — not yet confirmed complete.`,
      citation: {
        task_id: input.task_id,
        outcome_id: null,
        window_start: null,
        window_end: null,
        window_end_is_expected: false,
      },
    };
  }

  // ─── Completed, but nothing was ever set up to measure it ──────────────
  if (status === null) {
    return {
      state: 'verified_action',
      reason: 'The task completed and was confirmed, but no target metric is linked to it — no business outcome can be measured for this action.',
      citation: {
        task_id: input.task_id,
        outcome_id: null,
        window_start: input.completed_at,
        window_end: null,
        window_end_is_expected: false,
      },
    };
  }

  // ─── Completed, metric linked, but the window hasn't produced data yet ──
  if (status === 'pending' || status === 'measuring') {
    const windowDays = measurementWindowDays(input.action_type);
    const finalWindowDays = Math.max(...windowDays);
    const expectedClose = input.completed_at ? addDaysIso(input.completed_at, finalWindowDays) : null;
    return {
      state: 'roi_not_measurable',
      reason: status === 'pending'
        ? `Measurement window is still open.${expectedClose ? ` Final check expected by ${expectedClose}.` : ''}`
        : 'The measurement window has elapsed but the scheduled outcome check has not produced a result yet.',
      citation: {
        task_id: input.task_id,
        outcome_id: null,
        window_start: input.completed_at,
        window_end: expectedClose,
        window_end_is_expected: true,
      },
    };
  }

  // ─── successful / unsuccessful / neutral — a real measurement exists ───
  return {
    state: 'outcome_measured',
    reason: `Measured ${latestCheck?.weeks_after ?? '?'} week(s) after completion (${is_final ? 'final' : 'interim'} check). Result: ${status}.`,
    citation: {
      task_id: input.task_id,
      outcome_id: latestCheck?.id ?? null,
      window_start: input.completed_at,
      window_end: latestCheck?.check_date ?? null,
      window_end_is_expected: false,
    },
  };
}

export function emptyTaxonomyCounts(): Record<TaxonomyState, number> {
  return { activity: 0, verified_action: 0, outcome_measured: 0, roi_not_measurable: 0 };
}
