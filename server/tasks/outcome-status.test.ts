import { describe, test, expect } from 'bun:test';
import { computeOutcomeStatus } from './outcome-status.js';

describe('computeOutcomeStatus', () => {
  test('abandoned takes priority over everything else', () => {
    expect(computeOutcomeStatus({ task_status: 'rejected', target_metric: 'gsc.clicks', completed_at: null, checks: [] })).toEqual({ status: 'abandoned', is_final: true });
    expect(computeOutcomeStatus({ task_status: 'cancelled', target_metric: 'gsc.clicks', completed_at: null, checks: [{ weeks_after: 4, verdict: 'improved' }] })).toEqual({ status: 'abandoned', is_final: true });
  });

  test('no target_metric means not tracked at all (null status)', () => {
    expect(computeOutcomeStatus({ task_status: 'complete', target_metric: null, completed_at: new Date().toISOString(), checks: [] })).toEqual({ status: null, is_final: false });
  });

  test('not yet complete/verified, target_metric set -> pending', () => {
    expect(computeOutcomeStatus({ task_status: 'executing', target_metric: 'x', completed_at: null, checks: [] })).toEqual({ status: 'pending', is_final: false });
    expect(computeOutcomeStatus({ task_status: 'approved', target_metric: 'x', completed_at: null, checks: [] })).toEqual({ status: 'pending', is_final: false });
  });

  test('complete but within the 2-week grace period with no check yet -> pending', () => {
    const completedAt = new Date(Date.now() - 3 * 86400000).toISOString(); // 3 days ago
    expect(computeOutcomeStatus({ task_status: 'complete', target_metric: 'x', completed_at: completedAt, checks: [] })).toEqual({ status: 'pending', is_final: false });
  });

  test('complete, past 2 weeks, no check row yet (job has not run) -> measuring', () => {
    const completedAt = new Date(Date.now() - 20 * 86400000).toISOString(); // 20 days ago
    expect(computeOutcomeStatus({ task_status: 'complete', target_metric: 'x', completed_at: completedAt, checks: [] })).toEqual({ status: 'measuring', is_final: false });
  });

  test('a 2-week improved check is "successful" but not final', () => {
    expect(computeOutcomeStatus({ task_status: 'verified', target_metric: 'x', completed_at: null, checks: [{ weeks_after: 2, verdict: 'improved' }] }))
      .toEqual({ status: 'successful', is_final: false });
  });

  test('a 4-week improved check is "successful" and final', () => {
    expect(computeOutcomeStatus({
      task_status: 'verified', target_metric: 'x', completed_at: null,
      checks: [{ weeks_after: 2, verdict: 'improved' }, { weeks_after: 4, verdict: 'improved' }],
    })).toEqual({ status: 'successful', is_final: true });
  });

  test('worsened -> unsuccessful, no_change -> neutral', () => {
    expect(computeOutcomeStatus({ task_status: 'verified', target_metric: 'x', completed_at: null, checks: [{ weeks_after: 4, verdict: 'worsened' }] }).status).toBe('unsuccessful');
    expect(computeOutcomeStatus({ task_status: 'verified', target_metric: 'x', completed_at: null, checks: [{ weeks_after: 4, verdict: 'no_change' }] }).status).toBe('neutral');
  });

  test('an unrecognized/null verdict on the latest check falls back to measuring', () => {
    expect(computeOutcomeStatus({ task_status: 'verified', target_metric: 'x', completed_at: null, checks: [{ weeks_after: 2, verdict: null }] }).status).toBe('measuring');
  });

  test('uses only the latest (last) check when multiple exist, ordered ascending', () => {
    const result = computeOutcomeStatus({
      task_status: 'verified', target_metric: 'x', completed_at: null,
      checks: [{ weeks_after: 2, verdict: 'worsened' }, { weeks_after: 4, verdict: 'improved' }],
    });
    expect(result.status).toBe('successful'); // the 4-week check wins, not the 2-week one
  });
});
