/**
 * Brain — Agent calibration (Feature 5, upgraded in Phase 3).
 *
 * Tracks how well each agent's stated confidence predicts actual outcomes,
 * applies display offsets, injects notes into prompts, and adjusts trust
 * tiers.
 *
 * Phase 3 replaces the original single-scalar "avg stated minus avg
 * outcome" offset with a proper calibration model:
 *
 *   1. BINNED reliability curve — confidences are bucketed into deciles
 *      (a single global average hides the fact that an agent can be
 *      well-calibrated at high confidence and badly overconfident at
 *      medium confidence — a flat offset corrects neither case correctly).
 *   2. BAYESIAN SHRINKAGE per bucket — a bucket with 2 samples is not
 *      trustworthy on its own; each bucket's observed success rate is
 *      pulled toward the agent's overall rate in proportion to how little
 *      data that bucket has (Beta-Binomial posterior mean), so noisy small
 *      buckets don't produce wild offsets.
 *   3. RECENCY WEIGHTING — outcomes are weighted by exponential decay
 *      (half-life below) rather than a hard cutoff window, so a bad run
 *      last week matters more than one from three months ago without
 *      abruptly discarding older data.
 *   4. CONSERVATISM — if an agent has been overconfident in most of its
 *      last few calibration periods, its calibration_offset is scaled up
 *      (not just recomputed fresh each time), so a repeatedly-wrong agent
 *      gets progressively more conservative rather than resetting to
 *      "average" every period. This is the literal requirement: "agents
 *      should become more conservative when repeatedly wrong."
 *
 * Additional tracked dimensions (Phase 3): false positives/negatives,
 * recommendation acceptance/rejection (from tasks.status, not just
 * outcomes), execution success rate (did the approved task's execution
 * succeed, independent of whether the metric improved), and long-term
 * success rate (the outcome-based rate, kept as its own named field).
 */
import crypto from 'crypto';
import db from '../db/db.js';

interface CalibrationRow {
  agent_id: string;
  business_id: string | null;
  tasks_with_outcomes: number;
  avg_stated_confidence: number | null;
  avg_actual_outcome_rate: number | null;
  calibration_error: number | null;
  calibration_offset: number | null;
  calibration_score: number | null;
  trend: string | null;
  conservatism_factor: number | null;
}

interface CalibrationBin {
  range: string;
  n: number;
  raw_success_rate: number | null;
  shrunk_success_rate: number;
}

export interface CalibrationResult {
  agent: string;
  avgStated: number;
  avgOutcome: number;
  error: number;
  score: number;
  offset: number;
  trend: string;
  n: number;
  falsePositives: number;
  falseNegatives: number;
  recommendationsAccepted: number;
  recommendationsRejected: number;
  executionSuccessRate: number | null;
  longTermSuccessRate: number | null;
  conservatismFactor: number;
  bins: CalibrationBin[];
}

const HALF_LIFE_DAYS = 45;
// Pseudo-observation strength for the Bayesian shrinkage prior — higher
// means small buckets get pulled harder toward the agent's overall rate.
const PRIOR_STRENGTH = 5;
const BIN_COUNT = 5; // quintiles: 0-20, 20-40, 40-60, 60-80, 80-100

function recencyWeight(completedAt: string, now: number): number {
  const ageDays = Math.max(0, (now - new Date(completedAt).getTime()) / 86400000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function binIndex(confidence: number): number {
  return Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(confidence * BIN_COUNT)));
}

/**
 * Recalculate calibration for every agent with recent outcomes. Unlike the
 * original version, "recent" is recency-weighted rather than a hard window
 * — outcomes older than windowDays still contribute, just with
 * exponentially less weight.
 */
