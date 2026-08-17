/**
 * Brain — Recommendation Comparison (issue #66).
 *
 * Reviewers evaluate recommendations one at a time today, which makes
 * trade-offs and alternatives invisible. This module normalises a set of
 * candidate recommendations into ONE comparable shape so a human can see
 * what is genuinely shared between them and what actually differs.
 *
 * Three properties are load-bearing and are enforced here, not left to the
 * UI's good manners:
 *
 *  1. NOTHING IS FABRICATED. Every comparable field is a `ComparableField`
 *     carrying an explicit state: `known` (with a citation naming the
 *     record or computation it came from), `unknown` (with the reason the
 *     data does not exist), or `not_comparable` (the value exists but
 *     cannot be put on the same scale as the other candidates'). There is
 *     no code path that substitutes a default, an average, or a zero for a
 *     missing number. A reviewer sees the hole.
 *
 *  2. THE COMPARISON IS READ-ONLY. Building a comparison performs no
 *     approval, enqueues no execution_jobs row, calls no executor, and
 *     changes no task status. It only reads, plus the one documented
 *     read-through refresh noted on `evaluateApplicability` below. The
 *     module deliberately imports nothing from tasks/executor.ts,
 *     tasks/task-queue.ts or tasks/execution-worker.ts, so an accidental
 *     side effect cannot be introduced without adding an import that
 *     stands out in review.
 *
 *  3. IT REUSES THE REAL ENGINES. The policy constraints shown are the
 *     effective per-business Operating Policy (#68, server/policy/
 *     operating-policy.ts) each candidate would ACTUALLY be evaluated
 *     against — resolved once and shared, never a parallel constraint
 *     model invented for the comparison view. Risk tiering and evidence
 *     quality come from server/trust/trust-engine.ts
 *     (`calculateApprovalTier`, `evaluateApplicability`). Expected-outcome
 *     honesty comes from the #63 taxonomy
 *     (server/tasks/outcome-taxonomy.ts), so "we have not measured this"
 *     is stated in the same vocabulary the ROI dashboards already use.
 *
 * Selecting a winner is a PREFERENCE, not an execution. `recordComparisonDecision()`
 * writes a real decision-memory row (server/brain/decision-memory.ts) citing
 * the effective policy version — and explicitly does NOT approve, schedule
 * or execute the selected candidate. Approval stays the separate, existing
 * step it has always been.
 */
import db from '../db/db.js';
import {
  resolveOperatingPolicy, tierRank,
  type ApprovalTier, type ResolvedOperatingPolicy,
} from '../policy/operating-policy.js';
import { calculateApprovalTier, evaluateApplicability } from '../trust/trust-engine.js';
import { classifyOutcomeTaxonomy, type TaxonomyResult, type TaxonomyState } from '../tasks/outcome-taxonomy.js';
import { actionTypeTrackRecord } from '../tasks/historical-learning.js';
import { getActionRegistryEntry } from '../tasks/action-registry.js';
import { recordDecision } from './decision-memory.js';

// ─── Honest field envelope ───────────────────────────────────────────────────

export type FieldState = 'known' | 'unknown' | 'not_comparable';

/**
 * One field of one candidate. `value` is ONLY meaningful when
 * `state === 'known'`; in every other state it is null and `reason` says
 * why. This is the mechanism that makes "never fabricate a number"
 * structural rather than a convention.
 */
export interface ComparableField<T> {
  state: FieldState;
  value: T | null;
  /** Record id / table / computation the value came from. Set iff known. */
  citation: string | null;
  /** Why the value is missing or incomparable. Set iff not known. */
  reason: string | null;
}

export function knownField<T>(value: T, citation: string): ComparableField<T> {
  return { state: 'known', value, citation, reason: null };
}
export function unknownField<T>(reason: string): ComparableField<T> {
  return { state: 'unknown', value: null, citation: null, reason };
}
export function notComparableField<T>(reason: string): ComparableField<T> {
  return { state: 'not_comparable', value: null, citation: null, reason };
}

/**
 * Wrap a value that may legitimately be absent. `reason` is used verbatim
 * when it is — so the caller always supplies a specific explanation
 * ("this task has no estimated_cost recorded") rather than a generic "n/a".
 */
function fieldFrom<T>(value: T | null | undefined, citation: string, reason: string): ComparableField<T> {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
    ? unknownField<T>(reason)
    : knownField<T>(value as T, citation);
}

// ─── Candidate identity ──────────────────────────────────────────────────────

export type ComparisonCandidateKind = 'task' | 'opportunity' | 'strategy';

export const COMPARISON_CANDIDATE_KINDS: ComparisonCandidateKind[] = ['task', 'opportunity', 'strategy'];

export interface CandidateRef {
  id: string;
  /** Omit to let the engine locate the id across the three candidate tables. */
  kind?: ComparisonCandidateKind | null;
}

/**
 * Parse a caller-supplied candidate list into `CandidateRef`s. Accepts
 * either `["id1","id2"]` or `[{"id":"id1","kind":"task"}, ...]`.
 *
 * An unrecognised `kind` is rejected rather than silently dropped, so a typo
 * can never quietly change which record was compared. Lives on the engine
 * rather than in a route because both the dashboard router
 * (routes/comparisons.ts) and the BAP router (routes/bap-comparisons.ts)
 * must accept exactly the same shapes — two copies would eventually drift,
 * and a comparison that means different things to a human and to an agent
 * is worse than no comparison at all.
 *
 * Throws a plain Error (routes map it to 400) — this is malformed input, not
 * an honestly-uncomparable set, which is what ComparisonRejectedError means.
 */
export function parseCandidateRefs(raw: unknown): CandidateRef[] {
  if (!Array.isArray(raw)) {
    throw new Error('`candidates` must be an array of ids or { id, kind } objects.');
  }
  return raw.map((entry, i) => {
    if (typeof entry === 'string') return { id: entry };
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const id = obj.id;
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error(`candidates[${i}] is missing a string \`id\`.`);
      }
      const kind = obj.kind;
      if (kind == null) return { id };
      if (typeof kind !== 'string' || !COMPARISON_CANDIDATE_KINDS.includes(kind as ComparisonCandidateKind)) {
        throw new Error(`candidates[${i}].kind must be one of ${COMPARISON_CANDIDATE_KINDS.join(' | ')}.`);
      }
      return { id, kind: kind as ComparisonCandidateKind };
    }
    throw new Error(`candidates[${i}] must be an id string or an { id, kind } object.`);
  });
}

// ─── Rejections and flags ────────────────────────────────────────────────────

export type ComparisonRejectionCode =
  | 'too_few_candidates'
  | 'too_many_candidates'
  | 'duplicate_candidate'
  | 'candidate_not_found'
  | 'cross_business_candidate'
  | 'ambiguous_candidate';

export interface ComparisonRejection {
  code: ComparisonRejectionCode;
  candidate_id: string | null;
  message: string;
}

