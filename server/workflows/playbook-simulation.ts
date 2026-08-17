/**
 * Playbook simulation / preview (issue #74).
 *
 * Answers "what would this playbook do with these inputs?" without doing
 * any of it. Given a definition and a set of run inputs, it computes, per
 * step: whether the step would run at all, what payload it would send, what
 * the payload is missing, which risk tier it lands in, whether it would
 * stop for approval and WHY, what connectors it needs, whether an executor
 * exists for it, and whether it could be compensated if a later step failed.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 *
 * The zero-side-effect property is easiest to break by importing something
 * that writes "just to read one field" — so simulation lives apart from
 * playbook-engine.ts and imports nothing that can create a task, approve
 * one, enqueue a job or write a receipt. That is asserted structurally in
 * playbook-simulation.test.ts (the import list is checked) as well as
 * behaviourally (row counts before/after), the same belt-and-braces the
 * #66 comparison engine uses.
 *
 * Full disclosure about what "zero side effects" means here: simulating
 * creates NO task, execution job, receipt, workflow run, step run, playbook
 * event or audit row, and never mutates the playbook or any prior run. It
 * does read this business's operating policy, and reading a policy settles
 * any activation that was already due (operating-policy.ts's lazy
 * activation) — that is a property of every policy read in the codebase,
 * not something simulation initiates.
 */
import db from '../db/db.js';
import type { Connector } from '../types/db.js';
import type { ActionRegistryEntry } from '../types/action-registry.js';
import { getActionRegistryEntry } from '../tasks/action-registry.js';
import { calculateApprovalTier } from '../trust/trust-engine.js';
import { resolveOperatingPolicy, tierRank, type ApprovalTier } from '../policy/operating-policy.js';
import { getBusinessProfile } from '../business/business-profile.js';
import {
  type PlaybookDefinition, type PlaybookStepDefinition, type PlaybookViolation,
  bindTemplate, validatePlaybookDefinition, validateRunInputs, validateTemplateAgainstSchema,
} from './playbook-schema.js';

/** Why a step would pause for a human. A step can have more than one reason. */
export type ApprovalSource =
  /** The step's own `approval_gate` — the pre-#74 manual gate, always honoured. */
  | 'step_approval_gate'
  /** The Typed Action Registry marks this action_type `requires_approval`. */
  | 'registry_requires_approval'
  /** calculateApprovalTier() put this step at or above the policy's human-approval floor. */
  | 'risk_tier_requires_human'
  /** The policy sets an explicit auto-approval ceiling and this step's tier is above it. */
  | 'risk_tier_above_policy_ceiling'
  /** The operating policy names this action_type as always needing a human. */
  | 'policy_always_requires_human'
  /**
   * The step is free text. Blueprint will not perform unbounded free-text
   * work unattended inside a bounded playbook, so a manual step is a
   * hand-off a person confirms — never something the run quietly ticks off.
   */
  | 'manual_step_acknowledgement';

/**
 * The registry grades an action's inherent risk as low/medium/high; the
 * trust engine grades an approval in tiers. Mapping one onto the other as
 * the tier's STARTING point is what makes a step's registry risk_level
 * actually influence whether it needs a human — calculateApprovalTier()
 * can then escalate further from the payload (spend, affected records,
 * keywords) but never below the action's own grade.
 */
const RISK_LEVEL_BASE_TIER: Record<string, ApprovalTier> = {
  low: 'green', medium: 'yellow', high: 'orange',
};

export interface SimulatedStep {
  index: number;
  name: string;
  kind: 'action' | 'manual';
  action_type: string | null;
  agent_id: string | null;
  /** False when an earlier step would stop the run before this one is reached. */
  would_run: boolean;
  would_not_run_reason: string | null;
  /** The payload as far as it can be resolved before the run produces step outputs. */
  resolved_input: unknown;
  /** References that only a real run can resolve (earlier steps' actual outputs). */
  deferred_references: string[];
  /** Schema problems in the part of the payload that IS resolvable now. */
  input_issues: string[];
  input_valid: boolean;
  output_schema_declared: boolean;
  risk_level: string | null;
  risk_tier: ApprovalTier | null;
  requires_approval: boolean;
  approval_sources: ApprovalSource[];
  approval_explanation: string | null;
  side_effect_classification: string | null;
  timeout_seconds: number;
  max_attempts: number;
  on_failure: string;
  required_connector_types: string[];
  missing_connector_types: string[];
  /** Permissions the registry requires of whoever approves this step (enforced by approveTask's validateAction gate). */
  required_permissions: string[];
  /** Whether the registry says this action can be compensated (see rollback honesty in playbook-engine.ts). */
  supports_rollback: boolean;
  rollback_note: string;
  /** Whether executing this step produces a real action receipt (#70). */
  produces_receipt: boolean;
  /** Honest note about what actually happens to this step's task when approved. */
  execution_route: string;
  blocking_issues: string[];
}

