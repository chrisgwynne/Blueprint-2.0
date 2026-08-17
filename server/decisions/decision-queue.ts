/**
 * Decision Centre — the human review queue (#61).
 *
 * Human review was fragmented: proposals awaiting approval lived on the
 * Tasks board, ambiguous execution outcomes sat in 'manual_review' with no
 * dedicated surface, and "why did we decide this" lived in a separate
 * read-only decision log. This module is the one place a reviewer can ask
 * "what needs me right now, and what do I need to know to decide it?".
 *
 * ─── What this is NOT ───────────────────────────────────────────────────────
 *
 * It is NOT a second policy system. Per-business governance — risk
 * thresholds, autonomy limits, which action types always need a human — is
 * server/policy/operating-policy.ts (#68), and this module only READS it:
 *
 *   - resolveOperatingPolicy()  to cite the version in force
 *   - evaluateAutonomyGate()    to ask "could Blueprint have done this
 *                               unattended?", which is exactly what makes an
 *                               item interesting to a human
 *   - calculateApprovalTier()   for the risk tier, under that same policy
 *   - previewPolicyChange()     to show what promoting a one-off decision
 *                               into a standing rule would do
 *
 * Nor is it a parallel record of decisions: every outcome is written through
 * brain/decision-memory.ts's recordDecision(), which since #68 stamps every
 * row with the effective policy id/version/scope. There is no decision-queue
 * table — the queue is a VIEW over tasks, derived on read. A pending decision
 * has no existence independent of the task it is about, so giving it one
 * would just create two things to keep in sync.
 *
 * ─── Lanes: why an item needs a human ───────────────────────────────────────
 *
 * Mixing "approve this routine draft" in with "an action failed ambiguously
 * and we do not know what happened in the external system" is how review
 * fatigue causes real damage. Every item is therefore sorted into a lane
 * that says WHY it is here, computed from the operating policy rather than
 * from a hardcoded opinion:
 *
 *   manual_review — Blueprint does not know the outcome, or has no executor
 *                   for the action. Not routine. Never auto-approvable.
 *   policy_gated  — the operating policy actively holds this back: blocked
 *                   or non-allow-listed connectors, dry-run, an action type
 *                   on always_require_human_action_types, a tier above the
 *                   auto-approval ceiling, or a red tier.
 *   routine       — a human is reviewing it because the approval mode asks
 *                   for review, not because anything is unusual.
 *
 * ─── Overrides ──────────────────────────────────────────────────────────────
 *
 * A human approving something the policy says needs a human is the system
 * working, not an override. A genuine override is approving an item the
 * policy says should be HELD — not applicable to this business, a red tier,
 * a connector the policy blocks, or dry-run mode. Those require a written
 * reason (enforced here, not just in the UI), and the reason is stored on
 * the task and in the decision record.
 */
import db from '../db/db.js';
import {
  approveTask, rejectTask, deferTask, amendTaskPayload, type TaskRow,
} from '../tasks/task-queue.js';
import { getActionRegistryEntry } from '../tasks/action-registry.js';
import { calculateApprovalTier } from '../trust/trust-engine.js';
import {
  evaluateAutonomyGate, previewPolicyChange, resolveOperatingPolicy,
  tierRank, TIER_ORDER,
  type ApprovalTier, type OperatingPolicyPatch, type PolicyPreview,
  type ResolvedOperatingPolicy,
} from '../policy/operating-policy.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type DecisionLane = 'manual_review' | 'policy_gated' | 'routine';

/** What the operating policy thinks should happen to this item. */
export type PolicyRecommendation =
  /** Policy permits it; a human is reviewing by choice or approval mode. */
  | 'approve_allowed'
  /** Policy requires a human, and the reviewer is that human. */
  | 'human_required'
  /** Policy says do not proceed. Approving anyway is an override. */
  | 'hold';

export interface DecisionEvidenceItem {
  type: string;
  summary: string;
  detail?: unknown;
}

