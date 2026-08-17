/**
 * Blueprint Agent Protocol (BAP) — Reusable bounded playbooks (issue #85).
 *
 * Exposes #74's versioned, bounded playbook system — currently reachable
 * only from the session-authenticated dashboard route (server/routes/
 * workflows.ts, server/workflows/playbook-*.ts) — to external agents.
 *
 * ─── Read, simulate AND trigger — why the trigger endpoint is safe ──────────
 *
 * Every other write-capable BAP surface in this codebase (tasks:propose,
 * goals:propose, connectors:sync, agents:trigger) either creates something
 * that still has to clear a human review, or dispatches work that is itself
 * gated by the Typed Action Registry and the Operating Policy's autonomy
 * gate. A playbook RUN is the same shape, not a new one, once you look at
 * what starting one actually does (playbook-engine.ts):
 *
 *   - Every `kind: 'action'` step becomes a real task via the SAME
 *     createTask()+approveTask() pair every other BAP-proposed task goes
 *     through — the Typed Action Registry payload check, the Operating
 *     Policy's autonomy gate (`always_require_human_action_types`, the
 *     auto-approve tier ceiling, required connectors, the daily cap) all
 *     run exactly as they would for a task an agent proposed directly.
 *     Triggering a run does not skip approveTask(); it calls it.
 *   - Before that even happens, resolveStepApproval() (playbook-
 *     simulation.ts, shared by simulate and execute) can pause the run to
 *     `awaiting_approval` for a step's own `approval_gate`, a registry-
 *     level `requires_approval`, a risk tier at or above the policy's
 *     human-approval floor, or an explicit `always_require_human_action_
 *     types` match — and there is deliberately no BAP endpoint to clear
 *     that pause (see "No approve/reject/retry/rollback path" below), so a
 *     BAP agent can start a run but can never itself walk it past a step
 *     that needed a human.
 *   - `kind: 'manual'` steps unconditionally carry the
 *     `manual_step_acknowledgement` approval source, so they ALWAYS pause
 *     for a human too — a bounded playbook never hands free text to an
 *     agent unattended, whether the run was started from the dashboard or
 *     over BAP.
 *   - The actor recorded for everything a triggered run does is
 *     `bap:{agent_id}` — never `dashboard:...` — which is exactly the
 *     string #68's autonomy gate reads to tell a human decision from
 *     Blueprint (or an external agent) acting unattended. Triggering a run
 *     over BAP gets no more autonomy than proposing the same task directly
 *     over BAP would.
 *
 * So `POST .../playbooks/:id/run` does not bypass approval — it schedules
 * work that still needs it, identically to any other BAP-proposed action.
 * That is the deciding factor per #85's acceptance criteria ("no shortcut
 * that bypasses risk-derived approval"), and is checked directly in
 * bap-playbooks.test.ts (a step requiring approval, triggered over BAP,
 * ends up `awaiting_approval` — not executed).
 *
 * ─── No approve/reject/retry/rollback/cancel path ───────────────────────────
 *
 * Precisely because #77's Decision Queue established the precedent: a step
 * paused for a human stays paused for a human. There is no BAP endpoint to
 * approve, reject, retry, roll back or cancel a playbook run or step —
 * those remain session-authenticated dashboard acts (server/routes/
 * workflows.ts), attributed `dashboard:`, so the same actor string the
 * autonomy gate already trusts as "a person decided this" is never
 * forgeable from outside. An agent that triggers a run and wants to know
 * whether it is stuck on a human sees that directly in the run detail
 * response below (`steps[].status === 'awaiting_approval'`).
 *
 * ─── Authoring stays on the dashboard ────────────────────────────────────
 *
 * BAP has no path to create, validate, activate, schedule or roll back a
 * playbook VERSION — only to read what is already authored, simulate it,
 * and trigger a run of it. Authoring is an operator act with its own
 * validate→activate lifecycle (playbook-versions.ts); this file reads that
 * lifecycle's output, it does not extend it. The simulate endpoint below
 * therefore only accepts a stored version (or "whatever is active"), never
 * a caller-supplied raw definition the way the dashboard's own simulate
 * route does for previewing an unsaved draft.
 *
 * No blanket auth/rate-limit middleware here — mounted as a sub-router
 * inside bap.ts's already-authenticated chain (see bap-goals.ts's
 * docstring).
 *
 * Endpoints:
 *   GET  /businesses/:bid/playbooks                       — list, this business
 *   GET  /businesses/:bid/playbooks/:playbookId            — one playbook's active version + step definitions
 *   GET  /businesses/:bid/playbooks/:playbookId/runs       — run history (paginated)
 *   GET  /businesses/:bid/playbooks/:playbookId/runs/:runId — one run, step-by-step, receipt-backed status
 *   POST /businesses/:bid/playbooks/:playbookId/simulate   — #74's zero-side-effect preview
 *   POST /businesses/:bid/playbooks/:playbookId/run        — trigger a real run (requires playbooks:trigger)
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission } from '../bap/auth.js';
import { bapRateLimit } from '../bap/rate-limiter.js';
import {
  parsePagination, paginationMeta, normalizeTimestamps,
  withRequiredIdempotency, sendError,
} from '../bap/route-helpers.js';
import { PlaybookValidationError } from '../workflows/playbook-schema.js';
import {
  requireWorkflow, listPlaybookVersions, getPlaybookVersion, getActivePlaybookVersion,
  PlaybookNotFoundError, PlaybookStateError, type WorkflowRef,
} from '../workflows/playbook-versions.js';
import { simulatePlaybook } from '../workflows/playbook-simulation.js';
import { startPlaybookRun, describePlaybookRun } from '../workflows/playbook-engine.js';

const router = Router();

function businessExists(businessId: string): boolean {
  return !!db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
}

/** Maps the same playbook error vocabulary the dashboard route uses onto BAP's stable error schema. */
function sendPlaybookError(req: Request, res: Response, err: unknown): void {
  if (err instanceof PlaybookValidationError) {
    sendError(req, res, 400, 'validation_error', err.message, { violations: err.violations });
    return;
  }
  if (err instanceof PlaybookNotFoundError) { sendError(req, res, 404, 'not_found', err.message); return; }
  if (err instanceof PlaybookStateError) { sendError(req, res, 409, 'conflict', err.message); return; }
  sendError(req, res, 500, 'internal_error', (err as Error).message);
}

