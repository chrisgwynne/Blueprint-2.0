/**
 * Natural-language audit & history search API (issue #72).
 *
 * Read-only by design and by necessity. A search surface that could write
 * would stop being a way to inspect the record and start being a way to
 * change it, which is precisely what an audit trail must not permit.
 *
 * Authorization follows the convention routes/operating-policies.ts (#68)
 * established and routes/decision-queue.ts (#61) and
 * routes/command-centre.ts (#59) follow: router-level isAuthenticated, an
 * explicit existence check on the business, and every query scoped to one
 * business inside the engine's SQL. The business in the path is the ONLY
 * business searched — the interpreter can propose any business id it likes
 * and the engine intersects it with this permitted set before running
 * anything, so a natural-language question can never widen access.
 *
 * Every response has already been through lib/redaction.ts inside
 * finalise(), so no credential, provider body or raw payload can reach a
 * client even when the underlying row contains one.
 *
 *   GET  /api/audit-search/:businessId/vocabulary  — searchable types + real statuses
 *   POST /api/audit-search/:businessId             — run one search
 *   GET  /api/audit-search/:businessId/record/:token — resolve one citation
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  searchAuditHistory, searchVocabulary, resolveCitation,
  AUDIT_SEARCH_SCHEMA_VERSION, AUDIT_RECORD_TYPES, DEFAULT_RESULT_LIMIT,
  type AuditRecordType, type SearchFilters,
} from '../audit-search/index.js';

const router = Router();
router.use(isAuthenticated);

const MAX_QUERY_CHARS = 500;
const MAX_LIMIT = 100;

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
 * Filters the user set by hand. Only fields actually present in the body
 * become overrides — an absent field means "let the interpreter decide",
 * which is a different instruction from "search with no filter".
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
 * GET /api/audit-search/:businessId/vocabulary
 * What can be searched, and the statuses that actually occur in this
 * business's rows — so the UI never offers a filter that matches nothing.
 */
router.get('/:businessId/vocabulary', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return res.status(404).json({ error: `Business '${businessId}' not found.` });
    }
    return res.json(searchVocabulary(businessId));
  } catch (err) {
    console.error('[audit-search] Vocabulary error:', err);
    return res.status(500).json({ error: 'Failed to load the search vocabulary.' });
  }
});

/**
 * GET /api/audit-search/:businessId/record/:token
 * Resolve one citation token (`decision#dec_1`) back to its record, so a
 * cited claim can be checked without re-running the search. Scoped to the
 * business in the path: a token from another tenant resolves to 404.
 */
router.get('/:businessId/record/:token', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return res.status(404).json({ error: `Business '${businessId}' not found.` });
    }
    const record = resolveCitation(businessId, String(req.params.token));
    if (!record) {
      return res.status(404).json({
        error: `No record '${String(req.params.token)}' exists for this business.`,
      });
    }
    return res.json({ schema_version: AUDIT_SEARCH_SCHEMA_VERSION, record });
  } catch (err) {
    console.error('[audit-search] Citation resolve error:', err);
    return res.status(500).json({ error: 'Failed to resolve the cited record.' });
  }
});

/**
 * POST /api/audit-search/:businessId
 * Body: { query, filters?: { record_types, statuses, terms, from, to }, limit?, summarise? }
 */
router.post('/:businessId', async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return res.status(404).json({ error: `Business '${businessId}' not found.` });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = String(body.query ?? '').slice(0, MAX_QUERY_CHARS);

    const rawLimit = parseInt(String(body.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_RESULT_LIMIT;

    const result = await searchAuditHistory({
      query,
      // The authorization boundary: exactly the business in the path.
      permittedBusinessIds: [businessId],
      overrides: parseOverrides(body),
      limit,
      // Off by default. The records are the answer; a narrative is opt-in
      // and is discarded whenever it cannot be traced back to them.
      summarise: body.summarise === true,
    });

    return res.json(result);
  } catch (err) {
    console.error('[audit-search] Search error:', err);
    return res.status(500).json({ error: 'The search could not be completed.' });
  }
});

export default router;