export interface PendingDecision {
  task_id: string;
  business_id: string;
  title: string;
  description: string | null;
  status: string;
  /** What Blueprint would actually do if this is approved. */
  required_action: {
    action_type: string | null;
    /** Human-readable label from the action registry, when registered. */
    display_name: string | null;
    /** false when no executor exists — approving cannot make it run. */
    executable: boolean;
    required_connector_types: string[];
    supports_rollback: boolean;
    payload: Record<string, unknown>;
  };
  risk_tier: ApprovalTier;
  risk_evidence: Record<string, unknown>;
  lane: DecisionLane;
  /** Why this item is in that lane, in a sentence a human can act on. */
  lane_reason: string;
  policy_recommendation: PolicyRecommendation;
  /** Non-empty only when policy_recommendation is 'hold'. */
  hold_reasons: string[];
  /** Approving requires a written override reason. */
  requires_override_reason: boolean;
  policy: {
    policy_id: string | null;
    policy_version: number;
    policy_scope: string;
    citation: string;
  };
  /** The recurring class this decision belongs to (see decisionClassOf). */
  decision_class: string;
  evidence: DecisionEvidenceItem[];
  confidence: number | null;
  priority: string;
  estimated_impact: string | null;
  proposed_by: string;
  applicability_status: string | null;
  applicability_reason: string | null;
  amended_by: string | null;
  pre_amendment_payload: Record<string, unknown> | null;
  deferred_until: string | null;
  deferred_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DecisionQueueFilters {
  lane?: DecisionLane;
  risk_tier?: string;
  decision_class?: string;
  /** Include tasks already deferred to a future date. Default false. */
  include_deferred?: boolean;
  limit?: number;
}

/**
 * A recurring decision class: the unit a reusable policy rule is worth
 * writing about. Keyed on action type, because "what kind of thing is
 * this?" is the question a standing rule answers — a rule that applied to
 * one task would not be reusable, and one that applied to everything would
 * not be bounded.
 */
export function decisionClassOf(actionType: string | null | undefined): string {
  const t = (actionType ?? '').trim();
  return t === '' ? 'manual_task_no_action_type' : t;
}

export interface DecisionClassSummary {
  decision_class: string;
  action_type: string | null;
  pending_count: number;
  lanes: Record<DecisionLane, number>;
  highest_risk_tier: ApprovalTier;
  /** Already covered by approvals.always_require_human_action_types (#68). */
  already_has_human_rule: boolean;
  /** How many decisions of this class a human has already made. */
  reviewed_count: number;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

/**
 * Statuses that mean "a human has to look at this". 'proposed' is a
 * proposal awaiting approval; 'manual_review' is an execution whose outcome
 * Blueprint could not determine, or an action with no executor.
 */
const PENDING_STATUSES = ['proposed', 'manual_review'] as const;

/**
 * Build the reviewer-facing view of one task. Exported so the review path
 * can re-derive an item's policy standing at the moment of the decision
 * rather than trusting a classification the client sent back.
 */
export function describePendingDecision(
  row: Record<string, unknown>,
  policy: ResolvedOperatingPolicy,
): PendingDecision {
  const actionType = (row.action_type as string | null) ?? null;
  const payload = parseJson<Record<string, unknown>>(row.action_payload, {});
  const status = String(row.status);
  const registryEntry = actionType ? getActionRegistryEntry(actionType) : null;
  const applicabilityStatus = (row.applicability_status as string | null) ?? null;

  // Re-run the tier under the policy in force now, rather than trusting the
  // tier stored when the task was proposed: the policy may have changed
  // since, and a reviewer must see the risk as it stands today.
  const risk = calculateApprovalTier({
    actionType,
    payload,
    baseTier: (row.trust_tier as string | null) ?? null,
    agentConfidence: (row.confidence as number | null) ?? null,
    applicabilityStatus,
    policy,
  });

  // Ask the #68 gate what Blueprint could do unattended. A non-dashboard
  // actor is passed deliberately — the gate short-circuits to "allowed" for
  // dashboard actors, and the question here is precisely what the policy
  // would say if no human were involved.
  const gate = evaluateAutonomyGate({
    businessId: String(row.business_id),
    approvedBy: 'system:decision-queue',
    actionType,
    tier: risk.tier,
    requiredConnectorTypes: registryEntry?.required_connector_types ?? [],
  });

  const doc = policy.document;
  const holdReasons: string[] = [];
  if (applicabilityStatus === 'not_applicable') {
    holdReasons.push(
      `This action is not applicable to this business: ${row.applicability_reason ?? 'no reason recorded'}.`
    );
  }
  if (risk.tier === 'red') {
    holdReasons.push(
      `Risk tier is 'red' under ${policy.citation} — at or beyond this business's block thresholds ` +
      `(financial exposure >= £${doc.thresholds.financial_exposure_block_gbp}, ` +
      `or more than ${doc.thresholds.affected_records_block} affected records).`
    );
  }
  if (gate.code === 'connector_blocked_by_policy' || gate.code === 'connector_not_in_allow_list'
      || gate.code === 'autonomy_dry_run') {
    holdReasons.push(gate.reason ?? 'Held by this business\'s operating policy.');
  }

  let lane: DecisionLane;
  let laneReason: string;
  if (status === 'manual_review') {
    lane = 'manual_review';
    laneReason = registryEntry && !registryEntry.dispatched_by_executor
      ? `Action type '${actionType}' is registered but has no executor, so approving it could never make it run. ` +
        'A human must carry it out or cancel it.'
      : 'Blueprint could not determine what happened in the external system. ' +
        'A human must confirm the real outcome before anything automated touches this task again.';
  } else if (holdReasons.length > 0) {
    lane = 'policy_gated';
    laneReason = holdReasons[0]!;
  } else if (!gate.allowed) {
    lane = 'policy_gated';
    laneReason = gate.reason ?? 'This business\'s operating policy requires a human on this action.';
  } else {
    // Note what is deliberately NOT a lane: a tier at or above
    // approvals.require_human_approval_at_or_above. That describes the whole
    // queue — every item here is awaiting a human, and the default policy
    // sets that floor at 'yellow', which is also the default trust tier. Using
    // it to mark items "special" would put essentially everything in the
    // gated lane and the distinction would stop meaning anything, which is
    // exactly the review fatigue the lanes exist to prevent. It is still
    // reported on the item as policy_recommendation: 'human_required'.
    lane = 'routine';
    laneReason = 'Routine review — the operating policy places no special hold on this action.';
  }

  const recommendation: PolicyRecommendation =
    holdReasons.length > 0 ? 'hold'
      : lane === 'manual_review' || !gate.allowed
        || tierRank(risk.tier) >= tierRank(doc.approvals.require_human_approval_at_or_above)
        ? 'human_required'
        : 'approve_allowed';

  // Evidence: what the reviewer needs in order to decide, gathered from the
  // records that already exist rather than re-derived or invented.
  const evidence: DecisionEvidenceItem[] = [];
  if (row.description) {
    evidence.push({ type: 'proposal_rationale', summary: String(row.description) });
  }
  evidence.push({
    type: 'risk_assessment',
    summary:
      `Approval tier '${risk.tier}' calculated under ${policy.citation}.`,
    detail: risk.evidence,
  });
  if (row.signal_id) {
    const signal = db.prepare('SELECT id, type, title, severity, created_at, data FROM signals WHERE id = ?')
      .get(row.signal_id as string) as Record<string, unknown> | undefined;
    if (signal) {
      evidence.push({
        type: 'source_signal',
        summary: `Proposed in response to signal "${signal.title}" (${signal.type}, severity ${signal.severity}).`,
        detail: { ...signal, data: parseJson<unknown>(signal.data, {}) },
      });
    }
  }
  if (row.goal_id) {
    const goal = db.prepare('SELECT id, title, status FROM goals WHERE id = ?')
      .get(row.goal_id as string) as Record<string, unknown> | undefined;
    if (goal) {
      evidence.push({
        type: 'related_goal',
        summary: `Serves goal "${goal.title}" (${goal.status}).`,
        detail: goal,
      });
    }
  }
  if (applicabilityStatus && applicabilityStatus !== 'applicable') {
    evidence.push({
      type: 'applicability',
      summary: `Applicability to this business is '${applicabilityStatus}': ${row.applicability_reason ?? 'no reason recorded'}.`,
    });
  }
  const preAmendment = parseJson<Record<string, unknown> | null>(row.pre_amendment_payload, null);
  if (preAmendment) {
    evidence.push({
      type: 'payload_amendment',
      summary: `A reviewer amended the proposed payload${row.amended_by ? ` (${row.amended_by})` : ''}.`,
      detail: { payload_as_proposed: preAmendment, payload_now: payload },
    });
  }
  if (Number(row.degraded_data ?? 0) === 1) {
    evidence.push({
      type: 'data_quality',
      summary: 'This proposal was built from degraded or stale connector data.',
    });
  }

  return {
    task_id: String(row.id),
    business_id: String(row.business_id),
    title: String(row.title),
    description: (row.description as string | null) ?? null,
    status,
    required_action: {
      action_type: actionType,
      display_name: (registryEntry?.display_name as string | null) ?? null,
      executable: actionType ? Boolean(registryEntry?.dispatched_by_executor) : true,
      required_connector_types: registryEntry?.required_connector_types ?? [],
      supports_rollback: Boolean(registryEntry?.supports_rollback),
      payload,
    },
    risk_tier: risk.tier,
    risk_evidence: risk.evidence,
    lane,
    lane_reason: laneReason,
    policy_recommendation: recommendation,
    hold_reasons: holdReasons,
    requires_override_reason: holdReasons.length > 0,
    policy: {
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      policy_scope: policy.policy_scope,
      citation: policy.citation,
    },
    decision_class: decisionClassOf(actionType),
    evidence,
    confidence: (row.confidence as number | null) ?? null,
    priority: String(row.priority ?? 'p2'),
    estimated_impact: (row.estimated_impact as string | null) ?? null,
    proposed_by: String(row.proposed_by ?? 'unknown'),
    applicability_status: applicabilityStatus,
    applicability_reason: (row.applicability_reason as string | null) ?? null,
    amended_by: (row.amended_by as string | null) ?? null,
    pre_amendment_payload: preAmendment,
    deferred_until: (row.deferred_until as string | null) ?? null,
    deferred_reason: (row.deferred_reason as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export interface DecisionQueueResult {
  business_id: string;
  policy: PendingDecision['policy'];
  decisions: PendingDecision[];
  counts: Record<DecisionLane, number> & { total: number };
}

/**
 * The pending queue for exactly one business.
 *
 * Cross-business isolation is structural: business_id is a required
 * argument and is always in the WHERE clause. There is no "all pending
 * decisions" query, because a reviewer acts on behalf of one business at a
 * time and a queue that silently spanned businesses would be the easiest
 * possible way to approve something for the wrong one.
 */
export function listPendingDecisions(
  businessId: string,
  filters: DecisionQueueFilters = {},
): DecisionQueueResult {
  const policy = resolveOperatingPolicy(businessId);

  const statuses = filters.include_deferred
    ? [...PENDING_STATUSES, 'deferred']
    : [...PENDING_STATUSES];
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE business_id = ? AND status IN (${placeholders})
    ORDER BY created_at DESC
  `).all(businessId, ...statuses) as Array<Record<string, unknown>>;

  let decisions = rows.map((r) => describePendingDecision(r, policy));

  if (filters.lane) decisions = decisions.filter((d) => d.lane === filters.lane);
  if (filters.risk_tier) decisions = decisions.filter((d) => d.risk_tier === filters.risk_tier);
  if (filters.decision_class) decisions = decisions.filter((d) => d.decision_class === filters.decision_class);

  // Most-needing-attention first: manual_review, then policy_gated, then
  // routine; within a lane, highest risk first, then oldest first — an
  // item that has been waiting longest should not be buried.
  const laneOrder: Record<DecisionLane, number> = { manual_review: 0, policy_gated: 1, routine: 2 };
  decisions.sort((a, b) =>
    laneOrder[a.lane] - laneOrder[b.lane]
    || tierRank(b.risk_tier) - tierRank(a.risk_tier)
    || String(a.created_at).localeCompare(String(b.created_at))
  );

  const counts = { manual_review: 0, policy_gated: 0, routine: 0, total: decisions.length };
  for (const d of decisions) counts[d.lane]++;

  const limit = Math.min(500, Math.max(1, filters.limit ?? 200));
  return {
    business_id: businessId,
    policy: {
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      policy_scope: policy.policy_scope,
      citation: policy.citation,
    },
    decisions: decisions.slice(0, limit),
    counts,
  };
}

/**
 * One pending decision, scoped to a business.
 *
 * Returns null — never a bare task view — for anything not currently in the
 * queue, because a pending decision has no existence apart from a task a
 * human still owes an answer on. Once reviewed, the record of WHAT was
 * decided lives in brain/decision-memory.ts, not here.
 *
 * (id, business_id) is the isolation boundary, exactly as in
 * requireTaskInBusiness(): a task belonging to another business is simply
 * absent, never a 403 that would confirm the id is real.
 */
export function getPendingDecision(businessId: string, taskId: string): PendingDecision | null {
  const statuses = [...PENDING_STATUSES, 'deferred'];
  const placeholders = statuses.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT * FROM tasks
    WHERE id = ? AND business_id = ? AND status IN (${placeholders})
  `).get(taskId, businessId, ...statuses) as Record<string, unknown> | undefined;
  if (!row) return null;
  return describePendingDecision(row, resolveOperatingPolicy(businessId));
}

/**
 * Recurring decision classes for one business: what kinds of decision keep
 * coming back, and is there already a standing rule for them?
 *
 * This is the input to "should I write a policy rule for this?", and it
 * deliberately reports `already_has_human_rule` from #68's
 * approvals.always_require_human_action_types rather than from any list of
 * its own — there is one place a standing rule lives, and this is a view
 * onto it.
 */
export function listDecisionClasses(businessId: string): {
  business_id: string;
  classes: DecisionClassSummary[];
} {
  const { decisions } = listPendingDecisions(businessId, { limit: 500 });
  const policy = resolveOperatingPolicy(businessId);
  const alwaysHuman = policy.document.approvals.always_require_human_action_types;

  const byClass = new Map<string, DecisionClassSummary>();
  for (const d of decisions) {
    let entry = byClass.get(d.decision_class);
    if (!entry) {
      entry = {
        decision_class: d.decision_class,
        action_type: d.required_action.action_type,
        pending_count: 0,
        lanes: { manual_review: 0, policy_gated: 0, routine: 0 },
        highest_risk_tier: 'green',
        already_has_human_rule: d.required_action.action_type
          ? alwaysHuman.includes(d.required_action.action_type)
          : false,
        reviewed_count: 0,
      };
      byClass.set(d.decision_class, entry);
    }
    entry.pending_count++;
    entry.lanes[d.lane]++;
    if (tierRank(d.risk_tier) > tierRank(entry.highest_risk_tier)) entry.highest_risk_tier = d.risk_tier;
  }

  // How often a human has already decided this class — the honest measure
  // of "recurring". Counted from decisions already recorded against tasks
  // of this action type in THIS business.
  for (const entry of byClass.values()) {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM decisions d
      JOIN tasks t ON t.id = d.related_task_id
      WHERE d.business_id = ?
        AND t.business_id = ?
        AND COALESCE(NULLIF(t.action_type, ''), 'manual_task_no_action_type') = ?
        AND d.decision_type IN ('task_approval', 'task_rejection', 'task_deferral', 'task_amendment')
    `).get(businessId, businessId, entry.decision_class) as { n: number } | undefined;
    entry.reviewed_count = row?.n ?? 0;
  }

  return {
    business_id: businessId,
    classes: [...byClass.values()].sort((a, b) => b.pending_count - a.pending_count),
  };
}

// ─── Review ──────────────────────────────────────────────────────────────────

export type ReviewOutcome = 'approve' | 'reject' | 'defer' | 'amend';

export class DecisionQueueError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'invalid_review') {
    super(message);
    this.name = 'DecisionQueueError';
    this.status = status;
    this.code = code;
  }
}

export interface ReviewDecisionInput {
  businessId: string;
  taskId: string;
  outcome: ReviewOutcome;
  actor: string;
  /** Why — required for reject, defer and amend. */
  reason?: string | null;
  /** Required when approving an item the policy says should be held. */
  overrideReason?: string | null;
  /** amend only: the corrected payload. */
  amendedPayload?: Record<string, unknown> | null;
  /** amend only: approve immediately after amending. Default true. */
  approveAfterAmend?: boolean;
  /** defer only: ISO timestamp to resurface at. */
  deferUntil?: string | null;
}

export interface ReviewDecisionResult {
  outcome: ReviewOutcome;
  task: TaskRow | null;
  /** The policy standing of the item at the moment it was decided. */
  policy_recommendation: PolicyRecommendation;
  override: boolean;
  override_reason: string | null;
  policy: PendingDecision['policy'];
  /** Decision-memory rows written by this review, newest last. */
  decision_ids: string[];
}

const MIN_OVERRIDE_REASON_LENGTH = 15;

/**
 * Look up a task, scoped to a business.
 *
 * The (id, business_id) pair is the isolation boundary: a task id belonging
 * to another business is reported as not found, exactly as if it did not
 * exist. Returning 403 instead would confirm the id is real, which is
 * itself a cross-business leak.
 */
function requireTaskInBusiness(taskId: string, businessId: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND business_id = ?')
    .get(taskId, businessId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new DecisionQueueError(
      `No pending decision '${taskId}' for business '${businessId}'.`, 404, 'not_found',
    );
  }
  return row;
}

/**
 * Record a reviewer's outcome on one pending decision.
 *
 * Every outcome routes through the canonical task-queue function for that
 * transition (approveTask / rejectTask / deferTask / amendTaskPayload), so
 * the decision record, audit entry, action receipt and policy citation are
 * produced by exactly the same code an approval from any other surface
 * produces. This function adds the two things the decision centre is for:
 * business scoping, and the override rule.
 */
export function reviewDecision(input: ReviewDecisionInput): ReviewDecisionResult {
  const row = requireTaskInBusiness(input.taskId, input.businessId);
  const policy = resolveOperatingPolicy(input.businessId);
  const item = describePendingDecision(row, policy);

  const reason = (input.reason ?? '').trim();
  const overrideReason = (input.overrideReason ?? '').trim();

  const willApprove = input.outcome === 'approve'
    || (input.outcome === 'amend' && input.approveAfterAmend !== false);

  // The override rule. Approving an item the policy holds is allowed — a
  // human is the final authority — but never silently.
  let override = false;
  if (willApprove && item.policy_recommendation === 'hold') {
    if (overrideReason.length < MIN_OVERRIDE_REASON_LENGTH) {
      throw new DecisionQueueError(
        'This business\'s operating policy holds this action back: '
        + item.hold_reasons.join(' ')
        + ' Approving it anyway is an override, which requires a written reason of at least '
        + `${MIN_OVERRIDE_REASON_LENGTH} characters explaining why it is safe to proceed. `
        + `(effective ${policy.citation})`,
        422, 'override_reason_required',
      );
    }
    override = true;
  }

  const decisionsBefore = new Set(
    (db.prepare('SELECT id FROM decisions WHERE related_task_id = ?')
      .all(input.taskId) as Array<{ id: string }>).map((d) => d.id)
  );

  let task: TaskRow | null = null;
  switch (input.outcome) {
    case 'approve': {
      if (override) {
        // Stored before the approval so the record exists even if a
        // downstream gate throws — an attempted override is itself a fact.
        db.prepare('UPDATE tasks SET review_override_reason = ? WHERE id = ? AND business_id = ?')
          .run(overrideReason, input.taskId, input.businessId);
      }
      task = approveTask(input.taskId, input.actor);
      break;
    }
    case 'reject': {
      if (!reason) {
        throw new DecisionQueueError(
          'A rejection reason is required: the proposing agent learns from why it was wrong, not that it was.',
          422, 'reason_required',
        );
      }
      task = rejectTask(input.taskId, input.actor, reason);
      break;
    }
    case 'defer': {
      if (!input.deferUntil) {
        throw new DecisionQueueError(
          'defer_until is required: a deferral with no resurface date is an item that silently disappears.',
          422, 'defer_until_required',
        );
      }
      task = deferTask(input.taskId, input.actor, reason, input.deferUntil);
      break;
    }
    case 'amend': {
      if (!input.amendedPayload) {
        throw new DecisionQueueError('amended_payload is required to amend a proposal.', 422, 'amended_payload_required');
      }
      if (override) {
        db.prepare('UPDATE tasks SET review_override_reason = ? WHERE id = ? AND business_id = ?')
          .run(overrideReason, input.taskId, input.businessId);
      }
      task = amendTaskPayload(input.taskId, input.actor, input.amendedPayload, reason);
      if (input.approveAfterAmend !== false) {
        // Approval re-validates the amended payload and recalculates the
        // tier, so an amendment cannot be used to walk an action past the
        // gates its original payload would have failed.
        task = approveTask(input.taskId, input.actor);
      }
      break;
    }
    default:
      throw new DecisionQueueError(
        `Unknown review outcome '${String(input.outcome)}'. Must be approve, reject, defer or amend.`,
      );
  }

  const newDecisionIds = (db.prepare(
    'SELECT id FROM decisions WHERE related_task_id = ? ORDER BY created_at ASC'
  ).all(input.taskId) as Array<{ id: string }>)
    .map((d) => d.id)
    .filter((id) => !decisionsBefore.has(id));

  // Annotate the decision(s) this review produced with the override, so the
  // decision log answers "was this forced through, and why?" without
  // joining back to the task. recordDecision() has already stamped the
  // policy version on them (#68).
  if (override && newDecisionIds.length > 0) {
    for (const decisionId of newDecisionIds) {
      const existing = db.prepare('SELECT reasoning, evidence FROM decisions WHERE id = ?')
        .get(decisionId) as { reasoning: string | null; evidence: string } | undefined;
      if (!existing) continue;
      const evidence = parseJson<unknown[]>(existing.evidence, []);
      evidence.push({
        type: 'policy_override',
        overridden_recommendation: 'hold',
        hold_reasons: item.hold_reasons,
        override_reason: overrideReason,
        overridden_by: input.actor,
        policy_citation: policy.citation,
        policy_id: policy.policy_id,
        policy_version: policy.policy_version,
      });
      db.prepare('UPDATE decisions SET reasoning = ?, evidence = ? WHERE id = ?').run(
        `${existing.reasoning ? `${existing.reasoning}\n\n` : ''}`
        + `POLICY OVERRIDE by ${input.actor}: ${overrideReason} `
        + `(overrode: ${item.hold_reasons.join(' ')}) (effective ${policy.citation})`,
        JSON.stringify(evidence),
        decisionId,
      );
    }
  }

  return {
    outcome: input.outcome,
    task,
    policy_recommendation: item.policy_recommendation,
    override,
    override_reason: override ? overrideReason : null,
    policy: item.policy,
    decision_ids: newDecisionIds,
  };
}

// ─── Promoting a one-off decision into a standing rule ───────────────────────

export type PolicyRuleKind = 'always_require_human' | 'cap_auto_approve_tier';

export interface PolicyRuleProposal {
  business_id: string;
  decision_class: string;
  rule_kind: PolicyRuleKind;
  /** Plain-English statement of the rule being proposed. */
  statement: string;
  /**
   * The patch to apply to #68's operating policy document. The reviewer
   * takes this to the policy editor to test, schedule and save it — this
   * module never writes policy.
   */
  patch: OperatingPolicyPatch;
  /** True when the effective policy already says this. */
  already_in_effect: boolean;
  /** #68's own preview of the change: validation + impact, no writes. */
  preview: PolicyPreview;
}

/**
 * Turn "I keep making this same call by hand" into a proposed rule for the
 * per-business operating policy (#68).
 *
 * This is deliberately a THIN shortcut, not a second policy engine. It
 * builds a patch to the existing policy document and runs it through #68's
 * own previewPolicyChange(), which validates it exactly as the save would.
 * Nothing is written: the reviewer takes the proposal into the policy
 * editor, where versioning, scheduling, testing before activation and the
 * audit trail already live. Adding a save path here would mean two ways to
 * change policy and only one of them audited properly.
 */
export function proposePolicyRuleFromDecision(input: {
  businessId: string;
  taskId: string;
  ruleKind: PolicyRuleKind;
}): PolicyRuleProposal {
  const row = requireTaskInBusiness(input.taskId, input.businessId);
  const policy = resolveOperatingPolicy(input.businessId);
  const item = describePendingDecision(row, policy);
  const actionType = item.required_action.action_type;

  if (!actionType) {
    throw new DecisionQueueError(
      'This decision has no action type, so there is no recurring class a bounded rule could apply to. '
      + 'Policy rules are scoped to action types on purpose: a rule that matched everything would not be bounded.',
      422, 'no_decision_class',
    );
  }

  const doc = policy.document;
  let patch: OperatingPolicyPatch;
  let statement: string;
  let alreadyInEffect: boolean;

  if (input.ruleKind === 'always_require_human') {
    const current = doc.approvals.always_require_human_action_types;
    alreadyInEffect = current.includes(actionType);
    patch = {
      approvals: {
        always_require_human_action_types: alreadyInEffect ? [...current] : [...current, actionType],
      },
    };
    statement =
      `Always require an explicit human approval for action type '${actionType}', whatever risk tier it computes to.`;
  } else if (input.ruleKind === 'cap_auto_approve_tier') {
    // Cap autonomous approval below this item's tier, so items like this one
    // keep reaching a human while lower-risk work still flows.
    //
    // The cap must also sit strictly below require_human_approval_at_or_above,
    // or #68's validator rejects it as a contradiction (a tier that is both
    // auto-approvable and human-gated), and it must be 'none' when autonomous
    // execution is switched off entirely. Taking the STRICTER of those bounds
    // means a rule proposed from the queue is always one the policy editor
    // will accept — a proposal that could not be saved would be worse than
    // no proposal at all.
    const belowItem = TIER_ORDER.indexOf(item.risk_tier) - 1;
    const belowHumanFloor = tierRank(doc.approvals.require_human_approval_at_or_above) - 1;
    const capRank = Math.min(belowItem, belowHumanFloor);
    const cap = !doc.autonomy.allow_autonomous_execution || capRank < 0
      ? 'none'
      : TIER_ORDER[capRank]!;
    alreadyInEffect = doc.approvals.auto_approve_max_tier !== null
      && tierRank(doc.approvals.auto_approve_max_tier) <= tierRank(cap);
    patch = { approvals: { auto_approve_max_tier: cap } };
    statement =
      `Cap autonomous approval at tier '${cap}', so anything at '${item.risk_tier}' or above — like this decision — `
      + 'always reaches a human.';
  } else {
    throw new DecisionQueueError(
      `Unknown rule kind '${String(input.ruleKind)}'. Must be always_require_human or cap_auto_approve_tier.`,
    );
  }

  return {
    business_id: input.businessId,
    decision_class: item.decision_class,
    rule_kind: input.ruleKind,
    statement,
    patch,
    already_in_effect: alreadyInEffect,
    preview: previewPolicyChange({ scope: 'business', key: input.businessId, patch }),
  };
}
