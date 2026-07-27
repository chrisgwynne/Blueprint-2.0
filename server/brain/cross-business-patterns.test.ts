import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { updateCrossBusinessPatterns, listCrossBusinessPatterns, getCrossBusinessPattern } from './cross-business-patterns.js';

const BIZ_A = 'biz_cbp_test_a';
const BIZ_B = 'biz_cbp_test_b';
const ACTION_TYPE = 'cbp_test_action_type';

function insertTask(businessId: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, target_metric, completed_at, created_at, updated_at)
    VALUES (?, ?, 'Fixture', 'agent:x', 'verified', 'yellow', 'requires_approval', ?, 'gsc.avg_ctr', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId, ACTION_TYPE);
  return id;
}
function insertCheck(taskId: string, verdict: string): void {
  db.prepare(`INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, verdict, created_at) VALUES (?, ?, CURRENT_TIMESTAMP, 4, ?, CURRENT_TIMESTAMP)`)
    .run(generateId(), taskId, verdict);
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug, type) VALUES (?, 'CBP Test A', 'cbp-test-a', 'ecommerce') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug, type) VALUES (?, 'CBP Test B', 'cbp-test-b', 'saas') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);
});

afterAll(() => {
  db.prepare(`DELETE FROM cross_business_patterns WHERE action_type = ?`).run(ACTION_TYPE);
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (?, ?))`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM businesses WHERE id IN (?, ?)`).run(BIZ_A, BIZ_B);
});

describe('updateCrossBusinessPatterns', () => {
  test('aggregates outcomes across two different businesses into one pattern, without storing either business_id', () => {
    const tA1 = insertTask(BIZ_A);
    insertCheck(tA1, 'improved');
    const tA2 = insertTask(BIZ_A);
    insertCheck(tA2, 'improved');
    const tB1 = insertTask(BIZ_B);
    insertCheck(tB1, 'worsened');

    const patterns = updateCrossBusinessPatterns();
    const pattern = patterns.find((p) => p.action_type === ACTION_TYPE);
    expect(pattern).toBeDefined();
    expect(pattern!.sample_size).toBe(3);
    expect(pattern!.success_count).toBe(2);
    expect(pattern!.success_rate).toBeCloseTo(0.667, 2);
    expect(pattern!.applicable_business_types.sort()).toEqual(['ecommerce', 'saas']);

    // Verify directly against the DB row that no business-identifying
    // column exists to check in the first place.
    const row = db.prepare('SELECT * FROM cross_business_patterns WHERE action_type = ?').get(ACTION_TYPE) as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain('business_id');
    expect(JSON.stringify(row)).not.toContain(BIZ_A);
    expect(JSON.stringify(row)).not.toContain(BIZ_B);
  });

  test('re-running updates the same row rather than duplicating it', () => {
    updateCrossBusinessPatterns();
    updateCrossBusinessPatterns();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM cross_business_patterns WHERE action_type = ?').get(ACTION_TYPE) as { n: number }).n;
    expect(count).toBe(1);
  });

  test('getCrossBusinessPattern looks up by action_type', () => {
    const pattern = getCrossBusinessPattern(ACTION_TYPE);
    expect(pattern?.action_type).toBe(ACTION_TYPE);
  });
});

describe('listCrossBusinessPatterns', () => {
  test('filtering by business_type includes patterns with no type restriction or a matching one', () => {
    const all = listCrossBusinessPatterns();
    expect(all.some((p) => p.action_type === ACTION_TYPE)).toBe(true);

    const ecommerceOnly = listCrossBusinessPatterns('ecommerce');
    expect(ecommerceOnly.some((p) => p.action_type === ACTION_TYPE)).toBe(true);
  });
});
