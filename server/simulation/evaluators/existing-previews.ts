/**
 * Adapters: the four previews that existed before #67, expressed through
 * the shared simulation primitive.
 *
 * ── The retrofit decision, stated plainly ─────────────────────────────────
 *
 * Issue #67 asks for ONE simulation concept a user learns once. It does not
 * ask for four working engines to be rewritten, and rewriting them would be
 * the wrong trade: previewPolicyChange() (#68), simulatePlaybook() (#74),
 * buildComparison() (#66) and hiring's dry-run (#57) are correct, tested,
 * and each produces genuinely domain-shaped output that a common schema
 * could only impoverish.
 *
 * So the retrofit is by ADAPTER, not by rewrite:
 *
 *   - Each existing engine is called UNCHANGED. Not one line of #57, #66,
 *     #68 or #74's logic moved into this file.
 *   - Each adapter maps that engine's output onto the shared envelope's
 *     questions — planned changes, skipped work with reasons, freshness,
 *     assumptions, unsupported operations — so all five previews answer the
 *     same questions in the same fields.
 *   - Each runs inside the shared guard, so their "no side effects" promise
 *     stops being a per-module discipline and becomes an enforced property.
 *     Their own structural import-list tests still pass and are still worth
 *     keeping: belt (their import guard) and braces (this runtime guard).
 *
 * The one place this is more than mapping is hiring. See the comment on
 * evaluateHiringReadiness() below — hiring's dry-run deliberately PERSISTS
 * decisions, so it is not a zero-write operation and cannot be run inside
 * the guard. What is previewed instead is stated honestly there.
 */
import db from '../../db/db.js';
import { previewPolicyChange, type PolicyPreview, type OperatingPolicyPatch, type PolicyScope } from '../../policy/operating-policy.js';
import { simulatePlaybook, type PlaybookSimulation } from '../../workflows/playbook-simulation.js';
import type { PlaybookDefinition } from '../../workflows/playbook-schema.js';
import { buildComparison, type ComparisonResult, type CandidateRef } from '../../brain/comparison-engine.js';
import { resolveMode } from '../../agents/hiring/policy.js';
import { getConnectorEvidence, getInstalledAgentIds, countOpenProposals, getCoordination } from '../../agents/hiring/store.js';
import type { SnapshotSourceSpec } from '../simulation-store.js';
import type {
  EvaluatorOutput, PlannedChange, SkippedWork, UnsupportedOperation,
} from '../simulation.js';

// ─── #68 · Operating policy change ───────────────────────────────────────────

export function policyChangeSnapshotSources(scope: PolicyScope, key: string, patch: unknown): SnapshotSourceSpec[] {
  const sources: SnapshotSourceSpec[] = [
    { type: 'operating_policy', scope, key },
    { type: 'inputs', label: 'Proposed policy patch', value: patch },
  ];
  if (scope === 'business') {
    sources.push({ type: 'open_tasks', business_id: key });
    sources.push({ type: 'connectors', business_id: key });
  }
  return sources;
}

