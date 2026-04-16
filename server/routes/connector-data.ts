import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { decrypt } from '../crypto.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function parseConnector(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  let credentials: Record<string, unknown> = {};
  try { credentials = JSON.parse(decrypt(row['credentials'] as string)); } catch {}
  return { ...row, credentials, config: row['config'] ? JSON.parse(row['config'] as string) : {} };
}

interface DateRange {
  days: number;
  start: string;
  end: string;
  prevStart: string;
  prevEnd: string;
}

function getDateRange(range: string): DateRange {
  const now = new Date();

  // How many days back to query the metrics table for snapshots.
  // Short ranges (today/yesterday) still need to look back 7 days so we
  // always capture the most recent sync snapshot — recorded_at is the sync
  // timestamp, not the data date. Frontend does the actual date filtering.
  const queryDays = (range === 'today' || range === 'yesterday') ? 7
    : range === '7d' ? 7
    : range === '14d' ? 14
    : 30;

  const start = new Date(now.getTime() - queryDays * 86400000);
  const prevStart = new Date(start.getTime() - queryDays * 86400000);
  return {
    days: queryDays,
    start: start.toISOString(),
    end: now.toISOString(),
    prevStart: prevStart.toISOString(),
    prevEnd: start.toISOString(),
  };
}

/**
 * GET /api/connector-data/:connectorId?range=28d
 */
router.get('/:connectorId', (req: Request, res: Response) => {
  try {
    const connectorId = req.params['connectorId'] as string;
    const range = String(req.query['range'] ?? '28d');

    const connector = db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId) as Record<string, unknown> | null;
    if (!connector) return res.status(404).json({ error: 'Connector not found.' });

    const { start, end, prevStart, prevEnd, days } = getDateRange(range);

    // Get all metrics for this connector in range
    const currentMetrics = db.prepare(`
      SELECT metric_name, metric_value, metric_data, period_start, period_end, recorded_at
      FROM metrics WHERE connector_id = ? AND recorded_at >= ? AND recorded_at <= ?
      ORDER BY recorded_at DESC
    `).all(connectorId, start, end) as Record<string, unknown>[];

    const prevMetrics = db.prepare(`
      SELECT metric_name, metric_value, metric_data, period_start, period_end, recorded_at
      FROM metrics WHERE connector_id = ? AND recorded_at >= ? AND recorded_at <= ?
      ORDER BY recorded_at DESC
    `).all(connectorId, prevStart, prevEnd) as Record<string, unknown>[];

    // Parse metric_data JSON
    const parseMetrics = (rows: Record<string, unknown>[]): any[] => rows.map(r => ({
      ...r,
      metric_data: r['metric_data'] ? JSON.parse(r['metric_data'] as string) : null,
    }));

    // Helper: get latest value for a metric name.
    // If the row has parsed metric_data (non-null), return that (array/object).
    // Otherwise return the scalar metric_value.
    const latest = (metrics: any[], name: string): unknown => {
      const row = metrics.find((m: any) => m.metric_name === name);
      if (!row) return null;
      if (row.metric_data !== null && row.metric_data !== undefined) return row.metric_data;
      return row.metric_value ?? null;
    };

    // Helper: get all rows for a metric, sorted by date
    const series = (metrics: any[], name: string): any[] => metrics
      .filter((m: any) => m.metric_name === name)
      .sort((a: any, b: any) => new Date(a.recorded_at as string).getTime() - new Date(b.recorded_at as string).getTime());

    const current = parseMetrics(currentMetrics);
    const prev = parseMetrics(prevMetrics);

    // Build latest/series objects keyed by the raw metric_name, then merge
    // in canonical aliases so the per-connector renderers can look up by
    // the short name they expect (e.g. 'clicks' in addition to
    // 'gsc.total_clicks'). Aliases never overwrite existing real entries.
    const latestObj: Record<string, unknown> = Object.fromEntries(
      [...new Set((current as any[]).map((m: any) => m.metric_name as string))]
        .map(name => [name, latest(current, name)])
    );
    const seriesObj: Record<string, unknown> = Object.fromEntries(
      [...new Set((current as any[]).map((m: any) => m.metric_name as string))]
        .map(name => [name, series(current, name)])
    );
    const aliases: Record<string, string> = (ALIASES as any)[connector['type'] as string] || {};
    // For each alias, walk the raw rows to find the underlying metric and
    // pick the right shape: scalar metric_value if it's a number (so score
    // and rate aliases resolve to numbers), otherwise the parsed
    // metric_data (so list aliases like top_pages/keywords resolve to
    // arrays). The bare 'latest' map keeps the previous behaviour for
    // legacy callers.
    for (const [shortName, realName] of Object.entries(aliases)) {
      if (latestObj[shortName] === undefined) {
        const row = (current as any[]).find((m: any) => m.metric_name === realName);
        if (row) {
          // Prefer the scalar value when it's a non-null number — those
          // are the score/rate/count style metrics. Fall back to the
          // parsed data blob otherwise (top_pages, campaigns_data, etc.).
          const v = (row.metric_value !== null && row.metric_value !== undefined)
            ? row.metric_value
            : row.metric_data;
          latestObj[shortName] = v;
        }
      }
      if (seriesObj[shortName] === undefined && seriesObj[realName] !== undefined) {
        seriesObj[shortName] = seriesObj[realName];
      }
    }

    // Also expose array-style data fields under their "_data" suffix names
    // because some legacy renderers read latest['top_pages_data'] etc. We
    // give both naming conventions so future cleanup is non-breaking.
    for (const [shortName, realName] of Object.entries(aliases)) {
      const row = (current as any[]).find((m: any) => m.metric_name === realName);
      if (row?.metric_data && Array.isArray(row.metric_data)) {
        const dataAlias = `${shortName}_data`;
        if (latestObj[dataAlias] === undefined) latestObj[dataAlias] = row.metric_data;
      }
    }

    return res.json({
      connector: {
        id: connector['id'],
        business_id: connector['business_id'],
        type: connector['type'],
        name: connector['name'],
        status: connector['status'],
        last_sync: connector['last_sync'],
        config: connector['config'] ? JSON.parse(connector['config'] as string) : {},
      },
      range,
      days,
      period: { start, end },
      metrics: {
        current,
        previous: prev,
        latest: latestObj,
        series: seriesObj,
      },
      summary: buildSummary(connector['type'] as string, current, prev, aliases),
    });
  } catch (err) {
    console.error('[connector-data] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch connector data.' });
  }
});

