/**
 * Goal-to-outcome timeline (issue #64).
 *
 * Merges every record that is genuinely linked to a goal — its own
 * lifecycle rows (checks/assessments/strategies), signals, recommendations
 * (tasks), actions (tasks that progressed past 'proposed'), decisions,
 * conflicts and measured outcomes (task_outcomes) — into one chronological,
 * evidenced feed, then adds explicit "gap" entries for expected steps that
 * never happened rather than silently omitting them.
 *
 * Kept as a pure-ish function over `db` (not inline in the route handler)
 * so it's directly unit-testable without spinning up an Express server.
 */
import db from '../db/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Gap-detection thresholds ──────────────────────────────────────────────
// A goal genuinely needs *some* runway before its absence of a step is a
// meaningful gap rather than just "hasn't happened yet" — these are grace
// periods, not accusations.
const NO_SIGNAL_GRACE_DAYS = 7;
const STALE_ACTIVITY_DAYS = 14;
const RECOMMENDATION_GRACE_DAYS = 7;
// Mirrors outcome-status.ts's own "is_final once a 4-week check exists"
// invariant — 4 weeks is the point at which the outcome-tracking system
// itself considers a task's measurement complete.
const OUTCOME_MEASUREMENT_WINDOW_DAYS = 28;
const OUTCOME_FINAL_WEEKS_AFTER = 4;

export type Attribution = 'correlation' | 'verified_attribution' | null;

export interface TimelineEvent {
  at: string | null;
  /** Event category, e.g. 'goal_created' | 'signal' | 'recommendation' | 'action' | 'decision' | 'outcome_measured' | 'gap' | ... */
  type: string;
  /** Which subsystem/table this came from, e.g. 'goals' | 'signals' | 'tasks' | 'decisions' | 'task_outcomes' | 'gap_detector'. */
  source: string;
  summary: string;
  /** Short status label from the underlying record (task status, verdict, conflict status, ...), when one exists. */
  status: string | null;
  /** Short evidence string from the underlying record (description/reasoning/verdict detail), when one exists. */
  evidence: string | null;
  /** business_id this event belongs to — always the goal's own business, included explicitly so isolation is visible in the payload, not just enforced by the query. */
  business_scope: string;
  /**
   * 'verified_attribution': the record has a genuine goal_id FK / explicit
   * goal reference to *this* goal AND either is the goal's own lifecycle
   * data or carries measured evidence (a task_outcomes verdict, or a
   * decision citing measured evidence).
   * 'correlation': the record is linked to the goal (proposed/actioned
   * while it was active) but its actual causal effect on the goal is not
   * yet backed by a measured outcome — i.e. it merely correlates in time,
   * not yet verified as having moved the goal.
   * null: not applicable (gap entries — an absence has no attribution).
   */
  attribution: Attribution;
  /** For gap entries only: why this is considered a gap. */
  reason?: string;
  /** For gap entries only: which detection rule produced it. */
  gap_type?: 'no_signal_linked' | 'stale_activity' | 'no_downstream_action' | 'no_measured_outcome';
  data: Record<string, unknown>;
}

export interface GoalTimelineResult {
  goal_id: string;
  events: TimelineEvent[];
}

function safeParseArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addDaysIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
}

/**
 * Builds the goal-to-outcome timeline for a single goal, or returns null if
 * the goal doesn't exist in this business (isolation: a goal id that's real
 * but belongs to a *different* business is treated the same as not found).
 */