/**
 * Thrown when the requested set cannot honestly be compared at all — most
 * importantly when a candidate belongs to a different business, which
 * would silently mix two policy regimes and two evidence windows into one
 * table. Routes map this to 422.
 */
export class ComparisonRejectedError extends Error {
  readonly rejections: ComparisonRejection[];
  constructor(rejections: ComparisonRejection[]) {
    super(
      `Comparison rejected — ${rejections.length} problem(s): ` +
      rejections.map((r) => `[${r.code}] ${r.message}`).join(' '),
    );
    this.name = 'ComparisonRejectedError';
    this.rejections = rejections;
  }
}

export type ComparisonWarningCode =
  | 'mixed_decision_classes'
  | 'divergent_evidence_windows'
  | 'no_measured_track_record'
  | 'candidate_has_open_conflict';

export interface ComparisonWarning {
  code: ComparisonWarningCode;
  message: string;
  candidate_ids: string[];
}

export const MAX_COMPARISON_CANDIDATES = 6;

/** Evidence older than this is called out as a divergent window. */
const EVIDENCE_WINDOW_DIVERGENCE_DAYS = 30;

// ─── Candidate snapshot ──────────────────────────────────────────────────────

export interface CandidateEvidence {
  /** When the candidate's own evidence starts (its creation) and ends (now). */
  window_start: string;
  window_end: string;
  window_age_days: number;
  /** The signal that produced this candidate, when one did. */
  source_signal: ComparableField<{ id: string; title: string; detected_at: string | null }>;
  /** Free-form evidence recorded on the candidate row itself. */
  recorded_evidence: ComparableField<unknown[]>;
  /** Is this candidate even applicable given VERIFIED business capabilities? */
  applicability_status: ComparableField<string>;
  applicability_reason: string;
  applicability_capability_keys: string[];
  /** Connector types the action depends on, from the Typed Action Registry. */
  required_connector_types: string[];
  /** Is the candidate's evidence fresh enough under the policy's max_data_age_hours? */
  within_policy_data_age: ComparableField<boolean>;
}

export interface CandidatePolicyView {
  /** Tier this candidate computes to under the SHARED effective policy. */
  approval_tier: ComparableField<ApprovalTier>;
  /** The thresholds/policy citation the tier was computed from. */
  tier_evidence: Record<string, unknown>;
  /** Would this need an explicit human approval under the shared policy? */
  requires_human_approval: ComparableField<boolean>;
  /** Does it sit at or below approvals.auto_approve_max_tier? */
  clears_auto_approve_ceiling: ComparableField<boolean>;
  /** Is the action type in approvals.always_require_human_action_types? */
  always_requires_human_action_type: ComparableField<boolean>;
  /** Connector types this candidate needs that the policy blocks / excludes. */
  connector_types_blocked_by_policy: string[];
  /** Every constraint the shared policy imposes on this candidate, in words. */
  constraint_notes: string[];
}

export interface CandidateExpectedOutcome {
  /** The claim made about impact. A CLAIM — never presented as measured. */
  expected_impact: ComparableField<string>;
  /**
   * The #63 taxonomy state for this candidate right now. For anything still
   * awaiting a decision this is 'activity' — i.e. no outcome has been
   * measured and none can be claimed.
   */
  measured_state: TaxonomyState;
  measured_reason: string;
  measured_citation: TaxonomyResult['citation'] | null;
  /** Measured success rate for this ACTION TYPE across finished tasks. */
  historical_success_rate: ComparableField<number>;
  historical_sample_size: number;
  /** Metric this candidate would be measured against, if one is linked. */
  target_metric: ComparableField<string>;
}

export interface CandidateCost {
  estimated_cost: ComparableField<number>;
  estimated_cost_unit: string | null;
  estimated_effort: ComparableField<string>;
  /** Money the action itself would put at risk, from its payload. */
  financial_exposure_gbp: ComparableField<number>;
  time_to_impact_days: ComparableField<number>;
}

export interface CandidateRisk {
  approval_tier: ComparableField<ApprovalTier>;
  agent_confidence: ComparableField<number>;
  /** Registry risk_level for the action type, when the action is registered. */
  action_risk_level: ComparableField<string>;
  has_open_conflict: ComparableField<boolean>;
  /** Does the action have a rollback path? */
  supports_rollback: ComparableField<boolean>;
}

export interface ComparisonCandidate {
  id: string;
  kind: ComparisonCandidateKind;
  title: string;
  /** What sort of decision this is — the axis comparability is judged on. */
  decision_class: string;
  action_type: string | null;
  status: string;
  goal_id: string | null;
  goal_title: string | null;
  created_at: string;
  evidence: CandidateEvidence;
  policy: CandidatePolicyView;
  expected_outcome: CandidateExpectedOutcome;
  cost: CandidateCost;
  risk: CandidateRisk;
}

// ─── Shared vs differing ─────────────────────────────────────────────────────

export type DimensionGroup = 'scope' | 'evidence' | 'policy' | 'expected_outcome' | 'cost' | 'risk';
export type DimensionStatus = 'shared' | 'differing' | 'unknown_for_all';

export interface DimensionValue {
  candidate_id: string;
  state: FieldState;
  value: unknown;
  /** Short human-readable rendering — 'unknown' / 'not comparable' when so. */
  display: string;
  reason: string | null;
}

export interface ComparisonDimension {
  key: string;
  label: string;
  group: DimensionGroup;
  status: DimensionStatus;
  /** Only set when status === 'shared'. */
  shared_value: unknown;
  values: DimensionValue[];
  /** Candidates with no honest value for this dimension. */
  unknown_candidate_ids: string[];
  note: string;
}

export interface MissingDataMarker {
  candidate_id: string;
  field: string;
  state: 'unknown' | 'not_comparable';
  reason: string;
}

export interface SharedPolicyView {
  policy_id: string | null;
  policy_version: number;
  policy_scope: ResolvedOperatingPolicy['policy_scope'];
  policy_citation: string;
  thresholds: Record<string, unknown>;
  approvals: Record<string, unknown>;
  autonomy: Record<string, unknown>;
  connectors: Record<string, unknown>;
}

export interface ComparisonResult {
  business_id: string;
  generated_at: string;
  /**
   * Contract marker, always true. Producing this object approved nothing,
   * executed nothing and enqueued nothing.
   */
  read_only: true;
  comparability: {
    status: 'comparable' | 'flagged';
    decision_classes: string[];
    warnings: ComparisonWarning[];
  };
  /** The one policy every candidate below is evaluated against. */
  shared_policy: SharedPolicyView;
  /** The observation window the comparison is drawn from. */
  shared_evidence_window: { start: string; end: string; span_days: number; note: string };
  candidates: ComparisonCandidate[];
  dimensions: ComparisonDimension[];
  shared_dimension_keys: string[];
  differing_dimension_keys: string[];
  unknown_dimension_keys: string[];
  /** Every hole, collected — so a UI can show "what we do not know" at a glance. */
  missing_data: MissingDataMarker[];
}

// ─── Candidate loading ───────────────────────────────────────────────────────

