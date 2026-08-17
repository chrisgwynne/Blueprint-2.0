/**
 * Operating Policy — BAP surface (#68).
 *
 * Read-only by design. An external agent must be able to see the rules it
 * is being judged by (so it can explain "I did not auto-approve that
 * because your policy caps autonomy at green"), but authoring governance
 * is an operator act: there is no BAP write path to a policy version.
 *
 * requirePermission(..., business scoping) is the existing convention —
 * it enforces both the grant and the per-business ACL, so an agent scoped
 * to business A cannot read business B's operating policy.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '../bap/auth.js';
import {
  getPolicyVersion, listPolicyEvents, listPolicyVersions, resolveOperatingPolicy,
} from '../policy/operating-policy.js';

const router = Router();

router.get('/businesses/:businessId/operating-policy', requirePermission('operating_policies:read'), (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  res.json({
    effective: resolveOperatingPolicy(businessId),
    versions: listPolicyVersions({ scope: 'business', key: businessId }),
  });
});

router.get('/businesses/:businessId/operating-policy/versions/:version', requirePermission('operating_policies:read'), (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  const version = Number(req.params.version);
  const found = getPolicyVersion({ scope: 'business', key: businessId }, version);
  if (!found) return res.status(404).json({ error: `Policy version ${version} not found for business '${businessId}'.` });
  return res.json({ policy: found });
});

router.get('/businesses/:businessId/operating-policy/history', requirePermission('operating_policies:read'), (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  res.json({ events: listPolicyEvents({ scope: 'business', key: businessId }) });
});

export default router;
