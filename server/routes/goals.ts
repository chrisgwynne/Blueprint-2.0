/**
 * Goals API (Prompt 2).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function safeParse(v: unknown, fb: unknown): unknown {
  if (v == null) return fb;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fb; }
}
function parseRow(r: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!r) return null;
  return {
    ...r,
    assigned_agents: safeParse(r.assigned_agents, []),
    milestones: safeParse(r.milestones, []),
    notes: safeParse(r.notes, []),
    tags: safeParse(r.tags, []),
  };
}

// List goals
router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = req.params.businessId as string;
    const rows = db.prepare(`
      SELECT * FROM goals
      WHERE business_id = ? AND status != 'cancelled'
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
        deadline ASC
    `).all(businessId) as Record<string, unknown>[];
    res.json(rows.map(parseRow));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create goal
router.post('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = req.params.businessId as string;
    const {
      title, description, deadline,
      metric_name, metric_target, metric_unit,
      assigned_agents = [], strategy, milestones = [], tags = [],
      project_id = null, metric_baseline: providedBaseline,
    } = req.body ?? {};
    if (!title) return res.status(400).json({ error: 'title is required' });

    // Auto-fill baseline from latest metric if metric_name set and not provided
    let baseline = providedBaseline;
    if (metric_name && baseline == null) {
      const latest = db.prepare(`
        SELECT metric_value FROM metrics
        WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
        ORDER BY recorded_at DESC LIMIT 1
      `).get(businessId, metric_name) as Record<string, unknown> | undefined;
      baseline = latest?.metric_value ?? null;
    }

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO goals
      (id, business_id, title, description, deadline, metric_name,
       metric_baseline, metric_target, metric_current, metric_unit,
       assigned_agents, strategy, milestones, tags, project_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')
    `).run(
      id, businessId, title, description ?? null, deadline ?? null,
      metric_name ?? null, baseline, metric_target ?? null, baseline,
      metric_unit ?? null,
      JSON.stringify(assigned_agents), strategy ?? null,
      JSON.stringify(milestones), JSON.stringify(tags), project_id
    );

    // Brain — fire-and-forget strategic reasoning pass
    (async () => {
      try {
        const { runGoalReasoning } = await import('../brain/goal-reasoner.js') as unknown as { runGoalReasoning: (id: string, businessId: string) => Promise<any> };
        await runGoalReasoning(id, businessId);
      } catch (err: any) {
        console.warn('[Goals] Reasoning failed:', err.message);
      }
    })();

    // Brain — fire-and-forget conflict check against other active goals
    (async () => {
      try {
        const { checkGoalConflicts } = await import('../brain/conflict-engine.js') as unknown as { checkGoalConflicts: (id: string, businessId: string) => Promise<any> };
        await checkGoalConflicts(id, businessId);
      } catch (err: any) {
        console.warn('[Goals] Conflict check failed:', err.message);
      }
    })();

    res.status(201).json(parseRow(db.prepare('SELECT * FROM goals WHERE id=?').get(id) as Record<string, unknown> | null));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get goal detail
router.get('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const businessId = req.params.businessId as string;
    const goal = db.prepare('SELECT * FROM goals WHERE id=? AND business_id=?').get(id, businessId) as Record<string, unknown> | undefined;
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const checks = db.prepare(
      'SELECT * FROM goal_checks WHERE goal_id=? ORDER BY checked_at DESC LIMIT 50'
    ).all(id);
    res.json({ goal: parseRow(goal), checks });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update goal
router.put('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const businessId = req.params.businessId as string;
    const allowed = ['title', 'description', 'status', 'deadline', 'metric_name',
      'metric_baseline', 'metric_target', 'metric_unit', 'strategy', 'project_id'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key}=?`);
        values.push(req.body[key]);
      }
    }
    for (const key of ['assigned_agents', 'milestones', 'notes', 'tags']) {
      if (req.body[key] !== undefined) {
        updates.push(`${key}=?`);
        values.push(JSON.stringify(req.body[key]));
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
    updates.push('updated_at=CURRENT_TIMESTAMP');
    values.push(id, businessId);
    db.prepare(`UPDATE goals SET ${updates.join(', ')} WHERE id=? AND business_id=?`).run(...values);
    res.json(parseRow(db.prepare('SELECT * FROM goals WHERE id=?').get(id) as Record<string, unknown> | null));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel goal
router.delete('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const businessId = req.params.businessId as string;
    db.prepare("UPDATE goals SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND business_id=?")
      .run(id, businessId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Manual check
router.post('/:businessId/:id/check', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { checkGoalById } = await import('../goals/goal-engine.js') as unknown as { checkGoalById: (id: string) => Promise<any> };
    const result = await checkGoalById(id);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Re-run strategic reasoning pass
router.post('/:businessId/:id/reason', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const businessId = req.params.businessId as string;
    const goal = db.prepare('SELECT id FROM goals WHERE id=? AND business_id=?').get(id, businessId);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const { runGoalReasoning } = await import('../brain/goal-reasoner.js') as unknown as { runGoalReasoning: (id: string, businessId: string) => Promise<any> };
    const result = await runGoalReasoning(id, businessId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// AI-propose goal
router.post('/:businessId/propose', async (req: Request, res: Response) => {
  try {
    const businessId = req.params.businessId as string;
    const { context = 'human request' } = req.body ?? {};
    const { proposeGoal } = await import('../goals/goal-proposer.js') as unknown as { proposeGoal: (businessId: string, context: string) => Promise<any> };
    const proposed = await proposeGoal(businessId, context);
    if (!proposed) return res.status(422).json({ error: 'Conductor declined to propose' });
    res.json({ proposed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
