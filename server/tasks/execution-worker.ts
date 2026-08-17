/**
 * The execution worker — claims durable execution_jobs and drives them
 * through executor.ts:executeTask(). This is the *only* place executeTask
 * is called from (see task-queue.ts:approveTask's docstring on the
 * canonical execution path) — approval creates a queued job; this module
 * is what turns "queued" into "actually executed".
 *
 * Also owns crash recovery: jobs left in 'leased'/'executing' with an
 * expired lease (the worker that held them died) are found by
 * claimNextJob() itself (its WHERE clause treats an expired lease as
 * claimable) — but a job whose lease keeps expiring without ever
 * completing (e.g. the external-write step itself is what's hanging)
 * needs its own decision: is a fresh attempt safe, or does this need a
 * human? recoverStuckJobs() makes that call using execution-safety.ts's
 * classification, on a slower, independent cron tick from the worker
 * loop itself (jobs/scheduler.ts).
 */
import { getTask, updateTaskStatus } from './task-queue.js';
import { executeTask, isExecutable } from './executor.js';
import { classifyAction } from './execution-safety.js';
import {
  claimNextJob, markExecuting, completeJob, failJob, markManualReview,
  getExecutionJob, findStuckJobs, reclaimStuckJob, requeueAfterRecovery,
  type ExecutionJobRow,
} from './execution-jobs.js';
import { getInstanceId } from '../jobs/scheduler-lock.js';

const MAX_JOBS_PER_TICK = 10;
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
}

function payloadChangedFromApproval(task: ReturnType<typeof getTask>, job: ExecutionJobRow): { changed: boolean; reason?: string; evidence?: Record<string, unknown> } {
  if (!task) return { changed: true, reason: 'Task no longer exists.' };
  if (Number(task.version ?? 0) !== Number(job.task_version ?? 0)) {
    return {
      changed: true,
      reason: `Task version changed after approval (approved version ${job.task_version}, current version ${task.version}).`,
      evidence: { approved_version: job.task_version, current_version: task.version },
    };
  }
  if (!task.approved_payload_snapshot) {
    return {
      changed: true,
      reason: 'Task has no approved payload snapshot; reapproval is required before execution.',
      evidence: { current_action_payload: task.action_payload },
    };
  }
  const approved = stableStringify(task.approved_payload_snapshot);
  const current = stableStringify(task.action_payload ?? {});
  if (approved !== current) {
    return {
      changed: true,
      reason: 'Task action payload changed after approval; reapproval is required before execution.',
      evidence: { approved_payload_snapshot: task.approved_payload_snapshot, current_action_payload: task.action_payload },
    };
  }
  return { changed: false };
}

/**
 * Claim and run up to MAX_JOBS_PER_TICK eligible jobs. Safe to call
 * concurrently with itself across processes — claimNextJob()'s
 * compare-and-swap means each job is claimed by exactly one caller.
 */
export async function runExecutionWorkerTick(): Promise<{ claimed: number }> {
  const owner = getInstanceId();
  let claimed = 0;

  for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
    const job = claimNextJob(owner);
    if (!job) break;
    claimed++;
    await runOneJob(job, owner);
  }

  return { claimed };
}

async function runOneJob(job: ExecutionJobRow, owner: string): Promise<void> {
  const task = getTask(job.task_id);
  if (!task) {
    failJob(job.id, `Task ${job.task_id} no longer exists.`);
    return;
  }

  // The task must still be 'approved' — if it was cancelled after the job
  // was queued (task-queue.ts:cancelTask also cancels the job, but guard
  // here too in case of any other path), or somehow moved on, don't run.
  if (task.status !== 'approved') {
    failJob(job.id, `Task status is '${task.status}', expected 'approved' — not executing.`);
    return;
  }

  const integrity = payloadChangedFromApproval(task, job);
  if (integrity.changed) {
    try {
      updateTaskStatus(task.id, 'manual_review', 'system:execution-integrity', {
        outcome: integrity.reason,
        outcome_data: integrity.evidence ?? {},
        reason: integrity.reason,
      });
    } catch {}
    markManualReview(job.id, integrity.reason ?? 'Approved task changed before execution; reapproval is required.');
    return;
  }

  // Issue #39 belt-and-braces: approveTask() no longer enqueues a job for a
  // non-executable action_type (see task-queue.ts), but a job can still
  // reach here for one already queued before that fix deployed, or if the
  // registry's `dispatched_by_executor` mirror ever drifts from
  // executor.ts's real EXECUTABLE_ACTION_TYPES set. Either way, this is a
  // permanent condition, not a transient execution failure -- route to
  // manual_review directly, without leasing/executing the job or spending
  // any retry attempts on something that can never succeed.
  if (!job.action_type || !isExecutable(job.action_type)) {
    const reason = `action_type '${job.action_type}' has no executor.ts dispatch case -- permanently non-executable, ` +
      'routed to manual review without consuming retry budget.';
    try {
      updateTaskStatus(task.id, 'manual_review', 'system:execution-worker', { outcome: reason });
    } catch {}
    markManualReview(job.id, reason);
    return;
  }

  if (!markExecuting(job.id, owner)) {
    // Lost the lease between claim and here (extremely unlikely given
    // claimNextJob's own atomicity, but if it happens, just stop — the
    // job is presumably now owned by someone else).
    return;
  }

  try {
    const result = await executeTask(task.id, job);
    if (result.ok) {
      completeJob(job.id, { outcome: result.outcome, outcome_data: result.outcome_data ?? {} });
    } else {
      handleFailure(job, task.action_type, result.error ?? 'Unknown execution error');
    }
  } catch (err) {
    handleFailure(job, task.action_type, (err as Error).message);
  }
}

