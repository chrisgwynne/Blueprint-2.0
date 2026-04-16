import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function parseJsonField(val: unknown): unknown {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

/**
 * Fetch the most-recent N rows of a named metric for a business.
 * Limit defaults to 2 (current + prev) for trend cards; pass higher for
 * sparkline series.
 */
function recentMetric(businessId: string, metricName: string, limit = 2): any[] {
  return db.prepare(`
    SELECT metric_value, metric_data, recorded_at
    FROM metrics
    WHERE business_id = ? AND metric_name = ?
    ORDER BY recorded_at DESC
    LIMIT ?
  `).all(businessId, metricName, limit);
}

/** Convert a recentMetric() result to { value, prev, trend }. */
function summary(rows: any[]): { value: number | null; prev: number | null; trend: number | null } {
  const current = rows[0]?.metric_value ?? null;
  const prev    = rows[1]?.metric_value ?? null;
  const trend = (current != null && prev != null && prev !== 0)
    ? Math.round(((current - prev) / Math.abs(prev)) * 100)
    : null;
  return { value: current, prev, trend };
}

/** Sparkline data: oldest → newest list of values. */
function sparkline(businessId: string, metricName: string, days = 14): number[] {
  return db.prepare(`
    SELECT metric_value, recorded_at
    FROM metrics
    WHERE business_id = ?
      AND metric_name = ?
      AND recorded_at >= datetime('now', ?)
    ORDER BY recorded_at ASC
  `).all(businessId, metricName, `-${days} days`)
    .map((r: any) => Number(r.metric_value ?? 0));
}

/** Latest data blob for a metric (used for top_keywords / top_pages arrays). */
function latestData(businessId: string, metricName: string): any | null {
  const row = db.prepare(`
    SELECT metric_data FROM metrics
    WHERE business_id = ? AND metric_name = ?
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId, metricName) as Record<string, unknown> | undefined;
  if (!row?.metric_data) return null;
  try { return JSON.parse(row.metric_data as string); } catch { return null; }
}

/**
 * GET /api/dashboard/:businessId
 * Returns everything the home Dashboard renders: hero metrics with prev/trend,
 * sparkline history, top keywords, top pages, Core Web Vitals, recent
 * signals/tasks/agents.
 */
router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = req.params.businessId as string;

    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    // ─── Headline metrics (Sessions, Organic Sessions, Keywords, Position, PageSpeed) ─
    const sessions       = summary(recentMetric(businessId, 'ga4.sessions'));
    const users          = summary(recentMetric(businessId, 'ga4.users'));
    const conversions    = summary(recentMetric(businessId, 'ga4.conversions'));
    const gscClicks      = summary(recentMetric(businessId, 'gsc.total_clicks'));
    const gscImpressions = summary(recentMetric(businessId, 'gsc.total_impressions'));
    const keywordCount   = summary(recentMetric(businessId, 'gsc.keyword_count'));
    const avgPosition    = summary(recentMetric(businessId, 'gsc.avg_position'));
    const psPerfMobile   = summary(recentMetric(businessId, 'pagespeed.mobile.performance_score'));

    // ─── Core Web Vitals (mobile is the canonical, fall back to desktop) ─────
    const lcp = recentMetric(businessId, 'pagespeed.mobile.lcp_ms', 1)[0]?.metric_value
             ?? recentMetric(businessId, 'pagespeed.desktop.lcp_ms', 1)[0]?.metric_value
             ?? null;
    const cls = recentMetric(businessId, 'pagespeed.mobile.cls', 1)[0]?.metric_value
             ?? recentMetric(businessId, 'pagespeed.desktop.cls', 1)[0]?.metric_value
             ?? null;
    const fid = recentMetric(businessId, 'pagespeed.mobile.fid_ms', 1)[0]?.metric_value
             ?? recentMetric(businessId, 'pagespeed.mobile.tbt_ms', 1)[0]?.metric_value
             ?? null;

    // ─── Sparklines for hero cards (14-day) ──────────────────────────────────
    const history = {
      sessions:         sparkline(businessId, 'ga4.sessions'),
      organic_sessions: sparkline(businessId, 'ga4.sessions'),  // same metric
      keywords:         sparkline(businessId, 'gsc.keyword_count'),
      position:         sparkline(businessId, 'gsc.avg_position'),
      pagespeed:        sparkline(businessId, 'pagespeed.mobile.performance_score'),
      clicks:           sparkline(businessId, 'gsc.total_clicks'),
    };

    // ─── Top keywords (from GSC) ─────────────────────────────────────────────
    // gsc.keywords stores { name, value=count, data=[top 100 keyword objects] }
    const top_keywords = (latestData(businessId, 'gsc.keywords') ?? []).slice(0, 10).map((k: any) => ({
      query: k.query ?? k.keys?.[0] ?? '—',
      clicks: k.clicks ?? 0,
      impressions: k.impressions ?? 0,
      ctr: k.ctr ?? 0,
      position: k.position ?? null,
    }));

    // ─── Top pages (from GA4 if present, otherwise derive from GSC) ──────────
    let top_pages = (latestData(businessId, 'ga4.top_pages') ?? []).slice(0, 10).map((p: any) => ({
      path: p.pagePath ?? p.path ?? p.url ?? '/',
      sessions: p.sessions ?? p.pageviews ?? 0,
      pageviews: p.pageviews ?? p.sessions ?? 0,
      bounceRate: p.bounceRate ?? p.bounce_rate ?? 0,
      conversions: p.conversions ?? 0,
    }));

    if (top_pages.length === 0) {
      // Derive pages from GSC keyword data if GA4 isn't connected
      const gscKw = latestData(businessId, 'gsc.keywords') ?? [];
      const byPage = new Map<string, any>();
      for (const k of gscKw) {
        const url = k.page || k.url;
        if (!url) continue;
        const acc = byPage.get(url) || { path: url, sessions: 0, bounceRate: 0, conversions: 0 };
        acc.sessions += k.clicks ?? 0;
        byPage.set(url, acc);
      }
      top_pages = [...byPage.values()]
        .sort((a: any, b: any) => b.sessions - a.sessions)
        .slice(0, 10);
    }

    // ─── Open signals + recent tasks + agents ────────────────────────────────
    const openSignalsCount = (db.prepare(`
      SELECT COUNT(*) as cnt FROM signals WHERE business_id = ? AND status = 'open'
    `).get(businessId) as Record<string, unknown>)?.cnt ?? 0;
    const pendingTasksCount = (db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks WHERE business_id = ? AND status IN ('proposed', 'approved')
    `).get(businessId) as Record<string, unknown>)?.cnt ?? 0;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    // Exclude 'skipped' runs: an agent that skipped because readiness wasn't
    // met is not meaningful activity for the dashboard counter.
    const agentRunsToday = (db.prepare(`
      SELECT COUNT(*) as cnt FROM agent_runs
      WHERE business_id = ? AND started_at >= ? AND status != 'skipped'
    `).get(businessId, todayStart.toISOString()) as Record<string, unknown>)?.cnt ?? 0;

    const signals = (db.prepare(`
      SELECT s.*, c.type as connector_type, c.name as connector_name
      FROM signals s
      LEFT JOIN connectors c ON c.id = s.connector_id
      WHERE s.business_id = ? AND s.status = 'open'
      ORDER BY s.created_at DESC LIMIT 20
    `).all(businessId) as any[]).map(s => ({ ...s, data: parseJsonField(s.data) }));

    const recent_tasks = (db.prepare(`
      SELECT * FROM tasks
      WHERE business_id = ?
      ORDER BY updated_at DESC LIMIT 10
    `).all(businessId) as any[]).map(t => ({
      ...t,
      action_payload: parseJsonField(t.action_payload),
      outcome_data: parseJsonField(t.outcome_data),
    }));

    const agents = (db.prepare(`
      SELECT * FROM agents WHERE status != 'retired' ORDER BY id ASC
    `).all() as any[]).map(a => ({
      ...a,
      settings_override: parseJsonField(a.settings_override),
    }));

    const lastSync = (db.prepare(`
      SELECT MAX(last_sync) as last_sync FROM connectors WHERE business_id = ?
    `).get(businessId) as Record<string, unknown>)?.last_sync ?? null;

    return res.json({
      business: {
        ...(business as object),
        settings: parseJsonField((business as any).settings),
      },
      metrics: {
        // Headline cards — { value, prev, trend } shape, MetricCard unwraps
        sessions_7d:           sessions,
        organic_sessions:      sessions,             // alias
        organic_keywords:      keywordCount,
        avg_position:          avgPosition,
        pagespeed_score:       psPerfMobile,
        gsc_clicks:            gscClicks,
        gsc_impressions:       gscImpressions,
        users:                 users,
        conversions:           conversions,
        // Plain numbers for the legacy shape some renderers still read
        pagespeed: {
          score: psPerfMobile.value,
          lcp,
          cls,
          fid,
        },
        lcp, cls, fid,
        // Counts
        open_signals: openSignalsCount,
        pending_tasks: pendingTasksCount,
        agent_runs_today: agentRunsToday,
      },
      history,
      top_keywords,
      top_pages,
      signals,
      recent_tasks,
      tasks: recent_tasks,        // alias for any old callers
      agents,
      last_sync: lastSync,
    });
  } catch (err) {
    console.error('[dashboard] Error:', err);
    return res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

export default router;
