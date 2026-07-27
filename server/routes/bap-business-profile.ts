/**
 * Blueprint Agent Protocol (BAP) — Business Truth Layer.
 *
 * Exposes the canonical Business Profile so external agents (Hermes,
 * etc.) can consult business identity/capability/policy before proposing
 * a task, rather than inferring it from connector data.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET   /businesses/:bid/profile   — get (auto-creates with inferred
 *                                       defaults if none exists yet)
 *   PATCH /businesses/:bid/profile   — update (marks touched fields as
 *                                       human-confirmed, not inferred)
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import { getOrCreateBusinessProfile, updateBusinessProfile, type BusinessProfileUpdate } from '../business/business-profile.js';

const router = Router();

router.get('/businesses/:businessId/profile', requirePermission('business_profile:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const profile = getOrCreateBusinessProfile(businessId);
    if (!profile) return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);
    return res.json({ profile });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.patch('/businesses/:businessId/profile', requirePermission('business_profile:update'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const profile = updateBusinessProfile(businessId, req.body as BusinessProfileUpdate);
    if (!profile) return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);
    return res.json({ profile });
  } catch (err) {
    return sendError(req, res, 400, 'validation_error', (err as Error).message);
  }
});

export default router;