export function buildGoalTimeline(goalId: string, businessId: string): GoalTimelineResult | null {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND business_id = ?').get(goalId, businessId) as Record<string, unknown> | undefined;
  if (!goal) return null;

  const events: TimelineEvent[] = [];

  // ─── Goal's own lifecycle records (verified_attribution: this data IS
  // the goal's own system of record, not an externally-correlated event) ──

  events.push({
    at: goal.created_at as string,
    type: 'goal_created',
    source: 'goals',
    summary: `Goal created: ${goal.title as string}`,
    status: goal.status as string,
    evidence: null,
    business_scope: businessId,
    attribution: 'verified_attribution',
    data: { created_by: goal.created_by },
  });

  for (const c of db.prepare('SELECT * FROM goal_checks WHERE goal_id = ? AND business_id = ? ORDER BY checked_at ASC').all(goalId, businessId) as Record<string, unknown>[]) {
    events.push({
      at: c.checked_at as string,
      type: 'progress_check',
      source: 'goal_checks',
      summary: `Progress check: ${(c.progress_pct as number | null)?.toFixed?.(0) ?? c.progress_pct}% (${c.status_change ?? 'no change'})`,
      status: (c.status_change as string | null) ?? 'no_change',
      evidence: (c.agent_note as string | null) ?? null,
      business_scope: businessId,
      attribution: 'verified_attribution',
      data: c,
    });
  }

  for (const a of db.prepare('SELECT id, feasibility_verdict, feasibility_confidence, feasibility_reasoning, created_at FROM goal_assessments WHERE goal_id = ? AND business_id = ? ORDER BY created_at ASC').all(goalId, businessId) as Record<string, unknown>[]) {
    events.push({
      at: a.created_at as string,
      type: 'strategic_assessment',
      source: 'goal_assessments',
      summary: `Strategic assessment: ${a.feasibility_verdict ?? 'unknown'} (${Math.round(((a.feasibility_confidence as number | null) ?? 0) * 100)}% confidence)`,
      status: (a.feasibility_verdict as string | null) ?? null,
      evidence: (a.feasibility_reasoning as string | null) ?? null,
      business_scope: businessId,
      attribution: 'verified_attribution',
      data: a,
    });
  }

  for (const s of db.prepare('SELECT id, name, is_recommended, status, summary, created_at FROM goal_strategies WHERE goal_id = ? AND business_id = ? ORDER BY created_at ASC').all(goalId, businessId) as Record<string, unknown>[]) {
    events.push({
      at: s.created_at as string,
      type: 'strategy_proposed',
      source: 'goal_strategies',
      summary: `Strategy proposed: ${s.name}${s.is_recommended ? ' (recommended)' : ''}`,
      status: (s.status as string | null) ?? null,
      evidence: (s.summary as string | null) ?? null,
      business_scope: businessId,
      attribution: 'verified_attribution',
      data: s,
    });
  }

  for (const c of db.prepare(
    "SELECT id, conflict_type, description, status, severity, detected_at FROM conflicts WHERE business_id = ? AND ((entity_a_type = 'goal' AND entity_a_id = ?) OR (entity_b_type = 'goal' AND entity_b_id = ?)) ORDER BY detected_at ASC"
  ).all(businessId, goalId, goalId) as Record<string, unknown>[]) {
    events.push({
      at: c.detected_at as string,
      type: 'conflict_detected',
      source: 'conflicts',
      summary: `Conflict detected: ${c.description}`,
      status: (c.status as string | null) ?? null,
      evidence: (c.description as string | null) ?? null,
      business_scope: businessId,
      attribution: 'verified_attribution',
      data: c,
    });
  }

  if (goal.achieved_at) {
    events.push({
      at: goal.achieved_at as string,
      type: 'goal_achieved',
      source: 'goals',
      summary: `Goal achieved: ${goal.title as string}`,
      status: 'achieved',
      evidence: `Metric reached target (${goal.metric_current ?? '—'} / ${goal.metric_target ?? '—'})`,
      business_scope: businessId,
      attribution: 'verified_attribution',
      data: {},
    });
  }

  // ─── Signals linked to this goal (real signals.goal_id FK) ────────────────
  const signals = db.prepare(
    'SELECT id, type, severity, title, description, status, confidence, created_at FROM signals WHERE goal_id = ? AND business_id = ? ORDER BY created_at ASC'
  ).all(goalId, businessId) as Record<string, unknown>[];
  for (const sig of signals) {
    events.push({
      at: sig.created_at as string,
      type: 'signal',
      source: 'signals',
      summary: `Signal: ${sig.title}`,
      status: (sig.status as string | null) ?? null,
      evidence: (sig.description as string | null) ?? null,
      business_scope: businessId,
      attribution: 'verified_attribution',
      data: sig,
    });
  }

  // ─── Recommendations & actions linked to this goal (real tasks.goal_id
  // FK). A task is a *recommendation* the moment it's proposed; it becomes
  // an *action* once a human/agent moves it past 'proposed' (approved,
  // executing, complete, verified, rejected, cancelled...). Both are
  // 'correlation' by default — a task being linked to the goal only proves
  // it happened during the goal's active window, not that it moved the
  // goal; that upgrade to verified_attribution happens only via a measured
  // task_outcome, emitted separately below. ─────────────────────────────────
  const tasks = db.prepare(
    `SELECT id, title, description, proposed_by, status, action_type, target_metric,
            completed_at, approved_at, started_at, created_at, updated_at, measurement_window_days
     FROM tasks WHERE goal_id = ? AND business_id = ? ORDER BY created_at ASC`
  ).all(goalId, businessId) as Record<string, unknown>[];

  for (const t of tasks) {
    events.push({
      at: t.created_at as string,
      type: 'recommendation',
      source: 'tasks',
      summary: `Recommendation: ${t.title} (proposed by ${t.proposed_by})`,
      status: t.status as string,
      evidence: (t.description as string | null) ?? null,
      business_scope: businessId,
      attribution: 'correlation',
      data: t,
    });

    if (t.status !== 'proposed') {
      const actionAt = (t.approved_at as string | null) ?? (t.started_at as string | null) ?? (t.completed_at as string | null) ?? (t.updated_at as string | null) ?? (t.created_at as string);
      events.push({
        at: actionAt,
        type: 'action',
        source: 'tasks',
        summary: `Action: ${t.title} — ${t.status}`,
        status: t.status as string,
        evidence: (t.description as string | null) ?? null,
        business_scope: businessId,
        attribution: 'correlation',
        data: t,
      });
    }
  }

  // ─── Measured outcomes (task_outcomes for tasks linked to this goal).
  // This is the one category that always carries genuine measured
  // evidence — a metric_value read back against a baseline — so it's
  // always verified_attribution regardless of which way the verdict went. ──
  const outcomes = db.prepare(
    `SELECT o.id, o.task_id, o.check_date, o.weeks_after, o.metric_value, o.baseline_value,
            o.change_pct, o.verdict, o.verdict_detail, t.title AS task_title
     FROM task_outcomes o JOIN tasks t ON t.id = o.task_id
     WHERE t.goal_id = ? AND t.business_id = ?
     ORDER BY o.check_date ASC`
  ).all(goalId, businessId) as Record<string, unknown>[];

  for (const o of outcomes) {
    events.push({
      at: o.check_date as string,
      type: 'outcome_measured',
      source: 'task_outcomes',
      summary: `Outcome measured (${o.weeks_after}w after "${o.task_title}"): ${o.verdict}`,
      status: o.verdict as string | null,
      evidence: (o.verdict_detail as string | null) ?? null,
      business_scope: businessId,
      attribution: 'verified_attribution',
      data: o,
    });
  }

  // ─── Decisions explicitly referencing this goal (decisions.related_goal_id
  // soft-FK). verified_attribution only when the decision itself is grounded
  // in cited evidence or a measured outcome — otherwise it's a judgment call
  // made *about* the goal, not proof the goal was affected. ──────────────────
  const decisions = db.prepare(
    'SELECT id, decision_type, title, decision, reasoning, evidence, confidence, related_outcome_id, created_at FROM decisions WHERE related_goal_id = ? AND business_id = ? ORDER BY created_at ASC'
  ).all(goalId, businessId) as Record<string, unknown>[];
  for (const d of decisions) {
    const evidenceArr = safeParseArray(d.evidence);
    const grounded = evidenceArr.length > 0 || Boolean(d.related_outcome_id);
    events.push({
      at: d.created_at as string,
      type: 'decision',
      source: 'decisions',
      summary: `Decision: ${d.title}`,
      status: (d.decision_type as string | null) ?? null,
      evidence: (d.reasoning as string | null) ?? null,
      business_scope: businessId,
      attribution: grounded ? 'verified_attribution' : 'correlation',
      data: { ...d, evidence: evidenceArr },
    });
  }

  events.sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());

  // ─── Gap detection — expected steps with nothing linked, shown as
  // explicit entries instead of silently omitted. ────────────────────────────
  const gaps: TimelineEvent[] = [];
  const goalCreatedAt = goal.created_at as string;
  const goalActive = goal.status === 'active';

  // 1. No signal has ever been linked to this goal.
  if (signals.length === 0 && daysSince(goalCreatedAt) > NO_SIGNAL_GRACE_DAYS) {
    const anchor = addDaysIso(goalCreatedAt, NO_SIGNAL_GRACE_DAYS);
    gaps.push({
      at: anchor,
      type: 'gap',
      gap_type: 'no_signal_linked',
      source: 'gap_detector',
      summary: 'Gap: no signal ever linked to this goal',
      status: 'gap',
      evidence: null,
      business_scope: businessId,
      attribution: null,
      reason: `No signal has been linked to this goal in the ${daysSince(goalCreatedAt)} days since it was created.`,
      data: { goal_id: goalId, days_since_creation: daysSince(goalCreatedAt) },
    });
  }

  // 2. Stale — no new timeline event since the last one, for an active goal.
  const realAts = events.map((e) => e.at).filter((v): v is string => Boolean(v));
  const lastEventAt = realAts.length > 0 ? realAts[realAts.length - 1]! : goalCreatedAt;
  if (goalActive && daysSince(lastEventAt) > STALE_ACTIVITY_DAYS) {
    const anchor = addDaysIso(lastEventAt, STALE_ACTIVITY_DAYS);
    gaps.push({
      at: anchor,
      type: 'gap',
      gap_type: 'stale_activity',
      source: 'gap_detector',
      summary: `Gap: no linked activity since ${lastEventAt}`,
      status: 'gap',
      evidence: null,
      business_scope: businessId,
      attribution: null,
      reason: `No new timeline event has been linked to this goal in the ${daysSince(lastEventAt)} days since ${lastEventAt}.`,
      data: { goal_id: goalId, last_event_at: lastEventAt, days_stale: daysSince(lastEventAt) },
    });
  }

  // 3. A recommendation exists but has no downstream action (still
  // 'proposed' past the grace period — never approved, rejected, or acted on).
  for (const t of tasks) {
    if (t.status !== 'proposed') continue;
    const createdAt = t.created_at as string;
    if (daysSince(createdAt) <= RECOMMENDATION_GRACE_DAYS) continue;
    const anchor = addDaysIso(createdAt, RECOMMENDATION_GRACE_DAYS);
    gaps.push({
      at: anchor,
      type: 'gap',
      gap_type: 'no_downstream_action',
      source: 'gap_detector',
      summary: `Gap: recommendation "${t.title}" has no downstream action`,
      status: 'gap',
      evidence: null,
      business_scope: businessId,
      attribution: null,
      reason: `Recommendation "${t.title}" has been pending ${daysSince(createdAt)} days with no approval, rejection, or downstream action.`,
      data: { goal_id: goalId, task_id: t.id, days_pending: daysSince(createdAt) },
    });
  }

  // 4. An action was taken and is eligible for outcome tracking, but no
  // measured outcome exists past its measurement window.
  const outcomesByTask = new Map<string, Record<string, unknown>[]>();
  for (const o of outcomes) {
    const list = outcomesByTask.get(o.task_id as string) ?? [];
    list.push(o);
    outcomesByTask.set(o.task_id as string, list);
  }
  for (const t of tasks) {
    if (t.status !== 'complete' && t.status !== 'verified') continue;
    if (!t.target_metric || !t.completed_at) continue;
    const completedAt = t.completed_at as string;
    if (daysSince(completedAt) <= OUTCOME_MEASUREMENT_WINDOW_DAYS) continue;
    const taskOutcomes = outcomesByTask.get(t.id as string) ?? [];
    const hasFinalMeasurement = taskOutcomes.some((o) => (o.weeks_after as number) >= OUTCOME_FINAL_WEEKS_AFTER);
    if (hasFinalMeasurement) continue;
    const anchor = addDaysIso(completedAt, OUTCOME_MEASUREMENT_WINDOW_DAYS);
    gaps.push({
      at: anchor,
      type: 'gap',
      gap_type: 'no_measured_outcome',
      source: 'gap_detector',
      summary: `Gap: action "${t.title}" has no measured outcome`,
      status: 'gap',
      evidence: null,
      business_scope: businessId,
      attribution: null,
      reason: `Action "${t.title}" completed on ${completedAt} but has no measured outcome past its ${OUTCOME_MEASUREMENT_WINDOW_DAYS}-day measurement window.`,
      data: { goal_id: goalId, task_id: t.id, completed_at: completedAt },
    });
  }

  const allEvents = [...events, ...gaps];
  allEvents.sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());

  return { goal_id: goalId, events: allEvents };
}
