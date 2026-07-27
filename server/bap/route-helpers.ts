/**
 * Shared conventions for every BAP v1 route — Phase 2's "consistency" pillar
 * (identical pagination, timestamp format, request/correlation IDs, error
 * schema across every endpoint, old and new).
 *
 * Deliberately additive, not a rewrite of Phase 0/1 routes: existing
 * `res.status(x).json({error: ...})` call sites keep working exactly as
 * before (the `error` string field never moves/changes shape) — this
 * module's `sendError()`/`sendPaginated()` are used by Phase 2's new routes
 * and layer `request_id`/`code` on *top* of that same shape, rather than
 * replacing it.
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { withIdempotency, IdempotencyConflictError, IdempotencyInProgressError } from '../lib/idempotency.js';

// ─── Request / correlation IDs ─────────────────────────────────────────────

export interface BapRequestContext {
  requestId: string;
  correlationId: string;
}

// The codebase's existing convention (see bap/auth.ts's `bapAgent`) attaches
// per-request BAP state via a type-cast rather than augmenting Express's
// Request interface — matched here for consistency, and because module
// augmentation of 'express-serve-static-core' doesn't resolve under this
// project's TS module-resolution setup.
type RequestWithBapContext = Request & { bapContext?: BapRequestContext };

export function getBapContext(req: Request): BapRequestContext | undefined {
  return (req as RequestWithBapContext).bapContext;
}

/**
 * Every BAP response carries an `X-Request-Id` (unique per call) and an
 * `X-Correlation-Id` (defaults to the request ID, but a caller can supply
 * its own to tie a whole multi-call workflow — e.g. "investigate signal X"
 * — together for support/debugging). Mount before bapAuth so the audit
 * insert can persist both.
 */
export function bapRequestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = crypto.randomUUID();
  const suppliedCorrelation = req.headers['x-correlation-id'];
  const correlationId = typeof suppliedCorrelation === 'string' && suppliedCorrelation.trim()
    ? suppliedCorrelation.trim().slice(0, 200)
    : requestId;

  (req as RequestWithBapContext).bapContext = { requestId, correlationId };
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}

// ─── Stable error schema ────────────────────────────────────────────────────

export type BapErrorCode =
  | 'validation_error' | 'not_found' | 'permission_denied'
  | 'conflict' | 'rate_limited' | 'internal_error';

/**
 * `error` (human-readable string) is the field every existing BAP client
 * already depends on — never removed or renamed. `code` and `request_id`
 * are additive: safe for old clients to ignore, useful for new ones.
 */
export function sendError(
  req: Request, res: Response, status: number, code: BapErrorCode, message: string,
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({
    error: message,
    code,
    request_id: getBapContext(req)?.requestId ?? null,
    ...extra,
  });
}

// ─── Pagination ─────────────────────────────────────────────────────────────

export interface Pagination { page: number; limit: number; offset: number; }

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Matches the dashboard API's existing page/limit convention exactly (server/routes/tasks.ts). */
export function parsePagination(query: Record<string, unknown>, opts: { maxLimit?: number; defaultLimit?: number } = {}): Pagination {
  const maxLimit = opts.maxLimit ?? MAX_LIMIT;
  const defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(String(query.limit ?? String(defaultLimit)), 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function paginationMeta(total: number, page: number, limit: number): { page: number; limit: number; total: number; pages: number } {
  return { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

// ─── Timestamp normalization ────────────────────────────────────────────────

/**
 * Every timestamp column in the DB is (depending on which migration wrote
 * it) either SQLite's `CURRENT_TIMESTAMP` format (`YYYY-MM-DD HH:MM:SS`,
 * implicitly UTC, no offset marker) or a JS `Date.toISOString()` value
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`, from Phase 1's idempotency/execution-jobs
 * code). Normalizing the underlying columns would mean a data migration
 * across a dozen+ tables — out of scope and risky. Instead, every BAP
 * response normalizes at the API boundary: parse whichever format arrived,
 * re-serialize as `Date.toISOString()`. Unparseable input (never expected,
 * but defensive) is returned as-is rather than silently becoming `null`.
 */
export function toIso(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.includes('T') || raw.endsWith('Z') ? raw : `${raw.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString();
}

/** Apply toIso() to a fixed list of keys on an object, returning a new object (does not mutate). */
export function normalizeTimestamps<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...obj };
  for (const key of keys) {
    if (key in out) out[key] = toIso(out[key]);
  }
  return out as T;
}

// ─── Idempotency wrapper ────────────────────────────────────────────────────

/**
 * Every mutating BAP endpoint (create/approve/write), across every BAP
 * route file, requires an `Idempotency-Key` header and runs its handler
 * through lib/idempotency.ts's claim-then-execute pattern — this is what
 * lets an agent safely retry a timed-out or connection-dropped request
 * (the dominant failure mode for an autonomous caller) without risking a
 * duplicate signal, task, goal, or KB write. `scope` distinguishes key
 * namespaces per endpoint so the same key string reused for a different
 * operation by the same agent can't collide.
 */
export async function withRequiredIdempotency(
  req: Request, res: Response, scope: string,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const key = req.header('Idempotency-Key');
  if (!key) {
    res.status(400).json({ error: 'Idempotency-Key header is required for this endpoint.' });
    return;
  }
  const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
  try {
    const result = await withIdempotency(bapAgent.id as string, scope, key, req.body, handler);
    res.status(result.status).json(result.body);
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof IdempotencyInProgressError) {
      res.status(409).json({ error: err.message, retryable: true });
      return;
    }
    throw err;
  }
}
