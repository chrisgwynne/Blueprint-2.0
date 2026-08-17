/**
 * Workflows API (Prompt 1).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  startWorkflow, approveWorkflowStep, rejectWorkflowStep, cancelWorkflow,
} from '../workflows/workflow-engine.js';
import { PlaybookValidationError, parsePlaybookDefinition } from '../workflows/playbook-schema.js';
import {
  savePlaybookDraft, validatePlaybookVersion, activatePlaybookVersion,
  listPlaybookVersions, getPlaybookVersion, getActivePlaybookVersion,
  rollbackPlaybookVersion, cancelScheduledPlaybookVersion, listPlaybookEvents,
  PlaybookNotFoundError, PlaybookStateError,
} from '../workflows/playbook-versions.js';
import { simulatePlaybook } from '../workflows/playbook-simulation.js';
import {
  startPlaybookRun, advancePlaybookRun, approvePlaybookStep, rejectPlaybookStep,
  retryPlaybookStep, compensatePlaybookRun, cancelPlaybookRun, describePlaybookRun,
} from '../workflows/playbook-engine.js';

const router = Router();
router.use(isAuthenticated);

/**
 * The dashboard actor. `dashboard:` is load-bearing, not cosmetic: the
 * operating policy's autonomy gate treats a dashboard actor as a human
 * decision and an unprefixed one as Blueprint acting unattended.
 */
function actorOf(req: Request): string {
  const session = req.session as unknown as Record<string, unknown> | undefined;
  return `dashboard:${(session?.username as string) || (session?.userId as string) || 'human'}`;
}

/**
 * One place that maps the playbook error vocabulary onto HTTP, so a
 * validation failure is always a 400 carrying its violations (actionable
 * for the author) rather than an opaque 500.
 */
function sendPlaybookError(res: Response, err: unknown): Response {
  if (err instanceof PlaybookValidationError) {
    return res.status(400).json({ error: err.message, violations: err.violations });
  }
  if (err instanceof PlaybookNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof PlaybookStateError) return res.status(409).json({ error: err.message });
  return res.status(500).json({ error: (err as Error).message });
}

function parseRow(r: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!r) return null;
  return {
    ...r,
    trigger_config: safeParse(r.trigger_config, {}),
    steps: safeParse(r.steps, []),
    tags: safeParse(r.tags, []),
  };
}
function parseRun(r: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!r) return null;
  return { ...r, context: safeParse(r.context, {}) };
}
function parseStepRun(r: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!r) return null;
  return { ...r, tasks_created: safeParse(r.tasks_created, []) };
}
function safeParse(v: unknown, fallback: unknown): unknown {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ─── Playbooks: version lifecycle (#74) ──────────────────────────────────────
//
// Declared BEFORE the generic /:businessId/:workflowId handlers. Every route
// here carries a literal path segment ('playbook' / 'playbook-runs'), so the
// two families cannot shadow each other whatever the declaration order.

router.get('/:businessId/:workflowId/playbook/versions', (req: Request, res: Response) => {
  try {
    const ref = { workflowId: String(req.params.workflowId), businessId: String(req.params.businessId) };
    res.json({
      versions: listPlaybookVersions(ref),
      active: getActivePlaybookVersion(ref),
    });
  } catch (err) { sendPlaybookError(res, err); }
});

router.get('/:businessId/:workflowId/playbook/events', (req: Request, res: Response) => {
  try {
    const ref = { workflowId: String(req.params.workflowId), businessId: String(req.params.businessId) };
    res.json({ events: listPlaybookEvents(ref, parseInt(String(req.query.limit ?? '100'), 10) || 100) });
  } catch (err) { sendPlaybookError(res, err); }
});

/** Create a new DRAFT version. Creating never activates — that is a separate, explicit act. */
router.post('/:businessId/:workflowId/playbook/versions', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = savePlaybookDraft({
      workflowId: String(req.params.workflowId),
      businessId: String(req.params.businessId),
      definition: body.definition ?? body,
      actor: actorOf(req),
      change_reason: (body.change_reason as string | null) ?? null,
      base_version: body.base_version == null ? null : Number(body.base_version),
      validate: body.validate !== false,
    });
    res.status(201).json({ version });
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/:workflowId/playbook/versions/:version/validate', (req: Request, res: Response) => {
  try {
    const ref = { workflowId: String(req.params.workflowId), businessId: String(req.params.businessId) };
    res.json(validatePlaybookVersion(ref, parseInt(String(req.params.version), 10), actorOf(req)));
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/:workflowId/playbook/versions/:version/activate', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = activatePlaybookVersion({
      workflowId: String(req.params.workflowId),
      businessId: String(req.params.businessId),
      version: parseInt(String(req.params.version), 10),
      actor: actorOf(req),
      effective_at: (body.effective_at as string | null) ?? null,
      change_reason: (body.change_reason as string | null) ?? null,
    });
    res.json({ version });
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/:workflowId/playbook/versions/:version/cancel-schedule', (req: Request, res: Response) => {
  try {
    const version = cancelScheduledPlaybookVersion({
      workflowId: String(req.params.workflowId),
      businessId: String(req.params.businessId),
      version: parseInt(String(req.params.version), 10),
      actor: actorOf(req),
      reason: ((req.body ?? {}) as Record<string, unknown>).reason as string | null,
    });
    res.json({ version });
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/:workflowId/playbook/rollback', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.to_version == null) return res.status(400).json({ error: 'to_version is required.' });
    const version = rollbackPlaybookVersion({
      workflowId: String(req.params.workflowId),
      businessId: String(req.params.businessId),
      to_version: Number(body.to_version),
      actor: actorOf(req),
      change_reason: (body.change_reason as string | null) ?? null,
    });
    res.json({ version });
  } catch (err) { sendPlaybookError(res, err); }
});

