/**
 * server/lib/idempotency.ts — the claim-then-execute pattern that every
 * mutating BAP endpoint runs through (server/routes/bap.ts). Covers Phase 1
 * exit criterion: "an agent reuses an idempotency key with a different
 * payload -> 409" and the underlying replay/concurrency guarantees that
 * make retry-after-timeout safe for an autonomous caller.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  withIdempotency, fingerprintRequest,
  IdempotencyConflictError, IdempotencyInProgressError,
  pruneExpiredIdempotencyKeys,
} from './idempotency.js';

const AGENT = 'agt_idem_test';

afterAll(() => {
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id = ?`).run(AGENT);
});

describe('withIdempotency', () => {
  test('a fresh key runs the handler exactly once and returns its result', async () => {
    let calls = 0;
    const key = generateId();
    const result = await withIdempotency(AGENT, 'test:create', key, { a: 1 }, async () => {
      calls++;
      return { status: 201, body: { id: 'created-1' } };
    });
    expect(calls).toBe(1);
    expect(result.replayed).toBe(false);
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: 'created-1' });
  });

  test('the same key + identical payload replays the persisted response without re-running the handler', async () => {
    let calls = 0;
    const key = generateId();
    const body = { a: 1, b: 'x' };
    const handler = async () => { calls++; return { status: 201, body: { id: 'created-2', calls } }; };

    const first = await withIdempotency(AGENT, 'test:create', key, body, handler);
    const second = await withIdempotency(AGENT, 'test:create', key, body, handler);

    expect(calls).toBe(1); // handler only ran once
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });

  test('field order in the payload does not change the fingerprint (replay still matches)', async () => {
    const key = generateId();
    await withIdempotency(AGENT, 'test:create', key, { a: 1, b: 2 }, async () => ({ status: 200, body: {} }));
    const replay = await withIdempotency(AGENT, 'test:create', key, { b: 2, a: 1 }, async () => ({ status: 500, body: {} }));
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(200); // handler for the "different order" call never ran
  });

  test('the same key reused with a genuinely different payload is rejected with IdempotencyConflictError', async () => {
    const key = generateId();
    await withIdempotency(AGENT, 'test:create', key, { title: 'first' }, async () => ({ status: 201, body: {} }));

    await expect(
      withIdempotency(AGENT, 'test:create', key, { title: 'second' }, async () => ({ status: 201, body: {} }))
    ).rejects.toThrow(IdempotencyConflictError);
  });

  test('the same key is independent per scope — reusing it for a different operation does not conflict', async () => {
    const key = generateId();
    const a = await withIdempotency(AGENT, 'scope:a', key, { x: 1 }, async () => ({ status: 200, body: { from: 'a' } }));
    const b = await withIdempotency(AGENT, 'scope:b', key, { x: 1 }, async () => ({ status: 200, body: { from: 'b' } }));
    expect(a.body).toEqual({ from: 'a' });
    expect(b.body).toEqual({ from: 'b' });
  });

  test('the same key is independent per agent — a different agent reusing it does not conflict or replay', async () => {
    const key = generateId();
    const other = 'agt_idem_test_other';
    try {
      const a = await withIdempotency(AGENT, 'test:create', key, { x: 1 }, async () => ({ status: 200, body: { from: AGENT } }));
      const b = await withIdempotency(other, 'test:create', key, { x: 1 }, async () => ({ status: 200, body: { from: other } }));
      expect(a.body).toEqual({ from: AGENT });
      expect(b.body).toEqual({ from: other });
    } finally {
      db.prepare(`DELETE FROM idempotency_keys WHERE agent_id = ?`).run(other);
    }
  });

  test('a concurrent duplicate (same key still in_progress) is rejected with IdempotencyInProgressError, not replayed', async () => {
    const key = generateId();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withIdempotency(AGENT, 'test:concurrent', key, { x: 1 }, async () => {
      await gate;
      return { status: 200, body: { done: true } };
    });

    // Give the first call time to win the INSERT race and be sitting
    // in_progress before the second call starts.
    await new Promise((r) => setTimeout(r, 5));

    await expect(
      withIdempotency(AGENT, 'test:concurrent', key, { x: 1 }, async () => ({ status: 200, body: {} }))
    ).rejects.toThrow(IdempotencyInProgressError);

    releaseFirst();
    await first;
  });

  test('if the handler throws, the claim is released — a genuine retry (not a poisoned key) is possible', async () => {
    const key = generateId();
    let attempts = 0;

    await expect(
      withIdempotency(AGENT, 'test:retry', key, { x: 1 }, async () => {
        attempts++;
        throw new Error('downstream failure');
      })
    ).rejects.toThrow('downstream failure');

    const retried = await withIdempotency(AGENT, 'test:retry', key, { x: 1 }, async () => {
      attempts++;
      return { status: 200, body: { ok: true } };
    });

    expect(attempts).toBe(2); // first attempt failed, second actually ran
    expect(retried.replayed).toBe(false);
    expect(retried.body).toEqual({ ok: true });
  });

  test('an expired claim is treated as absent — a fresh call with the same key runs the handler again', async () => {
    const key = generateId();
    const id = generateId();
    // Insert an already-expired claim directly, bypassing the normal TTL.
    db.prepare(`
      INSERT INTO idempotency_keys (id, agent_id, scope, idempotency_key, request_fingerprint, status, response_status, response_body, created_at, completed_at, expires_at)
      VALUES (?, ?, 'test:expiry', ?, ?, 'completed', 200, '{"stale":true}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
    `).run(id, AGENT, key, fingerprintRequest({ x: 1 }), new Date(Date.now() - 1000).toISOString());

    let calls = 0;
    const result = await withIdempotency(AGENT, 'test:expiry', key, { x: 1 }, async () => {
      calls++;
      return { status: 200, body: { fresh: true } };
    });
    expect(calls).toBe(1);
    expect(result.body).toEqual({ fresh: true });
  });
});

describe('pruneExpiredIdempotencyKeys', () => {
  test('deletes only expired rows, leaving live claims untouched', async () => {
    const liveKey = generateId();
    await withIdempotency(AGENT, 'test:prune', liveKey, { x: 1 }, async () => ({ status: 200, body: {} }));

    const expiredId = generateId();
    db.prepare(`
      INSERT INTO idempotency_keys (id, agent_id, scope, idempotency_key, request_fingerprint, status, created_at, expires_at)
      VALUES (?, ?, 'test:prune', ?, 'irrelevant', 'in_progress', CURRENT_TIMESTAMP, ?)
    `).run(expiredId, AGENT, generateId(), new Date(Date.now() - 1000).toISOString());

    const pruned = pruneExpiredIdempotencyKeys();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const stillExpired = db.prepare(`SELECT 1 FROM idempotency_keys WHERE id = ?`).get(expiredId);
    expect(stillExpired).toBeNull();

    const stillLive = db.prepare(`SELECT 1 FROM idempotency_keys WHERE agent_id = ? AND idempotency_key = ?`).get(AGENT, liveKey);
    expect(stillLive).toBeTruthy();
  });
});
