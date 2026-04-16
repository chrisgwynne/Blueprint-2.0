/**
 * Brain — Agent calibration (Feature 5).
 *
 * Tracks how well each agent's stated confidence predicts actual outcomes,
 * applies display offsets, injects notes into prompts, and adjusts trust tiers.
 */
import crypto from 'crypto';
import db from '../db/db.js';

interface CalibrationRow {
  calibration_error: number | null;
  calibration_offset: number | null;
}

interface CalibrationResult {
  agent: string;
  avgStated: number;
  avgOutcome: number;
  error: number;
  score: number;
  offset: number;
  trend: string;
  n: number;
}

/**
 * Recalculate calibration for every agent with recent outcomes over the last N days.
 */
export function recalculateCalibrationForBusiness(businessId: string, windowDays = 90): CalibrationResult[] {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  // Gather per-agent calibration data from outcomes on tasks completed in window.
  const rows = db.prepare(`
    SELECT t.proposed_by AS agent_raw, t.confidence, o.verdict
    FROM task_outcomes o
    JOIN tasks t ON t.id = o.task_id
    WHERE t.business_id = ? AND t.completed_at >= ?
      AND t.confidence IS NOT NULL
      AND o.verdict IS NOT NULL
  `).all(businessId, since) as Array<{ agent_raw: string | null; confidence: number; verdict: string }>;

  const buckets: Record<string, { stated: number[]; outcomes: number[] }> = {};
  for (const r of rows) {
    if (!r.agent_raw) continue;
    const agent = String(r.agent_raw).replace(/^agent:/, '');
    if (!buckets[agent]) buckets[agent] = { stated: [], outcomes: [] };
    buckets[agent].stated.push(Number(r.confidence));
    buckets[agent].outcomes.push(r.verdict === 'improved' ? 1 : 0);
  }

  const results: CalibrationResult[] = [];
  for (const [agent, b] of Object.entries(buckets)) {
    if (b.stated.length < 3) continue; // need enough data
    const avgStated = b.stated.reduce((s, v) => s + v, 0) / b.stated.length;
    const avgOutcome = b.outcomes.reduce((s, v) => s + v, 0) / b.outcomes.length;
    const err = avgStated - avgOutcome;
    const score = Math.max(0, 1 - Math.abs(err));
    const offset = err; // positive offset subtracted from displayed confidence

    // Determine trend — compare to prior period if available
    const prior = db.prepare(`
      SELECT calibration_error FROM agent_calibration
      WHERE agent_id = ? AND business_id = ?
      ORDER BY calculated_at DESC LIMIT 1
    `).get(agent, businessId) as CalibrationRow | null;
    let trend = 'stable';
    if (prior?.calibration_error != null) {
      const diff = Math.abs(err) - Math.abs(prior.calibration_error);
      if (diff < -0.03) trend = 'improving';
      else if (diff > 0.03) trend = 'declining';
    }

    db.prepare(`
      INSERT INTO agent_calibration
      (id, agent_id, business_id, period_start, period_end,
       tasks_with_outcomes, avg_stated_confidence, avg_actual_outcome_rate,
       calibration_error, calibration_score, calibration_offset, trend, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), agent, businessId,
      since, new Date().toISOString(),
      b.stated.length, avgStated, avgOutcome, err, score, offset, trend,
      null
    );
    results.push({ agent, avgStated, avgOutcome, error: err, score, offset, trend, n: b.stated.length });
  }
  return results;
}

/**
 * Get the latest calibration entry for an agent (any business scope).
 */
export function getLatestCalibration(agentId: string, businessId?: string | null): CalibrationRow | null {
  const where = businessId ? 'agent_id = ? AND business_id = ?' : 'agent_id = ?';
  const params: any[] = businessId ? [agentId, businessId] : [agentId];
  return db.prepare(`
    SELECT * FROM agent_calibration
    WHERE ${where}
    ORDER BY calculated_at DESC LIMIT 1
  `).get(...params) as CalibrationRow | null;
}

export function listCalibrationHistory(agentId: string, businessId?: string | null, limit = 12): Record<string, unknown>[] {
  const where = businessId ? 'agent_id = ? AND business_id = ?' : 'agent_id = ?';
  const params: any[] = businessId ? [agentId, businessId, limit] : [agentId, limit];
  return db.prepare(`
    SELECT * FROM agent_calibration
    WHERE ${where}
    ORDER BY calculated_at DESC LIMIT ?
  `).all(...params) as Record<string, unknown>[];
}

/**
 * Apply calibration offset to a stated confidence.
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
 */
export function effectiveTrustTier(agentConfiguredTier: string, agentId: string, businessId?: string | null): string {
  const cal = getLatestCalibration(agentId, businessId);
  if (!cal) return agentConfiguredTier;
  if (((cal.calibration_error as number | null) ?? 0) > 0.2) return 'yellow';
  return agentConfiguredTier;
}
