import { Router } from 'express';
import { existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { readFileSync } from 'fs';
import { join } from 'path';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { checkAgentReadiness } from '../agents/readiness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');

const router = Router();
router.use(isAuthenticated);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STALE_THRESHOLDS_HOURS = {
  pagespeed: 48,
  gsc: 24,
  ga4: 12,
  shopify: 12,
  uptimerobot: 2,
  stripe: 24,
  github: 24,
  todoist: 2,
  brevo: 24,
  stannp: 72,
  wordpress: 24,
  kirby: 24,
  'google-ads': 24,
  gbp: 24,
};

const POLLING_DEFAULTS_MIN = {
  pagespeed: 1440,
  gsc: 720,
  ga4: 360,
  shopify: 360,
  uptimerobot: 15,
  todoist: 60,
  brevo: 360,
  stannp: 720,
  wordpress: 360,
  kirby: 720,
  'google-ads': 360,
};

const CONNECTOR_LABELS = {
  gsc: 'Google Search Console',
  ga4: 'Google Analytics 4',
  pagespeed: 'PageSpeed',
  shopify: 'Shopify',
  gbp: 'Google Business Profile',
  stripe: 'Stripe',
  github: 'GitHub',
  uptimerobot: 'UptimeRobot',
  todoist: 'Todoist',
  brevo: 'Brevo',
  stannp: 'Stannp',
  wordpress: 'WordPress',
  kirby: 'Kirby',
  'google-ads': 'Google Ads',
};

function getPollingInterval(connector) {
  try {
    if (connector.config) {
      const cfg = JSON.parse(connector.config);
      if (cfg.pollingIntervalMinutes) return Number(cfg.pollingIntervalMinutes);
    }
  } catch {}
  return POLLING_DEFAULTS_MIN[connector.type] ?? 360;
}

function computeConnectorStatus(c, hoursSinceSync, threshold) {
  if (c.status === 'error') return 'error';
  if (c.status === 'disconnected') return 'disconnected';
  if (hoursSinceSync != null && hoursSinceSync > threshold) return 'stale';
  if (c.status === 'connected' || c.status === 'syncing') return 'live';
  if (c.status === 'stale') return 'stale';
  return c.status || 'live';
}

function getAgentProfile(agentId) {
  const path = join(AGENTS_DIR, agentId, 'profile.yaml');
  if (!existsSync(path)) return null;
  try { return yaml.load(readFileSync(path, 'utf8')); } catch { return null; }
}

function getNextRunEstimate(agentId, profile) {
  const agent = db.prepare('SELECT last_run FROM agents WHERE id = ?').get(agentId);
  const lastRun = agent?.last_run ? new Date(agent.last_run).getTime() : 0;
  const jobs = profile?.scheduled_jobs ?? [];
  if (jobs.length === 0) return null;
  // Simple: assume hourly if cron has '*' in hour slot, else daily
  const job = jobs[0];
  if (!job?.cron) return null;
  const parts = String(job.cron).split(' ');
  let intervalMs = 60 * 60 * 1000;
  if (parts[1] === '*') intervalMs = 60 * 60 * 1000;
  else if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*') intervalMs = 24 * 60 * 60 * 1000;
  else if (parts[4] !== '*') intervalMs = 7 * 24 * 60 * 60 * 1000;
  const nextRun = lastRun + intervalMs;
  return nextRun;
}

// ─── GET /api/system/health/full ──────────────────────────────────────────────

