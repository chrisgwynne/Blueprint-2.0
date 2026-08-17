/**
 * Blueprint Agent Protocol (BAP) — Safe simulation / preview mode (issue #86).
 *
 * Exposes #67's shared preview primitive to external agents, so one can find
 * out what approving a task would do before actually proposing or approving
 * anything. Every guarantee #67 built in — zero side effects, honest
 * freshness/assumptions/unsupported-operations, stale-preview detection — is
 * inherited unchanged: this file is a thin HTTP wrapper over runSimulation(),
 * evaluateTaskApproval() and the preview store, exactly like
 * routes/simulations.ts (the dashboard surface for the same primitive). It
 * adds nothing to the guard itself.
 *
 * Scope, deliberately narrow (see the issue): a task-approval preview for an
 * ALREADY-PROPOSED task, plus reading one back. Blueprint has no
 * not-yet-created-task preview to mirror — every dashboard preview kind
 * previews an existing thing (a task, a policy patch, a playbook definition,
 * a set of candidates), never a hypothetical proposal — so "propose X, then
 * preview approving it" is the real shape, not a gap here.
 *
 * ── Permissions (two gates, not one) ──────────────────────────────────────
 *
 * `simulations:read` alone is not enough to preview a task approval: the
 * question being previewed is specifically "what would MY approval do?",
 * and an agent that could never actually call PATCH /tasks/:id (approve)
 * must not learn the answer to that question just by calling it "a
 * preview" — see the issue's acceptance criteria. So this route requires
 * BOTH `simulations:read` and `tasks:approve`, following the same
 * "evaluate without committing needs the read-shaped grant" precedent as
 * bap-trust.ts's POST /applicability/evaluate (requirePermission
 * ('capabilities:read') even though it's a POST) — plus, here, the grant
 * for the real action being previewed.
 *
 * ── Why the preview is run as `bap:{agentId}` ─────────────────────────────
 *
 * evaluateTaskApproval() branches on `approvedBy.startsWith('dashboard:')`
 * to decide whether the operating policy's autonomy limits apply (they
 * never constrain a human; see task-queue.ts's approveTask). A BAP agent is
 * never that human — the real PATCH /tasks/:id route in bap.ts calls
 * approveTask(id, `bap:${agent.id}`) — so previewing as anything else would
 * answer a different question than the one this agent's own approval call
 * would actually face. There is no `as_actor` override here (unlike the
 * dashboard route): a BAP agent asking "what would happen" always means
 * "what would happen if I did it".
 *
 * ── Zero real side effects, verified not just asserted ────────────────────
 *
 * runSimulation() opens the same simulation-context.ts guard the dashboard
 * route opens; db.prepare() rejects any write attempted beneath it, and
 * approveTask() itself calls guardSimulationSideEffect() before doing
 * anything else. See bap-simulation.test.ts for the behavioural proof
 * (row counts unchanged across every operational table) and simulation.ts /
 * simulation-context.ts for the enforcement itself — nothing in THIS file
 * is where the safety lives.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import { runSimulation } from '../simulation/simulation.js';
import { getPreview, checkPreviewCurrency } from '../simulation/simulation-store.js';
import {
  evaluateTaskApproval, loadTaskForPreview, taskApprovalSnapshotSources,
} from '../simulation/evaluators/task-approval.js';

// No blanket auth/rate-limit middleware here — see bap-goals.ts's docstring
// on this file's mounting inside bap.ts's already-authenticated router chain.
const router = Router();

function agentOf(req: Request): Record<string, unknown> {
  return (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
}

router.post(
  '/businesses/:businessId/simulate/task-approval',
  requirePermission('simulations:read'),
  requirePermission('tasks:approve'),
  (req: Request, res: Response) => {
    try {
      const businessId = String(req.params.businessId);
      const body = req.body as { task_id?: string };
      if (!body?.task_id) return sendError(req, res, 400, 'validation_error', 'task_id is required.');

      const task = loadTaskForPreview(String(body.task_id));
      if (!task) return sendError(req, res, 404, 'not_found', `Task '${body.task_id}' not found.`);
      if (task.business_id !== businessId) {
        return sendError(req, res, 404, 'not_found', `Task '${body.task_id}' does not belong to business '${businessId}'.`);
      }

      const agent = agentOf(req);
      const approvedBy = `bap:${agent.id as string}`;

      const result = runSimulation({
        kind: 'task_approval',
        businessId,
        actor: approvedBy,
        targetType: 'task',
        targetId: task.id,
        snapshotSources: taskApprovalSnapshotSources(task.id, businessId, task.action_type),
        // Not offered here — see "Why there is no execute-from-preview
        // route" below. Marking it non-executable keeps a BAP client from
        // being told it could authorise an execution this router never
        // implements.
        executable: false,
        evaluate: () => evaluateTaskApproval({ task, approvedBy }),
      });

      return res.json(result);
    } catch (err) {
      return sendError(req, res, 500, 'internal_error', (err as Error).message);
    }
  },
);

/**
 * GET /simulations/:id — read back a prior preview, plus a LIVE currency
 * check (drift/expiry/consumption), same shape as the dashboard's
 * GET /simulations/preview/:previewId. This is deliberately how staleness
 * is "flagged on reuse, not silently trusted" for a read-only surface: there
 * is no execute-from-preview route here for a stale preview to silently
 * authorise (see below), so the flag belongs on the read, not on a refusal
 * to read.
 *
 * Why there is no execute-from-preview route here: BAP's real approval path
 * — PATCH /tasks/:taskId in bap.ts — already re-validates every gate against
 * LIVE state on every call (autonomy, daily cap, applicability, tier,
 * connectors); it was never built to accept a stale snapshot in the first
 * place, unlike the dashboard's single execute step which exists precisely
 * because a human might act minutes after reading a preview. Adding a
 * second, preview-authorised execution path for BAP would be a second way
 * to approve a task with weaker guarantees than the one that already
 * exists, not a stronger one.
 */
router.get('/simulations/:previewId', requirePermission('simulations:read'), (req: Request, res: Response) => {
  try {
    const preview = getPreview(String(req.params.previewId));
    if (!preview) return sendError(req, res, 404, 'not_found', `Preview '${req.params.previewId}' not found.`);

    const agent = agentOf(req);
    if (!hasPermission(agent, 'simulations:read', preview.business_id)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: preview does not belong to an authorized business.');
    }

    const { drift, expired } = checkPreviewCurrency(preview);
    return res.json({
      preview,
      currency: {
        current: drift.length === 0 && !expired && !preview.consumed_at,
        expired,
        consumed: !!preview.consumed_at,
        drift,
        note: drift.length > 0
          ? 'The data behind this preview has changed. It no longer describes what would happen; run the preview again.'
          : expired
            ? 'This preview has expired and no longer describes what would happen.'
            : preview.consumed_at
              ? 'This preview has already been used to authorise an execution.'
              : 'This preview still matches live data.',
      },
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