interface RawCandidate {
  id: string;
  kind: ComparisonCandidateKind;
  business_id: string;
  title: string;
  status: string;
  created_at: string;
  action_type: string | null;
  confidence: number | null;
  estimated_cost: number | null;
  estimated_cost_unit: string | null;
  estimated_effort: string | null;
  time_to_impact_days: number | null;
  expected_impact: string | null;
  target_metric: string | null;
  completed_at: string | null;
  payload: Record<string, unknown>;
  evidence: unknown[] | null;
  signal_id: string | null;
  goal_id: string | null;
  goal_title: string | null;
  applicability_status: string | null;
  applicability_reason: string | null;
  /** Origin table + column set, cited on every field derived from this row. */
  source_record: string;
}

function parseJsonValue<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

function loadTask(id: string): RawCandidate | null {
  const row = db.prepare(`
    SELECT t.*, g.title AS goal_title
    FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.id = ?
  `).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const payload = parseJsonValue<Record<string, unknown>>(row.action_payload, {});
  return {
    id: String(row.id),
    kind: 'task',
    business_id: String(row.business_id),
    title: String(row.title),
    status: String(row.status ?? 'proposed'),
    created_at: String(row.created_at ?? new Date().toISOString()),
    action_type: row.action_type ? String(row.action_type) : null,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    // tasks carry no cost estimate column; the honest answer is "unknown",
    // not a zero and not a guess derived from effort.
    estimated_cost: null,
    estimated_cost_unit: null,
    estimated_effort: null,
    time_to_impact_days: null,
    expected_impact: (row.expected_outcome as string | null) ?? (row.estimated_impact as string | null) ?? null,
    target_metric: (row.target_metric as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    payload,
    evidence: null,
    signal_id: (row.signal_id as string | null) ?? null,
    goal_id: (row.goal_id as string | null) ?? null,
    goal_title: (row.goal_title as string | null) ?? null,
    applicability_status: (row.applicability_status as string | null) ?? null,
    applicability_reason: (row.applicability_reason as string | null) ?? null,
    source_record: `tasks#${String(row.id)}`,
  };
}

function loadOpportunity(id: string): RawCandidate | null {
  const row = db.prepare('SELECT * FROM goal_suggestions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const value = typeof row.opportunity_value === 'number' ? row.opportunity_value : null;
  const unit = row.opportunity_unit ? String(row.opportunity_unit) : null;
  return {
    id: String(row.id),
    kind: 'opportunity',
    business_id: String(row.business_id),
    title: String(row.title),
    status: String(row.status ?? 'pending'),
    created_at: String(row.created_at ?? new Date().toISOString()),
    // goal_suggestions overload: connector_source is the closest thing to an
    // action type, and is what the ranking engine already treats as one.
    action_type: row.connector_source ? String(row.connector_source) : null,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    estimated_cost: null,
    estimated_cost_unit: null,
    estimated_effort: null,
    time_to_impact_days: null,
    expected_impact: value != null ? `${value}${unit ? ` ${unit}` : ''}` : null,
    target_metric: (row.metric_name as string | null) ?? null,
    completed_at: null,
    payload: {},
    evidence: parseJsonValue<unknown[]>(row.evidence, []),
    signal_id: null,
    goal_id: (row.accepted_goal_id as string | null) ?? null,
    goal_title: null,
    applicability_status: null,
    applicability_reason: null,
    source_record: `goal_suggestions#${String(row.id)}`,
  };
}

function loadStrategy(id: string): RawCandidate | null {
  const row = db.prepare(`
    SELECT s.*, g.title AS goal_title
    FROM goal_strategies s LEFT JOIN goals g ON g.id = s.goal_id
    WHERE s.id = ?
  `).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    kind: 'strategy',
    business_id: String(row.business_id),
    title: String(row.name),
    status: String(row.status ?? 'candidate'),
    created_at: String(row.created_at ?? new Date().toISOString()),
    action_type: null,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    estimated_cost: typeof row.estimated_cost === 'number' ? row.estimated_cost : null,
    estimated_cost_unit: row.estimated_cost_unit ? String(row.estimated_cost_unit) : null,
    estimated_effort: (row.estimated_effort as string | null) ?? null,
    time_to_impact_days: typeof row.time_to_impact_days === 'number' ? row.time_to_impact_days : null,
    expected_impact: (row.expected_impact_summary as string | null) ?? null,
    target_metric: null,
    completed_at: null,
    payload: {},
    evidence: parseJsonValue<unknown[]>(row.evidence, []),
    signal_id: null,
    goal_id: (row.goal_id as string | null) ?? null,
    goal_title: (row.goal_title as string | null) ?? null,
    applicability_status: null,
    applicability_reason: null,
    source_record: `goal_strategies#${String(row.id)}`,
  };
}

const LOADERS: Record<ComparisonCandidateKind, (id: string) => RawCandidate | null> = {
  task: loadTask,
  opportunity: loadOpportunity,
  strategy: loadStrategy,
};

/**
 * Resolve a ref to its row. When `kind` is omitted the id is looked up in
 * each candidate table; matching in more than one is an explicit
 * `ambiguous_candidate` rejection rather than an arbitrary pick.
 */
function resolveCandidate(ref: CandidateRef): { row: RawCandidate | null; ambiguous: boolean } {
  if (ref.kind) return { row: LOADERS[ref.kind](ref.id), ambiguous: false };
  const hits = COMPARISON_CANDIDATE_KINDS.map((k) => LOADERS[k](ref.id)).filter((r): r is RawCandidate => r !== null);
  if (hits.length > 1) return { row: hits[0]!, ambiguous: true };
  return { row: hits[0] ?? null, ambiguous: false };
}

// ─── Comparability ───────────────────────────────────────────────────────────

function decisionClassOf(raw: RawCandidate): string {
  if (raw.kind !== 'task') return raw.kind;
  if (!raw.action_type) return 'task:no_action_type';
  const entry = getActionRegistryEntry(raw.action_type);
  return entry ? `task:${entry.side_effect_classification}` : 'task:unregistered_action';
}

/**
 * Hard checks. Anything that would make the resulting table dishonest —
 * most of all a candidate from another business, which has its own
 * operating policy, its own connectors and its own evidence window —
 * stops the comparison rather than being quietly dropped.
 */
function validateRefs(businessId: string, refs: CandidateRef[]): RawCandidate[] {
  const rejections: ComparisonRejection[] = [];

  if (refs.length < 2) {
    rejections.push({
      code: 'too_few_candidates', candidate_id: null,
      message: `A comparison needs at least 2 candidates; ${refs.length} supplied.`,
    });
  }
  if (refs.length > MAX_COMPARISON_CANDIDATES) {
    rejections.push({
      code: 'too_many_candidates', candidate_id: null,
      message: `A comparison is capped at ${MAX_COMPARISON_CANDIDATES} candidates; ${refs.length} supplied.`,
    });
  }

  const seen = new Set<string>();
  const rows: RawCandidate[] = [];
  for (const ref of refs) {
    const key = `${ref.kind ?? '*'}:${ref.id}`;
    if (seen.has(key)) {
      rejections.push({
        code: 'duplicate_candidate', candidate_id: ref.id,
        message: `Candidate '${ref.id}' was supplied more than once.`,
      });
      continue;
    }
    seen.add(key);

    const { row, ambiguous } = resolveCandidate(ref);
    if (ambiguous) {
      rejections.push({
        code: 'ambiguous_candidate', candidate_id: ref.id,
        message: `Id '${ref.id}' exists in more than one candidate table; supply an explicit kind (${COMPARISON_CANDIDATE_KINDS.join(' | ')}).`,
      });
      continue;
    }
    if (!row) {
      rejections.push({
        code: 'candidate_not_found', candidate_id: ref.id,
        message: `Candidate '${ref.id}'${ref.kind ? ` of kind '${ref.kind}'` : ''} does not exist.`,
      });
      continue;
    }
    if (row.business_id !== businessId) {
      rejections.push({
        code: 'cross_business_candidate', candidate_id: ref.id,
        message: `Candidate '${ref.id}' belongs to business '${row.business_id}', not '${businessId}'. Recommendations from different businesses are evaluated against different operating policies, connectors and evidence, so they cannot be compared in one scope.`,
      });
      continue;
    }
    rows.push(row);
  }

  if (rejections.length > 0) throw new ComparisonRejectedError(rejections);
  return rows;
}

// ─── Per-candidate snapshot ──────────────────────────────────────────────────

function hasOpenConflict(businessId: string, entityType: string, entityId: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM conflicts WHERE business_id = ? AND status = 'open' AND ((entity_a_type = ? AND entity_a_id = ?) OR (entity_b_type = ? AND entity_b_id = ?))",
  ).get(businessId, entityType, entityId, entityType, entityId));
}

