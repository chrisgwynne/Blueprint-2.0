/**
 * Goals API (Prompt 2).
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
    milestones: safeParse(r.milestones, []),
    notes: safeParse(r.notes, []),
    tags: safeParse(r.tags, []),
  };
}

// List goals
router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const rows = db.prepare(`
      SELECT * FROM goals
      WHERE business_id = ? AND status != 'cancelled'
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
        deadline ASC
    `).all(businessId);
    res.json(rows.map(parseRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create goal
router.post('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
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
      `).get(businessId, metric_name);
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
        const { runGoalReasoning } = await import('../brain/goal-reasoner.js');
        await runGoalReasoning(id, businessId);
      } catch (err) {
        console.warn('[Goals] Reasoning failed:', err.message);
      }
    })();

    res.status(201).json(parseRow(db.prepare('SELECT * FROM goals WHERE id=?').get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get goal detail
router.get('/:businessId/:id', (req, res) => {
  try {
    const { id, businessId } = req.params;
    const goal = db.prepare('SELECT * FROM goals WHERE id=? AND business_id=?').get(id, businessId);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const checks = db.prepare(
      'SELECT * FROM goal_checks WHERE goal_id=? ORDER BY checked_at DESC LIMIT 50'
    ).all(id);
    res.json({ goal: parseRow(goal), checks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update goal
router.put('/:businessId/:id', (req, res) => {
  try {
    const { id, businessId } = req.params;
    const allowed = ['title', 'description', 'status', 'deadline', 'metric_name',
      'metric_baseline', 'metric_target', 'metric_unit', 'strategy', 'project_id'];
    const updates = [];
    const values = [];
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
    res.json(parseRow(db.prepare('SELECT * FROM goals WHERE id=?').get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel goal
router.delete('/:businessId/:id', (req, res) => {
  try {
    const { id, businessId } = req.params;
    db.prepare("UPDATE goals SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND business_id=?")
      .run(id, businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual check
router.post('/:businessId/:id/check', async (req, res) => {
  try {
    const { id } = req.params;
    const { checkGoalById } = await import('../goals/goal-engine.js');
    const result = await checkGoalById(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-run strategic reasoning pass
router.post('/:businessId/:id/reason', async (req, res) => {
  try {
    const { id, businessId } = req.params;
    const goal = db.prepare('SELECT id FROM goals WHERE id=? AND business_id=?').get(id, businessId);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const { runGoalReasoning } = await import('../brain/goal-reasoner.js');
    const result = await runGoalReasoning(id, businessId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI-propose goal
router.post('/:businessId/propose', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { context = 'human request' } = req.body ?? {};
    const { proposeGoal } = await import('../goals/goal-proposer.js');
    const proposed = await proposeGoal(businessId, context);
    if (!proposed) return res.status(422).json({ error: 'Conductor declined to propose' });
    res.json({ proposed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
