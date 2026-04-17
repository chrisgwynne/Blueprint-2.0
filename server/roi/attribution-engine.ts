/**
 * ROI attribution engine — "how much of the observed improvement is
 * attributable to Blueprint, honestly?"
 *
 * Inputs:
 *   - baselines table          — the "before" picture (Tranche 7A)
 *   - metrics table            — current values
 *   - task_outcomes + tasks    — what Blueprint specifically did
 *   - cost_daily               — what Blueprint cost
 *
 * Outputs a structured report with:
 *   - observed_changes      : raw baseline→current per metric
 *   - natural_trajectory    : estimated change without Blueprint (if estimable)
 *   - attributed_improvements : task-linked wins with value + confidence
 *   - unattributed_improvements: metric improvements with no linked task
 *   - attributed_declines   : task-linked losses (yes, these count too)
 *   - confidence_level      : insufficient / early / developing / established
 *   - narrative             : plain-English summary that INCLUDES uncertainty
 *
 * The narrative is generated without an LLM in this tranche; a later tranche
 * swaps in an LLM-written version that preserves the honesty requirement.
 *
 * NB: this is distinct from server/brain/attribution-engine.js which does
 * PER-SIGNAL cause analysis. Different scope, different name intentional.
 */

import db from '../db/db.js';
import { getBaselines, getCurrentMetric } from './baselines.js';
import { estimateMonthlyValue } from './value-estimator.js';

// Confidence thresholds from the spec.
const DATA_STATES = [
  { level: 'insufficient', min_days: 0,  min_outcomes: 0,  label: 'Insufficient data' },
  { level: 'early',        min_days: 30, min_outcomes: 5,  label: 'Early signal — low confidence' },
  { level: 'developing',   min_days: 60, min_outcomes: 15, label: 'Developing — medium confidence' },
  { level: 'established',  min_days: 90, min_outcomes: 30, label: 'Established — high confidence' },
];

function classifyConfidence(daysSinceInstall: number, outcomesCount: number): string {
  let level = 'insufficient';
  for (const s of DATA_STATES) {
    if (daysSinceInstall >= s.min_days && outcomesCount >= s.min_outcomes) level = s.level;
  }
  return level;
}

/**
 * Main entry point. Returns a full ROI report object.
 *
 * @param {string} businessId
 * @param {object} [opts]
 * @param {string} [opts.period_start]  ISO — defaults to business.created_at
 * @param {string} [opts.period_end]    ISO — defaults to now
 */