// Map short canonical names that the frontend renderers expect to the
// real prefixed metric_name each connector writes. Only listed mappings
// get aliased; unlisted shorthand stays unresolved.
const ALIASES: Record<string, Record<string, string>> = {
  gsc: {
    clicks: 'gsc.total_clicks',
    clicks_prev: 'gsc.total_clicks_prev',
    impressions: 'gsc.total_impressions',
    impressions_prev: 'gsc.total_impressions_prev',
    ctr: 'gsc.avg_ctr',
    position: 'gsc.avg_position',
    keywords: 'gsc.keywords',
    keyword_count: 'gsc.keyword_count',
    keywords_up: 'gsc.keywords_up',
    keywords_down: 'gsc.keywords_down',
    opportunities: 'gsc.opportunities',
  },
  ga4: {
    sessions: 'ga4.sessions',
    sessions_prev: 'ga4.sessions_prev',
    users: 'ga4.users',
    users_prev: 'ga4.users_prev',
    bounce_rate: 'ga4.bounce_rate',
    conversions: 'ga4.conversions',
    conversions_prev: 'ga4.conversions_prev',
    top_pages: 'ga4.top_pages',
    pages: 'ga4.top_pages',           // renderer reads latest['pages_data']
    traffic_sources: 'ga4.traffic_sources',
    acquisition: 'ga4.traffic_sources', // renderer reads latest['acquisition_data']
  },
  brevo: {
    total_contacts: 'brevo.total_contacts',
    campaigns_sent_30d: 'brevo.campaigns_sent_30d',
    avg_open_rate: 'brevo.avg_open_rate',
    avg_click_rate: 'brevo.avg_click_rate',
    avg_unsubscribe_rate: 'brevo.avg_unsubscribe_rate',
    avg_bounce_rate: 'brevo.avg_bounce_rate',
    transactional_delivered_7d: 'brevo.transactional_delivered_7d',
    transactional_bounce_rate_7d: 'brevo.transactional_bounce_rate_7d',
    campaigns_data: 'brevo.campaigns_data',
    lists_data: 'brevo.lists_data',
  },
  pagespeed: {
    performance_mobile: 'pagespeed.mobile.performance_score',
    performance_desktop: 'pagespeed.desktop.performance_score',
    seo_mobile: 'pagespeed.mobile.seo_score',
    seo_desktop: 'pagespeed.desktop.seo_score',
    accessibility_mobile: 'pagespeed.mobile.accessibility_score',
    accessibility_desktop: 'pagespeed.desktop.accessibility_score',
    best_practices_mobile: 'pagespeed.mobile.best_practices_score',
    best_practices_desktop: 'pagespeed.desktop.best_practices_score',
    lcp_mobile: 'pagespeed.mobile.lcp_ms',
    lcp_desktop: 'pagespeed.desktop.lcp_ms',
    cls_mobile: 'pagespeed.mobile.cls',
    cls_desktop: 'pagespeed.desktop.cls',
    fid_mobile: 'pagespeed.mobile.fid_ms',
    fcp_mobile: 'pagespeed.mobile.fcp_ms',
    ttfb_mobile: 'pagespeed.mobile.ttfb_ms',
    tbt_mobile: 'pagespeed.mobile.tbt_ms',
    opportunities_mobile: 'pagespeed.mobile.opportunities',
    opportunities_desktop: 'pagespeed.desktop.opportunities',
  },
};

