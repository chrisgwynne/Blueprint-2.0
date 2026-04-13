/**
 * Agent Status API (Prompt 4) — lightweight endpoint for the AgentPanel.
 */
import { Router } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

const AVATARS = {
  conductor: '🎼', 'seo-sentinel': '🔍', quill: '✍️', velocity: '⚡',
  'trend-spotter': '📈', merchant: '🛒', ledger: '📊', sentinel: '🛡️',
  dev: '💻', researcher: '🔬', reporter: '📰', outreach: '📬',
};

// 30s cache
let cache = { expires: 0, payload: null };

router.get('/', (req, res) => {
  try {
    if (cache.payload && Date.now() < cache.expires) {
      return res.json(cache.payload);
    }

    const agents = db.prepare('SELECT * FROM agents ORDER BY name ASC').all();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const out = agents.map((a) => {
      const runningRun = db.prepare(`
        SELECT id, started_at FROM agent_runs
        WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1
      `).get(a.id);
      const recentRuns = db.prepare(`
        SELECT status FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 5
      `).all(a.id);
      const consecutiveFails = recentRuns.findIndex(r => r.status !== 'failed');
      const failing = consecutiveFails === -1 ? recentRuns.length : consecutiveFails;
      const tasksToday = db.prepare(`
        SELECT COALESCE(SUM(tasks_proposed), 0) as t FROM agent_runs
        WHERE agent_id = ? AND started_at >= ?
      `).get(a.id, todayStart.toISOString())?.t ?? 0;
      const costToday = db.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) as t FROM agent_runs
        WHERE agent_id = ? AND started_at >= ?
      `).get(a.id, todayStart.toISOString())?.t ?? 0;

      let status;
      if (a.status === 'paused' || a.status === 'disabled') status = 'paused';
      else if (runningRun) status = 'running';
      else if (failing >= 3) status = 'error';
      else status = 'idle';

      return {
        id: a.id,
        name: a.name,
        avatar: AVATARS[a.id] ?? '🤖',
        status,
        last_run: a.last_run,
        next_run: null,
        current_task: runningRun ? `Running since ${runningRun.started_at}` : null,
        tasks_proposed_today: tasksToday,
        cost_today_usd: Math.round(costToday * 10000) / 10000,
        consecutive_failures: failing,
      };
    });

    const totalCostToday = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as t FROM agent_runs WHERE started_at >= ?"
    ).get(todayStart.toISOString())?.t ?? 0;
    const runsToday = db.prepare(
      "SELECT COUNT(*) as c FROM agent_runs WHERE started_at >= ?"
    ).get(todayStart.toISOString())?.c ?? 0;

    const payload = {
      agents: out,
      total_cost_today: Math.round(totalCostToday * 10000) / 10000,
      runs_today: runsToday,
    };

    cache = { expires: Date.now() + 30000, payload };
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