/** Thin adapter over previewPolicyChange() — the engine is called unchanged. */
export function evaluatePolicyChange(input: {
  scope: PolicyScope; key: string; patch: OperatingPolicyPatch; effectiveAt?: string | null;
}): EvaluatorOutput<PolicyPreview> {
  const preview = previewPolicyChange({
    scope: input.scope, key: input.key, patch: input.patch, effective_at: input.effectiveAt ?? null,
  });

  const planned: PlannedChange[] = preview.changes.map((change) => ({
    kind: 'policy.field_change',
    target: change.field,
    summary: `${change.field}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`,
    external: false,
    requires_approval: true,
    detail: change,
  }));

  if (preview.valid) {
    planned.push({
      kind: 'policy.version',
      target: `${input.scope}:${input.key}`,
      summary: preview.would_activate_immediately
        ? `A new policy version ${preview.next_version} would be created and become active immediately, replacing version ${preview.current_version}.`
        : `A new policy version ${preview.next_version} would be created, scheduled to activate at ${preview.effective_at}.`,
      external: false,
      requires_approval: true,
    });
  }

  for (const impact of preview.impacts) {
    planned.push({
      kind: `policy.impact.${impact.kind}`,
      target: `${input.scope}:${input.key}`,
      summary: impact.summary,
      external: false,
      requires_approval: false,
      detail: impact.detail,
    });
  }

  const skipped: SkippedWork[] = [];
  if (!preview.valid) {
    for (const violation of preview.violations) {
      skipped.push({
        kind: 'policy.version',
        target: violation.field,
        reason: `The change is invalid and would be rejected on save: ${violation.message}`,
      });
    }
  }
  if (preview.valid && !preview.would_activate_immediately) {
    skipped.push({
      kind: 'policy.activate',
      target: `${input.scope}:${input.key}`,
      reason: `The change is scheduled for ${preview.effective_at}, so nothing about how decisions are made changes until then.`,
    });
  }
  if (preview.changes.length === 0) {
    skipped.push({
      kind: 'policy.field_change',
      target: `${input.scope}:${input.key}`,
      reason: 'The patch resolves to no effective change — every value already matches, so saving it would alter nothing.',
    });
  }

  const assumptions = [
    'Impacts are computed against the tasks and connectors that exist RIGHT NOW. A task proposed after this preview is not counted in any of the numbers above.',
    'The effective documents shown include inheritance from the portfolio policy, because that is what an operator is actually changing the behaviour of.',
  ];
  if (input.scope === 'portfolio') {
    assumptions.push('Each business in this portfolio may still override these values with its own policy, so the change may not reach every business shown.');
  }

  const unsupported: UnsupportedOperation[] = [
    {
      operation: 'retroactive_effect',
      reason: 'Already-approved and already-executed work is untouched by a policy change. This preview describes future decisions only, and cannot show what the past would have looked like under the new rules.',
    },
    {
      operation: 'task_retiering_beyond_200',
      reason: 'Task re-tiering impact is computed over at most 200 currently-open tasks. A business with more open tasks than that will have some omitted from the counts.',
    },
  ];

  const changeCount = preview.changes.length;
  const summary = !preview.valid
    ? `This policy change is INVALID and would be rejected: ${preview.violations[0]?.message ?? 'see violations'}.`
    : changeCount === 0
      ? 'This patch would change nothing — every value already matches the policy in force.'
      : `${changeCount} policy field(s) would change, creating version ${preview.next_version}${preview.would_activate_immediately ? ' with immediate effect' : ` effective ${preview.effective_at}`}. ${preview.impacts.length} operational impact(s) identified.`;

  return {
    detail: preview,
    summary,
    planned_changes: planned,
    skipped_work: skipped,
    assumptions,
    unsupported_operations: unsupported,
  };
}

// ─── #74 · Playbook run ──────────────────────────────────────────────────────

export function playbookSnapshotSources(input: {
  businessId: string; workflowId?: string | null; inputs?: Record<string, unknown>;
}): SnapshotSourceSpec[] {
  const sources: SnapshotSourceSpec[] = [
    { type: 'operating_policy', scope: 'business', key: input.businessId },
    { type: 'connectors', business_id: input.businessId },
    { type: 'business_profile', business_id: input.businessId },
    { type: 'inputs', label: 'Playbook run inputs', value: input.inputs ?? {} },
  ];
  if (input.workflowId) sources.push({ type: 'playbook', workflow_id: input.workflowId });
  return sources;
}