router.get('/health/full', async (req, res) => {
  try {
    const checkedAt = new Date().toISOString();

    // ─── Connectors ─────────────────────────────────────────────────────────
    const connectorRows = db.prepare(`
      SELECT c.*, b.name as business_name
      FROM connectors c
      JOIN businesses b ON c.business_id = b.id
      ORDER BY b.name, c.type
    `).all();

    const connectors = connectorRows.map((c) => {
      const threshold = STALE_THRESHOLDS_HOURS[c.type] ?? 24;
      const hoursSince = c.last_sync
        ? (Date.now() - new Date(c.last_sync).getTime()) / 3600000
        : null;
      const status = computeConnectorStatus(c, hoursSince, threshold);

      const pollingMinutes = getPollingInterval(c);
      const lastSyncMs = c.last_sync ? new Date(c.last_sync).getTime() : 0;
      const nextSyncMs = lastSyncMs + pollingMinutes * 60000;
      const nextSyncInMinutes = c.last_sync
        ? Math.round((nextSyncMs - Date.now()) / 60000)
        : null;

      const metricsStored = db.prepare(
        'SELECT COUNT(*) as n FROM metrics WHERE connector_id = ?'
      ).get(c.id)?.n ?? 0;

      const signalsEnabled = db.prepare(
        "SELECT COUNT(DISTINCT rule_id) as n FROM signals WHERE connector_id = ? AND created_at > datetime('now', '-30 days')"
      ).get(c.id)?.n ?? 0;

      return {
        id: c.id,
        type: c.type,
        name: CONNECTOR_LABELS[c.type] ?? c.name ?? c.type,
        business_name: c.business_name,
        business_id: c.business_id,
        status,
        last_sync: c.last_sync,
        hours_since_sync: hoursSince != null ? Math.round(hoursSince * 10) / 10 : null,
        next_sync_in_minutes: nextSyncInMinutes,
        stale_threshold_hours: threshold,
        last_error: c.last_error,
        metrics_stored: metricsStored,
        signals_enabled: signalsEnabled,
      };
    });

    // ─── Agents ─────────────────────────────────────────────────────────────
    const agentRows = db.prepare('SELECT * FROM agents ORDER BY name ASC').all();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    // Readiness is per-business; System Health is a tenant-wide view. Use the
    // first business as the readiness context — the vast majority of
    // installations are single-tenant. Multi-tenant deployments can layer a
    // per-business view on top.
    const primaryBusiness = db.prepare(
      'SELECT id FROM businesses ORDER BY created_at ASC LIMIT 1'
    ).get();

    const agents = agentRows.map((a) => {
      // Skipped runs aren't failures — don't count them toward consecutive
      // failure health state.
      const recentRuns = db.prepare(`
        SELECT status FROM agent_runs
        WHERE agent_id = ? AND status != 'skipped'
        ORDER BY started_at DESC LIMIT 10
      `).all(a.id);

      let consecutiveFailures = 0;
      for (const r of recentRuns) {
        if (r.status === 'failed') consecutiveFailures++;
        else break;
      }

      const sevenDayStats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as success,
               SUM(tasks_proposed) as tasks
        FROM agent_runs
        WHERE agent_id = ? AND started_at >= ? AND status != 'skipped'
      `).get(a.id, sevenDaysAgo);

      const runs7d = sevenDayStats?.total ?? 0;
      const success7d = sevenDayStats?.success ?? 0;
      const successRate = runs7d > 0 ? Math.round((success7d / runs7d) * 100) / 100 : 1.0;

      const lastRunMs = a.last_run ? new Date(a.last_run).getTime() : null;
      const minutesSinceRun = lastRunMs
        ? Math.round((Date.now() - lastRunMs) / 60000)
        : null;

      // Operational status (existing): ok / failing / disabled
      let status = 'ok';
      if (a.status === 'disabled' || a.status === 'paused') status = 'disabled';
      else if (consecutiveFailures >= 3) status = 'failing';

      // Readiness status (new): active / pending / retired / missing_connectors
      // etc. Surfaced alongside operational status so the UI can show
      // "Pending — waiting for GSC" instead of treating a healthy pending
      // agent as idle.
      let readinessStatus = 'active';
      let readinessReason = null;
      let missingRequired = [];
      let missingPreferred = [];
      if (a.status === 'retired') {
        readinessStatus = 'retired';
      } else if (a.status === 'pending') {
        readinessStatus = 'pending';
      } else if (primaryBusiness?.id) {
        try {
          const r = checkAgentReadiness(a.id, primaryBusiness.id);
          if (r.status === 'missing_connectors'
              || r.status === 'connectors_never_synced'
              || r.status === 'connectors_stale') {
            readinessStatus = 'pending';
          } else if (r.status === 'paused') {
            readinessStatus = 'paused';
          } else if (r.status === 'retired') {
            readinessStatus = 'retired';
          } else if (r.status === 'not_installed') {
            readinessStatus = 'not_installed';
          }
          readinessReason = r.reason ?? null;
          missingRequired = r.missing_required ?? [];
          missingPreferred = r.missing_preferred ?? [];
        } catch (err) {
          console.warn(`[system-health] readiness check failed for ${a.id}:`, err.message);
        }
      }

      return {
        id: a.id,
        name: a.name,
        status,                       // operational: ok | failing | disabled
        readiness_status: readinessStatus,  // lifecycle: active | pending | retired | paused | not_installed
        readiness_reason: readinessReason,
        missing_required: missingRequired,
        missing_preferred: missingPreferred,
        last_run: a.last_run,
        minutes_since_run: minutesSinceRun,
        consecutive_failures: consecutiveFailures,
        success_rate_7d: successRate,
        runs_7d: runs7d,
        tasks_proposed_7d: sevenDayStats?.tasks ?? 0,
      };
    });

    // ─── LLM spend ──────────────────────────────────────────────────────────
    const todayCost = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as t FROM cost_daily WHERE date = date('now')"
    ).get()?.t ?? 0;
    const monthCost = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as t FROM cost_daily WHERE date >= date('now', 'start of month')"
    ).get()?.t ?? 0;

    const budgetRow = db.prepare("SELECT value FROM settings WHERE key = 'cost_monthly_budget_usd'").get();
    const budget = budgetRow ? JSON.parse(budgetRow.value) : 20;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const forecastEnd = dayOfMonth > 0 ? (monthCost / dayOfMonth) * daysInMonth : 0;

    // Providers configured
    const providerRows = db.prepare(
      "SELECT key FROM settings WHERE key LIKE 'provider_credentials_%'"
    ).all();
    const providersConfigured = providerRows
      .map(r => r.key.replace('provider_credentials_', ''))
      .filter(Boolean);

    // Primary provider = provider with most spend today, fallback to 'anthropic'
    const primaryProviderRow = db.prepare(
      "SELECT provider, SUM(cost_usd) as total FROM cost_daily WHERE date >= date('now', '-7 days') GROUP BY provider ORDER BY total DESC LIMIT 1"
    ).get();
    const primaryProvider = primaryProviderRow?.provider || providersConfigured[0] || 'anthropic';

    // ─── Database ───────────────────────────────────────────────────────────
    const dbPath = process.env.DATABASE_PATH || resolve(process.cwd(), '../data/blueprint.db');
    let dbSizeMB = 0;
    let walSizeMB = 0;
    try { dbSizeMB = Math.round(statSync(dbPath).size / 1048576 * 10) / 10; } catch {}
    try {
      if (existsSync(dbPath + '-wal')) {
        walSizeMB = Math.round(statSync(dbPath + '-wal').size / 1048576 * 10) / 10;
      }
    } catch {}
    const tableCount = db.prepare(
      "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'"
    ).get()?.n ?? 0;

    let dbStatus = 'ok';
    try { db.prepare('SELECT 1').get(); } catch { dbStatus = 'error'; }

    // ─── KB ─────────────────────────────────────────────────────────────────
    let kbStats = { total_pages: 0, pending_review: 0, open_contradictions: 0, last_ingest: null, git_commits: 0 };
    try {
      const totalPages = db.prepare('SELECT COUNT(*) as n FROM kb_docs').get()?.n ?? 0;
      kbStats.total_pages = totalPages;

      // Get last_ingest from any business kb_config setting
      const kbConfigs = db.prepare(
        "SELECT value FROM settings WHERE key LIKE 'kb_config_%'"
      ).all();
      let lastIngest = null;
      for (const row of kbConfigs) {
        try {
          const cfg = JSON.parse(row.value);
          if (cfg.last_ingest && (!lastIngest || cfg.last_ingest > lastIngest)) {
            lastIngest = cfg.last_ingest;
          }
        } catch {}
      }
      kbStats.last_ingest = lastIngest;
    } catch {}

    // ─── Scheduler ──────────────────────────────────────────────────────────
    const jobsFailed24h = db.prepare(
      "SELECT COUNT(*) as n FROM agent_runs WHERE status = 'failed' AND started_at > datetime('now', '-24 hours')"
    ).get()?.n ?? 0;

    const agentsPaused = JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key = 'agents_globally_paused'").get()?.value ?? 'false'
    );

    // Build next scheduled runs list
    const nextRuns = [];
    for (const c of connectorRows) {
      if (c.status === 'disconnected') continue;
      const pollingMin = getPollingInterval(c);
      const lastSyncMs = c.last_sync ? new Date(c.last_sync).getTime() : 0;
      const nextMs = lastSyncMs + pollingMin * 60000;
      nextRuns.push({
        job_id: `connector_sync_${c.type}`,
        label: `${CONNECTOR_LABELS[c.type] ?? c.type} sync (${c.business_name})`,
        next_run: new Date(nextMs).toISOString(),
        minutes_until: Math.round((nextMs - Date.now()) / 60000),
      });
    }
    for (const a of agentRows) {
      if (a.status !== 'active') continue;
      const profile = getAgentProfile(a.id);
      if (!profile?.scheduled_jobs?.length) continue;
      const nextMs = getNextRunEstimate(a.id, profile);
      if (nextMs == null) continue;
      nextRuns.push({
        job_id: `agent_run_${a.id}`,
        label: `${a.name} scheduled run`,
        next_run: new Date(nextMs).toISOString(),
        minutes_until: Math.round((nextMs - Date.now()) / 60000),
      });
    }
    nextRuns.sort((a, b) => a.minutes_until - b.minutes_until);

    // ─── Overall status ─────────────────────────────────────────────────────
    const hasError = connectors.some(c => c.status === 'error');
    const hasStale = connectors.some(c => c.status === 'stale');
    const criticalAgent = agents.some(a => a.consecutive_failures >= 3);
    const failingAgent = agents.some(a => a.status === 'failing');
    const budgetPct = budget > 0 ? Math.round((monthCost / budget) * 100) : 0;

    let overall = 'healthy';
    if (hasError || criticalAgent || budgetPct >= 100) {
      overall = 'critical';
    } else if (hasStale || failingAgent || budgetPct >= 80 || agentsPaused) {
      overall = 'degraded';
    }

    res.json({
      overall,
      checked_at: checkedAt,
      connectors,
      agents,
      llm: {
        today_usd: Math.round(todayCost * 100) / 100,
        month_usd: Math.round(monthCost * 100) / 100,
        budget_usd: budget,
        budget_pct: budgetPct,
        forecast_month_end_usd: Math.round(forecastEnd * 100) / 100,
        providers_configured: providersConfigured,
        primary_provider: primaryProvider,
      },
      database: {
        status: dbStatus,
        size_mb: dbSizeMB,
        tables: tableCount,
        wal_size_mb: walSizeMB,
      },
      kb: kbStats,
      scheduler: {
        status: agentsPaused ? 'paused' : 'running',
        jobs_registered: nextRuns.length,
        jobs_failed_24h: jobsFailed24h,
        next_runs: nextRuns.slice(0, 5),
        jobs_with_constraints: db.prepare(
          "SELECT COUNT(*) AS n FROM scheduler_log WHERE decision='delayed' AND created_at > datetime('now','-7 days')"
        ).get()?.n ?? 0,
        recent_decisions: db.prepare(
          "SELECT job_name, decision, reason, delayed_to, created_at FROM scheduler_log ORDER BY created_at DESC LIMIT 20"
        ).all(),
      },
    });
  } catch (err) {
    console.error('[system-health] error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
