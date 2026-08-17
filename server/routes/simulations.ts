/**
 * Safe simulation / preview mode — HTTP surface (issue #67).
 *
 * One endpoint shape for every previewable action or workflow type, and one
 * separately-authorised execution step that re-validates before acting.
 *
 * The safeguards are NOT implemented here. Every route below is a thin
 * wrapper over runSimulation(), which runs the evaluator inside the
 * process-wide side-effect guard; the guarantees hold identically for a
 * scheduler, an agent or a test calling the same functions directly. That
 * split is deliberate — issue #67 asks for enforcement "in shared execution
 * paths, not only in the UI", so an HTTP layer that could be bypassed is
 * explicitly not where the safety lives.
 *
 *   POST /api/simulations/:businessId/task-approval  — what approving a task would do
 *   POST /api/simulations/:businessId/policy-change  — what a policy edit would change (#68)
 *   POST /api/simulations/:businessId/playbook       — which playbook steps would run (#74)
 *   POST /api/simulations/:businessId/comparison     — compare candidates read-only (#66)
 *   GET  /api/simulations/:businessId/hiring         — whether hiring would act (#57)
 *   GET  /api/simulations/:businessId                — recent previews for this business
 *   GET  /api/simulations/preview/:previewId         — one preview + a live currency check
 *   POST /api/simulations/preview/:previewId/execute — authorise and execute
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { runSimulation, SIMULATION_KINDS } from '../simulation/simulation.js';
import {
  authorizeFromPreview, checkPreviewCurrency, getPreview, listPreviews,
} from '../simulation/simulation-store.js';
import {
  evaluateTaskApproval, loadTaskForPreview, taskApprovalSnapshotSources,
} from '../simulation/evaluators/task-approval.js';
import {
  evaluatePolicyChange, policyChangeSnapshotSources,
  evaluatePlaybookRun, playbookSnapshotSources,
  evaluateComparison, comparisonSnapshotSources,
  evaluateHiringReadiness, hiringSnapshotSources,
} from '../simulation/evaluators/existing-previews.js';
import { parsePlaybookDefinition } from '../workflows/playbook-schema.js';
import { approveTask } from '../tasks/task-queue.js';
import type { OperatingPolicyPatch, PolicyScope } from '../policy/operating-policy.js';
import type { CandidateRef } from '../brain/comparison-engine.js';

const router = Router();
router.use(isAuthenticated);

function actorOf(req: Request): string {
  const userId = (req.session as unknown as { userId?: string } | undefined)?.userId;
  return `dashboard:${userId ?? 'unknown'}`;
}

function businessExists(businessId: string): boolean {
  return !!db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
}

function fail(res: Response, err: unknown, context: string): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[simulations] ${context}:`, message);
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;
  if (typeof statusCode === 'number') {
    return res.status(statusCode).json({ error: message, code: (err as { code?: string }).code ?? null });
  }
  return res.status(500).json({ error: `Failed to run ${context}.` });
}

/** Shown alongside every result so a client can label previews consistently. */
router.get('/kinds', (_req: Request, res: Response) => {
  return res.json({ kinds: SIMULATION_KINDS });
});

// ─── Previews ────────────────────────────────────────────────────────────────

router.post('/:businessId/task-approval', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });

    const body = req.body as { task_id?: string; as_actor?: string };
    if (!body?.task_id) return res.status(400).json({ error: 'task_id is required.' });

    const task = loadTaskForPreview(String(body.task_id));
    if (!task) return res.status(404).json({ error: `Task '${body.task_id}' not found.` });
    if (task.business_id !== businessId) {
      return res.status(404).json({ error: `Task '${body.task_id}' does not belong to business '${businessId}'.` });
    }

    // A preview may be run "as" the autonomous approver to answer "would
    // Blueprint be allowed to do this on its own?" — a genuinely different
    // question from "may I approve it?", because the policy's autonomy
    // limits do not constrain a person.
    const approvedBy = body.as_actor === 'autonomous' ? 'system:simulation' : actorOf(req);

    const result = runSimulation({
      kind: 'task_approval',
      businessId,
      actor: actorOf(req),
      targetType: 'task',
      targetId: task.id,
      snapshotSources: taskApprovalSnapshotSources(task.id, businessId, task.action_type),
      executable: true,
      evaluate: () => evaluateTaskApproval({ task, approvedBy }),
    });

    return res.json(result);
  } catch (err) { return fail(res, err, 'task approval simulation'); }
});

router.post('/:businessId/policy-change', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });

    const body = req.body as { patch?: OperatingPolicyPatch; effective_at?: string | null };
    if (!body?.patch || typeof body.patch !== 'object') {
      return res.status(400).json({ error: 'patch is required and must be an object.' });
    }
    const scope: PolicyScope = 'business';

    const result = runSimulation({
      kind: 'policy_change',
      businessId,
      actor: actorOf(req),
      targetType: 'operating_policy',
      targetId: businessId,
      snapshotSources: policyChangeSnapshotSources(scope, businessId, body.patch),
      executable: true,
      evaluate: () => evaluatePolicyChange({
        scope, key: businessId, patch: body.patch!, effectiveAt: body.effective_at ?? null,
      }),
    });

    return res.json(result);
  } catch (err) { return fail(res, err, 'policy change simulation'); }
});

