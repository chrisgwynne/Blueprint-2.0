/**
 * Blueprint Agent Protocol (BAP) — Typed Action & Executor Registry.
 *
 * The registry is global (not business-scoped) — it describes what an
 * action_type IS, not any one business's use of it. Read access lets
 * external agents check requirements (connectors/permissions/business
 * types) before proposing a task; write access lets an operator/trusted
 * agent extend the registry with new action types.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET  /action-registry             — list all entries
 *   GET  /action-registry/:actionType — get one entry
 *   PUT  /action-registry/:actionType — upsert (create or update)
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import { listActionRegistryEntries, getActionRegistryEntry, upsertActionRegistryEntry, type ActionRegistryUpsert } from '../tasks/action-registry.js';

const router = Router();

router.get('/action-registry', requirePermission('action_registry:read'), (_req: Request, res: Response) => {
  return res.json({ entries: listActionRegistryEntries() });
});

router.get('/action-registry/:actionType', requirePermission('action_registry:read'), (req: Request, res: Response) => {
  const entry = getActionRegistryEntry(String(req.params.actionType));
  if (!entry) return sendError(req, res, 404, 'not_found', `action_type '${req.params.actionType}' is not registered.`);
  return res.json({ entry });
});

router.put('/action-registry/:actionType', requirePermission('action_registry:write'), (req: Request, res: Response) => {
  try {
    const entry = upsertActionRegistryEntry(String(req.params.actionType), req.body as ActionRegistryUpsert);
    return res.json({ entry });
  } catch (err) {
    return sendError(req, res, 400, 'validation_error', (err as Error).message);
  }
});

export default router;
