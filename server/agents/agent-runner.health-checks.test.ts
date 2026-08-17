/**
 * Coverage for the three new "Blueprint health" checks that raise a
 * system_issue instead of only ever surfacing in the System Health
 * dashboard: an agent failing repeatedly (checkAgentFailureStreak /
 * resolveAgentFailureStreak), and an LLM provider stuck on its fallback
 * (checkProviderFallbackStreak, backed by llm-providers.ts's
 * recordProviderOutcome). Each check must fire exactly once per
 * streak/crossing — never once per run while the streak sits above
 * threshold — matching the dedup shape task-queue.ts's other
 * createSystemIssue() call sites already establish.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { checkAgentFailureStreak, resolveAgentFailureStreak, checkProviderFallbackStreak } from './agent-runner.js';

const BIZ = 'biz_agent_health_checks_test';
const AGENT_ID = 'agent_health_checks_test';
const PROVIDER = 'test-provider-health-checks';

function cleanup() {
  db.prepare(`DELETE FROM agent_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(`llm_fallback_streak_${PROVIDER}`);
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Agent Health Checks Test', 'agent-health-checks-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  db.prepare(`INSERT INTO agents (id, profile_path, name) VALUES (?, 'agents/health-checks', 'Health Checks Test Agent') ON CONFLICT(id) DO NOTHING`).run(AGENT_ID);
});

beforeEach(cleanup);
afterAll(cleanup);

function insertRun(status: string, minutesAgo: number): void {
  db.prepare(`
    INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at, completed_at)
    VALUES (?, ?, ?, 'test', ?, datetime('now', '-' || ? || ' minutes'), datetime('now', '-' || ? || ' minutes'))
  `).run(generateId(), AGENT_ID, BIZ, status, minutesAgo, minutesAgo);
}

function openIssues(issueType: string) {
  return db.prepare(`SELECT * FROM system_issues WHERE business_id = ? AND issue_type = ? AND status = 'open'`).all(BIZ, issueType) as Array<Record<string, unknown>>;
}

describe('checkAgentFailureStreak', () => {
  test('does not raise an issue below the 3-consecutive-failure threshold', () => {
    insertRun('failed', 3);
    insertRun('failed', 2);
    checkAgentFailureStreak(AGENT_ID, BIZ);
    expect(openIssues('agent_consecutive_failures')).toHaveLength(0);
  });

  test('raises exactly one issue once the 3rd consecutive failure is recorded', () => {
    insertRun('failed', 3);
    insertRun('failed', 2);
    insertRun('failed', 1);
    checkAgentFailureStreak(AGENT_ID, BIZ);
    const issues = openIssues('agent_consecutive_failures');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(JSON.parse(issues[0]!.metadata as string)).toMatchObject({ agent_id: AGENT_ID, consecutive_failures: 3 });
  });

  test('does not raise a second issue for runs 4, 5, 6 of the same streak', () => {
    insertRun('failed', 5);
    insertRun('failed', 4);
    insertRun('failed', 3);
    checkAgentFailureStreak(AGENT_ID, BIZ); // 3rd failure -> raises

    insertRun('failed', 2);
    checkAgentFailureStreak(AGENT_ID, BIZ); // 4th failure -> should stay silent
    insertRun('failed', 1);
    checkAgentFailureStreak(AGENT_ID, BIZ); // 5th failure -> should stay silent

    expect(openIssues('agent_consecutive_failures')).toHaveLength(1);
  });

  test('skipped runs do not count toward or break a streak', () => {
    insertRun('failed', 4);
    insertRun('failed', 3);
    insertRun('skipped', 2);
    insertRun('failed', 1);
    checkAgentFailureStreak(AGENT_ID, BIZ);
    // 3 non-skipped failures in a row (skipped is ignored, not a break)
    expect(openIssues('agent_consecutive_failures')).toHaveLength(1);
  });

  test('a successful run in between resets the streak', () => {
    insertRun('failed', 4);
    insertRun('failed', 3);
    insertRun('complete', 2);
    insertRun('failed', 1);
    checkAgentFailureStreak(AGENT_ID, BIZ);
    expect(openIssues('agent_consecutive_failures')).toHaveLength(0);
  });
});

describe('resolveAgentFailureStreak', () => {
  test('resolves the open issue once the agent succeeds again', () => {
    insertRun('failed', 3);
    insertRun('failed', 2);
    insertRun('failed', 1);
    checkAgentFailureStreak(AGENT_ID, BIZ);
    expect(openIssues('agent_consecutive_failures')).toHaveLength(1);

    resolveAgentFailureStreak(AGENT_ID);
    expect(openIssues('agent_consecutive_failures')).toHaveLength(0);
    const resolved = db.prepare(`SELECT status FROM system_issues WHERE business_id = ? AND issue_type = 'agent_consecutive_failures'`).get(BIZ) as { status: string };
    expect(resolved.status).toBe('resolved');
  });

  test('is a no-op when there is no open issue', () => {
    expect(() => resolveAgentFailureStreak(AGENT_ID)).not.toThrow();
  });
});

describe('checkProviderFallbackStreak', () => {
  test('does not raise below the 5-consecutive-fallback threshold', () => {
    for (let i = 0; i < 4; i++) checkProviderFallbackStreak(PROVIDER, BIZ, true);
    expect(openIssues('llm_provider_on_fallback')).toHaveLength(0);
  });

  test('raises exactly one issue on the 5th consecutive fallback, none on the 6th/7th', () => {
    for (let i = 0; i < 5; i++) checkProviderFallbackStreak(PROVIDER, BIZ, true);
    expect(openIssues('llm_provider_on_fallback')).toHaveLength(1);

    checkProviderFallbackStreak(PROVIDER, BIZ, true);
    checkProviderFallbackStreak(PROVIDER, BIZ, true);
    expect(openIssues('llm_provider_on_fallback')).toHaveLength(1);
  });

  test('a primary success resets the streak and resolves an open issue', () => {
    for (let i = 0; i < 5; i++) checkProviderFallbackStreak(PROVIDER, BIZ, true);
    expect(openIssues('llm_provider_on_fallback')).toHaveLength(1);

    checkProviderFallbackStreak(PROVIDER, BIZ, false);
    expect(openIssues('llm_provider_on_fallback')).toHaveLength(0);

    // streak must actually be back at zero, not just the issue closed
    for (let i = 0; i < 4; i++) checkProviderFallbackStreak(PROVIDER, BIZ, true);
    expect(openIssues('llm_provider_on_fallback')).toHaveLength(0);
  });

  test('severity is warning, not error — the run still completed via fallback', () => {
    for (let i = 0; i < 5; i++) checkProviderFallbackStreak(PROVIDER, BIZ, true);
    const issues = openIssues('llm_provider_on_fallback');
    expect(issues[0]!.severity).toBe('warning');
  });
});