function ageDays(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round(((Date.now() - t) / 86400000) * 10) / 10);
}

function buildCandidate(raw: RawCandidate, policy: ResolvedOperatingPolicy): ComparisonCandidate {
  const doc = policy.document;
  const now = new Date().toISOString();

  // ── Evidence ───────────────────────────────────────────────────────────
  const signalRow = raw.signal_id
    ? db.prepare('SELECT id, title, detected_at FROM signals WHERE id = ?').get(raw.signal_id) as { id: string; title: string; detected_at: string | null } | undefined
    : undefined;

  // `recordSuppression: false` keeps this a pure evaluation — entering
  // comparison mode must never write an applicability suppression that
  // would then hide the candidate from future ranking.
  const applicability = raw.applicability_status
    ? {
        status: raw.applicability_status,
        reason: raw.applicability_reason ?? 'Applicability recorded on the candidate when it was proposed.',
        capability_keys: [] as string[],
      }
    : evaluateApplicability({
        businessId: raw.business_id,
        candidateType: raw.kind,
        candidateKey: raw.id,
        actionType: raw.action_type,
        title: raw.title,
        payload: raw.payload,
        recordSuppression: false,
      });

  const requiredConnectorTypes = raw.kind === 'opportunity'
    ? (raw.action_type ? [raw.action_type] : [])
    : raw.action_type
      ? (getActionRegistryEntry(raw.action_type)?.required_connector_types ?? [])
      : [];

  const evidenceAgeDays = ageDays(raw.created_at);
  const maxAgeHours = doc.connectors.max_data_age_hours;
  const evidence: CandidateEvidence = {
    window_start: raw.created_at,
    window_end: now,
    window_age_days: evidenceAgeDays,
    source_signal: signalRow
      ? knownField({ id: signalRow.id, title: signalRow.title, detected_at: signalRow.detected_at }, `signals#${signalRow.id}`)
      : unknownField(raw.kind === 'task'
        ? 'This task is not linked to a source signal, so no originating observation can be cited.'
        : `A ${raw.kind} candidate carries no signal link in this schema.`),
    recorded_evidence: raw.evidence && raw.evidence.length > 0
      ? knownField(raw.evidence, `${raw.source_record}.evidence`)
      : unknownField(`No evidence array is recorded on ${raw.source_record}.`),
    applicability_status: knownField(String(applicability.status), `${raw.source_record} via trust-engine.evaluateApplicability`),
    applicability_reason: applicability.reason,
    applicability_capability_keys: (applicability as { capability_keys?: string[] }).capability_keys ?? [],
    required_connector_types: requiredConnectorTypes,
    within_policy_data_age: knownField(
      evidenceAgeDays * 24 <= maxAgeHours,
      `operating policy connectors.max_data_age_hours = ${maxAgeHours} vs ${raw.source_record}.created_at`,
    ),
  };

  // ── Policy view (the SAME policy for every candidate) ───────────────────
  const tierResult = calculateApprovalTier({
    actionType: raw.action_type,
    payload: raw.payload,
    baseTier: null,
    agentConfidence: raw.confidence,
    applicabilityStatus: String(applicability.status),
    businessId: raw.business_id,
    policy,
  });
  const tier = tierResult.tier;
  const alwaysHuman = Boolean(raw.action_type && doc.approvals.always_require_human_action_types.includes(raw.action_type));
  const requiresHuman = alwaysHuman
    || tierRank(tier) >= tierRank(doc.approvals.require_human_approval_at_or_above);
  const ceiling = doc.approvals.auto_approve_max_tier;
  const blockedConnectors = requiredConnectorTypes.filter((t) => doc.connectors.blocked_connector_types.includes(t));
  const allowList = doc.connectors.allowed_connector_types;
  const outsideAllowList = allowList.length > 0 ? requiredConnectorTypes.filter((t) => !allowList.includes(t)) : [];

  const constraintNotes: string[] = [];
  constraintNotes.push(`Computes to the '${tier}' approval tier under ${policy.citation}.`);
  if (alwaysHuman) constraintNotes.push(`Action type '${raw.action_type}' is listed in approvals.always_require_human_action_types — it always needs an explicit human approval.`);
  constraintNotes.push(requiresHuman
    ? `Needs an explicit human approval (policy requires one at or above '${doc.approvals.require_human_approval_at_or_above}').`
    : `Sits below the human-approval floor of '${doc.approvals.require_human_approval_at_or_above}'.`);
  if (ceiling === null) constraintNotes.push('No approvals.auto_approve_max_tier is set, so the policy imposes no auto-approval ceiling on this candidate.');
  else if (ceiling === 'none') constraintNotes.push('approvals.auto_approve_max_tier is "none" — nothing may be approved without a human.');
  else constraintNotes.push(tierRank(tier) <= tierRank(ceiling)
    ? `Clears the auto-approve ceiling of '${ceiling}'.`
    : `Exceeds the auto-approve ceiling of '${ceiling}'.`);
  if (doc.autonomy.allow_autonomous_execution === false) constraintNotes.push('autonomy.allow_autonomous_execution is false — nothing runs without a human, whichever candidate is chosen.');
  if (doc.autonomy.dry_run === true) constraintNotes.push('autonomy.dry_run is true — proposals are recorded but nothing is approved autonomously.');
  if (blockedConnectors.length > 0) constraintNotes.push(`Needs connector type(s) ${blockedConnectors.join(', ')}, listed in connectors.blocked_connector_types.`);
  if (outsideAllowList.length > 0) constraintNotes.push(`Needs connector type(s) ${outsideAllowList.join(', ')}, outside connectors.allowed_connector_types (${allowList.join(', ')}).`);

  const policyView: CandidatePolicyView = {
    approval_tier: knownField(tier, `trust-engine.calculateApprovalTier under ${policy.citation}`),
    tier_evidence: tierResult.evidence,
    requires_human_approval: knownField(requiresHuman, `operating policy approvals.require_human_approval_at_or_above = '${doc.approvals.require_human_approval_at_or_above}'`),
    clears_auto_approve_ceiling: ceiling === null
      ? unknownField('This business has not set approvals.auto_approve_max_tier, so there is no ceiling to clear or exceed.')
      : knownField(tierRank(tier) <= tierRank(ceiling), `operating policy approvals.auto_approve_max_tier = '${ceiling}'`),
    always_requires_human_action_type: raw.action_type
      ? knownField(alwaysHuman, `operating policy approvals.always_require_human_action_types`)
      : unknownField(`This ${raw.kind} candidate has no action type, so the always-require-human action list cannot apply to it.`),
    connector_types_blocked_by_policy: [...new Set([...blockedConnectors, ...outsideAllowList])],
    constraint_notes: constraintNotes,
  };

  // ── Expected outcome (honest about what has actually been measured) ─────
  const checks = raw.kind === 'task'
    ? db.prepare('SELECT id, weeks_after, verdict, check_date FROM task_outcomes WHERE task_id = ? ORDER BY weeks_after ASC').all(raw.id) as Array<{ id: string; weeks_after: number; verdict: string | null; check_date: string | null }>
    : [];
  const taxonomy = classifyOutcomeTaxonomy({
    task_id: raw.id,
    task_status: raw.status,
    action_type: raw.action_type,
    target_metric: raw.target_metric,
    completed_at: raw.completed_at,
    checks,
  });
  const track = raw.action_type ? actionTypeTrackRecord(raw.business_id, raw.action_type) : null;

  const expectedOutcome: CandidateExpectedOutcome = {
    expected_impact: fieldFrom(
      raw.expected_impact,
      `${raw.source_record} (stated estimate — a projection, not a measurement)`,
      `No expected impact is recorded on ${raw.source_record}. Nothing can be claimed about this candidate's value.`,
    ),
    measured_state: taxonomy.state,
    measured_reason: taxonomy.reason,
    measured_citation: taxonomy.citation,
    historical_success_rate: track && track.sample_size > 0 && track.success_rate != null
      ? knownField(track.success_rate, `measured outcomes for action_type '${raw.action_type}' (n=${track.sample_size})`)
      : unknownField(raw.action_type
        ? `No completed, measured task of action type '${raw.action_type}' exists for this business yet, so its historical success rate is unknown.`
        : `This ${raw.kind} candidate has no action type, so there is no track record to draw on.`),
    historical_sample_size: track?.sample_size ?? 0,
    target_metric: fieldFrom(
      raw.target_metric,
      `${raw.source_record}.target_metric`,
      `No target metric is linked, so the outcome of this candidate could never be measured — only that the work happened.`,
    ),
  };

  // ── Cost ───────────────────────────────────────────────────────────────
  const exposure = raw.payload.financial_exposure_gbp ?? raw.payload.spend_gbp ?? raw.payload.budget_gbp;
  const cost: CandidateCost = {
    estimated_cost: fieldFrom(
      raw.estimated_cost, `${raw.source_record}.estimated_cost`,
      `No cost estimate is recorded on ${raw.source_record}.`,
    ),
    estimated_cost_unit: raw.estimated_cost_unit,
    estimated_effort: fieldFrom(
      raw.estimated_effort, `${raw.source_record}.estimated_effort`,
      `No effort estimate is recorded on ${raw.source_record}.`,
    ),
    financial_exposure_gbp: typeof exposure === 'number' && Number.isFinite(exposure)
      ? knownField(exposure, `${raw.source_record}.action_payload`)
      : unknownField(`No financial exposure is declared in ${raw.source_record}'s payload. This means "not stated", not "zero".`),
    time_to_impact_days: fieldFrom(
      raw.time_to_impact_days, `${raw.source_record}.time_to_impact_days`,
      `No time-to-impact estimate is recorded on ${raw.source_record}.`,
    ),
  };

  // ── Risk ───────────────────────────────────────────────────────────────
  const registryEntry = raw.action_type ? getActionRegistryEntry(raw.action_type) : null;
  const conflictEntity = raw.kind === 'task' ? 'task' : raw.kind === 'strategy' ? 'goal' : null;
  const conflictId = raw.kind === 'task' ? raw.id : raw.goal_id;
  const risk: CandidateRisk = {
    approval_tier: policyView.approval_tier,
    agent_confidence: fieldFrom(
      raw.confidence, `${raw.source_record}.confidence`,
      `No confidence was recorded by whoever proposed this candidate.`,
    ),
    action_risk_level: registryEntry
      ? knownField(registryEntry.risk_level, `action_registry#${raw.action_type}.risk_level`)
      : unknownField(raw.action_type
        ? `Action type '${raw.action_type}' is not in the action registry, so its risk level is not defined.`
        : `This ${raw.kind} candidate has no action type, so no registry risk level applies.`),
    has_open_conflict: conflictEntity && conflictId
      ? knownField(hasOpenConflict(raw.business_id, conflictEntity, conflictId), `conflicts table, ${conflictEntity} ${conflictId}`)
      : unknownField(`${raw.kind} candidates are not tracked as conflict entities and this one has no linked goal, so open conflicts cannot be determined.`),
    supports_rollback: registryEntry
      ? knownField(registryEntry.supports_rollback, `action_registry#${raw.action_type}.supports_rollback`)
      : unknownField(raw.action_type
        ? `Action type '${raw.action_type}' is not in the action registry, so rollback support is unknown.`
        : `This ${raw.kind} candidate has no action type, so rollback support does not apply.`),
  };

  return {
    id: raw.id,
    kind: raw.kind,
    title: raw.title,
    decision_class: decisionClassOf(raw),
    action_type: raw.action_type,
    status: raw.status,
    goal_id: raw.goal_id,
    goal_title: raw.goal_title,
    created_at: raw.created_at,
    evidence,
    policy: policyView,
    expected_outcome: expectedOutcome,
    cost,
    risk,
  };
}

