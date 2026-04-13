import { Router } from 'express';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

// ─── Static-prefix routes (must come before /:businessId and /:id param routes) ─

/**
 * POST /api/signals/analyse/:businessId
 * Trigger AI analysis — runs async, returns runId
 */
router.post('/analyse/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;

    const business = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    const runId = generateId();

    db.prepare(`
      INSERT INTO analysis_runs (id, business_id, status, started_at)
      VALUES (?, ?, 'running', CURRENT_TIMESTAMP)
    `).run(runId, businessId);

    const { runAIAnalysis } = await import('../signals/ai-analysis.js');

    runAIAnalysis(businessId, runId).catch(err => {
      console.error('[signals] AI analysis failed:', err);
      db.prepare(`UPDATE analysis_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(runId);
    });

    return res.json({ runId, status: 'running' });
  } catch (err) {
    console.error('[signals] Analyse error:', err);
    return res.status(500).json({ error: 'Failed to start analysis.' });
  }
});

/**
 * GET /api/signals/analyse/:businessId/status/:runId
 */
router.get('/analyse/:businessId/status/:runId', (req, res) => {
  try {
    const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ? AND business_id = ?').get(
      req.params.runId, req.params.businessId
    );
    if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
    return res.json(run);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get analysis status.' });
  }
});

/**
 * PATCH /api/signals/clusters/:id
 * Body: { status: 'dismissed' | 'resolved' | 'open' }
 */
router.patch('/clusters/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body ?? {};
    if (!['dismissed', 'resolved', 'open'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    const cluster = db.prepare('SELECT * FROM signal_clusters WHERE id = ?').get(id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });

    const sigIds = JSON.parse(cluster.signal_ids ?? '[]');
    db.prepare(`
      UPDATE signal_clusters SET status = ?, updated_at = CURRENT_TIMESTAMP,
      resolved_at = CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END
      WHERE id = ?
    `).run(status, status, id);

    // Resolving/dismissing a cluster acknowledges its signals too
    if (status === 'resolved' || status === 'dismissed') {
      for (const sigId of sigIds) {
        db.prepare(
          `UPDATE signals SET status = 'acknowledged' WHERE id = ? AND status = 'open'`
        ).run(sigId);
      }
    }
    res.json({ ok: true, id, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/signals/:businessId/cluster
 * Trigger clustering manually.
 */
router.post('/:businessId/cluster', async (req, res) => {
  try {
    const { runClustering } = await import('../signals/cluster-engine.js');
    const created = await runClustering(req.params.businessId);
    res.json({ ok: true, clusters_created: created.length, cluster_ids: created });
  } catch (err) {
    console.error('[signals] cluster trigger error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/signals/:businessId/clusters
 */
router.get('/:businessId/clusters', (req, res) => {
  try {
    const { businessId } = req.params;
    const status = req.query.status || 'open';
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);

    const clusters = db.prepare(`
      SELECT * FROM signal_clusters
      WHERE business_id = ? AND status = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(businessId, status, limit);

    const enriched = clusters.map((c) => {
      const sigIds = JSON.parse(c.signal_ids ?? '[]');
      const signals = sigIds.length > 0 ? db.prepare(`
        SELECT s.id, s.title, s.severity, c2.type as connector
        FROM signals s
        LEFT JOIN connectors c2 ON c2.id = s.connector_id
        WHERE s.id IN (${sigIds.map(() => '?').join(',')})
      `).all(...sigIds) : [];
      return {
        id: c.id,
        title: c.title,
        summary: c.summary,
        likely_cause: c.likely_cause,
        recommendation: c.recommendation,
        severity: c.severity,
        confidence: c.confidence,
        status: c.status,
        signal_count: signals.length,
        signals,
        created_at: c.created_at,
      };
    });

    res.json({ clusters: enriched });
  } catch (err) {
    console.error('[signals] clusters list error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/signals/insights/:businessId
 * Returns signals created by AI analysis
 */
router.get('/insights/:businessId', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM signals
      WHERE business_id = ? AND agent_id = 'conductor' AND rule_id = 'ai_analysis'
      ORDER BY created_at DESC LIMIT 50
    `).all(req.params.businessId);
    return res.json(rows.map(r => ({ ...r, data: r.data ? JSON.parse(r.data) : {} })));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get insights.' });
  }
});

// ─── /:id action routes ───────────────────────────────────────────────────────

/**
 * POST /api/signals/:id/create-task
 * Body: { title, description, agentId, priority, actionType, trustTier }
 */
router.post('/:id/create-task', async (req, res) => {
  try {
    const { id } = req.params;
    const signal = db.prepare('SELECT * FROM signals WHERE id = ?').get(id);
    if (!signal) return res.status(404).json({ error: 'Signal not found.' });

    const {
      title,
      description,
      agentId = 'conductor',
      priority = 'p2',
      actionType,
      trustTier = 'yellow',
    } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required.' });

    const { createTask } = await import('../tasks/task-queue.js');
    const { createTaskEvent } = await import('../tasks/task-events.js');

    const task = createTask({
      business_id: signal.business_id,
      signal_id: id,
      title,
      description,
      proposed_by: agentId,
      action_type: actionType || null,
      action_payload: {},
      trust_tier: trustTier,
      priority,
      confidence: signal.confidence,
      approval_mode: 'requires_approval',
    });

    createTaskEvent(task.id, 'created', agentId, `Task created from signal: "${title}"`, { signal_id: id, signal_title: signal.title });

    db.prepare(`UPDATE signals SET status = 'acknowledged' WHERE id = ? AND status = 'open'`).run(id);

    return res.json(task);
  } catch (err) {
    console.error('[signals] Create task error:', err);
    return res.status(500).json({ error: 'Failed to create task from signal.' });
  }
});

const VALID_STATUSES = ['open', 'acknowledged', 'snoozed', 'resolved'];

const VALID_TRANSITIONS = {
  open: ['acknowledged', 'snoozed', 'resolved'],
  acknowledged: ['snoozed', 'resolved', 'open'],
  snoozed: ['open', 'acknowledged', 'resolved'],
  resolved: ['open'], // allow re-opening
};

function safeJSON(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); }
  catch {
    console.warn('[signals] Failed to parse JSON field, using fallback. Raw:', String(raw).slice(0, 120));
    return fallback;
  }
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    data: safeJSON(row.data, {}),
    attribution_analysis: safeJSON(row.attribution_analysis, null),
  };
}

/**
 * GET /api/signals/:businessId
 * Query: page, limit, severity, connector, type, status, dateFrom, dateTo
 */
router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const {
      page = 1,
      limit = 50,
      severity,
      connector,
      type,
      status,
      dateFrom,
      dateTo,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    // Prefix every condition with "s." so they remain unambiguous in the
    // JOIN query (connectors also has business_id, created_at, etc.).
    const conditions = ['s.business_id = ?'];
    const params = [businessId];

    if (severity) { conditions.push('s.severity = ?'); params.push(severity); }
    if (connector) { conditions.push('s.connector_id = ?'); params.push(connector); }
    if (type) { conditions.push('s.type = ?'); params.push(type); }
    if (status) { conditions.push('s.status = ?'); params.push(status); }
    if (dateFrom) { conditions.push('s.created_at >= ?'); params.push(dateFrom); }
    if (dateTo) { conditions.push('s.created_at <= ?'); params.push(dateTo); }

    const where = conditions.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM signals s WHERE ${where}`).get(...params)?.cnt ?? 0;
    const rows = db.prepare(`
      SELECT s.*, c.type as connector_type, c.name as connector_name
      FROM signals s
      LEFT JOIN connectors c ON c.id = s.connector_id
      WHERE ${where}
      ORDER BY s.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    return res.json({
      data: rows.map(parseRow),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('[signals] List error:', err);
    return res.status(500).json({ error: 'Failed to list signals.' });
  }
});

/**
 * PATCH /api/signals/:id
 * Body: { status, snoozed_until? }
 */
router.patch('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status: newStatus, snoozed_until } = req.body;

    const existing = db.prepare('SELECT * FROM signals WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Signal not found.' });

    if (!newStatus) return res.status(400).json({ error: 'status is required.' });

    if (!VALID_STATUSES.includes(newStatus)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const allowed = VALID_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(newStatus)) {
      return res.status(422).json({
        error: `Cannot transition from '${existing.status}' to '${newStatus}'. Allowed: ${allowed.join(', ')}`,
      });
    }

    const updates = ['status = ?'];
    const values = [newStatus];

    if (newStatus === 'resolved') {
      updates.push('resolved_at = CURRENT_TIMESTAMP');
    }
    if (newStatus === 'snoozed' && snoozed_until) {
      updates.push('snoozed_until = ?');
      values.push(snoozed_until);
    }

    values.push(id);
    db.prepare(`UPDATE signals SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = parseRow(db.prepare('SELECT * FROM signals WHERE id = ?').get(id));
    audit(
      existing.business_id,
      'signal',
      id,
      `status_change:${existing.status}->${newStatus}`,
      req.session.userId,
      parseRow(existing),
      updated
    );

    return res.json(updated);
  } catch (err) {
    console.error('[signals] Update error:', err);
    return res.status(500).json({ error: 'Failed to update signal.' });
  }
});

/**
 * GET /api/signals/:businessId/summary
 */
router.get('/:businessId/summary', (req, res) => {
  try {
    const { businessId } = req.params;
    const byCritical = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND severity = 'critical' AND status = 'open'`).get(businessId)?.n ?? 0;
    const byAlert = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND severity = 'alert' AND status = 'open'`).get(businessId)?.n ?? 0;
    const byWarning = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND severity = 'warning' AND status = 'open'`).get(businessId)?.n ?? 0;
    const total = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND status = 'open'`).get(businessId)?.n ?? 0;
    const aiCount = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND rule_id = 'ai_analysis' AND status = 'open'`).get(businessId)?.n ?? 0;
    const lastAnalysis = db.prepare(`SELECT completed_at, health_score, summary FROM analysis_runs WHERE business_id = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 1`).get(businessId);
    return res.json({ total, critical: byCritical, alert: byAlert, warning: byWarning, ai: aiCount, lastAnalysis });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get summary.' });
  }
});

export default router;