export interface PlaybookSimulation {
  business_id: string;
  workflow_id: string | null;
  version: number | null;
  /** Definition-level validity — identical to what activation would check. */
  definition_valid: boolean;
  violations: PlaybookViolation[];
  inputs: Record<string, unknown>;
  input_violations: PlaybookViolation[];
  steps: SimulatedStep[];
  /** Step indexes that would pause the run for a human. */
  approval_points: number[];
  /** Problems that would stop the run from getting past a step. */
  blocking_issues: Array<{ step_index: number; issue: string }>;
  would_complete_without_human: boolean;
  summary: {
    total_steps: number;
    steps_that_would_run: number;
    action_steps: number;
    manual_steps: number;
    approval_points: number;
    rollback_capable_steps: number;
    external_side_effect_steps: number;
  };
  /** Constant. Stated in the payload so an API consumer can show it, not just trust it. */
  side_effects_performed: 'none';
}

export interface SimulateInput {
  businessId: string;
  definition: PlaybookDefinition;
  inputs?: Record<string, unknown>;
  workflowId?: string | null;
  version?: number | null;
}

function listConnectors(businessId: string): Connector[] {
  return db.prepare('SELECT * FROM connectors WHERE business_id = ?').all(businessId) as Connector[];
}

/**
 * Decide whether a step stops for a human, and say exactly why. The manual
 * `approval_gate` is never overridden — risk can only ADD reasons to pause,
 * which is what "risk-derived approval layered on top of the existing gate"
 * has to mean if the existing gate is to remain trustworthy.
 */
export function resolveStepApproval(params: {
  step: PlaybookStepDefinition;
  entry: ActionRegistryEntry | null;
  businessId: string;
  payload: Record<string, unknown>;
}): { requires_approval: boolean; sources: ApprovalSource[]; tier: ApprovalTier | null; explanation: string | null } {
  const { step, entry, businessId, payload } = params;
  const sources: ApprovalSource[] = [];

  if (step.approval_gate) sources.push('step_approval_gate');
  if (step.kind === 'manual') sources.push('manual_step_acknowledgement');

  let tier: ApprovalTier | null = null;
  if (step.kind === 'action' && entry) {
    if (entry.requires_approval) sources.push('registry_requires_approval');

    const policy = resolveOperatingPolicy(businessId);
    tier = calculateApprovalTier({
      actionType: step.action_type,
      payload,
      baseTier: RISK_LEVEL_BASE_TIER[entry.risk_level] ?? 'yellow',
      businessId,
      policy,
    }).tier;

    // The policy's own human-approval floor — the same field the rest of
    // the system uses to mean "at or above this tier, a person decides".
    const floor = policy.document.approvals.require_human_approval_at_or_above;
    if (tierRank(tier) >= tierRank(floor)) sources.push('risk_tier_requires_human');

    // A configured auto-approval ceiling is a second, stricter gate. `null`
    // means "no ceiling configured", exactly as approveTask() reads it —
    // not "approve nothing".
    const ceiling = policy.document.approvals.auto_approve_max_tier;
    if (ceiling !== null && tierRank(tier) > tierRank(ceiling)) {
      sources.push('risk_tier_above_policy_ceiling');
    }
    if (step.action_type && policy.document.approvals.always_require_human_action_types.includes(step.action_type)) {
      sources.push('policy_always_requires_human');
    }
  }

  const unique = Array.from(new Set(sources));
  if (unique.length === 0) return { requires_approval: false, sources: [], tier, explanation: null };

  const reasons: Record<ApprovalSource, string> = {
    step_approval_gate: 'the playbook step declares an approval gate',
    registry_requires_approval: `the Typed Action Registry marks '${step.action_type}' as requiring approval`,
    risk_tier_requires_human: `its derived risk tier '${tier}' is at or above this business's human-approval floor`,
    risk_tier_above_policy_ceiling: `its derived risk tier '${tier}' is above this business's auto-approval ceiling`,
    policy_always_requires_human: `this business's operating policy always requires a human for '${step.action_type}'`,
    manual_step_acknowledgement: 'it is a free-text step a person performs and confirms, not a typed action Blueprint executes',
  };
  return {
    requires_approval: true,
    sources: unique,
    tier,
    explanation: `Pauses for approval because ${unique.map((s) => reasons[s]).join('; and ')}.`,
  };
}

