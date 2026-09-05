import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import db from '../db/db.js';
import { buildPreLLMContextSnapshot, formatPreLLMContextSnapshot } from './context-builders.js';

const BIZ = 'biz_pre_llm_snapshot_test';
const AGENT = 'pre-llm-snapshot-agent';
const OTHER_BIZ = 'biz_pre_llm_snapshot_other';

function cleanup() {
  db.prepare('DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (?, ?))').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM decisions WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM conflicts WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM system_issues WHERE business_id IN (?, ?) OR business_id IS NULL').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM agent_runs WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM signals WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM goal_suggestions WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM goals WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM metrics WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM connectors WHERE business_id IN (?, ?)').run(BIZ, OTHER_BIZ);
  db.prepare('DELETE FROM agents WHERE id = ?').run(AGENT);
  db.prepare('DELETE FROM businesses WHERE id IN (?, ?)').run(BIZ, OTHER_BIZ);
}

function rowCounts() {
  return {
    connectors: (db.prepare('SELECT COUNT(*) n FROM connectors').get() as { n: number }).n,
    tasks: (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n,
    signals: (db.prepare('SELECT COUNT(*) n FROM signals').get() as { n: number }).n,
    decisions: (db.prepare('SELECT COUNT(*) n FROM decisions').get() as { n: number }).n,
    issues: (db.prepare('SELECT COUNT(*) n FROM system_issues').get() as { n: number }).n,
  };
}

beforeEach(() => {
  cleanup();
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Snapshot Biz', 'snapshot-biz')").run(BIZ);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Other Snapshot Biz', 'other-snapshot-biz')").run(OTHER_BIZ);
  db.prepare("INSERT INTO agents (id, profile_path, name, status) VALUES (?, 'server/agents/profiles/pre-llm-snapshot-agent.yaml', 'Snapshot Agent', 'active')").run(AGENT);

  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, last_sync, last_error, config)
    VALUES ('conn_gsc_snapshot', ?, 'gsc', 'Search Console', 'active', '2026-09-05T09:00:00.000Z', ?, '{}')
  `).run(BIZ, 'temporary API key sk-test-secret-1234567890 failed');
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, last_sync, last_error, config)
    VALUES ('conn_other_snapshot', ?, 'stripe', 'Other Stripe', 'active', '2026-09-05T10:00:00.000Z', NULL, '{}')
  `).run(OTHER_BIZ);

  db.prepare(`
    INSERT INTO goals (id, business_id, title, status, progress_pct, deadline, metric_name, metric_current, metric_target, updated_at)
    VALUES ('goal_snapshot', ?, 'Recover search demand', 'active', 35, '2026-09-08T00:00:00.000Z', 'gsc.clicks', 35, 100, '2026-09-05T08:30:00.000Z')
  `).run(BIZ);
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, action_type, action_payload, status, confidence, priority, estimated_impact, created_at, updated_at, goal_id)
    VALUES ('task_snapshot', ?, 'Refresh top landing page', ?, 'content_brief', '{}', 'proposed', 0.82, 'p1', 'Recover clicks', '2026-09-05T08:40:00.000Z', '2026-09-05T08:40:00.000Z', 'goal_snapshot')
  `).run(BIZ, AGENT);
  db.prepare(`
    INSERT INTO signals (id, business_id, connector_id, rule_id, type, severity, title, description, data, status, confidence, created_at)
    VALUES ('signal_snapshot', ?, 'conn_gsc_snapshot', 'gsc_drop', 'anomaly', 'critical', 'Search clicks dropped', 'Clicks fell materially', '{}', 'open', 0.91, '2026-09-05T08:45:00.000Z')
  `).run(BIZ);
  db.prepare(`
    INSERT INTO system_issues (id, business_id, issue_type, severity, title, status, related_connector_id, created_at, updated_at)
    VALUES ('issue_snapshot', ?, 'connector_critically_stale', 'warning', 'Connector token sk-test-secret-1234567890 stale', 'open', 'conn_gsc_snapshot', '2026-09-05T08:50:00.000Z', '2026-09-05T08:50:00.000Z')
  `).run(BIZ);
  db.prepare(`
    INSERT INTO conflicts (id, business_id, conflict_type, severity, entity_a_type, entity_a_id, entity_b_type, entity_b_id, description, recommendation, status, detected_at)
    VALUES ('conflict_snapshot', ?, 'task_overlap', 'warning', 'task', 'task_snapshot', 'goal', 'goal_snapshot', 'Task overlaps another active plan', 'Pick one plan', 'open', '2026-09-05T08:55:00.000Z')
  `).run(BIZ);
  db.prepare(`
    INSERT INTO decisions (id, business_id, decision_type, title, decision, reasoning, evidence, confidence, author, related_task_id, created_at)
    VALUES ('decision_snapshot', ?, 'approval', 'Approved page refresh', 'approved', 'Strong evidence', '[]', 0.88, 'dashboard:test', 'task_snapshot', '2026-09-05T09:05:00.000Z')
  `).run(BIZ);
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, created_at)
    VALUES ('outcome_snapshot', 'task_snapshot', '2026-09-05T09:10:00.000Z', 1, 120, 100, 20, 'positive', '2026-09-05T09:11:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at, completed_at)
    VALUES ('run_snapshot', ?, ?, 'manual', 'failed', '2026-09-05T09:12:00.000Z', '2026-09-05T09:13:00.000Z')
  `).run(AGENT, BIZ);
});

