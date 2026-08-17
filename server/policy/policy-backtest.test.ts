/**
 * Operating Policy backtest (#68 extension).
 *
 * Covers the guarantees this feature promises over previewPolicyChange():
 * a genuine replay of REAL historical tasks against the current active
 * policy and a candidate patch, using the actual gate logic (never a
 * reimplementation), an honest empty-window result, evidence with task ids
 * (never a bare count), and zero side effects.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { savePolicyVersion, upsertPolicyPortfolio } from './operating-policy.js';
import { backtestPolicyChange } from './policy-backtest.js';

const BIZ_A = 'biz_backtest_a';
const BIZ_B = 'biz_backtest_b';
const ACTOR = 'dashboard:test-operator';

beforeAll(() => {
  const fixtures: Array<[string, string, string]> = [
    [BIZ_A, 'Backtest Test A', 'backtest-test-a'],
    [BIZ_B, 'Backtest Test B', 'backtest-test-b'],
  ];
  for (const [id, name, slug] of fixtures) {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, name, slug);
  }
});

afterEach(() => {
  const ids = [BIZ_A, BIZ_B];
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM operating_policies WHERE scope_key IN (${ph}) OR portfolio_id IN (SELECT id FROM operating_policy_portfolios)`).run(...ids);
  db.prepare('DELETE FROM operating_policies WHERE scope = ?').run('portfolio');
  db.prepare(`DELETE FROM operating_policy_events WHERE scope_key IN (${ph}) OR scope = 'portfolio'`).run(...ids);
  db.prepare('DELETE FROM operating_policy_portfolios').run();
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${ph})`).run(...ids);
});

function isoDaysAgo(days: number, extraMs = 0): string {
  return new Date(Date.now() - days * 86400000 + extraMs).toISOString();
}

interface TaskFixture {
  businessId: string;
  title?: string;
  actionType?: string | null;
  trustTier?: string;
  status?: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

function insertTask(f: TaskFixture): string {
  const id = `task_bt_${generateId()}`;
  const createdAt = f.createdAt ?? isoDaysAgo(5);
  db.prepare(`
    INSERT INTO tasks (
      id, business_id, title, proposed_by, action_type, action_payload, status,
      trust_tier, approval_mode, approved_by, approved_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'test', ?, ?, ?, ?, 'requires_approval', ?, ?, ?, ?)
  `).run(
    id, f.businessId, f.title ?? 'Backtest fixture task', f.actionType ?? null,
    JSON.stringify(f.payload ?? {}), f.status ?? 'proposed', f.trustTier ?? 'green',
    f.approvedBy ?? null, f.approvedAt ?? null, createdAt, createdAt,
  );
  return id;
}

function autoApproved(f: TaskFixture): string {
  return insertTask({ ...f, status: 'approved', approvedBy: 'bap:some-agent', approvedAt: f.createdAt ?? isoDaysAgo(5) });
}

function humanRequired(f: TaskFixture): string {
  return insertTask({ ...f, status: 'manual_review' });
}

// ─── Empty window is honest, never mistaken for safety ──────────────────────

describe('empty window', () => {
  test('no history in range is reported explicitly, not implied as "safe"', () => {
    const result = backtestPolicyChange({ key: BIZ_A, patch: {}, days: 30 });
    expect(result.empty_window).toBe(true);
    expect(result.tasks_in_window).toBe(0);
    expect(result.would_now_require_review.count).toBe(0);
    expect(result.would_now_auto_approve.count).toBe(0);
    expect(result.methodology_notes.join(' ')).toMatch(/NOT evidence the candidate is safe/);
  });

  test('a task outside the lookback window does not count', () => {
    autoApproved({ businessId: BIZ_A, createdAt: isoDaysAgo(45) });
    const result = backtestPolicyChange({ key: BIZ_A, patch: {}, days: 30 });
    expect(result.empty_window).toBe(true);
    expect(result.tasks_in_window).toBe(0);
  });
});

// ─── Tier ceiling transitions ────────────────────────────────────────────────

describe('auto_approve_max_tier changes', () => {
  test('lowering the ceiling flips a historically auto-approved orange task to now-requires-review, with the task id as evidence', () => {
    const taskId = autoApproved({ businessId: BIZ_A, trustTier: 'orange', actionType: 'report' });

    const result = backtestPolicyChange({
      key: BIZ_A, days: 30,
      patch: { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } },
    });

    expect(result.tasks_in_window).toBe(1);
    expect(result.would_now_require_review.count).toBe(1);
    expect(result.would_now_require_review.task_ids).toContain(taskId);
    expect(result.would_now_require_review.by_action_type.report).toBe(1);
    expect(result.would_now_auto_approve.count).toBe(0);
    const evidence = result.evidence.find((e) => e.task_id === taskId)!;
    expect(evidence.actual_outcome).toBe('auto_approved');
    expect(evidence.current_would_auto_approve).toBe(true);
    expect(evidence.candidate_would_auto_approve).toBe(false);
    expect(evidence.transition).toBe('now_requires_review');
  });

  test('raising an existing ceiling flips a historically manual-review orange task to now-auto-approves', () => {
    savePolicyVersion({
      scope: 'business', key: BIZ_A, actor: ACTOR,
      patch: { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } },
    });
    const taskId = humanRequired({ businessId: BIZ_A, trustTier: 'orange', actionType: 'report' });

    const result = backtestPolicyChange({
      key: BIZ_A, days: 30,
      patch: { approvals: { auto_approve_max_tier: 'orange' } },
    });

    expect(result.would_now_auto_approve.count).toBe(1);
    expect(result.would_now_auto_approve.task_ids).toContain(taskId);
    const evidence = result.evidence.find((e) => e.task_id === taskId)!;
    expect(evidence.actual_outcome).toBe('required_human');
    expect(evidence.current_would_auto_approve).toBe(false);
    expect(evidence.candidate_would_auto_approve).toBe(true);
    expect(evidence.transition).toBe('now_auto_approves');
  });

  test('a task whose outcome is unaffected is counted as unchanged, not as a transition', () => {
    autoApproved({ businessId: BIZ_A, trustTier: 'green', actionType: 'report' });
    const result = backtestPolicyChange({
      key: BIZ_A, days: 30,
      patch: { approvals: { auto_approve_max_tier: 'orange' } },
    });
    expect(result.would_now_require_review.count).toBe(0);
    expect(result.would_now_auto_approve.count).toBe(0);
    expect(result.unchanged_auto_approved_count).toBe(1);
  });
});

// ─── always_require_human_action_types ──────────────────────────────────────

describe('always_require_human_action_types', () => {
  test('adding an action type to the human-required list flips its historical auto-approvals', () => {
    const taskId = autoApproved({ businessId: BIZ_A, actionType: 'content_draft', trustTier: 'green' });
    const result = backtestPolicyChange({
      key: BIZ_A, days: 30,
      patch: { approvals: { always_require_human_action_types: ['content_draft'] } },
    });
    expect(result.would_now_require_review.task_ids).toContain(taskId);
    expect(result.would_now_require_review.by_action_type.content_draft).toBe(1);
  });
});

// ─── Daily autonomy cap ──────────────────────────────────────────────────────

describe('autonomy.max_autonomous_tasks_per_day', () => {
  test('lowering the cap blocks the later-in-the-day approvals but not the first', () => {
    const day = isoDaysAgo(3);
    const first = autoApproved({ businessId: BIZ_A, createdAt: day });
    const second = autoApproved({ businessId: BIZ_A, createdAt: new Date(new Date(day).getTime() + 60000).toISOString() });
    const third = autoApproved({ businessId: BIZ_A, createdAt: new Date(new Date(day).getTime() + 120000).toISOString() });

    const result = backtestPolicyChange({
      key: BIZ_A, days: 30,
      patch: { autonomy: { max_autonomous_tasks_per_day: 1 } },
    });

    const byId = new Map(result.evidence.map((e) => [e.task_id, e]));
    expect(byId.get(first)!.candidate_would_auto_approve).toBe(true);
    expect(byId.get(second)!.candidate_would_auto_approve).toBe(false);
    expect(byId.get(second)!.candidate_block_code).toBe('daily_autonomy_cap_reached');
    expect(byId.get(third)!.candidate_would_auto_approve).toBe(false);
    expect(result.would_now_require_review.task_ids.sort()).toEqual([second, third].sort());
  });
});

// ─── Undetermined outcomes ────────────────────────────────────────────────────

describe('tasks with no resolved actual outcome', () => {
  test('a still-proposed task is reported separately, not folded into either transition bucket', () => {
    const taskId = insertTask({ businessId: BIZ_A, status: 'proposed', trustTier: 'orange' });
    const result = backtestPolicyChange({
      key: BIZ_A, days: 30,
      patch: { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } },
    });
    expect(result.undetermined_count).toBe(1);
    expect(result.would_now_require_review.task_ids).not.toContain(taskId);
    expect(result.would_now_auto_approve.task_ids).not.toContain(taskId);
    const evidence = result.evidence.find((e) => e.task_id === taskId)!;
    expect(evidence.actual_outcome).toBe('undetermined');
  });
});

// ─── Candidate validity is still surfaced ────────────────────────────────────

describe('an invalid candidate patch', () => {
  test('is flagged invalid with violations, while still replaying history for evidence', () => {
    autoApproved({ businessId: BIZ_A, trustTier: 'green' });
    const result = backtestPolicyChange({
      key: BIZ_A, days: 30,
      patch: { thresholds: { financial_exposure_review_gbp: -5 } },
    });
    expect(result.candidate_valid).toBe(false);
    expect(result.candidate_violations.map((v) => v.code)).toContain('threshold_negative');
    expect(result.tasks_in_window).toBe(1);
  });
});

// ─── Lookback window bounds ───────────────────────────────────────────────────

describe('lookback window', () => {
  test('days defaults to 30 and is capped at 90', () => {
    const result = backtestPolicyChange({ key: BIZ_A, patch: {} });
    expect(result.days).toBe(30);
    const capped = backtestPolicyChange({ key: BIZ_A, patch: {}, days: 500 });
    expect(capped.days).toBe(90);
    const floored = backtestPolicyChange({ key: BIZ_A, patch: {}, days: 0 });
    expect(floored.days).toBe(1);
  });
});

// ─── Portfolio scope ──────────────────────────────────────────────────────────

describe('portfolio scope', () => {
  test('replays history across every member business, respecting each business\'s own override on top', () => {
    const portfolio = upsertPolicyPortfolio({ name: 'Backtest Portfolio', business_ids: [BIZ_A, BIZ_B], actor: ACTOR });
    // BIZ_B opts itself OUT of the portfolio's tightened ceiling by setting its own looser one.
    savePolicyVersion({
      scope: 'business', key: BIZ_B, actor: ACTOR,
      patch: {
        approvals: { auto_approve_max_tier: 'orange', require_human_approval_at_or_above: 'red' },
        acknowledged_risks: ['unsafe_auto_approve_orange'],
      },
    });

    const taskA = autoApproved({ businessId: BIZ_A, trustTier: 'orange' });
    const taskB = autoApproved({ businessId: BIZ_B, trustTier: 'orange' });

    const result = backtestPolicyChange({
      scope: 'portfolio', key: portfolio.id, days: 30,
      patch: { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } },
    });

    expect(result.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());
    const byId = new Map(result.evidence.map((e) => [e.task_id, e]));
    expect(byId.get(taskA)!.transition).toBe('now_requires_review');
    // BIZ_B's own override (orange ceiling) still permits an orange task.
    expect(byId.get(taskB)!.transition).toBe('unchanged');
  });

  test('a portfolio with no member businesses is an honest empty window, not an error', () => {
    const portfolio = upsertPolicyPortfolio({ name: 'Solo Portfolio', business_ids: [BIZ_A], actor: ACTOR });
    db.prepare('UPDATE operating_policy_portfolios SET business_ids = ? WHERE id = ?').run('[]', portfolio.id);
    const result = backtestPolicyChange({ scope: 'portfolio', key: portfolio.id, patch: {} });
    expect(result.empty_window).toBe(true);
    expect(result.business_ids).toEqual([]);
  });
});

// ─── Read-only, always ────────────────────────────────────────────────────────

describe('zero side effects', () => {
  test('running a backtest writes no policy version, no policy event, and touches no task row', () => {
    const taskId = autoApproved({ businessId: BIZ_A, trustTier: 'orange' });
    const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    const policiesBefore = (db.prepare('SELECT COUNT(*) AS n FROM operating_policies WHERE scope_key = ?').get(BIZ_A) as { n: number }).n;
    const eventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM operating_policy_events WHERE scope_key = ?').get(BIZ_A) as { n: number }).n;

    for (let i = 0; i < 3; i += 1) {
      backtestPolicyChange({
        key: BIZ_A, days: 30,
        patch: { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } },
      });
    }

    expect(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)).toEqual(before as Record<string, unknown>);
    expect((db.prepare('SELECT COUNT(*) AS n FROM operating_policies WHERE scope_key = ?').get(BIZ_A) as { n: number }).n).toBe(policiesBefore);
    expect((db.prepare('SELECT COUNT(*) AS n FROM operating_policy_events WHERE scope_key = ?').get(BIZ_A) as { n: number }).n).toBe(eventsBefore);
  });
});
