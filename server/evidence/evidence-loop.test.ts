import { describe, expect, test } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { getSignalJourney } from './evidence-loop.js';

const BUSINESS = 'evidence_loop_test_business';

function seedSignal(): string {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Evidence Loop Test', 'evidence-loop-test') ON CONFLICT(id) DO NOTHING`).run(BUSINESS);
  const signalId = generateId();
  db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, data, status, confidence, created_at) VALUES (?, ?, 'test_rule', 'traffic_anomaly', 'warning', 'Traffic dropped', 'Sessions are down', ?, 'open', 0.82, '2026-09-01 10:00:00')`).run(signalId, BUSINESS, JSON.stringify({ metric: 'ga4.sessions' }));
  return signalId;
}

test('builds a detected journey with no task and honest next step', () => {
  const signalId = seedSignal();
  const journey = getSignalJourney(BUSINESS, signalId);
  expect(journey?.current_phase).toBe('detected');
  expect(journey?.next_step).toBe('Propose a task');
  expect(journey?.tasks).toEqual([]);
  expect(journey?.signal.data).toEqual({ metric: 'ga4.sessions' });
  db.prepare('DELETE FROM signals WHERE id = ?').run(signalId);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BUSINESS);
});

test('joins a task and outcome while keeping the journey business-scoped', () => {
  const signalId = seedSignal();
  const taskId = generateId();
  db.prepare(`INSERT INTO tasks (id, business_id, signal_id, title, proposed_by, status, action_type, approved_at, completed_at, target_metric, target_metric_baseline, created_at, updated_at) VALUES (?, ?, ?, 'Recover traffic', 'agent:seo', 'verified', 'content_draft', '2026-09-02 10:00:00', '2026-09-03 10:00:00', 'ga4.sessions', 100, '2026-09-01 11:00:00', '2026-09-03 10:00:00')`).run(taskId, BUSINESS, signalId);
  const outcomeId = generateId();
  db.prepare(`INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, verdict_detail) VALUES (?, ?, '2026-09-10 10:00:00', 1, 120, 100, 20, 'improved', 'Sessions increased')`).run(outcomeId, taskId);

  const journey = getSignalJourney(BUSINESS, signalId);
  expect(journey?.current_phase).toBe('measured');
  expect(journey?.phases.measured.reached).toBe(true);
  expect(journey?.tasks[0]?.latest_outcome).toMatchObject({ id: outcomeId, verdict: 'improved', change_pct: 20 });
  expect(journey?.provenance.map((item) => item.kind)).toEqual(['signal', 'task', 'outcome']);
  expect(getSignalJourney('another_business', signalId)).toBeNull();

  db.prepare('DELETE FROM task_outcomes WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  db.prepare('DELETE FROM signals WHERE id = ?').run(signalId);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BUSINESS);
});
