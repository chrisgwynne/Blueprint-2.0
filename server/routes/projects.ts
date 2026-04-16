/**
 * Projects API (Prompt 3).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function safeParse(v: unknown, fb: any): any {
  if (v == null) return fb;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fb; }
}
function parseRow(r: Record<string, unknown> | null): any | null {
  if (!r) return null;
  return {
    ...r,
    assigned_agents: safeParse(r.assigned_agents, []),
    goals: safeParse(r.goals, []),
    tags: safeParse(r.tags, []),
  };
}

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const rows = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM signals WHERE project_id = p.id) AS signal_count,
        (SELECT COUNT(*) FROM workflows WHERE project_id = p.id) AS workflow_count,
        (SELECT COUNT(*) FROM goals WHERE project_id = p.id) AS goal_count
      FROM projects p
      WHERE p.business_id = ? AND p.status != 'archived'
      ORDER BY p.updated_at DESC
    `).all(businessId) as Record<string, unknown>[];

    res.json(rows.map(parseRow));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
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
    res.status(201).json(parseRow(db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Record<string, unknown> | null));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const businessId = String(req.params.businessId);
    const project = db.prepare('SELECT * FROM projects WHERE id=? AND business_id=?').get(id, businessId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks     = db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 50').all(id);
    const signals   = db.prepare('SELECT * FROM signals WHERE project_id=? ORDER BY created_at DESC LIMIT 50').all(id);
    const workflows = db.prepare('SELECT * FROM workflows WHERE project_id=? ORDER BY updated_at DESC').all(id);
    const goals     = db.prepare('SELECT * FROM goals WHERE project_id=? ORDER BY deadline ASC').all(id);

    res.json({
      project: parseRow(project as Record<string, unknown>),
      tasks, signals, workflows, goals,
      counts: { tasks: tasks.length, signals: signals.length, workflows: workflows.length, goals: goals.length },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const businessId = String(req.params.businessId);
    const allowed = ['name', 'description', 'status', 'color', 'icon', 'start_date', 'target_date'];
    const updates: string[] = [];
    const values: any[] = [];
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
    res.json(parseRow(db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Record<string, unknown> | null));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const businessId = String(req.params.businessId);
    db.prepare("UPDATE projects SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id=? AND business_id=?")
      .run(id, businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Link an existing task/signal/workflow/goal to a project
router.post('/:businessId/:id/link', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { type, id: entityId } = req.body ?? {};
    const allowedTables: Record<string, string> = { task: 'tasks', signal: 'signals', workflow: 'workflows', goal: 'goals' };
    const table = allowedTables[type];
    if (!table || !entityId) return res.status(400).json({ error: 'invalid type or id' });
    db.prepare(`UPDATE ${table} SET project_id=? WHERE id=?`).run(id, entityId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/propose', async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { context = '' } = req.body ?? {};
    const { proposeProject } = await import('../workflows/project-proposer.js') as unknown as { proposeProject: (businessId: string, context: string) => Promise<any> };
    const proposed = await proposeProject(businessId, context);
    if (!proposed) return res.status(422).json({ error: 'Conductor declined' });
    res.json({ proposed });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
