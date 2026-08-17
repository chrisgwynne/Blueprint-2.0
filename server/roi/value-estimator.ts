/**
 * Value estimator — convert a metric change into an estimated £/$ monthly
 * value so ROI can be expressed in currency.
 *
 * Rules of engagement:
 *   - Direct revenue metrics (shopify.revenue_30d, stripe.mrr, etc.) map
 *     1:1 to money — HIGH confidence.
 *   - Conversion-rate / traffic changes convert via the business's own
 *     AOV + traffic baselines when present — MEDIUM confidence.
 *   - Proxy metrics (PageSpeed, avg ranking position) use conservative
 *     industry-benchmark coefficients — LOW confidence, stated explicitly.
 *   - If we don't have enough context to quote a number honestly, we say
 *     so and return estimated_usd_per_month: null. No guessing.
 *
 * The estimator never returns false certainty. Every result carries a
 * confidence level and an `assumptions` string the UI renders verbatim.
 */

import db from '../db/db.js';
import { getBaseline } from './baselines.js';

// Metrics where a lower value is better. Copied from outcomes.js so the sign
// of `change` gets interpreted correctly for things like LCP and avg_position.
const LOWER_IS_BETTER = new Set([
  'pagespeed.mobile.lcp_ms',
  'pagespeed.desktop.lcp_ms',
  'pagespeed.mobile.tti_ms',
  'pagespeed.mobile.cls',
  'ga4.bounce_rate',
  'gsc.avg_position',
  'stripe.churn_rate',
  'uptimerobot.avg_response_ms',
  'meta-ads.cpa',
]);

// Metrics that ARE the money. One dollar of change = one dollar of value.
const DIRECT_REVENUE_METRICS = new Set([
  'shopify.revenue_30d',
  'stripe.mrr',
  'stripe.revenue_30d',
  'meta-ads.revenue_30d',
  'klaviyo.attributed_revenue_30d',
]);

/**
 * How a currency figure for a metric was arrived at.
 *
 *   measured_revenue  the metric IS money that was actually observed
 *                     (DIRECT_REVENUE_METRICS above) — one dollar of change
 *                     is one dollar of value, HIGH confidence.
 *   estimated_proxy   the metric is not money, and a dollar figure was
 *                     derived from it via AOV/traffic baselines or industry
 *                     benchmark coefficients — MEDIUM/LOW confidence.
 *
 * Exported because a currency total is only additive or rankable against
 * another one derived the SAME way. A shop's measured revenue delta and a
 * service business's benchmark-derived lead value are both "$/month" and
 * are not the same kind of number; anything comparing businesses (see
 * server/portfolio/portfolio-comparison.ts, #71) must be able to tell them
 * apart rather than summing them. Kept here because this module owns the
 * knowledge of which metrics are money.
 */
export type ValuationBasis = 'measured_revenue' | 'estimated_proxy';

export function valuationBasisForMetric(metricName: string | null | undefined): ValuationBasis {
  return metricName && DIRECT_REVENUE_METRICS.has(metricName) ? 'measured_revenue' : 'estimated_proxy';
}

export interface ValueEstimate {
  estimated_usd_per_month: number | null;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  direction: 'improved' | 'worsened' | 'flat';
  reasoning: string;
  assumptions: string[];
}

interface EstimateOpts {
  metricName: string;
  baselineValue: number | null;
  currentValue: number | null;
  businessId: string;
}

/**
 * Estimate the monthly $ value of a metric change.
 */