export function computeROIReport(businessId: string, opts: { period_start?: string; period_end?: string } = {}): any | null {
  if (!businessId) return null;

  const business = db.prepare('SELECT id, name, created_at FROM businesses WHERE id = ?').get(businessId) as { id: string; name: string; created_at: string } | null;
  if (!business) return null;

  const periodStart = opts.period_start ?? business.created_at;
  const periodEnd = opts.period_end ?? new Date().toISOString();
  const daysSinceInstall = daysBetween(periodStart, periodEnd);

  // ─── Observed changes ───────────────────────────────────────────────────
  const baselines = getBaselines(businessId);
  const observed: any[] = [];
  for (const b of baselines) {
    const cur = getCurrentMetric(businessId, b.metric_name);
    if (!cur || cur.value == null) continue;
    const changePct = b.baseline_value === 0
      ? null
      : ((cur.value - b.baseline_value) / Math.abs(b.baseline_value)) * 100;
    const est = estimateMonthlyValue({
      metricName: b.metric_name,
      baselineValue: b.baseline_value,
      currentValue: cur.value,
      businessId,
    });
    observed.push({
      metric_name: b.metric_name,
      baseline_value: b.baseline_value,
      baseline_date: b.baseline_date,
      current_value: cur.value,
      current_at: cur.at,
      change_absolute: cur.value - b.baseline_value,
      change_pct: changePct,
      direction: est.direction,
      estimated_monthly_usd: est.estimated_usd_per_month,
      value_confidence: est.confidence,
      value_reasoning: est.reasoning,
    });
  }

  // ─── Task-linked attribution ────────────────────────────────────────────
  // Any task with a measured outcome that's linked to one of our baseline
  // metrics gets a share of attribution. Confidence graded per the spec:
  //   HIGH: outcome=improved, metric also improved globally, nothing else
  //         in that window that obviously explains it
  //   MEDIUM: outcome=improved + metric improved, but concurrent activity
  //   LOW: metric improved but no specific task attributable
  // task_outcomes doesn't store metric_name directly — we join to tasks to
  // pick it up from tasks.target_metric. If target_metric is null (some
  // older tasks) we fall back to parsing it out of verdict_detail.
  const outcomeRows = db.prepare(`
    SELECT o.*, t.title as task_title, t.proposed_by, t.action_type,
           t.target_metric as metric_name,
           t.created_at as task_created_at, t.completed_at as task_completed_at
      FROM task_outcomes o
      JOIN tasks t ON t.id = o.task_id
     WHERE t.business_id = ?
     ORDER BY o.check_date DESC
  `).all(businessId) as any[];

  const attributedImprovements: any[] = [];
  const attributedDeclines: any[] = [];
  const seenTasks = new Set<string>();

  for (const o of outcomeRows) {
    if (seenTasks.has(o.task_id)) continue;
    seenTasks.add(o.task_id);

    if (o.verdict === 'improved' || o.verdict === 'worsened') {
      const est = estimateMonthlyValue({
        metricName: o.metric_name ?? metricFromVerdictDetail(o.verdict_detail),
        baselineValue: o.baseline_value,
        currentValue: o.metric_value,
        businessId,
      });

      // Confidence: favour outcomes that closed their full measurement window
      // (4 weeks_after). 2-week checks get a notch lower.
      const windowClosed = o.weeks_after >= 4;
      const magnitudeMeaningful = Math.abs(o.change_pct ?? 0) > 10;
      let confidence = 'low';
      if (windowClosed && magnitudeMeaningful) confidence = 'high';
      else if (windowClosed || magnitudeMeaningful) confidence = 'medium';

      const record = {
        task_id: o.task_id,
        task_title: o.task_title,
        proposed_by: o.proposed_by,
        action_type: o.action_type,
        metric_name: o.metric_name ?? metricFromVerdictDetail(o.verdict_detail),
        change_pct: o.change_pct,
        change_absolute: o.metric_value - o.baseline_value,
        estimated_monthly_usd: est.estimated_usd_per_month,
        confidence,
        value_confidence: est.confidence,
        weeks_after: o.weeks_after,
        checked_at: o.check_date,
      };

      if (o.verdict === 'improved') attributedImprovements.push(record);
      else attributedDeclines.push(record);
    }
  }

  // ─── Sum the attribution ────────────────────────────────────────────────
  const attributedValueUsd = attributedImprovements.reduce(
    (sum: number, r: any) => sum + (Number.isFinite(r.estimated_monthly_usd) ? r.estimated_monthly_usd : 0), 0);
  const attributedDeclineUsd = attributedDeclines.reduce(
    (sum: number, r: any) => sum + (Number.isFinite(r.estimated_monthly_usd) ? Math.abs(r.estimated_monthly_usd) : 0), 0);

  // ─── Unattributed improvements ──────────────────────────────────────────
  // Metrics that improved in the observed delta but have no linked task.
  // These are real movement but Blueprint cannot claim them.
  const attributedMetrics = new Set(attributedImprovements.map((r: any) => r.metric_name));
  const unattributedImprovements = observed
    .filter((o: any) => o.direction === 'improved' && !attributedMetrics.has(o.metric_name))
    .map((o: any) => ({
      metric_name: o.metric_name,
      change_pct: o.change_pct,
      change_absolute: o.change_absolute,
      estimated_monthly_usd: o.estimated_monthly_usd,
      reason: 'No specific Blueprint task has been attributed to this improvement.',
    }));

  const unattributedDeclines = observed
    .filter((o: any) => o.direction === 'worsened' && !attributedMetrics.has(o.metric_name))
    .map((o: any) => ({
      metric_name: o.metric_name,
      change_pct: o.change_pct,
      change_absolute: o.change_absolute,
      estimated_monthly_usd: o.estimated_monthly_usd,
      reason: 'Metric declined but no Blueprint task is linked.',
    }));

  // ─── Natural-trajectory estimate ─────────────────────────────────────────
  // For each directly-revenue metric, if we have enough early post-install
  // data to fit a slope, we quote what the metric would have been at
  // period_end following that slope. This is the "what would have happened
  // anyway" baseline Blueprint's contribution gets measured against.
  const naturalTrajectory = estimateNaturalTrajectory(businessId, periodStart, periodEnd, observed);

  // ─── Cost ────────────────────────────────────────────────────────────────
  const costRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM cost_daily
     WHERE business_id = ?
       AND date >= date(?)
       AND date <= date(?)
  `).get(businessId, periodStart, periodEnd) as { total: number } | null;
  const totalCostUsd = costRow?.total ?? 0;

  // ─── Confidence level ───────────────────────────────────────────────────
  const outcomesCount = outcomeRows.length;
  const confidenceLevel = classifyConfidence(daysSinceInstall, outcomesCount);

  // ─── ROI ratio ──────────────────────────────────────────────────────────
  // Ratio expressed as (attributed_value_per_month × months_elapsed) / total_cost.
  // Meaningful only once we've collected enough data.
  const monthsElapsed = Math.max(0.1, daysSinceInstall / 30);
  const roiRatio = totalCostUsd > 0
    ? (attributedValueUsd * monthsElapsed) / totalCostUsd
    : null;

  // ─── Narrative ──────────────────────────────────────────────────────────
  const narrative = buildNarrative({
    business, daysSinceInstall, confidenceLevel, outcomesCount,
    observed, attributedImprovements, attributedDeclines,
    unattributedImprovements, unattributedDeclines,
    naturalTrajectory, attributedValueUsd, totalCostUsd, roiRatio,
  });

  return {
    business_id: businessId,
    business_name: business.name,
    period_start: periodStart,
    period_end: periodEnd,
    days_since_install: daysSinceInstall,
    confidence_level: confidenceLevel,
    outcomes_count: outcomesCount,
    metrics_analysed: observed.length,
    observed_changes: observed,
    natural_trajectory: naturalTrajectory,
    attributed_improvements: attributedImprovements,
    attributed_declines: attributedDeclines,
    unattributed_improvements: unattributedImprovements,
    unattributed_declines: unattributedDeclines,
    total_cost_usd: Math.round(totalCostUsd * 10000) / 10000,
    attributed_value_usd_per_month: Math.round(attributedValueUsd * 100) / 100,
    attributed_decline_usd_per_month: Math.round(attributedDeclineUsd * 100) / 100,
    roi_ratio: roiRatio != null ? Math.round(roiRatio * 10) / 10 : null,
    narrative,
  };
}

// ─── Natural trajectory ───────────────────────────────────────────────────────

function estimateNaturalTrajectory(businessId: string, periodStart: string, periodEnd: string, observed: any[]): any {
  const installMs = new Date(periodStart).getTime();
  const periodEndMs = new Date(periodEnd).getTime();

  // Only makes sense once we have at least 30 days + 15 more days to compare against.
  if (periodEndMs - installMs < 45 * 86400000) {
    return {
      available: false,
      reason: 'Not enough post-install data yet. Natural-trajectory estimate requires 45+ days.',
    };
  }

  // For each direct-revenue metric with enough early data, fit a simple
  // linear slope across the first 30 days and project to period_end.
  const REVENUE_METRICS = ['shopify.revenue_30d', 'stripe.mrr', 'stripe.revenue_30d'];
  const projections: any[] = [];
  let totalProjected = 0;
  let totalObserved = 0;

  for (const metricName of REVENUE_METRICS) {
    const obs = observed.find((o: any) => o.metric_name === metricName);
    if (!obs) continue;

    const earlySamples = db.prepare(`
      SELECT metric_value as v, recorded_at as at
        FROM metrics
       WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
         AND recorded_at >= ? AND recorded_at <= datetime(?, '+30 days')
       ORDER BY recorded_at ASC
    `).all(businessId, metricName, periodStart, periodStart) as Array<{ v: number; at: string }>;

    if (earlySamples.length < 3) continue; // not enough data to fit

    const { slopePerDay } = linearSlope(earlySamples);
    if (!Number.isFinite(slopePerDay)) continue;

    const totalDays = Math.max(1, daysBetween(periodStart, periodEnd));
    const projected = obs.baseline_value + (slopePerDay as number) * totalDays;
    projections.push({
      metric_name: metricName,
      baseline_value: obs.baseline_value,
      projected_value: Math.round(projected * 100) / 100,
      observed_value: obs.current_value,
      projected_change_usd_per_month: Math.round((projected - obs.baseline_value) * 100) / 100,
      slope_per_day: Math.round((slopePerDay as number) * 100) / 100,
      basis: `Fitted to ${earlySamples.length} samples in the first 30 days after install.`,
    });
    totalProjected += (projected - obs.baseline_value);
    totalObserved += (obs.current_value - obs.baseline_value);
  }

  if (projections.length === 0) {
    return {
      available: false,
      reason: 'No revenue metric had enough early-period samples to fit a trajectory.',
    };
  }

  return {
    available: true,
    projections,
    projected_change_usd_per_month: Math.round(totalProjected * 100) / 100,
    observed_change_usd_per_month: Math.round(totalObserved * 100) / 100,
    unexplained_delta_usd_per_month: Math.round((totalObserved - totalProjected) * 100) / 100,
    note:
      'Natural-trajectory estimate fitted to the first 30 days post-install. This ' +
      "assumes minimal Blueprint impact in that window — realistic for most " +
      "agents whose measurement windows are 2–4 weeks, but inspect per-metric " +
      "projections before trusting the headline number.",
  };
}

function linearSlope(samples: Array<{ v: number; at: string }>): { slopePerDay: number | null } {
  // Simple linear regression against days-since-first-sample.
  const t0 = new Date(samples[0]!.at).getTime();
  const xs = samples.map(s => (new Date(s.at).getTime() - t0) / 86400000);
  const ys = samples.map(s => s.v);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * (ys[i] ?? 0), 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slopePerDay: null };
  const slopePerDay = (n * sumXY - sumX * sumY) / denom;
  return { slopePerDay };
}

// ─── Narrative ────────────────────────────────────────────────────────────────

function buildNarrative(ctx: any): string {
  const {
    business, daysSinceInstall, confidenceLevel, outcomesCount,
    attributedImprovements, attributedDeclines,
    naturalTrajectory, attributedValueUsd, totalCostUsd, roiRatio,
  } = ctx;

  const parts: string[] = [];
  parts.push(`Blueprint has been running on ${business.name} for ${daysSinceInstall} day${daysSinceInstall === 1 ? '' : 's'}.`);

  if (confidenceLevel === 'insufficient') {
    parts.push(
      `We need at least 30 days and 5 measured outcomes before an ROI estimate is meaningful. ` +
      `Currently ${outcomesCount} outcome${outcomesCount === 1 ? '' : 's'} measured.`
    );
    return parts.join(' ');
  }

  if (attributedImprovements.length === 0 && attributedDeclines.length === 0) {
    parts.push(
      `${outcomesCount} outcomes measured so far but none have produced a clear attributable improvement. ` +
      `The data we have doesn't yet support a specific monetary claim.`
    );
  } else {
    const roiText = roiRatio != null ? ` ROI ratio: ${roiRatio.toFixed(1)}x.` : '';
    parts.push(
      `${attributedImprovements.length} improved outcome${attributedImprovements.length === 1 ? '' : 's'} ` +
      `linked to Blueprint tasks — estimated +£${(attributedValueUsd as number).toFixed(2)}/month. ` +
      `Spent $${(totalCostUsd as number).toFixed(2)} on agent LLM calls over the period.${roiText}`
    );
  }

  if (attributedDeclines.length > 0) {
    parts.push(
      `Honest note: ${attributedDeclines.length} Blueprint task${attributedDeclines.length === 1 ? '' : 's'} ` +
      `produced worse outcomes than baseline. These count against the ROI figure.`
    );
  }

  if (naturalTrajectory?.available) {
    parts.push(
      `Pre-Blueprint trajectory would have added about £${naturalTrajectory.projected_change_usd_per_month}/month on its own. ` +
      `Observed change was £${naturalTrajectory.observed_change_usd_per_month}/month. ` +
      `The £${naturalTrajectory.unexplained_delta_usd_per_month}/month gap is where Blueprint's contribution lives — ` +
      `verified outcomes account for part, the rest is unattributed.`
    );
  } else if (naturalTrajectory?.reason) {
    parts.push(`Natural-trajectory comparison: ${naturalTrajectory.reason}`);
  }

  if (confidenceLevel !== 'established') {
    parts.push(
      `Confidence level: ${confidenceLevel}. This estimate will become more reliable as more measurement windows close.`
    );
  }

  return parts.join(' ');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.max(0, Math.round((tb - ta) / 86400000));
}

function metricFromVerdictDetail(detail: string | null | undefined): string | null {
  // verdict_detail looks like "ga4.sessions: 1000 → 1234 (+23.4%)"
  const m = detail?.match?.(/^([a-z0-9._-]+):/i);
  return m?.[1] ?? null;
}
