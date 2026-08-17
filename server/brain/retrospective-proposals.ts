/**
 * Retrospective operating-change proposals (issue #73).
 *
 * A retrospective used to end at prose: `recommendations` and
 * `operating_changes` were arrays of strings. Useful to read, impossible to
 * approve, diff, activate or roll back. This module is the missing
 * propose → review → activate pipeline, and nothing more: it does not
 * re-analyse anything retrospective-engine.ts already analyses, and it does
 * not implement a second copy of any subsystem's activation logic.
 *
 * THE CENTRAL INVARIANT: A RETROSPECTIVE NEVER ACTIVATES ANYTHING.
 *
 * Generating a proposal writes, at most, a DRAFT in the subsystem that owns
 * the thing being changed, plus a review item in the #61 decision queue.
 * Behaviour changes only when a human approves that review item, and the
 * change is then made by the owning subsystem's own activation function:
 *
 *   target 'policy'
 *     draft   — the patch is validated by #68's previewPolicyChange(), which
 *               writes nothing, and stored on the proposal with the full
 *               versioned diff (current_version → next_version) it produced.
 *     approve — #68's savePolicyVersion() writes and activates version N+1.
 *     reject  — no operating_policies row was ever written. Nothing to undo.
 *     rollback— #68's rollbackPolicy(), which restores a prior version by
 *               writing it FORWARD as a new version.
 *
 *     Why a validated patch rather than a stored 'draft' row: #68's
 *     operating_policies.state is CHECK-constrained to
 *     ('scheduled','active','superseded') and a 'scheduled' row ACTIVATES
 *     ITSELF when its effective_at arrives (activateDuePolicies). Parking an
 *     unapproved proposal there would mean an unreviewed retrospective
 *     finding silently taking effect later — precisely what this issue
 *     forbids. The versioned diff a reviewer needs is produced by #68's own
 *     preview, and the version that lands is written by #68's own save.
 *
 *   target 'workflow'
 *     draft   — #74's savePlaybookDraft() writes a REAL draft playbook
 *               version (state 'draft', validated). A draft never runs.
 *     approve — #74's activatePlaybookVersion(), which re-validates before
 *               activating and refuses an invalid definition.
 *     reject  — the draft is marked 'archived' via #74's own event log, so
 *               it is explicitly abandoned rather than lingering as a live
 *               draft somebody might activate later by hand.
 *     rollback— #74's rollbackPlaybookVersion().
 *
 *   target 'agent_lifecycle'
 *     draft   — none exists to write. #69's evaluateRetention() verdict is
 *               carried as a recommendation; no agent state is touched.
 *     approve — the existing controls: uninstallAgent() to retire, or
 *               transitionAgent(agent, 'standby') to pause a downgrade.
 *     reject  — nothing was changed, so nothing is undone.
 *     rollback— not offered. Re-hiring a retired agent is a hiring decision
 *               with its own evidence gate (#56/#69), not a rollback, and
 *               saying otherwise would promise an undo this system does not
 *               have.
 *
 * Approval and rejection both go through #61's reviewDecision() on a normal
 * task, so a retrospective proposal produces exactly the same decision
 * record, audit row, action receipt and policy citation as any other
 * reviewed decision. There is no retrospective-specific approval path.
 */
import db, { generateId, audit } from '../db/db.js';
import {
  gatherPeriodEvidence, MIN_OUTCOME_SAMPLE,
  type CitedRecord, type EvidenceBasis, type EvidenceConflict, type EvidenceGap,
  type PeriodEvidence, type SubjectEvidence,
} from './retrospective-evidence.js';
import type { ComparableField } from './comparison-engine.js';
import {
  previewPolicyChange, resolveOperatingPolicy, savePolicyVersion, rollbackPolicy,
  getActivePolicyVersion, type OperatingPolicyPatch, type PolicyFieldChange,
} from '../policy/operating-policy.js';
import {
  savePlaybookDraft, activatePlaybookVersion, rollbackPlaybookVersion,
  getActivePlaybookVersion, getPlaybookVersion, recordPlaybookEvent,
} from '../workflows/playbook-versions.js';
import type { PlaybookDefinition, PlaybookStepDefinition } from '../workflows/playbook-schema.js';
import { evaluateRetention, type RetentionAssessment } from '../agents/hiring/retention.js';
import { uninstallAgent } from '../agents/installer.js';
import { transitionAgent } from '../agents/agentLifecycle.js';
import { createTask, cancelTask, type TaskRow } from '../tasks/task-queue.js';
import { reviewDecision, type ReviewDecisionResult } from '../decisions/decision-queue.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** The one action type every retrospective proposal is reviewed as. */
export const RETROSPECTIVE_CHANGE_ACTION_TYPE = 'retrospective_operating_change';

/**
 * An unreviewed proposal lapses rather than sitting in the queue forever.
 * A finding about last month stops being a good reason to change how the
 * system runs once the period it describes is well behind us.
 */
export const PROPOSAL_EXPIRY_DAYS = 30;

const PROPOSER = 'system:retrospective';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProposalTarget = 'policy' | 'workflow' | 'agent_lifecycle';
export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'expired' | 'abandoned';

/** Pointer to the real artifact this proposal created in its own subsystem. */
export type ProposalDraftRef =
  | {
      kind: 'policy_patch';
      scope: 'business';
      scope_key: string;
      /**
       * The SEMANTIC intent: action types this proposal adds to
       * approvals.always_require_human_action_types.
       *
       * Stored alongside `patch` rather than instead of it because the patch
       * is a snapshot — its array holds the list as it stood when the
       * proposal was raised. Replaying that snapshot months later would
       * silently DELETE any entry added in between, reverting a change
       * nobody asked to revert. Activation therefore recomputes the patch
       * from the live policy using this field; `patch` and `changes` remain
       * as the diff the reviewer was actually shown.
       */
      add_action_types: string[];
      patch: OperatingPolicyPatch;
      base_version: number;
      next_version: number;
      /** #68's own diff, produced by previewPolicyChange(). */
      changes: PolicyFieldChange[];
      valid: boolean;
    }
  | {
      kind: 'playbook_version';
      workflow_id: string;
      workflow_name: string;
      version: number;
      playbook_version_id: string;
      base_version: number | null;
      validation_state: string;
    }
  | {
      kind: 'agent_lifecycle';
      agent_id: string;
      /** #69's verdict, carried verbatim. */
      retention_verdict: RetentionAssessment['verdict'];
      /** The existing control this maps to. */
      action: 'retire' | 'pause';
    };

