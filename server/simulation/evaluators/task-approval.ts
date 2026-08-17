/**
 * "What would approving this task actually do?" (issue #67).
 *
 * This is the one genuinely new preview #67 adds. #61's decision centre
 * shows a task and #66's comparison mode weighs candidates against each
 * other, but neither answers the question an operator actually has their
 * finger over the button about: if I approve THIS, what happens next —
 * does it queue for execution, does it go to manual review, does it reach
 * outside Blueprint, and is there anything that would stop it?
 *
 * ── Mirroring, not re-implementing ────────────────────────────────────────
 *
 * Every gate below calls the SAME function approveTask() calls, in the same
 * order, with the same arguments: evaluateAutonomyGate, effectiveDailyTaskCap,
 * evaluateApplicability, calculateApprovalTier, the auto-approval ceiling
 * check, then validateAction. A preview computed from a parallel model of
 * the rules would drift from the real ones and quietly start lying, which
 * is worse than having no preview at all.
 *
 * The one deliberate difference: evaluateApplicability is called with
 * `recordSuppression: false`. Everywhere else it records a suppression row
 * as a side effect of judging; a preview must not, and the guard would
 * block it anyway. That divergence is disclosed as an assumption in the
 * result rather than left implicit.
 *
 * The post-approval routing (queue a job / hand off to an external system /
 * route to manual review) mirrors approveTask()'s branch on
 * `dispatched_by_executor` and `side_effect_classification` exactly — see
 * the comments there for why those three branches exist.
 */
import db from '../../db/db.js';
import { getActionRegistryEntry, validateAction } from '../../tasks/action-registry.js';
import { getBusinessProfile } from '../../business/business-profile.js';
import { calculateApprovalTier, evaluateApplicability } from '../../trust/trust-engine.js';
import {
  effectiveDailyTaskCap, evaluateAutonomyGate, tierRank, type ApprovalTier,
} from '../../policy/operating-policy.js';
import type { Connector } from '../../types/db.js';
import type { SnapshotSourceSpec } from '../simulation-store.js';
import type {
  EvaluatorOutput, PlannedChange, SkippedWork, UnsupportedOperation,
} from '../simulation.js';

export interface TaskApprovalPreview {
  task_id: string;
  business_id: string;
  title: string;
  action_type: string | null;
  current_status: string;
  /** Whether approval would be accepted at all right now. */
  would_approve: boolean;
  /** Every reason approval would be refused, in the order approveTask checks them. */
  blockers: Array<{ gate: string; reason: string }>;
  /** The tier approval would RE-CALCULATE, which may differ from the stored one. */
  stored_tier: string | null;
  recalculated_tier: ApprovalTier | null;
  tier_changed: boolean;
  /** How the approved task would (or would not) reach an executor. */
  execution_route: 'queued_for_execution' | 'external_system' | 'manual_review' | 'no_action' | 'blocked';
  execution_route_explanation: string;
  /** Whether Blueprint would perform work visible outside itself. */
  reaches_outside_blueprint: boolean;
  requires_human: boolean;
  requires_human_reason: string | null;
  applicability_status: string;
  applicability_reason: string;
  daily_cap: { cap: number | null; source: string; approved_today: number; would_exhaust: boolean };
  validation_issues: string[];
  validation_warnings: string[];
  missing_connector_types: string[];
  supports_rollback: boolean;
  rollback_note: string;
}

/** The inputs whose change should invalidate a task-approval preview. */
export function taskApprovalSnapshotSources(taskId: string, businessId: string, actionType: string | null): SnapshotSourceSpec[] {
  const sources: SnapshotSourceSpec[] = [
    { type: 'task', id: taskId },
    { type: 'operating_policy', scope: 'business', key: businessId },
    { type: 'connectors', business_id: businessId },
    { type: 'business_profile', business_id: businessId },
  ];
  if (actionType) sources.push({ type: 'action_registry', action_type: actionType });
  return sources;
}

