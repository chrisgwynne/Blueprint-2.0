/**
 * BAP request idempotency.
 *
 * Every mutating BAP endpoint requires an `Idempotency-Key` header. This
 * module implements the claim-then-execute pattern:
 *
 *   1. Atomically INSERT a row keyed on (agent_id, scope, idempotency_key).
 *      The UNIQUE index on that triple is what makes this atomic even
 *      across two genuinely concurrent requests — whichever INSERT wins
 *      the race proceeds to run the handler; the other sees a UNIQUE
 *      constraint failure and falls into the "claim already exists" path
 *      below, just like a normal retry would.
 *   2. If the claim already existed:
 *      - same request_fingerprint + status='completed' → replay the
 *        persisted response (this is the "identical retry" case).
 *      - same request_fingerprint + status='in_progress' → another
 *        request with the same key is still being handled right now
 *        (fintingerprint matches, so it's a genuine concurrent duplicate,
 *        not a conflict) → 409 with a retryable hint, since replaying an
 *        incomplete result isn't possible.
 *      - different request_fingerprint → 409 Conflict, regardless of
 *        status (the key was reused for a different payload).
 *   3. If no claim existed, this call owns it: run the handler, persist
 *      the result, return it.
 *
 * Expired claims (past `expires_at`) are treated as if they don't exist —
 * a stale row is opportunistically deleted and replaced.
 */
import crypto from 'crypto';
import db, { generateId } from '../db/db.js';

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency-Key was already used with a different request payload.') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyInProgressError extends Error {
  constructor(message = 'A request with this Idempotency-Key is still being processed. Retry shortly.') {
    super(message);
    this.name = 'IdempotencyInProgressError';
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches the audit's F-24 recommendation

export function fingerprintRequest(body: unknown): string {
  const canonical = JSON.stringify(body ?? {}, Object.keys(body as object ?? {}).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

interface IdempotencyRow {
  id: string;
  status: 'in_progress' | 'completed';
  request_fingerprint: string;
  response_status: number | null;
  response_body: string | null;
  resource_id: string | null;
  expires_at: string;
}

function getClaim(agentId: string, scope: string, key: string): IdempotencyRow | null {
  const row = db.prepare(
    `SELECT * FROM idempotency_keys WHERE agent_id = ? AND scope = ? AND idempotency_key = ?`
  ).get(agentId, scope, key) as IdempotencyRow | null;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    // Expired — opportunistically clear it so a fresh claim can be made.
    db.prepare(`DELETE FROM idempotency_keys WHERE id = ?`).run(row.id);
    return null;
  }
  return row;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Run `handler` under an idempotency claim. Throws IdempotencyConflictError
 * (caller should map to HTTP 409) if the key was already used with a
 * different payload, or IdempotencyInProgressError (map to 409 as well,
 * distinct message) if a concurrent request with the same key+payload is
 * still in flight.
 */
export async function withIdempotency<T>(
  agentId: string,
  scope: string,
  idempotencyKey: string,
  requestBody: unknown,
  handler: () => Promise<{ status: number; body: T }>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<IdempotentResult<T>> {
  const fingerprint = fingerprintRequest(requestBody);

  const existing = getClaim(agentId, scope, idempotencyKey);
  if (existing) {
    return resolveExisting<T>(existing, fingerprint);
  }

  // Attempt to atomically claim the key. The UNIQUE index on
  // (agent_id, scope, idempotency_key) is the actual concurrency control —
  // if two requests race here, exactly one INSERT succeeds.
  const claimId = generateId();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  try {
    db.prepare(`
      INSERT INTO idempotency_keys (id, agent_id, scope, idempotency_key, request_fingerprint, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'in_progress', CURRENT_TIMESTAMP, ?)
    `).run(claimId, agentId, scope, idempotencyKey, fingerprint, expiresAt);
  } catch (err) {
    // Lost the race (or a stale row reappeared between getClaim() and here)
    // — re-fetch and resolve against whatever is there now.
    const raced = getClaim(agentId, scope, idempotencyKey);
    if (raced) return resolveExisting<T>(raced, fingerprint);
    throw err;
  }

  // We own the claim — run the handler and persist the outcome. If the
  // handler throws, the claim is deleted so a genuine retry (not a
  // replay) can happen — an idempotency key should never permanently
  // "poison" a slot after a failed attempt.
  try {
    const result = await handler();
    db.prepare(`
      UPDATE idempotency_keys
      SET status = 'completed', response_status = ?, response_body = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(result.status, JSON.stringify(result.body ?? null), claimId);
    return { status: result.status, body: result.body, replayed: false };
  } catch (err) {
    db.prepare(`DELETE FROM idempotency_keys WHERE id = ?`).run(claimId);
    throw err;
  }
}

function resolveExisting<T>(row: IdempotencyRow, fingerprint: string): IdempotentResult<T> {
  if (row.request_fingerprint !== fingerprint) {
    throw new IdempotencyConflictError();
  }
  if (row.status === 'in_progress') {
    throw new IdempotencyInProgressError();
  }
  return {
    status: row.response_status ?? 200,
    body: JSON.parse(row.response_body ?? 'null') as T,
    replayed: true,
  };
}

/**
 * Housekeeping — called from the scheduler. Deletes expired claims.
 *
 * Compares against an explicit ISO-8601 timestamp passed as a bound
 * parameter, not SQL's CURRENT_TIMESTAMP: expires_at is written as
 * `Date.toISOString()` (`...T...Z`), while CURRENT_TIMESTAMP renders as
 * `YYYY-MM-DD HH:MM:SS` — the differing separator ('T' vs ' ') breaks
 * lexicographic comparison between the two formats (every ISO string
 * would sort as "greater than" same-day CURRENT_TIMESTAMP values,
 * regardless of actual time), so nothing would ever be pruned.
 */
export function pruneExpiredIdempotencyKeys(): number {
  const nowIso = new Date().toISOString();
  const result = db.prepare(`DELETE FROM idempotency_keys WHERE expires_at < ?`).run(nowIso);
  return result.changes ?? 0;
}
