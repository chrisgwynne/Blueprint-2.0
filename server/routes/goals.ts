/**
 * Goals API (Prompt 2).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { buildGoalTimeline } from '../goals/goal-timeline.js';

const router = Router();
router.use(isAuthenticated);

function safeParse(v: unknown, fb: unknown): unknown {
  if (v == null) return fb;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fb; }
}

/**
 * Phase 3 — real milestones (goal_milestones) merged with any legacy
 * free-form goals.milestones JSON, same fallback approach as
 * bap-goals.ts's loadMilestones().
 */
function loadMilestones(goalId: string, legacyJson: unknown): Record<string, unknown>[] {
  const real = db.prepare(
    'SELECT id, title, target_pct, notes, status, achieved_at, source, created_at FROM goal_milestones WHERE goal_id = ? ORDER BY created_at ASC'
  ).all(goalId) as Record<string, unknown>[];
  const realTitles = new Set(real.map((m) => m.title));
  const legacy = (safeParse(legacyJson, []) as Record<string, unknown>[]).filter((m) => m?.title && !realTitles.has(m.title));
  return [...real, ...legacy.map((m) => ({ ...m, id: null, source: 'legacy_json', status: m.status ?? 'pending' }))];
}

function loadDependencies(goalId: string): Record<string, unknown>[] {
  return db.prepare(`
    SELECT gd.depends_on_goal_id AS goal_id, gd.note, g.title, g.status, g.progress_pct
    FROM goal_dependencies gd JOIN goals g ON g.id = gd.depends_on_goal_id
    WHERE gd.goal_id = ?
  `).all(goalId) as Record<string, unknown>[];
}

/** Replace a goal's full dependency set, silently dropping IDs that aren't real goals in this business. */
function setDependencies(goalId: string, businessId: string, dependsOn: unknown): void {
  if (!Array.isArray(dependsOn)) return;
  const validIds = (dependsOn as unknown[])
    .filter((id): id is string => typeof id === 'string' && id !== goalId)
    .filter((id) => db.prepare('SELECT 1 FROM goals WHERE id = ? AND business_id = ?').get(id, businessId));
  db.prepare('DELETE FROM goal_dependencies WHERE goal_id = ?').run(goalId);
  for (const dep of validIds) {
    db.prepare(`
      INSERT INTO goal_dependencies (id, goal_id, depends_on_goal_id, business_id, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(goal_id, depends_on_goal_id) DO NOTHING
    `).run(crypto.randomUUID(), goalId, dep, businessId);
  }
}

function parseRow(r: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!r) return null;
  const { milestones: _legacyMilestones, ...rest } = r;
  return {
    ...rest,
    assigned_agents: safeParse(r.assigned_agents, []),
    milestones: loadMilestones(r.id as string, r.milestones),
    dependencies: loadDependencies(r.id as string),
    notes: safeParse(r.notes, []),
    tags: safeParse(r.tags, []),
  };
}

function parseAssessmentRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    assumptions: safeParse(row.assumptions, []),
    risks: safeParse(row.risks, []),
    dependencies: safeParse(row.dependencies, []),
    gap_analysis: safeParse(row.gap_analysis, null),
    measurement_plan: safeParse(row.measurement_plan, null),
    success_criteria: safeParse(row.success_criteria, []),
  };
}

function parseStrategyRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    evidence: safeParse(row.evidence, []),
    depends_on: safeParse(row.depends_on, []),
    is_recommended: Boolean(row.is_recommended),
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
      owner = null, confidence = null, priority = 'p2', depends_on,
    } = req.body ?? {};
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (priority !== undefined && !['p1', 'p2', 'p3'].includes(String(priority))) {
      return res.status(400).json({ error: 'priority must be one of: p1, p2, p3' });
    }
    if (confidence !== undefined && confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
      return res.status(400).json({ error: 'confidence must be a number between 0 and 1' });
    }

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
       assigned_agents, strategy, milestones, tags, project_id, created_by,
       owner, confidence, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?)
    `).run(
      id, businessId, title, description ?? null, deadline ?? null,
      metric_name ?? null, baseline, metric_target ?? null, baseline,
      metric_unit ?? null,
      JSON.stringify(assigned_agents), strategy ?? null,
      JSON.stringify(milestones), JSON.stringify(tags), project_id,
      owner, typeof confidence === 'number' ? confidence : null, priority ?? 'p2',
    );

    if (depends_on) setDependencies(id, businessId, depends_on);

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

    const created = parseRow(db.prepare('SELECT * FROM goals WHERE id=?').get(id) as Record<string, unknown> | null);
    import('../bap/webhook-dispatcher.js').then((m: any) =>
      m.dispatchWebhookEvent('goal.created', { goal_id: id, business_id: businessId, title, priority })
    ).catch(() => {});
    res.status(201).json(created);
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
    const latestAssessment = db.prepare(
      'SELECT * FROM goal_assessments WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(id) as Record<string, unknown> | undefined;
    const strategyCount = (db.prepare('SELECT COUNT(*) AS n FROM goal_strategies WHERE goal_id = ?').get(id) as { n: number }).n;
    const conflicts = db.prepare(
      "SELECT id, conflict_type, severity, entity_a_type, entity_a_id, entity_b_type, entity_b_id, description, status, detected_at FROM conflicts WHERE business_id = ? AND status = 'open' AND ((entity_a_type = 'goal' AND entity_a_id = ?) OR (entity_b_type = 'goal' AND entity_b_id = ?))"
    ).all(businessId, id, id) as Record<string, unknown>[];
    res.json({
      goal: parseRow(goal),
      checks,
      conflicts,
      strategic_planning: {
        latest_assessment: latestAssessment ? parseAssessmentRow(latestAssessment) : null,
        strategy_count: strategyCount,
      },
    });
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
      'metric_baseline', 'metric_target', 'metric_unit', 'strategy', 'project_id',
      'owner', 'confidence', 'priority'];
    if (req.body.priority !== undefined && !['p1', 'p2', 'p3'].includes(String(req.body.priority))) {
      return res.status(400).json({ error: 'priority must be one of: p1, p2, p3' });
    }
    if (req.body.confidence !== undefined && req.body.confidence !== null && (typeof req.body.confidence !== 'number' || req.body.confidence < 0 || req.body.confidence > 1)) {
      return res.status(400).json({ error: 'confidence must be a number between 0 and 1' });
    }
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
    if (req.body.depends_on !== undefined) setDependencies(id, businessId, req.body.depends_on);
    if (updates.length === 0 && req.body.depends_on === undefined) return res.status(400).json({ error: 'no fields to update' });
    if (updates.length === 0) {
      return res.json(parseRow(db.prepare('SELECT * FROM goals WHERE id=?').get(id) as Record<string, unknown> | null));
    }
    updates.push('updated_at=CURRENT_TIMESTAMP');
    values.push(id, businessId);
    db.prepare(`UPDATE goals SET ${updates.join(', ')} WHERE id=? AND business_id=?`).run(...values);
    const updated = parseRow(db.prepare('SELECT * FROM goals WHERE id=?').get(id) as Record<string, unknown> | null);
    import('../bap/webhook-dispatcher.js').then((m: any) =>
      m.dispatchWebhookEvent('goal.updated', { goal_id: id, business_id: businessId, status: (updated as any)?.status, title: (updated as any)?.title })
    ).catch(() => {});
    res.json(updated);
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

// ─── Phase 3: strategic assessment + candidate strategies + timeline ──────

router.get('/:businessId/:id/assessment', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const businessId = String(req.params.businessId);
    const goal = db.prepare('SELECT id FROM goals WHERE id=? AND business_id=?').get(id, businessId);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const latest = db.prepare('SELECT * FROM goal_assessments WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as Record<string, unknown> | undefined;
    if (!latest) return res.status(404).json({ error: `No strategic assessment exists yet for this goal — trigger one with POST /:businessId/${id}/reason.` });
    res.json({ assessment: parseAssessmentRow(latest) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/:id/assessments', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const businessId = String(req.params.businessId);
    const goal = db.prepare('SELECT id FROM goals WHERE id=? AND business_id=?').get(id, businessId);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const rows = db.prepare('SELECT * FROM goal_assessments WHERE goal_id = ? ORDER BY created_at DESC').all(id) as Record<string, unknown>[];
    res.json({ assessments: rows.map(parseAssessmentRow), total: rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/:id/strategies', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const businessId = String(req.params.businessId);
    const goal = db.prepare('SELECT id FROM goals WHERE id=? AND business_id=?').get(id, businessId);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const rows = db.prepare(
      'SELECT * FROM goal_strategies WHERE goal_id = ? ORDER BY is_recommended DESC, confidence DESC NULLS LAST, created_at DESC'
    ).all(id) as Record<string, unknown>[];
    res.json({ strategies: rows.map(parseStrategyRow), total: rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/:id/timeline', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const businessId = String(req.params.businessId);
    const timeline = buildGoalTimeline(id, businessId);
    if (!timeline) return res.status(404).json({ error: 'Goal not found' });
    res.json(timeline);
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
