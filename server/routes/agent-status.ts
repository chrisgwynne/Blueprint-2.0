/**
 * Agent Status API (Prompt 4) — lightweight endpoint for the AgentPanel.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname, '..', 'agents');

// Match the definition in routes/agents.js so the sidebar and the Agents
// page agree on what "installed" means (profile.yaml exists on disk).
function agentIsInstalled(agentId: string): boolean {
  return existsSync(join(AGENTS_DIR, agentId, 'profile.yaml'));
}

const router = Router();
router.use(isAuthenticated);

const AVATARS: Record<string, string> = {
  conductor: '🎼', 'seo-sentinel': '🔍', quill: '✍️', velocity: '⚡',
  'trend-spotter': '📈', merchant: '🛒', ledger: '📊', sentinel: '🛡️',
  dev: '💻', researcher: '🔬', reporter: '📰', outreach: '📬',
};

// 30s cache
let cache: { expires: number; payload: unknown } = { expires: 0, payload: null };

router.get('/', async (req: Request, res: Response) => {
  try {
    if (cache.payload && Date.now() < cache.expires) {
      return res.json(cache.payload);
    }

    // Only surface agents that are actually installed (profile.yaml present
    // on disk). Otherwise the sidebar shows agents that the Agents page
    // flags as "Not installed — profile missing" — one source of truth.
    const allAgents = db.prepare('SELECT * FROM agents ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    const agents = allAgents.filter((a) => agentIsInstalled(a.id as string));
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    // Lazy import — these Tranche 6A/6B modules are available only after
    // migrations run, so failure-to-import must not kill the status route.
    let getPollInterval: ((id: string) => number) | null = null;
    try {
      const mod = await import('../agents/poll-intervals.js') as unknown as { getPollInterval: (id: string) => number };
      getPollInterval = mod.getPollInterval;
    } catch {}

    const out = agents.map((a) => {
      const agentId = a.id as string;
      const runningRun = db.prepare(`
        SELECT id, started_at FROM agent_runs
        WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1
      `).get(agentId) as { id: string; started_at: string } | undefined;

      // Last run of any kind (including skipped) — for the "sleeping since X"
      // timestamp shown in the panel.
      const lastAnyRun = db.prepare(`
        SELECT status, started_at, trigger, trigger_type FROM agent_runs
         WHERE agent_id = ?
         ORDER BY started_at DESC LIMIT 1
      `).get(agentId) as { status: string; started_at: string; trigger: string | null; trigger_type: string | null } | undefined;

      // Skipped runs (readiness/work-check gate blocked them) are not meaningful
      // for "is this agent healthy" — exclude so we don't conclude an agent is
      // fine just because it skipped cleanly N times in a row.
      const recentRuns = db.prepare(`
        SELECT status FROM agent_runs
        WHERE agent_id = ? AND status != 'skipped'
        ORDER BY started_at DESC LIMIT 5
      `).all(agentId) as Array<{ status: string }>;
      const consecutiveFails = recentRuns.findIndex(r => r.status !== 'failed');
      const failing = consecutiveFails === -1 ? recentRuns.length : consecutiveFails;
      const tasksToday = (db.prepare(`
        SELECT COALESCE(SUM(tasks_proposed), 0) as t FROM agent_runs
        WHERE agent_id = ? AND started_at >= ?
      `).get(agentId, todayStart.toISOString()) as { t: number } | undefined)?.t ?? 0;
      const costToday = (db.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) as t FROM agent_runs
        WHERE agent_id = ? AND started_at >= ?
      `).get(agentId, todayStart.toISOString()) as { t: number } | undefined)?.t ?? 0;

      // Derive status — order matters, more specific states first.
      //   pending_hire: template exists but agent is pending (needs connector)
      //   paused:       user or system paused
      //   running:      currently executing
      //   error:        3+ consecutive non-skipped failures
      //   stale:        no completed run in 2× its configured poll interval
      //   sleeping:     last non-skipped run recent OR last run was a skip
      //                 (work-check returned false — conserving tokens)
      //   idle:         default — has completed runs, no work right now
      let status: string;
      const pollIntervalMin = getPollInterval ? getPollInterval(agentId) : 60;
      const msSinceAny = lastAnyRun?.started_at
        ? Date.now() - new Date(lastAnyRun.started_at + (lastAnyRun.started_at.endsWith('Z') ? '' : 'Z')).getTime()
        : Infinity;

      if (a.status === 'pending') status = 'pending_hire';
      else if (a.status === 'paused' || a.status === 'disabled') status = 'paused';
      else if (runningRun) status = 'running';
      else if (failing >= 3) status = 'error';
      else if (Number.isFinite(msSinceAny) && msSinceAny > pollIntervalMin * 2 * 60 * 1000) status = 'stale';
      else if (lastAnyRun?.status === 'skipped') status = 'sleeping';
      else status = 'idle';

      // Surface why the agent is sleeping / what triggered the last run so
      // the panel can render a useful subtitle ("Waiting for pagespeed sync")
      const lastTriggerReason = lastAnyRun?.trigger ?? null;

      return {
        id: a.id,
        name: a.name,
        avatar: AVATARS[agentId] ?? '🤖',
        status,
        last_run: a.last_run,
        last_run_trigger: lastTriggerReason,
        last_run_trigger_type: lastAnyRun?.trigger_type ?? null,
        next_run: null,
        poll_interval_minutes: pollIntervalMin,
        current_task: runningRun ? `Running since ${runningRun.started_at}` : null,
        tasks_proposed_today: tasksToday,
        cost_today_usd: Math.round(costToday * 10000) / 10000,
        consecutive_failures: failing,
      };
    });

    const totalCostToday = (db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as t FROM agent_runs WHERE started_at >= ?"
    ).get(todayStart.toISOString()) as { t: number } | undefined)?.t ?? 0;
    const runsToday = (db.prepare(
      "SELECT COUNT(*) as c FROM agent_runs WHERE started_at >= ? AND status != 'skipped'"
    ).get(todayStart.toISOString()) as { c: number } | undefined)?.c ?? 0;

    const payload = {
      agents: out,
      total_cost_today: Math.round(totalCostToday * 10000) / 10000,
      runs_today: runsToday,
    };

    cache = { expires: Date.now() + 30000, payload };
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
