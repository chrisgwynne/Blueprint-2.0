/**
 * Brain — Seasonal awareness.
 *
 * Learns day-of-week patterns per metric after ≥60 data points and
 * exposes isWithinSeasonalVariation() so the signal engine can avoid
 * firing on expected weekly fluctuations.
 */
import crypto from 'crypto';
import db from '../db/db.js';

const METRICS_TO_LEARN = [
  'ga4.sessions',
  'gsc.total_clicks',
  'shopify.revenue',
  'shopify.order_count_30d',
  'meta-ads.roas',
];

/**
 * Detect weekly (day-of-week) patterns per metric. Stores learned
 * multipliers in seasonal_patterns. Returns count of patterns learned.
 */
export async function detectSeasonalPatterns(businessId) {
  let learned = 0;

  for (const metric of METRICS_TO_LEARN) {
    const history = db.prepare(`
      SELECT metric_value, recorded_at FROM metrics
      WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
        AND recorded_at > datetime('now', '-180 days')
      ORDER BY recorded_at ASC
    `).all(businessId, metric);

    if (history.length < 60) continue;

    const dowBuckets = {};
    for (const row of history) {
      const dow = new Date(row.recorded_at).getDay();
      if (!dowBuckets[dow]) dowBuckets[dow] = [];
      dowBuckets[dow].push(Number(row.metric_value));
    }

    const totalAvg = history.reduce((s, r) => s + Number(r.metric_value), 0) / history.length;
    if (totalAvg === 0) continue;
    const multipliers = {};
    for (const [dow, values] of Object.entries(dowBuckets)) {
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      multipliers[`dow_${dow}`] = avg / totalAvg;
    }

    db.prepare(`
      INSERT OR REPLACE INTO seasonal_patterns
      (id, business_id, metric_name, pattern_type, pattern_data, confidence, data_points, last_updated)
      VALUES (?, ?, ?, 'weekly', ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      crypto.randomUUID(), businessId, metric,
      JSON.stringify(multipliers),
      Math.min(0.9, history.length / 200),
      history.length
    );
    learned++;
  }

  if (learned > 0) console.log(`[brain] Learned ${learned} seasonal patterns for business ${businessId.slice(0, 8)}`);
  return learned;
}

/**
 * Is `changePct` within expected seasonal variation for the current day of week?
 * Returns true if the change is plausibly "normal weekly fluctuation".
 */
export function isWithinSeasonalVariation(metric, changePct, businessId) {
  const row = db.prepare(
    'SELECT pattern_data, confidence FROM seasonal_patterns WHERE business_id = ? AND metric_name = ? AND pattern_type = ?'
  ).get(businessId, metric, 'weekly');
  if (!row || row.confidence < 0.6) return false;

  let multipliers;
  try { multipliers = JSON.parse(row.pattern_data); } catch { return false; }

  const today = new Date().getDay();
  const todayMult = multipliers[`dow_${today}`] ?? 1;
  const expectedVariationPct = Math.abs(1 - todayMult) * 100;
  return Math.abs(changePct) < expectedVariationPct * 1.5;
}