afterEach(cleanup);

describe('pre-LLM Blueprint context snapshot', () => {
  test('assembles scoped aggregates, data freshness, and redacted read-only state', () => {
    const before = rowCounts();
    const snapshot = buildPreLLMContextSnapshot(BIZ, AGENT, db, { trigger: 'manual', triggerId: 'run-now' });
    const rendered = formatPreLLMContextSnapshot(snapshot);

    expect(snapshot.business_id).toBe(BIZ);
    expect(snapshot.agent_id).toBe(AGENT);
    expect(snapshot.trigger).toBe('manual');
    expect(snapshot.trigger_id).toBe('run-now');
    expect(snapshot.partial).toBe(false);
    expect(snapshot.error).toBeNull();
    expect(snapshot.data_as_of).toBe('2026-09-05T09:13:00.000Z');

    expect(snapshot.sections.connectors.data.counts.total).toBe(1);
    expect(snapshot.sections.connectors.data.connectors[0]?.id).toBe('conn_gsc_snapshot');
    expect(snapshot.sections.connectors.data.connectors[0]?.last_error).toContain('[redacted-provider-key]');
    expect(rendered).not.toContain('sk-test-secret-1234567890');

    expect(snapshot.sections.command_centre_health.data.agent_runs_24h.failed).toBe(1);
    expect(snapshot.sections.command_centre_health.data.open_system_issue_counts.by_type.connector_critically_stale).toBe(1);
    expect(snapshot.sections.goals_tasks_signals_recommendations.data.at_risk_goals.map((g) => g.id)).toEqual(['goal_snapshot']);
    expect(snapshot.sections.goals_tasks_signals_recommendations.data.signal_counts.by_severity?.critical).toBe(1);
    expect(snapshot.sections.decisions_conflicts_outcomes.data.pending_decisions.counts.by_lane.routine).toBe(1);
    expect(snapshot.sections.decisions_conflicts_outcomes.data.pending_decisions.counts.by_lane).not.toHaveProperty('total');
    expect(snapshot.sections.decisions_conflicts_outcomes.data.open_conflicts).toHaveLength(1);
    expect(snapshot.sections.decisions_conflicts_outcomes.data.recent_outcomes[0]?.verdict).toBe('positive');
    expect(rowCounts()).toEqual(before);
  });

  test('reports open system issue totals from uncapped counts while keeping the sample capped', () => {
    for (let i = 0; i < 12; i += 1) {
      db.prepare(`
        INSERT INTO system_issues (id, business_id, issue_type, severity, title, status, created_at, updated_at)
        VALUES (?, ?, 'connector_critically_stale', 'warning', ?, 'open', ?, ?)
      `).run(
        `issue_snapshot_over_cap_${i}`,
        BIZ,
        `Connector stale ${i}`,
        `2026-09-05T07:${String(i).padStart(2, '0')}:00.000Z`,
        `2026-09-05T07:${String(i).padStart(2, '0')}:00.000Z`,
      );
    }

    const snapshot = buildPreLLMContextSnapshot(BIZ, AGENT, db);
    const health = snapshot.sections.command_centre_health.data;

    expect(health.open_system_issues).toHaveLength(10);
    expect(health.open_system_issue_counts.total).toBe(13);
    expect(health.open_system_issue_counts.by_status?.open).toBe(13);
    expect(health.open_system_issue_counts.by_type.connector_critically_stale).toBe(13);
  });

  test('marks only the failing section and top-level snapshot partial', () => {
    const wrapped = {
      prepare(sql: string) {
        if (sql.includes('FROM system_issues')) {
          throw new Error('synthetic read failure with sk-test-secret-1234567890');
        }
        return db.prepare(sql);
      },
    } as unknown as Database;

    const snapshot = buildPreLLMContextSnapshot(BIZ, AGENT, wrapped);

    expect(snapshot.partial).toBe(true);
    expect(snapshot.error?.code).toBe('partial_snapshot');
    expect(snapshot.sections.command_centre_health.partial).toBe(true);
    expect(snapshot.sections.command_centre_health.error?.message).toContain('[redacted-provider-key]');
    expect(snapshot.sections.connectors.partial).toBe(false);
    expect(snapshot.sections.goals_tasks_signals_recommendations.partial).toBe(false);
  });
});