/**
 * Preview. A GET would be more RESTful, but inputs and (for an unsaved
 * draft) a whole definition are too large for a query string. This writes
 * nothing — see playbook-simulation.ts.
 */
router.post('/:businessId/:workflowId/playbook/simulate', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const workflowId = String(req.params.workflowId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ref = { workflowId, businessId };

    // Simulate an unsaved draft when one is supplied, a stored version when
    // a number is given, and otherwise whatever is active today.
    let definition;
    let version: number | null = null;
    if (body.definition) {
      definition = parsePlaybookDefinition(body.definition, businessId);
    } else if (body.version != null) {
      const stored = getPlaybookVersion(ref, Number(body.version));
      if (!stored) return res.status(404).json({ error: `Version ${body.version} does not exist for this playbook.` });
      definition = stored.definition;
      version = stored.version;
    } else {
      const active = getActivePlaybookVersion(ref);
      if (!active) return res.status(409).json({ error: 'This workflow has no active playbook version to simulate.' });
      definition = active.definition;
      version = active.version;
    }

    res.json(simulatePlaybook({
      businessId, definition, workflowId, version,
      inputs: (body.inputs as Record<string, unknown>) ?? {},
    }));
  } catch (err) { sendPlaybookError(res, err); }
});

// ─── Playbooks: runs (#74) ───────────────────────────────────────────────────

router.post('/:businessId/:workflowId/playbook/runs', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = startPlaybookRun({
      workflowId: String(req.params.workflowId),
      businessId: String(req.params.businessId),
      inputs: (body.inputs as Record<string, unknown>) ?? {},
      actor: actorOf(req),
      trigger_reason: (body.reason as string | null) ?? 'Manual playbook run',
      idempotency_key: (body.idempotency_key as string | null)
        ?? (req.get('Idempotency-Key') || null),
    });
    res.status(result.reused ? 200 : 202).json(result);
  } catch (err) { sendPlaybookError(res, err); }
});

