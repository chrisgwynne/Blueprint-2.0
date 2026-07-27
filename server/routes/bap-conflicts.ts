/**
 * Blueprint Agent Protocol (BAP) — Conflicts (Phase 3, general surface).
 *
 * bap-goals.ts already exposes GET /goals/:id/conflicts (conflicts
 * referencing one specific goal). This file adds the general,
 * business-wide conflict list across every conflict_type (goal_vs_goal,
 * task_vs_window, task_vs_goal, task_vs_task, signal_vs_goal,
 * goal_dependency) and category (direct/resource/timing/dependency) — the
 * "task conflicts" and "signal conflicts" surfaces the spec asks for,
 * which no goal-scoped route can answer.
 *
 * Read-only — resolving/dismissing a conflict remains a dashboard action
 * (server/routes/conflicts.ts); BAP callers can see conflicts and factor
 * them into recommendations, not adjudicate them, matching the same
 * "who has resolution authority" boundary the audit endpoint documents.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET    /businesses/:bid/conflicts    — list (filterable, paginated)
 *   GET    /conflicts/:id                — detail
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { parsePagination, paginationMeta, normalizeTimestamps, sendError } from '../bap/route-helpers.js';

const router = Router();

router.get('/businesses/:businessId/conflicts', requirePermission('conflicts:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { status = 'open', conflict_type, category, entity_id } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (status && status !== 'all') { conditions.push('status = ?'); params.push(String(status)); }
    if (conflict_type) {
      const arr = String(conflict_type).split(',');
      conditions.push(`conflict_type IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (category) {
      const arr = String(category).split(',');
      conditions.push(`category IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (entity_id) {
      conditions.push('(entity_a_id = ? OR entity_b_id = ?)');
      params.push(String(entity_id), String(entity_id));
    }

    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM conflicts WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = (db.prepare(
      `SELECT * FROM conflicts WHERE ${where} ORDER BY detected_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>).map((c) => normalizeTimestamps(c, ['detected_at', 'resolved_at']));

    return res.json({ conflicts: rows, total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/conflicts/:conflictId', requirePermission('conflicts:read'), (req: Request, res: Response) => {
  try {
    const id = String(req.params.conflictId);
    const row = db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return sendError(req, res, 404, 'not_found', `Conflict '${id}' not found.`);
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'conflicts:read', row.business_id as string)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: conflict does not belong to an authorized business.');
    }
    return res.json({ conflict: normalizeTimestamps(row, ['detected_at', 'resolved_at']) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