export function estimateMonthlyValue({ metricName, baselineValue, currentValue, businessId }: EstimateOpts): ValueEstimate {
  if (!metricName || baselineValue == null || currentValue == null) {
    return emptyResult('missing inputs');
  }

  const lowerBetter = LOWER_IS_BETTER.has(metricName);
  const diff = currentValue - baselineValue;
  const direction: 'improved' | 'worsened' | 'flat' =
    Math.abs(diff) < Math.abs(baselineValue) * 0.001 ? 'flat' :
    (lowerBetter ? diff < 0 : diff > 0) ? 'improved' : 'worsened';

  // 1. Direct revenue metrics — HIGH confidence, straight subtraction.
  if (DIRECT_REVENUE_METRICS.has(metricName)) {
    // stripe.mrr is already monthly; others are 30-day running totals ~= monthly.
    const monthlyValue = diff;
    return {
      estimated_usd_per_month: Math.round(monthlyValue * 100) / 100,
      confidence: 'high',
      direction,
      reasoning: `Direct revenue metric: baseline ${formatMoney(baselineValue)} → current ${formatMoney(currentValue)} ` +
                 `= ${formatMoney(monthlyValue, true)} per month.`,
      assumptions: ['Metric is already in monthly currency terms.'],
    };
  }

  // 2. Conversion-rate changes — need traffic + AOV from baselines.
  if (metricName === 'shopify.conversion_rate' || metricName === 'ga4.conversion_rate') {
    return valueFromConversionRate(businessId, baselineValue, currentValue, direction);
  }

  // 3. Traffic metrics — need conversion rate + AOV.
  if (metricName === 'ga4.sessions_30d' || metricName === 'ga4.sessions' || metricName === 'gsc.total_clicks_30d' || metricName === 'gsc.total_clicks') {
    return valueFromTraffic(businessId, baselineValue, currentValue, direction, metricName);
  }

  // 4. PageSpeed / Core Web Vitals — proxy with conservative conversion uplift.
  if (metricName.startsWith('pagespeed.')) {
    return valueFromPageSpeed(businessId, metricName, baselineValue, currentValue, direction);
  }

  // 5. Average ranking position — each position = ~10% CTR change.
  if (metricName === 'gsc.avg_position') {
    return valueFromAvgPosition(businessId, baselineValue, currentValue, direction);
  }

  // 6. GBP visibility — rough proxy via phone-action → conversion assumption.
  if (metricName === 'gbp.views_total_30d' || metricName === 'gbp.actions_phone_30d') {
    return valueFromGBP(businessId, metricName, baselineValue, currentValue, direction);
  }

  // 7. Fall-through: we don't know how to price this metric honestly.
  return {
    estimated_usd_per_month: null,
    confidence: 'unknown',
    direction,
    reasoning: `No value model available for metric '${metricName}'. Change observed (${formatPct(baselineValue, currentValue)}) but monetary value not estimated.`,
    assumptions: ['Metric is outside the direct-revenue / traffic / perf / ranking / GBP models.'],
  };
}

// ─── Context lookups ──────────────────────────────────────────────────────────

/**
 * Look up the business's AOV (average order value) baseline in dollars.
 * Tries shopify.aov first, falls back to computing from revenue_30d / orders_30d.
 * Returns null when we don't have the data.
 */
function getAOV(businessId: string): number | null {
  const direct = getBaseline(businessId, 'shopify.aov');
  if (direct && direct.baseline_value > 0) return direct.baseline_value as number;

  const rev = getBaseline(businessId, 'shopify.revenue_30d');
  const orders = getBaseline(businessId, 'shopify.orders_30d');
  if ((rev?.baseline_value ?? 0) > 0 && (orders?.baseline_value ?? 0) > 0) {
    return (rev!.baseline_value as number) / (orders!.baseline_value as number);
  }
  return null;
}

/**
 * Business's baseline conversion rate as a decimal (0.025 = 2.5%).
 * Tries shopify first, then ga4.
 */
/**
 * Normalise a stored conversion-rate baseline to a decimal.
 * Baselines have no unit metadata, so this is a heuristic: e-commerce
 * conversion rates virtually never exceed 20% as a decimal, so anything
 * above 0.2 is assumed to be a percentage (e.g. 2.5 → 0.025). Values that
 * remain implausible after conversion are rejected rather than fed into
 * revenue estimates.
 */
function normaliseConversionRate(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const decimal = raw > 0.2 ? raw / 100 : raw;
  if (decimal > 0.5) {
    console.warn(`[value-estimator] Implausible conversion rate baseline ${raw} — ignoring.`);
    return null;
  }
  return decimal;
}

function getConversionRate(businessId: string): number | null {
  const shop = getBaseline(businessId, 'shopify.conversion_rate');
  if (shop && Number.isFinite(shop.baseline_value)) {
    const rate = normaliseConversionRate(shop.baseline_value as number);
    if (rate !== null) return rate;
  }
  const ga4 = getBaseline(businessId, 'ga4.conversion_rate');
  if (ga4 && Number.isFinite(ga4.baseline_value)) {
    const rate = normaliseConversionRate(ga4.baseline_value as number);
    if (rate !== null) return rate;
  }
  return null;
}

/**
 * Current monthly sessions (or a close proxy) for traffic-based estimates.
 */
