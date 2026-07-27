/**
 * scheduler-lock.ts's single renewable leader lease — the mechanism behind
 * Phase 1 exit criterion "two instances point at the same DB, scheduled
 * jobs execute exactly once". A second process is simulated here by a
 * second lock-holder identity racing the module's real (process-wide)
 * INSTANCE_ID for the same lock row.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import db from '../db/db.js';
import { tryAcquireOrRenewLeaderLock, releaseLeaderLock, isLeader, getInstanceId, withLeaderLock } from './scheduler-lock.js';

afterEach(() => {
  db.prepare(`DELETE FROM scheduler_locks WHERE lock_name = 'scheduler_leader'`).run();
});

describe('tryAcquireOrRenewLeaderLock', () => {
  test('the first caller acquires the lock and isLeader() reflects it', () => {
    expect(tryAcquireOrRenewLeaderLock()).toBe(true);
    expect(isLeader()).toBe(true);
  });

  test('the same instance renewing its own lock succeeds repeatedly', () => {
    expect(tryAcquireOrRenewLeaderLock()).toBe(true);
    expect(tryAcquireOrRenewLeaderLock()).toBe(true);
    expect(tryAcquireOrRenewLeaderLock()).toBe(true);
  });

  test('a different, still-live owner cannot steal the lock', () => {
    // Simulate a second instance directly owning the row (the real
    // INSTANCE_ID is fixed per-process, so a second "instance" in-process
    // is modelled by writing a foreign owner directly, exactly like a
    // second Blueprint process would appear from this process's view).
    const now = new Date();
    db.prepare(`
      INSERT INTO scheduler_locks (lock_name, owner, expires_at, updated_at)
      VALUES ('scheduler_leader', 'other-instance-xyz', ?, CURRENT_TIMESTAMP)
    `).run(new Date(now.getTime() + 45_000).toISOString());

    expect(tryAcquireOrRenewLeaderLock()).toBe(false);
    expect(isLeader()).toBe(false);

    const row = db.prepare(`SELECT owner FROM scheduler_locks WHERE lock_name = 'scheduler_leader'`).get() as { owner: string };
    expect(row.owner).toBe('other-instance-xyz'); // untouched — this instance never overwrote it
  });

  test('this instance takes over once the other owner\'s lease has expired', () => {
    db.prepare(`
      INSERT INTO scheduler_locks (lock_name, owner, expires_at, updated_at)
      VALUES ('scheduler_leader', 'dead-instance', ?, CURRENT_TIMESTAMP)
    `).run(new Date(Date.now() - 1000).toISOString());

    expect(tryAcquireOrRenewLeaderLock()).toBe(true);
    expect(isLeader()).toBe(true);
    const row = db.prepare(`SELECT owner FROM scheduler_locks WHERE lock_name = 'scheduler_leader'`).get() as { owner: string };
    expect(row.owner).toBe(getInstanceId());
  });

  test('two "processes" racing to acquire a free lock — only one wins per call, and it is deterministic per caller identity', () => {
    // This process's own tryAcquireOrRenewLeaderLock always uses its fixed
    // INSTANCE_ID, so a real inter-process race is exercised by the raw
    // conditional UPSERT this function wraps — verified directly here
    // against a competing owner written by a separate statement, mirroring
    // exactly what a second process's own call would do.
    const acquired = tryAcquireOrRenewLeaderLock();
    expect(acquired).toBe(true);

    // A second process attempting the same conditional UPSERT for a
    // different owner, while this instance's lease is still live, must not
    // succeed in taking the row.
    const result = db.prepare(`
      INSERT INTO scheduler_locks (lock_name, owner, expires_at, updated_at)
      VALUES ('scheduler_leader', 'second-process', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(lock_name) DO UPDATE SET
        owner = excluded.owner, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP
      WHERE scheduler_locks.owner = excluded.owner OR scheduler_locks.expires_at < ?
    `).run(new Date(Date.now() + 45_000).toISOString(), new Date().toISOString());
    expect(result.changes).toBe(0); // no-op: this instance's lease is still live

    const row = db.prepare(`SELECT owner FROM scheduler_locks WHERE lock_name = 'scheduler_leader'`).get() as { owner: string };
    expect(row.owner).toBe(getInstanceId());
  });
});

describe('releaseLeaderLock', () => {
  test('only releases the lock if this instance is the current owner', () => {
    tryAcquireOrRenewLeaderLock();
    releaseLeaderLock();
    expect(isLeader()).toBe(false);
    const row = db.prepare(`SELECT 1 FROM scheduler_locks WHERE lock_name = 'scheduler_leader'`).get();
    expect(row).toBeNull();
  });

  test('does not release a lock currently held by a different owner', () => {
    db.prepare(`
      INSERT INTO scheduler_locks (lock_name, owner, expires_at, updated_at)
      VALUES ('scheduler_leader', 'other-instance', ?, CURRENT_TIMESTAMP)
    `).run(new Date(Date.now() + 45_000).toISOString());

    releaseLeaderLock();
    const row = db.prepare(`SELECT owner FROM scheduler_locks WHERE lock_name = 'scheduler_leader'`).get() as { owner: string } | undefined;
    expect(row?.owner).toBe('other-instance');
  });
});

describe('withLeaderLock', () => {
  test('runs the wrapped callback when the lock is acquired', async () => {
    let ran = false;
    const wrapped = withLeaderLock(async () => { ran = true; });
    await wrapped();
    expect(ran).toBe(true);
  });

  test('skips the wrapped callback (no-op, no throw) when another owner holds a live lock', async () => {
    db.prepare(`
      INSERT INTO scheduler_locks (lock_name, owner, expires_at, updated_at)
      VALUES ('scheduler_leader', 'other-instance', ?, CURRENT_TIMESTAMP)
    `).run(new Date(Date.now() + 45_000).toISOString());

    let ran = false;
    const wrapped = withLeaderLock(async () => { ran = true; });
    await expect(wrapped()).resolves.toBeUndefined();
    expect(ran).toBe(false);
  });
});