function summarisePlaybook(ref: WorkflowRef): Record<string, unknown> | null {
  const workflow = db.prepare(
    'SELECT id, name, description, status, trigger_type, run_count, last_run_at, updated_at FROM workflows WHERE id = ? AND business_id = ?',
  ).get(ref.workflowId, ref.businessId) as Record<string, unknown> | undefined;
  if (!workflow) return null;

  const versions = listPlaybookVersions(ref);
  const active = getActivePlaybookVersion(ref);
  return normalizeTimestamps({
    workflow_id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    trigger_type: workflow.trigger_type,
    run_count: workflow.run_count,
    last_run_at: workflow.last_run_at,
    version_count: versions.length,
    active_version: active ? {
      version: active.version,
      state: active.state,
      step_count: active.definition.steps.length,
      activated_at: active.activated_at,
      change_reason: active.change_reason,
    } : null,
  }, ['last_run_at', 'updated_at']);
}

router.get('/businesses/:businessId/playbooks', requirePermission('playbooks:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);

    // A "playbook" is a workflow that has adopted #74's versioned system —
    // i.e. it has at least one row in playbook_versions. A workflow that
    // still only carries the pre-#74 free-text step shape (workflows.steps)
    // is not a bounded playbook and is out of #85's scope; it has no
    // typed, schema-checked, risk-graded step to expose here.
    const workflowIds = db.prepare(
      'SELECT DISTINCT workflow_id FROM playbook_versions WHERE business_id = ? ORDER BY workflow_id',
    ).all(businessId) as Array<{ workflow_id: string }>;

    const playbooks = workflowIds
      .map(({ workflow_id }) => summarisePlaybook({ workflowId: workflow_id, businessId }))
      .filter((p): p is Record<string, unknown> => p !== null);

    return res.json({ playbooks, total: playbooks.length });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/businesses/:businessId/playbooks/:playbookId', requirePermission('playbooks:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const workflowId = String(req.params.playbookId);
    const ref: WorkflowRef = { workflowId, businessId };
    requireWorkflow(ref);

    const workflow = db.prepare(
      'SELECT id, name, description, status, trigger_type, trigger_config, run_count, last_run_at, created_at, updated_at FROM workflows WHERE id = ? AND business_id = ?',
    ).get(workflowId, businessId) as Record<string, unknown>;

    const versions = listPlaybookVersions(ref);
    const active = getActivePlaybookVersion(ref);

    return res.json({
      workflow: normalizeTimestamps(workflow, ['last_run_at', 'created_at', 'updated_at']),
      active_version: active ? {
        id: active.id, version: active.version, state: active.state,
        definition: active.definition, activated_at: active.activated_at, change_reason: active.change_reason,
      } : null,
      versions: versions.map((v) => normalizeTimestamps({
        id: v.id, version: v.version, state: v.state, validation_state: v.validation_state,
        effective_at: v.effective_at, activated_at: v.activated_at, superseded_at: v.superseded_at,
        source: v.source, change_reason: v.change_reason, created_by: v.created_by, created_at: v.created_at,
      }, ['effective_at', 'activated_at', 'superseded_at', 'created_at'])),
    });
  } catch (err) {
    return sendPlaybookError(req, res, err);
  }
});

