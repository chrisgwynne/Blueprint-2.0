/**
 * Blueprint Agent Protocol (BAP) — Natural-language audit search (issue #83).
 *
 * Exposes #72's grounded, cited history search to external agents. This is
 * NOT the same surface as bap-audit.ts's `GET /businesses/:bid/audit`:
 * that route lists raw `audit_log` rows filtered by structured query
 * parameters (entity_type, action, actor, date range) — a listing. This
 * route accepts a free-text question, runs it through the same two-layer
 * pipeline the dashboard search bar uses (query-interpretation.ts turns the
 * sentence into filters; record-index.ts runs those filters as real SQL
 * across decisions, tasks, receipts, outcomes, policy events, connector
 * syncs, signals, agent runs AND the audit log; grounding.ts verifies any
 * narrative summary against the rows actually retrieved) — an answer, not
 * a table. `audit:read` alone does not grant this: they are gated by
 * separate permissions on purpose, so an agent can be trusted with one
 * without the other.
 *
 * No shortcut around the anti-fabrication check: this route calls
 * searchAuditHistory() directly, the exact function server/routes/
 * audit-search.ts (the dashboard route) calls, so a summary that fails
 * verifySummaryGrounding() is withheld here exactly as it is there.
 *
 * Authorization is scoped to the single business named in the path, both
 * for interpretation (the interpreter is offered only that business, and a
 * model output naming a different one is rejected as a scope violation —
 * see query-interpretation.ts) and for retrieval (the engine's SQL is
 * parameterized to that business only) — a natural-language question can
 * never widen access.
 *
 * No blanket auth/rate-limit middleware here — see bap-goals.ts's docstring
 * on this file's mounting inside bap.ts's already-authenticated router chain.
 *
 * Endpoints:
 *   POST /businesses/:bid/audit-search — run one natural-language search
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission } from '../bap/auth.js';
import { bapRateLimit } from '../bap/rate-limiter.js';
import { sendError } from '../bap/route-helpers.js';
import {
  searchAuditHistory, AUDIT_RECORD_TYPES,
  type AuditRecordType, type SearchFilters,
} from '../audit-search/index.js';

const router = Router();

const MAX_QUERY_CHARS = 500;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 40;

function businessExists(businessId: string): boolean {
  return !!db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
}

function parseStringArray(raw: unknown, cap: number): string[] | undefined {
  if (raw == null) return undefined;
  const values = Array.isArray(raw)
    ? raw.filter((v) => typeof v === 'string')
    : String(raw).split(',');
  const cleaned = values.map((v) => String(v).trim()).filter(Boolean).slice(0, cap);
  return cleaned.length ? cleaned : [];
}

/**
 * Mirrors server/routes/audit-search.ts's own parseOverrides — kept as a
 * separate copy rather than a shared import because the two routes answer
 * to different callers (dashboard session vs. BAP key) and are free to
 * diverge; today they happen to agree on the wire shape.
 */
function parseOverrides(body: Record<string, unknown>): Partial<SearchFilters> | undefined {
  const raw = body.filters;
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  const out: Partial<SearchFilters> = {};

  const types = parseStringArray(f.record_types, 12);
  if (types) out.record_types = types.filter((t) => AUDIT_RECORD_TYPES.includes(t as AuditRecordType)) as AuditRecordType[];

  const statuses = parseStringArray(f.statuses, 12);
  if (statuses) out.statuses = statuses;

  const terms = parseStringArray(f.terms, 8);
  if (terms) out.terms = terms;

  if ('from' in f) out.from = f.from == null || f.from === '' ? null : String(f.from);
  if ('to' in f) out.to = f.to == null || f.to === '' ? null : String(f.to);

  return Object.keys(out).length ? out : undefined;
}

/**
 * POST /businesses/:businessId/audit-search
 * Body: { query, filters?: { record_types, statuses, terms, from, to }, limit?, summarise? }
 */
router.post(
  '/businesses/:businessId/audit-search',
  requirePermission('audit_search:read'),
  bapRateLimit('audit_search:query'),
  async (req: Request, res: Response) => {
    try {
      const businessId = String(req.params.businessId);
      if (!businessExists(businessId)) {
        return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const query = String(body.query ?? '').slice(0, MAX_QUERY_CHARS);

      const rawLimit = parseInt(String(body.limit ?? ''), 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

      const result = await searchAuditHistory({
        query,
        // The authorization boundary: exactly the business in the path,
        // same as the dashboard route and every other business-scoped BAP
        // endpoint — the interpreter may propose any business id it likes
        // and the engine intersects it with this permitted set before
        // running anything.
        permittedBusinessIds: [businessId],
        overrides: parseOverrides(body),
        limit,
        // Off by default, same as the dashboard: the cited records are the
        // answer, and a narrative is an opt-in convenience that is
        // discarded whole if it cannot be traced back to them.
        summarise: body.summarise === true,
      });

      return res.json(result);
    } catch (err) {
      return sendError(req, res, 500, 'internal_error', (err as Error).message);
    }
  },
);

export default router;
