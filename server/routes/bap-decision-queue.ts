/**
 * Blueprint Agent Protocol (BAP) — Decision Centre / pending-decision queue (#77).
 *
 * ─── NOT the same thing as bap-decisions.ts ─────────────────────────────────
 *
 * Two surfaces in this codebase are called "decisions" and they are different
 * concepts. Read this before adding anything to either one:
 *
 *   bap-decisions.ts        GET /businesses/:id/decisions, GET /decisions/:id
 *                           permission `decisions:read`
 *                           → the decision-MEMORY recall log
 *                             (server/brain/decision-memory.ts). Historical,
 *                             already-made decisions: "why did we decide this
 *                             six months ago?". One row per decision made.
 *
 *   THIS FILE               GET /businesses/:id/decision-queue, …/classes,
 *                           GET /decision-queue/:taskId
 *                           permission `decision_queue:read`
 *                           → the pending review QUEUE
 *                             (server/decisions/decision-queue.ts, #61).
 *                             Items still awaiting a human, with evidence,
 *                             risk tier, lane and required action. Not a
 *                             table — a view derived over tasks on read.
 *
 * The paths and the permission are deliberately distinct rather than shared.
 * Reusing `decisions:read` or the `/decisions` paths would mean an agent
 * asking for its pending work could silently receive the historical log
 * instead — the same word, a different data model, no error raised. An agent
 * that wants both asks for both grants.
 *
 * Once an item here is reviewed it leaves this queue and the record of what
 * was decided appears in decision-memory, i.e. on the OTHER surface. That
 * hand-off is why #77's "list pending/reviewed decisions" is served by two
 * endpoints rather than one: this file is honest about only having the
 * pending half, instead of inventing a second store of reviewed outcomes.
 *
 * ─── Read-only, deliberately ────────────────────────────────────────────────
 *
 * There is no BAP approve/reject/defer/amend path, matching #77's stated
 * default and bap-operating-policies.ts's reasoning. The queue exists so a
 * human decides; letting the proposing agent approve its own proposal over
 * the same protocol it proposed on would make the review step a formality.
 * Review stays on the session-authenticated dashboard route
 * (server/routes/decision-queue.ts), where the actor is attributed
 * `dashboard:` — which is precisely what #68's autonomy gate reads to tell a
 * human approval from an unattended one.
 *
 * What an agent gains from read access is the thing #77 actually asks for:
 * seeing WHY its proposal is pending (lane, lane_reason, hold_reasons,
 * policy citation) so it can supply better evidence or stop re-proposing
 * something the policy holds — rather than blind-polling task status.
 *
 * ─── Authorization ──────────────────────────────────────────────────────────
 *
 * Two gates, the convention every business-scoped BAP route uses:
 *   1. `requirePermission('decision_queue:read')` — the agent holds the grant
 *      AND the path's business is in its `business_access`.
 *   2. For the ID-addressed lookup, whose path carries no business, the row's
 *      own business_id is re-checked before anything is returned: an agent
 *      scoped to business B can never read business A's queue item by
 *      guessing a task ID.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside bap.ts's
 * already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET /businesses/:bid/decision-queue          — pending queue, sorted by lane
 *   GET /businesses/:bid/decision-queue/classes  — recurring decision classes
 *   GET /decision-queue/:taskId                  — single queue item detail
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import {
  getPendingDecision, listDecisionClasses, listPendingDecisions,
  type DecisionLane,
} from '../decisions/decision-queue.js';

const router = Router();

const LANES: DecisionLane[] = ['manual_review', 'policy_gated', 'routine'];

function agentOf(req: Request): Record<string, unknown> {
  return (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
}

function businessExists(businessId: string): boolean {
  return !!db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
}

/**
 * GET /businesses/:businessId/decision-queue
 *
 * Query: lane, risk_tier, decision_class, include_deferred, limit,
 *        proposed_by (exact match — how an agent narrows the queue to its
 *        own proposals, which is #77's motivating case).
 */
