/**
 * Blueprint Agent Protocol (BAP) — World Model.
 *
 * Read-only: the World Model is derived state, written by connector syncs
 * (see server/world-model/world-model.ts). Agents should reason from this
 * rather than raw connector data.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET /businesses/:bid/world-model           — current (most recent) snapshot
 *   GET /businesses/:bid/world-model/history   — historical snapshots
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import { getCurrentWorldModel, getWorldModelHistory } from '../world-model/world-model.js';

const router = Router();

router.get('/businesses/:businessId/world-model', requirePermission('world_model:read'), (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  const current = getCurrentWorldModel(businessId);
  if (!current) return sendError(req, res, 404, 'not_found', `No World Model snapshot yet for business '${businessId}'.`);
  return res.json({ world_model: current });
});

router.get('/businesses/:businessId/world-model/history', requirePermission('world_model:read'), (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  return res.json({ snapshots: getWorldModelHistory(businessId, limit) });
});

export default router;
