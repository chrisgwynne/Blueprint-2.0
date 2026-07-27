import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { actionTypeTrackRecord, haveWeSeenThisBefore } from './historical-learning.js';

const BIZ = 'biz_hist_learning';

function insertTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, target_metric, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, 'agent:x', ?, 'yellow', 'requires_approval', ?, 'gsc.avg_ctr', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, BIZ, (overrides.title as string) ?? 'Fixture', (overrides.status as string) ?? 'verified',
    (overrides.action_type as string) ?? 'meta_update', (overrides.completed_at as string) ?? new Date().toISOString(),
  );
  return id;
}

function insertCheck(taskId: string, weeksAfter: number, verdict: string): void {
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, verdict, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
  `).run(generateId(), taskId, weeksAfter, verdict);
}

function insertActionMemory(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO action_memory (id, business_id, task_id, action_type, title, target_url, measurement_window_start, measurement_window_end, do_not_touch_until, outcome_measured, outcome_summary)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now','-30 days'), datetime('now','-2 days'), datetime('now','-2 days'), ?, ?)
  `).run(
    id, BIZ, (overrides.task_id as string) ?? null, (overrides.action_type as string) ?? 'meta_update',
    (overrides.title as string) ?? 'Fixture action', (overrides.target_url as string) ?? null,
    overrides.outcome_measured ? 1 : 0, (overrides.outcome_summary as string) ?? null,
  );
  return id;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Hist Learning', 'hist-learning') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM action_memory WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

describe('actionTypeTrackRecord', () => {
  test('returns null for a null action_type', () => {
    expect(actionTypeTrackRecord(BIZ, null)).toBeNull();
  });

  test('computes sample_size/success_rate only from final (>=4wk) outcomes', () => {
    const t1 = insertTask({ action_type: 'track_record_type', status: 'verified' });
    insertCheck(t1, 4, 'improved');
    const t2 = insertTask({ action_type: 'track_record_type', status: 'verified' });
    insertCheck(t2, 4, 'worsened');
    const t3 = insertTask({ action_type: 'track_record_type', status: 'verified' });
    insertCheck(t3, 2, 'improved'); // not final yet — excluded

    const result = actionTypeTrackRecord(BIZ, 'track_record_type');
    expect(result?.sample_size).toBe(2);
    expect(result?.success_count).toBe(1);
    expect(result?.success_rate).toBe(0.5);
  });

  test('sample_size 0 gives a null success_rate, not NaN or 0', () => {
    const result = actionTypeTrackRecord(BIZ, 'never_used_action_type');
    expect(result?.sample_size).toBe(0);
    expect(result?.success_rate).toBeNull();
  });
});

describe('haveWeSeenThisBefore', () => {
  test('insufficient_data when no query field is supplied', () => {
    const result = haveWeSeenThisBefore(BIZ, {});
    expect(result.seen_before).toBe(false);
    expect(result.recommendation).toBe('insufficient_data');
  });

  test('seen_before is false with no prior action_memory rows', () => {
    const result = haveWeSeenThisBefore(BIZ, { action_type: 'totally_novel_action' });
    expect(result.seen_before).toBe(false);
    expect(result.prior_instances).toHaveLength(0);
  });

  test('recommends repeat when track record is strong', () => {
    for (let i = 0; i < 3; i++) {
      const t = insertTask({ action_type: 'repeat_worthy', status: 'verified' });
      insertCheck(t, 4, 'improved');
      insertActionMemory({ task_id: t, action_type: 'repeat_worthy', outcome_measured: true });
    }
    const result = haveWeSeenThisBefore(BIZ, { action_type: 'repeat_worthy' });
    expect(result.seen_before).toBe(true);
    expect(result.recommendation).toBe('repeat');
    expect(result.track_record?.success_rate).toBe(1);
  });

  test('recommends avoid when track record is poor', () => {
    for (let i = 0; i < 3; i++) {
      const t = insertTask({ action_type: 'avoid_worthy', status: 'verified' });
      insertCheck(t, 4, 'worsened');
      insertActionMemory({ task_id: t, action_type: 'avoid_worthy', outcome_measured: true });
    }
    const result = haveWeSeenThisBefore(BIZ, { action_type: 'avoid_worthy' });
    expect(result.recommendation).toBe('avoid');
  });

  test('matches by target_url independent of action_type', () => {
    insertActionMemory({ action_type: 'meta_update', target_url: '/products/widget' });
    const result = haveWeSeenThisBefore(BIZ, { target_url: '/products/widget' });
    expect(result.seen_before).toBe(true);
  });
});