router.post('/:businessId/playbook', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });

    const body = req.body as {
      definition?: unknown; inputs?: Record<string, unknown>;
      workflow_id?: string | null; version?: number | null;
    };
    if (!body?.definition) return res.status(400).json({ error: 'definition is required.' });

    const definition = parsePlaybookDefinition(body.definition, businessId);

    const result = runSimulation({
      kind: 'playbook_run',
      businessId,
      actor: actorOf(req),
      targetType: 'playbook',
      targetId: body.workflow_id ?? null,
      snapshotSources: playbookSnapshotSources({
        businessId, workflowId: body.workflow_id ?? null, inputs: body.inputs ?? {},
      }),
      evaluate: () => evaluatePlaybookRun({
        businessId, definition, inputs: body.inputs ?? {},
        workflowId: body.workflow_id ?? null, version: body.version ?? null,
      }),
    });

    return res.json(result);
  } catch (err) { return fail(res, err, 'playbook simulation'); }
});

router.post('/:businessId/comparison', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });

    const body = req.body as { candidates?: CandidateRef[] };
    if (!Array.isArray(body?.candidates) || body.candidates.length === 0) {
      return res.status(400).json({ error: 'candidates must be a non-empty array.' });
    }

    const result = runSimulation({
      kind: 'recommendation_comparison',
      businessId,
      actor: actorOf(req),
      targetType: 'comparison',
      targetId: null,
      snapshotSources: comparisonSnapshotSources(businessId, body.candidates),
      evaluate: () => evaluateComparison({ businessId, refs: body.candidates! }),
    });

    return res.json(result);
  } catch (err) { return fail(res, err, 'comparison simulation'); }
});

router.get('/:businessId/hiring', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });

    const result = runSimulation({
      kind: 'hiring_analysis',
      businessId,
      actor: actorOf(req),
      targetType: 'hiring',
      targetId: businessId,
      snapshotSources: hiringSnapshotSources(businessId),
      evaluate: () => evaluateHiringReadiness({ businessId }),
    });

    return res.json(result);
  } catch (err) { return fail(res, err, 'hiring simulation'); }
});

// ─── Reading back ────────────────────────────────────────────────────────────

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
    const limit = parseInt(String(req.query.limit ?? ''), 10) || 50;
    const previews = listPreviews(businessId, limit).map((p) => ({
      id: p.id, kind: p.kind, actor: p.actor,
      target_type: p.target_type, target_id: p.target_id,
      created_at: p.created_at, expires_at: p.expires_at,
      consumed_at: p.consumed_at, consumed_by: p.consumed_by,
      expired: new Date(p.expires_at).getTime() <= Date.now(),
    }));
    return res.json({ previews, total: previews.length });
  } catch (err) { return fail(res, err, 'preview list'); }
});

/**
 * One preview, plus a LIVE currency check. A client showing a stored
 * preview should show this alongside it: "still current" is a fact about
 * now, not about when the preview was made.
 */
router.get('/preview/:previewId', (req: Request, res: Response) => {
  try {
    const preview = getPreview(String(req.params.previewId));
    if (!preview) return res.status(404).json({ error: `Preview '${req.params.previewId}' not found.` });

    const { drift, expired } = checkPreviewCurrency(preview);
    return res.json({
      preview,
      currency: {
        current: drift.length === 0 && !expired && !preview.consumed_at,
        expired,
        consumed: !!preview.consumed_at,
        drift,
        note: drift.length > 0
          ? 'The data behind this preview has changed. Executing from it is refused; run the preview again.'
          : expired
            ? 'This preview has expired and can no longer authorise execution.'
            : preview.consumed_at
              ? 'This preview has already been used to authorise an execution.'
              : 'This preview still matches live data and can authorise execution.',
      },
    });
  } catch (err) { return fail(res, err, 'preview read'); }
});

// ─── The separately-authorised execution step ────────────────────────────────

/**
 * Execute what a preview described.
 *
 * The authorisation is not "the user saw a preview" — it is "the preview is
 * STILL TRUE". authorizeFromPreview() re-resolves every snapshot source
 * against live data and refuses on any drift, on expiry, or on reuse. Only
 * kinds whose execution is a single well-defined step are executable;
 * previewing something is deliberately not the same as being able to fire
 * it from the preview.
 */
router.post('/preview/:previewId/execute', (req: Request, res: Response) => {
  try {
    const previewId = String(req.params.previewId);
    const preview = getPreview(previewId);
    if (!preview) return res.status(404).json({ error: `Preview '${previewId}' not found.` });

    const actor = actorOf(req);

    if (preview.kind !== 'task_approval') {
      return res.status(400).json({
        error:
          `A '${preview.kind}' preview cannot be executed from here. Only task approvals have a single ` +
          'well-defined execution step; policy changes are saved through the operating-policy API, playbooks ' +
          'are run through the workflow API, and comparisons and hiring readiness are not executable at all.',
        code: 'kind_not_executable',
      });
    }

    // Re-validate and claim, in one step. Failure is explicit and names why.
    const authorization = authorizeFromPreview({
      previewId, actor, expectedKind: 'task_approval', expectedTargetId: preview.target_id,
    });
    if (!authorization.ok) {
      return res.status(409).json({
        error: authorization.message,
        code: authorization.reason,
        drift: authorization.drift,
        must_repreview: true,
      });
    }

    const task = approveTask(String(preview.target_id), actor);
    return res.json({
      executed: true,
      authorized_from_preview: previewId,
      task,
    });
  } catch (err) { return fail(res, err, 'preview execution'); }
});

export default router;