// ─── Dimensions ──────────────────────────────────────────────────────────────

interface DimensionSpec {
  key: string;
  label: string;
  group: DimensionGroup;
  extract: (c: ComparisonCandidate) => ComparableField<unknown>;
  display?: (value: unknown, c: ComparisonCandidate) => string;
}

function pct(value: unknown): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : String(value);
}

const DIMENSION_SPECS: DimensionSpec[] = [
  {
    key: 'decision_class', label: 'Decision class', group: 'scope',
    extract: (c) => knownField(c.decision_class, `${c.kind} candidate ${c.id}`),
  },
  {
    key: 'evidence_window_age_days', label: 'Evidence age (days)', group: 'evidence',
    extract: (c) => knownField(c.evidence.window_age_days, `${c.kind}#${c.id}.created_at`),
  },
  {
    key: 'evidence_within_policy_data_age', label: 'Evidence fresh enough for policy', group: 'evidence',
    extract: (c) => c.evidence.within_policy_data_age,
  },
  {
    key: 'source_signal', label: 'Originating signal', group: 'evidence',
    extract: (c) => c.evidence.source_signal,
    display: (v) => (v as { title?: string } | null)?.title ?? String(v),
  },
  {
    key: 'applicability_status', label: 'Capability applicability', group: 'evidence',
    extract: (c) => c.evidence.applicability_status,
  },
  {
    key: 'approval_tier', label: 'Approval tier under policy', group: 'policy',
    extract: (c) => c.policy.approval_tier,
  },
  {
    key: 'requires_human_approval', label: 'Requires human approval', group: 'policy',
    extract: (c) => c.policy.requires_human_approval,
  },
  {
    key: 'clears_auto_approve_ceiling', label: 'Clears auto-approve ceiling', group: 'policy',
    extract: (c) => c.policy.clears_auto_approve_ceiling,
  },
  {
    key: 'always_requires_human_action_type', label: 'Always needs a human (action type rule)', group: 'policy',
    extract: (c) => c.policy.always_requires_human_action_type,
  },
  {
    key: 'expected_impact', label: 'Expected impact (claim)', group: 'expected_outcome',
    extract: (c) => c.expected_outcome.expected_impact,
  },
  {
    key: 'measured_outcome_state', label: 'Measured outcome state', group: 'expected_outcome',
    extract: (c) => knownField(c.expected_outcome.measured_state, `outcome taxonomy for ${c.id}`),
  },
  {
    key: 'target_metric', label: 'Target metric', group: 'expected_outcome',
    extract: (c) => c.expected_outcome.target_metric,
  },
  {
    key: 'historical_success_rate', label: 'Measured success rate for this action type', group: 'expected_outcome',
    extract: (c) => c.expected_outcome.historical_success_rate,
    display: (v) => pct(v),
  },
  {
    key: 'estimated_cost', label: 'Estimated cost', group: 'cost',
    extract: (c) => c.cost.estimated_cost,
    display: (v, c) => `${v}${c.cost.estimated_cost_unit ? ` ${c.cost.estimated_cost_unit}` : ''}`,
  },
  {
    key: 'estimated_effort', label: 'Estimated effort', group: 'cost',
    extract: (c) => c.cost.estimated_effort,
  },
  {
    key: 'financial_exposure_gbp', label: 'Declared financial exposure (GBP)', group: 'cost',
    extract: (c) => c.cost.financial_exposure_gbp,
  },
  {
    key: 'time_to_impact_days', label: 'Time to impact (days)', group: 'cost',
    extract: (c) => c.cost.time_to_impact_days,
  },
  {
    key: 'agent_confidence', label: 'Proposer confidence', group: 'risk',
    extract: (c) => c.risk.agent_confidence,
    display: (v) => pct(v),
  },
  {
    key: 'action_risk_level', label: 'Registered action risk level', group: 'risk',
    extract: (c) => c.risk.action_risk_level,
  },
  {
    key: 'has_open_conflict', label: 'Open unresolved conflict', group: 'risk',
    extract: (c) => c.risk.has_open_conflict,
  },
  {
    key: 'supports_rollback', label: 'Rollback available', group: 'risk',
    extract: (c) => c.risk.supports_rollback,
  },
];