/** Thin adapter over simulatePlaybook() — the engine is called unchanged. */
export function evaluatePlaybookRun(input: {
  businessId: string;
  definition: PlaybookDefinition;
  inputs?: Record<string, unknown>;
  workflowId?: string | null;
  version?: number | null;
}): EvaluatorOutput<PlaybookSimulation> {
  const sim = simulatePlaybook({
    businessId: input.businessId,
    definition: input.definition,
    inputs: input.inputs ?? {},
    workflowId: input.workflowId ?? null,
    version: input.version ?? null,
  });

  const planned: PlannedChange[] = [];
  const skipped: SkippedWork[] = [];

  for (const step of sim.steps) {
    if (!step.would_run) {
      skipped.push({
        kind: 'playbook.step',
        target: `step ${step.index}: ${step.name}`,
        reason: step.would_not_run_reason ?? 'An earlier step would stop the run before this one is reached.',
      });
      continue;
    }
    if (step.blocking_issues.length > 0) {
      skipped.push({
        kind: 'playbook.step',
        target: `step ${step.index}: ${step.name}`,
        reason: step.blocking_issues.join(' '),
      });
    }
    planned.push({
      kind: step.kind === 'manual' ? 'playbook.manual_step' : 'playbook.action_step',
      target: `step ${step.index}: ${step.name}`,
      summary: step.kind === 'manual'
        ? `A person would be asked to perform "${step.name}" and confirm it. ${step.execution_route}`
        : `"${step.name}" would run '${step.action_type}' at risk tier '${step.risk_tier ?? 'unknown'}'. ${step.execution_route}`,
      external: step.side_effect_classification === 'external_verifiable',
      requires_approval: step.requires_approval,
      detail: {
        index: step.index,
        resolved_input: step.resolved_input,
        deferred_references: step.deferred_references,
        approval_sources: step.approval_sources,
        approval_explanation: step.approval_explanation,
      },
    });
  }

  const assumptions: string[] = [
    'Step payloads are resolved only from the run inputs supplied. References to an earlier step\'s output cannot be resolved before that step actually runs, and are listed per step as deferred rather than guessed at.',
    'Approval requirements are computed against the operating policy in force right now. Activating a different policy before the run would change where it pauses.',
  ];
  const deferred = sim.steps.filter((s) => s.deferred_references.length > 0);
  if (deferred.length > 0) {
    assumptions.push(
      `${deferred.length} step(s) depend on values produced by earlier steps at run time. Their payloads are shown partially resolved, and are fully validated again at dispatch.`,
    );
  }

  const unsupported: UnsupportedOperation[] = [
    {
      operation: 'step_outputs',
      reason: 'A step\'s real output is only produced by running it, so downstream branching and payloads that depend on those outputs cannot be shown definitively.',
    },
    {
      operation: 'execution_outcome',
      reason: 'Whether each step would succeed is not knowable in advance; this shows what would be attempted and where it would pause or stop.',
    },
  ];
  const irreversible = sim.steps.filter((s) => s.would_run && !s.supports_rollback && s.kind === 'action');
  if (irreversible.length > 0) {
    unsupported.push({
      operation: 'rollback',
      reason: `${irreversible.length} step(s) that would run are not rollback-capable. If the run fails after them, a rollback stops later steps but cannot undo those.`,
    });
  }

  const summary = sim.would_complete_without_human
    ? `All ${sim.summary.steps_that_would_run} step(s) would run unattended with no approval pause and no blocking issue.`
    : `${sim.summary.steps_that_would_run} of ${sim.summary.total_steps} step(s) would run; ${sim.summary.approval_points} approval pause(s) and ${sim.blocking_issues.length} blocking issue(s).`;

  return {
    detail: sim,
    summary,
    planned_changes: planned,
    skipped_work: skipped,
    assumptions,
    unsupported_operations: unsupported,
  };
}

// ─── #66 · Recommendation comparison ─────────────────────────────────────────

export function comparisonSnapshotSources(businessId: string, refs: CandidateRef[]): SnapshotSourceSpec[] {
  return [
    { type: 'operating_policy', scope: 'business', key: businessId },
    { type: 'connectors', business_id: businessId },
    { type: 'open_tasks', business_id: businessId },
    { type: 'inputs', label: 'Compared candidates', value: refs },
  ];
}

/** Thin adapter over buildComparison() — the engine is called unchanged. */
export function evaluateComparison(input: {
  businessId: string; refs: CandidateRef[];
}): EvaluatorOutput<ComparisonResult> {
  const comparison = buildComparison(input.businessId, input.refs);

  const planned: PlannedChange[] = comparison.candidates.map((c) => ({
    kind: 'comparison.candidate',
    target: c.id,
    summary: `"${c.title}" would be evaluated at tier '${String(c.risk.approval_tier.value ?? 'unknown')}' against ${comparison.shared_policy.policy_citation}.`,
    external: false,
    requires_approval: true,
    detail: { id: c.id, kind: c.kind, action_type: c.action_type },
  }));

  const skipped: SkippedWork[] = [
    {
      kind: 'task.approve',
      target: input.businessId,
      reason: 'Comparing candidates selects nothing. Choosing a winner records a preference in decision memory; approving it remains the separate, explicitly-authorised step it has always been.',
    },
  ];
  for (const missing of comparison.missing_data) {
    skipped.push({
      kind: 'comparison.dimension',
      target: `${missing.candidate_id}:${missing.field}`,
      reason: missing.reason,
    });
  }

  const assumptions = [
    `Every candidate is measured against ONE shared operating policy (${comparison.shared_policy.policy_citation}). A candidate that would in reality be evaluated under different rules is not comparable on this basis.`,
    `Evidence is drawn from ${comparison.shared_evidence_window.start} to ${comparison.shared_evidence_window.end} (${comparison.shared_evidence_window.span_days} days). ${comparison.shared_evidence_window.note}`,
    'No number here is imputed, averaged or defaulted. A dimension with no data is reported as unknown with a reason rather than filled in.',
  ];

  const unsupported: UnsupportedOperation[] = [
    {
      operation: 'ranking',
      reason: 'This comparison does not rank or recommend a winner. It puts candidates on the same scale so a person can decide; the decision is not automated.',
    },
    {
      operation: 'outcome_prediction',
      reason: 'Expected outcomes are classified by the #63 taxonomy, which explicitly distinguishes "measured" from "not measured". Unmeasured candidates cannot be forecast.',
    },
  ];
  if (comparison.comparability.status === 'flagged') {
    unsupported.push({
      operation: 'like_for_like_comparison',
      reason: `These candidates span decision classes (${comparison.comparability.decision_classes.join(', ')}) and are not straightforwardly comparable: ${comparison.comparability.warnings.map((w) => w.message).join(' ')}`,
    });
  }

  return {
    detail: comparison,
    summary:
      `${comparison.candidates.length} candidate(s) compared across ${comparison.dimensions.length} dimension(s); ` +
      `${comparison.differing_dimension_keys.length} genuinely differ, ${comparison.unknown_dimension_keys.length} are unknown for at least one candidate.`,
    planned_changes: planned,
    skipped_work: skipped,
    assumptions,
    unsupported_operations: unsupported,
  };
}

