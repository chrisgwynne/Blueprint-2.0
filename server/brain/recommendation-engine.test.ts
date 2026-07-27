import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { getRankedRecommendations } from './recommendation-engine.js';

const BIZ = 'biz_recommendation_engine_test';

function insertTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, confidence, priority, goal_id, created_at, updated_at)
    VALUES (?, ?, ?, 'agent:x', 'proposed', 'yellow', 'requires_approval', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, BIZ, (overrides.title as string) ?? 'Fixture task', (overrides.action_type as string) ?? null,
    (overrides.confidence as number) ?? 0.7, (overrides.priority as string) ?? 'p2', (overrides.goal_id as string) ?? null,
  );
  return id;
}

function insertGoal(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`INSERT INTO goals (id, business_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .run(id, BIZ, (overrides.title as string) ?? 'Fixture goal', (overrides.priority as string) ?? 'p2');
  return id;
}

function insertOpportunity(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO goal_suggestions (id, business_id, title, confidence, opportunity_value, opportunity_unit, status, required_effort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, BIZ, (overrides.title as string) ?? 'Fixture opportunity', (overrides.confidence as number) ?? 0.8, (overrides.opportunity_value as number) ?? 500, 'gbp_per_month', (overrides.required_effort as string) ?? 'low');
  return id;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Recommendation Engine Test', 'recommendation-engine-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM conflicts WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM constraints WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM goal_suggestions WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM goal_strategies WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM goal_assessments WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM goals WHERE business_id = ?`).run(BIZ);
});

describe('getRankedRecommendations', () => {
  test('empty business returns no recommendations and no exclusions', () => {
    const result = getRankedRecommendations('biz_nonexistent_rec_test');
    expect(result.recommendations).toHaveLength(0);
    expect(result.excluded).toHaveLength(0);
  });

  test('a task linked to a p1 goal outranks an otherwise-identical task linked to a p3 goal', () => {
    const p1Goal = insertGoal({ priority: 'p1' });
    const p3Goal = insertGoal({ priority: 'p3' });
    const highPriorityTaskId = insertTask({ title: 'High priority task', confidence: 0.7, goal_id: p1Goal });
    const lowPriorityTaskId = insertTask({ title: 'Low priority task', confidence: 0.7, goal_id: p3Goal });

    const { recommendations } = getRankedRecommendations(BIZ);
    const high = recommendations.find((r) => r.id === highPriorityTaskId)!;
    const low = recommendations.find((r) => r.id === lowPriorityTaskId)!;
    expect(high.score).toBeGreaterThan(low.score);
  });

  test('includes opportunities as a distinct source_type with rationale', () => {
    const oppId = insertOpportunity();
    const { recommendations } = getRankedRecommendations(BIZ);
    const opp = recommendations.find((r) => r.id === oppId);
    expect(opp).toBeDefined();
    expect(opp!.source_type).toBe('opportunity');
    expect(opp!.rationale.length).toBeGreaterThan(0);
  });

  test('a candidate matching a blocking constraint is excluded, not ranked, with a reason', () => {
    db.prepare(`INSERT INTO constraints (id, business_id, constraint_type, scope, active) VALUES (?, ?, 'freeze', ?, 1)`)
      .run(generateId(), BIZ, JSON.stringify({ action_type: 'frozen_action_type' }));
    const frozenTaskId = insertTask({ action_type: 'frozen_action_type' });

    const { recommendations, excluded } = getRankedRecommendations(BIZ);
    expect(recommendations.some((r) => r.id === frozenTaskId)).toBe(false);
    const exclusion = excluded.find((e) => e.id === frozenTaskId);
    expect(exclusion).toBeDefined();
    expect(exclusion!.reason).toBeTruthy();
  });

  test('a task with an open conflict is still ranked but flagged and scores lower than an unconflicted twin', () => {
    const conflictedId = insertTask({ title: 'Conflicted task', confidence: 0.8 });
    const cleanId = insertTask({ title: 'Clean task', confidence: 0.8 });
    db.prepare(`
      INSERT INTO conflicts (id, business_id, conflict_type, category, severity, entity_a_type, entity_a_id, entity_b_type, entity_b_id, description, status)
      VALUES (?, ?, 'task_vs_goal', 'direct', 'warning', 'task', ?, 'goal', ?, 'test conflict', 'open')
    `).run(generateId(), BIZ, conflictedId, insertGoal());

    const { recommendations } = getRankedRecommendations(BIZ);
    const conflicted = recommendations.find((r) => r.id === conflictedId)!;
    const clean = recommendations.find((r) => r.id === cleanId)!;
    expect(conflicted.has_open_conflict).toBe(true);
    expect(clean.has_open_conflict).toBe(false);
    expect(conflicted.score).toBeLessThan(clean.score);
  });

  test('limit truncates the ranked list', () => {
    for (let i = 0; i < 5; i++) insertTask({ title: `Limit test ${i}` });
    const { recommendations } = getRankedRecommendations(BIZ, { limit: 3 });
    expect(recommendations.length).toBeLessThanOrEqual(3);
  });
});