router.get(
  '/businesses/:businessId/decision-queue',
  requirePermission('decision_queue:read'),
  (req: Request, res: Response) => {
    try {
      const businessId = String(req.params.businessId);
      if (!businessExists(businessId)) {
        return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);
      }

      const { lane, risk_tier, decision_class, include_deferred, limit, proposed_by } = req.query;
      if (lane && !LANES.includes(String(lane) as DecisionLane)) {
        return sendError(req, res, 400, 'validation_error',
          `Unknown lane '${String(lane)}'. Must be one of: ${LANES.join(', ')}.`);
      }

      const result = listPendingDecisions(businessId, {
        lane: lane ? String(lane) as DecisionLane : undefined,
        risk_tier: risk_tier ? String(risk_tier) : undefined,
        decision_class: decision_class ? String(decision_class) : undefined,
        include_deferred: String(include_deferred ?? '') === 'true',
        limit: limit ? parseInt(String(limit), 10) : undefined,
      });

      if (!proposed_by) return res.json(result);

      // Narrowing to one proposer is a filter over the same evidence/risk the
      // engine already computed, applied here rather than in the engine: the
      // engine's counts describe the business's whole queue, and an agent
      // asking "what of MINE is pending" should not be told that is the total.
      const wanted = String(proposed_by);
      return res.json({
        ...result,
        decisions: result.decisions.filter((d) => d.proposed_by === wanted),
        proposed_by: wanted,
      });
    } catch (err) {
      return sendError(req, res, 500, 'internal_error', (err as Error).message);
    }
  },
);

/**
 * GET /businesses/:businessId/decision-queue/classes
 *
 * The recurring decision classes for this business: what kinds of decision
 * keep coming back, how many are pending, and whether the operating policy
 * already carries a standing human-review rule for them. Read-only here —
 * proposing a rule from a class is an operator act on the dashboard, and
 * saving one is #68's operating-policy editor.
 */
router.get(
  '/businesses/:businessId/decision-queue/classes',
  requirePermission('decision_queue:read'),
  (req: Request, res: Response) => {
    try {
      const businessId = String(req.params.businessId);
      if (!businessExists(businessId)) {
        return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);
      }
      return res.json(listDecisionClasses(businessId));
    } catch (err) {
      return sendError(req, res, 500, 'internal_error', (err as Error).message);
    }
  },
);

/**
 * GET /decision-queue/:taskId
 *
 * A queue item is identified by the task it is about — the queue has no ID
 * of its own because it has no table (see decision-queue.ts's docstring).
 *
 * 404 for a task that is not currently awaiting review, whatever its status:
 * this endpoint answers "what is pending about this?", not "show me a task".
 * Task state itself is `tasks:read`, and what was decided once it left the
 * queue is decision-memory (`decisions:read`, bap-decisions.ts).
 */
router.get('/decision-queue/:taskId', requirePermission('decision_queue:read'), (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId);
    // The path carries no business, so the row decides authorization. Resolve
    // the owning business first, re-check access against it, and only then
    // build the item — an unauthorized caller must not be able to tell a real
    // task ID from a fabricated one.
    const row = db.prepare('SELECT business_id FROM tasks WHERE id = ?')
      .get(taskId) as { business_id: string } | undefined;
    if (!row) return sendError(req, res, 404, 'not_found', `No pending decision '${taskId}'.`);

    if (!hasPermission(agentOf(req), 'decision_queue:read', row.business_id)) {
      return sendError(req, res, 403, 'permission_denied',
        'Permission denied: decision does not belong to an authorized business.');
    }

    const decision = getPendingDecision(row.business_id, taskId);
    if (!decision) {
      return sendError(req, res, 404, 'not_found',
        `Task '${taskId}' is not awaiting review, so it has no pending decision. `
        + 'Reviewed outcomes are on the decision-memory surface (GET /decisions, decisions:read).');
    }
    return res.json({ decision });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