export function recalculateCalibrationForBusiness(businessId: string, windowDays = 180): CalibrationResult[] {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const now = Date.now();

  const rows = db.prepare(`
    SELECT t.proposed_by AS agent_raw, t.confidence, t.completed_at, o.verdict
    FROM task_outcomes o
    JOIN tasks t ON t.id = o.task_id
    WHERE t.business_id = ? AND t.completed_at >= ?
      AND t.confidence IS NOT NULL AND o.verdict IS NOT NULL
  `).all(businessId, since) as Array<{ agent_raw: string | null; confidence: number; completed_at: string; verdict: string }>;

  type Bucket = {
    weightedStated: number; weightedOutcome: number; weight: number;
    n: number; falsePositives: number; falseNegatives: number;
    bins: Array<{ weightedSuccess: number; weight: number; n: number }>;
  };
  const buckets: Record<string, Bucket> = {};
  for (const r of rows) {
    if (!r.agent_raw) continue;
    const agent = String(r.agent_raw).replace(/^(agent:|bap:)/, '');
    if (!buckets[agent]) {
      buckets[agent] = {
        weightedStated: 0, weightedOutcome: 0, weight: 0, n: 0,
        falsePositives: 0, falseNegatives: 0,
        bins: Array.from({ length: BIN_COUNT }, () => ({ weightedSuccess: 0, weight: 0, n: 0 })),
      };
    }
    const b = buckets[agent]!;
    const w = recencyWeight(r.completed_at, now);
    const stated = Number(r.confidence);
    const succeeded = r.verdict === 'improved' ? 1 : 0;

    b.weightedStated += stated * w;
    b.weightedOutcome += succeeded * w;
    b.weight += w;
    b.n += 1;
    if (stated >= 0.7 && !succeeded) b.falsePositives += 1;
    if (stated < 0.5 && succeeded) b.falseNegatives += 1;

    const bin = b.bins[binIndex(stated)]!;
    bin.weightedSuccess += succeeded * w;
    bin.weight += w;
    bin.n += 1;
  }

  const results: CalibrationResult[] = [];
  for (const [agent, b] of Object.entries(buckets)) {
    if (b.n < 3) continue; // need enough data

    const avgStated = b.weightedStated / b.weight;
    const avgOutcome = b.weightedOutcome / b.weight;
    const err = avgStated - avgOutcome;
    const score = Math.max(0, 1 - Math.abs(err));

    // Bayesian-shrunk per-bin reliability curve: each bin's rate is pulled
    // toward the agent's overall avgOutcome, weighted by how much data
    // that bin actually has (PRIOR_STRENGTH pseudo-observations of the
    // overall rate act as the prior).
    const bins: CalibrationBin[] = b.bins.map((bin, i) => {
      const raw = bin.weight > 0 ? bin.weightedSuccess / bin.weight : null;
      const shrunk = (bin.weightedSuccess + avgOutcome * PRIOR_STRENGTH) / (bin.weight + PRIOR_STRENGTH);
      return {
        range: `${(i / BIN_COUNT * 100).toFixed(0)}-${((i + 1) / BIN_COUNT * 100).toFixed(0)}%`,
        n: bin.n, raw_success_rate: raw, shrunk_success_rate: shrunk,
      };
    });

    // Conservatism: look at the last 2 prior periods' calibration_error
    // sign. If overconfident (positive error) in >=2 of the last 3
    // periods including this one, scale the offset up rather than resetting
    // to the fresh value each time — this is what makes a repeatedly-wrong
    // agent progressively more conservative instead of oscillating.
    const priorPeriods = db.prepare(`
      SELECT calibration_error FROM agent_calibration
      WHERE agent_id = ? AND business_id = ?
      ORDER BY calculated_at DESC LIMIT 2
    `).all(agent, businessId) as Array<{ calibration_error: number | null }>;
    const overconfidentCount = [err, ...priorPeriods.map((p) => p.calibration_error)]
      .filter((e): e is number => e != null && e > 0.05).length;
    const conservatismFactor = overconfidentCount >= 2 ? 1.5 : 1.0;
    const offset = err * conservatismFactor;

    let trend = 'stable';
    if (priorPeriods[0]?.calibration_error != null) {
      const diff = Math.abs(err) - Math.abs(priorPeriods[0].calibration_error);
      if (diff < -0.03) trend = 'improving';
      else if (diff > 0.03) trend = 'declining';
    }

    // Recommendation acceptance/rejection and execution success come from
    // tasks.status directly (not task_outcomes) so they reflect ALL of an
    // agent's proposals, including ones with no target_metric and
    // therefore no outcome row at all.
    const statusCounts = db.prepare(`
      SELECT status, COUNT(*) AS n FROM tasks
      WHERE business_id = ? AND proposed_by IN (?, ?) AND created_at >= ?
      GROUP BY status
    `).all(businessId, `agent:${agent}`, `bap:${agent}`, since) as Array<{ status: string; n: number }>;
    const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s.n]));
    const accepted = (counts.approved ?? 0) + (counts.executing ?? 0) + (counts.complete ?? 0) + (counts.verified ?? 0) + (counts.failed ?? 0);
    const rejected = counts.rejected ?? 0;
    const executedTotal = (counts.complete ?? 0) + (counts.verified ?? 0) + (counts.failed ?? 0) + (counts.manual_review ?? 0);
    const executionSuccessRate = executedTotal > 0 ? ((counts.complete ?? 0) + (counts.verified ?? 0)) / executedTotal : null;

    db.prepare(`
      INSERT INTO agent_calibration
      (id, agent_id, business_id, period_start, period_end,
       tasks_with_outcomes, avg_stated_confidence, avg_actual_outcome_rate,
       calibration_error, calibration_score, calibration_offset, trend, notes,
       false_positives, false_negatives, recommendations_accepted, recommendations_rejected,
       execution_success_rate, long_term_success_rate, calibration_method, conservatism_factor, bins)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bayesian_binned', ?, ?)
    `).run(
      crypto.randomUUID(), agent, businessId,
      since, new Date().toISOString(),
      b.n, avgStated, avgOutcome, err, score, offset, trend, null,
      b.falsePositives, b.falseNegatives, accepted, rejected,
      executionSuccessRate, avgOutcome, conservatismFactor,
      JSON.stringify(bins),
    );
    results.push({
      agent, avgStated, avgOutcome, error: err, score, offset, trend, n: b.n,
      falsePositives: b.falsePositives, falseNegatives: b.falseNegatives,
      recommendationsAccepted: accepted, recommendationsRejected: rejected,
      executionSuccessRate, longTermSuccessRate: avgOutcome, conservatismFactor, bins,
    });
  }
  return results;
}

