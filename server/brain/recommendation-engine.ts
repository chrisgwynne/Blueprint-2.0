/**
 * Brain — Recommendation Ranking (Phase 3).
 *
 * "What should we do next?" — gathers every currently-actionable candidate
 * (proposed tasks awaiting approval, pending opportunities, candidate
 * strategies for active goals) into one comparable ranked list, scored on
 * expected impact, goal importance, urgency, confidence, effort,
 * historical success, risk, and constraint feasibility — with a
 * human-readable rationale per item, never an opaque number alone.
 *
 * Candidates that violate a blocking constraint (constraint-engine.ts) are
 * never ranked — they're returned separately as `excluded`, with the
 * violated constraint's note, so a caller can see *why* something wasn't
 * recommended rather than it silently vanishing.
 */
import db from '../db/db.js';
import { actionTypeTrackRecord } from '../tasks/historical-learning.js';
import { checkConstraints } from './constraint-engine.js';

export type RecommendationSourceType = 'task' | 'opportunity' | 'strategy';

export interface RankedRecommendation {
  id: string;
  source_type: RecommendationSourceType;
  title: string;
  score: number;
  rationale: string[];
  expected_impact: string | null;
  confidence: number | null;
  estimated_cost: number | null;
  estimated_effort: string | null;
  historical_success_rate: number | null;
  historical_sample_size: number;
  goal_id: string | null;
  goal_title: string | null;
  has_open_conflict: boolean;
}

export interface ExcludedRecommendation {
  id: string;
  source_type: RecommendationSourceType;
  title: string;
  reason: string;
}

interface Candidate {
  id: string;
  source_type: RecommendationSourceType;
  title: string;
  action_type: string | null;
  confidence: number | null;
  priority: string | null; // p1|p2|p3
  estimated_effort: string | null; // low|medium|high
  estimated_cost: number | null;
  time_to_impact_days: number | null;
  expected_impact: string | null;
  goal_id: string | null;
  goal_priority: string | null;
  goal_title: string | null;
}

function priorityWeight(p: string | null): number {
  return p === 'p1' ? 1.0 : p === 'p2' ? 0.6 : p === 'p3' ? 0.3 : 0.4;
}

function effortWeight(e: string | null): number {
  return e === 'low' ? 1.0 : e === 'medium' ? 0.6 : e === 'high' ? 0.3 : 0.5;
}

function urgencyFromDays(days: number | null): number {
  if (days == null) return 0.4;
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.7;
  if (days <= 90) return 0.4;
  return 0.2;
}

