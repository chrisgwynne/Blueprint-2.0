/**
 * Durable execution jobs — leases, crash recovery, and the worker loop that
 * drives approved tasks through executor.ts:executeTask().
 *
 * A job is created exactly once per approval (task-queue.ts:approveTask,
 * in the same transaction as the approval itself — see idx_execution_jobs
 * _one_active_per_task, which makes a second active job for the same task
 * impossible at the DB level, not just by convention).
 *
 * Job lifecycle:
 *   queued -> leased -> executing -> succeeded
 *                                 -> failed (retryable, attempts remain)   -> queued (after backoff)
 *                                 -> dead_letter (retries exhausted)
 *                                 -> manual_review (ambiguous external-write outcome — see execution-safety.ts)
 *   queued|leased|manual_review -> cancelled (operator/BAP cancel)
 */
import db, { generateId } from '../db/db.js';
import type { TaskRow } from './task-queue.js';

export type JobStatus =
  | 'queued' | 'leased' | 'executing'
  | 'succeeded' | 'failed' | 'dead_letter' | 'manual_review' | 'cancelled';

export interface ExecutionJobRow {
  id: string;
  task_id: string;
  task_version: number;
  business_id: string;
  action_type: string | null;
  status: JobStatus;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  external_reference: Record<string, unknown> | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function parseJobRow(row: Record<string, unknown> | null): ExecutionJobRow | null {
  if (!row) return null;
  return {
    ...(row as unknown as ExecutionJobRow),
    external_reference: parseJSON(row.external_reference),
    result: parseJSON(row.result),
  };
}

function parseJSON(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  try { return JSON.parse(v as string); } catch { return null; }
}

/**
 * Enqueue exactly one execution job for a just-approved task. Must be
 * called inside the same transaction as the approval itself (see
 * task-queue.ts:approveTask) — the caller is responsible for the
 * transaction boundary; this function issues a single INSERT.
 *
 * The unique partial index (idx_execution_jobs_one_active_per_task) is the
 * actual "exactly one active job" guarantee: if somehow called twice for
 * the same task while a job is still active, the second INSERT throws and
 * the whole enclosing transaction rolls back — there is no path to two
 * live jobs for one task.
 */
export function enqueueExecutionJob(task: TaskRow): ExecutionJobRow {
  const id = generateId();
  db.prepare(`
    INSERT INTO execution_jobs (id, task_id, task_version, business_id, action_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, task.id, task.version ?? 1, task.business_id, task.action_type ?? null);
  return parseJobRow(db.prepare('SELECT * FROM execution_jobs WHERE id = ?').get(id) as Record<string, unknown>)!;
}

export function getExecutionJob(id: string): ExecutionJobRow | null {
  return parseJobRow(db.prepare('SELECT * FROM execution_jobs WHERE id = ?').get(id) as Record<string, unknown> | null);
}

export function getActiveJobForTask(taskId: string): ExecutionJobRow | null {
  return parseJobRow(
    db.prepare(
      `SELECT * FROM execution_jobs WHERE task_id = ? AND status IN ('queued','leased','executing','manual_review') LIMIT 1`
    ).get(taskId) as Record<string, unknown> | null
  );
}

export function listExecutionJobs(
  businessId: string,
  filters: { status?: string[]; limit?: number; page?: number } = {},
): { jobs: ExecutionJobRow[]; total: number; page: number; limit: number; pages: number } {
  const conditions = ['business_id = ?'];
  const params: any[] = [businessId];
  if (filters.status?.length) {
    conditions.push(`status IN (${filters.status.map(() => '?').join(',')})`);
    params.push(...filters.status);
  }
  const where = conditions.join(' AND ');
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * limit;

  const total = (db.prepare(`SELECT COUNT(*) as n FROM execution_jobs WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db.prepare(
    `SELECT * FROM execution_jobs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Array<Record<string, unknown>>;

  return {
    jobs: rows.map((r) => parseJobRow(r)!),
    total, page, limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ─── Leasing ───────────────────────────────────────────────────────────────

const DEFAULT_LEASE_MS = 2 * 60 * 1000; // 2 minutes — generous for a single HTTP write-back call

/**
 * Atomically claim the next eligible *queued* job for this worker
 * instance. Deliberately does NOT reclaim jobs stuck in 'leased'/
 * 'executing' with an expired lease — a task whose job died mid-flight is
 * left at task status 'executing', which has no valid transition back to
 * 'approved' (see task-queue.ts's VALID_TRANSITIONS) for executeTask()'s
 * own approved-only guard to accept. Blindly re-claiming here would just
 * make executeTask() reject every attempt with "not approved" until
 * retries exhaust, without ever actually resolving the stuck task.
 * Recovering those is recoverStuckJobs()'s job (execution-worker.ts) — it
 * explicitly decides the task's fate (safe retry / manual review /
 * failed) rather than silently re-attempting through this path.
 *
 * The claim itself is a single UPDATE with a WHERE clause re-validating
 * the expected prior state (compare-and-swap). SQLite serializes writers,
 * so if two processes race for the same row, the second one's UPDATE
 * simply matches zero rows once the first has committed — no separate
 * locking primitive is needed for correctness within a single claim.
 */
export function claimNextJob(workerOwner: string, leaseMs = DEFAULT_LEASE_MS): ExecutionJobRow | null {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpires = new Date(now.getTime() + leaseMs).toISOString();

  const candidates = db.prepare(`
    SELECT id FROM execution_jobs
    WHERE status = 'queued'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at ASC
    LIMIT 20
  `).all(nowIso) as Array<{ id: string }>;

  for (const { id } of candidates) {
    const result = db.prepare(`
      UPDATE execution_jobs
      SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    `).run(workerOwner, leaseExpires, id, nowIso);

    if (result.changes && result.changes > 0) {
      return getExecutionJob(id);
    }
    // Lost the race for this candidate (another worker/process claimed it
    // between our SELECT and UPDATE) — try the next one.
  }
  return null;
}

/** Jobs whose lease has expired while still 'leased'/'executing' — the worker that held them died. */
export function findStuckJobs(): ExecutionJobRow[] {
  const nowIso = new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM execution_jobs
    WHERE status IN ('leased', 'executing') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    ORDER BY created_at ASC
    LIMIT 50
  `).all(nowIso) as Array<Record<string, unknown>>;
  return rows.map((r) => parseJobRow(r)!);
}

/**
 * Reclaim a stuck job for recovery processing — same CAS pattern as
 * claimNextJob, but for the 'leased'/'executing'+expired-lease state
 * specifically, and callable only from recoverStuckJobs().
 */
export function reclaimStuckJob(jobId: string, owner: string, leaseMs = DEFAULT_LEASE_MS): boolean {
  const nowIso = new Date().toISOString();
  const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
  const result = db.prepare(`
    UPDATE execution_jobs SET lease_owner = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('leased', 'executing') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
  `).run(owner, leaseExpires, jobId, nowIso);
  return (result.changes ?? 0) > 0;
}

/** Heartbeat — extend an active lease. Returns false if the lease was lost (expired/reassigned). */
export function extendLease(jobId: string, owner: string, leaseMs = DEFAULT_LEASE_MS): boolean {
  const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
  const result = db.prepare(`
    UPDATE execution_jobs SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'executing')
  `).run(leaseExpires, jobId, owner);
  return (result.changes ?? 0) > 0;
}

export function markExecuting(jobId: string, owner: string): boolean {
  const result = db.prepare(`
    UPDATE execution_jobs SET status = 'executing', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND lease_owner = ? AND status = 'leased'
  `).run(jobId, owner);
  return (result.changes ?? 0) > 0;
}

export function setExternalReference(jobId: string, reference: Record<string, unknown>): void {
  db.prepare(`UPDATE execution_jobs SET external_reference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(JSON.stringify(reference), jobId);
}

export function completeJob(jobId: string, result: Record<string, unknown>): void {
  db.prepare(`
    UPDATE execution_jobs SET status = 'succeeded', result = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(result), jobId);
}

const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000]; // 30s, 2m, 10m, 30m

/**
 * Record a failed attempt. If attempts remain, schedules a retry with
 * exponential-ish backoff (status returns to 'queued'). Otherwise marks
 * 'dead_letter' — never silently drops a job, always leaves a terminal,
 * inspectable record with the last error.
 */
export function failJob(jobId: string, error: string): { status: JobStatus; attempt: number } {
  const job = getExecutionJob(jobId);
  if (!job) return { status: 'dead_letter', attempt: 0 };

  const attempt = job.attempt_count + 1;
  if (attempt >= job.max_attempts) {
    db.prepare(`
      UPDATE execution_jobs SET status = 'dead_letter', attempt_count = ?, last_error = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(attempt, error, jobId);
    return { status: 'dead_letter', attempt };
  }

  const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? 30_000;
  const nextAttemptAt = new Date(Date.now() + backoff).toISOString();
  db.prepare(`
    UPDATE execution_jobs SET status = 'queued', attempt_count = ?, last_error = ?, next_attempt_at = ?,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(attempt, error, nextAttemptAt, jobId);
  return { status: 'queued', attempt };
}

/**
 * Mark a job as needing human review rather than blind auto-retry — used
 * when an external-write action's lease expired (or otherwise failed)
 * with no way to determine whether the remote action already happened.
 * See execution-safety.ts for the classification logic that decides this
 * vs. a safe automatic retry.
 */
/**
 * Recovery decided a stuck (reclaimed) job is safe to retry from scratch
 * — release the lease and return it to 'queued'. Distinct from the
 * normal failJob() backoff path since recovery already knows this is a
 * fresh attempt, not a just-failed one.
 */
export function requeueAfterRecovery(jobId: string, note: string): void {
  db.prepare(`
    UPDATE execution_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
      attempt_count = attempt_count + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(note, jobId);
}

export function markManualReview(jobId: string, reason: string): void {
  db.prepare(`
    UPDATE execution_jobs SET status = 'manual_review', last_error = ?,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason, jobId);
}

export function cancelJob(jobId: string): boolean {
  const result = db.prepare(`
    UPDATE execution_jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('queued', 'manual_review')
  `).run(jobId);
  return (result.changes ?? 0) > 0;
}

/**
 * Reset a terminal (dead_letter/manual_review/cancelled) job back to
 * 'queued' for a fresh attempt — the operational "retry" action. Does not
 * touch attempt_count/max_attempts (a manually-triggered retry gets a
 * fresh attempt budget so it isn't immediately dead-lettered again).
 */
export function retryJob(jobId: string): boolean {
  const result = db.prepare(`
    UPDATE execution_jobs SET status = 'queued', attempt_count = 0, next_attempt_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('dead_letter', 'manual_review', 'cancelled')
  `).run(jobId);
  return (result.changes ?? 0) > 0;
}
