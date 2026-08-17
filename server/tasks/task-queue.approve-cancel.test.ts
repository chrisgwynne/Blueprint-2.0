/**
 * task-queue.ts's approveTask()/cancelTask() — the canonical, atomic
 * approval path every surface (dashboard, BAP, Telegram) calls through.
 * Covers Phase 1 exit criteria:
 *   - "concurrent dashboard+Telegram approval of the same task executes
 *     exactly once" — simulated here as two concurrent approveTask() calls
 *     racing for the same task.
 *   - approval atomically creates exactly one execution_jobs row bound to
 *     the approved version/snapshot (the partial unique index backs this,
 *     not just application logic).
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { createTask, approveTask, cancelTask, getTask } from './task-queue.js';
import { getActiveJobForTask } from './execution-jobs.js';

const BIZ = 'biz_approve_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Approve Test', 'approve-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterEach(() => {
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

function proposeTask(): { id: string } {
  // action_type must actually be executable (in executor.ts's
  // EXECUTABLE_ACTION_TYPES / action_registry.dispatched_by_executor) —
  // these tests assert approveTask() enqueues a real, executable job.
  // 'investigation' has no required connectors/business type and needs no
  // approval-flow scaffolding beyond that. See issue #39: a registered but
  // non-executable action_type (e.g. 'notification') is now routed to
  // manual_review at approval instead of being enqueued.
  const task = createTask({
    business_id: BIZ,
    title: 'Approve/cancel fixture task',
    proposed_by: 'test',
    action_type: 'investigation',
    action_payload: { note: 'x' },
    approval_mode: 'requires_approval',
  })!;
  return { id: task.id };
}

describe('approveTask', () => {
  test('moves a proposed task to approved, bumps version, snapshots the payload, and enqueues one job', () => {
    const { id } = proposeTask();
    const before = getTask(id)!;
    expect(before.version).toBe(1);

    const after = approveTask(id, 'dashboard:tester')!;
    expect(after.status).toBe('approved');
    expect(after.version).toBe(2);
    expect(after.approved_payload_snapshot).toEqual({ note: 'x' });

    const job = getActiveJobForTask(id);
    expect(job).not.toBeNull();
    expect(job?.status).toBe('queued');
    expect(job?.task_version).toBe(2);
  });

  test('approves a manual task without enqueuing an unexecutable job', () => {
    const task = createTask({
      business_id: BIZ,
      title: 'Manual fixture task',
      proposed_by: 'test',
      action_type: null,
      action_payload: {},
      approval_mode: 'requires_approval',
    })!;

    const after = approveTask(task.id, 'dashboard:tester')!;
    expect(after.status).toBe('approved');
    expect(after.approved_payload_snapshot).toEqual({});
    expect(getActiveJobForTask(task.id)).toBeNull();

    const jobs = db.prepare('SELECT COUNT(*) as n FROM execution_jobs WHERE task_id = ?').get(task.id) as { n: number };
    expect(jobs.n).toBe(0);
  });

  test('two concurrent approvals of the same task — exactly one succeeds, exactly one job is enqueued', () => {
    const { id } = proposeTask();

    const attempts = [
      () => { try { return { ok: true, task: approveTask(id, 'dashboard:tester') }; } catch (err) { return { ok: false, error: (err as Error).message }; } },
      () => { try { return { ok: true, task: approveTask(id, 'telegram:owner') }; } catch (err) { return { ok: false, error: (err as Error).message }; } },
    ];
    const results = attempts.map((fn) => fn());

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as { error: string }).error).toMatch(/Cannot approve task in status/);

    // Exactly one execution job exists for the task — approveTask's
    // "second CAS attempt loses" behaviour didn't also create a second job.
    const jobs = db.prepare('SELECT COUNT(*) as n FROM execution_jobs WHERE task_id = ?').get(id) as { n: number };
    expect(jobs.n).toBe(1);

    const finalTask = getTask(id)!;
    expect(finalTask.status).toBe('approved');
    expect(finalTask.version).toBe(2); // bumped exactly once, not twice
  });

  test('approving an already-approved task is rejected, not silently re-run', () => {
    const { id } = proposeTask();
    approveTask(id, 'dashboard:tester');
    expect(() => approveTask(id, 'dashboard:tester-again')).toThrow(/Cannot approve task in status 'approved'/);
  });

  test('rejects approval of a non-existent task', () => {
    expect(() => approveTask('does-not-exist', 'tester')).toThrow(/not found/);
  });
});

describe('cancelTask', () => {
  test('cancels a proposed task', () => {
    const { id } = proposeTask();
    const after = cancelTask(id, 'dashboard:tester', 'no longer needed')!;
    expect(after.status).toBe('cancelled');
  });

  test('cancelling an approved task also cancels its active execution job', () => {
    const { id } = proposeTask();
    approveTask(id, 'dashboard:tester');
    const jobBefore = getActiveJobForTask(id);
    expect(jobBefore).not.toBeNull();

    cancelTask(id, 'dashboard:tester', 'changed my mind');
    expect(getTask(id)?.status).toBe('cancelled');
    expect(getActiveJobForTask(id)).toBeNull(); // the job moved to 'cancelled', no longer "active"

    const jobRow = db.prepare('SELECT status FROM execution_jobs WHERE id = ?').get(jobBefore!.id) as { status: string };
    expect(jobRow.status).toBe('cancelled');
  });

  test('cannot cancel a task that is already executing', () => {
    const { id } = proposeTask();
    approveTask(id, 'dashboard:tester');
    db.prepare(`UPDATE tasks SET status = 'executing' WHERE id = ?`).run(id);
    expect(() => cancelTask(id, 'dashboard:tester')).toThrow(/Cannot cancel task in status 'executing'/);
  });

  test('rejects cancellation of a non-existent task', () => {
    expect(() => cancelTask('does-not-exist', 'tester')).toThrow(/not found/);
  });
});
