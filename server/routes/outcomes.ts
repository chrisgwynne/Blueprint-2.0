/**
 * Outcome Attribution API (Feature 4).
 *
 * Exposes:
 *   GET /api/outcomes/:businessId            — list of task outcomes with summary
 *   GET /api/outcomes/:businessId/agents     — per-agent outcome performance
 *   GET /api/outcomes/:businessId/timeline   — metric timeline with task markers
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function parseFilter(raw: unknown): string[] | null {
  if (!raw) return null;
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

// ─── GET /api/outcomes/:businessId ───────────────────────────────────────────

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const verdictFilter = parseFilter(req.query.verdict);
    const agentFilter = req.query.agent;
    const limit = Math.min(100, parseInt(String(req.query.limit ?? ''), 10) || 20);

    // Get tasks that have been completed and have target_metric set
    const params: any[] = [businessId];
    let where = "t.business_id = ? AND t.status IN ('complete', 'verified') AND t.completed_at IS NOT NULL";
    if (agentFilter) {
      where += ' AND t.proposed_by = ?';
      params.push(agentFilter);
    }

    const tasks = db.prepare(`
      SELECT t.id, t.title, t.action_type, t.proposed_by,
             t.completed_at, t.approved_at,
             COALESCE(t.target_metric, '') as target_metric,
             COALESCE(t.target_metric_baseline, NULL) as baseline_value
      FROM tasks t
      WHERE ${where}
      ORDER BY t.completed_at DESC
      LIMIT ?
    `).all(...params, limit);

    const outcomes = (tasks as any[]).map((t) => {
      const checks = db.prepare(`
        SELECT * FROM task_outcomes WHERE task_id = ? ORDER BY weeks_after ASC
      `).all(t.id) as any[];

      const check_2w = checks.find(c => c.weeks_after === 2) ?? null;
      const check_4w = checks.find(c => c.weeks_after === 4) ?? null;
      const latest = check_4w ?? check_2w;

      return {
        task_id: t.id,
        task_title: t.title,
        task_action_type: t.action_type,
        proposed_by: t.proposed_by,
        approved_at: t.approved_at,
        completed_at: t.completed_at,
        target_metric: t.target_metric || null,
        baseline_value: t.baseline_value,
        check_2w,
        check_4w,
        final_verdict: latest?.verdict ?? 'pending',
      };
    });

    const filtered = verdictFilter
      ? outcomes.filter(o => verdictFilter.includes(o.final_verdict))
      : outcomes;

    // Summary
    const total = outcomes.length;
    const improved = outcomes.filter(o => o.final_verdict === 'improved').length;
    const worsened = outcomes.filter(o => o.final_verdict === 'worsened').length;
    const noChange = outcomes.filter(o => o.final_verdict === 'no_change').length;
    const inconclusive = outcomes.filter(o => o.final_verdict === 'inconclusive').length;
    const measured = improved + worsened + noChange + inconclusive;
    const improvementRate = measured > 0 ? improved / measured : 0;

    // Best outcome — biggest positive change_pct
    const bestOutcome = outcomes
      .filter(o => o.final_verdict === 'improved')
      .map(o => ({ ...o, change: o.check_4w?.change_pct ?? o.check_2w?.change_pct ?? 0 }))
      .sort((a, b) => (b.change) - (a.change))[0];

    // Worst outcome — biggest negative change_pct
    const worstOutcome = outcomes
      .filter(o => o.final_verdict === 'worsened')
      .map(o => ({ ...o, change: o.check_4w?.change_pct ?? o.check_2w?.change_pct ?? 0 }))
      .sort((a, b) => (a.change) - (b.change))[0];

    res.json({
      outcomes: filtered,
      summary: {
        total_checked: total,
        improved,
        worsened,
        no_change: noChange,
        inconclusive,
        improvement_rate: Math.round(improvementRate * 100) / 100,
        best_label: bestOutcome ? `+${Math.round(bestOutcome.change)}% ${bestOutcome.target_metric?.split('.').pop() ?? ''}` : null,
        best_sub: bestOutcome?.task_title ?? null,
        worst_label: worstOutcome ? `${Math.round(worstOutcome.change)}%` : null,
      },
    });
  } catch (err) {
    console.error('[outcomes] list error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/outcomes/:businessId/agents ────────────────────────────────────

router.get('/:businessId/agents', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

    const agents = db.prepare(
      "SELECT id, name FROM agents WHERE status IN ('active', 'paused')"
    ).all() as any[];

    const perf = agents.map((agent) => {
      const proposed = (db.prepare(`
        SELECT COUNT(*) as n FROM tasks
        WHERE business_id = ? AND proposed_by = ? AND created_at >= ?
      `).get(businessId, agent.id, thirtyDaysAgo) as any)?.n ?? 0;

      const approved = (db.prepare(`
        SELECT COUNT(*) as n FROM tasks
        WHERE business_id = ? AND proposed_by = ? AND created_at >= ?
        AND status NOT IN ('proposed', 'rejected')
      `).get(businessId, agent.id, thirtyDaysAgo) as any)?.n ?? 0;

      const outcomeRows = db.prepare(`
        SELECT o.verdict, o.change_pct, t.title, t.target_metric, t.confidence
        FROM task_outcomes o
        JOIN tasks t ON t.id = o.task_id
        WHERE t.business_id = ? AND t.proposed_by = ? AND o.weeks_after = 2
        AND o.created_at >= ?
      `).all(businessId, agent.id, thirtyDaysAgo) as any[];

      const measured = outcomeRows.length;
      const improved = outcomeRows.filter(o => o.verdict === 'improved').length;
      const improvementRate = measured > 0 ? improved / measured : 0;

      const sorted = [...outcomeRows].sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];

      // Calibration: how well confidence predicts success. If we have confidence and verdict:
      //   calibration = 1 - avg( |confidence - (improved ? 1 : 0)| )
      let calibration = 0;
      let calibSamples = 0;
      for (const row of outcomeRows) {
        if (row.confidence == null) continue;
        const actual = row.verdict === 'improved' ? 1 : 0;
        calibration += 1 - Math.abs(row.confidence - actual);
        calibSamples++;
      }
      calibration = calibSamples > 0 ? calibration / calibSamples : 0;

      const avgConfidence = (db.prepare(`
        SELECT AVG(confidence) as avg FROM tasks
        WHERE business_id = ? AND proposed_by = ? AND confidence IS NOT NULL
        AND created_at >= ?
      `).get(businessId, agent.id, thirtyDaysAgo) as any)?.avg ?? 0;

      return {
        agent_id: agent.id,
        agent_name: agent.name,
        tasks_proposed_30d: proposed,
        tasks_approved_30d: approved,
        acceptance_rate: proposed > 0 ? Math.round((approved / proposed) * 100) / 100 : 0,
        outcomes_measured: measured,
        improvement_rate: Math.round(improvementRate * 100) / 100,
        best_outcome: best ? { task_title: best.title, metric: best.target_metric, change_pct: best.change_pct } : null,
        worst_outcome: worst ? { task_title: worst.title, metric: worst.target_metric, change_pct: worst.change_pct } : null,
        avg_confidence: Math.round((avgConfidence ?? 0) * 100) / 100,
        calibration: Math.round(calibration * 100) / 100,
      };
    });

    // Sort — most-active agents first
    perf.sort((a, b) => b.tasks_proposed_30d - a.tasks_proposed_30d);
    res.json(perf.filter(p => p.tasks_proposed_30d > 0 || p.outcomes_measured > 0));
  } catch (err) {
    console.error('[outcomes] agents error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/outcomes/:businessId/timeline ──────────────────────────────────

router.get('/:businessId/timeline', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const metric = String(req.query.metric || 'gsc.total_clicks');
    const days = Math.min(365, parseInt(String(req.query.days ?? ''), 10) || 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const dataPoints = db.prepare(`
      SELECT date(recorded_at) as date, AVG(metric_value) as value
      FROM metrics
      WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL AND recorded_at >= ?
      GROUP BY date(recorded_at)
      ORDER BY date(recorded_at) ASC
    `).all(businessId, metric, since);

    // Task markers — completed tasks with outcome for this metric
    const markers = db.prepare(`
      SELECT t.id as task_id, t.title, date(t.completed_at) as date,
             COALESCE(
               (SELECT verdict FROM task_outcomes WHERE task_id = t.id AND weeks_after = 4 LIMIT 1),
               (SELECT verdict FROM task_outcomes WHERE task_id = t.id AND weeks_after = 2 LIMIT 1),
               'pending'
             ) as verdict,
             COALESCE(
               (SELECT change_pct FROM task_outcomes WHERE task_id = t.id AND weeks_after = 4 LIMIT 1),
               (SELECT change_pct FROM task_outcomes WHERE task_id = t.id AND weeks_after = 2 LIMIT 1),
               NULL
             ) as change_pct
      FROM tasks t
      WHERE t.business_id = ?
        AND t.target_metric = ?
        AND t.completed_at IS NOT NULL
        AND t.completed_at >= ?
    `).all(businessId, metric, since) as any[];

    res.json({
      metric,
      data_points: dataPoints,
      task_markers: markers.map(m => ({
        date: m.date,
        task_id: m.task_id,
        task_title: m.title,
        verdict: m.verdict,
        change_pct: m.change_pct,
      })),
    });
  } catch (err) {
    console.error('[outcomes] timeline error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