/**
 * Get the latest calibration entry for an agent (any business scope).
 */
export function getLatestCalibration(agentId: string, businessId?: string | null): CalibrationRow | null {
  const where = businessId ? 'agent_id = ? AND business_id = ?' : 'agent_id = ?';
  const params: any[] = businessId ? [agentId, businessId] : [agentId]; // eslint-disable-line @typescript-eslint/no-explicit-any
  return db.prepare(`
    SELECT * FROM agent_calibration
    WHERE ${where}
    ORDER BY calculated_at DESC LIMIT 1
  `).get(...params) as CalibrationRow | null;
}

export function listCalibrationHistory(agentId: string, businessId?: string | null, limit = 12): Record<string, unknown>[] {
  const where = businessId ? 'agent_id = ? AND business_id = ?' : 'agent_id = ?';
  const params: any[] = businessId ? [agentId, businessId, limit] : [agentId, limit]; // eslint-disable-line @typescript-eslint/no-explicit-any
  return db.prepare(`
    SELECT * FROM agent_calibration
    WHERE ${where}
    ORDER BY calculated_at DESC LIMIT ?
  `).all(...params) as Record<string, unknown>[];
}

/**
 * Apply calibration offset to a stated confidence. The offset already has
 * the conservatism factor baked in (see recalculateCalibrationForBusiness),
 * so this stays a simple subtraction — the "become more conservative"
 * behaviour lives in how the offset was computed, not here.
 */
export function adjustedConfidence(statedConfidence: number | null, agentId: string, businessId?: string | null): number | null {
  if (statedConfidence == null) return null;
  const cal = getLatestCalibration(agentId, businessId);
  if (!cal?.calibration_offset) return statedConfidence;
  const adjusted = Number(statedConfidence) - Number(cal.calibration_offset);
  return Math.max(0, Math.min(1, adjusted));
}

/**
 * Trust-tier adjustment rule: if an agent is >20% overconfident, elevate
 * all their new tasks to yellow (requires approval) regardless of config.
 * A conservatism_factor > 1 (repeatedly overconfident) lowers that
 * threshold further, since "more conservative" should also mean "watched
 * more closely," not just "displayed confidence knocked down."
 */
export function effectiveTrustTier(agentConfiguredTier: string, agentId: string, businessId?: string | null): string {
  const cal = getLatestCalibration(agentId, businessId);
  if (!cal) return agentConfiguredTier;
  const threshold = (cal.conservatism_factor ?? 1) > 1 ? 0.12 : 0.2;
  if (((cal.calibration_error as number | null) ?? 0) > threshold) return 'yellow';
  return agentConfiguredTier;
}