/**
 * How an approved step's task actually reaches (or does not reach) an
 * executor. Mirrors approveTask()'s routing rather than guessing, so a
 * preview does not promise execution the system will not perform.
 */
function describeExecutionRoute(entry: ActionRegistryEntry | null, kind: 'action' | 'manual'): string {
  if (kind === 'manual') {
    return 'Free-text step: the run pauses and a person performs it and confirms. Blueprint executes no typed ' +
      'action here, so there is no action receipt — any task raised while doing the work gets its own receipt ' +
      'through the normal task path. (The classic workflow engine still hands free-text steps straight to an ' +
      'agent; a bounded playbook deliberately does not.)';
  }
  if (!entry) return 'Unknown action type — this step cannot run until the action is registered.';
  if (entry.dispatched_by_executor) {
    return 'Creates a real task, approves it through the normal approval path (opening an action receipt), ' +
      'and queues a durable execution job.';
  }
  if (entry.side_effect_classification === 'external_verifiable') {
    return 'Creates and authorises a real task, but Blueprint never executes it — an external system performs ' +
      'and verifies the work. The receipt records the authorisation only.';
  }
  return 'Registered but has no executor implementation: the task is routed to manual review rather than ' +
    'queued, and the receipt records an explicit pre-execution rejection.';
}

function rollbackNote(entry: ActionRegistryEntry | null, kind: 'action' | 'manual'): string {
  if (kind === 'manual') {
    return 'Manual step — nothing to compensate automatically; the agent output stands and any follow-up is a human decision.';
  }
  if (!entry) return 'Unknown action type — rollback capability cannot be determined.';
  if (entry.supports_rollback) {
    return 'The registry marks this action as rollback-capable: compensation replays the rollback data the ' +
      'executor recorded at execution time. If no rollback data was recorded, compensation is reported as ' +
      'unavailable rather than assumed.';
  }
  return `The registry marks '${entry.action_type}' as NOT rollback-capable. If this step has already run, ` +
    'a playbook rollback stops later steps but CANNOT undo it — that is surfaced, not papered over.';
}

/**
 * Compute the full preview. Pure with respect to the playbook, its runs and
 * every task/receipt/job table (see the module comment).
 */
