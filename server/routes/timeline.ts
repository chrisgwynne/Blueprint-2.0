/**
 * Timeline API (Prompt 5).
 * Merged chronological feed of agent runs, tasks, signals, workflow runs,
 * goal checks, and connector syncs.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

const AGENT_DISPLAY: Record<string, string> = {
  conductor: 'Conductor', 'seo-sentinel': 'SEO Sentinel', quill: 'Quill',
  velocity: 'Velocity', 'trend-spotter': 'Trend Spotter', merchant: 'Merchant',
  ledger: 'Ledger', reporter: 'Reporter', sentinel: 'Sentinel', dev: 'Dev',
  researcher: 'Researcher', outreach: 'Outreach',
};

function parseTypes(raw: unknown): string[] | null {
  if (!raw) return null;
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const limit = Math.min(100, parseInt(String(req.query.limit ?? '50'), 10) || 50);
    const before = req.query.before ? String(req.query.before) : null;
    const types = parseTypes(req.query.types);
    const projectId = req.query.project_id ? String(req.query.project_id) : null;

    const has = (k: string, alt?: string): boolean => !types || types.includes(k) || (!!alt && types.includes(alt));
    const wantAgent     = has('agent_run', 'agent');
    const wantTask      = has('task');
    const wantSignal    = has('signal');
    const wantWorkflow  = has('workflow_run', 'workflow');
    const wantGoal      = has('goal_check', 'goal');
    const wantConnector = has('connector_sync', 'connector');

    const events: Array<Record<string, unknown>> = [];

    if (wantAgent) {
      const rows = db.prepare(`
        SELECT id, agent_id, status, tasks_proposed, cost_usd, started_at, completed_at, error
        FROM agent_runs
        WHERE business_id = ?
        ${before ? 'AND started_at < ?' : ''}
        ORDER BY started_at DESC LIMIT ?
      `).all(...([businessId, ...(before ? [before] : []), limit] as any[])) as Array<Record<string, unknown>>;
      for (const r of rows) {
        events.push({
          id: `agent_run_${r.id as string}`,
          type: 'agent_run',
          actor: r.agent_id,
          actor_name: AGENT_DISPLAY[r.agent_id as string] || r.agent_id,
          title: `${AGENT_DISPLAY[r.agent_id as string] || r.agent_id as string} ran`,
          subtitle: r.status === 'complete'
            ? `Proposed ${(r.tasks_proposed as number | null) ?? 0} tasks · $${Number(r.cost_usd ?? 0).toFixed(3)}`
            : (r.error || r.status),
          severity: r.status === 'failed' ? 'error' : 'info',
          created_at: r.started_at,
          ref: { run_id: r.id },
          // UI can call /produced/agent_run/<run_id> to see what this run did
          produces: { source_type: 'agent_run', source_id: r.id },
        });
      }
    }

    if (wantTask) {
      const clauses = ['business_id = ?']; const params: any[] = [businessId];
      if (before) { clauses.push('created_at < ?'); params.push(before); }
      if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
      const rows = db.prepare(`
        SELECT id, title, status, priority, trust_tier, proposed_by, created_at, completed_at
        FROM tasks WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC LIMIT ?
      `).all(...params, limit) as Array<Record<string, unknown>>;
      for (const r of rows) {
        events.push({
          id: `task_${r.id as string}`,
          type: 'task',
          actor: r.proposed_by,
          actor_name: AGENT_DISPLAY[r.proposed_by as string] || r.proposed_by,
          title: `Task ${r.status as string}`,
          subtitle: `"${r.title as string}" — ${(r.priority as string) || 'p2'} · ${(r.trust_tier as string) || 'yellow'}`,
          severity: r.priority === 'p1' ? 'warning' : 'info',
          created_at: r.created_at,
          ref: { task_id: r.id },
          produces: { source_type: 'task', source_id: r.id },
        });
      }
    }

    if (wantSignal) {
      const clauses = ['business_id = ?']; const params: any[] = [businessId];
      if (before) { clauses.push('created_at < ?'); params.push(before); }
      if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
      const rows = db.prepare(`
        SELECT s.id, s.title, s.severity, s.type, s.confidence, s.status,
               s.created_at, c.type as connector
        FROM signals s
        LEFT JOIN connectors c ON c.id = s.connector_id
        WHERE ${clauses.join(' AND ').replace(/business_id/g, 's.business_id').replace('created_at', 's.created_at').replace('project_id', 's.project_id')}
        ORDER BY s.created_at DESC LIMIT ?
      `).all(...params, limit) as Array<Record<string, unknown>>;
      for (const r of rows) {
        events.push({
          id: `signal_${r.id as string}`,
          type: 'signal',
          actor: r.connector ?? 'system',
          actor_name: r.connector ? (r.connector as string).toUpperCase() : 'System',
          title: `Signal detected`,
          subtitle: `[${r.severity as string}] "${r.title as string}"${r.confidence ? ` — ${((r.confidence as number) * 100).toFixed(0)}%` : ''}`,
          severity: r.severity === 'critical' || r.severity === 'alert' ? 'error' : 'info',
          created_at: r.created_at,
          ref: { signal_id: r.id },
          produces: { source_type: 'signal', source_id: r.id },
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
      `).all(...([businessId, ...(before ? [before] : []), limit] as any[])) as Array<Record<string, unknown>>;
      for (const r of rows) {
        events.push({
          id: `workflow_run_${r.id as string}`,
          type: 'workflow_run',
          actor: r.triggered_by,
          actor_name: r.triggered_by,
          title: `Workflow: ${r.name as string}`,
          subtitle: `${r.steps_completed as number}/${r.steps_total as number} steps · ${r.status as string}`,
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
      `).all(...([businessId, ...(before ? [before] : []), limit] as any[])) as Array<Record<string, unknown>>;
      for (const r of rows) {
        events.push({
          id: `goal_check_${r.id as string}`,
          type: 'goal_check',
          actor: 'system',
          actor_name: 'System',
          title: `Goal progress: ${r.title as string}`,
          subtitle: `${((r.progress_pct as number | null) ?? 0).toFixed(0)}% — ${(r.status_change as string) || 'checked'}. ${(r.agent_note as string) || ''}`.trim(),
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
      `).all(...([businessId, ...(before ? [before] : []), limit] as any[])) as Array<Record<string, unknown>>;
      for (const r of rows) {
        events.push({
          id: `connector_sync_${r.id as string}`,
          type: 'connector_sync',
          actor: r.type,
          actor_name: r.name,
          title: `${(r.name || r.type as string).toString()} synced`,
          subtitle: r.status === 'complete'
            ? `${(r.metrics_stored as number | null) ?? 0} metrics stored${r.duration_ms ? ` · ${Math.round((r.duration_ms as number) / 1000)}s` : ''}`
            : (r.error || r.status),
          severity: r.status === 'failed' ? 'error' : 'info',
          created_at: r.created_at,
        });
      }
    }

    // Merge and sort
    events.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());
    res.json(events.slice(0, limit));
  } catch (err) {
    console.error('[timeline] error:', err);
    res.status(500).json({ error: (err as Error).message });
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
router.get('/:businessId/intelligence', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const limit = Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50);
    const sourceType = req.query.source_type ? String(req.query.source_type) : null;
    const targetType = req.query.target_type ? String(req.query.target_type) : null;
    const since = req.query.since ? String(req.query.since) : null;

    const clauses = ['business_id = ?'];
    const args: any[] = [businessId];
    if (sourceType) { clauses.push('source_type = ?'); args.push(sourceType); }
    if (targetType) { clauses.push('target_type = ?'); args.push(targetType); }
    if (since)      { clauses.push('created_at > ?'); args.push(since); }

    const rows = db.prepare(`
      SELECT * FROM intelligence_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?
    `).all(...args, limit) as Array<Record<string, unknown>>;

    const events = rows.map((r) => ({
      ...r,
      metadata: r.metadata ? safeJSON(r.metadata as string) : null,
    }));
    res.json(events);
  } catch (err) {
    console.error('[timeline/intelligence] error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Fetch the intelligence events PRODUCED BY a specific timeline event.
 * E.g. "What did this agent run produce?" → events where source matches.
 */
router.get('/:businessId/produced/:sourceType/:sourceId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const sourceType = String(req.params.sourceType);
    const sourceId = String(req.params.sourceId);
    const limit = Math.min(100, parseInt(String(req.query.limit ?? '25'), 10) || 25);

    const rows = db.prepare(`
      SELECT * FROM intelligence_events
       WHERE business_id = ?
         AND source_type = ?
         AND source_id = ?
       ORDER BY created_at DESC
       LIMIT ?
    `).all(businessId, sourceType, sourceId, limit) as Array<Record<string, unknown>>;

    const events = rows.map((r) => ({
      ...r,
      metadata: r.metadata ? safeJSON(r.metadata as string) : null,
    }));
    res.json(events);
  } catch (err) {
    console.error('[timeline/produced] error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

function safeJSON(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export default router;
