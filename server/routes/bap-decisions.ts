/**
 * Blueprint Agent Protocol (BAP) — Decision Memory (Phase 3).
 *
 * "Why did we decide this six months ago?" — answerable from stored
 * evidence (server/brain/decision-memory.ts), not reconstructed by an LLM
 * guessing from surrounding context. Read-only: decisions are written by
 * the engines that make them (task-queue.ts, goal-reasoner.ts,
 * conflict-engine.ts, goal-suggester.ts), never directly via BAP.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET    /businesses/:bid/decisions    — recall (search/filter/paginate)
 *   GET    /decisions/:id                — detail
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { normalizeTimestamps, sendError } from '../bap/route-helpers.js';
import { recallDecisions, getDecision } from '../brain/decision-memory.js';

const router = Router();

router.get('/businesses/:businessId/decisions', requirePermission('decisions:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!biz) return sendError(req, res, 404, 'not_found', 'Business not found.');

    const { q, decision_type, related_goal_id, related_task_id, date_from, date_to, page, limit } = req.query;
    const { decisions, total } = recallDecisions(businessId, {
      q: q ? String(q) : undefined,
      decision_type: decision_type ? String(decision_type) : undefined,
      related_goal_id: related_goal_id ? String(related_goal_id) : undefined,
      related_task_id: related_task_id ? String(related_task_id) : undefined,
      date_from: date_from ? String(date_from) : undefined,
      date_to: date_to ? String(date_to) : undefined,
      page: page ? parseInt(String(page), 10) : undefined,
      limit: limit ? parseInt(String(limit), 10) : undefined,
    });
    const lim = limit ? Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50)) : 50;
    const pg = page ? Math.max(1, parseInt(String(page), 10) || 1) : 1;

    return res.json({
      decisions: decisions.map((d) => normalizeTimestamps(d, ['created_at'])),
      total,
      pagination: { page: pg, limit: lim, total, pages: Math.max(1, Math.ceil(total / lim)) },
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/decisions/:decisionId', requirePermission('decisions:read'), (req: Request, res: Response) => {
  try {
    const id = String(req.params.decisionId);
    // getDecision() requires a businessId, but this route has none in its
    // path — look the row up first, then re-check ownership against its
    // actual business, same cross-tenant-safe pattern as every other
    // no-:businessId BAP route.
    const row = db.prepare('SELECT business_id FROM decisions WHERE id = ?').get(id) as { business_id: string } | undefined;
    if (!row) return sendError(req, res, 404, 'not_found', `Decision '${id}' not found.`);
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'decisions:read', row.business_id)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: decision does not belong to an authorized business.');
    }
    const decision = getDecision(id, row.business_id);
    return res.json({ decision: decision ? normalizeTimestamps(decision, ['created_at']) : null });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
