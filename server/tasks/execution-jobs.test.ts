/**
 * server/tasks/execution-jobs.ts — the durable job queue/lease primitives
 * behind Phase 1's execution reliability guarantees:
 *   - at most one active job per task (DB-level partial unique index)
 *   - claim is a compare-and-swap, safe under concurrent claimers
 *   - leases expire and become reclaimable; reclaim is itself a CAS
 *   - terminal states (dead_letter/manual_review/cancelled) are the only
 *     ones an operator retry can move back to 'queued' from
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  enqueueExecutionJob, getExecutionJob, getActiveJobForTask, listExecutionJobs,
  claimNextJob, findStuckJobs, reclaimStuckJob, extendLease, markExecuting,
  setExternalReference, completeJob, failJob, markManualReview, cancelJob,
  retryJob, requeueAfterRecovery,
} from './execution-jobs.js';
import type { TaskRow } from './task-queue.js';

const BIZ = 'biz_execjobs_test';

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, version, created_at, updated_at)
    VALUES (?, ?, 'Execution job fixture task', 'test', 'approved', 'yellow', 'requires_approval', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, BIZ, (overrides.action_type as string) ?? 'github_issue', (overrides.version as number) ?? 1);
  return { id, business_id: BIZ, action_type: 'github_issue', version: 1, ...overrides } as TaskRow;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'ExecJobs Test', 'execjobs-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

// claimNextJob()/findStuckJobs() operate system-wide (they pick "the next
// eligible job", not "this test's job") — without cleaning up between
// tests, a queued/stuck job left behind by an earlier test can be the one
// a later test's claim call actually picks up instead of its own fixture,
// producing flaky, order-dependent failures. Full isolation per test.
afterEach(() => {
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

describe('enqueueExecutionJob', () => {
  test('creates exactly one queued job for a task', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    expect(job.status).toBe('queued');
    expect(job.task_id).toBe(task.id);
    expect(job.business_id).toBe(BIZ);
    expect(job.attempt_count).toBe(0);
  });

  test('a second active job for the same task is rejected at the DB level', () => {
    const task = makeTask();
    enqueueExecutionJob(task);
    expect(() => enqueueExecutionJob(task)).toThrow();
  });

  test('a new job CAN be enqueued once the prior one reaches a terminal state', () => {
    const task = makeTask();
    const first = enqueueExecutionJob(task);
    completeJob(first.id, { outcome: 'done' });
    expect(() => enqueueExecutionJob(task)).not.toThrow();
  });
});

describe('getActiveJobForTask', () => {
  test('finds the active (non-terminal) job and ignores terminal ones', () => {
    const task = makeTask();
    expect(getActiveJobForTask(task.id)).toBeNull();
    const job = enqueueExecutionJob(task);
    expect(getActiveJobForTask(task.id)?.id).toBe(job.id);
    completeJob(job.id, {});
    expect(getActiveJobForTask(task.id)).toBeNull();
  });
});

describe('claimNextJob', () => {
  test('claims a queued job, assigns lease_owner and a future lease_expires_at', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    const claimed = claimNextJob('worker-a');
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('leased');
    expect(claimed?.lease_owner).toBe('worker-a');
    expect(new Date(claimed!.lease_expires_at!).getTime()).toBeGreaterThan(Date.now());
  });

  test('two concurrent claimers racing for the same job — exactly one wins', () => {
    const task = makeTask();
    enqueueExecutionJob(task);
    const a = claimNextJob('worker-a');
    const b = claimNextJob('worker-b');
    // Only one of the two calls can have won this job; the other call
    // either got null or (if other jobs existed) something else — here
    // there's only one job, so exactly one of a/b is non-null.
    const winners = [a, b].filter(Boolean);
    expect(winners.length).toBe(1);
  });

  test('does not reclaim a job that is leased or executing, even with an expired lease', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    // Force the lease into the past directly (simulating a dead worker).
    db.prepare(`UPDATE execution_jobs SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), job.id);
    expect(claimNextJob('worker-b')).toBeNull();
  });

  test('does not claim a job whose next_attempt_at is in the future (retry backoff)', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    db.prepare(`UPDATE execution_jobs SET next_attempt_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + 60_000).toISOString(), job.id);
    expect(claimNextJob('worker-a')).toBeNull();
  });
});

describe('findStuckJobs / reclaimStuckJob', () => {
  test('finds jobs stuck in leased/executing with an expired lease', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    db.prepare(`UPDATE execution_jobs SET status = 'executing', lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), job.id);

    const stuck = findStuckJobs();
    expect(stuck.some((j) => j.id === job.id)).toBe(true);
  });

  test('does not find jobs with a still-live lease', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a'); // lease is in the future by default
    const stuck = findStuckJobs();
    expect(stuck.some((j) => j.id === job.id)).toBe(false);
  });

  test('reclaimStuckJob is a CAS — only one of two concurrent recoverers wins', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    db.prepare(`UPDATE execution_jobs SET status = 'executing', lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), job.id);

    const r1 = reclaimStuckJob(job.id, 'recovery-1');
    const r2 = reclaimStuckJob(job.id, 'recovery-2');
    expect([r1, r2].filter(Boolean).length).toBe(1);
  });
});

describe('extendLease', () => {
  test('extends the lease for the current owner', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    const before = getExecutionJob(job.id)!.lease_expires_at;
    expect(extendLease(job.id, 'worker-a')).toBe(true);
    const after = getExecutionJob(job.id)!.lease_expires_at;
    expect(new Date(after!).getTime()).toBeGreaterThanOrEqual(new Date(before!).getTime());
  });

  test('fails for a caller that is not the current lease owner', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    expect(extendLease(job.id, 'worker-b')).toBe(false);
  });
});

describe('markExecuting', () => {
  test('transitions leased -> executing only for the lease owner', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    expect(markExecuting(job.id, 'worker-b')).toBe(false);
    expect(markExecuting(job.id, 'worker-a')).toBe(true);
    expect(getExecutionJob(job.id)?.status).toBe('executing');
  });
});

describe('setExternalReference / completeJob', () => {
  test('persists an external reference independently of completion, and completing clears the lease', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    markExecuting(job.id, 'worker-a');
    setExternalReference(job.id, { issue_number: 42, repo: 'acme/widgets' });
    expect(getExecutionJob(job.id)?.external_reference).toEqual({ issue_number: 42, repo: 'acme/widgets' });

    completeJob(job.id, { outcome: 'created' });
    const done = getExecutionJob(job.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.lease_owner).toBeNull();
    expect(done.result).toEqual({ outcome: 'created' });
    // The reference set before completion must survive it.
    expect(done.external_reference).toEqual({ issue_number: 42, repo: 'acme/widgets' });
  });
});

describe('failJob', () => {
  test('schedules a retry (back to queued) while attempts remain', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    const outcome = failJob(job.id, 'transient error');
    expect(outcome.status).toBe('queued');
    expect(outcome.attempt).toBe(1);
    const row = getExecutionJob(job.id)!;
    expect(row.status).toBe('queued');
    expect(row.next_attempt_at).not.toBeNull();
    expect(row.last_error).toBe('transient error');
  });

  test('moves to dead_letter once max_attempts is exhausted', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    db.prepare(`UPDATE execution_jobs SET max_attempts = 2 WHERE id = ?`).run(job.id);

    let outcome = failJob(job.id, 'err 1');
    expect(outcome.status).toBe('queued');
    outcome = failJob(job.id, 'err 2');
    expect(outcome.status).toBe('dead_letter');
    expect(getExecutionJob(job.id)?.status).toBe('dead_letter');
  });
});

describe('markManualReview / cancelJob / retryJob / requeueAfterRecovery', () => {
  test('markManualReview clears the lease and records the reason', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    markManualReview(job.id, 'ambiguous external state');
    const row = getExecutionJob(job.id)!;
    expect(row.status).toBe('manual_review');
    expect(row.lease_owner).toBeNull();
    expect(row.last_error).toBe('ambiguous external state');
  });

  test('cancelJob only succeeds from queued or manual_review', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    markExecuting(job.id, 'worker-a');
    expect(cancelJob(job.id)).toBe(false); // executing — not cancellable

    const task2 = makeTask();
    const job2 = enqueueExecutionJob(task2);
    expect(cancelJob(job2.id)).toBe(true); // queued — cancellable
    expect(getExecutionJob(job2.id)?.status).toBe('cancelled');
  });

  test('retryJob only moves terminal states back to queued, with a fresh attempt budget', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    expect(retryJob(job.id)).toBe(false); // leased — not a terminal state

    db.prepare(`UPDATE execution_jobs SET status = 'dead_letter', attempt_count = 5, last_error = 'boom' WHERE id = ?`).run(job.id);
    expect(retryJob(job.id)).toBe(true);
    const row = getExecutionJob(job.id)!;
    expect(row.status).toBe('queued');
    expect(row.attempt_count).toBe(0);
    expect(row.last_error).toBeNull();
  });

  test('requeueAfterRecovery returns a reclaimed job to queued and bumps attempt_count', () => {
    const task = makeTask();
    const job = enqueueExecutionJob(task);
    claimNextJob('worker-a');
    requeueAfterRecovery(job.id, 'recovered after crash');
    const row = getExecutionJob(job.id)!;
    expect(row.status).toBe('queued');
    expect(row.attempt_count).toBe(1);
    expect(row.lease_owner).toBeNull();
  });
});

describe('listExecutionJobs', () => {
  test('filters by business and status, and paginates', () => {
    const t1 = makeTask();
    const t2 = makeTask();
    const j1 = enqueueExecutionJob(t1);
    const j2 = enqueueExecutionJob(t2);
    completeJob(j2.id, {});

    const queuedOnly = listExecutionJobs(BIZ, { status: ['queued'] });
    expect(queuedOnly.jobs.some((j) => j.id === j1.id)).toBe(true);
    expect(queuedOnly.jobs.some((j) => j.id === j2.id)).toBe(false);

    const all = listExecutionJobs(BIZ, {});
    expect(all.total).toBeGreaterThanOrEqual(2);
  });
});
