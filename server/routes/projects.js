/**
 * Projects API (Prompt 3).
 */
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function safeParse(v, fb) {
  if (v == null) return fb;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fb; }
}
function parseRow(r) {
  if (!r) return null;
  return {
    ...r,
    assigned_agents: safeParse(r.assigned_agents, []),
    goals: safeParse(r.goals, []),
    tags: safeParse(r.tags, []),
  };
}

router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const rows = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM signals WHERE project_id = p.id) AS signal_count,
        (SELECT COUNT(*) FROM workflows WHERE project_id = p.id) AS workflow_count,
        (SELECT COUNT(*) FROM goals WHERE project_id = p.id) AS goal_count
      FROM projects p
      WHERE p.business_id = ? AND p.status != 'archived'
      ORDER BY p.updated_at DESC
    `).all(businessId);

    res.json(rows.map(parseRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const {
      name, description, color = '#3b82f6', icon = '📁',
      assigned_agents = [], goals = [], tags = [],
      start_date, target_date,
    } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO projects
      (id, business_id, name, description, color, icon, assigned_agents,
       goals, tags, start_date, target_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')
    `).run(
      id, businessId, name, description ?? null, color, icon,
      JSON.stringify(assigned_agents), JSON.stringify(goals),
      JSON.stringify(tags), start_date ?? null, target_date ?? null
    );
    res.status(201).json(parseRow(db.prepare('SELECT * FROM projects WHERE id=?').get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/:id', (req, res) => {
  try {
    const { id, businessId } = req.params;
    const project = db.prepare('SELECT * FROM projects WHERE id=? AND business_id=?').get(id, businessId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks     = db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 50').all(id);
    const signals   = db.prepare('SELECT * FROM signals WHERE project_id=? ORDER BY created_at DESC LIMIT 50').all(id);
    const workflows = db.prepare('SELECT * FROM workflows WHERE project_id=? ORDER BY updated_at DESC').all(id);
    const goals     = db.prepare('SELECT * FROM goals WHERE project_id=? ORDER BY deadline ASC').all(id);

    res.json({
      project: parseRow(project),
      tasks, signals, workflows, goals,
      counts: { tasks: tasks.length, signals: signals.length, workflows: workflows.length, goals: goals.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:businessId/:id', (req, res) => {
  try {
    const { id, businessId } = req.params;
    const allowed = ['name', 'description', 'status', 'color', 'icon', 'start_date', 'target_date'];
    const updates = [];
    const values = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { updates.push(`${k}=?`); values.push(req.body[k]); }
    }
    for (const k of ['assigned_agents', 'goals', 'tags']) {
      if (req.body[k] !== undefined) { updates.push(`${k}=?`); values.push(JSON.stringify(req.body[k])); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
    updates.push('updated_at=CURRENT_TIMESTAMP');
    values.push(id, businessId);
    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id=? AND business_id=?`).run(...values);
    res.json(parseRow(db.prepare('SELECT * FROM projects WHERE id=?').get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:businessId/:id', (req, res) => {
  try {
    const { id, businessId } = req.params;
    db.prepare("UPDATE projects SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id=? AND business_id=?")
      .run(id, businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Link an existing task/signal/workflow/goal to a project
router.post('/:businessId/:id/link', (req, res) => {
  try {
    const { id } = req.params;
    const { type, id: entityId } = req.body ?? {};
    const allowedTables = { task: 'tasks', signal: 'signals', workflow: 'workflows', goal: 'goals' };
    const table = allowedTables[type];
    if (!table || !entityId) return res.status(400).json({ error: 'invalid type or id' });
    db.prepare(`UPDATE ${table} SET project_id=? WHERE id=?`).run(id, entityId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/propose', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { context = '' } = req.body ?? {};
    const { proposeProject } = await import('../workflows/project-proposer.js');
    const proposed = await proposeProject(businessId, context);
    if (!proposed) return res.status(422).json({ error: 'Conductor declined' });
    res.json({ proposed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
