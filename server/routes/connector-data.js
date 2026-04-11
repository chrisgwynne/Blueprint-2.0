import { Router } from 'express';
import db from '../db/db.js';
import { decrypt } from '../crypto.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function parseConnector(row) {
  if (!row) return null;
  let credentials = {};
  try { credentials = JSON.parse(decrypt(row.credentials)); } catch {}
  return { ...row, credentials, config: row.config ? JSON.parse(row.config) : {} };
}

function getDateRange(range) {
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
router.get('/:connectorId', (req, res) => {
  try {
    const { connectorId } = req.params;
    const range = req.query.range || '28d';

    const connector = db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId);
    if (!connector) return res.status(404).json({ error: 'Connector not found.' });

    const { start, end, prevStart, prevEnd, days } = getDateRange(range);

    // Get all metrics for this connector in range
    const currentMetrics = db.prepare(`
      SELECT metric_name, metric_value, metric_data, period_start, period_end, recorded_at
      FROM metrics WHERE connector_id = ? AND recorded_at >= ? AND recorded_at <= ?
      ORDER BY recorded_at DESC
    `).all(connectorId, start, end);

    const prevMetrics = db.prepare(`
      SELECT metric_name, metric_value, metric_data, period_start, period_end, recorded_at
      FROM metrics WHERE connector_id = ? AND recorded_at >= ? AND recorded_at <= ?
      ORDER BY recorded_at DESC
    `).all(connectorId, prevStart, prevEnd);

    // Parse metric_data JSON
    const parseMetrics = (rows) => rows.map(r => ({
      ...r,
      metric_data: r.metric_data ? JSON.parse(r.metric_data) : null,
    }));

    // Helper: get latest value for a metric name.
    // If the row has parsed metric_data (non-null), return that (array/object).
    // Otherwise return the scalar metric_value.
    const latest = (metrics, name) => {
      const row = metrics.find(m => m.metric_name === name);
      if (!row) return null;
      if (row.metric_data !== null && row.metric_data !== undefined) return row.metric_data;
      return row.metric_value ?? null;
    };

    // Helper: get all rows for a metric, sorted by date
    const series = (metrics, name) => metrics
      .filter(m => m.metric_name === name)
      .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));

    const current = parseMetrics(currentMetrics);
    const prev = parseMetrics(prevMetrics);

    return res.json({
      connector: {
        id: connector.id,
        business_id: connector.business_id,
        type: connector.type,
        name: connector.name,
        status: connector.status,
        last_sync: connector.last_sync,
        config: connector.config ? JSON.parse(connector.config) : {},
      },
      range,
      days,
      period: { start, end },
      metrics: {
        current,
        previous: prev,
        latest: Object.fromEntries(
          [...new Set(current.map(m => m.metric_name))]
            .map(name => [name, latest(current, name)])
        ),
        series: Object.fromEntries(
          [...new Set(current.map(m => m.metric_name))]
            .map(name => [name, series(current, name)])
        ),
      },
      summary: buildSummary(connector.type, current, prev),
    });
  } catch (err) {
    console.error('[connector-data] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch connector data.' });
  }
});

function buildSummary(type, current, prev) {
  const latestOf = (metrics, name) => metrics.find(m => m.metric_name === name)?.metric_value ?? null;

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
  return {};
}

export default router;
