/**
 * Baselines — the immutable "before" snapshot.
 *
 * When a connector first syncs for a business, we record the current values
 * of its key metrics as the baseline. Every ROI comparison Blueprint makes
 * is against these values. They are never overwritten; if one looks wrong,
 * a correction note goes into `context` instead.
 *
 * Capture is idempotent via the unique (business_id, metric_name) index:
 * the connector's first successful sync wins, subsequent syncs silently
 * skip. This means we can safely call captureBaselinesForConnector() from
 * the post-sync hook on every sync and only ever record the first.
 *
 * Per-connector baseline metric lists are derived from what each connector
 * actually stores in the metrics table — we don't manufacture numbers.
 */

import db, { generateId } from '../db/db.js';

// Which metrics qualify as "baseline-worthy" per connector type.
// Stored metrics that aren't in this list still flow through the normal
// metrics table; we just don't lock them down as a reference baseline.
const BASELINE_METRICS_BY_CONNECTOR = {
  shopify: [
    'shopify.revenue_30d',
    'shopify.orders_30d',
    'shopify.aov',
    'shopify.conversion_rate',
  ],
  stripe: [
    'stripe.mrr',
    'stripe.churn_rate',
    'stripe.ltv',
    'stripe.active_subscriptions',
    'stripe.revenue_30d',
  ],
  ga4: [
    'ga4.sessions_30d',
    'ga4.sessions',
    'ga4.bounce_rate',
    'ga4.avg_session_duration',
    'ga4.conversions_30d',
  ],
  gsc: [
    'gsc.total_clicks_30d',
    'gsc.total_clicks',
    'gsc.avg_position',
    'gsc.total_impressions',
    'gsc.avg_ctr',
  ],
  pagespeed: [
    'pagespeed.mobile.performance_score',
    'pagespeed.mobile.lcp_ms',
    'pagespeed.mobile.tti_ms',
    'pagespeed.mobile.cls',
    'pagespeed.desktop.performance_score',
  ],
  'meta-ads': [
    'meta-ads.roas',
    'meta-ads.spend_30d',
    'meta-ads.revenue_30d',
    'meta-ads.cpa',
    'meta-ads.ctr',
  ],
  klaviyo: [
    'klaviyo.attributed_revenue_30d',
    'klaviyo.open_rate',
    'klaviyo.subscriber_count',
    'klaviyo.click_rate',
  ],
  gbp: [
    'gbp.views_total_30d',
    'gbp.views_total',
    'gbp.actions_phone_30d',
    'gbp.actions_directions_30d',
    'gbp.reviews_avg_rating',
    'gbp.reviews_count',
  ],
  uptimerobot: [
    'uptimerobot.uptime_pct_30d',
    'uptimerobot.avg_response_ms',
  ],
  semrush: [
    'semrush.organic_traffic_estimate',
    'semrush.organic_keywords',
  ],
};

/**
 * Record a baseline row if one doesn't already exist for this metric.
 * Returns the baseline row id on first record, null if a baseline already
 * existed (we don't overwrite).
 */
export function recordBaseline({
  businessId, metricName, value, sourceConnector = null, context = null, date = null,
}) {
  if (!businessId || !metricName || value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  const existing = db.prepare(
    'SELECT id FROM baselines WHERE business_id = ? AND metric_name = ?'
  ).get(businessId, metricName);
  if (existing) return null; // immutability — first capture wins

  const id = generateId();
  const isoDate = date ?? new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO baselines (
        id, business_id, metric_name, baseline_value,
        baseline_date, source_connector, context, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(id, businessId, metricName, Number(value), isoDate, sourceConnector, context);
    return id;
  } catch (err) {
    // Race: two syncs hit at once. Acceptable — the other won.
    if (/UNIQUE constraint/i.test(err.message)) return null;
    console.warn('[baselines] recordBaseline failed:', err.message);
    return null;
  }
}

/**
 * Capture baselines for a connector type by reading the most recent value
 * of each of its baseline-worthy metrics from the metrics table. Idempotent
 * via the unique index — only the first sync per metric records anything.
 *
 * Call this from the post-sync hook. Non-blocking.
 *
 * @returns {{ recorded: number, skipped: number }}
 */
export function captureBaselinesForConnector(businessId, connectorType) {
  if (!businessId || !connectorType) return { recorded: 0, skipped: 0 };

  const metrics = BASELINE_METRICS_BY_CONNECTOR[connectorType] ?? [];
  if (metrics.length === 0) return { recorded: 0, skipped: 0 };

  // Check how many days ago Blueprint was installed for this business.
  // If it's more than 0 days, we note that in the context so the user
  // knows this baseline is post-install (not a true pre-Blueprint picture).
  const biz = db.prepare('SELECT created_at FROM businesses WHERE id = ?').get(businessId);
  let context = null;
  if (biz?.created_at) {
    const installMs = new Date(biz.created_at.endsWith('Z') ? biz.created_at : biz.created_at + 'Z').getTime();
    const days = Math.round((Date.now() - installMs) / 86400000);
    if (days > 0) context = `Connector activated ${days} day${days === 1 ? '' : 's'} after Blueprint installation.`;
  }

  let recorded = 0, skipped = 0;
  for (const metricName of metrics) {
    const latest = db.prepare(`
      SELECT metric_value, recorded_at
        FROM metrics
       WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
       ORDER BY recorded_at DESC
       LIMIT 1
    `).get(businessId, metricName);
    if (!latest) continue; // connector hasn't actually produced this metric yet

    const id = recordBaseline({
      businessId,
      metricName,
      value: latest.metric_value,
      sourceConnector: connectorType,
      context,
      date: latest.recorded_at,
    });
    if (id) recorded += 1; else skipped += 1;
  }
  return { recorded, skipped };
}

/**
 * Return all baselines for a business. Newest-first.
 */
export function getBaselines(businessId) {
  if (!businessId) return [];
  try {
    return db.prepare(`
      SELECT * FROM baselines
       WHERE business_id = ?
       ORDER BY baseline_date DESC
    `).all(businessId);
  } catch {
    return [];
  }
}

/**
 * Lookup a specific metric's baseline. Returns null when not captured yet.
 */
export function getBaseline(businessId, metricName) {
  if (!businessId || !metricName) return null;
  try {
    return db.prepare(
      'SELECT * FROM baselines WHERE business_id = ? AND metric_name = ?'
    ).get(businessId, metricName) ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the current value of a metric (latest metrics row).
 * Paired with getBaseline to compute observed change.
 */
export function getCurrentMetric(businessId, metricName) {
  try {
    return db.prepare(`
      SELECT metric_value as value, recorded_at as at
        FROM metrics
       WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
       ORDER BY recorded_at DESC
       LIMIT 1
    `).get(businessId, metricName) ?? null;
  } catch {
    return null;
  }
}

// Re-export so downstream modules can enumerate
export { BASELINE_METRICS_BY_CONNECTOR };
