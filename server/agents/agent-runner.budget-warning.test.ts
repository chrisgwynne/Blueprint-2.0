/**
 * Budget cap visibility (companion to Paperclip's "hard limits, enforced by
 * the system" pattern): before this, both the 80%-of-cap soft warning and
 * the 100% hard stop itself were only ever a server console.warn — nothing
 * surfaced on the dashboard or over BAP (system_issues:read). Both cap
 * types (per-agent daily, global monthly) now raise a system_issues row at
 * 80% (severity 'warning', run still proceeds) and again at 100%
 * (severity 'error', run is skipped) — deduped so a caller polling every
 * few minutes doesn't get a fresh row each time.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/db.js';
import { listSystemIssues } from '../system/system-issues.js';

// createSystemIssue() now fire-and-forget dispatches a notification for
// severity >= error (see system-issues.ts's notifyIfSevereEnough), which
// this file's 100%-cap tests would trigger for real — inserting a
// `notifications` row that outlives the synchronous test body (the
// dispatch is an unawaited dynamic import) and then blocks this file's own
// cleanup()'s `DELETE FROM businesses` with a FK violation. Mocked here
// (matching system-issues.notify.test.ts's own convention) so these tests
// only ever assert on the durable system_issues row they're actually about.
mock.module('../notifications/dispatcher.js', () => ({
  dispatchToAll: mock(async () => []),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

const BIZ = 'biz_budget_warning_test';
const AGENT_ID = 'budget-warning-test';
const AGENT_DIR = resolve(__dirname, AGENT_ID);
const PROFILE_PATH = resolve(AGENT_DIR, 'profile.yaml');
const originalFetch = globalThis.fetch;

function cleanup() {
  db.prepare('DELETE FROM agent_runs WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agent_run_events WHERE run_id NOT IN (SELECT id FROM agent_runs)').run();
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM signals WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agents WHERE id = ?').run(AGENT_ID);
  db.prepare('DELETE FROM system_issues WHERE business_id = ? OR business_id IS NULL').run(BIZ);
  db.prepare('DELETE FROM cost_daily').run();
  db.prepare("DELETE FROM settings WHERE key IN ('llm_default_provider','llm_default_model','provider_credentials_google','cost_monthly_budget_usd')").run();
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
  if (existsSync(AGENT_DIR)) rmSync(AGENT_DIR, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
}

beforeAll(() => cleanup());

beforeEach(() => {
  cleanup();
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(PROFILE_PATH, [
    `id: ${AGENT_ID}`,
    'name: Budget Warning Test',
    'description: Test agent',
    'system_prompt: Test system prompt',
    'llm:',
    '  temperature: 0.2',
    '  max_tokens: 256',
    '  cost_cap_daily_usd: 2.0',
    '',
  ].join('\n'));
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Budget Warning Test', 'budget-warning-test')").run(BIZ);
  db.prepare('INSERT INTO agents (id, profile_path, name, status) VALUES (?, ?, ?, ?)').run(
    AGENT_ID, PROFILE_PATH, 'Budget Warning Test', 'active',
  );
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_provider', ?)").run(JSON.stringify({ provider: 'google' }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_model', ?)").run(JSON.stringify('gemini-3.5-flash-lite'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('provider_credentials_google', ?)").run(JSON.stringify({ apiKey: 'test-key' }));
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/models?')) {
      return new Response(JSON.stringify({
        models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }],
      }), { status: 200 });
    }
    const body = String(init?.body ?? '');
    if (body.includes('Reply with exactly: ok')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{}' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

/** Seeds a completed agent_runs row so today's per-agent spend totals `usd`. */
function seedTodaySpend(usd: number) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, queued_at, started_at, completed_at, cost_usd)
    VALUES (?, ?, ?, 'manual', 'complete', ?, ?, ?, ?)
  `).run(`seed_${Math.random().toString(36).slice(2)}`, AGENT_ID, BIZ, now, now, now, usd);
}

describe('per-agent daily cost cap visibility', () => {
  test('below 80% raises no system_issues warning', async () => {
    seedTodaySpend(1.0); // 50% of the 2.0 cap
    const { runAgent } = await import('./agent-runner.js');
    await runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true });

    const issues = listSystemIssues({ business_id: BIZ, issue_type: 'agent_daily_budget_warning' });
    expect(issues.length).toBe(0);
  });

  test('80-99% of cap raises a warning and still lets the run proceed', async () => {
    seedTodaySpend(1.7); // 85% of the 2.0 cap
    const { runAgent } = await import('./agent-runner.js');
    const result = await runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true });

    expect(result.skipped).toBeFalsy();
    const issues = listSystemIssues({ business_id: BIZ, issue_type: 'agent_daily_budget_warning' });
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.status).toBe('open');
    expect(issues[0]!.metadata.agent_id).toBe(AGENT_ID);
    expect(issues[0]!.metadata.today_cost_usd).toBe(1.7);
  });

  test('a second run the same day at the same level does not duplicate the warning', async () => {
    seedTodaySpend(1.7);
    const { runAgent } = await import('./agent-runner.js');
    await runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true });
    await runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true });

    const issues = listSystemIssues({ business_id: BIZ, issue_type: 'agent_daily_budget_warning' });
    expect(issues.length).toBe(1);
  });

  test('at 100% the run is skipped AND a severity=error system_issue is raised (not just a server log)', async () => {
    seedTodaySpend(2.0); // exactly the 2.0 cap
    const { runAgent } = await import('./agent-runner.js');
    const result = await runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('cost_cap');
    const issues = listSystemIssues({ business_id: BIZ, issue_type: 'agent_daily_budget_exhausted' });
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('error');
  });
});

describe('global monthly budget visibility', () => {
  test('80-99% of the monthly budget raises a global (business_id=null) warning', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('cost_monthly_budget_usd', ?)").run(JSON.stringify(10));
    db.prepare(`INSERT INTO cost_daily (id, date, cost_usd) VALUES (?, date('now'), 8.5)`).run(`seed_${Math.random().toString(36).slice(2)}`);
    seedTodaySpend(0.1); // stay well under the per-agent daily cap so only the monthly path fires

    const { runAgent } = await import('./agent-runner.js');
    const result = await runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true });

    expect(result.skipped).toBeFalsy();
    const issues = listSystemIssues({ issue_type: 'monthly_budget_warning' });
    expect(issues.length).toBe(1);
    expect(issues[0]!.business_id).toBeNull();
    expect(issues[0]!.severity).toBe('warning');

    // A global (business_id=null) issue must still show up when a caller
    // lists issues scoped to a specific business — otherwise it would be
    // created but permanently invisible through both the dashboard route
    // and the BAP route, which only ever query by business_id.
    const scoped = listSystemIssues({ business_id: BIZ, issue_type: 'monthly_budget_warning' });
    expect(scoped.length).toBe(1);
    expect(scoped[0]!.business_id).toBeNull();
  });

  test('at 100% of the monthly budget every run is skipped and a severity=error issue is raised', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('cost_monthly_budget_usd', ?)").run(JSON.stringify(10));
    db.prepare(`INSERT INTO cost_daily (id, date, cost_usd) VALUES (?, date('now'), 10)`).run(`seed_${Math.random().toString(36).slice(2)}`);

    const { runAgent } = await import('./agent-runner.js');
    const result = await runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('monthly_budget');
    const issues = listSystemIssues({ issue_type: 'monthly_budget_exhausted' });
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.business_id).toBeNull();
  });
});
