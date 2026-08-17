/**
 * Bounded playbook execution (issue #74).
 *
 * This EXTENDS workflow-engine.ts rather than replacing it. Runs still live
 * in `workflow_runs`, steps still live in `workflow_step_runs`, and the
 * per-step human approval gate that engine already had still pauses a run
 * exactly as before. What a playbook run adds:
 *
 *   • it is bound to ONE immutable playbook version at start, so activating
 *     a new version never changes what an in-flight run is doing;
 *   • typed steps become REAL tasks with a registered action_type and a
 *     schema-checked payload, approved through the normal approval path —
 *     which means each one gets a real action receipt (#70) rather than a
 *     parallel bookkeeping story;
 *   • the run's status is derived from those receipts, and stops safely the
 *     moment one of them says the action failed or failed verification;
 *   • re-running or retrying cannot duplicate a side effect that already
 *     happened, using the SAME correlation-key identity execution-safety.ts
 *     and action-receipts.ts already use;
 *   • rollback is honest: it always stops later steps, and only claims to
 *     have compensated a step the registry says is rollback-capable AND for
 *     which the executor actually recorded rollback data.
 *
 * ── Why dispatch is not "await the action" ────────────────────────────────
 *
 * approveTask() queues a durable execution job; the worker runs it. A
 * playbook step therefore DISPATCHES and then reads the receipt. The run
 * sits at `awaiting_execution` until the receipt settles, and
 * advancePlaybookRun() is re-entrant so the route, the worker wake-up or a
 * scheduler tick can all push it forward. Nothing here polls or sleeps: an
 * unsettled receipt is a legitimate, reportable state, not a stall to hide
 * behind a spinner.
 */
import crypto from 'crypto';
import db, { generateId } from '../db/db.js';
import { pushDashboardEvent } from '../lib/sse-bus.js';
import { getActionRegistryEntry, validatePayloadAgainstSchema } from '../tasks/action-registry.js';
import { createTask, approveTask } from '../tasks/task-queue.js';
import {
  buildCorrelationKey, getReceiptForTaskVersion, getLatestReceiptForTask,
  type ActionReceiptRow,
} from '../tasks/action-receipts.js';
import {
  type PlaybookDefinition, type PlaybookStepDefinition, PlaybookValidationError,
  bindTemplate, validateRunInputs,
} from './playbook-schema.js';
import {
  type PlaybookVersion, PlaybookNotFoundError, PlaybookStateError,
  getActivePlaybookVersion, getPlaybookVersionById, recordPlaybookEvent, requireWorkflow,
} from './playbook-versions.js';
import { resolveStepApproval } from './playbook-simulation.js';

// ─── Run + step status vocabulary ────────────────────────────────────────────
//
// Deliberately a superset of the statuses workflow-engine.ts already writes,
// so the existing UI and routes keep working: 'running', 'paused',
// 'complete', 'failed', 'cancelled' mean what they always meant.

export type PlaybookRunStatus =
  | 'running'
  /** A step is waiting for a human (manual gate or risk-derived). */
  | 'paused'
  /** A step's task is approved and queued; its receipt has not settled yet. */
  | 'awaiting_execution'
  | 'complete'
  | 'failed'
  /** Stopped deliberately and safely — a receipt failed verification, or a human halted it. */
  | 'stopped'
  | 'cancelled'
  | 'rolled_back';

export type PlaybookStepStatus =
  | 'pending' | 'awaiting_approval' | 'dispatched' | 'complete' | 'failed'
  /** Never started, and now never will — an earlier step stopped the run. */
  | 'not_run';

export interface PlaybookRunRow {
  id: string;
  workflow_id: string;
  business_id: string;
  status: string;
  current_step: number;
  steps_total: number;
  steps_completed: number;
  context: string;
  inputs: string | null;
  playbook_version_id: string | null;
  playbook_version: number | null;
  run_key: string | null;
  stopped_reason: string | null;
  rollback_state: string | null;
  rollback_report: string | null;
  triggered_by: string;
  error: string | null;
}

