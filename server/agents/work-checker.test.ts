import { describe, test, expect, beforeEach, afterAll } from 'bun:test';

const { default: db } = await import('../db/db.js');
const { hasWorkToDo } = await import('./work-checker.js');

const BIZ = 'biz_work_checker_regression';

beforeEach(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Work Checker Regression', 'work-checker-regression') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agent_runs WHERE business_id = ?').run(BIZ);
});

afterAll(() => {
  db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(BIZ);
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agent_runs WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
});

function insertTask(id: string, status: string, rejectionReason: string | null = null): void {
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, action_type, action_payload, status, rejection_reason)
    VALUES (?, ?, 'Work checker test task', 'test', 'investigation', '{}', ?, ?)
  `).run(id, BIZ, status, rejectionReason);
}

describe('conductor work check autonomous progression integration', () => {
  test('runs for any proposed task even when there are no new signals, syncs, or inbox events', () => {
    insertTask('tsk_work_checker_proposed', 'proposed');

    const conductor = hasWorkToDo('conductor', BIZ);
    const specialist = hasWorkToDo('seo-sentinel', BIZ);

    expect(conductor.hasWork).toBe(true);
    expect(conductor.reasons.some((reason) => reason.includes('proposed'))).toBe(true);
    expect(specialist.hasWork).toBe(false);
  });

  test('runs for an exact recoverable autonomous hold but ignores genuine manual review outcomes', () => {
    insertTask('tsk_work_checker_recoverable', 'manual_review', 'Held for human/policy review: prior classifier hold');
    insertTask('tsk_work_checker_genuine', 'manual_review', 'Execution outcome is ambiguous');

    const conductor = hasWorkToDo('conductor', BIZ);

    expect(conductor.hasWork).toBe(true);
    expect(conductor.reasons.some((reason) => reason.includes('recoverable'))).toBe(true);
    expect(conductor.reasons.some((reason) => reason.includes('manual_review'))).toBe(false);

    db.prepare('DELETE FROM tasks WHERE id = ?').run('tsk_work_checker_recoverable');
    const genuineOnly = hasWorkToDo('conductor', BIZ);
    expect(genuineOnly.hasWork).toBe(false);
  });
});
