import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { recalculateCalibrationForBusiness, getLatestCalibration, adjustedConfidence, effectiveTrustTier } from './calibration.js';

const BIZ = 'biz_calibration_test';

function insertTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, confidence, completed_at, created_at, updated_at)
    VALUES (?, ?, 'Fixture', ?, ?, 'yellow', 'requires_approval', 'meta_update', ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, BIZ, (overrides.proposed_by as string) ?? 'agent:cal_test_agent',
    (overrides.status as string) ?? 'verified',
    (overrides.confidence as number) ?? 0.8,
    (overrides.completed_at as string) ?? new Date().toISOString(),
    (overrides.created_at as string) ?? new Date().toISOString(),
  );
  return id;
}

function insertCheck(taskId: string, verdict: string): void {
  db.prepare(`INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, verdict, created_at) VALUES (?, ?, CURRENT_TIMESTAMP, 4, ?, CURRENT_TIMESTAMP)`)
    .run(generateId(), taskId, verdict);
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Calibration Test', 'calibration-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM agent_calibration WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

describe('recalculateCalibrationForBusiness', () => {
  test('an overconfident agent gets a positive calibration_error and offset', () => {
    const agent = 'overconfident_agent';
    for (let i = 0; i < 4; i++) {
      const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.9 });
      insertCheck(t, 'worsened'); // stated 0.9, actual failure
    }
    const results = recalculateCalibrationForBusiness(BIZ);
    const r = results.find((x) => x.agent === agent);
    expect(r).toBeDefined();
    expect(r!.error).toBeGreaterThan(0);
    expect(r!.offset).toBeGreaterThan(0);
    expect(r!.falsePositives).toBe(4);
  });

  test('an underconfident agent gets a negative calibration_error', () => {
    const agent = 'underconfident_agent';
    for (let i = 0; i < 4; i++) {
      const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.3 });
      insertCheck(t, 'improved'); // stated low, actual success
    }
    const results = recalculateCalibrationForBusiness(BIZ);
    const r = results.find((x) => x.agent === agent);
    expect(r!.error).toBeLessThan(0);
    expect(r!.falseNegatives).toBe(4);
  });

  test('a well-calibrated agent gets a near-zero error and a high score', () => {
    const agent = 'well_calibrated_agent';
    for (let i = 0; i < 3; i++) {
      const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.7 });
      insertCheck(t, 'improved');
    }
    for (let i = 0; i < 1; i++) {
      const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.7 });
      insertCheck(t, 'worsened');
    }
    const results = recalculateCalibrationForBusiness(BIZ);
    const r = results.find((x) => x.agent === agent);
    expect(Math.abs(r!.error)).toBeLessThan(0.2);
    expect(r!.score).toBeGreaterThan(0.7);
  });

  test('agents with fewer than 3 outcomes are skipped entirely', () => {
    const agent = 'sparse_agent';
    const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.9 });
    insertCheck(t, 'worsened');
    const results = recalculateCalibrationForBusiness(BIZ);
    expect(results.find((x) => x.agent === agent)).toBeUndefined();
  });

  test('conservatism_factor rises to 1.5 after repeated overconfidence, making the offset larger than the raw error', () => {
    const agent = 'repeatedly_overconfident_agent';
    const runOverconfidentPeriod = () => {
      for (let i = 0; i < 4; i++) {
        const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.95 });
        insertCheck(t, 'worsened');
      }
      return recalculateCalibrationForBusiness(BIZ).find((x) => x.agent === agent)!;
    };
    const first = runOverconfidentPeriod();
    expect(first.conservatismFactor).toBe(1.0); // no prior history yet
    const second = runOverconfidentPeriod();
    expect(second.conservatismFactor).toBe(1.5);
    expect(Math.abs(second.offset)).toBeGreaterThan(Math.abs(second.error) * 1.1);
  });

  test('recommendations_accepted/rejected reflect tasks.status, not just outcome-bearing tasks', () => {
    const agent = 'acceptance_tracked_agent';
    insertTask({ proposed_by: `agent:${agent}`, status: 'rejected', confidence: 0.6 });
    insertTask({ proposed_by: `agent:${agent}`, status: 'rejected', confidence: 0.6 });
    for (let i = 0; i < 3; i++) {
      const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.6, status: 'verified' });
      insertCheck(t, 'improved');
    }
    const results = recalculateCalibrationForBusiness(BIZ);
    const r = results.find((x) => x.agent === agent)!;
    expect(r.recommendationsRejected).toBe(2);
    expect(r.recommendationsAccepted).toBeGreaterThanOrEqual(3);
  });

  test('bins array has 5 entries covering the full 0-100% confidence range', () => {
    const agent = 'binned_agent';
    for (let i = 0; i < 3; i++) {
      const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.85 });
      insertCheck(t, 'improved');
    }
    const results = recalculateCalibrationForBusiness(BIZ);
    const r = results.find((x) => x.agent === agent)!;
    expect(r.bins).toHaveLength(5);
    expect(r.bins[0]!.range).toBe('0-20%');
    expect(r.bins[4]!.range).toBe('80-100%');
  });
});

describe('adjustedConfidence / effectiveTrustTier', () => {
  test('adjustedConfidence subtracts the stored offset and clamps to [0,1]', () => {
    const agent = 'adjustment_test_agent';
    for (let i = 0; i < 4; i++) {
      const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.95 });
      insertCheck(t, 'worsened');
    }
    recalculateCalibrationForBusiness(BIZ);
    const adjusted = adjustedConfidence(0.95, agent, BIZ);
    expect(adjusted).not.toBeNull();
    expect(adjusted!).toBeLessThan(0.95);
    expect(adjusted!).toBeGreaterThanOrEqual(0);
  });

  test('adjustedConfidence returns the stated value unchanged when no calibration exists', () => {
    expect(adjustedConfidence(0.6, 'never_calibrated_agent', BIZ)).toBe(0.6);
  });

  test('effectiveTrustTier escalates to yellow for a meaningfully overconfident agent', () => {
    const agent = 'escalation_test_agent';
    for (let i = 0; i < 4; i++) {
      const t = insertTask({ proposed_by: `agent:${agent}`, confidence: 0.95 });
      insertCheck(t, 'worsened');
    }
    recalculateCalibrationForBusiness(BIZ);
    expect(effectiveTrustTier('green', agent, BIZ)).toBe('yellow');
  });

  test('getLatestCalibration returns null for an agent with no rows', () => {
    expect(getLatestCalibration('totally_unknown_agent', BIZ)).toBeNull();
  });
});
