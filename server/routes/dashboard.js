import { Router } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function parseJsonField(val) {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

/**
 * GET /api/dashboard/:businessId
 */
router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;

    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    // --- Metrics ---
    // sessions_7d from ga4 metrics
    const sessions7d = db.prepare(`
      SELECT metric_value, metric_data FROM metrics
      WHERE business_id = ? AND metric_name = 'sessions_7d'
      ORDER BY recorded_at DESC LIMIT 2
    `).all(businessId);

    const organicKeywords = db.prepare(`
      SELECT metric_value, metric_data FROM metrics
      WHERE business_id = ? AND metric_name = 'organic_keywords'
      ORDER BY recorded_at DESC LIMIT 2
    `).all(businessId);

    const pagespeedScore = db.prepare(`
      SELECT metric_value, metric_data FROM metrics
      WHERE business_id = ? AND metric_name = 'pagespeed_score'
      ORDER BY recorded_at DESC LIMIT 2
    `).all(businessId);

    function metricSummary(rows) {
      const current = rows[0]?.metric_value ?? 0;
      const prev = rows[1]?.metric_value ?? 0;
      const trend = prev !== 0 ? Math.round(((current - prev) / prev) * 100) : 0;
      return { value: current, prev, trend };
    }

    const openSignalsCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM signals
      WHERE business_id = ? AND status = 'open'
    `).get(businessId)?.cnt ?? 0;

    const pendingTasksCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE business_id = ? AND status IN ('proposed', 'approved')
    `).get(businessId)?.cnt ?? 0;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const agentRunsToday = db.prepare(`
      SELECT COUNT(*) as cnt FROM agent_runs
      WHERE business_id = ? AND started_at >= ?
    `).get(businessId, todayStart.toISOString())?.cnt ?? 0;

    // --- Signals (last 20 open) ---
    const signals = db.prepare(`
      SELECT s.*, c.type as connector_type, c.name as connector_name
      FROM signals s
      LEFT JOIN connectors c ON c.id = s.connector_id
      WHERE s.business_id = ? AND s.status = 'open'
      ORDER BY s.created_at DESC LIMIT 20
    `).all(businessId).map(s => ({
      ...s,
      data: parseJsonField(s.data),
    }));

    // --- Tasks (last 5) ---
    const tasks = db.prepare(`
      SELECT * FROM tasks
      WHERE business_id = ?
      ORDER BY updated_at DESC LIMIT 5
    `).all(businessId).map(t => ({
      ...t,
      action_payload: parseJsonField(t.action_payload),
      outcome_data: parseJsonField(t.outcome_data),
    }));

    // --- Agents ---
    const agents = db.prepare('SELECT * FROM agents ORDER BY name ASC').all().map(a => ({
      ...a,
      settings_override: parseJsonField(a.settings_override),
    }));

    // --- Last sync ---
    const lastSync = db.prepare(`
      SELECT MAX(last_sync) as last_sync FROM connectors WHERE business_id = ?
    `).get(businessId)?.last_sync ?? null;

    return res.json({
      business: {
        ...business,
        settings: parseJsonField(business.settings),
      },
      metrics: {
        sessions_7d: metricSummary(sessions7d),
        organic_keywords: metricSummary(organicKeywords),
        pagespeed_score: metricSummary(pagespeedScore),
        open_signals: openSignalsCount,
        pending_tasks: pendingTasksCount,
        agent_runs_today: agentRunsToday,
      },
      signals,
      tasks,
      agents,
      last_sync: lastSync,
    });
  } catch (err) {
    console.error('[dashboard] Error:', err);
    return res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

export default router;
