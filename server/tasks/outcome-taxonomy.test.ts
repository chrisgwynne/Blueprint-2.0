import { describe, test, expect } from 'bun:test';
import { classifyOutcomeTaxonomy, emptyTaxonomyCounts } from './outcome-taxonomy.js';

// action_type is left null throughout so classifyOutcomeTaxonomy never hits
// the DB-backed action_registry lookup — this keeps these pure unit tests
// (matching the sibling outcome-status.test.ts convention).

describe('classifyOutcomeTaxonomy — issue #63 four-state taxonomy', () => {
  test('task still in flight (not complete/verified) -> activity', () => {
    const result = classifyOutcomeTaxonomy({
      task_id: 't1', task_status: 'executing', action_type: null,
      target_metric: 'ga4.sessions', completed_at: null, checks: [],
    });
    expect(result.state).toBe('activity');
    expect(result.citation.task_id).toBe('t1');
    expect(result.citation.outcome_id).toBeNull();
    expect(result.citation.window_start).toBeNull();
    expect(result.citation.window_end).toBeNull();
  });

  test('task abandoned (rejected) before any verified result -> activity, not verified_action', () => {
    const result = classifyOutcomeTaxonomy({
      task_id: 't2', task_status: 'rejected', action_type: null,
      target_metric: 'ga4.sessions', completed_at: null, checks: [],
    });
    expect(result.state).toBe('activity');
    expect(result.reason).toMatch(/rejected/);
  });

  // ─── "missing outcome data": completed but nothing to measure ───────────
  test('completed task with no target_metric -> verified_action (missing outcome data)', () => {
    const completedAt = new Date(Date.now() - 40 * 86400000).toISOString();
    const result = classifyOutcomeTaxonomy({
      task_id: 't3', task_status: 'complete', action_type: 'shopify_meta_update',
      target_metric: null, completed_at: completedAt, checks: [],
    });
    expect(result.state).toBe('verified_action');
    expect(result.citation.task_id).toBe('t3');
    expect(result.citation.outcome_id).toBeNull();
    expect(result.citation.window_start).toBe(completedAt);
    expect(result.citation.window_end).toBeNull();
    expect(result.citation.window_end_is_expected).toBe(false);
  });

  // ─── "delayed (still inside window)" ─────────────────────────────────────
  test('completed task with target_metric, completed 3 days ago, no check yet -> roi_not_measurable (grace period)', () => {
    const completedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    const result = classifyOutcomeTaxonomy({
      task_id: 't4', task_status: 'complete', action_type: null,
      target_metric: 'gsc.total_clicks', completed_at: completedAt, checks: [],
    });
    expect(result.state).toBe('roi_not_measurable');
    expect(result.citation.window_start).toBe(completedAt);
    expect(result.citation.window_end).not.toBeNull();
    expect(result.citation.window_end_is_expected).toBe(true);
    // Expected close should be 28 days (default final window) after completion.
    const expected = new Date(completedAt);
    expected.setUTCDate(expected.getUTCDate() + 28);
    expect(result.citation.window_end).toBe(expected.toISOString());
  });

  test('completed task, target_metric set, past due window but scheduled check has not run -> roi_not_measurable', () => {
    const completedAt = new Date(Date.now() - 20 * 86400000).toISOString();
    const result = classifyOutcomeTaxonomy({
      task_id: 't5', task_status: 'complete', action_type: null,
      target_metric: 'gsc.total_clicks', completed_at: completedAt, checks: [],
    });
    expect(result.state).toBe('roi_not_measurable');
    expect(result.reason).toMatch(/has not produced a result yet/);
  });

  // ─── "negative outcome" ───────────────────────────────────────────────────
  test('measured, worsened verdict -> outcome_measured, never roi_not_measurable', () => {
    const result = classifyOutcomeTaxonomy({
      task_id: 't6', task_status: 'verified', action_type: null,
      target_metric: 'gsc.total_clicks', completed_at: '2026-06-01T00:00:00.000Z',
      checks: [{ id: 'oc1', weeks_after: 4, verdict: 'worsened', check_date: '2026-06-29T00:00:00.000Z' }],
    });
    expect(result.state).toBe('outcome_measured');
    expect(result.reason).toMatch(/unsuccessful/);
    expect(result.citation).toEqual({
      task_id: 't6', outcome_id: 'oc1',
      window_start: '2026-06-01T00:00:00.000Z',
      window_end: '2026-06-29T00:00:00.000Z',
      window_end_is_expected: false,
    });
  });

  // ─── "successful outcome" ─────────────────────────────────────────────────
  test('measured, improved verdict -> outcome_measured with a citation to the exact outcome row', () => {
    const result = classifyOutcomeTaxonomy({
      task_id: 't7', task_status: 'verified', action_type: null,
      target_metric: 'gsc.total_clicks', completed_at: '2026-05-01T00:00:00.000Z',
      checks: [{ id: 'oc2', weeks_after: 4, verdict: 'improved', check_date: '2026-05-29T00:00:00.000Z' }],
    });
    expect(result.state).toBe('outcome_measured');
    expect(result.reason).toMatch(/successful/);
    expect(result.citation.outcome_id).toBe('oc2');
    expect(result.citation.window_end).toBe('2026-05-29T00:00:00.000Z');
  });

  test('no_change verdict is still an honest outcome_measured, not roi_not_measurable', () => {
    const result = classifyOutcomeTaxonomy({
      task_id: 't8', task_status: 'verified', action_type: null,
      target_metric: 'gsc.total_clicks', completed_at: '2026-05-01T00:00:00.000Z',
      checks: [{ id: 'oc3', weeks_after: 4, verdict: 'no_change', check_date: '2026-05-29T00:00:00.000Z' }],
    });
    expect(result.state).toBe('outcome_measured');
  });

  test('latest (most recent) check wins when multiple exist', () => {
    const result = classifyOutcomeTaxonomy({
      task_id: 't9', task_status: 'verified', action_type: null,
      target_metric: 'gsc.total_clicks', completed_at: '2026-05-01T00:00:00.000Z',
      checks: [
        { id: 'oc4', weeks_after: 2, verdict: 'worsened', check_date: '2026-05-15T00:00:00.000Z' },
        { id: 'oc5', weeks_after: 4, verdict: 'improved', check_date: '2026-05-29T00:00:00.000Z' },
      ],
    });
    expect(result.state).toBe('outcome_measured');
    expect(result.citation.outcome_id).toBe('oc5');
  });

  test('emptyTaxonomyCounts starts every bucket at zero', () => {
    expect(emptyTaxonomyCounts()).toEqual({
      activity: 0, verified_action: 0, outcome_measured: 0, roi_not_measurable: 0,
    });
  });
});
