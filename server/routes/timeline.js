/**
 * Timeline API (Prompt 5).
 * Merged chronological feed of agent runs, tasks, signals, workflow runs,
 * goal checks, and connector syncs.
 */
import { Router } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

const AGENT_DISPLAY = {
  conductor: 'Conductor', 'seo-sentinel': 'SEO Sentinel', quill: 'Quill',
  velocity: 'Velocity', 'trend-spotter': 'Trend Spotter', merchant: 'Merchant',
  ledger: 'Ledger', reporter: 'Reporter', sentinel: 'Sentinel', dev: 'Dev',
  researcher: 'Researcher', outreach: 'Outreach',
};

function parseTypes(raw) {
  if (!raw) return null;
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const before = req.query.before ?? null;
    const types = parseTypes(req.query.types);
    const projectId = req.query.project_id ?? null;

    const has = (k, alt) => !types || types.includes(k) || (alt && types.includes(alt));
    const wantAgent     = has('agent_run', 'agent');
    const wantTask      = has('task');
    const wantSignal    = has('signal');
    const wantWorkflow  = has('workflow_run', 'workflow');
    const wantGoal      = has('goal_check', 'goal');
    const wantConnector = has('connector_sync', 'connector');

    const events = [];

    if (wantAgent) {
      const rows = db.prepare(`
        SELECT id, agent_id, status, tasks_proposed, cost_usd, started_at, completed_at, error
        FROM agent_runs
        WHERE business_id = ?
        ${before ? 'AND started_at < ?' : ''}
        ORDER BY started_at DESC LIMIT ?
      `).all(...[businessId, ...(before ? [before] : []), limit]);
      for (const r of rows) {
        events.push({
          id: `agent_run_${r.id}`,
          type: 'agent_run',
          actor: r.agent_id,
          actor_name: AGENT_DISPLAY[r.agent_id] || r.agent_id,
          title: `${AGENT_DISPLAY[r.agent_id] || r.agent_id} ran`,
          subtitle: r.status === 'complete'
            ? `Proposed ${r.tasks_proposed ?? 0} tasks · $${Number(r.cost_usd ?? 0).toFixed(3)}`
            : (r.error || r.status),
          severity: r.status === 'failed' ? 'error' : 'info',
          created_at: r.started_at,
          ref: { run_id: r.id },
        });
      }
    }

    if (wantTask) {
      const clauses = ['business_id = ?']; const params = [businessId];
      if (before) { clauses.push('created_at < ?'); params.push(before); }
      if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
      const rows = db.prepare(`
        SELECT id, title, status, priority, trust_tier, proposed_by, created_at, completed_at
        FROM tasks WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC LIMIT ?
      `).all(...params, limit);
      for (const r of rows) {
        events.push({
          id: `task_${r.id}`,
          type: 'task',
          actor: r.proposed_by,
          actor_name: AGENT_DISPLAY[r.proposed_by] || r.proposed_by,
          title: `Task ${r.status}`,
          subtitle: `"${r.title}" — ${r.priority || 'p2'} · ${r.trust_tier || 'yellow'}`,
          severity: r.priority === 'p1' ? 'warning' : 'info',
          created_at: r.created_at,
          ref: { task_id: r.id },
        });
      }
    }

    if (wantSignal) {
      const clauses = ['business_id = ?']; const params = [businessId];
      if (before) { clauses.push('created_at < ?'); params.push(before); }
      if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
      const rows = db.prepare(`
        SELECT s.id, s.title, s.severity, s.type, s.confidence, s.status,
               s.created_at, c.type as connector
        FROM signals s
        LEFT JOIN connectors c ON c.id = s.connector_id
        WHERE ${clauses.join(' AND ').replace(/business_id/g, 's.business_id').replace('created_at', 's.created_at').replace('project_id', 's.project_id')}
        ORDER BY s.created_at DESC LIMIT ?
      `).all(...params, limit);
      for (const r of rows) {
        events.push({
          id: `signal_${r.id}`,
          type: 'signal',
          actor: r.connector ?? 'system',
          actor_name: r.connector ? r.connector.toUpperCase() : 'System',
          title: `Signal detected`,
          subtitle: `[${r.severity}] "${r.title}"${r.confidence ? ` — ${(r.confidence * 100).toFixed(0)}%` : ''}`,
          severity: r.severity === 'critical' || r.severity === 'alert' ? 'error' : 'info',
          created_at: r.created_at,
          ref: { signal_id: r.id },
        });
      }
    }

    if (wantWorkflow) {
      const rows = db.prepare(`
        SELECT wr.id, wr.triggered_by, wr.status, wr.steps_completed, wr.steps_total,
               wr.started_at, wr.completed_at, w.name
        FROM workflow_runs wr
        JOIN workflows w ON w.id = wr.workflow_id
        WHERE wr.business_id = ?
        ${before ? 'AND wr.started_at < ?' : ''}
        ORDER BY wr.started_at DESC LIMIT ?
      `).all(...[businessId, ...(before ? [before] : []), limit]);
      for (const r of rows) {
        events.push({
          id: `workflow_run_${r.id}`,
          type: 'workflow_run',
          actor: r.triggered_by,
          actor_name: r.triggered_by,
          title: `Workflow: ${r.name}`,
          subtitle: `${r.steps_completed}/${r.steps_total} steps · ${r.status}`,
          severity: r.status === 'failed' || r.status === 'cancelled' ? 'error' : 'info',
          created_at: r.started_at,
          ref: { run_id: r.id, workflow_name: r.name },
        });
      }
    }

    if (wantGoal) {
      const rows = db.prepare(`
        SELECT gc.id, gc.progress_pct, gc.status_change, gc.agent_note,
               gc.checked_at, g.title
        FROM goal_checks gc
        JOIN goals g ON g.id = gc.goal_id
        WHERE gc.business_id = ?
        ${before ? 'AND gc.checked_at < ?' : ''}
        ORDER BY gc.checked_at DESC LIMIT ?
      `).all(...[businessId, ...(before ? [before] : []), limit]);
      for (const r of rows) {
        events.push({
          id: `goal_check_${r.id}`,
          type: 'goal_check',
          actor: 'system',
          actor_name: 'System',
          title: `Goal progress: ${r.title}`,
          subtitle: `${(r.progress_pct ?? 0).toFixed(0)}% — ${r.status_change || 'checked'}. ${r.agent_note || ''}`.trim(),
          severity: r.status_change === 'at_risk' ? 'warning' : r.status_change === 'achieved' ? 'success' : 'info',
          created_at: r.checked_at,
        });
      }
    }

    if (wantConnector) {
      const rows = db.prepare(`
        SELECT cs.id, cs.status, cs.metrics_stored, cs.duration_ms, cs.error,
               cs.created_at, c.type, c.name
        FROM connector_syncs cs
        JOIN connectors c ON c.id = cs.connector_id
        WHERE c.business_id = ?
        ${before ? 'AND cs.created_at < ?' : ''}
        ORDER BY cs.created_at DESC LIMIT ?
      `).all(...[businessId, ...(before ? [before] : []), limit]);
      for (const r of rows) {
        events.push({
          id: `connector_sync_${r.id}`,
          type: 'connector_sync',
          actor: r.type,
          actor_name: r.name,
          title: `${(r.name || r.type).toString()} synced`,
          subtitle: r.status === 'complete'
            ? `${r.metrics_stored ?? 0} metrics stored${r.duration_ms ? ` · ${Math.round(r.duration_ms/1000)}s` : ''}`
            : (r.error || r.status),
          severity: r.status === 'failed' ? 'error' : 'info',
          created_at: r.created_at,
        });
      }
    }

    // Merge and sort
    events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(events.slice(0, limit));
  } catch (err) {
    console.error('[timeline] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Intelligence events (mesh flow) ─────────────────────────────────────────
//
// Every time one part of the mesh produces output that another consumes
// (KB → signal, signal → task, agent → brief, chat → gap) an intelligence
// event is logged. These endpoints let the Timeline UI show "what did this
// event produce downstream".

/**
 * List recent intelligence events for a business.
 * Query params: ?limit=50, ?source_type=kb|signal|task|..., ?target_type=...
 */
router.get('/:businessId/intelligence', (req, res) => {
  try {
    const { businessId } = req.params;
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const sourceType = req.query.source_type ?? null;
    const targetType = req.query.target_type ?? null;
    const since = req.query.since ?? null;

    const clauses = ['business_id = ?'];
    const args = [businessId];
    if (sourceType) { clauses.push('source_type = ?'); args.push(sourceType); }
    if (targetType) { clauses.push('target_type = ?'); args.push(targetType); }
    if (since)      { clauses.push('created_at > ?'); args.push(since); }

    const rows = db.prepare(`
      SELECT * FROM intelligence_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?
    `).all(...args, limit);

    const events = rows.map((r) => ({
      ...r,
      metadata: r.metadata ? safeJSON(r.metadata) : null,
    }));
    res.json(events);
  } catch (err) {
    console.error('[timeline/intelligence] error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Fetch the intelligence events PRODUCED BY a specific timeline event.
 * E.g. "What did this agent run produce?" → events where source matches.
 */
router.get('/:businessId/produced/:sourceType/:sourceId', (req, res) => {
  try {
    const { businessId, sourceType, sourceId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 25);

    const rows = db.prepare(`
      SELECT * FROM intelligence_events
       WHERE business_id = ?
         AND source_type = ?
         AND source_id = ?
       ORDER BY created_at DESC
       LIMIT ?
    `).all(businessId, sourceType, sourceId, limit);

    const events = rows.map((r) => ({
      ...r,
      metadata: r.metadata ? safeJSON(r.metadata) : null,
    }));
    res.json(events);
  } catch (err) {
    console.error('[timeline/produced] error:', err);
    res.status(500).json({ error: err.message });
  }
});

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export default router;
