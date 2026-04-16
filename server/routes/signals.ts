import { Router } from 'express';
import type { Request, Response } from 'express';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

// ─── Static-prefix routes (must come before /:businessId and /:id param routes) ─

/**
 * POST /api/signals/analyse/:businessId
 * Trigger AI analysis — runs async, returns runId
 */
router.post('/analyse/:businessId', async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);

    const business = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    const runId = generateId();

    db.prepare(`
      INSERT INTO analysis_runs (id, business_id, status, started_at)
      VALUES (?, ?, 'running', CURRENT_TIMESTAMP)
    `).run(runId, businessId);

    const { runAIAnalysis } = await import('../signals/ai-analysis.js') as unknown as {
      runAIAnalysis: (businessId: string, runId: string) => Promise<void>;
    };

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
router.get('/analyse/:businessId/status/:runId', (req: Request, res: Response) => {
  try {
    const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ? AND business_id = ?').get(
      String(req.params.runId), String(req.params.businessId)
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
router.patch('/clusters/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { status } = (req.body ?? {}) as { status?: string };
    if (!['dismissed', 'resolved', 'open'].includes(status ?? '')) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    const cluster = db.prepare('SELECT * FROM signal_clusters WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });

    const sigIds = JSON.parse(cluster.signal_ids as string ?? '[]') as string[];
    db.prepare(`
      UPDATE signal_clusters SET status = ?, updated_at = CURRENT_TIMESTAMP,
      resolved_at = CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END
      WHERE id = ?
    `).run(status as string, status as string, id);

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
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/signals/:businessId/cluster
 * Trigger clustering manually.
 */
router.post('/:businessId/cluster', async (req: Request, res: Response) => {
  try {
    const { runClustering } = await import('../signals/cluster-engine.js') as unknown as {
      runClustering: (businessId: string) => Promise<string[]>;
    };
    const created = await runClustering(String(req.params.businessId));
    res.json({ ok: true, clusters_created: created.length, cluster_ids: created });
  } catch (err) {
    console.error('[signals] cluster trigger error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/signals/:businessId/clusters
 */
router.get('/:businessId/clusters', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const status = String(req.query.status ?? 'open');
    const limit = Math.min(50, parseInt(String(req.query.limit ?? '10'), 10) || 10);

    const clusters = db.prepare(`
      SELECT * FROM signal_clusters
      WHERE business_id = ? AND status = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(businessId, status, limit) as Array<Record<string, unknown>>;

    const enriched = clusters.map((c) => {
      const sigIds = JSON.parse(c.signal_ids as string ?? '[]') as string[];
      const signals: unknown[] = sigIds.length > 0 ? db.prepare(`
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
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/signals/insights/:businessId
 * Returns signals created by AI analysis
 */
router.get('/insights/:businessId', (req: Request, res: Response) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM signals
      WHERE business_id = ? AND agent_id = 'conductor' AND rule_id = 'ai_analysis'
      ORDER BY created_at DESC LIMIT 50
    `).all(String(req.params.businessId)) as Array<Record<string, unknown>>;
    return res.json(rows.map(r => ({ ...r, data: r.data ? JSON.parse(r.data as string) : {} })));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get insights.' });
  }
});

// ─── /:id action routes ───────────────────────────────────────────────────────

/**
 * POST /api/signals/:id/create-task
 * Body: { title, description, agentId, priority, actionType, trustTier }
 */
router.post('/:id/create-task', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const signal = db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!signal) return res.status(404).json({ error: 'Signal not found.' });

    const {
      title,
      description,
      agentId = 'conductor',
      priority = 'p2',
      actionType,
      trustTier = 'yellow',
    } = req.body as {
      title?: string;
      description?: string;
      agentId?: string;
      priority?: string;
      actionType?: string;
      trustTier?: string;
    };

    if (!title) return res.status(400).json({ error: 'title is required.' });

    const { createTask } = await import('../tasks/task-queue.js') as unknown as {
      createTask: (opts: Record<string, unknown>) => Record<string, unknown>;
    };
    const { createTaskEvent } = await import('../tasks/task-events.js') as unknown as {
      createTaskEvent: (taskId: string, type: string, actor: string, msg: string, meta: Record<string, unknown>) => void;
    };

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

    createTaskEvent(task.id as string, 'created', agentId, `Task created from signal: "${title}"`, { signal_id: id, signal_title: signal.title });

    db.prepare(`UPDATE signals SET status = 'acknowledged' WHERE id = ? AND status = 'open'`).run(id);

    return res.json(task);
  } catch (err) {
    console.error('[signals] Create task error:', err);
    return res.status(500).json({ error: 'Failed to create task from signal.' });
  }
});

const VALID_STATUSES = ['open', 'acknowledged', 'snoozed', 'resolved'];

const VALID_TRANSITIONS: Record<string, string[]> = {
  open: ['acknowledged', 'snoozed', 'resolved'],
  acknowledged: ['snoozed', 'resolved', 'open'],
  snoozed: ['open', 'acknowledged', 'resolved'],
  resolved: ['open'], // allow re-opening
};

function safeJSON(raw: unknown, fallback: unknown): unknown {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw as string); }
  catch {
    console.warn('[signals] Failed to parse JSON field, using fallback. Raw:', String(raw).slice(0, 120));
    return fallback;
  }
}

function parseRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
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
router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const {
      page = '1',
      limit = '50',
      severity,
      connector,
      type,
      status,
      dateFrom,
      dateTo,
    } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    // Prefix every condition with "s." so they remain unambiguous in the
    // JOIN query (connectors also has business_id, created_at, etc.).
    const conditions = ['s.business_id = ?'];
    const params: any[] = [businessId];

    if (severity) { conditions.push('s.severity = ?'); params.push(String(severity)); }
    if (connector) { conditions.push('s.connector_id = ?'); params.push(String(connector)); }
    if (type) { conditions.push('s.type = ?'); params.push(String(type)); }
    if (status) { conditions.push('s.status = ?'); params.push(String(status)); }
    if (dateFrom) { conditions.push('s.created_at >= ?'); params.push(String(dateFrom)); }
    if (dateTo) { conditions.push('s.created_at <= ?'); params.push(String(dateTo)); }

    const where = conditions.join(' AND ');

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM signals s WHERE ${where}`).get(...params) as { cnt: number } | undefined)?.cnt ?? 0;
    const rows = db.prepare(`
      SELECT s.*, c.type as connector_type, c.name as connector_name
      FROM signals s
      LEFT JOIN connectors c ON c.id = s.connector_id
      WHERE ${where}
      ORDER BY s.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset) as Array<Record<string, unknown>>;

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
router.patch('/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { status: newStatus, snoozed_until } = req.body as { status?: string; snoozed_until?: string };

    const existing = db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Signal not found.' });

    if (!newStatus) return res.status(400).json({ error: 'status is required.' });

    if (!VALID_STATUSES.includes(newStatus)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const allowed = VALID_TRANSITIONS[existing.status as string] ?? [];
    if (!allowed.includes(newStatus)) {
      return res.status(422).json({
        error: `Cannot transition from '${existing.status as string}' to '${newStatus}'. Allowed: ${allowed.join(', ')}`,
      });
    }

    const updates = ['status = ?'];
    const values: any[] = [newStatus];

    if (newStatus === 'resolved') {
      updates.push('resolved_at = CURRENT_TIMESTAMP');
    }
    if (newStatus === 'snoozed' && snoozed_until) {
      updates.push('snoozed_until = ?');
      values.push(snoozed_until);
    }

    values.push(id);
    db.prepare(`UPDATE signals SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = parseRow(db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Record<string, unknown> | null);
    const session = req.session as unknown as Record<string, unknown>;
    audit(
      existing.business_id as string,
      'signal',
      id,
      `status_change:${existing.status as string}->${newStatus}`,
      session.userId as string,
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
router.get('/:businessId/summary', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const byCritical = (db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND severity = 'critical' AND status = 'open'`).get(businessId) as { n: number } | undefined)?.n ?? 0;
    const byAlert = (db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND severity = 'alert' AND status = 'open'`).get(businessId) as { n: number } | undefined)?.n ?? 0;
    const byWarning = (db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND severity = 'warning' AND status = 'open'`).get(businessId) as { n: number } | undefined)?.n ?? 0;
    const total = (db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND status = 'open'`).get(businessId) as { n: number } | undefined)?.n ?? 0;
    const aiCount = (db.prepare(`SELECT COUNT(*) as n FROM signals WHERE business_id = ? AND rule_id = 'ai_analysis' AND status = 'open'`).get(businessId) as { n: number } | undefined)?.n ?? 0;
    const lastAnalysis = db.prepare(`SELECT completed_at, health_score, summary FROM analysis_runs WHERE business_id = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 1`).get(businessId);
    return res.json({ total, critical: byCritical, alert: byAlert, warning: byWarning, ai: aiCount, lastAnalysis });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get summary.' });
  }
});

export default router;
