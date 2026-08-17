/**
 * execution-worker.ts's recoverStuckJobs() — the crash-recovery sweep
 * covering Phase 1 exit criteria "kill during execution + restart resumes
 * or safely enters review" and "lost worker heartbeat -> lease expires and
 * recovers". Exercises all three branches documented on the function:
 *   1. external_reference already recorded -> finalise as complete, no re-run
 *   2. internal_idempotent action, no reference -> safe to requeue
 *   3. external_verifiable action, no reference -> manual_review (never guess)
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { recoverStuckJobs, runExecutionWorkerTick } from './execution-worker.js';
import { enqueueExecutionJob, claimNextJob, getExecutionJob, setExternalReference } from './execution-jobs.js';
import { getTask, createTask, type TaskRow } from './task-queue.js';

const BIZ = 'biz_recovery_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Recovery Test', 'recovery-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterEach(() => {
  db.prepare(`DELETE FROM outcome_measurement_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

/**
 * Build an approved task and enqueue its execution job directly (the same
 * two DB operations approveTask() performs), then force it into a stuck,
 * lease-expired state. Deliberately does NOT call the real approveTask() —
 * that also fires triggerWorkerTick(), which wakes the actual background
 * execution worker via a live dynamic import of jobs/scheduler.js. In a
 * shared-process test run that background tick can race this test's own
 * assertions (claiming/executing the job moments after recoverStuckJobs()
 * requeues it), which is a real behaviour in production but pure flakiness
 * in a test that wants full control over the job's state.
 */