// ─── #57 · Autonomous hiring ─────────────────────────────────────────────────

export function hiringSnapshotSources(businessId: string): SnapshotSourceSpec[] {
  return [
    { type: 'hiring_policy' },
    { type: 'agents', business_id: businessId },
    { type: 'connectors', business_id: businessId },
    { type: 'operating_policy', scope: 'business', key: businessId },
  ];
}

export interface HiringReadinessPreview {
  business_id: string;
  /** 'live' | 'dry_run' | 'disabled' — resolveMode()'s answer, unchanged. */
  mode: string;
  skip_reason: string | null;
  hiring_enabled: boolean;
  policy_dry_run: boolean;
  installed_agent_count: number;
  open_proposals: number;
  max_open_proposals: number;
  proposal_headroom: number;
  connector_evidence: Array<{ type: string; last_sync: string | null; age_hours: number | null; fresh: boolean }>;
  fresh_connector_count: number;
  freshness_max_age_hours: number;
  passes_freshness_gate: boolean;
  next_eligible_at: string | null;
  last_analysis_at: string | null;
  would_analyse: boolean;
  would_propose_hires: boolean;
  blockers: string[];
}

/**
 * Hiring readiness — what autonomous hiring WOULD do, without running it.
 *
 * ── Why this is not simply "call the hiring engine in dry-run" ────────────
 *
 * Hiring's dry-run (#57) is a different kind of thing from the other three
 * previews, and pretending otherwise would misrepresent it. Its contract is
 * "evaluate and PERSIST decisions, but create no tasks, installs or first
 * runs" — a dry run deliberately writes hiring_decisions and an analysis
 * run row, because the point is to record what the engine concluded. It is
 * also asynchronous and calls a reasoning provider.
 *
 * So it is genuinely not a zero-side-effect operation, and running it under
 * this guard would (correctly) throw. Rather than weaken the guard for it
 * or claim a guarantee it does not have, this evaluator previews the part
 * that IS answerable read-only: every gate the hiring engine must pass
 * before it can propose anything — the master switch, dry-run mode,
 * connector-evidence freshness, the open-proposal WIP cap and the pacing
 * window.
 *
 * That is usually the question anyway ("why is hiring not proposing
 * anything?"), and the answer arrives without an LLM call. Running the real
 * analysis stays where it was, on the hiring control plane, and is listed
 * below under unsupported operations so nobody mistakes this for it.
 */
