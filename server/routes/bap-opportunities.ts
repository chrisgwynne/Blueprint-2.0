/**
 * Blueprint Agent Protocol (BAP) — Opportunities (Phase 3 Opportunity Engine).
 *
 * Exposes goal_suggestions (Brain feature 6, server/brain/goal-suggester.ts)
 * — already a quantified-opportunity scanner over connector data — as BAP's
 * "opportunities" surface, extended in Phase 3 with required_effort,
 * related_goal_ids, related_risks, and why_it_matters. Not a new engine or
 * a new table: reusing goal_suggestions exactly, per PHASE3.md's "extend,
 * don't fork" approach.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring for
 * why: applying bapAuth again here would double-count every request that
 * falls through to reach this router).
 *
 * Endpoints:
 *   GET    /businesses/:bid/opportunities          — list (filterable, paginated)
 *   GET    /opportunities/:id                       — detail
 *   POST   /businesses/:bid/opportunities/scan       — trigger a fresh scan
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { parsePagination, paginationMeta, normalizeTimestamps, withRequiredIdempotency, sendError } from '../bap/route-helpers.js';

const router = Router();

function safeJSON<T>(val: unknown, fallback: T): T {
  if (Array.isArray(val) || (typeof val === 'object' && val !== null)) return val as T;
  if (!val) return fallback;
  try { return JSON.parse(val as string) as T; } catch { return fallback; }
}

function parseOpportunityRow(row: Record<string, unknown>): Record<string, unknown> {
  return normalizeTimestamps({
    ...row,
    suggested_agents: safeJSON(row.suggested_agents, []),
    evidence: safeJSON(row.evidence, {}),
    related_goal_ids: safeJSON(row.related_goal_ids, []),
    related_risks: safeJSON(row.related_risks, []),
  }, ['suggested_deadline', 'snoozed_until', 'created_at', 'updated_at']);
}

router.get('/businesses/:businessId/opportunities', requirePermission('opportunities:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { status = 'pending', connector_source } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (status && status !== 'all') {
      const arr = String(status).split(',');
      conditions.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (connector_source) { conditions.push('connector_source = ?'); params.push(String(connector_source)); }

    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM goal_suggestions WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = db.prepare(
      `SELECT * FROM goal_suggestions WHERE ${where} ORDER BY opportunity_value DESC, created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>;

    return res.json({ opportunities: rows.map(parseOpportunityRow), total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/opportunities/:opportunityId', requirePermission('opportunities:read'), (req: Request, res: Response) => {
  try {
    const id = String(req.params.opportunityId);
    const row = db.prepare('SELECT * FROM goal_suggestions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return sendError(req, res, 404, 'not_found', `Opportunity '${id}' not found.`);
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'opportunities:read', row.business_id as string)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: opportunity does not belong to an authorized business.');
    }
    return res.json({ opportunity: parseOpportunityRow(row) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/businesses/:businessId/opportunities/scan', requirePermission('opportunities:trigger'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!biz) return sendError(req, res, 404, 'not_found', 'Business not found.');

    await withRequiredIdempotency(req, res, 'opportunities:scan', async () => {
      // Fire-and-forget — an LLM-backed pattern scan can take a while; same
      // async-trigger shape as goals:plan / connectors:sync / agents:trigger.
      import('../brain/goal-suggester.js')
        .then((m) => (m as unknown as { scanForGoalSuggestions: (bid: string) => Promise<unknown> }).scanForGoalSuggestions(businessId))
        .catch((err) => console.warn(`[bap-opportunities] scan trigger failed for ${businessId}:`, (err as Error).message));
      return { status: 202, body: { business_id: businessId, status: 'scanning', message: 'Opportunity scan triggered. Poll GET /businesses/:id/opportunities for results.' } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