function renderDisplay(field: ComparableField<unknown>, spec: DimensionSpec, c: ComparisonCandidate): string {
  if (field.state === 'unknown') return 'unknown';
  if (field.state === 'not_comparable') return 'not comparable';
  if (spec.display) return spec.display(field.value, c);
  if (typeof field.value === 'boolean') return field.value ? 'yes' : 'no';
  return String(field.value);
}

function buildDimensions(candidates: ComparisonCandidate[]): ComparisonDimension[] {
  return DIMENSION_SPECS.map((spec) => {
    const values: DimensionValue[] = candidates.map((c) => {
      const field = spec.extract(c);
      return {
        candidate_id: c.id,
        state: field.state,
        value: field.state === 'known' ? field.value : null,
        display: renderDisplay(field, spec, c),
        reason: field.reason,
      };
    });

    const known = values.filter((v) => v.state === 'known');
    const unknownIds = values.filter((v) => v.state !== 'known').map((v) => v.candidate_id);

    let status: DimensionStatus;
    let sharedValue: unknown = null;
    let note: string;

    if (known.length === 0) {
      status = 'unknown_for_all';
      note = `No candidate has an honest value for "${spec.label}", so this dimension cannot be used to choose between them.`;
    } else {
      const first = JSON.stringify(known[0]!.value);
      const allSame = known.every((v) => JSON.stringify(v.value) === first);
      if (allSame && unknownIds.length === 0) {
        status = 'shared';
        sharedValue = known[0]!.value;
        note = `All candidates share "${spec.label}" (${known[0]!.display}), so it is not a differentiator.`;
      } else if (allSame) {
        status = 'differing';
        note = `Every candidate with a known value agrees on ${known[0]!.display}, but ${unknownIds.length} candidate(s) have no value at all — treat this as an open question, not agreement.`;
      } else {
        status = 'differing';
        note = unknownIds.length > 0
          ? `Candidates differ on "${spec.label}", and ${unknownIds.length} of them have no value recorded.`
          : `Candidates differ on "${spec.label}" — this is a real trade-off.`;
      }
    }

    return {
      key: spec.key, label: spec.label, group: spec.group,
      status, shared_value: sharedValue, values,
      unknown_candidate_ids: unknownIds, note,
    };
  });
}

