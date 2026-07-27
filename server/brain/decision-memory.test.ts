import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { recordDecision, recallDecisions, getDecision } from './decision-memory.js';

const BIZ_A = 'biz_decision_memory_a';
const BIZ_B = 'biz_decision_memory_b';

function insertGoal(businessId: string): string {
  const id = generateId();
  db.prepare(`INSERT INTO goals (id, business_id, title, status, created_at, updated_at) VALUES (?, ?, 'Fixture goal', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(id, businessId);
  return id;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Decision Memory A', 'decision-memory-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Decision Memory B', 'decision-memory-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);
});

afterAll(() => {
  db.prepare(`DELETE FROM decisions WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goals WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM businesses WHERE id IN (?, ?)`).run(BIZ_A, BIZ_B);
});

describe('recordDecision / getDecision', () => {
  test('round-trips evidence and alternatives_rejected as real arrays, not strings', () => {
    const goalId = insertGoal(BIZ_A);
    const id = recordDecision({
      business_id: BIZ_A, decision_type: 'strategy_selection',
      title: 'Chose SEO over paid ads', decision: 'Pursue organic SEO first.',
      reasoning: 'Higher historical success rate.', confidence: 0.8,
      evidence: [{ note: 'past SEO campaigns succeeded 70% of the time' }],
      alternatives_rejected: [{ name: 'Paid ads', confidence: 0.4 }],
      author: 'goal-reasoner', related_goal_id: goalId,
    });

    const decision = getDecision(id, BIZ_A);
    expect(decision?.title).toBe('Chose SEO over paid ads');
    expect(decision?.related_goal_id).toBe(goalId);
    expect(Array.isArray(decision?.evidence)).toBe(true);
    expect(Array.isArray(decision?.alternatives_rejected)).toBe(true);
    expect((decision?.alternatives_rejected as any[])[0].name).toBe('Paid ads');
  });

  test('getDecision returns null across tenants', () => {
    const id = recordDecision({
      business_id: BIZ_A, decision_type: 'manual', title: 'x', decision: 'x', author: 'human',
    });
    expect(getDecision(id, BIZ_B)).toBeNull();
  });
});

describe('recallDecisions', () => {
  test('filters by decision_type and related_goal_id, paginates, and stays tenant-scoped', () => {
    const goalId = insertGoal(BIZ_A);
    recordDecision({ business_id: BIZ_A, decision_type: 'task_approval', title: 'Approved X', decision: 'x', author: 'human', related_goal_id: goalId });
    recordDecision({ business_id: BIZ_A, decision_type: 'task_rejection', title: 'Rejected Y', decision: 'y', author: 'human' });
    recordDecision({ business_id: BIZ_B, decision_type: 'task_approval', title: 'Other tenant', decision: 'z', author: 'human' });

    const byType = recallDecisions(BIZ_A, { decision_type: 'task_approval' });
    expect(byType.decisions.every((d) => d.decision_type === 'task_approval')).toBe(true);
    expect(byType.decisions.some((d) => d.title === 'Other tenant')).toBe(false);

    const byGoal = recallDecisions(BIZ_A, { related_goal_id: goalId });
    expect(byGoal.total).toBe(1);
    expect(byGoal.decisions[0]?.title).toBe('Approved X');
  });

  test('q searches title/decision/reasoning text', () => {
    recordDecision({ business_id: BIZ_A, decision_type: 'manual', title: 'Meta rewrite decision', decision: 'Changed the door-toppers meta.', author: 'human' });
    const result = recallDecisions(BIZ_A, { q: 'door-toppers' });
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  test('pagination limit/page are honoured', () => {
    for (let i = 0; i < 5; i++) {
      recordDecision({ business_id: BIZ_A, decision_type: 'manual', title: `Page test ${i}`, decision: 'x', author: 'human' });
    }
    const page1 = recallDecisions(BIZ_A, { q: 'Page test', limit: 2, page: 1 });
    expect(page1.decisions).toHaveLength(2);
    expect(page1.total).toBe(5);
  });
});
