/**
 * Decision Centre API (#61) — session-authenticated reviewer surface for
 * server/decisions/decision-queue.ts.
 *
 * Every route is scoped to exactly one business, following the convention
 * routes/operating-policies.ts (#68) established: router-level
 * isAuthenticated, an explicit existence check on the business, and no
 * endpoint that spans businesses. A task id from another business is
 * reported as not found rather than forbidden — see requireTaskInBusiness()
 * in the engine for why.
 *
 * This is a review surface, not a policy surface: proposing a standing rule
 * returns a validated patch and #68's own preview, and the operator saves it
 * through routes/operating-policies.ts. There is deliberately no policy
 * write path here.
 *
 *   GET  /:businessId                       — pending queue, sorted by lane
 *   GET  /:businessId/classes               — recurring decision classes
 *   POST /:businessId/:taskId/review        — approve | reject | defer | amend
 *   POST /:businessId/:taskId/propose-rule  — preview a standing policy rule
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { PolicyValidationError } from '../policy/operating-policy.js';
import {
  DecisionQueueError, listDecisionClasses, listPendingDecisions,
  proposePolicyRuleFromDecision, reviewDecision,
  type DecisionLane, type PolicyRuleKind, type ReviewOutcome,
} from '../decisions/decision-queue.js';

const router = Router();
router.use(isAuthenticated);

/**
 * Reviews are attributed with the `dashboard:` prefix that the rest of the
 * system uses to mean "a human did this", which is what tells the #68
 * autonomy gate that this is a human approval rather than an unattended one.
 */
function actorOf(req: Request): string {
  const userId = (req.session as unknown as { userId?: string } | undefined)?.userId;
  return `dashboard:${userId ?? 'unknown'}`;
}

function businessExists(businessId: string): boolean {
  return !!db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof DecisionQueueError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err instanceof PolicyValidationError) {
    return res.status(422).json({
      error: 'The proposed policy rule is invalid: it contains conflicting or unsafe settings.',
      violations: err.violations,
    });
  }
  const message = (err as Error).message ?? 'Unknown error';
  // task-queue.ts signals a refused transition or a failed gate with
  // 'Cannot ...' / 'not found'; both are the caller's problem, not a bug.
  if (/not found/i.test(message)) return res.status(404).json({ error: message });
  if (/^Cannot |cannot be approved|is required|must be/i.test(message)) {
    return res.status(422).json({ error: message });
  }
  console.error('[decision-queue]', err);
  return res.status(500).json({ error: message });
}

const LANES: DecisionLane[] = ['manual_review', 'policy_gated', 'routine'];
const OUTCOMES: ReviewOutcome[] = ['approve', 'reject', 'defer', 'amend'];
const RULE_KINDS: PolicyRuleKind[] = ['always_require_human', 'cap_auto_approve_tier'];

/**
 * GET /api/decision-queue/:businessId
 * Query: lane, risk_tier, decision_class, include_deferred, limit
 */
router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return res.status(404).json({ error: `Business '${businessId}' not found.` });
    }
    const { lane, risk_tier, decision_class, include_deferred, limit } = req.query;
    if (lane && !LANES.includes(String(lane) as DecisionLane)) {
      return res.status(400).json({ error: `Unknown lane '${String(lane)}'. Must be one of: ${LANES.join(', ')}.` });
    }
    return res.json(listPendingDecisions(businessId, {
      lane: lane ? String(lane) as DecisionLane : undefined,
      risk_tier: risk_tier ? String(risk_tier) : undefined,
      decision_class: decision_class ? String(decision_class) : undefined,
      include_deferred: String(include_deferred ?? '') === 'true',
      limit: limit ? parseInt(String(limit), 10) : undefined,
    }));
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * GET /api/decision-queue/:businessId/classes
 * The recurring decision classes — what a reusable policy rule would be about.
 */
router.get('/:businessId/classes', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return res.status(404).json({ error: `Business '${businessId}' not found.` });
    }
    return res.json(listDecisionClasses(businessId));
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * POST /api/decision-queue/:businessId/:taskId/review
 * Body: { outcome, reason?, override_reason?, amended_payload?,
 *         approve_after_amend?, defer_until? }
 */
router.post('/:businessId/:taskId/review', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return res.status(404).json({ error: `Business '${businessId}' not found.` });
    }
    const body = req.body as Record<string, unknown>;
    const outcome = String(body.outcome ?? '') as ReviewOutcome;
    if (!OUTCOMES.includes(outcome)) {
      return res.status(400).json({
        error: `outcome must be one of: ${OUTCOMES.join(', ')}.`,
      });
    }
    const result = reviewDecision({
      businessId,
      taskId: String(req.params.taskId),
      outcome,
      actor: actorOf(req),
      reason: body.reason == null ? null : String(body.reason),
      overrideReason: body.override_reason == null ? null : String(body.override_reason),
      amendedPayload: (body.amended_payload as Record<string, unknown> | undefined) ?? null,
      approveAfterAmend: body.approve_after_amend === undefined ? undefined : body.approve_after_amend !== false,
      deferUntil: body.defer_until == null ? null : String(body.defer_until),
    });
    return res.json(result);
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * POST /api/decision-queue/:businessId/:taskId/propose-rule
 * Body: { rule_kind }
 *
 * Returns a patch + #68's preview. Writes nothing — the operator saves it
 * through the operating policy editor, where scheduling and audit live.
 */
router.post('/:businessId/:taskId/propose-rule', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return res.status(404).json({ error: `Business '${businessId}' not found.` });
    }
    const ruleKind = String((req.body as Record<string, unknown>)?.rule_kind ?? '') as PolicyRuleKind;
    if (!RULE_KINDS.includes(ruleKind)) {
      return res.status(400).json({ error: `rule_kind must be one of: ${RULE_KINDS.join(', ')}.` });
    }
    return res.json(proposePolicyRuleFromDecision({
      businessId, taskId: String(req.params.taskId), ruleKind,
    }));
  } catch (err) {
    return handleError(res, err);
  }
});

export default router;
