/**
 * Single global renewable leader lease, backed by the scheduler_locks
 * table. Replaces the previous in-process `schedulerStarted` boolean,
 * which only prevented double-starting the scheduler *within one
 * process* — it did nothing to stop two separate Blueprint processes
 * (e.g. an accidental second `bun run start`, or a crashed instance that
 * got restarted while an old copy was somehow still alive) from both
 * running every cron job and duplicating connector syncs, agent runs,
 * outcome checks, and execution-job claims.
 *
 * Every scheduled callback calls tryAcquireOrRenewLeaderLock() first; if
 * it doesn't hold (or can't acquire) the lease, it skips that tick
 * entirely rather than doing the work. The lease is short-lived and
 * renewed on every successful tick, so a crashed holder's lease simply
 * expires (LEASE_TTL_MS) and another instance takes over on its own —
 * no manual intervention, no split-brain window beyond the TTL.
 */
import db from '../db/db.js';

const LOCK_NAME = 'scheduler_leader';
export const LEASE_TTL_MS = 45_000; // renewed roughly every scheduler tick (much shorter interval)

// Stable per-process identity so a lease this process still holds is
// recognisable as "ours" across ticks without re-winning a fresh race
// each time.
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;

export function getInstanceId(): string {
  return INSTANCE_ID;
}

/**
 * Attempt to acquire or renew the leader lease for this process.
 * Returns true if this process holds the lease afterwards (and may
 * proceed with scheduled work), false otherwise.
 *
 * Implemented as a single atomic UPSERT: either there's no row yet (first
 * claim), the existing row is already ours (renewal), or the existing
 * row's lease has expired (takeover) — all three cases succeed. Anything
 * else (a *different*, still-live owner) is left untouched by the WHERE
 * clause and the row-count check reports failure.
 */
export function tryAcquireOrRenewLeaderLock(ttlMs = LEASE_TTL_MS): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  db.prepare(`
    INSERT INTO scheduler_locks (lock_name, owner, expires_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(lock_name) DO UPDATE SET
      owner = excluded.owner,
      expires_at = excluded.expires_at,
      updated_at = CURRENT_TIMESTAMP
    WHERE scheduler_locks.owner = excluded.owner OR scheduler_locks.expires_at < ?
  `).run(LOCK_NAME, INSTANCE_ID, expiresAt, nowIso);

  // The UPSERT above is a no-op (doesn't touch the row) when a *different*
  // still-live owner holds it — check who actually holds it now.
  const row = db.prepare(`SELECT owner, expires_at FROM scheduler_locks WHERE lock_name = ?`).get(LOCK_NAME) as
    { owner: string; expires_at: string } | undefined;
  return row?.owner === INSTANCE_ID;
}

export function releaseLeaderLock(): void {
  db.prepare(`DELETE FROM scheduler_locks WHERE lock_name = ? AND owner = ?`).run(LOCK_NAME, INSTANCE_ID);
}

export function isLeader(): boolean {
  const row = db.prepare(`SELECT owner, expires_at FROM scheduler_locks WHERE lock_name = ?`).get(LOCK_NAME) as
    { owner: string; expires_at: string } | undefined;
  if (!row) return false;
  return row.owner === INSTANCE_ID && new Date(row.expires_at).getTime() > Date.now();
}

/**
 * Wrap a scheduled callback so it only runs while this process holds the
 * leader lease — tries to acquire/renew first, and simply skips (no-op,
 * no error) if it doesn't hold it.
 */
export function withLeaderLock<T extends unknown[]>(fn: (...args: T) => void | Promise<void>): (...args: T) => Promise<void> {
  return async (...args: T) => {
    if (!tryAcquireOrRenewLeaderLock()) return;
    await fn(...args);
  };
}
