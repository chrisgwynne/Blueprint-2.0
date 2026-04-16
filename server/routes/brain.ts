/**
 * Brain API.
 *
 * Exposes:
 *   GET /api/brain/:businessId                 — current brain status + summary
 *   GET /api/brain/:businessId/action-windows  — knowledge base of action windows
 *   GET /api/brain/:businessId/in-flight       — actions currently in windows
 *   POST /api/brain/:businessId/check          — trigger causal + seasonal check
 *   POST /api/brain/:businessId/tasks/:id/override — force a deferred task through
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', async (req: Request, res: Response) => {
  try {
    const businessId = req.params['businessId'] as string;
    const { generateTemporalSummary } = await import('../brain/temporal-summary.js') as unknown as {
      generateTemporalSummary: (businessId: string) => Promise<{
        in_flight: unknown[];
        ready_for_measurement: unknown[];
        still_waiting: unknown;
        summary: unknown;
      }>;
    };
    const summary = await generateTemporalSummary(businessId);

    // Count seasonal patterns learned
    const seasonalCount = (db.prepare(
      'SELECT COUNT(*) as c FROM seasonal_patterns WHERE business_id = ?'
    ).get(businessId) as any)?.c ?? 0;

    // Recent intent extractions — infer from chat_messages where sender_id = 'brain'
    const brainMessages7d = (db.prepare(`
      SELECT COUNT(*) as c FROM chat_messages
      WHERE business_id = ? AND sender_id = 'brain' AND created_at > datetime('now', '-7 days')
    `).get(businessId) as any)?.c ?? 0;

    // Deferred tasks
    const deferred = (db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE business_id = ? AND status = 'deferred'
    `).get(businessId) as any)?.c ?? 0;

    // Recent restraints — approximate: count of deferred tasks created in last 7 days
    const recentRestraints = (db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE business_id = ? AND status = 'deferred' AND created_at > datetime('now', '-7 days')
    `).get(businessId) as any)?.c ?? 0;

    res.json({
      in_flight_count: summary.in_flight.length,
      ready_for_measurement: summary.ready_for_measurement.length,
      still_waiting: summary.still_waiting,
      summary: summary.summary,
      seasonal_patterns: seasonalCount,
      brain_messages_7d: brainMessages7d,
      deferred_tasks: deferred,
      recent_restraints_7d: recentRestraints,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/action-windows', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare('SELECT * FROM action_windows ORDER BY expected_days ASC').all() as Record<string, unknown>[];
    res.json(rows.map((r) => ({ ...r, metric_types: JSON.parse((r['metric_types'] as string) || '[]') })));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/in-flight', (req: Request, res: Response) => {
  try {
    const businessId = req.params['businessId'] as string;
    const rows = db.prepare(`
      SELECT am.*, aw.display_name, aw.expected_days, aw.measurement_notes, aw.volatility
      FROM action_memory am
      LEFT JOIN action_windows aw ON aw.action_type = am.action_type
      WHERE am.business_id = ? AND am.outcome_measured = 0
      ORDER BY am.measurement_window_start DESC
    `).all(businessId) as Record<string, unknown>[];
    res.json(rows.map((r) => ({ ...r, metrics_expected: JSON.parse((r['metrics_expected'] as string) || '[]') })));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/tasks/:id/override', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const businessId = req.params['businessId'] as string;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND business_id = ?').get(id, businessId) as any;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'deferred') return res.status(400).json({ error: 'Task is not deferred' });

    db.prepare(`
      UPDATE tasks
      SET status = 'proposed', deferred_until = NULL, deferred_reason = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    // Audit the override
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (lower(hex(randomblob(16))), ?, 'task', ?, 'brain_override', ?, ?, CURRENT_TIMESTAMP)
    `).run(
      businessId, id,
      (req.session as any)?.username || 'human',
      JSON.stringify({ previous_deferred_reason: task.deferred_reason })
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Shared KB stats (Feature 7) — global, not business-scoped
router.get('/_shared/stats', async (_req: Request, res: Response) => {
  try {
    const { getSharedKBStats } = await import('../kb/shared-kb.js') as unknown as {
      getSharedKBStats: () => Promise<unknown>;
    };
    res.json(await getSharedKBStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