function getMonthlyTraffic(businessId: string): number | null {
  const latest30 = db.prepare(`
    SELECT metric_value as v FROM metrics
     WHERE business_id = ? AND metric_name = 'ga4.sessions_30d'
       AND metric_value IS NOT NULL
     ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId) as { v: number } | null;
  if ((latest30?.v ?? 0) > 0) return latest30!.v;

  const base30 = getBaseline(businessId, 'ga4.sessions_30d');
  if ((base30?.baseline_value ?? 0) > 0) return base30!.baseline_value as number;
  return null;
}

// ─── Per-metric estimators ────────────────────────────────────────────────────

function valueFromConversionRate(businessId: string, baseline: number, current: number, direction: 'improved' | 'worsened' | 'flat'): ValueEstimate {
  const aov = getAOV(businessId);
  const traffic = getMonthlyTraffic(businessId);
  if (aov == null || traffic == null) {
    return partialKnowledge('conversion rate', direction, baseline, current,
      ['AOV or monthly traffic baseline unavailable — cannot convert a rate change to money.']);
  }
  // Normalise baseline/current to decimals if stored as %.
  const b = baseline > 1 ? baseline / 100 : baseline;
  const c = current > 1 ? current / 100 : current;
  const deltaOrders = (c - b) * traffic;
  const monthlyValue = deltaOrders * aov;
  return {
    estimated_usd_per_month: Math.round(monthlyValue * 100) / 100,
    confidence: 'medium',
    direction,
    reasoning: `Conversion rate change ${(b * 100).toFixed(2)}% → ${(c * 100).toFixed(2)}% ` +
               `× ${Math.round(traffic)} monthly sessions × ${formatMoney(aov)} AOV = ` +
               `${formatMoney(monthlyValue, true)}/month.`,
    assumptions: [
      'Current traffic levels hold.',
      `Using AOV baseline of ${formatMoney(aov)}.`,
      'All additional conversions are at AOV (ignores new-customer vs repeat mix).',
    ],
  };
}

function valueFromTraffic(businessId: string, baseline: number, current: number, direction: 'improved' | 'worsened' | 'flat', metricName: string): ValueEstimate {
  const aov = getAOV(businessId);
  const cvr = getConversionRate(businessId);
  if (aov == null || cvr == null) {
    return partialKnowledge(metricName, direction, baseline, current,
      ['AOV or conversion rate baseline unavailable — cannot convert sessions to money.']);
  }
  const deltaSessions = current - baseline;
  const monthlyValue = deltaSessions * cvr * aov;
  return {
    estimated_usd_per_month: Math.round(monthlyValue * 100) / 100,
    confidence: 'medium',
    direction,
    reasoning: `${metricName} change ${Math.round(baseline)} → ${Math.round(current)} ` +
               `(+${Math.round(deltaSessions)}) × ${(cvr * 100).toFixed(2)}% conv × ` +
               `${formatMoney(aov)} AOV = ${formatMoney(monthlyValue, true)}/month.`,
    assumptions: [
      `Applying baseline conversion rate ${(cvr * 100).toFixed(2)}% to new traffic.`,
      `Using AOV baseline of ${formatMoney(aov)}.`,
      'New traffic converts at the same rate as existing traffic.',
    ],
  };
}

function valueFromPageSpeed(businessId: string, metricName: string, baseline: number, current: number, direction: 'improved' | 'worsened' | 'flat'): ValueEstimate {
  const aov = getAOV(businessId);
  const traffic = getMonthlyTraffic(businessId);
  const cvr = getConversionRate(businessId);

  // Proxy: a 20-point improvement in mobile performance score correlates
  // with roughly 2-7% conversion uplift in published studies. Use 3% per
  // 20 points as the conservative midpoint. Applies only to score metrics.
  let upliftPct: number | null = null;
  if (metricName.endsWith('.performance_score')) {
    const delta = direction === 'improved' ? Math.abs(current - baseline) : -Math.abs(current - baseline);
    upliftPct = (delta / 20) * 0.03; // 3% per 20-point improvement
  }
  // LCP: each 1000ms improvement ≈ 1.5% conversion uplift (Google benchmarks).
  if (metricName.endsWith('.lcp_ms')) {
    const deltaMs = baseline - current; // lower is better; positive means improved
    upliftPct = (deltaMs / 1000) * 0.015;
  }

  if (upliftPct == null || aov == null || traffic == null || cvr == null) {
    return partialKnowledge(metricName, direction, baseline, current,
      ['PageSpeed-to-revenue proxy needs AOV, traffic, and conversion rate baselines.']);
  }

  const newConversions = traffic * cvr * upliftPct;
  const monthlyValue = newConversions * aov;
  return {
    estimated_usd_per_month: Math.round(monthlyValue * 100) / 100,
    confidence: 'low',
    direction,
    reasoning: `PageSpeed ${metricName} ${Math.round(baseline)} → ${Math.round(current)} ` +
               `estimated ${(upliftPct * 100).toFixed(1)}% conversion uplift × ` +
               `${Math.round(traffic)} sessions × ${(cvr * 100).toFixed(2)}% conv × ` +
               `${formatMoney(aov)} AOV ≈ ${formatMoney(monthlyValue, true)}/month.`,
    assumptions: [
      'Industry benchmark: ~3% conversion uplift per 20-point score improvement.',
      'Industry benchmark: ~1.5% conversion uplift per 1s LCP reduction.',
      'Benchmarks come from published ecommerce studies; this business may differ.',
      'PageSpeed is one input to conversion among many — directionally useful, not precise.',
    ],
  };
}

function valueFromAvgPosition(businessId: string, baseline: number, current: number, direction: 'improved' | 'worsened' | 'flat'): ValueEstimate {
  const aov = getAOV(businessId);
  const cvr = getConversionRate(businessId);
  const impressions = getBaseline(businessId, 'gsc.total_impressions');

  if (aov == null || cvr == null || !(impressions?.baseline_value)) {
    return partialKnowledge('gsc.avg_position', direction, baseline, current,
      ['Need AOV, conversion rate, and impressions baseline to monetise a position change.']);
  }

  // Rule of thumb: each position improvement (1→2, 5→4, etc.) changes CTR by ~10% of the previous rate.
  // Not precise — CTR curves are non-linear — but a serviceable directional estimate.
  const deltaPositions = baseline - current; // lower is better; positive means improved
  const ctrMultiplier = Math.max(-0.9, Math.min(3, deltaPositions * 0.10));
  const deltaClicks = (impressions.baseline_value as number) * 0.03 * ctrMultiplier; // assume ~3% baseline CTR
  const monthlyValue = deltaClicks * cvr * aov;
  return {
    estimated_usd_per_month: Math.round(monthlyValue * 100) / 100,
    confidence: 'low',
    direction,
    reasoning: `Avg position ${baseline.toFixed(1)} → ${current.toFixed(1)} ` +
               `(${deltaPositions > 0 ? '+' : ''}${deltaPositions.toFixed(1)} positions) ` +
               `× ~${(ctrMultiplier * 100).toFixed(0)}% CTR change on ${Math.round(impressions.baseline_value as number)} impressions ` +
               `× ${(cvr * 100).toFixed(2)}% conv × ${formatMoney(aov)} AOV ≈ ${formatMoney(monthlyValue, true)}/month.`,
    assumptions: [
      '~10% relative CTR change per position (non-linear — imprecise at page boundaries).',
      `Baseline CTR assumption ~3% (real value varies by query intent).`,
      `Current impressions ~${Math.round(impressions.baseline_value as number)}.`,
    ],
  };
}

function valueFromGBP(businessId: string, metricName: string, baseline: number, current: number, direction: 'improved' | 'worsened' | 'flat'): ValueEstimate {
  // Phone actions are the closest GBP metric to revenue for local businesses,
  // but we'd need per-call conversion + order-value data this system doesn't
  // have. Report direction + magnitude honestly; don't guess money.
  const delta = current - baseline;
  return {
    estimated_usd_per_month: null,
    confidence: 'unknown',
    direction,
    reasoning: `${metricName} changed ${Math.round(baseline)} → ${Math.round(current)} ` +
               `(${delta >= 0 ? '+' : ''}${Math.round(delta)}). Local GBP visibility ` +
               `doesn't convert to currency without per-call conversion data Blueprint doesn't track.`,
    assumptions: [
      'Not monetised — would need call-conversion and call-value data per business.',
    ],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyResult(msg: string): ValueEstimate {
  return {
    estimated_usd_per_month: null,
    confidence: 'unknown',
    direction: 'flat',
    reasoning: msg,
    assumptions: [],
  };
}

function partialKnowledge(label: string, direction: 'improved' | 'worsened' | 'flat', baseline: number, current: number, assumptions: string[]): ValueEstimate {
  return {
    estimated_usd_per_month: null,
    confidence: 'unknown',
    direction,
    reasoning: `${label} moved ${formatPct(baseline, current)} but monetary impact not estimable — missing context.`,
    assumptions,
  };
}

function formatMoney(v: number | null, signed = false): string {
  if (v == null || !Number.isFinite(v)) return '£?';
  const abs = Math.abs(v);
  const sign = signed ? (v > 0 ? '+' : v < 0 ? '-' : '') : (v < 0 ? '-' : '');
  return `${sign}£${abs.toFixed(2)}`;
}

function formatPct(baseline: number, current: number): string {
  if (!baseline) return '?%';
  const pct = ((current - baseline) / Math.abs(baseline)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// Re-export for tests
export { LOWER_IS_BETTER, DIRECT_REVENUE_METRICS };