router.get('/businesses/:businessId/playbooks/:playbookId/runs', requirePermission('playbooks:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const workflowId = String(req.params.playbookId);
    requireWorkflow({ workflowId, businessId });

    const { status } = req.query;
    const conditions = ['workflow_id = ?', 'business_id = ?'];
    const params: any[] = [workflowId, businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (status) {
      const arr = String(status).split(',');
      conditions.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    const where = conditions.join(' AND ');

    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM workflow_runs WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = db.prepare(`
      SELECT id, workflow_id, business_id, status, triggered_by, trigger_reason,
        current_step, steps_total, steps_completed, playbook_version, run_key,
        stopped_reason, started_at, completed_at, error
      FROM workflow_runs WHERE ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<Record<string, unknown>>;

    return res.json({
      runs: rows.map((r) => normalizeTimestamps(r, ['started_at', 'completed_at'])),
      total,
      pagination: paginationMeta(total, page, limit),
    });
  } catch (err) {
    return sendPlaybookError(req, res, err);
  }
});

router.get('/businesses/:businessId/playbooks/:playbookId/runs/:runId', requirePermission('playbooks:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const workflowId = String(req.params.playbookId);
    const runId = String(req.params.runId);
    requireWorkflow({ workflowId, businessId });

    // describePlaybookRun() itself scopes only by business — re-check the
    // run actually belongs to THIS playbook so /playbooks/A/runs/:id can
    // never return a run started on playbook B in the same business.
    const runRow = db.prepare('SELECT workflow_id FROM workflow_runs WHERE id = ? AND business_id = ?')
      .get(runId, businessId) as { workflow_id: string } | undefined;
    if (!runRow || runRow.workflow_id !== workflowId) {
      return sendError(req, res, 404, 'not_found', `Run '${runId}' was not found for playbook '${workflowId}'.`);
    }

    return res.json(describePlaybookRun(runId, businessId));
  } catch (err) {
    return sendPlaybookError(req, res, err);
  }
});

/**
 * Preview only — never accepts a raw `definition` the way the dashboard's
 * simulate route can (see the module docstring: authoring stays on the
 * dashboard). `version` simulates that stored version; omitted simulates
 * whatever is active today.
 */
router.post('/businesses/:businessId/playbooks/:playbookId/simulate', requirePermission('playbooks:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const workflowId = String(req.params.playbookId);
    const ref: WorkflowRef = { workflowId, businessId };
    requireWorkflow(ref);

    const body = (req.body ?? {}) as Record<string, unknown>;
    let definition;
    let version: number | null = null;
    if (body.version != null) {
      const stored = getPlaybookVersion(ref, Number(body.version));
      if (!stored) return sendError(req, res, 404, 'not_found', `Version ${body.version} does not exist for this playbook.`);
      definition = stored.definition;
      version = stored.version;
    } else {
      const active = getActivePlaybookVersion(ref);
      if (!active) {
        return sendError(req, res, 409, 'conflict',
          'This playbook has no active version to simulate. Pass an explicit `version`, or ask the operator to activate one.');
      }
      definition = active.definition;
      version = active.version;
    }

    return res.json(simulatePlaybook({
      businessId, definition, workflowId, version,
      inputs: (body.inputs as Record<string, unknown>) ?? {},
    }));
  } catch (err) {
    return sendPlaybookError(req, res, err);
  }
});

/**
 * Trigger a real run. See the module docstring for why this does not
 * bypass approval: every action step still clears the same Typed Action
 * Registry + Operating Policy gate a directly-proposed task would, and a
 * step needing a human still pauses at `awaiting_approval` with no BAP
 * path past it.
 */
router.post(
  '/businesses/:businessId/playbooks/:playbookId/run',
  requirePermission('playbooks:trigger'),
  bapRateLimit('playbooks:trigger'),
  async (req: Request, res: Response) => {
    try {
      const businessId = String(req.params.businessId);
      const workflowId = String(req.params.playbookId);
      requireWorkflow({ workflowId, businessId });

      const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
      const body = (req.body ?? {}) as Record<string, unknown>;

      await withRequiredIdempotency(req, res, 'playbooks:trigger', async () => {
        const result = startPlaybookRun({
          workflowId,
          businessId,
          inputs: (body.inputs as Record<string, unknown>) ?? {},
          // `bap:` — never `dashboard:` — so #68's autonomy gate treats
          // everything this run dispatches as unattended, exactly as it
          // would for a task this agent proposed directly.
          actor: `bap:${bapAgent.id as string}`,
          trigger_reason: (body.reason as string | null) ?? `Triggered via BAP by external agent "${bapAgent.name as string}"`,
          idempotency_key: req.header('Idempotency-Key') ?? null,
        });
        return { status: result.reused ? 200 : 202, body: result };
      });
    } catch (err) {
      return sendPlaybookError(req, res, err);
    }
  },
);

export default router;
