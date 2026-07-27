/**
 * Regression coverage for issue #25: agent_runs left in status='running'
 * indefinitely (crashed process, or an LLM/tool call that hung) with no
 * completed_at/error and no timeout — BAP/dashboard then treat stale work
 * as still in-flight. recoverStaleAgentRuns() is the periodic sweep that
 * closes this out, mirroring execution-worker.ts's recoverStuckJobs() for
 * execution_jobs.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { recoverStaleAgentRuns } from './agent-runner.js';

const BIZ = 'biz_stale_runs_test';
const AGENT_ID = 'agent_stale_runs_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Stale Runs Test', 'stale-runs-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  db.prepare(`INSERT INTO agents (id, profile_path, name) VALUES (?, 'agents/stale', 'Stale Test Agent') ON CONFLICT(id) DO NOTHING`).run(AGENT_ID);
});

afterEach(() => {
  db.prepare(`DELETE FROM agent_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM settings WHERE key = 'agent_run_timeout_minutes'`).run();
});

function insertRun(status: string, startedMinutesAgo: number): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at, completed_at, error)
    VALUES (?, ?, ?, 'test', ?, datetime('now', '-' || ? || ' minutes'), NULL, NULL)
  `).run(id, AGENT_ID, BIZ, status, startedMinutesAgo);
  return id;
}

describe('recoverStaleAgentRuns', () => {
  test('marks a running run older than the default 30-minute timeout as failed', () => {
    const id = insertRun('running', 45);
    const { markedStale } = recoverStaleAgentRuns();
    expect(markedStale).toBe(1);
    const row = db.prepare('SELECT status, error, completed_at FROM agent_runs WHERE id = ?').get(id) as any;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/exceeded the maximum duration/i);
    expect(row.completed_at).not.toBeNull();
  });

  test('does not touch a running run within the timeout window', () => {
    const id = insertRun('running', 5);
    const { markedStale } = recoverStaleAgentRuns();
    expect(markedStale).toBe(0);
    const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(id) as any;
    expect(row.status).toBe('running');
  });

  test('does not touch a run that already completed or failed normally', () => {
    const completedId = generateId();
    db.prepare(`
      INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at, completed_at)
      VALUES (?, ?, ?, 'test', 'complete', datetime('now', '-2 hours'), datetime('now', '-1 hours'))
    `).run(completedId, AGENT_ID, BIZ);
    const failedId = generateId();
    db.prepare(`
      INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at, completed_at, error)
      VALUES (?, ?, ?, 'test', 'failed', datetime('now', '-2 hours'), datetime('now', '-1 hours'), 'a real error')
    `).run(failedId, AGENT_ID, BIZ);

    const { markedStale } = recoverStaleAgentRuns();
    expect(markedStale).toBe(0);
  });

  test('honours a configured agent_run_timeout_minutes setting', () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('agent_run_timeout_minutes', '10')`).run();
    const id = insertRun('running', 15); // stale under the 10-min setting, not under the 30-min default

    const { markedStale } = recoverStaleAgentRuns();

    expect(markedStale).toBe(1);
    const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(id) as any;
    expect(row.status).toBe('failed');
  });

  test('marks multiple stale runs across businesses in one sweep', () => {
    const biz2 = 'biz_stale_runs_test_2';
    db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Stale Runs Test 2', 'stale-runs-test-2') ON CONFLICT(id) DO NOTHING`).run(biz2);
    const id1 = insertRun('running', 60);
    const id2 = generateId();
    db.prepare(`
      INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at, completed_at, error)
      VALUES (?, ?, ?, 'test', 'running', datetime('now', '-90 minutes'), NULL, NULL)
    `).run(id2, AGENT_ID, biz2);

    const { markedStale } = recoverStaleAgentRuns();
    expect(markedStale).toBeGreaterThanOrEqual(2);
    expect((db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(id1) as any).status).toBe('failed');
    expect((db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(id2) as any).status).toBe('failed');

    db.prepare(`DELETE FROM agent_runs WHERE business_id = ?`).run(biz2);
  });
});
