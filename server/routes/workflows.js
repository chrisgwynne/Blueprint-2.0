/**
 * Workflows API (Prompt 1).
 */
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  startWorkflow, approveWorkflowStep, rejectWorkflowStep, cancelWorkflow,
} from '../workflows/workflow-engine.js';

const router = Router();
router.use(isAuthenticated);

function parseRow(r) {
  if (!r) return null;
  return {
    ...r,
    trigger_config: safeParse(r.trigger_config, {}),
    steps: safeParse(r.steps, []),
    tags: safeParse(r.tags, []),
  };
}
function parseRun(r) {
  if (!r) return null;
  return { ...r, context: safeParse(r.context, {}) };
}
function parseStepRun(r) {
  if (!r) return null;
  return { ...r, tasks_created: safeParse(r.tasks_created, []) };
}
function safeParse(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ─── List workflows ──────────────────────────────────────────────────────────

router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const rows = db.prepare(`
      SELECT w.*,
        (SELECT status FROM workflow_runs WHERE workflow_id=w.id ORDER BY started_at DESC LIMIT 1) AS last_run_status,
        (SELECT id FROM workflow_runs WHERE workflow_id=w.id AND status IN ('running','paused') ORDER BY started_at DESC LIMIT 1) AS active_run_id
      FROM workflows w
      WHERE w.business_id = ? AND w.status != 'archived'
      ORDER BY w.updated_at DESC
    `).all(businessId);
    res.json(rows.map(parseRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create workflow ─────────────────────────────────────────────────────────

router.post('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const { name, description, trigger_type = 'manual', trigger_config = {}, steps = [], tags = [], status = 'active', project_id = null } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'at least one step is required' });
    }

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO workflows
      (id, business_id, name, description, trigger_type, trigger_config, steps, created_by, tags, status, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?)
    `).run(id, businessId, name, description ?? null, trigger_type, JSON.stringify(trigger_config), JSON.stringify(steps), JSON.stringify(tags), status, project_id);

    res.status(201).json(parseRow(db.prepare('SELECT * FROM workflows WHERE id=?').get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get workflow detail ─────────────────────────────────────────────────────

router.get('/:businessId/:workflowId', (req, res) => {
  try {
    const { businessId, workflowId } = req.params;
    const workflow = db.prepare('SELECT * FROM workflows WHERE id=? AND business_id=?').get(workflowId, businessId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const runs = db.prepare(`
      SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC LIMIT 20
    `).all(workflowId).map(parseRun);

    res.json({ workflow: parseRow(workflow), runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update workflow ─────────────────────────────────────────────────────────

router.put('/:businessId/:workflowId', (req, res) => {
  try {
    const { businessId, workflowId } = req.params;
    const existing = db.prepare('SELECT * FROM workflows WHERE id=? AND business_id=?').get(workflowId, businessId);
    if (!existing) return res.status(404).json({ error: 'Workflow not found' });

    const { name, description, trigger_type, trigger_config, steps, tags, status, project_id } = req.body ?? {};
    const updates = [];
    const values = [];
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
    res.json(parseRow(db.prepare('SELECT * FROM workflows WHERE id=?').get(workflowId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Archive workflow ────────────────────────────────────────────────────────

router.delete('/:businessId/:workflowId', (req, res) => {
  try {
    const { businessId, workflowId } = req.params;
    db.prepare("UPDATE workflows SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id=? AND business_id=?")
      .run(workflowId, businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Run workflow ────────────────────────────────────────────────────────────

router.post('/:businessId/:workflowId/run', async (req, res) => {
  try {
    const { businessId, workflowId } = req.params;
    const reason = req.body?.reason || 'Manual trigger';
    const runId = await startWorkflow(workflowId, businessId, 'human', reason);
    res.status(202).json({ ok: true, runId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── List runs ───────────────────────────────────────────────────────────────

router.get('/:businessId/runs/all', (req, res) => {
  try {
    const { businessId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 30);
    const rows = db.prepare(`
      SELECT wr.*, w.name as workflow_name
      FROM workflow_runs wr
      JOIN workflows w ON w.id = wr.workflow_id
      WHERE wr.business_id = ?
      ORDER BY wr.started_at DESC LIMIT ?
    `).all(businessId, limit);
    res.json(rows.map(parseRun));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get run detail ──────────────────────────────────────────────────────────

router.get('/:businessId/runs/:runId', (req, res) => {
  try {
    const { businessId, runId } = req.params;
    const run = db.prepare('SELECT * FROM workflow_runs WHERE id=? AND business_id=?').get(runId, businessId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const workflow = db.prepare('SELECT * FROM workflows WHERE id=?').get(run.workflow_id);
    const steps = db.prepare(
      'SELECT * FROM workflow_step_runs WHERE run_id=? ORDER BY step_index ASC'
    ).all(runId).map(parseStepRun);
    res.json({ run: parseRun(run), workflow: parseRow(workflow), steps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Approve / reject step ───────────────────────────────────────────────────

router.post('/:businessId/runs/:runId/steps/:stepIndex/approve', async (req, res) => {
  try {
    const { runId, stepIndex } = req.params;
    await approveWorkflowStep(runId, parseInt(stepIndex, 10), req.session?.username || 'human');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/runs/:runId/steps/:stepIndex/reject', async (req, res) => {
  try {
    const { runId, stepIndex } = req.params;
    const reason = req.body?.reason || 'Rejected by user';
    await rejectWorkflowStep(runId, parseInt(stepIndex, 10), reason, req.session?.username || 'human');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/runs/:runId/cancel', async (req, res) => {
  try {
    await cancelWorkflow(req.params.runId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AI-propose workflow ─────────────────────────────────────────────────────

router.post('/:businessId/propose', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { trigger } = req.body ?? {};
    const { proposeWorkflow } = await import('../workflows/workflow-proposer.js');
    const workflowId = await proposeWorkflow(businessId, trigger || 'human request');
    if (!workflowId) return res.status(422).json({ error: 'Conductor declined to propose a workflow' });
    const workflow = db.prepare('SELECT * FROM workflows WHERE id=?').get(workflowId);
    res.json({ workflowId, workflow: parseRow(workflow) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
