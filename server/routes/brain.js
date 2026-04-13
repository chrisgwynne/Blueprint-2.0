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
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { generateTemporalSummary } = await import('../brain/temporal-summary.js');
    const summary = await generateTemporalSummary(businessId);

    // Count seasonal patterns learned
    const seasonalCount = db.prepare(
      'SELECT COUNT(*) as c FROM seasonal_patterns WHERE business_id = ?'
    ).get(businessId)?.c ?? 0;

    // Recent intent extractions — infer from chat_messages where sender_id = 'brain'
    const brainMessages7d = db.prepare(`
      SELECT COUNT(*) as c FROM chat_messages
      WHERE business_id = ? AND sender_id = 'brain' AND created_at > datetime('now', '-7 days')
    `).get(businessId)?.c ?? 0;

    // Deferred tasks
    const deferred = db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE business_id = ? AND status = 'deferred'
    `).get(businessId)?.c ?? 0;

    // Recent restraints — approximate: count of deferred tasks created in last 7 days
    const recentRestraints = db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE business_id = ? AND status = 'deferred' AND created_at > datetime('now', '-7 days')
    `).get(businessId)?.c ?? 0;

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
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/action-windows', (_req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM action_windows ORDER BY expected_days ASC').all();
    res.json(rows.map((r) => ({ ...r, metric_types: JSON.parse(r.metric_types || '[]') })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/in-flight', (req, res) => {
  try {
    const { businessId } = req.params;
    const rows = db.prepare(`
      SELECT am.*, aw.display_name, aw.expected_days, aw.measurement_notes, aw.volatility
      FROM action_memory am
      LEFT JOIN action_windows aw ON aw.action_type = am.action_type
      WHERE am.business_id = ? AND am.outcome_measured = 0
      ORDER BY am.measurement_window_start DESC
    `).all(businessId);
    res.json(rows.map((r) => ({ ...r, metrics_expected: JSON.parse(r.metrics_expected || '[]') })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/tasks/:id/override', (req, res) => {
  try {
    const { id, businessId } = req.params;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND business_id = ?').get(id, businessId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'deferred') return res.status(400).json({ error: 'Task is not deferred' });

    db.prepare(`
      UPDATE tasks
      SET status = 'proposed', deferred_until = NULL, deferred_reason = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    // Audit the override
    const { audit } = db;
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (lower(hex(randomblob(16))), ?, 'task', ?, 'brain_override', ?, ?, CURRENT_TIMESTAMP)
    `).run(
      businessId, id,
      req.session?.username || 'human',
      JSON.stringify({ previous_deferred_reason: task.deferred_reason })
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