function gatherCandidates(businessId: string): Candidate[] {
  const candidates: Candidate[] = [];

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.action_type, t.confidence, t.priority, t.goal_id, g.priority AS goal_priority, g.title AS goal_title
    FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.business_id = ? AND t.status = 'proposed'
  `).all(businessId) as Array<{ id: string; title: string; action_type: string | null; confidence: number | null; priority: string | null; goal_id: string | null; goal_priority: string | null; goal_title: string | null }>;
  for (const t of tasks) {
    candidates.push({
      id: t.id, source_type: 'task', title: t.title, action_type: t.action_type,
      confidence: t.confidence, priority: t.priority, estimated_effort: null, estimated_cost: null,
      time_to_impact_days: null, expected_impact: null,
      goal_id: t.goal_id, goal_priority: t.goal_priority, goal_title: t.goal_title,
    });
  }

  const opportunities = db.prepare(`
    SELECT id, title, connector_source, confidence, opportunity_value, opportunity_unit, required_effort, related_goal_ids
    FROM goal_suggestions
    WHERE business_id = ? AND status = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= CURRENT_TIMESTAMP)
  `).all(businessId) as Array<{ id: string; title: string; connector_source: string | null; confidence: number | null; opportunity_value: number | null; opportunity_unit: string | null; required_effort: string | null; related_goal_ids: string | null }>;
  for (const o of opportunities) {
    let relatedGoalIds: string[] = [];
    try { relatedGoalIds = JSON.parse(o.related_goal_ids || '[]'); } catch {}
    const firstGoal = relatedGoalIds[0]
      ? db.prepare('SELECT id, title, priority FROM goals WHERE id = ?').get(relatedGoalIds[0]) as { id: string; title: string; priority: string | null } | undefined
      : undefined;
    candidates.push({
      id: o.id, source_type: 'opportunity', title: o.title, action_type: o.connector_source,
      confidence: o.confidence, priority: null, estimated_effort: o.required_effort, estimated_cost: null,
      time_to_impact_days: null,
      expected_impact: o.opportunity_value != null ? `${o.opportunity_value} ${o.opportunity_unit ?? ''}`.trim() : null,
      goal_id: firstGoal?.id ?? null, goal_priority: firstGoal?.priority ?? null, goal_title: firstGoal?.title ?? null,
    });
  }

  const strategies = db.prepare(`
    SELECT s.id, s.name, s.confidence, s.estimated_effort, s.estimated_cost, s.time_to_impact_days,
           s.expected_impact_summary, s.goal_id, g.priority AS goal_priority, g.title AS goal_title
    FROM goal_strategies s
    JOIN goals g ON g.id = s.goal_id
    WHERE s.business_id = ? AND s.status = 'candidate' AND g.status = 'active'
      AND s.assessment_id = (SELECT id FROM goal_assessments WHERE goal_id = s.goal_id ORDER BY created_at DESC LIMIT 1)
  `).all(businessId) as Array<{ id: string; name: string; confidence: number | null; estimated_effort: string | null; estimated_cost: number | null; time_to_impact_days: number | null; expected_impact_summary: string | null; goal_id: string; goal_priority: string | null; goal_title: string }>;
  for (const s of strategies) {
    candidates.push({
      id: s.id, source_type: 'strategy', title: s.name, action_type: null,
      confidence: s.confidence, priority: null, estimated_effort: s.estimated_effort, estimated_cost: s.estimated_cost,
      time_to_impact_days: s.time_to_impact_days, expected_impact: s.expected_impact_summary,
      goal_id: s.goal_id, goal_priority: s.goal_priority, goal_title: s.goal_title,
    });
  }

  return candidates;
}

function hasOpenConflict(businessId: string, entityType: string, entityId: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM conflicts WHERE business_id = ? AND status = 'open' AND ((entity_a_type = ? AND entity_a_id = ?) OR (entity_b_type = ? AND entity_b_id = ?))"
  ).get(businessId, entityType, entityId, entityType, entityId);
  return Boolean(row);
}

export function getRankedRecommendations(businessId: string, opts: { limit?: number } = {}): { recommendations: RankedRecommendation[]; excluded: ExcludedRecommendation[] } {
  const limit = opts.limit ?? 20;
  const candidates = gatherCandidates(businessId);
  const recommendations: RankedRecommendation[] = [];
  const excluded: ExcludedRecommendation[] = [];

  for (const c of candidates) {
    const constraintResult = checkConstraints(businessId, {
      action_type: c.action_type, estimated_cost: c.estimated_cost,
    });
    if (!constraintResult.allowed) {
      const blocking = constraintResult.violations.find((v) => v.severity === 'blocking');
      excluded.push({
        id: c.id, source_type: c.source_type, title: c.title,
        reason: blocking?.note ?? `Blocked by a ${blocking?.constraint_type ?? 'constraint'} constraint.`,
      });
      continue;
    }

    const track = c.action_type ? actionTypeTrackRecord(businessId, c.action_type) : null;
    // Opportunities (goal_suggestions) aren't tracked as conflict entities
    // today — only their linked goal (if any) can carry a conflict.
    const conflict = c.source_type === 'task'
      ? hasOpenConflict(businessId, 'task', c.id)
      : c.goal_id
        ? hasOpenConflict(businessId, 'goal', c.goal_id)
        : false;

    const confidenceScore = c.confidence ?? 0.5;
    const goalWeight = priorityWeight(c.goal_priority ?? c.priority);
    const urgency = urgencyFromDays(c.time_to_impact_days);
    const historicalScore = track?.success_rate ?? 0.5;
    const effortScore = effortWeight(c.estimated_effort);
    const riskPenalty = conflict ? 1 : 0;

    const score = Math.round((
      0.25 * confidenceScore +
      0.20 * goalWeight +
      0.15 * urgency +
      0.15 * historicalScore +
      0.15 * effortScore +
      0.10 * (1 - riskPenalty)
    ) * 1000) / 1000;

    const rationale: string[] = [];
    rationale.push(`Confidence ${Math.round(confidenceScore * 100)}%`);
    if (c.goal_title) rationale.push(`Serves goal "${c.goal_title}"${c.goal_priority ? ` (${c.goal_priority})` : ''}`);
    if (track && track.sample_size > 0) rationale.push(`Historically ${Math.round((track.success_rate ?? 0) * 100)}% successful for "${c.action_type}" (n=${track.sample_size})`);
    else if (c.action_type) rationale.push(`No prior track record for "${c.action_type}" yet`);
    if (c.estimated_effort) rationale.push(`${c.estimated_effort} effort`);
    if (c.time_to_impact_days != null) rationale.push(`~${c.time_to_impact_days}d to impact`);
    if (conflict) rationale.push('⚠ Has an open, unresolved conflict — review before acting');

    recommendations.push({
      id: c.id, source_type: c.source_type, title: c.title, score, rationale,
      expected_impact: c.expected_impact, confidence: c.confidence,
      estimated_cost: c.estimated_cost, estimated_effort: c.estimated_effort,
      historical_success_rate: track?.success_rate ?? null, historical_sample_size: track?.sample_size ?? 0,
      goal_id: c.goal_id, goal_title: c.goal_title, has_open_conflict: conflict,
    });
  }

  recommendations.sort((a, b) => b.score - a.score);
  return { recommendations: recommendations.slice(0, limit), excluded };
}