export function evaluateHiringReadiness(input: { businessId: string }): EvaluatorOutput<HiringReadinessPreview> {
  const { businessId } = input;
  const resolved = resolveMode(businessId);
  const policy = resolved.policy;

  const evidence = getConnectorEvidence(businessId, policy.freshness_max_age_hours);
  const fresh = evidence.filter((e) => e.fresh);
  const installed = getInstalledAgentIds(businessId);
  const openProposals = countOpenProposals(businessId);
  const coordination = getCoordination(businessId);

  const headroom = Math.max(0, policy.max_open_proposals - openProposals);
  const passesFreshness = fresh.length > 0;
  const blockers: string[] = [];

  if (!policy.enabled) {
    blockers.push(
      policy.disabled_reason
        ? `Autonomous hiring is switched off for this business: ${String(policy.disabled_reason)}`
        : 'Autonomous hiring is switched off for this business by the hiring control plane.',
    );
  }
  if (policy.dry_run) {
    blockers.push('The hiring policy is in dry-run mode: the engine evaluates candidates and records its decisions, but creates no hire proposals.');
  }
  if (!passesFreshness) {
    blockers.push(
      evidence.length === 0
        ? 'No connected connector has any data behind it, so there is no evidence a hiring decision could be based on.'
        : `No connector has synced within the ${policy.freshness_max_age_hours}h freshness window, so the evidence gate would refuse to propose a hire on stale data.`,
    );
  }
  if (headroom === 0) {
    blockers.push(`This business already has ${openProposals} open hire proposal(s), at its cap of ${policy.max_open_proposals}. No further proposal would be made until one is decided.`);
  }

  const withinCooldown = !!coordination?.next_eligible_at
    && Date.parse(`${coordination.next_eligible_at.replace(' ', 'T')}Z`) > Date.now();
  if (withinCooldown) {
    blockers.push(`This business was analysed recently and is paced until ${coordination!.next_eligible_at}; a triggered analysis inside that window is skipped unless its inputs materially changed.`);
  }

  const wouldAnalyse = policy.enabled && !withinCooldown;
  const wouldPropose = wouldAnalyse && !policy.dry_run && passesFreshness && headroom > 0;

  const planned: PlannedChange[] = [];
  if (wouldPropose) {
    planned.push({
      kind: 'hiring.propose',
      target: businessId,
      summary: `A triggered analysis would be allowed to propose up to ${headroom} hire(s), each as a task requiring approval before any agent is installed.`,
      external: false,
      requires_approval: true,
    });
  }
  if (wouldAnalyse) {
    planned.push({
      kind: 'hiring.analysis_run',
      target: businessId,
      summary: 'A real analysis would call the reasoning provider and record an analysis run with its conclusions.',
      external: true,
      requires_approval: false,
    });
  }

  const skipped: SkippedWork[] = blockers.map((reason) => ({
    kind: 'hiring.propose', target: businessId, reason,
  }));
  if (!wouldAnalyse && !blockers.some((b) => b.includes('paced'))) {
    skipped.push({ kind: 'hiring.analysis_run', target: businessId, reason: 'Hiring is disabled, so no analysis would run at all.' });
  }

  const assumptions = [
    'This reports the GATES, evaluated against current state. It does not run the reasoning step, so it cannot say which agent the engine would actually pick.',
    `Connector freshness is judged against this business's configured window of ${policy.freshness_max_age_hours} hours.`,
    'A hire proposal is always a task requiring approval. Even with every gate passed, no agent is installed without a separate authorised approval.',
  ];

  const unsupported: UnsupportedOperation[] = [
    {
      operation: 'hiring_analysis_execution',
      reason:
        'Running the real analysis is not available as a simulation. Hiring\'s dry-run mode (#57) deliberately PERSISTS the decisions it reaches — that is its purpose — so it is not a zero-side-effect operation and is not offered here. Use the hiring control plane to run it.',
    },
    {
      operation: 'candidate_selection',
      reason: 'Which agent template the engine would choose depends on a reasoning-provider call that this preview does not make.',
    },
  ];

  const summary = !policy.enabled
    ? `Autonomous hiring is DISABLED for ${businessId} — no analysis and no proposals, whatever triggers.`
    : wouldPropose
      ? `Hiring is live and every gate passes: an analysis could propose up to ${headroom} hire(s), each still requiring approval.`
      : `Hiring would not propose anything right now: ${blockers[0] ?? 'no gate passed'}`;

  return {
    detail: {
      business_id: businessId,
      mode: resolved.mode,
      skip_reason: resolved.skip_reason,
      hiring_enabled: policy.enabled,
      policy_dry_run: policy.dry_run,
      installed_agent_count: installed.size,
      open_proposals: openProposals,
      max_open_proposals: policy.max_open_proposals,
      proposal_headroom: headroom,
      connector_evidence: evidence.map((e) => ({
        type: e.type, last_sync: e.last_sync, age_hours: e.age_hours, fresh: e.fresh,
      })),
      fresh_connector_count: fresh.length,
      freshness_max_age_hours: policy.freshness_max_age_hours,
      passes_freshness_gate: passesFreshness,
      next_eligible_at: coordination?.next_eligible_at ?? null,
      last_analysis_at: coordination?.last_analysis_at ?? null,
      would_analyse: wouldAnalyse,
      would_propose_hires: wouldPropose,
      blockers,
    },
    summary,
    planned_changes: planned,
    skipped_work: skipped,
    assumptions,
    unsupported_operations: unsupported,
  };
}

/** Used by the route to confirm a business exists before previewing against it. */
export function businessExists(businessId: string): boolean {
  return !!db.prepare('SELECT 1 FROM businesses WHERE id = ?').get(businessId);
}