function approvedAndStuck(actionType: string): { taskId: string; jobId: string } {
  const task = createTask({
    business_id: BIZ,
    title: 'Recovery fixture task',
    proposed_by: 'test',
    action_type: actionType,
    action_payload: {},
    approval_mode: 'requires_approval',
  })!;
  db.prepare(`UPDATE tasks SET status = 'approved', version = version + 1 WHERE id = ?`).run(task.id);
  const approved = { ...task, status: 'approved', version: (task.version ?? 1) + 1 } as TaskRow;
  enqueueExecutionJob(approved);

  const job = db.prepare(`SELECT id FROM execution_jobs WHERE task_id = ?`).get(task.id) as { id: string };
  claimNextJob('dead-worker');
  db.prepare(`UPDATE execution_jobs SET status = 'executing', lease_expires_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 60_000).toISOString(), job.id);
  db.prepare(`UPDATE tasks SET status = 'executing' WHERE id = ?`).run(task.id);

  return { taskId: task.id, jobId: job.id };
}

describe('recoverStuckJobs', () => {
  test('a stuck job with an already-recorded external_reference is finalised as complete, not re-run', async () => {
    const { taskId, jobId } = approvedAndStuck('github_issue'); // external_verifiable
    setExternalReference(jobId, { issue_number: 7, repo: 'acme/widgets' });

    const stats = await recoverStuckJobs();
    expect(stats.recovered).toBe(1);
    expect(stats.requeued).toBe(0);
    expect(stats.manualReview).toBe(0);

    expect(getTask(taskId)?.status).toBe('complete');
    expect(getExecutionJob(jobId)?.status).toBe('succeeded');
  });

  test('a stuck internal_idempotent job with no external reference is safely requeued for a fresh attempt', async () => {
    const { taskId, jobId } = approvedAndStuck('content_draft'); // registered internal_idempotent action, not in EXTERNAL_VERIFIABLE_ACTIONS

    const stats = await recoverStuckJobs();
    expect(stats.recovered).toBe(0);
    expect(stats.requeued).toBe(1);
    expect(stats.manualReview).toBe(0);

    expect(getTask(taskId)?.status).toBe('approved'); // recovery-only transition back
    expect(getExecutionJob(jobId)?.status).toBe('queued');
  });

  test('a stuck external-write job with no reference is sent to manual review, never blindly retried', async () => {
    const { taskId, jobId } = approvedAndStuck('shopify_product_create'); // external_verifiable

    const stats = await recoverStuckJobs();
    expect(stats.recovered).toBe(0);
    expect(stats.requeued).toBe(0);
    expect(stats.manualReview).toBe(1);

    expect(getTask(taskId)?.status).toBe('manual_review');
    expect(getExecutionJob(jobId)?.status).toBe('manual_review');
  });

  test('a job whose lease has not expired is left untouched', async () => {
    const task = createTask({
      business_id: BIZ, title: 'Live lease fixture', proposed_by: 'test',
      action_type: 'content_draft', action_payload: {}, approval_mode: 'requires_approval',
    })!;
    db.prepare(`UPDATE tasks SET status = 'approved', version = version + 1 WHERE id = ?`).run(task.id);
    enqueueExecutionJob({ ...task, status: 'approved', version: (task.version ?? 1) + 1 } as TaskRow);
    claimNextJob('live-worker'); // lease is in the future by default

    const stats = await recoverStuckJobs();
    expect(stats.recovered + stats.requeued + stats.manualReview).toBe(0);
  });

  test('two concurrent recovery sweeps do not double-process the same stuck job', async () => {
    const { jobId } = approvedAndStuck('content_draft');

    const [a, b] = await Promise.all([recoverStuckJobs(), recoverStuckJobs()]);
    const totalRequeued = a.requeued + b.requeued;
    expect(totalRequeued).toBe(1); // exactly one sweep actually reclaimed and acted on it

    expect(getExecutionJob(jobId)?.status).toBe('queued');
  });
});

describe('runExecutionWorkerTick approval integrity', () => {
  function approvedQueuedTask(payload: Record<string, unknown>): { taskId: string; jobId: string } {
    const task = createTask({
      business_id: BIZ,
      title: 'Execution integrity fixture',
      proposed_by: 'test',
      action_type: 'research_connector',
      action_payload: payload,
      approval_mode: 'requires_approval',
    })!;
    db.prepare(`UPDATE tasks SET status = 'approved', version = version + 1, approved_payload_snapshot = ? WHERE id = ?`).run(JSON.stringify(payload), task.id);
    const approved = getTask(task.id)!;
    const job = enqueueExecutionJob(approved);
    return { taskId: task.id, jobId: job.id };
  }

  test('does not execute when the action payload changed after approval', async () => {
    const { taskId, jobId } = approvedQueuedTask({ description: 'approved connector research' });
    db.prepare(`UPDATE tasks SET action_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(JSON.stringify({ description: 'changed after approval' }), taskId);

    const result = await runExecutionWorkerTick();

    expect(result.claimed).toBe(1);
    expect(getTask(taskId)?.status).toBe('manual_review');
    const job = getExecutionJob(jobId)!;
    expect(job.status).toBe('manual_review');
    expect(job.last_error).toContain('payload changed after approval');
  });

  test('does not execute when the task version changed after approval', async () => {
    const { taskId, jobId } = approvedQueuedTask({ description: 'approved connector research' });
    db.prepare(`UPDATE tasks SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(taskId);

    const result = await runExecutionWorkerTick();

    expect(result.claimed).toBe(1);
    expect(getTask(taskId)?.status).toBe('manual_review');
    const job = getExecutionJob(jobId)!;
    expect(job.status).toBe('manual_review');
    expect(job.last_error).toContain('version changed after approval');
  });
});

/**
 * Issue #39 belt-and-braces: approveTask() (task-queue.ts) no longer
 * enqueues a job for a non-executable action_type at all, but a job can
 * still reach the worker for one queued before that fix (or a future
 * action_registry/executor.ts drift). Either way, runExecutionWorkerTick()
 * must recognise a permanently non-executable action_type on first claim
 * and route it straight to manual_review — never lease/execute it, and
 * never spend a retry attempt on something that can never succeed.
 */
describe('runExecutionWorkerTick — non-executable action_type (issue #39)', () => {
  // Bypasses approveTask() on purpose: simulates a job that reached
  // 'queued' despite not being executable (e.g. one enqueued before this
  // fix shipped), so the worker's own defensive check is what's exercised
  // here, independent of the approval-time gate.
  function queuedJobForNonExecutableType(actionType: string): { taskId: string; jobId: string } {
    const task = createTask({
      business_id: BIZ,
      title: 'Non-executable fixture task',
      proposed_by: 'test',
      action_type: actionType,
      action_payload: {},
      approval_mode: 'requires_approval',
    })!;
    const version = (task.version ?? 1) + 1;
    db.prepare(`UPDATE tasks SET status = 'approved', version = ?, approved_payload_snapshot = ? WHERE id = ?`)
      .run(version, JSON.stringify(task.action_payload ?? {}), task.id);
    const job = enqueueExecutionJob({ ...task, status: 'approved', version } as TaskRow);
    return { taskId: task.id, jobId: job.id };
  }

  test('a registered-but-non-executable action_type (product_suggestion) is routed to manual_review on first claim, not retried', async () => {
    const { taskId, jobId } = queuedJobForNonExecutableType('product_suggestion');

    const result = await runExecutionWorkerTick();

    expect(result.claimed).toBe(1);
    expect(getTask(taskId)?.status).toBe('manual_review');
    const job = getExecutionJob(jobId)!;
    expect(job.status).toBe('manual_review');
    expect(job.attempt_count).toBe(0); // no retry budget spent — this is terminal, not a failed attempt
    expect(job.last_error).toContain('no executor.ts dispatch case');
  });

  test('a registered-but-non-executable action_type (page_optimisation) never cycles back to queued', async () => {
    const { taskId, jobId } = queuedJobForNonExecutableType('page_optimisation');

    await runExecutionWorkerTick();

    const job = getExecutionJob(jobId)!;
    expect(job.status).not.toBe('queued');
    expect(job.status).toBe('manual_review');
    expect(job.attempt_count).toBe(0);
    expect(getTask(taskId)?.status).toBe('manual_review');

    // A second tick must not find (or re-touch) this job — it's terminal.
    const second = await runExecutionWorkerTick();
    expect(second.claimed).toBe(0);
    expect(getExecutionJob(jobId)!.attempt_count).toBe(0);
  });
});