function buildSummary(
  type: string,
  current: any[],
  prev: any[],
  aliases: Record<string, string> = {},
): Record<string, unknown> {
  const latestOf = (metrics: any[], name: string): unknown => {
    const realName = aliases[name] || name;
    return (metrics.find((m: any) => m.metric_name === realName)?.metric_value) ?? null;
  };

  if (type === 'ga4') {
    return {
      sessions: latestOf(current, 'sessions'),
      sessions_prev: latestOf(prev, 'sessions'),
      users: latestOf(current, 'users'),
      bounce_rate: latestOf(current, 'bounce_rate'),
      avg_session_duration: latestOf(current, 'avg_session_duration'),
      pageviews: latestOf(current, 'pageviews'),
    };
  }
  if (type === 'gsc') {
    return {
      clicks: latestOf(current, 'clicks'),
      clicks_prev: latestOf(prev, 'clicks'),
      impressions: latestOf(current, 'impressions'),
      ctr: latestOf(current, 'ctr'),
      position: latestOf(current, 'position'),
    };
  }
  if (type === 'pagespeed') {
    return {
      performance_mobile: latestOf(current, 'performance_mobile'),
      performance_desktop: latestOf(current, 'performance_desktop'),
      seo_mobile: latestOf(current, 'seo_mobile'),
      accessibility_mobile: latestOf(current, 'accessibility_mobile'),
      lcp_mobile: latestOf(current, 'lcp_mobile'),
      cls_mobile: latestOf(current, 'cls_mobile'),
    };
  }
  if (type === 'shopify') {
    return {
      revenue: latestOf(current, 'revenue'),
      revenue_prev: latestOf(prev, 'revenue'),
      orders: latestOf(current, 'orders'),
      orders_prev: latestOf(prev, 'orders'),
      aov: latestOf(current, 'aov'),
      customers: latestOf(current, 'customers'),
    };
  }
  if (type === 'stripe') {
    return {
      mrr: latestOf(current, 'mrr'),
      mrr_prev: latestOf(prev, 'mrr'),
      arr: latestOf(current, 'arr'),
      churn_rate: latestOf(current, 'churn_rate'),
      active_customers: latestOf(current, 'active_customers'),
    };
  }
  if (type === 'github') {
    return {
      open_prs: latestOf(current, 'open_prs'),
      merged_prs_7d: latestOf(current, 'merged_prs_7d'),
      open_issues: latestOf(current, 'open_issues'),
      commits_7d: latestOf(current, 'commits_7d'),
    };
  }
  if (type === 'brevo') {
    return {
      total_contacts: latestOf(current, 'total_contacts'),
      campaigns_sent_30d: latestOf(current, 'campaigns_sent_30d'),
      avg_open_rate: latestOf(current, 'avg_open_rate'),
      avg_open_rate_prev: latestOf(prev, 'avg_open_rate'),
      avg_click_rate: latestOf(current, 'avg_click_rate'),
      avg_unsubscribe_rate: latestOf(current, 'avg_unsubscribe_rate'),
      avg_bounce_rate: latestOf(current, 'avg_bounce_rate'),
      transactional_delivered_7d: latestOf(current, 'transactional_delivered_7d'),
      transactional_bounce_rate_7d: latestOf(current, 'transactional_bounce_rate_7d'),
    };
  }
  return {};
}

export default router;
