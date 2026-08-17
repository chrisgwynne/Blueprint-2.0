/**
 * Retention / downgrade / retirement rules (#56, second half).
 *
 * Measured outcomes must not only shape future HIRING decisions — they must
 * also flag agents already hired that are producing persistently low or
 * negative value, with business-scoped explainable evidence.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import db from '../../db/db.js';
import {
  assertHiringTestIsolation, cleanupTestBusinesses, createTestBusiness,
} from './test-harness.js';
import { createTrial, recordInstallation, recordTrialOutcome } from './store.js';
import { evaluateRetention, verdictFor } from './retention.js';
import { getHiringStatus } from './contract.js';
import type { OutcomeHistory } from './store.js';
import type { TrialVerdict } from './types.js';

assertHiringTestIsolation();

const BIZ = createTestBusiness('ret_a');
const BIZ_B = createTestBusiness('ret_b');

function reset(): void {
  cleanupTestBusinesses(BIZ, BIZ_B);
  createTestBusiness('ret_a');
  createTestBusiness('ret_b');
}

function addTrial(biz: string, template: string, verdict: TrialVerdict | null, cost = 1): void {
  const id = createTrial(biz, template, {
    goal_id: null, signal_id: null, target_metric: 'm',
    baseline_value: 0, target_value: 1, measurement_window_days: 7,
    evidence_deliverable: 'x',
  }, { confidence: 0.8 });
  if (verdict) recordTrialOutcome(biz, id, { verdict, costUsd: cost });
}

beforeEach(reset);
afterAll(() => cleanupTestBusinesses(BIZ, BIZ_B));

const emptyHistory: OutcomeHistory = {
  total: 0, successful: 0, neutral: 0, unsuccessful: 0, insufficient_data: 0,
  open: 0, last_verdict: null, last_verdict_reason: null,
  mean_calibration_error: null, total_cost_usd: 0,
};

describe('retention verdict rules (unit)', () => {
  test('two unsuccessful trials with no successes ⇒ retire', () => {
    const v = verdictFor({ ...emptyHistory, total: 2, unsuccessful: 2 }, 60);
    expect(v.verdict).toBe('retire');
    expect(v.reason).toContain('unsuccessful');
  });

  test('three no-evidence trials with no successes ⇒ retire', () => {
    const v = verdictFor({ ...emptyHistory, total: 3, insufficient_data: 3 }, 60);
    expect(v.verdict).toBe('retire');
  });

  test('one unsuccessful trial with no successes ⇒ downgrade', () => {
    expect(verdictFor({ ...emptyHistory, total: 1, unsuccessful: 1 }, 60).verdict).toBe('downgrade');
  });

  test('a successful record ⇒ retain', () => {
    const v = verdictFor({ ...emptyHistory, total: 2, successful: 2 }, 60);
    expect(v.verdict).toBe('retain');
    expect(v.reason).toContain('succeeded');
  });

  test('a trial still inside its window ⇒ monitor', () => {
    expect(verdictFor({ ...emptyHistory, total: 1, open: 1 }, 60).verdict).toBe('monitor');
  });

  test('no trials but past the grace period ⇒ downgrade with an explicit reason', () => {
    const v = verdictFor(emptyHistory, 90);
    expect(v.verdict).toBe('downgrade');
    expect(v.reason).toContain('no trial on record');
  });

  test('no trials but inside the grace period ⇒ monitor', () => {
    expect(verdictFor(emptyHistory, 5).verdict).toBe('monitor');
  });

  test('purely neutral outcomes ⇒ monitor, never retire', () => {
    expect(verdictFor({ ...emptyHistory, total: 3, neutral: 3 }, 60).verdict).toBe('monitor');
  });
});

describe('evaluateRetention over installed agents', () => {
  test('assesses each installed agent with explainable evidence', () => {
    recordInstallation(BIZ, 'good-agent', { installedBy: 'test' });
    recordInstallation(BIZ, 'bad-agent', { installedBy: 'test' });
    addTrial(BIZ, 'good-agent', 'successful', 2);
    addTrial(BIZ, 'bad-agent', 'unsuccessful', 5);
    addTrial(BIZ, 'bad-agent', 'unsuccessful', 5);

    const out = evaluateRetention(BIZ);
    const good = out.find((r) => r.agent_id === 'good-agent')!;
    const bad = out.find((r) => r.agent_id === 'bad-agent')!;

    expect(good.verdict).toBe('retain');
    expect(good.evidence.successful).toBe(1);
    expect(bad.verdict).toBe('retire');
    expect(bad.evidence.unsuccessful).toBe(2);
    expect(bad.evidence.total_cost_usd).toBe(10);
    expect(bad.reason).toBeTruthy();
  });

  test('an uninstalled agent is not assessed', () => {
    recordInstallation(BIZ, 'gone', { installedBy: 'test' });
    db.prepare("UPDATE agent_installations SET status='uninstalled' WHERE business_id = ? AND agent_id='gone'").run(BIZ);
    expect(evaluateRetention(BIZ).map((r) => r.agent_id)).not.toContain('gone');
  });

  test('verdicts never cross businesses', () => {
    recordInstallation(BIZ, 'shared-agent', { installedBy: 'test' });
    recordInstallation(BIZ_B, 'shared-agent', { installedBy: 'test' });
    addTrial(BIZ, 'shared-agent', 'unsuccessful');
    addTrial(BIZ, 'shared-agent', 'unsuccessful');

    expect(evaluateRetention(BIZ)[0]!.verdict).toBe('retire');
    // B has the same agent installed with no bad history of its own.
    expect(evaluateRetention(BIZ_B)[0]!.verdict).toBe('monitor');
  });

  test('retention is surfaced on the business-scoped status contract', () => {
    recordInstallation(BIZ, 'bad-agent', { installedBy: 'test' });
    addTrial(BIZ, 'bad-agent', 'unsuccessful');
    addTrial(BIZ, 'bad-agent', 'unsuccessful');

    const status = getHiringStatus(BIZ);
    expect(status.retention).toHaveLength(1);
    expect(status.retention[0]!.agent_id).toBe('bad-agent');
    expect(status.retention[0]!.verdict).toBe('retire');
    expect(getHiringStatus(BIZ_B).retention).toHaveLength(0);
  });

  test('assessment is advisory — it never retires anything by itself', () => {
    recordInstallation(BIZ, 'bad-agent', { installedBy: 'test' });
    addTrial(BIZ, 'bad-agent', 'unsuccessful');
    addTrial(BIZ, 'bad-agent', 'unsuccessful');

    expect(evaluateRetention(BIZ)[0]!.verdict).toBe('retire');
    const row = db.prepare('SELECT status FROM agent_installations WHERE business_id = ? AND agent_id = ?')
      .get(BIZ, 'bad-agent') as { status: string };
    expect(row.status).toBe('installed');
  });
});