function collectMissingData(candidates: ComparisonCandidate[]): MissingDataMarker[] {
  const out: MissingDataMarker[] = [];
  const push = (candidateId: string, field: string, f: ComparableField<unknown>) => {
    if (f.state === 'known') return;
    out.push({ candidate_id: candidateId, field, state: f.state, reason: f.reason ?? 'No reason recorded.' });
  };
  for (const c of candidates) {
    push(c.id, 'evidence.source_signal', c.evidence.source_signal);
    push(c.id, 'evidence.recorded_evidence', c.evidence.recorded_evidence);
    push(c.id, 'policy.clears_auto_approve_ceiling', c.policy.clears_auto_approve_ceiling);
    push(c.id, 'policy.always_requires_human_action_type', c.policy.always_requires_human_action_type);
    push(c.id, 'expected_outcome.expected_impact', c.expected_outcome.expected_impact);
    push(c.id, 'expected_outcome.historical_success_rate', c.expected_outcome.historical_success_rate);
    push(c.id, 'expected_outcome.target_metric', c.expected_outcome.target_metric);
    push(c.id, 'cost.estimated_cost', c.cost.estimated_cost);
    push(c.id, 'cost.estimated_effort', c.cost.estimated_effort);
    push(c.id, 'cost.financial_exposure_gbp', c.cost.financial_exposure_gbp);
    push(c.id, 'cost.time_to_impact_days', c.cost.time_to_impact_days);
    push(c.id, 'risk.agent_confidence', c.risk.agent_confidence);
    push(c.id, 'risk.action_risk_level', c.risk.action_risk_level);
    push(c.id, 'risk.has_open_conflict', c.risk.has_open_conflict);
    push(c.id, 'risk.supports_rollback', c.risk.supports_rollback);
  }
  return out;
}

function buildWarnings(candidates: ComparisonCandidate[]): ComparisonWarning[] {
  const warnings: ComparisonWarning[] = [];

  const classes = [...new Set(candidates.map((c) => c.decision_class))];
  if (classes.length > 1) {
    warnings.push({
      code: 'mixed_decision_classes',
      message: `These candidates span ${classes.length} different decision classes (${classes.join(', ')}). They are shown side by side, but they are not like-for-like alternatives — an externally-visible action and an internal one carry different consequences even at the same tier.`,
      candidate_ids: candidates.map((c) => c.id),
    });
  }

  const ages = candidates.map((c) => c.evidence.window_age_days);
  const spread = Math.max(...ages) - Math.min(...ages);
  if (spread > EVIDENCE_WINDOW_DIVERGENCE_DAYS) {
    warnings.push({
      code: 'divergent_evidence_windows',
      message: `The candidates' evidence differs in age by ${spread.toFixed(1)} days. The oldest was proposed against a materially different picture of the business than the newest.`,
      candidate_ids: candidates.map((c) => c.id),
    });
  }

  const noTrack = candidates.filter((c) => c.expected_outcome.historical_success_rate.state !== 'known');
  if (noTrack.length > 0) {
    warnings.push({
      code: 'no_measured_track_record',
      message: `${noTrack.length} of ${candidates.length} candidate(s) have no measured track record at all. Their expected impact is a stated projection with nothing behind it yet.`,
      candidate_ids: noTrack.map((c) => c.id),
    });
  }

  const conflicted = candidates.filter((c) => c.risk.has_open_conflict.state === 'known' && c.risk.has_open_conflict.value === true);
  if (conflicted.length > 0) {
    warnings.push({
      code: 'candidate_has_open_conflict',
      message: `${conflicted.length} candidate(s) have an open, unresolved conflict. Resolve it before treating them as a real option.`,
      candidate_ids: conflicted.map((c) => c.id),
    });
  }

  return warnings;
}

// ─── Public: build a comparison ──────────────────────────────────────────────

/**
 * Build the normalised comparison. READ-ONLY: no approval, no
 * execution_jobs row, no task status change, no decision written.
 *
 * Throws ComparisonRejectedError when the set cannot honestly be compared
 * (cross-business candidates, unknown ids, fewer than two candidates).
 */
export function buildComparison(businessId: string, refs: CandidateRef[]): ComparisonResult {
  const raws = validateRefs(businessId, refs);

  // Resolved ONCE. Every candidate is then measured against the same
  // effective policy — the whole point of "same policy constraints".
  const policy = resolveOperatingPolicy(businessId);
  const doc = policy.document;

  const candidates = raws.map((r) => buildCandidate(r, policy));
  const dimensions = buildDimensions(candidates);
  const warnings = buildWarnings(candidates);

  const windowStart = candidates.reduce((min, c) => (c.created_at < min ? c.created_at : min), candidates[0]!.created_at);
  const windowEnd = new Date().toISOString();
  const spanDays = ageDays(windowStart);

  return {
    business_id: businessId,
    generated_at: windowEnd,
    read_only: true,
    comparability: {
      status: warnings.length > 0 ? 'flagged' : 'comparable',
      decision_classes: [...new Set(candidates.map((c) => c.decision_class))],
      warnings,
    },
    shared_policy: {
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      policy_scope: policy.policy_scope,
      policy_citation: policy.citation,
      thresholds: { ...doc.thresholds },
      approvals: { ...doc.approvals },
      autonomy: { ...doc.autonomy },
      connectors: { ...doc.connectors },
    },
    shared_evidence_window: {
      start: windowStart,
      end: windowEnd,
      span_days: spanDays,
      note: `All candidates are described from evidence available between ${windowStart} and ${windowEnd}. Nothing observed after ${windowEnd} is reflected here.`,
    },
    candidates,
    dimensions,
    shared_dimension_keys: dimensions.filter((d) => d.status === 'shared').map((d) => d.key),
    differing_dimension_keys: dimensions.filter((d) => d.status === 'differing').map((d) => d.key),
    unknown_dimension_keys: dimensions.filter((d) => d.status === 'unknown_for_all').map((d) => d.key),
    missing_data: collectMissingData(candidates),
  };
}

// ─── Public: record the decision ─────────────────────────────────────────────

export type ComparisonOutcome = 'selected' | 'deferred';

export interface RecordComparisonDecisionInput {
  business_id: string;
  candidates: CandidateRef[];
  outcome: ComparisonOutcome;
  /** Required when outcome is 'selected'; must be absent when 'deferred'. */
  selected_candidate_id?: string | null;
  /** Free text. Required — a preference without a reason is not a decision. */
  rationale: string;
  actor: string;
}

export interface ComparisonDecisionRecord {
  decision_id: string;
  business_id: string;
  outcome: ComparisonOutcome;
  selected_candidate_id: string | null;
  policy_id: string | null;
  policy_version: number;
  policy_scope: ResolvedOperatingPolicy['policy_scope'];
  policy_citation: string;
  /**
   * Always false. Recording a comparison outcome states a preference; it
   * does NOT approve, schedule or execute the selected candidate. That
   * remains the separate, existing approval step.
   */
  executed: false;
  approved: false;
  comparison: ComparisonResult;
}

/**
 * Record the outcome of a comparison as a real decision-memory row, citing
 * the effective operating policy version the candidates were compared
 * under.
 *
 * Deliberately writes exactly one row, to `decisions`. It does not touch
 * `tasks`, `execution_jobs`, `approvals` or any executor — choosing a
 * winner here expresses a preference, and approving it stays a separate
 * human step with its own gate.
 */