router.get('/:businessId/playbook-runs/:runId', (req: Request, res: Response) => {
  try {
    res.json(describePlaybookRun(String(req.params.runId), String(req.params.businessId)));
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/playbook-runs/:runId/advance', (req: Request, res: Response) => {
  try {
    const status = advancePlaybookRun(String(req.params.runId), String(req.params.businessId), actorOf(req));
    res.json({ status });
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/playbook-runs/:runId/steps/:stepIndex/approve', (req: Request, res: Response) => {
  try {
    const status = approvePlaybookStep({
      runId: String(req.params.runId), businessId: String(req.params.businessId),
      stepIndex: parseInt(String(req.params.stepIndex), 10), actor: actorOf(req),
    });
    res.json({ status });
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/playbook-runs/:runId/steps/:stepIndex/reject', (req: Request, res: Response) => {
  try {
    const status = rejectPlaybookStep({
      runId: String(req.params.runId), businessId: String(req.params.businessId),
      stepIndex: parseInt(String(req.params.stepIndex), 10), actor: actorOf(req),
      reason: ((req.body ?? {}) as Record<string, unknown>).reason as string || 'Rejected by reviewer',
    });
    res.json({ status });
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/playbook-runs/:runId/steps/:stepIndex/retry', (req: Request, res: Response) => {
  try {
    // Deliberately returns 200 with `retried: false` when a retry is
    // refused: "this already executed, so I will not repeat it" is a
    // successful, informative answer, not an error.
    res.json(retryPlaybookStep({
      runId: String(req.params.runId), businessId: String(req.params.businessId),
      stepIndex: parseInt(String(req.params.stepIndex), 10), actor: actorOf(req),
    }));
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/playbook-runs/:runId/rollback', (req: Request, res: Response) => {
  try {
    res.json(compensatePlaybookRun({
      runId: String(req.params.runId), businessId: String(req.params.businessId), actor: actorOf(req),
      reason: ((req.body ?? {}) as Record<string, unknown>).reason as string | null,
    }));
  } catch (err) { sendPlaybookError(res, err); }
});

router.post('/:businessId/playbook-runs/:runId/cancel', (req: Request, res: Response) => {
  try {
    const status = cancelPlaybookRun({
      runId: String(req.params.runId), businessId: String(req.params.businessId), actor: actorOf(req),
      reason: ((req.body ?? {}) as Record<string, unknown>).reason as string | null,
    });
    res.json({ status });
  } catch (err) { sendPlaybookError(res, err); }
});

// ─── List workflows ──────────────────────────────────────────────────────────

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const rows = db.prepare(`
      SELECT w.*,
        (SELECT status FROM workflow_runs WHERE workflow_id=w.id ORDER BY started_at DESC LIMIT 1) AS last_run_status,
        (SELECT id FROM workflow_runs WHERE workflow_id=w.id AND status IN ('running','paused') ORDER BY started_at DESC LIMIT 1) AS active_run_id
      FROM workflows w
      WHERE w.business_id = ? AND w.status != 'archived'
      ORDER BY w.updated_at DESC
    `).all(businessId) as Array<Record<string, unknown>>;
    res.json(rows.map(parseRow));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Create workflow ─────────────────────────────────────────────────────────

router.post('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const {
      name,
      description,
      trigger_type = 'manual',
      trigger_config = {},
      steps = [],
      tags = [],
      status = 'active',
      project_id = null,
    } = (req.body ?? {}) as Record<string, unknown>;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'at least one step is required' });
    }

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO workflows
      (id, business_id, name, description, trigger_type, trigger_config, steps, created_by, tags, status, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?)
    `).run(id, businessId, name as string, (description as string | null | undefined) ?? null, trigger_type as string, JSON.stringify(trigger_config), JSON.stringify(steps), JSON.stringify(tags), status as string, (project_id as string | null | undefined) ?? null);

    res.status(201).json(parseRow(db.prepare('SELECT * FROM workflows WHERE id=?').get(id) as Record<string, unknown> | null));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Get workflow detail ─────────────────────────────────────────────────────

router.get('/:businessId/:workflowId', (req: Request, res: Response) => {
  try {
    const workflowId = String(req.params.workflowId);
    const businessId = String(req.params.businessId);
    const workflow = db.prepare('SELECT * FROM workflows WHERE id=? AND business_id=?').get(workflowId, businessId) as Record<string, unknown> | undefined;
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const runs = (db.prepare(`
      SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC LIMIT 20
    `).all(workflowId) as Array<Record<string, unknown>>).map(parseRun);

    res.json({ workflow: parseRow(workflow), runs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Update workflow ─────────────────────────────────────────────────────────

router.put('/:businessId/:workflowId', (req: Request, res: Response) => {
  try {
    const workflowId = String(req.params.workflowId);
    const businessId = String(req.params.businessId);
    const existing = db.prepare('SELECT * FROM workflows WHERE id=? AND business_id=?').get(workflowId, businessId);
    if (!existing) return res.status(404).json({ error: 'Workflow not found' });

    const { name, description, trigger_type, trigger_config, steps, tags, status, project_id } = (req.body ?? {}) as Record<string, unknown>;
    const updates: string[] = [];
    const values: any[] = [];
    if (name !== undefined)           { updates.push('name=?');           values.push(name); }
    if (description !== undefined)    { updates.push('description=?');    values.push(description); }
    if (trigger_type !== undefined)   { updates.push('trigger_type=?');   values.push(trigger_type); }
    if (trigger_config !== undefined) { updates.push('trigger_config=?'); values.push(JSON.stringify(trigger_config)); }
    if (tags !== undefined)           { updates.push('tags=?');           values.push(JSON.stringify(tags)); }
    if (status !== undefined)         { updates.push('status=?');         values.push(status); }
    if (project_id !== undefined)     { updates.push('project_id=?');     values.push(project_id); }
    if (steps !== undefined) {
      updates.push('steps=?, version=version+1');
      values.push(JSON.stringify(steps));
    }
    updates.push('updated_at=CURRENT_TIMESTAMP');
    values.push(workflowId);
    if (updates.length === 1) return res.status(400).json({ error: 'no fields to update' });
    db.prepare(`UPDATE workflows SET ${updates.join(', ')} WHERE id=?`).run(...values);
    res.json(parseRow(db.prepare('SELECT * FROM workflows WHERE id=?').get(workflowId) as Record<string, unknown> | null));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Archive workflow ────────────────────────────────────────────────────────

router.delete('/:businessId/:workflowId', (req: Request, res: Response) => {
  try {
    const workflowId = String(req.params.workflowId);
    const businessId = String(req.params.businessId);
    db.prepare("UPDATE workflows SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id=? AND business_id=?")
      .run(workflowId, businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Run workflow ────────────────────────────────────────────────────────────

router.post('/:businessId/:workflowId/run', async (req: Request, res: Response) => {
  try {
    const workflowId = String(req.params.workflowId);
    const businessId = String(req.params.businessId);
    const reason = (req.body as Record<string, unknown>)?.reason as string || 'Manual trigger';
    const runId = await (startWorkflow as (...args: unknown[]) => Promise<string>)(workflowId, businessId, 'human', reason);
    res.status(202).json({ ok: true, runId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── List runs ───────────────────────────────────────────────────────────────

router.get('/:businessId/runs/all', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const limit = Math.min(100, parseInt(String(req.query.limit ?? '30'), 10) || 30);
    const rows = db.prepare(`
      SELECT wr.*, w.name as workflow_name
      FROM workflow_runs wr
      JOIN workflows w ON w.id = wr.workflow_id
      WHERE wr.business_id = ?
      ORDER BY wr.started_at DESC LIMIT ?
    `).all(businessId, limit) as Array<Record<string, unknown>>;
    res.json(rows.map(parseRun));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Get run detail ──────────────────────────────────────────────────────────

router.get('/:businessId/runs/:runId', (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const businessId = String(req.params.businessId);
    const run = db.prepare('SELECT * FROM workflow_runs WHERE id=? AND business_id=?').get(runId, businessId) as Record<string, unknown> | undefined;
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const workflow = db.prepare('SELECT * FROM workflows WHERE id=?').get(run.workflow_id as string) as Record<string, unknown> | null;
    const steps = (db.prepare(
      'SELECT * FROM workflow_step_runs WHERE run_id=? ORDER BY step_index ASC'
    ).all(runId) as Array<Record<string, unknown>>).map(parseStepRun);
    res.json({ run: parseRun(run), workflow: parseRow(workflow), steps });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Approve / reject step ───────────────────────────────────────────────────

router.post('/:businessId/runs/:runId/steps/:stepIndex/approve', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const stepIndex = String(req.params.stepIndex);
    const session = req.session as unknown as Record<string, unknown>;
    await approveWorkflowStep(runId, parseInt(stepIndex, 10), (session?.username as string) || 'human');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/runs/:runId/steps/:stepIndex/reject', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const stepIndex = String(req.params.stepIndex);
    const reason = (req.body as Record<string, unknown>)?.reason as string || 'Rejected by user';
    const session = req.session as unknown as Record<string, unknown>;
    await rejectWorkflowStep(runId, parseInt(stepIndex, 10), reason, (session?.username as string) || 'human');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/runs/:runId/cancel', async (req: Request, res: Response) => {
  try {
    await cancelWorkflow(String(req.params.runId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── AI-propose workflow ─────────────────────────────────────────────────────

router.post('/:businessId/propose', async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { trigger } = (req.body ?? {}) as { trigger?: string };
    const { proposeWorkflow } = await import('../workflows/workflow-proposer.js') as unknown as {
      proposeWorkflow: (businessId: string, trigger: string) => Promise<string | null>;
    };
    const workflowId = await proposeWorkflow(businessId, trigger || 'human request');
    if (!workflowId) return res.status(422).json({ error: 'Conductor declined to propose a workflow' });
    const workflow = db.prepare('SELECT * FROM workflows WHERE id=?').get(workflowId) as Record<string, unknown> | null;
    res.json({ workflowId, workflow: parseRow(workflow) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
