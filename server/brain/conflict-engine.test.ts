/**
 * Only the deterministic parts of conflict-engine.ts are unit tested here
 * (checkGoalDependencyConflicts needs no LLM call). The LLM-backed
 * detectors (checkGoalConflicts, checkTaskGoalConflicts,
 * checkTaskTaskConflicts, checkSignalGoalConflicts) follow this
 * codebase's existing convention of validating Brain/LLM features via live
 * smoke testing rather than mocked unit tests — see PHASE3.md.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { checkGoalDependencyConflicts } from './conflict-engine.js';

const BIZ = 'biz_conflict_engine_test';

function insertGoal(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO goals (id, business_id, title, status, progress_pct, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, BIZ, (overrides.title as string) ?? 'Fixture goal', (overrides.status as string) ?? 'active', (overrides.progress_pct as number) ?? 0);
  return id;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Conflict Engine Test', 'conflict-engine-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM conflicts WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM goal_dependencies WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM goals WHERE business_id = ?`).run(BIZ);
});

describe('checkGoalDependencyConflicts', () => {
  test('no conflict when there are no dependencies', () => {
    const goalId = insertGoal();
    expect(checkGoalDependencyConflicts(goalId, BIZ)).toEqual([]);
  });

  test('flags a dependency conflict when the depended-on goal is far behind', () => {
    const depId = insertGoal({ title: 'Blocking goal', status: 'active', progress_pct: 10 });
    const goalId = insertGoal({ title: 'Dependent goal' });
    db.prepare(`INSERT INTO goal_dependencies (id, goal_id, depends_on_goal_id, business_id) VALUES (?, ?, ?, ?)`)
      .run(generateId(), goalId, depId, BIZ);

    const ids = checkGoalDependencyConflicts(goalId, BIZ);
    expect(ids).toHaveLength(1);
    const row = db.prepare('SELECT * FROM conflicts WHERE id = ?').get(ids[0]!) as Record<string, unknown>;
    expect(row.conflict_type).toBe('goal_dependency');
    expect(row.category).toBe('dependency');
    expect(row.severity).toBe('warning');
  });

  test('critical severity when the dependency was missed', () => {
    const depId = insertGoal({ title: 'Missed dependency', status: 'missed' });
    const goalId = insertGoal({ title: 'Dependent goal 2' });
    db.prepare(`INSERT INTO goal_dependencies (id, goal_id, depends_on_goal_id, business_id) VALUES (?, ?, ?, ?)`)
      .run(generateId(), goalId, depId, BIZ);

    const ids = checkGoalDependencyConflicts(goalId, BIZ);
    const row = db.prepare('SELECT * FROM conflicts WHERE id = ?').get(ids[0]!) as Record<string, unknown>;
    expect(row.severity).toBe('critical');
  });

  test('no conflict when the dependency is sufficiently progressed', () => {
    const depId = insertGoal({ title: 'On-track dependency', status: 'active', progress_pct: 80 });
    const goalId = insertGoal({ title: 'Dependent goal 3' });
    db.prepare(`INSERT INTO goal_dependencies (id, goal_id, depends_on_goal_id, business_id) VALUES (?, ?, ?, ?)`)
      .run(generateId(), goalId, depId, BIZ);

    expect(checkGoalDependencyConflicts(goalId, BIZ)).toEqual([]);
  });

  test('no conflict for an inactive (non-active) goal', () => {
    const depId = insertGoal({ status: 'active', progress_pct: 0 });
    const goalId = insertGoal({ status: 'paused' });
    db.prepare(`INSERT INTO goal_dependencies (id, goal_id, depends_on_goal_id, business_id) VALUES (?, ?, ?, ?)`)
      .run(generateId(), goalId, depId, BIZ);

    expect(checkGoalDependencyConflicts(goalId, BIZ)).toEqual([]);
  });

  test('does not duplicate an already-open conflict on re-run', () => {
    const depId = insertGoal({ status: 'active', progress_pct: 5 });
    const goalId = insertGoal();
    db.prepare(`INSERT INTO goal_dependencies (id, goal_id, depends_on_goal_id, business_id) VALUES (?, ?, ?, ?)`)
      .run(generateId(), goalId, depId, BIZ);

    const first = checkGoalDependencyConflicts(goalId, BIZ);
    const second = checkGoalDependencyConflicts(goalId, BIZ);
    expect(second).toEqual(first);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE entity_a_id = ? AND status = 'open'").get(goalId) as { n: number }).n;
    expect(count).toBe(1);
  });
});
