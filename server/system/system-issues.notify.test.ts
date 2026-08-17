/**
 * Coverage for the createSystemIssue() -> dispatch() wiring: severity at or
 * above the configurable settings.system_issue_notify_min_severity
 * threshold (default 'error') should proactively notify; anything below it
 * should only ever produce the durable system_issues row, matching how
 * cost_monthly_budget_usd/cost_cap_daily_usd are read fresh from `settings`
 * elsewhere in the codebase (see agent-runner.ts).
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import db from '../db/db.js';

const dispatchToAll = mock(async (_channels: string[], _n: Record<string, unknown>) => []);

mock.module('../notifications/dispatcher.js', () => ({
  dispatchToAll,
}));

const { createSystemIssue } = await import('./system-issues.js');

const BIZ = 'biz_system_issues_notify_test';

function cleanup() {
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM settings WHERE key = 'system_issue_notify_min_severity'`).run();
  dispatchToAll.mockClear();
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'System Issues Notify Test', 'system-issues-notify-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

beforeEach(cleanup);
afterAll(cleanup);

// Flush the dynamic import() + .then() chain notifyIfSevereEnough() kicks
// off (fire-and-forget, not awaited by createSystemIssue itself).
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('createSystemIssue notify wiring', () => {
  test('severity=error dispatches to dashboard + telegram by default', async () => {
    const issue = createSystemIssue({
      business_id: BIZ,
      issue_type: 'test_notify',
      severity: 'error',
      title: 'Something broke',
      description: 'Detail here.',
    });
    await flush();

    expect(dispatchToAll).toHaveBeenCalledTimes(1);
    const [channels, payload] = dispatchToAll.mock.calls[0]!;
    expect(channels).toEqual(['dashboard', 'telegram']);
    expect(payload).toMatchObject({
      business_id: BIZ,
      severity: 'error',
      title: 'Something broke',
      body: 'Detail here.',
      entity_type: 'system_issue',
      entity_id: issue.id,
    });
  });

  test('severity=critical also dispatches by default', async () => {
    createSystemIssue({ business_id: BIZ, issue_type: 'test_notify', severity: 'critical', title: 'Very broken' });
    await flush();
    expect(dispatchToAll).toHaveBeenCalledTimes(1);
  });

  test('severity=warning does NOT dispatch by default (threshold=error)', async () => {
    createSystemIssue({ business_id: BIZ, issue_type: 'test_notify', severity: 'warning', title: 'Minor thing' });
    await flush();
    expect(dispatchToAll).not.toHaveBeenCalled();
  });

  test('severity=info does NOT dispatch by default', async () => {
    createSystemIssue({ business_id: BIZ, issue_type: 'test_notify', severity: 'info', title: 'FYI' });
    await flush();
    expect(dispatchToAll).not.toHaveBeenCalled();
  });

  test('lowering the settings threshold to warning makes warning-severity issues dispatch too', async () => {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('system_issue_notify_min_severity', '"warning"', CURRENT_TIMESTAMP)`).run();
    createSystemIssue({ business_id: BIZ, issue_type: 'test_notify', severity: 'warning', title: 'Now paged' });
    await flush();
    expect(dispatchToAll).toHaveBeenCalledTimes(1);
  });

  test('raising the settings threshold to critical suppresses error-severity dispatch', async () => {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('system_issue_notify_min_severity', '"critical"', CURRENT_TIMESTAMP)`).run();
    createSystemIssue({ business_id: BIZ, issue_type: 'test_notify', severity: 'error', title: 'Not paged now' });
    await flush();
    expect(dispatchToAll).not.toHaveBeenCalled();
  });
});