/**
 * Crash recovery. Finds execution_jobs whose lease expired while still
 * 'leased'/'executing' — the worker that held them died (process crash,
 * kill -9, host reboot) before it could finish. For each:
 *
 *   1. If the job's external_reference is already recorded, the external
 *      write (if any) demonstrably succeeded before the crash — finalise
 *      the task as complete using that reference. Nothing is re-executed.
 *   2. Else if the action is 'internal_idempotent' (classifyAction,
 *      execution-safety.ts) — no external system was touched, or the
 *      touch is a safe overwrite (KB writes) — it's safe to retry from
 *      scratch. The task is moved 'executing' -> 'approved' (the one
 *      recovery-only transition, see task-queue.ts's VALID_TRANSITIONS)
 *      and the job is requeued.
 *   3. Else (an external-write action with no reference) — we cannot
 *      tell whether the create call happened before the crash. Never
 *      guess: the task moves to 'manual_review' and the job is flagged
 *      the same way, so a human (or an operator-triggered retry after
 *      they've checked the actual GitHub/Shopify account) decides.
 *
 * Runs on its own cron tick (jobs/scheduler.ts), independent of and
 * slower than the normal claim loop — lease expiry is the signal that
 * something died, so this only needs to run roughly as often as the
 * lease TTL, not every worker tick.
 */
export async function recoverStuckJobs(): Promise<{ recovered: number; requeued: number; manualReview: number }> {
  const owner = getInstanceId();
  const stats = { recovered: 0, requeued: 0, manualReview: 0 };

  for (const job of findStuckJobs()) {
    if (!reclaimStuckJob(job.id, owner)) continue; // another instance got there first

    const task = getTask(job.task_id);
    if (!task) {
      failJob(job.id, `Task ${job.task_id} no longer exists (found during crash recovery).`);
      continue;
    }

    if (job.external_reference) {
      try {
        updateTaskStatus(task.id, 'complete', 'system:recovery', {
          outcome: 'Recovered after an interrupted execution — external reference was already recorded before the crash.',
          outcome_data: job.external_reference,
        });
        completeJob(job.id, { outcome: 'recovered', outcome_data: job.external_reference });
        stats.recovered++;
      } catch (err) {
        markManualReview(job.id, `Recovery could not finalise a completed external write: ${(err as Error).message}`);
        stats.manualReview++;
      }
      continue;
    }

    if (classifyAction(job.action_type) === 'internal_idempotent') {
      try {
        updateTaskStatus(task.id, 'approved', 'system:recovery', {
          outcome: 'Recovered after an interrupted execution — action type is safe to retry from scratch.',
        });
        requeueAfterRecovery(job.id, 'Requeued by crash recovery: internal/idempotent action type, no external reference at risk.');
        stats.requeued++;
      } catch (err) {
        markManualReview(job.id, `Recovery could not requeue a safe-to-retry job: ${(err as Error).message}`);
        stats.manualReview++;
      }
      continue;
    }

    // External-write action, no reference recorded — cannot rule out that
    // the create call succeeded right before the crash. Do not retry.
    try {
      updateTaskStatus(task.id, 'manual_review', 'system:recovery', {
        outcome: 'Execution was interrupted mid-run for an external-write action with no recorded reference — ' +
          'cannot determine whether the external object was already created. A human must check before retrying.',
      });
    } catch {}
    markManualReview(
      job.id,
      'Lease expired mid-execution for an external-write action with no external_reference recorded — ' +
      'the create call may have already succeeded. Verify manually before retrying.'
    );
    stats.manualReview++;
  }

  return stats;
}

/**
 * Decide what happens to a failed attempt. executor.ts's executeTask()
 * already moved the *task* to 'blocked' or 'failed' itself (it has its
 * own error handling/self-heal hook) — this only decides the *job's*
 * fate: retry, dead-letter, or manual_review.
 *
 * Never blind-retries an external-write action whose job has no
 * external_reference recorded — the create call may have actually
 * succeeded and only the *result recording* failed (e.g. a crash right
 * after the API call returned). For those, and only those, a human
 * reviews before anything runs again. Internal/idempotent actions and
 * external actions that DO already have a reference (so a retry would
 * hit the pre-flight check in executor.ts and skip re-creating) are safe
 * to retry automatically with backoff.
 */
function handleFailure(job: ExecutionJobRow, actionType: string | null, error: string): void {
  const current = getExecutionJob(job.id);
  const hasReference = !!current?.external_reference;
  const isExternalUnverified = classifyAction(actionType) === 'external_verifiable' && !hasReference;

  if (isExternalUnverified) {
    markManualReview(
      job.id,
      `Execution failed with no recorded external reference for an external-write action ` +
      `('${actionType}') — cannot safely auto-retry without risking a duplicate. ${error}`
    );
    try { updateTaskStatus(job.task_id, 'manual_review', 'system:executor', { outcome: `Needs manual review: ${error}` }); } catch {}
    return;
  }

  const outcome = failJob(job.id, error);
  if (outcome.status === 'dead_letter') {
    try { updateTaskStatus(job.task_id, 'failed', 'system:executor', { outcome: `Execution failed after ${outcome.attempt} attempts: ${error}` }); } catch {}
  }
  // status === 'queued' (retry scheduled): leave the task's own status as
  // whatever executeTask() left it at (typically 'failed' or 'blocked')
  // — the *job* will retry and, on success, moves the task forward again
  // via the normal complete/executing transitions. Tasks left 'blocked'
  // (missing connector) are retried by the same mechanism once the
  // connector is available, matching the pre-Phase-1 behaviour.
}