export function simulatePlaybook(input: SimulateInput): PlaybookSimulation {
  const { businessId, definition } = input;
  const inputs = input.inputs ?? {};

  const businessType = (() => {
    try { return getBusinessProfile(businessId)?.business_type ?? null; } catch { return null; }
  })();

  const violations = validatePlaybookDefinition(definition, { businessId, businessType });
  const inputViolations = validateRunInputs(definition, inputs);

  const connectorTypes = new Set(listConnectors(businessId).map((c) => c.type));
  const steps: SimulatedStep[] = [];
  const blocking: Array<{ step_index: number; issue: string }> = [];
  const approvalPoints: number[] = [];

  // A step that would stop the run means every later step "would not run".
  // Reporting them as running anyway would be the exact false confidence a
  // preview exists to prevent.
  let haltedBy: { index: number; reason: string } | null = null;

  for (const step of definition.steps) {
    const entry = step.kind === 'action' && step.action_type ? getActionRegistryEntry(step.action_type) : null;

    // Only `inputs.*` can be resolved ahead of a run; `steps.N.output.*`
    // genuinely does not exist yet and is reported as deferred.
    const bound = bindTemplate(step.input, { inputs, steps: {} });
    const payload = (bound.value && typeof bound.value === 'object' && !Array.isArray(bound.value))
      ? bound.value as Record<string, unknown>
      : {};

    // Values still carrying an unresolved `{{steps.N.output...}}` reference
    // are deferred, not wrong — validateTemplateAgainstSchema skips exactly
    // those leaves while still enforcing that required keys are present at
    // all. The fully-bound payload is validated again for real at dispatch.
    const inputIssues = entry
      ? validateTemplateAgainstSchema(entry.payload_schema, payload).map((issue) => issue.message)
      : [];

    const approval = resolveStepApproval({ step, entry, businessId, payload });

    const missingConnectors = (entry?.required_connector_types ?? []).filter((t) => !connectorTypes.has(t));
    const stepBlocking: string[] = [];
    if (step.kind === 'action' && !entry) {
      stepBlocking.push(`action_type '${step.action_type}' is not registered — this step cannot run.`);
    }
    for (const issue of inputIssues) stepBlocking.push(`Payload does not satisfy the action schema: ${issue}.`);
    for (const type of missingConnectors) {
      stepBlocking.push(`Requires a '${type}' connector, which this business has not configured.`);
    }
    for (const violation of violations.filter((v) => v.field.startsWith(`steps[${step.index}]`))) {
      stepBlocking.push(violation.message);
    }

    const wouldRun = haltedBy === null;
    steps.push({
      index: step.index,
      name: step.name,
      kind: step.kind,
      action_type: step.action_type,
      agent_id: step.agent_id,
      would_run: wouldRun,
      would_not_run_reason: haltedBy
        ? `Step ${haltedBy.index} would stop the run first: ${haltedBy.reason}`
        : null,
      resolved_input: bound.value,
      deferred_references: bound.unresolved,
      input_issues: inputIssues,
      input_valid: inputIssues.length === 0,
      output_schema_declared: step.output_schema !== null,
      risk_level: entry?.risk_level ?? null,
      risk_tier: approval.tier,
      requires_approval: approval.requires_approval,
      approval_sources: approval.sources,
      approval_explanation: approval.explanation,
      side_effect_classification: entry?.side_effect_classification ?? null,
      timeout_seconds: step.timeout_seconds,
      max_attempts: step.max_attempts,
      on_failure: step.on_failure,
      required_connector_types: entry?.required_connector_types ?? [],
      missing_connector_types: missingConnectors,
      required_permissions: entry?.required_permissions ?? [],
      supports_rollback: Boolean(entry?.supports_rollback),
      rollback_note: rollbackNote(entry, step.kind),
      produces_receipt: step.kind === 'action' && !!entry,
      execution_route: describeExecutionRoute(entry, step.kind),
      blocking_issues: stepBlocking,
    });

    if (wouldRun && approval.requires_approval) approvalPoints.push(step.index);
    for (const issue of stepBlocking) blocking.push({ step_index: step.index, issue });
    if (wouldRun && stepBlocking.length > 0 && step.on_failure !== 'continue') {
      haltedBy = { index: step.index, reason: stepBlocking[0]! };
    }
  }

  return {
    business_id: businessId,
    workflow_id: input.workflowId ?? null,
    version: input.version ?? null,
    definition_valid: violations.length === 0,
    violations,
    inputs,
    input_violations: inputViolations,
    steps,
    approval_points: approvalPoints,
    blocking_issues: blocking,
    would_complete_without_human: approvalPoints.length === 0 && blocking.length === 0
      && violations.length === 0 && inputViolations.length === 0,
    summary: {
      total_steps: definition.steps.length,
      steps_that_would_run: steps.filter((s) => s.would_run).length,
      action_steps: definition.steps.filter((s) => s.kind === 'action').length,
      manual_steps: definition.steps.filter((s) => s.kind === 'manual').length,
      approval_points: approvalPoints.length,
      rollback_capable_steps: steps.filter((s) => s.supports_rollback).length,
      external_side_effect_steps: steps.filter((s) => s.side_effect_classification === 'external_verifiable').length,
    },
    side_effects_performed: 'none',
  };
}