interface TaskRowLike {
  id: string; business_id: string; title: string; description: string | null;
  status: string; action_type: string | null; action_payload: unknown;
  trust_tier: string | null; confidence: number | null; version: number;
}

export function loadTaskForPreview(taskId: string): TaskRowLike | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | null;
  if (!row) return null;
  let payload: unknown = {};
  try { payload = typeof row.action_payload === 'string' ? JSON.parse(row.action_payload) : (row.action_payload ?? {}); }
  catch { payload = {}; }
  return {
    id: String(row.id),
    business_id: String(row.business_id),
    title: String(row.title ?? ''),
    description: (row.description as string) ?? null,
    status: String(row.status ?? ''),
    action_type: (row.action_type as string) ?? null,
    action_payload: payload,
    trust_tier: (row.trust_tier as string) ?? null,
    confidence: (row.confidence as number) ?? null,
    version: Number(row.version ?? 1),
  };
}

/**
 * The evaluator. Pure with respect to every table — it reads, judges, and
 * describes. Runs inside runSimulation()'s guard, so any accidental write
 * added here in future throws rather than slipping through review.
 */
export function evaluateTaskApproval(input: {
  task: TaskRowLike;
  /** The actor whose approval is being previewed — human vs autonomous changes the gates. */
  approvedBy: string;
}): EvaluatorOutput<TaskApprovalPreview> {
  const { task, approvedBy } = input;
  const blockers: Array<{ gate: string; reason: string }> = [];
  const planned: PlannedChange[] = [];
  const skipped: SkippedWork[] = [];
  const assumptions: string[] = [];
  const unsupported: UnsupportedOperation[] = [];

  const isHuman = approvedBy.startsWith('dashboard:');
  assumptions.push(
    isHuman
      ? `Previewed as a human approval by '${approvedBy}'. The operating policy's autonomy limits do not constrain a person approving through the dashboard, so an autonomous approval of the same task may be refused where this one is not.`
      : `Previewed as an AUTONOMOUS approval by '${approvedBy}'. A human approving the same task through the dashboard bypasses the autonomy gate and the daily cap, so a human may be able to approve this even when Blueprint may not.`,
  );

  // ── Gate 0: status ────────────────────────────────────────────────────────
  if (task.status !== 'proposed') {
    blockers.push({
      gate: 'status',
      reason: `The task is '${task.status}', not 'proposed'. Only a proposed task can be approved — this one has already moved on.`,
    });
  }

  const entry = task.action_type ? getActionRegistryEntry(task.action_type) : null;
  const businessProfile = getBusinessProfile(task.business_id);

  // ── Gate 1: autonomy ──────────────────────────────────────────────────────
  const autonomy = evaluateAutonomyGate({
    businessId: task.business_id,
    approvedBy,
    actionType: task.action_type,
    tier: (['green', 'yellow', 'orange', 'red'] as const).find((t) => t === task.trust_tier) ?? null,
    requiredConnectorTypes: entry?.required_connector_types ?? [],
  });
  if (!autonomy.allowed) {
    blockers.push({ gate: 'operating_policy_autonomy', reason: autonomy.reason ?? 'Blocked by operating policy.' });
  }
  const policy = autonomy.policy;

  // ── Gate 2: daily autonomous cap ──────────────────────────────────────────
  const { cap, source: capSource } = effectiveDailyTaskCap(
    policy, businessProfile?.automation_policy?.max_autonomous_tasks_per_day ?? null,
  );
  const approvedToday = (db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
     WHERE business_id = ? AND approved_by IS NOT NULL AND approved_by NOT LIKE 'dashboard:%'
       AND approved_at >= datetime('now', 'start of day')
  `).get(task.business_id) as { n: number }).n;
  const capApplies = cap != null && !isHuman;
  const capExhausted = capApplies && approvedToday >= (cap ?? 0);
  if (capExhausted) {
    blockers.push({
      gate: 'daily_autonomous_cap',
      reason: `The ${capSource === 'operating_policy' ? 'operating policy' : 'business profile'} caps autonomous approvals at ${cap}/day and ${approvedToday} have already been recorded today. A human can still approve this via the dashboard.`,
    });
  }

  // ── Gate 3: applicability ─────────────────────────────────────────────────
  // recordSuppression: false — see the module comment.
  const applicability = evaluateApplicability({
    businessId: task.business_id,
    candidateType: 'task_approval',
    candidateKey: task.action_type ?? task.title,
    actionType: task.action_type,
    title: task.title,
    description: task.description,
    payload: task.action_payload,
    sourceType: 'task_approval_simulation',
    sourceId: task.id,
    recordSuppression: false,
  });
  assumptions.push(
    'Applicability was judged without recording a suppression row. A real approval records one; this preview does not, so nothing here appears in suppression reporting.',
  );
  if (applicability.status === 'not_applicable') {
    blockers.push({ gate: 'applicability', reason: `Not applicable to this business: ${applicability.reason}` });
  }

  // ── Gate 4: re-calculated risk tier ───────────────────────────────────────
  const risk = calculateApprovalTier({
    actionType: task.action_type,
    payload: task.action_payload as Record<string, unknown>,
    baseTier: task.trust_tier,
    agentConfidence: task.confidence,
    applicabilityStatus: applicability.status,
    policy,
  });
  const tierChanged = risk.tier !== task.trust_tier;
  if (tierChanged) {
    assumptions.push(
      `Approval re-calculates this task's risk tier. It is stored as '${task.trust_tier ?? 'unset'}' but would be re-graded '${risk.tier}' at approval time — the decision queue may be showing the stored value.`,
    );
  }

  const ceiling = policy.document.approvals.auto_approve_max_tier;
  const aboveCeiling = !isHuman && ceiling !== null && tierRank(risk.tier) > tierRank(ceiling);
  if (aboveCeiling) {
    blockers.push({
      gate: 'auto_approve_ceiling',
      reason: `The re-calculated tier '${risk.tier}' is above this business's auto_approve_max_tier of '${ceiling}'. A human can still approve this via the dashboard.`,
    });
  }

  const alwaysHuman = task.action_type
    ? policy.document.approvals.always_require_human_action_types.includes(task.action_type)
    : false;
  const floor = policy.document.approvals.require_human_approval_at_or_above;
  const atOrAboveFloor = tierRank(risk.tier) >= tierRank(floor);
  const requiresHuman = alwaysHuman || atOrAboveFloor || aboveCeiling;
  const requiresHumanReason = alwaysHuman
    ? `This business's operating policy always requires a human for '${task.action_type}'.`
    : aboveCeiling
      ? `Its tier '${risk.tier}' is above the auto-approval ceiling '${ceiling}'.`
      : atOrAboveFloor
        ? `Its tier '${risk.tier}' is at or above this business's human-approval floor '${floor}'.`
        : null;

  // ── Gate 5: typed action / executor / connector validation ────────────────
  const connectors = db.prepare('SELECT * FROM connectors WHERE business_id = ?')
    .all(task.business_id) as Connector[];
  const validation = validateAction({
    actionType: task.action_type,
    payload: task.action_payload as Record<string, unknown>,
    businessId: task.business_id,
    businessProfile,
    connectors,
    approvedBy,
  });
  if (!validation.valid) {
    for (const issue of validation.issues) {
      blockers.push({ gate: 'action_validation', reason: issue.message });
    }
  }

  const connectorTypes = new Set(connectors.map((c) => c.type));
  const missingConnectors = (entry?.required_connector_types ?? []).filter((t) => !connectorTypes.has(t));

  // ── What would actually happen ────────────────────────────────────────────
  const wouldApprove = blockers.length === 0;
  let route: TaskApprovalPreview['execution_route'];
  let routeExplanation: string;
  let reachesOutside = false;

  if (!wouldApprove) {
    route = 'blocked';
    routeExplanation =
      'Approval would be refused before anything is changed. No task status change, no receipt, no execution job — ' +
      'the reasons are listed as blockers, and a real attempt would raise a Blueprint System Issue explaining them.';
  } else if (!task.action_type) {
    route = 'no_action';
    routeExplanation =
      'This is a plain to-do with no typed action. Approving it marks it approved and opens a receipt recording who ' +
      'authorised it; Blueprint executes nothing and queues nothing.';
  } else if (entry?.dispatched_by_executor) {
    route = 'queued_for_execution';
    reachesOutside = entry.side_effect_classification !== 'internal_idempotent';
    routeExplanation =
      'Approving queues a durable execution job. The worker would pick it up and run the action for real' +
      (reachesOutside ? ', including writes visible outside Blueprint.' : ', with effects confined to Blueprint.');
  } else if (entry?.side_effect_classification === 'external_verifiable') {
    route = 'external_system';
    reachesOutside = true;
    routeExplanation =
      'Approving authorises the action but Blueprint never executes it — an external system performs and verifies ' +
      'the work. The receipt would record the authorisation only.';
  } else {
    route = 'manual_review';
    routeExplanation =
      `'${task.action_type}' is registered but has no executor implementation, so approval routes it straight to ` +
      'manual review rather than queueing it. An explicit pre-execution rejection is recorded — nothing will run it.';
  }

  // ── Planned changes ───────────────────────────────────────────────────────
  if (wouldApprove) {
    planned.push({
      kind: 'task.approve', target: task.id,
      summary: `Task "${task.title}" would move from 'proposed' to 'approved' (version ${task.version} → ${task.version + 1}), recorded against '${approvedBy}'.`,
      external: false, requires_approval: requiresHuman,
      detail: { from: 'proposed', to: 'approved', approved_by: approvedBy },
    });
    if (tierChanged) {
      planned.push({
        kind: 'task.retier', target: task.id,
        summary: `Its risk tier would be re-written from '${task.trust_tier ?? 'unset'}' to '${risk.tier}'.`,
        external: false, requires_approval: false,
        detail: { from: task.trust_tier, to: risk.tier, evidence: risk.evidence },
      });
    }
    planned.push({
      kind: 'action_receipt.open', target: task.id,
      summary: 'A verified action receipt would be opened in the same transaction, recording who authorised this and when.',
      external: false, requires_approval: false,
    });
    if (route === 'queued_for_execution') {
      planned.push({
        kind: 'execution_job.enqueue', target: task.action_type ?? task.id,
        summary: `A durable execution job would be queued for '${task.action_type}' and the worker woken immediately.`,
        external: reachesOutside, requires_approval: false,
      });
    }
    if (route === 'external_system') {
      planned.push({
        kind: 'external.handoff', target: task.action_type ?? task.id,
        summary: `'${task.action_type}' would be handed to an external system to perform and verify. Blueprint cannot undo what it does.`,
        external: true, requires_approval: false,
      });
    }
    if (task.action_type === 'hire_agent') {
      planned.push({
        kind: 'agent.hire', target: String((task.action_payload as { template_id?: unknown })?.template_id ?? 'unknown'),
        summary: 'Approving records a positive hiring decision and starts the bounded trial clock for this agent.',
        external: false, requires_approval: true,
      });
    }
    planned.push({
      kind: 'decision_memory.record', target: task.id,
      summary: `A decision-memory entry would cite ${policy.citation}.`,
      external: false, requires_approval: false,
    });
    planned.push({
      kind: 'webhook.dispatch', target: 'task.approved',
      summary: 'A `task.approved` webhook would be dispatched to every subscribed BAP agent — visible outside Blueprint.',
      external: true, requires_approval: false,
    });
  }

  // ── Skipped work ──────────────────────────────────────────────────────────
  if (!wouldApprove) {
    skipped.push({
      kind: 'task.approve', target: task.id,
      reason: `Approval would be refused: ${blockers.map((b) => b.reason).join(' ')}`,
    });
  }
  if (route === 'manual_review') {
    skipped.push({
      kind: 'execution_job.enqueue', target: task.action_type ?? task.id,
      reason: `No executor implements '${task.action_type}', so no job is queued — queueing one would only retry and dead-letter.`,
    });
  }
  if (route === 'external_system') {
    skipped.push({
      kind: 'execution_job.enqueue', target: task.action_type ?? task.id,
      reason: 'Blueprint deliberately never executes this action type; an external system owns it.',
    });
  }
  if (route === 'no_action') {
    skipped.push({
      kind: 'execution_job.enqueue', target: task.id,
      reason: 'The task has no typed action, so there is nothing for an executor to run.',
    });
  }
  for (const type of missingConnectors) {
    skipped.push({
      kind: 'connector.required', target: type,
      reason: `The action needs a '${type}' connector and this business has none configured.`,
    });
  }

  // ── What this preview genuinely cannot tell you ───────────────────────────
  unsupported.push({
    operation: 'execution_outcome',
    reason:
      'Whether the action would SUCCEED cannot be previewed. This shows what Blueprint would attempt and what would ' +
      'stop it beforehand; the external system\'s response is only knowable by actually calling it.',
  });
  if (route === 'queued_for_execution' || route === 'external_system') {
    unsupported.push({
      operation: 'external_side_effects',
      reason:
        'The precise external changes (which records, which ids) are decided by the executor at run time against live ' +
        'data, so they cannot be enumerated in advance.',
    });
  }
  if (entry && !entry.supports_rollback) {
    unsupported.push({
      operation: 'rollback',
      reason: `'${task.action_type}' is not rollback-capable. If it runs, Blueprint cannot undo it — that is a property of the action, not a gap in this preview.`,
    });
  }

  const summary = wouldApprove
    ? `Approving "${task.title}" would ${route === 'queued_for_execution' ? 'queue it for real execution' : route === 'external_system' ? 'authorise an external system to perform it' : route === 'manual_review' ? 'route it to manual review — nothing would execute it' : 'mark it approved with nothing to execute'}${requiresHuman ? ', and it requires a human decision' : ''}.`
    : `Approving "${task.title}" would be REFUSED right now: ${blockers[0]!.reason}`;

  return {
    detail: {
      task_id: task.id,
      business_id: task.business_id,
      title: task.title,
      action_type: task.action_type,
      current_status: task.status,
      would_approve: wouldApprove,
      blockers,
      stored_tier: task.trust_tier,
      recalculated_tier: risk.tier,
      tier_changed: tierChanged,
      execution_route: route,
      execution_route_explanation: routeExplanation,
      reaches_outside_blueprint: reachesOutside,
      requires_human: requiresHuman,
      requires_human_reason: requiresHumanReason,
      applicability_status: applicability.status,
      applicability_reason: applicability.reason,
      daily_cap: { cap, source: capSource, approved_today: approvedToday, would_exhaust: capExhausted },
      validation_issues: validation.issues.map((i) => i.message),
      validation_warnings: validation.warnings.map((i) => i.message),
      missing_connector_types: missingConnectors,
      supports_rollback: Boolean(entry?.supports_rollback),
      rollback_note: entry?.supports_rollback
        ? 'The registry marks this action rollback-capable: compensation replays the rollback data recorded at execution time.'
        : `The registry marks '${task.action_type ?? 'this task'}' as NOT rollback-capable — once run, it cannot be automatically undone.`,
    },
    summary,
    planned_changes: planned,
    skipped_work: skipped,
    assumptions,
    unsupported_operations: unsupported,
  };
}
