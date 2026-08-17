/**
 * Retrospectives API (Feature 3) + retrospective operating-change proposals (#73).
 *
 * The proposal routes here are deliberately thin. Approval and rejection are
 * delegated to reviewRetrospectiveProposal(), which routes through #61's
 * decision queue — there is no endpoint that activates a change directly, and
 * adding one would be the exact failure this issue exists to prevent.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  listRetrospectives, getRetrospective, runRetrospective,
} from '../brain/retrospective-engine.js';
import {
  listProposalsForBusiness, getProposal, reviewRetrospectiveProposal,
  rollbackRetrospectiveChange, expireStaleProposals,
  RetrospectiveProposalError,
} from '../brain/retrospective-proposals.js';

const router = Router();
router.use(isAuthenticated);

function actorOf(req: Request): string {
  const raw = (req.body as { actor?: unknown } | undefined)?.actor;
  const actor = typeof raw === 'string' ? raw.trim() : '';
  // 'dashboard:' marks a human acting through the UI. The autonomy gate in
  // #68 treats that prefix as "a person is doing this", so it must never be
  // applied to anything but a real dashboard review.
  return actor === '' ? 'dashboard:human' : actor;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof RetrospectiveProposalError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}

// ─── Proposals (registered before /:businessId/:id so 'proposals' is not
//     read as a retrospective id) ──────────────────────────────────────────

router.get('/:businessId/proposals', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    // Lapse anything overdue before listing, so the queue a reviewer sees
    // never contains a proposal that is already past its expiry.
    expireStaleProposals(businessId);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(listProposalsForBusiness(businessId, {
      status: status as never,
      limit: Number(req.query.limit) || undefined,
    }));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:businessId/proposals/:proposalId', (req: Request, res: Response) => {
  try {
    const proposal = getProposal(String(req.params.proposalId), String(req.params.businessId));
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    res.json(proposal);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Approve or reject. Approval marks the decision-queue task approved, which
 * is what enqueues the activation for the executor; it does not itself change
 * any policy, playbook or agent.
 */
router.post('/:businessId/proposals/:proposalId/review', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      outcome?: unknown; reason?: unknown; override_reason?: unknown;
    };
    const outcome = body.outcome === 'approve' || body.outcome === 'reject' ? body.outcome : null;
    if (!outcome) {
      return res.status(422).json({
        error: "outcome must be 'approve' or 'reject'.",
        code: 'invalid_outcome',
      });
    }
    const result = reviewRetrospectiveProposal({
      proposalId: String(req.params.proposalId),
      businessId: String(req.params.businessId),
      outcome,
      actor: actorOf(req),
      reason: typeof body.reason === 'string' ? body.reason : null,
      overrideReason: typeof body.override_reason === 'string' ? body.override_reason : null,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/** Undo an activated change through the owning subsystem's own rollback. */
router.post('/:businessId/proposals/:proposalId/rollback', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { reason?: unknown };
    res.json(rollbackRetrospectiveChange({
      proposalId: String(req.params.proposalId),
      businessId: String(req.params.businessId),
      actor: actorOf(req),
      reason: typeof body.reason === 'string' ? body.reason : null,
    }));
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Retrospectives ──────────────────────────────────────────────────────────

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    res.json(listRetrospectives(String(req.params.businessId)));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const r = getRetrospective(String(req.params.id), String(req.params.businessId));
    if (!r) return res.status(404).json({ error: 'Retrospective not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/run', async (req: Request, res: Response) => {
  try {
    const result = await runRetrospective(String(req.params.businessId), { triggered_by: 'human' });
    if (!result) return res.status(422).json({ error: 'Unable to generate retrospective' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