export interface PlaybookStepRunRow {
  id: string;
  run_id: string;
  step_index: number;
  step_name: string;
  status: string;
  step_kind: string | null;
  action_type: string | null;
  resolved_input: string | null;
  typed_output: string | null;
  task_id: string | null;
  receipt_id: string | null;
  receipt_state: string | null;
  correlation_key: string | null;
  risk_tier: string | null;
  approval_reason: string | null;
  approval_required: number;
  approved_by: string | null;
  attempt_count: number;
  max_attempts: number;
  timeout_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  output: string | null;
  rollback_status: string | null;
  rollback_detail: string | null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

/**
 * Stable JSON: key order must not change a run's identity, or the same
 * request sent twice by a retrying client would start two runs.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The run-level analogue of action-receipts.ts's correlation key: the same
 * (playbook version, inputs, caller key) always resolves to the same run.
 * A caller that supplies no idempotency key still cannot accidentally
 * double-start the identical run, because the inputs hash alone is stable.
 */
export function buildPlaybookRunKey(
  versionId: string, inputs: Record<string, unknown>, idempotencyKey?: string | null,
): string {
  const digest = crypto.createHash('sha256')
    .update(`${versionId}|${canonicalJson(inputs)}|${idempotencyKey ?? ''}`)
    .digest('hex')
    .slice(0, 32);
  return `playbook:version=${versionId}:run=${digest}`;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function getPlaybookRunRow(runId: string, businessId: string): PlaybookRunRow | null {
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ? AND business_id = ?')
    .get(runId, businessId) as PlaybookRunRow | null;
}

export function listPlaybookStepRuns(runId: string): PlaybookStepRunRow[] {
  return db.prepare('SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY step_index ASC')
    .all(runId) as PlaybookStepRunRow[];
}

function requireRun(runId: string, businessId: string): PlaybookRunRow {
  const run = getPlaybookRunRow(runId, businessId);
  if (!run) {
    throw new PlaybookNotFoundError(
      `Playbook run '${runId}' was not found for business '${businessId}'.`,
    );
  }
  return run;
}

/** The immutable version an in-flight run is executing — never the currently-active one. */
function runDefinition(run: PlaybookRunRow): { version: PlaybookVersion; definition: PlaybookDefinition } {
  if (!run.playbook_version_id) {
    throw new PlaybookStateError(
      `Run '${run.id}' is a pre-playbook workflow run with no bound version; it is driven by workflow-engine.ts.`,
    );
  }
  const version = getPlaybookVersionById(run.playbook_version_id, run.business_id);
  if (!version) {
    throw new PlaybookNotFoundError(
      `The playbook version this run is bound to ('${run.playbook_version_id}') no longer resolves for this business.`,
    );
  }
  return { version, definition: version.definition };
}

function stepDefinitionAt(definition: PlaybookDefinition, index: number): PlaybookStepDefinition | null {
  return definition.steps.find((s) => s.index === index) ?? null;
}

// ─── Receipt interpretation ──────────────────────────────────────────────────

export type StepOutcome = 'pending' | 'succeeded' | 'failed' | 'needs_human';

export interface ReceiptVerdict {
  outcome: StepOutcome;
  reason: string;
  /** True specifically when an independent verification says the change did NOT take effect. */
  verification_failed: boolean;
}

/**
 * Turn a receipt into a step verdict.
 *
 * The distinction receipts exist to make is preserved here rather than
 * flattened: `externally_acknowledged` is enough for the step to proceed
 * (the external system took the write), but a receipt that later reaches
 * `verified` with a FAILING verdict stops the run — an acknowledged write
 * that measurement says did not take effect is exactly the case a bounded
 * playbook must not build further steps on top of.
 */
export function interpretReceipt(receipt: ActionReceiptRow | null): ReceiptVerdict {
  if (!receipt) {
    return { outcome: 'pending', reason: 'No receipt has been written for this step yet.', verification_failed: false };
  }

  const evidence = receipt.verification_evidence;
  const failedChecks = (evidence?.checks ?? []).filter((c) => c.passed === false);
  const verdictSaysFailed = typeof evidence?.verdict === 'string'
    && /^(fail|failed|unsuccessful|regressed|not_verified)$/i.test(evidence.verdict);
  if (receipt.state === 'verified' && (verdictSaysFailed || failedChecks.length > 0)) {
    return {
      outcome: 'failed',
      reason: verdictSaysFailed
        ? `Verification returned verdict '${evidence?.verdict}': the change did not take effect.`
        : `Verification failed ${failedChecks.length} check(s): ${failedChecks.map((c) => c.name).join(', ')}.`,
      verification_failed: true,
    };
  }

  switch (receipt.state) {
    case 'verified':
      return { outcome: 'succeeded', reason: 'An independent measurement verified the change took effect.', verification_failed: false };
    case 'externally_acknowledged':
      return {
        outcome: 'succeeded',
        reason: `The external system acknowledged the write${receipt.external_id ? ` (id ${receipt.external_id})` : ''}. Nothing has independently verified the result yet.`,
        verification_failed: false,
      };
    case 'executed':
      return {
        outcome: receipt.result_status === 'failure' ? 'failed' : 'succeeded',
        reason: receipt.result_summary ?? 'Blueprint completed the action.',
        verification_failed: false,
      };
    case 'failed':
      return { outcome: 'failed', reason: receipt.result_summary ?? 'The action failed.', verification_failed: false };
    case 'rejected_pre_execution':
      return {
        outcome: 'failed',
        reason: `Rejected before execution at the '${receipt.rejection_stage}' stage: ${receipt.rejection_reason ?? 'no reason recorded'}.`,
        verification_failed: false,
      };
    case 'cancelled':
      return { outcome: 'failed', reason: receipt.result_summary ?? 'The action was cancelled.', verification_failed: false };
    case 'ambiguous':
      return {
        outcome: 'needs_human',
        reason: receipt.result_summary
          ?? 'The outcome cannot be determined without a human looking at the external system.',
        verification_failed: false,
      };
    case 'authorized':
    case 'executing':
    default:
      return { outcome: 'pending', reason: `Receipt is at '${receipt.state}'; execution has not settled.`, verification_failed: false };
  }
}

function receiptForStep(step: PlaybookStepRunRow): ActionReceiptRow | null {
  if (!step.task_id) return null;
  const row = db.prepare('SELECT version FROM tasks WHERE id = ?').get(step.task_id) as { version: number } | null;
  if (row) {
    const exact = getReceiptForTaskVersion(step.task_id, Number(row.version ?? 1));
    if (exact) return exact;
  }
  return getLatestReceiptForTask(step.task_id);
}

/**
 * Aggregate every step's receipt into one coherent answer about the run.
 * A playbook run's status is not an independent claim — it is a summary of
 * the receipts underneath it, which is why this reads them rather than
 * trusting the cached `receipt_state` column.
 */
export interface PlaybookRunReceiptSummary {
  run_id: string;
  status: string;
  total_steps: number;
  receipts: Array<{
    step_index: number;
    step_name: string;
    task_id: string | null;
    receipt_id: string | null;
    correlation_key: string | null;
    state: string | null;
    result_status: string | null;
    external_id: string | null;
    external_permalink: string | null;
    verdict: StepOutcome | 'not_dispatched';
    reason: string;
  }>;
  counts: Record<string, number>;
  /** True when at least one step's receipt reports a failed verification. */
  verification_failed: boolean;
  /** Highest claim the whole run can honestly make. */
  aggregate_state: 'no_actions' | 'pending' | 'executed' | 'externally_acknowledged' | 'verified' | 'failed' | 'needs_human';
}

const AGGREGATE_RANK: Record<string, number> = {
  verified: 0, externally_acknowledged: 1, executed: 2, pending: 3, needs_human: 4, failed: 5,
};

export function summariseRunReceipts(runId: string, businessId: string): PlaybookRunReceiptSummary {
  const run = requireRun(runId, businessId);
  const steps = listPlaybookStepRuns(runId);
  const receipts: PlaybookRunReceiptSummary['receipts'] = [];
  const counts: Record<string, number> = {};
  let verificationFailed = false;
  let worst: string | null = null;

  for (const step of steps) {
    const receipt = receiptForStep(step);
    const verdict = step.task_id ? interpretReceipt(receipt) : null;
    if (verdict?.verification_failed) verificationFailed = true;

    const stateKey = receipt?.state ?? (step.task_id ? 'pending' : 'not_dispatched');
    counts[stateKey] = (counts[stateKey] ?? 0) + 1;

    if (verdict) {
      const contribution = verdict.outcome === 'succeeded'
        ? (receipt?.state === 'verified' ? 'verified'
          : receipt?.state === 'externally_acknowledged' ? 'externally_acknowledged' : 'executed')
        : verdict.outcome;
      if (worst === null || (AGGREGATE_RANK[contribution] ?? 3) > (AGGREGATE_RANK[worst] ?? 3)) {
        worst = contribution;
      }
    }

    receipts.push({
      step_index: step.step_index,
      step_name: step.step_name,
      task_id: step.task_id,
      receipt_id: receipt?.id ?? null,
      correlation_key: step.correlation_key,
      state: receipt?.state ?? null,
      result_status: receipt?.result_status ?? null,
      external_id: receipt?.external_id ?? null,
      external_permalink: receipt?.external_permalink ?? null,
      verdict: verdict ? verdict.outcome : 'not_dispatched',
      reason: verdict ? verdict.reason : 'This step has not created a task, so there is nothing to receipt yet.',
    });
  }

  return {
    run_id: runId,
    status: run.status,
    total_steps: steps.length,
    receipts,
    counts,
    verification_failed: verificationFailed,
    aggregate_state: (worst ?? 'no_actions') as PlaybookRunReceiptSummary['aggregate_state'],
  };
}

// ─── Starting a run ──────────────────────────────────────────────────────────

export interface StartPlaybookRunInput {
  workflowId: string;
  businessId: string;
  inputs?: Record<string, unknown>;
  /** 'dashboard:<user>' for a human, 'playbook:<id>'/'scheduler:<id>' for unattended runs. */
  actor: string;
  trigger_reason?: string | null;
  /** Supplied by a caller that may retry the request. Same key + same inputs = same run. */
  idempotency_key?: string | null;
}

export interface StartPlaybookRunResult {
  run_id: string;
  reused: boolean;
  status: string;
  version: number;
}

/**
 * Start (or re-join) a run of the workflow's ACTIVE playbook version.
 *
 * Binding to the active version happens exactly once, here. Everything
 * afterwards reads the version by id, which is what makes "activating v3
 * does not disturb the run that started on v2" true by construction rather
 * than by care.
 */
export function startPlaybookRun(input: StartPlaybookRunInput): StartPlaybookRunResult {
  const ref = { workflowId: input.workflowId, businessId: input.businessId };
  const workflow = requireWorkflow(ref);
  if (workflow.status === 'archived') {
    throw new PlaybookStateError(`Workflow '${workflow.name}' is archived and cannot be run.`);
  }

  const version = getActivePlaybookVersion(ref);
  if (!version) {
    throw new PlaybookStateError(
      'This workflow has no ACTIVE playbook version. Create a draft, validate it, then activate it before running.',
    );
  }

  const inputs = input.inputs ?? {};
  const inputViolations = validateRunInputs(version.definition, inputs);
  if (inputViolations.length > 0) throw new PlaybookValidationError(inputViolations);

  const runKey = buildPlaybookRunKey(version.id, inputs, input.idempotency_key);
  const existing = db.prepare('SELECT * FROM workflow_runs WHERE run_key = ?').get(runKey) as PlaybookRunRow | null;
  if (existing) {
    // Same version, same inputs, same key — this is the same run, not a
    // second one. Returning it (rather than starting a duplicate) is the
    // whole point of the key.
    recordPlaybookEvent({
      playbookVersionId: version.id, workflowId: input.workflowId, businessId: input.businessId,
      version: version.version, eventType: 'run_reused', actor: input.actor, runId: existing.id,
      reason: 'A run with the same playbook version, inputs and idempotency key already exists.',
    });
    return { run_id: existing.id, reused: true, status: existing.status, version: version.version };
  }

  const runId = generateId();
  const steps = version.definition.steps;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO workflow_runs (
        id, workflow_id, business_id, status, triggered_by, trigger_reason,
        current_step, steps_total, steps_completed, context,
        playbook_version_id, playbook_version, inputs, run_key, started_at
      ) VALUES (?, ?, ?, 'running', ?, ?, 0, ?, 0, '{}', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      runId, input.workflowId, input.businessId, input.actor, input.trigger_reason ?? null,
      steps.length, version.id, version.version, JSON.stringify(inputs), runKey,
    );

    for (const step of steps) {
      db.prepare(`
        INSERT INTO workflow_step_runs (
          id, run_id, workflow_id, business_id, step_index, step_name, agent_id, status,
          approval_required, step_kind, action_type, timeout_seconds, max_attempts, attempt_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0)
      `).run(
        generateId(), runId, input.workflowId, input.businessId, step.index, step.name,
        step.agent_id ?? (step.kind === 'action' ? 'system:playbook' : 'conductor'),
        step.approval_gate ? 1 : 0, step.kind, step.action_type,
        step.timeout_seconds, step.max_attempts,
      );
    }

    db.prepare(`
      UPDATE workflows SET run_count = run_count + 1, last_run_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(input.workflowId);
  })();

  recordPlaybookEvent({
    playbookVersionId: version.id, workflowId: input.workflowId, businessId: input.businessId,
    version: version.version, eventType: 'run_started', actor: input.actor, runId,
    reason: input.trigger_reason ?? null, metadata: { run_key: runKey, step_count: steps.length },
  });
  pushDashboardEvent(input.businessId, 'workflow_started', {
    runId, workflowId: input.workflowId, name: version.definition.name, playbook_version: version.version,
  });

  const status = advancePlaybookRun(runId, input.businessId, input.actor);
  return { run_id: runId, reused: false, status, version: version.version };
}

// ─── Advancing a run ─────────────────────────────────────────────────────────

function setRunStatus(runId: string, status: PlaybookRunStatus, patch: Partial<{
  stopped_reason: string | null; error: string | null; completed: boolean;
}> = {}): void {
  const sets = ['status = ?'];
  const values: Array<string | null> = [status];
  if (patch.stopped_reason !== undefined) { sets.push('stopped_reason = ?'); values.push(patch.stopped_reason); }
  if (patch.error !== undefined) { sets.push('error = ?'); values.push(patch.error); }
  if (patch.completed) sets.push('completed_at = CURRENT_TIMESTAMP');
  values.push(runId);
  db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

function markRemainingStepsNotRun(runId: string, fromIndex: number, reason: string): void {
  db.prepare(`
    UPDATE workflow_step_runs
       SET status = 'not_run', error = ?, completed_at = CURRENT_TIMESTAMP
     WHERE run_id = ? AND step_index > ? AND status IN ('pending', 'awaiting_approval')
  `).run(reason, runId, fromIndex);
}

/**
 * Stop the run safely: no further step is dispatched, and every step that
 * had not started is explicitly marked `not_run` rather than left looking
 * pending forever.
 */
function stopRun(run: PlaybookRunRow, stepIndex: number, reason: string, actor: string, status: PlaybookRunStatus = 'stopped'): string {
  markRemainingStepsNotRun(run.id, stepIndex, `Not run: the playbook stopped at step ${stepIndex}. ${reason}`);
  setRunStatus(run.id, status, { stopped_reason: reason, error: reason, completed: true });
  recordPlaybookEvent({
    playbookVersionId: run.playbook_version_id, workflowId: run.workflow_id, businessId: run.business_id,
    version: run.playbook_version ?? 0, eventType: 'run_stopped', actor, runId: run.id, stepIndex,
    reason, metadata: { status },
  });
  pushDashboardEvent(run.business_id, 'workflow_failed', { runId: run.id, stepIndex, error: reason });
  return status;
}

/** Safety ceiling for one advance pass; matches playbook-schema's MAX_STEPS. */
const MAX_ADVANCE_STEPS = 25;

/**
 * Push a run as far forward as it can go right now, then return its status.
 * Re-entrant and safe to call repeatedly: every transition is guarded by the
 * step's persisted status, so two concurrent callers cannot dispatch one
 * step twice.
 */
export function advancePlaybookRun(runId: string, businessId: string, actor: string): string {
  // Bounded: a step needs at most three transitions (dispatch, settle,
  // advance), so a bug in one of them can never spin. The run simply
  // reports where it got to.
  for (let guard = 0; guard <= 4 * MAX_ADVANCE_STEPS; guard++) {
    const run = requireRun(runId, businessId);
    if (!['running', 'paused', 'awaiting_execution'].includes(run.status)) return run.status;

    const { definition, version } = runDefinition(run);
    const stepDef = stepDefinitionAt(definition, run.current_step);

    if (!stepDef) {
      setRunStatus(runId, 'complete', { completed: true });
      recordPlaybookEvent({
        playbookVersionId: version.id, workflowId: run.workflow_id, businessId,
        version: version.version, eventType: 'run_completed', actor, runId,
        metadata: summariseRunReceipts(runId, businessId).counts,
      });
      pushDashboardEvent(businessId, 'workflow_complete', { runId, workflowId: run.workflow_id });
      return 'complete';
    }

    const stepRun = db.prepare('SELECT * FROM workflow_step_runs WHERE run_id = ? AND step_index = ?')
      .get(runId, run.current_step) as PlaybookStepRunRow | null;
    if (!stepRun) {
      return stopRun(run, run.current_step, `Step ${run.current_step} has no run record; the run cannot continue.`, actor, 'failed');
    }

    switch (stepRun.status) {
      case 'pending': {
        const approval = resolveStepApproval({
          step: stepDef,
          entry: stepDef.action_type ? getActionRegistryEntry(stepDef.action_type) : null,
          businessId,
          payload: bindStepInput(run, definition, stepDef).payload,
        });
        if (approval.requires_approval) {
          db.prepare(`
            UPDATE workflow_step_runs
               SET status = 'awaiting_approval', approval_required = 1, risk_tier = ?, approval_reason = ?
             WHERE id = ?
          `).run(approval.tier, approval.explanation, stepRun.id);
          setRunStatus(runId, 'paused');
          pushDashboardEvent(businessId, 'workflow_approval_needed', {
            runId, stepIndex: stepDef.index, stepName: stepDef.name,
            message: stepDef.approval_message || approval.explanation || `Review ${stepDef.name} before proceeding`,
          });
          return 'paused';
        }
        const dispatched = dispatchStep(run, definition, stepDef, stepRun, actor);
        if (dispatched !== 'dispatched') {
          // The step failed during dispatch. `on_failure: 'continue'` leaves
          // the run running at the next step; anything else has already
          // stopped it.
          const after = requireRun(runId, businessId);
          if (after.status === 'running') continue;
          return after.status;
        }
        continue;
      }

      case 'awaiting_approval':
        setRunStatus(runId, 'paused');
        return 'paused';

      case 'dispatched': {
        const settled = settleStep(run, stepDef, stepRun, actor);
        if (settled === 'pending') { setRunStatus(runId, 'awaiting_execution'); return 'awaiting_execution'; }
        if (settled === 'stopped') return requireRun(runId, businessId).status;
        continue;
      }

      case 'complete':
        db.prepare(`
          UPDATE workflow_runs SET current_step = current_step + 1,
            steps_completed = steps_completed + 1, status = 'running' WHERE id = ?
        `).run(runId);
        continue;

      case 'failed':
      case 'not_run':
      default:
        return stopRun(run, stepRun.step_index,
          stepRun.error ?? `Step ${stepRun.step_index} is '${stepRun.status}'.`, actor, 'failed');
    }
  }
  return requireRun(runId, businessId).status;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

interface BoundStepInput {
  payload: Record<string, unknown>;
  unresolved: string[];
}

/** Bind a step's template against the run inputs and the outputs earlier steps actually produced. */
function bindStepInput(run: PlaybookRunRow, definition: PlaybookDefinition, step: PlaybookStepDefinition): BoundStepInput {
  const inputs = parseJson<Record<string, unknown>>(run.inputs, {});
  const completed = db.prepare(
    "SELECT step_index, typed_output FROM workflow_step_runs WHERE run_id = ? AND status = 'complete'",
  ).all(run.id) as Array<{ step_index: number; typed_output: string | null }>;

  const stepOutputs: Record<number, { output: unknown }> = {};
  for (const row of completed) stepOutputs[row.step_index] = { output: parseJson<unknown>(row.typed_output, null) };

  const bound = bindTemplate(step.input, { inputs, steps: stepOutputs });
  void definition;
  return {
    payload: (bound.value && typeof bound.value === 'object' && !Array.isArray(bound.value))
      ? bound.value as Record<string, unknown> : {},
    unresolved: bound.unresolved,
  };
}

function failStep(
  run: PlaybookRunRow, step: PlaybookStepDefinition, stepRun: PlaybookStepRunRow, reason: string, actor: string,
): string {
  db.prepare(`
    UPDATE workflow_step_runs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(reason, stepRun.id);
  recordPlaybookEvent({
    playbookVersionId: run.playbook_version_id, workflowId: run.workflow_id, businessId: run.business_id,
    version: run.playbook_version ?? 0, eventType: 'run_step_failed', actor, runId: run.id,
    stepIndex: step.index, reason,
  });

  if (step.on_failure === 'continue') {
    db.prepare(`
      UPDATE workflow_runs SET current_step = current_step + 1, status = 'running' WHERE id = ?
    `).run(run.id);
    return 'running';
  }
  if (step.on_failure === 'rollback') {
    stopRun(run, step.index, `Step ${step.index} (${step.name}) failed: ${reason}`, actor, 'failed');
    compensatePlaybookRun({ runId: run.id, businessId: run.business_id, actor, reason: `Step ${step.index} failed.` });
    return 'rolled_back';
  }
  return stopRun(run, step.index, `Step ${step.index} (${step.name}) failed: ${reason}`, actor, 'failed');
}

/**
 * Turn a step into a real, typed, receipted action.
 *
 * Idempotency lives here, not in a wrapper: a step that already has a
 * task_id is NEVER given a second one. Whatever prompted the re-entry
 * (worker wake-up, operator refresh, crash recovery) resolves to the same
 * task, the same approved version, and therefore the same correlation key
 * and the same receipt row.
 */
function dispatchStep(
  run: PlaybookRunRow, definition: PlaybookDefinition, step: PlaybookStepDefinition,
  stepRun: PlaybookStepRunRow, actor: string,
): string {
  if (stepRun.task_id) {
    // Already dispatched. Re-binding it to a new task would duplicate the
    // side effect this key exists to prevent.
    db.prepare("UPDATE workflow_step_runs SET status = 'dispatched' WHERE id = ? AND status = 'pending'").run(stepRun.id);
    return 'dispatched';
  }

  db.prepare(`
    UPDATE workflow_step_runs SET status = 'dispatched', started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
      attempt_count = attempt_count + 1 WHERE id = ?
  `).run(stepRun.id);

  const bound = bindStepInput(run, definition, step);
  db.prepare('UPDATE workflow_step_runs SET resolved_input = ? WHERE id = ?')
    .run(JSON.stringify(bound.payload), stepRun.id);

  if (bound.unresolved.length > 0) {
    return failStep(run, step, stepRun,
      `Step input could not be resolved: ${bound.unresolved.join(', ')} did not resolve to a value. ` +
      'An earlier step did not produce the output this step depends on.', actor);
  }

  if (step.kind === 'manual') {
    // The free-text fallback, preserved from the pre-#74 step shape and
    // clearly labelled. A bounded playbook does NOT hand free text to an
    // agent unattended — the run paused for acknowledgement (see
    // resolveStepApproval's 'manual_step_acknowledgement'), and reaching
    // here means a person confirmed they did the work. Nothing typed was
    // executed, so there is deliberately no action receipt, and the record
    // says exactly that rather than implying Blueprint did something.
    const acknowledgedBy = stepRun.approved_by ?? actor;
    db.prepare(`
      UPDATE workflow_step_runs SET input = ?, status = 'complete', output = ?, completed_at = CURRENT_TIMESTAMP,
        typed_output = ? WHERE id = ?
    `).run(
      step.task_template ?? '',
      `Free-text step confirmed done by ${acknowledgedBy}. Blueprint executed no typed action, so there is ` +
      'no action receipt for this step.',
      JSON.stringify({
        kind: 'manual', task_template: step.task_template,
        acknowledged_by: acknowledgedBy, acknowledged_at: new Date().toISOString(),
      }),
      stepRun.id,
    );
    recordPlaybookEvent({
      playbookVersionId: run.playbook_version_id, workflowId: run.workflow_id, businessId: run.business_id,
      version: run.playbook_version ?? 0, eventType: 'run_step_completed', actor, runId: run.id,
      stepIndex: step.index, reason: 'Free-text step acknowledged by a person — no typed action was executed.',
    });
    return 'dispatched';
  }

  const entry = step.action_type ? getActionRegistryEntry(step.action_type) : null;
  if (!entry) {
    return failStep(run, step, stepRun,
      `action_type '${step.action_type}' is not registered in the Typed Action Registry, so this step cannot run.`, actor);
  }

  const payloadIssues = validatePayloadAgainstSchema(entry.payload_schema, bound.payload);
  if (payloadIssues.length > 0) {
    return failStep(run, step, stepRun,
      `Resolved input does not match the '${step.action_type}' payload schema: ` +
      `${payloadIssues.map((i) => i.message).join('; ')}.`, actor);
  }

  let taskId: string;
  try {
    const task = createTask({
      business_id: run.business_id,
      title: `${definition.name} · step ${step.index + 1}: ${step.name}`,
      description: `Playbook '${definition.name}' v${run.playbook_version} step ${step.index} (${step.name}), run ${run.id}.`,
      proposed_by: `playbook:${run.workflow_id}`,
      action_type: step.action_type,
      action_payload: bound.payload,
    });
    if (!task) throw new Error('Task creation returned no task.');
    taskId = task.id;
  } catch (err) {
    return failStep(run, step, stepRun, `Could not create the task for this step: ${(err as Error).message}`, actor);
  }

  db.prepare('UPDATE workflow_step_runs SET task_id = ? WHERE id = ?').run(taskId, stepRun.id);

  try {
    const approved = approveTask(taskId, actor);
    const taskVersion = Number(approved?.version ?? 1) || 1;
    const correlationKey = buildCorrelationKey(taskId, taskVersion);
    const receipt = getReceiptForTaskVersion(taskId, taskVersion);
    db.prepare(`
      UPDATE workflow_step_runs SET correlation_key = ?, receipt_id = ?, receipt_state = ? WHERE id = ?
    `).run(correlationKey, receipt?.id ?? null, receipt?.state ?? null, stepRun.id);
  } catch (err) {
    // The approval path refused it (policy, validation, connector, cap).
    // The task still exists and its receipt records the refusal — the step
    // fails with the real reason rather than a generic "step failed".
    return failStep(run, step, stepRun, `The action was not authorised: ${(err as Error).message}`, actor);
  }

  recordPlaybookEvent({
    playbookVersionId: run.playbook_version_id, workflowId: run.workflow_id, businessId: run.business_id,
    version: run.playbook_version ?? 0, eventType: 'run_step_dispatched', actor, runId: run.id,
    stepIndex: step.index, metadata: { task_id: taskId, action_type: step.action_type },
  });
  pushDashboardEvent(run.business_id, 'workflow_step_started', {
    runId: run.id, stepIndex: step.index, stepName: step.name, actionType: step.action_type,
  });
  return 'dispatched';
}

// ─── Settling a dispatched step ──────────────────────────────────────────────

/**
 * Read the step's receipt and decide what the run does next. Returns
 * 'pending' when the receipt has not settled, 'advanced' when the step
 * completed, 'stopped' when the run halted.
 */
function settleStep(
  run: PlaybookRunRow, step: PlaybookStepDefinition, stepRun: PlaybookStepRunRow, actor: string,
): 'pending' | 'advanced' | 'stopped' {
  // A manual step has no receipt; dispatchStep already completed it.
  if (step.kind === 'manual') {
    db.prepare("UPDATE workflow_step_runs SET status = 'complete', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?").run(stepRun.id);
    return 'advanced';
  }

  const receipt = receiptForStep(stepRun);
  const verdict = interpretReceipt(receipt);
  db.prepare('UPDATE workflow_step_runs SET receipt_state = ?, receipt_id = ? WHERE id = ?')
    .run(receipt?.state ?? null, receipt?.id ?? stepRun.receipt_id, stepRun.id);

  if (verdict.outcome === 'pending') return 'pending';

  if (verdict.outcome === 'needs_human') {
    stopRun(run, step.index,
      `Step ${step.index} (${step.name}) has an undetermined outcome: ${verdict.reason} ` +
      'The run stopped rather than building later steps on an unknown result.', actor, 'stopped');
    return 'stopped';
  }

  if (verdict.outcome === 'failed') {
    const label = verdict.verification_failed
      ? `verification failed — ${verdict.reason}`
      : verdict.reason;
    failStep(run, step, stepRun, label, actor);
    return 'stopped';
  }

  // Succeeded. Record the typed output and check it against the step's own
  // declared contract — a step that promised an output and did not produce
  // it has NOT satisfied its verification, whatever the receipt says about
  // the API call.
  const output = buildTypedOutput(receipt);
  if (step.output_schema) {
    const issues = validatePayloadAgainstSchema(step.output_schema, output);
    if (issues.length > 0) {
      failStep(run, step, stepRun,
        `verification failed — the step completed but its output does not satisfy the output contract it declares: ` +
        `${issues.map((i) => i.message).join('; ')}.`, actor);
      return 'stopped';
    }
  }

  db.prepare(`
    UPDATE workflow_step_runs
       SET status = 'complete', typed_output = ?, output = ?, completed_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(JSON.stringify(output), verdict.reason, stepRun.id);

  recordPlaybookEvent({
    playbookVersionId: run.playbook_version_id, workflowId: run.workflow_id, businessId: run.business_id,
    version: run.playbook_version ?? 0, eventType: 'run_step_completed', actor, runId: run.id,
    stepIndex: step.index, reason: verdict.reason,
    metadata: { receipt_id: receipt?.id ?? null, receipt_state: receipt?.state ?? null },
  });
  pushDashboardEvent(run.business_id, 'workflow_step_complete', {
    runId: run.id, stepIndex: step.index, stepName: step.name,
  });
  return 'advanced';
}

/** The typed output a later step may reference: the receipt's own facts, not a free-text blob. */
function buildTypedOutput(receipt: ActionReceiptRow | null): Record<string, unknown> {
  if (!receipt) return {};
  const detail = (receipt.result_detail && typeof receipt.result_detail === 'object') ? receipt.result_detail : {};
  return {
    ...detail,
    task_id: receipt.task_id,
    receipt_id: receipt.id,
    receipt_state: receipt.state,
    result_status: receipt.result_status,
    external_id: receipt.external_id,
    external_permalink: receipt.external_permalink,
    correlation_key: receipt.correlation_key,
  };
}

// ─── Approval / rejection ────────────────────────────────────────────────────

export function approvePlaybookStep(input: {
  runId: string; businessId: string; stepIndex: number; actor: string;
}): string {
  const run = requireRun(input.runId, input.businessId);
  const stepRun = db.prepare('SELECT * FROM workflow_step_runs WHERE run_id = ? AND step_index = ?')
    .get(input.runId, input.stepIndex) as PlaybookStepRunRow | null;
  if (!stepRun) throw new PlaybookNotFoundError(`Step ${input.stepIndex} does not exist on run '${input.runId}'.`);
  if (stepRun.status !== 'awaiting_approval') {
    throw new PlaybookStateError(
      `Step ${input.stepIndex} is '${stepRun.status}', not awaiting approval.`,
    );
  }

  const { definition } = runDefinition(run);
  const stepDef = stepDefinitionAt(definition, input.stepIndex);
  if (!stepDef) throw new PlaybookNotFoundError(`Step ${input.stepIndex} is not part of the version this run is bound to.`);

  db.prepare(`
    UPDATE workflow_step_runs SET status = 'pending', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(input.actor, stepRun.id);
  db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(input.runId);

  recordPlaybookEvent({
    playbookVersionId: run.playbook_version_id, workflowId: run.workflow_id, businessId: input.businessId,
    version: run.playbook_version ?? 0, eventType: 'run_step_approved', actor: input.actor,
    runId: input.runId, stepIndex: input.stepIndex, reason: stepRun.approval_reason,
  });
  pushDashboardEvent(input.businessId, 'workflow_step_approved', { runId: input.runId, stepIndex: input.stepIndex });

  // Dispatch directly rather than re-deriving approval: the human just
  // supplied it, and re-running resolveStepApproval() would pause again.
  const refreshed = db.prepare('SELECT * FROM workflow_step_runs WHERE id = ?').get(stepRun.id) as PlaybookStepRunRow;
  const outcome = dispatchStep(run, definition, stepDef, refreshed, input.actor);
  if (outcome !== 'dispatched') return requireRun(input.runId, input.businessId).status;
  return advancePlaybookRun(input.runId, input.businessId, input.actor);
}

export function rejectPlaybookStep(input: {
  runId: string; businessId: string; stepIndex: number; reason: string; actor: string;
}): string {
  const run = requireRun(input.runId, input.businessId);
  db.prepare(`
    UPDATE workflow_step_runs
       SET status = 'failed', rejection_reason = ?, approved_by = ?, completed_at = CURRENT_TIMESTAMP
     WHERE run_id = ? AND step_index = ?
  `).run(input.reason, input.actor, input.runId, input.stepIndex);
  return stopRun(run, input.stepIndex, `Step ${input.stepIndex} rejected: ${input.reason}`, input.actor, 'cancelled');
}

// ─── Retry ───────────────────────────────────────────────────────────────────

export interface RetryResult {
  retried: boolean;
  reason: string;
  status: string;
}

/**
 * Retry a failed step WITHOUT risking a duplicate side effect.
 *
 * The rule is deliberately conservative and stated in the response rather
 * than buried: if the step's receipt shows the action actually ran — an
 * `executed_at`, or an external reference handed back — the retry is
 * REFUSED. Blueprint cannot know whether re-running would create a second
 * external object, and guessing is exactly what execution-safety.ts and
 * action-receipts.ts refuse to do. Only a step that provably never executed
 * is re-dispatched, and it gets a fresh task (hence a fresh correlation
 * key), matching how a rejected-then-re-approved task already behaves.
 */
export function retryPlaybookStep(input: {
  runId: string; businessId: string; stepIndex: number; actor: string;
}): RetryResult {
  const run = requireRun(input.runId, input.businessId);
  const stepRun = db.prepare('SELECT * FROM workflow_step_runs WHERE run_id = ? AND step_index = ?')
    .get(input.runId, input.stepIndex) as PlaybookStepRunRow | null;
  if (!stepRun) throw new PlaybookNotFoundError(`Step ${input.stepIndex} does not exist on run '${input.runId}'.`);
  if (stepRun.status !== 'failed') {
    throw new PlaybookStateError(`Step ${input.stepIndex} is '${stepRun.status}', not failed — there is nothing to retry.`);
  }

  const attempts = Number(stepRun.attempt_count ?? 0);
  const maxAttempts = Number(stepRun.max_attempts ?? 1);
  if (attempts >= maxAttempts) {
    return {
      retried: false,
      status: run.status,
      reason: `Step ${input.stepIndex} has used all ${maxAttempts} attempt(s) its playbook version allows.`,
    };
  }

  const receipt = receiptForStep(stepRun);
  if (receipt && (receipt.executed_at || receipt.external_id)) {
    return {
      retried: false,
      status: run.status,
      reason:
        `Step ${input.stepIndex} will not be retried: its receipt (${receipt.correlation_key}) shows the action ` +
        `already ${receipt.external_id ? `produced external object '${receipt.external_id}'` : 'executed'}. ` +
        'Retrying could duplicate that side effect, so a human must decide what to do.',
    };
  }

  const { definition } = runDefinition(run);
  const stepDef = stepDefinitionAt(definition, input.stepIndex);
  if (!stepDef) throw new PlaybookNotFoundError(`Step ${input.stepIndex} is not part of the version this run is bound to.`);

  // Clear the failed attempt's task binding: it provably never executed, so
  // a fresh task (and fresh correlation key) is the honest representation
  // of a second attempt — not a reuse of a receipt that says "failed".
  db.prepare(`
    UPDATE workflow_step_runs
       SET status = 'pending', error = NULL, task_id = NULL, receipt_id = NULL, receipt_state = NULL,
           correlation_key = NULL, completed_at = NULL
     WHERE id = ?
  `).run(stepRun.id);
  db.prepare(`
    UPDATE workflow_runs SET status = 'running', current_step = ?, stopped_reason = NULL, error = NULL,
      completed_at = NULL WHERE id = ?
  `).run(input.stepIndex, input.runId);
  db.prepare(`
    UPDATE workflow_step_runs SET status = 'pending', error = NULL
     WHERE run_id = ? AND step_index > ? AND status = 'not_run'
  `).run(input.runId, input.stepIndex);

  const status = advancePlaybookRun(input.runId, input.businessId, input.actor);
  return {
    retried: true,
    status,
    reason: `Step ${input.stepIndex} never executed (no receipt evidence of an action), so it was safely re-attempted.`,
  };
}

// ─── Compensation / rollback ─────────────────────────────────────────────────

export type StepCompensation =
  /** The rollback data recorded at execution time was replayed successfully. */
  | 'compensated'
  /** The step had not run, or had been dispatched but never executed: nothing to undo. */
  | 'nothing_to_undo'
  /** The step will now never run. This is a real guarantee, not compensation. */
  | 'prevented'
  /** The action type is not rollback-capable — the effect STANDS. Said plainly. */
  | 'unsupported'
  /** Rollback-capable in principle, but no rollback data exists for this task. */
  | 'unavailable'
  /** A rollback was attempted and itself failed. */
  | 'failed';

export interface CompensationReport {
  run_id: string;
  rollback_state: 'complete' | 'partial' | 'not_possible';
  /** True when at least one already-executed step cannot be undone by Blueprint. */
  irreversible_effects: boolean;
  steps: Array<{
    step_index: number;
    step_name: string;
    action_type: string | null;
    task_id: string | null;
    outcome: StepCompensation;
    detail: string;
  }>;
  summary: string;
}

/**
 * Roll a playbook run back.
 *
 * Two very different things happen, and they are reported separately
 * because conflating them would be a lie:
 *
 *   1. PREVENTION — every step that has not run is marked not_run. This
 *      always works and is the strongest guarantee rollback offers.
 *   2. COMPENSATION — for steps that DID run, Blueprint replays the
 *      executor's recorded rollback data, but only where the Typed Action
 *      Registry says `supports_rollback` AND rollback data was actually
 *      recorded. Everything else is reported as 'unsupported' or
 *      'unavailable' with the effect that still stands, never as a
 *      successful compensation.
 *
 * Most registered action types are NOT rollback-capable today. A run of
 * those that has already executed therefore reports
 * `irreversible_effects: true` — which is the honest answer an operator
 * needs, rather than a green "rolled back" badge over an unchanged world.
 */
export function compensatePlaybookRun(input: {
  runId: string; businessId: string; actor: string; reason?: string | null;
}): CompensationReport {
  const run = requireRun(input.runId, input.businessId);
  const steps = listPlaybookStepRuns(input.runId);
  const report: CompensationReport['steps'] = [];

  // 1. Prevention first — stop anything that has not started, before
  //    spending time on compensation.
  db.prepare(`
    UPDATE workflow_step_runs
       SET status = 'not_run', rollback_status = 'prevented',
           rollback_detail = 'Not run: the playbook run was rolled back before this step started.',
           error = COALESCE(error, 'Not run: playbook run rolled back.'), completed_at = CURRENT_TIMESTAMP
     WHERE run_id = ? AND status IN ('pending', 'awaiting_approval')
  `).run(input.runId);

  let irreversible = false;
  let compensated = 0;
  let attempted = 0;

  // 2. Compensation in reverse order — undo the most recent effect first.
  for (const step of [...steps].reverse()) {
    const refreshed = db.prepare('SELECT * FROM workflow_step_runs WHERE id = ?').get(step.id) as PlaybookStepRunRow;

    if (refreshed.status === 'not_run') {
      report.push({
        step_index: step.step_index, step_name: step.step_name, action_type: step.action_type,
        task_id: null, outcome: 'prevented',
        detail: 'This step had not started and will now never run.',
      });
      continue;
    }

    if (!refreshed.task_id) {
      setStepRollback(refreshed.id, 'nothing_to_undo', 'This step created no task, so there is no side effect to undo.');
      report.push({
        step_index: step.step_index, step_name: step.step_name, action_type: step.action_type,
        task_id: null, outcome: 'nothing_to_undo',
        detail: 'This step created no task, so there is no side effect to undo.',
      });
      continue;
    }

    const receipt = receiptForStep(refreshed);
    const everExecuted = Boolean(receipt?.executed_at || receipt?.external_id);
    if (!everExecuted) {
      const detail =
        'The receipt shows this step never executed (no execution timestamp and no external reference), ' +
        'so there is nothing to compensate.';
      setStepRollback(refreshed.id, 'nothing_to_undo', detail);
      report.push({
        step_index: step.step_index, step_name: step.step_name, action_type: step.action_type,
        task_id: refreshed.task_id, outcome: 'nothing_to_undo', detail,
      });
      continue;
    }

    const entry = refreshed.action_type ? getActionRegistryEntry(refreshed.action_type) : null;
    if (!entry?.supports_rollback) {
      irreversible = true;
      const detail =
        `action_type '${refreshed.action_type}' is not rollback-capable in the Typed Action Registry. ` +
        'This step HAS taken effect and Blueprint cannot undo it. Later steps were stopped, but this ' +
        'change stands and needs a human decision.';
      setStepRollback(refreshed.id, 'unsupported', detail);
      report.push({
        step_index: step.step_index, step_name: step.step_name, action_type: refreshed.action_type,
        task_id: refreshed.task_id, outcome: 'unsupported', detail,
      });
      continue;
    }

    const taskRow = db.prepare('SELECT rollback_data FROM tasks WHERE id = ?')
      .get(refreshed.task_id) as { rollback_data: string | null } | null;
    if (!taskRow?.rollback_data) {
      irreversible = true;
      const detail =
        `action_type '${refreshed.action_type}' is rollback-capable, but the executor recorded no rollback data ` +
        'for this task, so there is nothing to replay. The effect stands and needs a human decision.';
      setStepRollback(refreshed.id, 'unavailable', detail);
      report.push({
        step_index: step.step_index, step_name: step.step_name, action_type: refreshed.action_type,
        task_id: refreshed.task_id, outcome: 'unavailable', detail,
      });
      continue;
    }

    attempted++;
    setStepRollback(refreshed.id, 'requested',
      'Compensation requested: replaying the rollback data the executor recorded at execution time.');
    report.push({
      step_index: step.step_index, step_name: step.step_name, action_type: refreshed.action_type,
      task_id: refreshed.task_id, outcome: 'compensated',
      detail: 'Compensation requested — replaying the executor\'s recorded rollback data.',
    });
    compensated++;
    void runCompensationForStep(refreshed.id, refreshed.task_id);
  }

  const rollbackState: CompensationReport['rollback_state'] =
    irreversible ? (compensated > 0 ? 'partial' : 'not_possible') : 'complete';
  const summary = irreversible
    ? `Later steps were stopped. ${compensated} step(s) had compensation requested; at least one executed step ` +
      'CANNOT be undone by Blueprint and still stands.'
    : `Later steps were stopped and every executed step was either compensated (${attempted}) or had nothing to undo.`;

  db.prepare(`
    UPDATE workflow_runs SET status = 'rolled_back', rollback_state = ?, rollback_report = ?,
      stopped_reason = COALESCE(stopped_reason, ?), completed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(rollbackState, JSON.stringify(report), input.reason ?? 'Rolled back.', input.runId);

  recordPlaybookEvent({
    playbookVersionId: run.playbook_version_id, workflowId: run.workflow_id, businessId: input.businessId,
    version: run.playbook_version ?? 0, eventType: 'run_rolled_back', actor: input.actor, runId: input.runId,
    reason: input.reason ?? null, metadata: { rollback_state: rollbackState, irreversible_effects: irreversible },
  });

  return {
    run_id: input.runId,
    rollback_state: rollbackState,
    irreversible_effects: irreversible,
    steps: report.sort((a, b) => a.step_index - b.step_index),
    summary,
  };
}

function setStepRollback(stepRunId: string, status: string, detail: string): void {
  db.prepare('UPDATE workflow_step_runs SET rollback_status = ?, rollback_detail = ? WHERE id = ?')
    .run(status, detail, stepRunId);
}

/**
 * Replay the executor's rollback for one step. Dynamically imported so
 * neither this module's import graph nor a simulation can reach the
 * executor, and best-effort: a failed compensation is RECORDED as failed,
 * never swallowed into a success.
 */
async function runCompensationForStep(stepRunId: string, taskId: string): Promise<void> {
  try {
    const { rollbackTask } = await import('../tasks/executor.js') as unknown as {
      rollbackTask: (id: string) => Promise<{ outcome: string }>;
    };
    const result = await rollbackTask(taskId);
    setStepRollback(stepRunId, 'compensated', `Compensated: ${result.outcome}`);
  } catch (err) {
    setStepRollback(stepRunId, 'failed',
      `Compensation was attempted and FAILED: ${(err as Error).message}. The original effect still stands.`);
    db.prepare("UPDATE workflow_runs SET rollback_state = 'partial' WHERE id = (SELECT run_id FROM workflow_step_runs WHERE id = ?)")
      .run(stepRunId);
  }
}

// ─── Cancellation ────────────────────────────────────────────────────────────

export function cancelPlaybookRun(input: {
  runId: string; businessId: string; actor: string; reason?: string | null;
}): string {
  const run = requireRun(input.runId, input.businessId);
  if (!['running', 'paused', 'awaiting_execution'].includes(run.status)) return run.status;
  return stopRun(run, run.current_step, input.reason ?? 'Cancelled by user.', input.actor, 'cancelled');
}

// ─── Composite read for the UI ───────────────────────────────────────────────

export function describePlaybookRun(runId: string, businessId: string): Record<string, unknown> {
  const run = requireRun(runId, businessId);
  const steps = listPlaybookStepRuns(runId);
  const summary = summariseRunReceipts(runId, businessId);
  const version = run.playbook_version_id ? getPlaybookVersionById(run.playbook_version_id, businessId) : null;

  return {
    run: {
      ...run,
      inputs: parseJson<Record<string, unknown>>(run.inputs, {}),
      context: parseJson<Record<string, unknown>>(run.context, {}),
      rollback_report: parseJson<unknown>(run.rollback_report, null),
    },
    playbook: version
      ? {
          id: version.id, version: version.version, state: version.state,
          name: version.definition.name, description: version.definition.description,
        }
      : null,
    steps: steps.map((step) => {
      const definitionStep = version ? stepDefinitionAt(version.definition, step.step_index) : null;
      return {
        ...step,
        resolved_input: parseJson<unknown>(step.resolved_input, null),
        typed_output: parseJson<unknown>(step.typed_output, null),
        definition: definitionStep
          ? {
              kind: definitionStep.kind,
              action_type: definitionStep.action_type,
              output_schema: definitionStep.output_schema,
              on_failure: definitionStep.on_failure,
              timeout_seconds: definitionStep.timeout_seconds,
              max_attempts: definitionStep.max_attempts,
            }
          : null,
        receipt: summary.receipts.find((r) => r.step_index === step.step_index) ?? null,
      };
    }),
    receipt_summary: summary,
  };
}