export function recordComparisonDecision(input: RecordComparisonDecisionInput): ComparisonDecisionRecord {
  const rationale = (input.rationale ?? '').trim();
  if (!rationale) {
    throw new Error('A rationale is required — a recorded decision without a stated reason is not decision memory.');
  }
  if (input.outcome !== 'selected' && input.outcome !== 'deferred') {
    throw new Error(`Unknown comparison outcome '${input.outcome}'. Expected 'selected' or 'deferred'.`);
  }

  // Rebuilding re-runs every validation (business scope included) against
  // the state at the moment of recording, so the decision cites what was
  // actually true then rather than what the client last rendered.
  const comparison = buildComparison(input.business_id, input.candidates);

  const selectedId = input.outcome === 'selected' ? (input.selected_candidate_id ?? null) : null;
  if (input.outcome === 'selected') {
    if (!selectedId) throw new Error("outcome 'selected' requires selected_candidate_id.");
    if (!comparison.candidates.some((c) => c.id === selectedId)) {
      throw new Error(`selected_candidate_id '${selectedId}' is not one of the compared candidates.`);
    }
  } else if (input.selected_candidate_id) {
    throw new Error("outcome 'deferred' must not name a selected_candidate_id — deferring picks no winner.");
  }

  const selected = selectedId ? comparison.candidates.find((c) => c.id === selectedId)! : null;
  const others = comparison.candidates.filter((c) => c.id !== selectedId);

  const title = selected
    ? `Comparison: selected "${selected.title}" over ${others.length} alternative(s)`
    : `Comparison: deferred all ${comparison.candidates.length} candidate(s)`;

  const decisionText = selected
    ? `Selected ${selected.kind} "${selected.title}" (${selected.id}) as the preferred option. This records a preference only — it does not approve or execute the candidate.`
    : `Deferred: none of the ${comparison.candidates.length} compared candidates was selected. No candidate was approved or executed.`;

  const decisionId = recordDecision({
    business_id: input.business_id,
    decision_type: input.outcome === 'selected' ? 'comparison_selection' : 'comparison_deferral',
    title,
    decision: decisionText,
    reasoning: rationale,
    evidence: [
      {
        type: 'comparison',
        generated_at: comparison.generated_at,
        policy_citation: comparison.shared_policy.policy_citation,
        evidence_window: comparison.shared_evidence_window,
        decision_classes: comparison.comparability.decision_classes,
        comparability_status: comparison.comparability.status,
        comparability_warnings: comparison.comparability.warnings,
        shared_dimensions: comparison.shared_dimension_keys,
        differing_dimensions: comparison.differing_dimension_keys,
        dimensions_unknown_for_all: comparison.unknown_dimension_keys,
        missing_data: comparison.missing_data,
        candidates: comparison.candidates.map((c) => ({
          id: c.id, kind: c.kind, title: c.title, decision_class: c.decision_class,
          approval_tier: c.policy.approval_tier.value,
          requires_human_approval: c.policy.requires_human_approval.value,
          confidence: c.risk.agent_confidence.value,
          measured_outcome_state: c.expected_outcome.measured_state,
        })),
      },
    ],
    // Confidence is only ever the selected candidate's OWN recorded
    // confidence. A deferral, or a candidate with no recorded confidence,
    // leaves this null rather than inventing a number for the decision.
    confidence: selected && selected.risk.agent_confidence.state === 'known'
      ? (selected.risk.agent_confidence.value as number)
      : null,
    alternatives_rejected: others.map((c) => ({
      id: c.id, kind: c.kind, title: c.title,
      approval_tier: c.policy.approval_tier.value,
      confidence: c.risk.agent_confidence.state === 'known' ? c.risk.agent_confidence.value : null,
      not_selected_reason: input.outcome === 'deferred'
        ? 'All candidates were deferred; no winner was chosen.'
        : 'Not selected in this comparison.',
    })),
    author: input.actor,
    related_task_id: selected?.kind === 'task' ? selected.id : null,
    related_goal_id: selected?.goal_id ?? null,
    effective_policy_id: comparison.shared_policy.policy_id,
    effective_policy_version: comparison.shared_policy.policy_version,
    effective_policy_scope: comparison.shared_policy.policy_scope,
  });

  return {
    decision_id: decisionId,
    business_id: input.business_id,
    outcome: input.outcome,
    selected_candidate_id: selectedId,
    policy_id: comparison.shared_policy.policy_id,
    policy_version: comparison.shared_policy.policy_version,
    policy_scope: comparison.shared_policy.policy_scope,
    policy_citation: comparison.shared_policy.policy_citation,
    executed: false,
    approved: false,
    comparison,
  };
}

// ─── Public: what can be compared ────────────────────────────────────────────

export interface ComparableCandidateSummary {
  id: string;
  kind: ComparisonCandidateKind;
  title: string;
  decision_class: string;
  status: string;
  created_at: string;
  goal_title: string | null;
  confidence: number | null;
}

/**
 * The pool of candidates a reviewer may pick from, scoped to one business.
 * Read-only; mirrors the candidate set the ranking engine already gathers
 * (proposed tasks, pending opportunities, candidate strategies).
 */
export function listComparableCandidates(businessId: string): ComparableCandidateSummary[] {
  const out: ComparableCandidateSummary[] = [];

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.created_at, t.confidence, t.action_type, g.title AS goal_title
    FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.business_id = ? AND t.status IN ('proposed', 'manual_review', 'deferred')
    ORDER BY t.created_at DESC LIMIT 100
  `).all(businessId) as Array<Record<string, unknown>>;
  for (const t of tasks) {
    out.push({
      id: String(t.id), kind: 'task', title: String(t.title),
      decision_class: decisionClassOf({ kind: 'task', action_type: t.action_type ? String(t.action_type) : null } as RawCandidate),
      status: String(t.status), created_at: String(t.created_at),
      goal_title: (t.goal_title as string | null) ?? null,
      confidence: typeof t.confidence === 'number' ? t.confidence : null,
    });
  }

  const opportunities = db.prepare(`
    SELECT id, title, status, created_at, confidence FROM goal_suggestions
    WHERE business_id = ? AND status = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= CURRENT_TIMESTAMP)
    ORDER BY created_at DESC LIMIT 100
  `).all(businessId) as Array<Record<string, unknown>>;
  for (const o of opportunities) {
    out.push({
      id: String(o.id), kind: 'opportunity', title: String(o.title), decision_class: 'opportunity',
      status: String(o.status), created_at: String(o.created_at), goal_title: null,
      confidence: typeof o.confidence === 'number' ? o.confidence : null,
    });
  }

  const strategies = db.prepare(`
    SELECT s.id, s.name, s.status, s.created_at, s.confidence, g.title AS goal_title
    FROM goal_strategies s LEFT JOIN goals g ON g.id = s.goal_id
    WHERE s.business_id = ? AND s.status = 'candidate'
    ORDER BY s.created_at DESC LIMIT 100
  `).all(businessId) as Array<Record<string, unknown>>;
  for (const s of strategies) {
    out.push({
      id: String(s.id), kind: 'strategy', title: String(s.name), decision_class: 'strategy',
      status: String(s.status), created_at: String(s.created_at),
      goal_title: (s.goal_title as string | null) ?? null,
      confidence: typeof s.confidence === 'number' ? s.confidence : null,
    });
  }

  return out;
}