export interface RetrospectiveProposal {
  id: string;
  retrospective_id: string | null;
  business_id: string;
  target: ProposalTarget;
  title: string;
  statement: string;
  basis: EvidenceBasis;
  basis_reason: string;
  period_start: string;
  period_end: string;
  cited_records: CitedRecord[];
  measured_effect: ComparableField<unknown> | null;
  conflicts: EvidenceConflict[];
  expected_benefit: string;
  risk: string;
  rollback_plan: string;
  expires_at: string | null;
  draft_ref: ProposalDraftRef | null;
  decision_task_id: string | null;
  status: ProposalStatus;
  activation_result: Record<string, unknown> | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** An LLM narrative line that no measured record supports. */
export interface UnstructuredSuggestion {
  text: string;
  source: 'recommendations' | 'operating_changes';
  /** Why this stayed prose instead of becoming an approvable proposal. */
  not_proposed_reason: string;
}

export interface ProposalGenerationResult {
  proposals: RetrospectiveProposal[];
  gaps: EvidenceGap[];
  conflicts: EvidenceConflict[];
  unstructured_suggestions: UnstructuredSuggestion[];
  evidence_summary: {
    total_measured_outcomes: number;
    total_completed_tasks: number;
    minimum_sample_required: number;
  };
}

// ─── Row mapping ─────────────────────────────────────────────────────────────

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

function parseProposalRow(row: Record<string, unknown> | null | undefined): RetrospectiveProposal | null {
  if (!row) return null;
  return {
    ...(row as unknown as RetrospectiveProposal),
    cited_records: parseJson<CitedRecord[]>(row.cited_records, []),
    measured_effect: parseJson<ComparableField<unknown> | null>(row.measured_effect, null),
    conflicts: parseJson<EvidenceConflict[]>(row.conflicts, []),
    draft_ref: parseJson<ProposalDraftRef | null>(row.draft_ref, null),
    activation_result: parseJson<Record<string, unknown> | null>(row.activation_result, null),
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listProposalsForRetrospective(
  retrospectiveId: string, businessId: string,
): RetrospectiveProposal[] {
  return (db.prepare(
    'SELECT * FROM retrospective_proposals WHERE retrospective_id = ? AND business_id = ? ORDER BY created_at ASC',
  ).all(retrospectiveId, businessId) as Array<Record<string, unknown>>)
    .map((r) => parseProposalRow(r)!);
}

export function listProposalsForBusiness(
  businessId: string, opts: { status?: ProposalStatus; limit?: number } = {},
): RetrospectiveProposal[] {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const rows = opts.status
    ? db.prepare(
        'SELECT * FROM retrospective_proposals WHERE business_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
      ).all(businessId, opts.status, limit)
    : db.prepare(
        'SELECT * FROM retrospective_proposals WHERE business_id = ? ORDER BY created_at DESC LIMIT ?',
      ).all(businessId, limit);
  return (rows as Array<Record<string, unknown>>).map((r) => parseProposalRow(r)!);
}

/**
 * Look up one proposal, scoped to its business. A proposal id belonging to
 * another business is reported as not found, exactly as decision-queue.ts
 * treats a foreign task id — returning "forbidden" would confirm the id is
 * real, which is itself a cross-business leak.
 */
export function getProposal(id: string, businessId: string): RetrospectiveProposal | null {
  return parseProposalRow(db.prepare(
    'SELECT * FROM retrospective_proposals WHERE id = ? AND business_id = ?',
  ).get(id, businessId) as Record<string, unknown> | null);
}

export class RetrospectiveProposalError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(message: string, statusCode = 400, code = 'invalid_proposal') {
    super(message);
    this.name = 'RetrospectiveProposalError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ─── Candidate shaping ───────────────────────────────────────────────────────

/**
 * A candidate is everything a proposal needs EXCEPT the draft and the review
 * item. Building candidates separately from materialising them keeps the
 * evidence rules (which decide whether a candidate exists at all) apart from
 * the write path (which turns one into a draft plus a queue item).
 */
interface ProposalCandidate {
  target: ProposalTarget;
  title: string;
  statement: string;
  evidence: SubjectEvidence;
  expected_benefit: string;
  risk: string;
  rollback_plan: string;
  extra_citations: CitedRecord[];
  /** Builds the real draft. Returns null when the subsystem cannot host it. */
  makeDraft: () => ProposalDraftRef | null;
}

/**
 * Should this subject produce a proposal at all?
 *
 * 'hypothesis' means the sample was too small — per the issue, that produces
 * NO proposal, only a recorded gap. A low-confidence guess is exactly what a
 * retrospective must not emit.
 *
 * 'conflicting_evidence' DOES produce a proposal, because the conflict itself
 * is the finding a human needs to see. Such a proposal is labelled as
 * conflicting and never claims the change will help.
 */
function proposalIsWarranted(evidence: SubjectEvidence): boolean {
  if (evidence.basis === 'hypothesis') return false;
  if (evidence.basis === 'conflicting_evidence') return true;
  return evidence.direction === 'negative';
}

// ─── Candidate: policy change ────────────────────────────────────────────────

/**
 * The bounded policy change a retrospective is allowed to propose: add ONE
 * action type to approvals.always_require_human_action_types, so an action
 * whose measured outcomes went badly stops being approved unattended.
 *
 * Deliberately the narrowest useful lever. A retrospective proposing broad
 * threshold or autonomy rewrites from a month of outcomes would be claiming
 * far more than its evidence supports, and would be far harder for a human
 * to reason about at review time.
 */
function policyCandidate(
  businessId: string, actionType: string, evidence: SubjectEvidence,
): ProposalCandidate | null {
  const resolved = resolveOperatingPolicy(businessId);
  const current = resolved.document.approvals.always_require_human_action_types ?? [];
  if (current.includes(actionType)) return null; // already covered — no change to make

  const patch: OperatingPolicyPatch = {
    approvals: {
      always_require_human_action_types: [...current, actionType],
    },
  };

  const conflicting = evidence.basis === 'conflicting_evidence';
  return {
    target: 'policy',
    title: `Require human approval for '${actionType}'`,
    statement:
      `Add '${actionType}' to approvals.always_require_human_action_types, so Blueprint stops approving it ` +
      'unattended and a person sees each one first. ' +
      (conflicting
        ? 'The outcome records for this action type disagree, so this is proposed as a way to look more closely — not as a fix.'
        : 'This does not claim the action is wrong; it claims its recent measured outcomes justify a human looking before it runs.'),
    evidence,
    expected_benefit:
      `Every future '${actionType}' proposal reaches a human before it runs, so the pattern in these ` +
      `${evidence.tally.measured_total} measured outcome(s) cannot repeat unattended.`,
    risk:
      `Throughput on '${actionType}' drops to whatever a reviewer can process. If the measured outcomes were ` +
      'caused by something other than the action type itself, this gates useful work for no benefit.',
    rollback_plan:
      `Roll the operating policy back to version ${resolved.policy_version} via the policy editor's rollback, ` +
      'which restores it as a new version and leaves the full history intact.',
    extra_citations: [{
      kind: 'operating_policy',
      id: resolved.policy_id ?? 'system_default',
      summary:
        `operating policy in force during this period: ${resolved.citation} ` +
        `(always_require_human_action_types currently ${current.length === 0 ? 'empty' : current.join(', ')})`,
    }],
    makeDraft: () => {
      // #68's own validation and diff. previewPolicyChange writes NOTHING —
      // no policy row, no event — so an unapproved proposal leaves the policy
      // table exactly as it found it.
      const preview = previewPolicyChange({ scope: 'business', key: businessId, patch });
      return {
        kind: 'policy_patch',
        scope: 'business',
        scope_key: businessId,
        add_action_types: [actionType],
        patch,
        base_version: preview.current_version,
        next_version: preview.next_version,
        changes: preview.changes,
        valid: preview.valid,
      };
    },
  };
}

// ─── Candidate: workflow / playbook change ───────────────────────────────────

interface WorkflowTarget {
  workflow_id: string;
  workflow_name: string;
  version: number;
  definition: PlaybookDefinition;
  step_indexes: number[];
}

/** Active playbooks with an ungated step running the action type in question. */
function findUngatedPlaybookSteps(businessId: string, actionType: string): WorkflowTarget[] {
  const workflows = db.prepare(
    'SELECT id, name FROM workflows WHERE business_id = ?',
  ).all(businessId) as Array<{ id: string; name: string }>;

  const targets: WorkflowTarget[] = [];
  for (const workflow of workflows) {
    let active;
    try {
      active = getActivePlaybookVersion({ workflowId: workflow.id, businessId });
    } catch { continue; }
    if (!active) continue;
    const stepIndexes = active.definition.steps
      .filter((s) => s.action_type === actionType && !s.approval_gate)
      .map((s) => s.index);
    if (stepIndexes.length === 0) continue;
    targets.push({
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      version: active.version,
      definition: active.definition,
      step_indexes: stepIndexes,
    });
  }
  return targets;
}

/**
 * The bounded workflow change: put an approval gate on the steps of an active
 * playbook that run a badly-performing action type. The step is not deleted
 * and the playbook is not restructured — a retrospective has evidence about
 * outcomes, not about what the workflow should have been instead.
 */
function workflowCandidate(
  businessId: string, actionType: string, evidence: SubjectEvidence, target: WorkflowTarget,
): ProposalCandidate {
  const gatedSteps: PlaybookStepDefinition[] = target.definition.steps.map((step) =>
    target.step_indexes.includes(step.index)
      ? {
          ...step,
          approval_gate: true,
          approval_message:
            step.approval_message
            ?? `Retrospective evidence: ${evidence.basis_reason} Confirm this step before it runs.`,
        }
      : step);

  const nextDefinition: PlaybookDefinition = { ...target.definition, steps: gatedSteps };
  const conflicting = evidence.basis === 'conflicting_evidence';

  return {
    target: 'workflow',
    title: `Gate '${actionType}' step(s) in playbook "${target.workflow_name}"`,
    statement:
      `Add a manual approval gate to step(s) ${target.step_indexes.join(', ')} of "${target.workflow_name}" ` +
      `(the '${actionType}' step(s)), leaving the rest of the playbook unchanged. ` +
      (conflicting
        ? 'Proposed because the outcome records for this action type disagree and the workflow runs it without a human.'
        : 'Proposed because this playbook runs an action whose measured outcomes in this period went the wrong way.'),
    evidence,
    expected_benefit:
      `Runs of "${target.workflow_name}" pause at the '${actionType}' step for a person, instead of carrying ` +
      'the measured pattern straight through unattended.',
    risk:
      `Every run of "${target.workflow_name}" now blocks on a reviewer at ${target.step_indexes.length} step(s). ` +
      'An unattended run will stall rather than complete.',
    rollback_plan:
      `Roll the playbook back to version ${target.version} with the playbook rollback control, which restores ` +
      'it as a new version. In-flight runs stay bound to the version they started on.',
    extra_citations: [{
      kind: 'playbook_version',
      id: `${target.workflow_id}#${target.version}`,
      summary:
        `active playbook version ${target.version} of "${target.workflow_name}" runs '${actionType}' ` +
        `at step(s) ${target.step_indexes.join(', ')} with no approval gate`,
    }],
    makeDraft: () => {
      // #74's own draft writer. A draft NEVER runs — playbook-engine binds
      // runs to the active version — so this cannot change behaviour.
      const draft = savePlaybookDraft({
        workflowId: target.workflow_id,
        businessId,
        definition: nextDefinition,
        actor: PROPOSER,
        change_reason:
          `Retrospective proposal: gate '${actionType}' step(s) pending human approval. ${evidence.basis_reason}`,
        base_version: target.version,
        validate: true,
      });
      return {
        kind: 'playbook_version',
        workflow_id: target.workflow_id,
        workflow_name: target.workflow_name,
        version: draft.version,
        playbook_version_id: draft.id,
        base_version: target.version,
        validation_state: draft.validation_state,
      };
    },
  };
}

// ─── Candidate: agent lifecycle ──────────────────────────────────────────────

/**
 * #69's retention verdict, surfaced as a proposal. The verdict itself is NOT
 * recomputed here — evaluateRetention() owns "is this agent still worth
 * keeping", and inventing a second answer to that question in the
 * retrospective would give the system two disagreeing opinions about the
 * same agent.
 *
 * Only 'retire' and 'downgrade' become proposals, and only when at least one
 * TRIAL RECORD exists to cite. #69's "hired N days ago with no trial on
 * record" downgrade is a real observation but has no measured outcome behind
 * it, so it is recorded as an evidence gap instead — consistent with the
 * rule that thin evidence produces no proposal.
 */
function agentLifecycleCandidate(
  businessId: string,
  assessment: RetentionAssessment,
  agentEvidence: SubjectEvidence | undefined,
): { candidate: ProposalCandidate | null; gap: EvidenceGap | null } {
  const subject = `agent '${assessment.agent_id}'`;
  if (assessment.verdict !== 'retire' && assessment.verdict !== 'downgrade') {
    return { candidate: null, gap: null };
  }

  const ev = assessment.evidence;
  const recordedTrials = ev.successful + ev.unsuccessful + ev.neutral + ev.insufficient_data;
  if (ev.trials_total === 0 || recordedTrials === 0) {
    return {
      candidate: null,
      gap: {
        subject,
        reason: 'no_measured_outcomes',
        detail:
          `Retention says '${assessment.verdict}' for ${subject} (${assessment.reason}), but no completed trial ` +
          'record exists to cite. No lifecycle change is proposed on an absence of records.',
        measured_outcomes: 0,
        required_outcomes: 1,
      },
    };
  }

  const action: 'retire' | 'pause' = assessment.verdict === 'retire' ? 'retire' : 'pause';
  const citations: CitedRecord[] = [{
    kind: 'agent_installation',
    id: assessment.agent_id,
    summary:
      `#69 retention verdict '${assessment.verdict}': ${assessment.reason} ` +
      `(${ev.trials_total} trial(s): ${ev.successful} successful, ${ev.unsuccessful} unsuccessful, ` +
      `${ev.neutral} neutral, ${ev.insufficient_data} unmeasurable, ${ev.open} still open; ` +
      `$${ev.total_cost_usd.toFixed(2)} cost)`,
  }];

  // Carry #69's own evidence when this agent has no task outcomes in the
  // period — the trials ARE the record, and marking the effect "unknown"
  // when a verdict exists would be its own kind of dishonesty.
  const evidence: SubjectEvidence = agentEvidence && agentEvidence.tally.measured_total > 0
    ? {
        ...agentEvidence,
        cited_records: [...citations, ...agentEvidence.cited_records],
      }
    : {
        subject,
        tally: {
          positive: [], negative: [], neutral: [],
          measured_total: recordedTrials, mean_change_pct: null, change_pct_sample: 0,
        },
        direction: 'negative',
        basis: 'evidence_backed',
        basis_reason:
          `${recordedTrials} completed trial record(s) for ${subject} support #69's '${assessment.verdict}' ` +
          `verdict: ${assessment.reason}`,
        conflicts: [],
        cited_records: citations,
        measured_effect: {
          state: 'known',
          value: {
            successful: ev.successful,
            unsuccessful: ev.unsuccessful,
            neutral: ev.neutral,
            insufficient_data: ev.insufficient_data,
            total_cost_usd: ev.total_cost_usd,
          },
          citation: `agent_trials via evaluateRetention('${businessId}', '${assessment.agent_id}')`,
          reason: null,
        },
      };

  return {
    candidate: {
      target: 'agent_lifecycle',
      title: action === 'retire'
        ? `Retire agent '${assessment.agent_id}'`
        : `Pause agent '${assessment.agent_id}' to standby`,
      statement: action === 'retire'
        ? `Retire '${assessment.agent_id}' for this business using the existing retire control. Its files, past ` +
          'runs and trial records are kept; it simply stops running.'
        : `Move '${assessment.agent_id}' to standby so it stops being activated, without retiring it. ` +
          'Its scope can then be narrowed before it is used again.',
      evidence,
      expected_benefit: action === 'retire'
        ? `Stops spending on an agent whose measured trials did not pay off (${ev.total_cost_usd.toFixed(2)} USD ` +
          `across ${ev.trials_total} trial(s) in the record).`
        : `Stops '${assessment.agent_id}' being activated while its scope is reconsidered, without discarding it.`,
      risk: action === 'retire'
        ? 'Whatever this agent covered stops being covered. Re-hiring later goes through the hiring evidence ' +
          'gate as a fresh decision — this is not an undo.'
        : 'Work this agent would have picked up is not picked up by anyone until it returns or is replaced.',
      rollback_plan: action === 'retire'
        ? 'No rollback. Retiring is reversible only by hiring the agent again, which is a new hiring decision ' +
          'with its own evidence requirements — not a rollback of this change.'
        : `Re-activation returns '${assessment.agent_id}' to normal operation through the usual activation path.`,
      extra_citations: [],
      makeDraft: () => ({
        kind: 'agent_lifecycle',
        agent_id: assessment.agent_id,
        retention_verdict: assessment.verdict,
        action,
      }),
    },
    gap: null,
  };
}

// ─── LLM narrative reconciliation ────────────────────────────────────────────

/**
 * The retrospective's prose suggestions are matched against the proposals the
 * records actually justify. A line that names a subject with a proposal is
 * shown alongside it; a line that names nothing measurable stays PROSE and
 * says why. This is the "distinguishes evidence from hypotheses" criterion
 * at the level a reader sees: a narrative suggestion never quietly becomes
 * an approvable operating change.
 */
export function reconcileNarrativeSuggestions(
  parsed: Record<string, unknown> | null,
  proposals: RetrospectiveProposal[],
  evidence: PeriodEvidence,
): UnstructuredSuggestion[] {
  if (!parsed) return [];
  const subjects = new Set<string>([
    ...evidence.by_action_type.keys(),
    ...evidence.by_agent.keys(),
  ]);
  const proposedSubjects = new Set(
    proposals.map((p) => {
      const ref = p.draft_ref;
      if (ref?.kind === 'agent_lifecycle') return ref.agent_id;
      return null;
    }).filter((s): s is string => s !== null),
  );
  for (const p of proposals) {
    // The action type is in the title for policy/workflow proposals; match on
    // any subject the title mentions rather than re-deriving it.
    for (const subject of subjects) {
      if (p.title.includes(subject) || p.statement.includes(subject)) proposedSubjects.add(subject);
    }
  }

  const out: UnstructuredSuggestion[] = [];
  for (const source of ['recommendations', 'operating_changes'] as const) {
    const lines = Array.isArray(parsed[source]) ? parsed[source] as unknown[] : [];
    for (const raw of lines) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') continue;
      const mentioned = [...subjects].filter((s) => text.toLowerCase().includes(s.toLowerCase()));
      const covered = mentioned.filter((s) => proposedSubjects.has(s));
      out.push({
        text,
        source,
        not_proposed_reason: covered.length > 0
          ? `Kept as narrative. The measurable part of this (${covered.join(', ')}) is already covered by a ` +
            'bounded proposal above; the rest of the sentence is the analyst\'s interpretation, not a record.'
          : mentioned.length > 0
            ? `Kept as narrative. It refers to ${mentioned.join(', ')}, but this period's records did not meet the ` +
              `${MIN_OUTCOME_SAMPLE}-outcome minimum needed to propose an operating change about it.`
            : 'Kept as narrative. No measured outcome, trial or decision record in this period corresponds to it, ' +
              'so it cannot be turned into an approvable change.',
      });
    }
  }
  return out;
}

// ─── Materialising a candidate ───────────────────────────────────────────────

function expiryFrom(now: Date): string {
  return new Date(now.getTime() + PROPOSAL_EXPIRY_DAYS * 86_400_000).toISOString();
}

/**
 * Write the proposal, its subsystem draft, and the decision-queue item a
 * human reviews. If the review item cannot be created the whole thing is
 * rolled back: a proposal nobody can review is worse than no proposal, and a
 * dangling draft with no approval path is exactly the "lingering ambiguously"
 * state this issue calls out.
 */
function materialise(
  candidate: ProposalCandidate,
  input: { businessId: string; retrospectiveId: string | null; periodStart: string; periodEnd: string },
): RetrospectiveProposal | null {
  let draftRef: ProposalDraftRef | null;
  try {
    draftRef = candidate.makeDraft();
  } catch (err) {
    console.warn(
      `[retrospective-proposals] could not create draft for "${candidate.title}": ${(err as Error).message}`,
    );
    return null;
  }
  if (!draftRef) return null;

  // A policy patch that #68 itself rejects is not proposed. Surfacing an
  // invalid change for approval would offer a human a button that cannot work.
  if (draftRef.kind === 'policy_patch' && !draftRef.valid) {
    console.warn(
      `[retrospective-proposals] policy patch for "${candidate.title}" fails #68 validation; not proposed.`,
    );
    return null;
  }

  const id = generateId();
  const now = new Date();
  const citations = [...candidate.evidence.cited_records, ...candidate.extra_citations];

  const insert = db.prepare(`
    INSERT INTO retrospective_proposals (
      id, retrospective_id, business_id, target, title, statement, basis, basis_reason,
      period_start, period_end, cited_records, measured_effect, conflicts,
      expected_benefit, risk, rollback_plan, expires_at, draft_ref, decision_task_id,
      status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'proposed', ?, ?, ?)
  `);

  insert.run(
    id, input.retrospectiveId, input.businessId, candidate.target,
    candidate.title, candidate.statement,
    candidate.evidence.basis, candidate.evidence.basis_reason,
    input.periodStart, input.periodEnd,
    JSON.stringify(citations),
    JSON.stringify(candidate.evidence.measured_effect),
    JSON.stringify(candidate.evidence.conflicts),
    candidate.expected_benefit, candidate.risk, candidate.rollback_plan,
    expiryFrom(now), JSON.stringify(draftRef),
    PROPOSER, now.toISOString(), now.toISOString(),
  );

  let task: TaskRow | null = null;
  try {
    task = createTask({
      business_id: input.businessId,
      title: candidate.title,
      description: buildReviewDescription(candidate, draftRef, citations),
      proposed_by: PROPOSER,
      action_type: RETROSPECTIVE_CHANGE_ACTION_TYPE,
      action_payload: {
        proposal_id: id,
        target: candidate.target,
        draft_ref: draftRef,
        basis: candidate.evidence.basis,
      },
      // An operating change is not routine work. 'orange' is the starting
      // tier; approveTask re-derives the real tier under the live policy.
      trust_tier: 'orange',
      priority: 'p2',
      confidence: null,
      estimated_impact: candidate.expected_benefit,
      approval_mode: 'requires_approval',
    });
  } catch (err) {
    db.prepare('DELETE FROM retrospective_proposals WHERE id = ?').run(id);
    abandonDraft(draftRef, input.businessId, PROPOSER,
      `Review item could not be created: ${(err as Error).message}`);
    console.warn(
      `[retrospective-proposals] could not queue review for "${candidate.title}": ${(err as Error).message}`,
    );
    return null;
  }

  if (!task) {
    db.prepare('DELETE FROM retrospective_proposals WHERE id = ?').run(id);
    abandonDraft(draftRef, input.businessId, PROPOSER, 'Review item could not be created.');
    return null;
  }

  db.prepare(
    'UPDATE retrospective_proposals SET decision_task_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(task.id, id);

  audit(input.businessId, 'retrospective_proposal', id, 'propose', PROPOSER, null, {
    target: candidate.target, basis: candidate.evidence.basis, draft_ref: draftRef,
  }, { retrospective_id: input.retrospectiveId, decision_task_id: task.id });

  return getProposal(id, input.businessId);
}

/** The reviewer-facing text on the decision-queue item. */
function buildReviewDescription(
  candidate: ProposalCandidate, draftRef: ProposalDraftRef, citations: CitedRecord[],
): string {
  const lines: string[] = [];
  lines.push(candidate.statement);
  lines.push('');
  lines.push(
    candidate.evidence.basis === 'evidence_backed'
      ? `EVIDENCE-BACKED: ${candidate.evidence.basis_reason}`
      : candidate.evidence.basis === 'conflicting_evidence'
        ? `CONFLICTING EVIDENCE: ${candidate.evidence.basis_reason}`
        : `HYPOTHESIS: ${candidate.evidence.basis_reason}`,
  );
  lines.push('');
  lines.push(`Expected benefit: ${candidate.expected_benefit}`);
  lines.push(`Risk: ${candidate.risk}`);
  lines.push(`Rollback: ${candidate.rollback_plan}`);
  lines.push('');
  if (draftRef.kind === 'policy_patch') {
    lines.push(
      `Approving activates operating policy version ${draftRef.next_version} (from ${draftRef.base_version}). ` +
      `Diff: ${draftRef.changes.map((c) => `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join('; ') || 'none'}`,
    );
  } else if (draftRef.kind === 'playbook_version') {
    lines.push(
      `Approving activates draft playbook version ${draftRef.version} of "${draftRef.workflow_name}" ` +
      `(currently '${draftRef.validation_state}', base version ${draftRef.base_version ?? 'none'}). ` +
      'Rejecting archives that draft.',
    );
  } else {
    lines.push(
      `Approving ${draftRef.action === 'retire' ? 'retires' : 'moves to standby'} agent '${draftRef.agent_id}' ` +
      `(retention verdict '${draftRef.retention_verdict}').`,
    );
  }
  if (candidate.evidence.conflicts.length > 0) {
    lines.push('');
    lines.push('Conflicts (not averaged away):');
    for (const conflict of candidate.evidence.conflicts) lines.push(`- ${conflict.detail}`);
  }
  lines.push('');
  lines.push(`Records analysed (${citations.length}):`);
  for (const record of citations.slice(0, 20)) lines.push(`- [${record.kind} ${record.id}] ${record.summary}`);
  return lines.join('\n');
}

// ─── Generation ──────────────────────────────────────────────────────────────

export interface GenerateProposalsInput {
  businessId: string;
  retrospectiveId?: string | null;
  periodStart: Date;
  periodEnd: Date;
  /** The retrospective's parsed LLM output, for narrative reconciliation. */
  parsedReport?: Record<string, unknown> | null;
}

/**
 * Produce every bounded proposal this period's records justify — and record
 * every place they did not.
 *
 * Nothing here activates anything. The most this function does to live
 * behaviour is create draft playbook versions (which never run) and tasks in
 * the review queue (which do nothing until approved).
 */
export function generateRetrospectiveProposals(
  input: GenerateProposalsInput,
): ProposalGenerationResult {
  const { businessId } = input;
  const evidence = gatherPeriodEvidence(businessId, input.periodStart, input.periodEnd);
  const gaps: EvidenceGap[] = [...evidence.gaps];
  const proposals: RetrospectiveProposal[] = [];

  const materialiseInput = {
    businessId,
    retrospectiveId: input.retrospectiveId ?? null,
    periodStart: evidence.period_start,
    periodEnd: evidence.period_end,
  };

  // ── Policy and workflow proposals, from action-type outcomes ──
  for (const [actionType, subject] of evidence.by_action_type) {
    if (!proposalIsWarranted(subject)) continue;

    const policy = policyCandidate(businessId, actionType, subject);
    if (policy) {
      const created = materialise(policy, materialiseInput);
      if (created) proposals.push(created);
    } else {
      gaps.push({
        subject: actionType,
        reason: 'subject_already_covered',
        detail:
          `'${actionType}' already requires human approval under this business's operating policy, ` +
          'so there is no policy change left to propose.',
        measured_outcomes: subject.tally.measured_total,
        required_outcomes: MIN_OUTCOME_SAMPLE,
      });
    }

    const workflowTargets = findUngatedPlaybookSteps(businessId, actionType);
    if (workflowTargets.length === 0) {
      gaps.push({
        subject: actionType,
        reason: 'no_active_playbook',
        detail:
          `No active playbook for this business runs '${actionType}' through an ungated step, so there is no ` +
          'workflow change to propose — the evidence is real, but it has nowhere to land as a playbook edit.',
        measured_outcomes: subject.tally.measured_total,
        required_outcomes: MIN_OUTCOME_SAMPLE,
      });
    }
    for (const target of workflowTargets) {
      const created = materialise(workflowCandidate(businessId, actionType, subject, target), materialiseInput);
      if (created) proposals.push(created);
    }
  }

  // ── Agent lifecycle proposals, from #69's retention verdicts ──
  let assessments: RetentionAssessment[] = [];
  try {
    assessments = evaluateRetention(businessId);
  } catch (err) {
    console.warn('[retrospective-proposals] retention evaluation unavailable:', (err as Error).message);
  }
  if (assessments.length === 0) {
    gaps.push({
      subject: 'agent lifecycle',
      reason: 'no_installed_agents',
      detail: 'This business has no installed agents to assess, so no lifecycle change is proposed.',
      measured_outcomes: 0,
      required_outcomes: 1,
    });
  }
  for (const assessment of assessments) {
    const { candidate, gap } = agentLifecycleCandidate(
      businessId, assessment, evidence.by_agent.get(assessment.agent_id),
    );
    if (gap) gaps.push(gap);
    if (candidate) {
      const created = materialise(candidate, materialiseInput);
      if (created) proposals.push(created);
    }
  }

  const unstructured = reconcileNarrativeSuggestions(input.parsedReport ?? null, proposals, evidence);

  return {
    proposals,
    gaps,
    conflicts: evidence.conflicts,
    unstructured_suggestions: unstructured,
    evidence_summary: {
      total_measured_outcomes: evidence.total_measured_outcomes,
      total_completed_tasks: evidence.total_completed_tasks,
      minimum_sample_required: MIN_OUTCOME_SAMPLE,
    },
  };
}

// ─── Review ──────────────────────────────────────────────────────────────────

export interface ReviewProposalInput {
  proposalId: string;
  businessId: string;
  outcome: 'approve' | 'reject';
  actor: string;
  reason?: string | null;
  overrideReason?: string | null;
}

export interface ReviewProposalResult {
  proposal: RetrospectiveProposal;
  review: ReviewDecisionResult;
}

/**
 * Approve or reject a proposal THROUGH #61's decision queue.
 *
 * Approval only marks the task approved; the change itself is made by
 * executor.ts dispatching the approved task to applyApprovedProposal(),
 * exactly as any other executable action type is dispatched. This function
 * cannot activate anything on its own, and there is no code path that lets a
 * proposal skip the queue.
 */
export function reviewRetrospectiveProposal(input: ReviewProposalInput): ReviewProposalResult {
  const proposal = getProposal(input.proposalId, input.businessId);
  if (!proposal) {
    throw new RetrospectiveProposalError(
      `No retrospective proposal '${input.proposalId}' for business '${input.businessId}'.`, 404, 'not_found',
    );
  }
  if (proposal.status !== 'proposed') {
    throw new RetrospectiveProposalError(
      `Proposal '${proposal.id}' is '${proposal.status}', not 'proposed' — it has already been decided.`,
      409, 'already_decided',
    );
  }
  if (!proposal.decision_task_id) {
    throw new RetrospectiveProposalError(
      `Proposal '${proposal.id}' has no decision-queue item, so it cannot be reviewed.`, 409, 'no_review_item',
    );
  }

  const review = reviewDecision({
    businessId: input.businessId,
    taskId: proposal.decision_task_id,
    outcome: input.outcome,
    actor: input.actor,
    reason: input.reason ?? null,
    overrideReason: input.overrideReason ?? null,
  });

  if (input.outcome === 'reject') {
    // The draft is explicitly abandoned rather than left sitting in a state
    // where somebody could activate it by hand later without the evidence
    // the reviewer just rejected.
    abandonDraft(proposal.draft_ref, input.businessId, input.actor,
      `Retrospective proposal rejected: ${input.reason ?? 'no reason given'}`);
    db.prepare(`
      UPDATE retrospective_proposals
         SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
             review_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(input.actor, input.reason ?? null, proposal.id);
    audit(input.businessId, 'retrospective_proposal', proposal.id, 'reject', input.actor,
      { status: 'proposed' }, { status: 'rejected' }, { reason: input.reason ?? null });
  } else {
    db.prepare(`
      UPDATE retrospective_proposals
         SET reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_reason = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(input.actor, input.reason ?? null, proposal.id);
  }

  return { proposal: getProposal(proposal.id, input.businessId)!, review };
}

/**
 * Mark a draft explicitly dead. Policy proposals have no draft row to
 * abandon (by design — see the header), agent-lifecycle proposals never
 * created any state, and a playbook draft is archived through #74's own
 * event log so the abandonment appears in that playbook's history.
 */
function abandonDraft(
  draftRef: ProposalDraftRef | null, businessId: string, actor: string, reason: string,
): void {
  if (!draftRef) return;
  if (draftRef.kind !== 'playbook_version') return;
  try {
    const ref = { workflowId: draftRef.workflow_id, businessId };
    const version = getPlaybookVersion(ref, draftRef.version);
    if (!version || version.state !== 'draft') return;
    db.prepare(
      "UPDATE playbook_versions SET state = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'draft'",
    ).run(version.id);
    recordPlaybookEvent({
      playbookVersionId: version.id,
      workflowId: draftRef.workflow_id,
      businessId,
      version: draftRef.version,
      eventType: 'archived',
      actor,
      reason,
    });
  } catch (err) {
    console.warn('[retrospective-proposals] could not archive draft playbook version:', (err as Error).message);
  }
}

// ─── Activation (executor-dispatched) ────────────────────────────────────────

export interface ProposalActivationResult {
  proposal_id: string;
  target: ProposalTarget;
  outcome: string;
  detail: Record<string, unknown>;
}

/**
 * Activate an approved proposal by calling the OWNING subsystem's activation
 * function. Reached only from executor.ts, which reaches it only for a task
 * that approveTask() has already put through every policy, registry,
 * applicability and connector gate.
 *
 * Every branch delegates. There is no line in this function that writes
 * policy, playbook or agent state directly.
 */
export function applyApprovedProposal(
  proposalId: string, businessId: string, actor: string,
): ProposalActivationResult {
  const proposal = getProposal(proposalId, businessId);
  if (!proposal) {
    throw new RetrospectiveProposalError(
      `No retrospective proposal '${proposalId}' for business '${businessId}'.`, 404, 'not_found',
    );
  }
  if (proposal.status === 'approved') {
    // Idempotent: a retried execution job must not double-apply a change.
    return {
      proposal_id: proposal.id,
      target: proposal.target,
      outcome: 'already_applied',
      detail: proposal.activation_result ?? {},
    };
  }
  if (proposal.status !== 'proposed') {
    throw new RetrospectiveProposalError(
      `Proposal '${proposal.id}' is '${proposal.status}' and cannot be activated.`, 409, 'not_activatable',
    );
  }
  const draftRef = proposal.draft_ref;
  if (!draftRef) {
    throw new RetrospectiveProposalError(
      `Proposal '${proposal.id}' has no draft to activate.`, 409, 'no_draft',
    );
  }

  let result: ProposalActivationResult;
  switch (draftRef.kind) {
    case 'policy_patch': {
      // Rebuild the patch against the policy AS IT STANDS NOW. The stored
      // patch holds the action-type list as it was when the proposal was
      // raised; replaying it would drop any entry added since, quietly
      // undoing somebody else's change under the cover of this approval.
      // The reviewer approved "also require a human for these action types",
      // and that is what gets applied.
      const live = resolveOperatingPolicy(draftRef.scope_key);
      const liveList = live.document.approvals.always_require_human_action_types ?? [];
      const toAdd = draftRef.add_action_types.filter((a) => !liveList.includes(a));
      if (toAdd.length === 0) {
        // Somebody already made this exact change. Writing an identical
        // version would add a no-op entry to the policy's history.
        result = {
          proposal_id: proposal.id,
          target: 'policy',
          outcome:
            `No policy change was needed: ${draftRef.add_action_types.join(', ')} already require human approval `
            + `under ${live.citation}.`,
          detail: {
            activated_version: live.policy_version,
            previous_version: draftRef.base_version,
            already_satisfied: true,
          },
        };
        break;
      }

      // #68 writes and activates the version, re-validating as it goes.
      const saved = savePolicyVersion({
        scope: draftRef.scope,
        key: draftRef.scope_key,
        patch: { approvals: { always_require_human_action_types: [...liveList, ...toAdd] } },
        effective_at: new Date().toISOString(),
        change_reason:
          `Retrospective proposal ${proposal.id} approved by ${actor}: ${proposal.title}. ${proposal.basis_reason}`,
        actor,
        source: 'edit',
      });
      result = {
        proposal_id: proposal.id,
        target: 'policy',
        outcome: `Operating policy version ${saved.version} is active.`,
        detail: {
          policy_id: saved.id,
          activated_version: saved.version,
          previous_version: live.policy_version,
          added_action_types: toAdd,
          reviewed_changes: draftRef.changes,
        },
      };
      break;
    }
    case 'playbook_version': {
      // #74 re-validates the draft against the registry as it stands NOW and
      // refuses an invalid definition rather than activating it provisionally.
      const activated = activatePlaybookVersion({
        workflowId: draftRef.workflow_id,
        businessId,
        version: draftRef.version,
        actor,
        change_reason:
          `Retrospective proposal ${proposal.id} approved by ${actor}: ${proposal.title}.`,
      });
      result = {
        proposal_id: proposal.id,
        target: 'workflow',
        outcome: `Playbook version ${activated.version} of "${draftRef.workflow_name}" is active.`,
        detail: {
          workflow_id: draftRef.workflow_id,
          playbook_version_id: activated.id,
          activated_version: activated.version,
          previous_version: draftRef.base_version,
        },
      };
      break;
    }
    case 'agent_lifecycle': {
      result = applyAgentLifecycleAction(proposal, draftRef, businessId, actor);
      break;
    }
    default: {
      const exhaustive: never = draftRef;
      throw new RetrospectiveProposalError(
        `Unknown draft kind on proposal '${proposal.id}': ${JSON.stringify(exhaustive)}`,
      );
    }
  }

  db.prepare(`
    UPDATE retrospective_proposals
       SET status = 'approved', activation_result = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(JSON.stringify(result), proposal.id);
  audit(businessId, 'retrospective_proposal', proposal.id, 'activate', actor,
    { status: 'proposed' }, { status: 'approved' }, result as unknown as Record<string, unknown>);

  return result;
}

/**
 * Route an agent-lifecycle proposal to #69's existing controls. Both branches
 * call functions that already existed; nothing about agent lifecycle
 * semantics is redefined here.
 */
function applyAgentLifecycleAction(
  proposal: RetrospectiveProposal,
  draftRef: Extract<ProposalDraftRef, { kind: 'agent_lifecycle' }>,
  businessId: string,
  actor: string,
): ProposalActivationResult {
  if (draftRef.action === 'retire') {
    // #69/#49's existing retire control. It archives the lifecycle state,
    // marks the per-business installation uninstalled and writes the audit
    // row — none of which is re-implemented here.
    const outcome = uninstallAgent(draftRef.agent_id, actor, businessId);
    return {
      proposal_id: proposal.id,
      target: 'agent_lifecycle',
      outcome: `Agent '${draftRef.agent_id}' retired for this business.`,
      detail: { agent_id: draftRef.agent_id, action: 'retire', success: outcome.success },
    };
  }
  const transition = transitionAgent(draftRef.agent_id, 'standby', actor, {
    businessId,
    reason: `Retrospective proposal ${proposal.id} approved: ${proposal.title}`,
  });
  if (!transition.ok) {
    throw new RetrospectiveProposalError(
      `Could not pause agent '${draftRef.agent_id}': ${transition.error ?? 'unknown error'}`, 409, 'lifecycle_failed',
    );
  }
  return {
    proposal_id: proposal.id,
    target: 'agent_lifecycle',
    outcome: `Agent '${draftRef.agent_id}' moved to standby.`,
    detail: { agent_id: draftRef.agent_id, action: 'pause', from: transition.from, to: transition.to },
  };
}

// ─── Rollback ────────────────────────────────────────────────────────────────

export interface RollbackResult {
  proposal_id: string;
  target: ProposalTarget;
  outcome: string;
  detail: Record<string, unknown>;
}

/**
 * Undo an activated proposal through the owning subsystem's own
 * rollback-as-a-new-version function. History is never rewound: "we undid
 * the retrospective's change" is itself a versioned, audited change.
 */
export function rollbackRetrospectiveChange(input: {
  proposalId: string; businessId: string; actor: string; reason?: string | null;
}): RollbackResult {
  const proposal = getProposal(input.proposalId, input.businessId);
  if (!proposal) {
    throw new RetrospectiveProposalError(
      `No retrospective proposal '${input.proposalId}' for business '${input.businessId}'.`, 404, 'not_found',
    );
  }
  if (proposal.status !== 'approved') {
    throw new RetrospectiveProposalError(
      `Proposal '${proposal.id}' is '${proposal.status}' — only an activated proposal can be rolled back. ` +
      'A rejected or expired proposal never changed anything.',
      409, 'not_activated',
    );
  }
  const draftRef = proposal.draft_ref;
  const reason = input.reason
    ?? `Rolling back retrospective proposal ${proposal.id}: ${proposal.title}`;

  if (draftRef?.kind === 'policy_patch') {
    const detail = (proposal.activation_result?.detail ?? proposal.activation_result ?? {}) as {
      activated_version?: number; previous_version?: number; already_satisfied?: boolean;
    };
    const activatedVersion = detail.activated_version ?? null;
    const previousVersion = detail.previous_version ?? draftRef.base_version;
    const active = getActivePolicyVersion({ scope: draftRef.scope, key: draftRef.scope_key });

    if (detail.already_satisfied) {
      throw new RetrospectiveProposalError(
        `Proposal '${proposal.id}' did not change the policy — the rule was already in force when it was ` +
        'approved, so there is nothing of its own to undo.',
        409, 'nothing_to_roll_back',
      );
    }

    // The clean case: this proposal's version is still the one in force, so
    // #68's own rollback-as-a-new-version restores exactly what preceded it.
    if (active && activatedVersion != null && active.version === activatedVersion) {
      // previousVersion 0 means the business had never authored a policy —
      // this proposal's version WAS version 1. There is no row to roll back
      // to, so "before" is the inherited/default document. #68 expresses
      // that as a version with no overrides at all (replace rather than
      // merge, or the override this proposal added would survive the undo).
      const restored = previousVersion === 0
        ? savePolicyVersion({
            scope: draftRef.scope, key: draftRef.scope_key,
            patch: {}, replace_overrides: true,
            effective_at: new Date().toISOString(),
            change_reason:
              `${reason} (No policy version preceded this change, so the business returns to its ` +
              'inherited/default operating policy.)',
            actor: input.actor, source: 'rollback',
          })
        : rollbackPolicy({
            scope: draftRef.scope, key: draftRef.scope_key,
            to_version: previousVersion, actor: input.actor, change_reason: reason,
          });
      const result: RollbackResult = {
        proposal_id: proposal.id,
        target: 'policy',
        outcome: previousVersion === 0
          ? `Operating policy returned to the inherited default, written forward as version ${restored.version}.`
          : `Operating policy rolled back to version ${previousVersion}, written forward as version ${restored.version}.`,
        detail: {
          restored_from_version: previousVersion,
          restored_to_default: previousVersion === 0,
          new_version: restored.version,
          policy_id: restored.id,
        },
      };
      recordRollback(proposal, result, input.actor, reason);
      return result;
    }

    // The policy has moved on since this proposal was activated. A wholesale
    // rollback would take the later changes down with it, so only this
    // proposal's own effect is undone — as a forward version, like every
    // other policy change.
    const live = resolveOperatingPolicy(draftRef.scope_key);
    const liveList = live.document.approvals.always_require_human_action_types ?? [];
    const remaining = liveList.filter((a) => !draftRef.add_action_types.includes(a));
    if (remaining.length === liveList.length) {
      throw new RetrospectiveProposalError(
        `Proposal '${proposal.id}' added ${draftRef.add_action_types.join(', ')} to the human-approval list, ` +
        'but the current policy no longer contains those entries — its effect has already been undone.',
        409, 'nothing_to_roll_back',
      );
    }
    const restored = savePolicyVersion({
      scope: draftRef.scope, key: draftRef.scope_key,
      patch: { approvals: { always_require_human_action_types: remaining } },
      effective_at: new Date().toISOString(),
      change_reason:
        `${reason} (The policy has changed since version ${activatedVersion ?? '?'} was activated, so only this ` +
        "proposal's own addition was removed rather than rolling every later change back with it.)",
      actor: input.actor, source: 'rollback',
    });
    const result: RollbackResult = {
      proposal_id: proposal.id,
      target: 'policy',
      outcome:
        `Removed ${draftRef.add_action_types.join(', ')} from the human-approval list as operating policy ` +
        `version ${restored.version}; later policy changes were left in place.`,
      detail: {
        removed_action_types: draftRef.add_action_types,
        new_version: restored.version,
        policy_id: restored.id,
        partial: true,
      },
    };
    recordRollback(proposal, result, input.actor, reason);
    return result;
  }

  if (draftRef?.kind === 'playbook_version') {
    if (draftRef.base_version == null) {
      throw new RetrospectiveProposalError(
        `Proposal '${proposal.id}' has no prior playbook version to roll back to.`, 409, 'no_prior_version',
      );
    }
    const restored = rollbackPlaybookVersion({
      workflowId: draftRef.workflow_id,
      businessId: input.businessId,
      to_version: draftRef.base_version,
      actor: input.actor,
      change_reason: reason,
    });
    const result: RollbackResult = {
      proposal_id: proposal.id,
      target: 'workflow',
      outcome:
        `Playbook "${draftRef.workflow_name}" rolled back to version ${draftRef.base_version}, ` +
        `written forward as version ${restored.version}.`,
      detail: {
        workflow_id: draftRef.workflow_id,
        restored_from_version: draftRef.base_version,
        new_version: restored.version,
      },
    };
    recordRollback(proposal, result, input.actor, reason);
    return result;
  }

  throw new RetrospectiveProposalError(
    `Proposal '${proposal.id}' targets agent lifecycle, which has no rollback. Re-hiring a retired agent is a ` +
    'new hiring decision with its own evidence requirements, not an undo of this change.',
    409, 'rollback_unavailable',
  );
}

function recordRollback(
  proposal: RetrospectiveProposal, result: RollbackResult, actor: string, reason: string,
): void {
  db.prepare(`
    UPDATE retrospective_proposals
       SET activation_result = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(
    JSON.stringify({ ...(proposal.activation_result ?? {}), rolled_back: result }),
    proposal.id,
  );
  audit(proposal.business_id, 'retrospective_proposal', proposal.id, 'rollback', actor,
    proposal.activation_result, result as unknown as Record<string, unknown>, { reason });
}

// ─── Expiry ──────────────────────────────────────────────────────────────────

/**
 * Lapse proposals nobody reviewed in time, abandoning their drafts and
 * cancelling their review items. An expired proposal is a decision NOT to
 * change anything, so it leaves no draft behind that could be activated
 * later without a fresh look at the evidence.
 */
export function expireStaleProposals(businessId: string, now: Date = new Date()): number {
  const stale = (db.prepare(`
    SELECT * FROM retrospective_proposals
     WHERE business_id = ? AND status = 'proposed' AND expires_at IS NOT NULL AND expires_at <= ?
  `).all(businessId, now.toISOString()) as Array<Record<string, unknown>>)
    .map((r) => parseProposalRow(r)!);

  for (const proposal of stale) {
    abandonDraft(proposal.draft_ref, businessId, 'system:retrospective-expiry',
      `Proposal expired unreviewed after ${PROPOSAL_EXPIRY_DAYS} days.`);
    if (proposal.decision_task_id) {
      try {
        cancelTask(proposal.decision_task_id, 'system:retrospective-expiry',
          `Retrospective proposal expired unreviewed after ${PROPOSAL_EXPIRY_DAYS} days.`);
      } catch { /* already decided elsewhere — nothing to cancel */ }
    }
    db.prepare(
      "UPDATE retrospective_proposals SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(proposal.id);
    audit(businessId, 'retrospective_proposal', proposal.id, 'expire', 'system:retrospective-expiry',
      { status: 'proposed' }, { status: 'expired' }, { expires_at: proposal.expires_at });
  }
  return stale.length;
}
