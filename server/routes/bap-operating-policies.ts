/**
 * Operating Policy — BAP surface (#68, backtest extension).
 *
 * Read-only by design. An external agent must be able to see the rules it
 * is being judged by (so it can explain "I did not auto-approve that
 * because your policy caps autonomy at green"), but authoring governance
 * is an operator act: there is no BAP write path to a policy version.
 *
 * requirePermission(..., business scoping) is the existing convention —
 * it enforces both the grant and the per-business ACL, so an agent scoped
 * to business A cannot read business B's operating policy.
 *
 * ── The backtest route's permission: BOTH operating_policies:read AND
 *    tasks:read ─────────────────────────────────────────────────────────
 *
 * A backtest is read-only — it writes no policy version, touches no task —
 * so it belongs behind a `:read` grant, same as everything else in this
 * file. But unlike the GET routes above, which only ever return the policy
 * DOCUMENT, a backtest's evidence is built from real historical TASKS:
 * their ids, titles, action types and actual approval outcome. That is
 * `tasks:read`'s data, not `operating_policies:read`'s, and an agent that
 * only holds the former should not be able to read business task history
 * through a side door labelled "policy". So this route requires both
 * grants — the same "evaluating something still needs the read grant for
 * the data being evaluated" precedent bap-simulation.ts's task-approval
 * preview sets for `simulations:read` + `tasks:approve`.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import {
  getPolicyVersion, listPolicyEvents, listPolicyVersions, resolveOperatingPolicy,
  type OperatingPolicyPatch,
} from '../policy/operating-policy.js';
import { backtestPolicyChange } from '../policy/policy-backtest.js';

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

router.post(
  '/businesses/:businessId/operating-policy/backtest',
  requirePermission('operating_policies:read'),
  requirePermission('tasks:read'),
  (req: Request, res: Response) => {
    try {
      const businessId = String(req.params.businessId);
      const body = req.body as { patch?: OperatingPolicyPatch; days?: number };
      const backtest = backtestPolicyChange({
        scope: 'business', key: businessId, patch: body.patch ?? {}, days: body.days,
      });
      return res.json({ backtest });
    } catch (err) {
      const message = (err as Error).message ?? 'Unknown error';
      const status = /not found|does not exist/i.test(message) ? 404 : 400;
      return sendError(req, res, status, status === 404 ? 'not_found' : 'validation_error', message);
    }
  },
);

export default router;
