/**
 * Tests for the goal-to-outcome timeline (issue #64) — server/goals/goal-timeline.ts.
 *
 * Exercises buildGoalTimeline() directly against the real db (same pattern
 * as other server/**\/*.test.ts files) rather than through Express, since
 * it's a pure function over the database with no HTTP concerns of its own.
 * The route-level wiring (server/routes/goals.ts and server/routes/bap-goals.ts)
 * is covered by their own existing test suites.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { buildGoalTimeline } from './goal-timeline.js';

const BIZ_A = 'biz_goal_timeline_a';
const BIZ_B = 'biz_goal_timeline_b';

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function insertGoal(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO goals (id, business_id, title, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, (overrides.business_id as string) ?? BIZ_A, (overrides.title as string) ?? 'Fixture goal',
    (overrides.status as string) ?? 'active',
    (overrides.created_at as string) ?? daysAgoIso(1),
    (overrides.updated_at as string) ?? daysAgoIso(1),
  );
  return id;
}

function insertSignal(goalId: string, businessId: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO signals (id, business_id, goal_id, rule_id, type, severity, title, description, status, created_at)
    VALUES (?, ?, ?, 'r1', 'opportunity', 'medium', ?, ?, 'open', ?)
  `).run(id, businessId, goalId, (overrides.title as string) ?? 'Fixture signal', (overrides.description as string) ?? 'signal evidence', (overrides.created_at as string) ?? daysAgoIso(1));
  return id;
}

function insertTask(goalId: string, businessId: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, goal_id, title, description, proposed_by, status, action_type, target_metric, target_metric_baseline, completed_at, approved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, businessId, goalId,
    (overrides.title as string) ?? 'Fixture task',
    (overrides.description as string) ?? 'task evidence',
    (overrides.proposed_by as string) ?? 'agent:seo-sentinel',
    (overrides.status as string) ?? 'proposed',
    (overrides.action_type as string) ?? 'meta_update',
    'target_metric' in overrides ? (overrides.target_metric as string | null) : null,
    'target_metric_baseline' in overrides ? (overrides.target_metric_baseline as number | null) : null,
    (overrides.completed_at as string | null) ?? null,
    (overrides.approved_at as string | null) ?? null,
    (overrides.created_at as string) ?? daysAgoIso(1),
    (overrides.updated_at as string) ?? daysAgoIso(1),
  );
  return id;
}

function insertOutcome(taskId: string, weeksAfter: number, verdict: string, overrides: Partial<Record<string, unknown>> = {}): void {
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, verdict_detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId(), taskId,
    (overrides.check_date as string) ?? daysAgoIso(1),
    weeksAfter,
    (overrides.metric_value as number) ?? 3.0,
    (overrides.baseline_value as number) ?? 2.0,
    (overrides.change_pct as number) ?? 50,
    verdict,
    (overrides.verdict_detail as string) ?? 'metric moved',
    (overrides.check_date as string) ?? daysAgoIso(1),
  );
}

function insertDecision(goalId: string, businessId: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO decisions (id, business_id, decision_type, title, decision, reasoning, evidence, author, related_goal_id, related_outcome_id, created_at)
    VALUES (?, ?, 'strategy_selection', ?, 'proceed', ?, ?, 'human', ?, ?, ?)
  `).run(
    id, businessId,
    (overrides.title as string) ?? 'Fixture decision',
    (overrides.reasoning as string) ?? 'because reasons',
    JSON.stringify(overrides.evidence ?? []),
    goalId,
    (overrides.related_outcome_id as string | null) ?? null,
    (overrides.created_at as string) ?? daysAgoIso(1),
  );
  return id;
}

function gapTypes(events: ReturnType<typeof buildGoalTimeline>): string[] {
  return (events?.events ?? []).filter((e) => e.type === 'gap').map((e) => e.gap_type as string);
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Goal Timeline A', 'goal-timeline-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Goal Timeline B', 'goal-timeline-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);
});

afterAll(() => {
  // Deliberately not scoped per-business: one test seeds a cross-tenant row
  // (business_id = B, goal_id pointing at a goal owned by A) on purpose, so
  // every child table must be fully cleared — for both businesses — before
  // any `goals` row is deleted, or the goal_id FK blocks the delete.
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (?, ?))`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM decisions WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM signals WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goal_checks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM goals WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM businesses WHERE id IN (?, ?)`).run(BIZ_A, BIZ_B);
});

describe('buildGoalTimeline — not found / isolation', () => {
  test('returns null for a goal id that does not exist', () => {
    expect(buildGoalTimeline('nonexistent-goal', BIZ_A)).toBeNull();
  });

  test('returns null when the goal exists but belongs to a different business', () => {
    const goalId = insertGoal({ business_id: BIZ_A });
    expect(buildGoalTimeline(goalId, BIZ_B)).toBeNull();
  });
});

describe('buildGoalTimeline — gap detection', () => {
  test('a goal with genuine gaps in each detected category renders all four', () => {
    const goalId = insertGoal({ business_id: BIZ_A, created_at: daysAgoIso(20), status: 'active' });
    // No signal ever linked -> no_signal_linked gap.
    // No new event since goal_created (20 days ago) -> stale_activity gap.
    const pendingTask = insertTask(goalId, BIZ_A, { title: 'Stale recommendation', status: 'proposed', created_at: daysAgoIso(16) });
    // No downstream action taken on that recommendation -> no_downstream_action gap.
    const completedTask = insertTask(goalId, BIZ_A, {
      title: 'Unmeasured action', status: 'complete', action_type: 'meta_update',
      target_metric: 'gsc.avg_ctr', target_metric_baseline: 2.0,
      completed_at: daysAgoIso(35), created_at: daysAgoIso(36),
    });
    // completedTask has no task_outcomes row past the 4-week window -> no_measured_outcome gap.

    const timeline = buildGoalTimeline(goalId, BIZ_A);
    expect(timeline).not.toBeNull();
    const types = gapTypes(timeline);
    expect(types).toContain('no_signal_linked');
    expect(types).toContain('stale_activity');
    expect(types).toContain('no_downstream_action');
    expect(types).toContain('no_measured_outcome');

    const gapEvents = timeline!.events.filter((e) => e.type === 'gap');
    for (const g of gapEvents) {
      expect(g.attribution).toBeNull();
      expect(typeof g.reason).toBe('string');
      expect((g.reason as string).length).toBeGreaterThan(0);
    }
    const actionGap = gapEvents.find((e) => e.gap_type === 'no_downstream_action');
    expect((actionGap!.data as any).task_id).toBe(pendingTask);
    const outcomeGap = gapEvents.find((e) => e.gap_type === 'no_measured_outcome');
    expect((outcomeGap!.data as any).task_id).toBe(completedTask);

    // Timeline stays chronologically sorted even with gaps interleaved.
    const timestamps = timeline!.events.map((e) => new Date(e.at ?? 0).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  });

  test('a goal with full linkage renders no false gaps', () => {
    const goalId = insertGoal({ business_id: BIZ_A, created_at: daysAgoIso(2), status: 'active' });
    insertSignal(goalId, BIZ_A, { created_at: daysAgoIso(1) });
    const taskId = insertTask(goalId, BIZ_A, {
      title: 'Verified action', status: 'verified', action_type: 'meta_update',
      target_metric: 'gsc.avg_ctr', target_metric_baseline: 2.0,
      completed_at: daysAgoIso(1), approved_at: daysAgoIso(1), created_at: daysAgoIso(2),
    });
    insertOutcome(taskId, 1, 'improved', { check_date: daysAgoIso(0) });

    const timeline = buildGoalTimeline(goalId, BIZ_A);
    expect(timeline).not.toBeNull();
    const types = gapTypes(timeline);
    expect(types).toEqual([]);
  });

  test('a goal that is too young for the grace period has no premature no_signal_linked gap', () => {
    const goalId = insertGoal({ business_id: BIZ_A, created_at: daysAgoIso(1), status: 'active' });
    const timeline = buildGoalTimeline(goalId, BIZ_A);
    expect(gapTypes(timeline)).not.toContain('no_signal_linked');
  });
});

describe('buildGoalTimeline — correlation vs verified_attribution', () => {
  test('signals, goal lifecycle records, and measured outcomes are verified_attribution', () => {
    const goalId = insertGoal({ business_id: BIZ_A, created_at: daysAgoIso(2) });
    insertSignal(goalId, BIZ_A, { created_at: daysAgoIso(1) });
    const taskId = insertTask(goalId, BIZ_A, {
      status: 'complete', target_metric: 'gsc.avg_ctr', target_metric_baseline: 2.0,
      completed_at: daysAgoIso(1), created_at: daysAgoIso(2),
    });
    insertOutcome(taskId, 1, 'improved');

    const timeline = buildGoalTimeline(goalId, BIZ_A)!;
    const byType = (t: string) => timeline.events.filter((e) => e.type === t);

    expect(byType('goal_created')[0]!.attribution).toBe('verified_attribution');
    expect(byType('signal')[0]!.attribution).toBe('verified_attribution');
    expect(byType('outcome_measured')[0]!.attribution).toBe('verified_attribution');
  });

  test('recommendations and actions are correlation until backed by a measured outcome', () => {
    const goalId = insertGoal({ business_id: BIZ_A });
    insertTask(goalId, BIZ_A, { status: 'approved' });

    const timeline = buildGoalTimeline(goalId, BIZ_A)!;
    const recommendation = timeline.events.find((e) => e.type === 'recommendation')!;
    const action = timeline.events.find((e) => e.type === 'action')!;
    expect(recommendation.attribution).toBe('correlation');
    expect(action.attribution).toBe('correlation');
  });

  test('a decision grounded in cited evidence is verified_attribution; one without evidence is correlation', () => {
    const goalId = insertGoal({ business_id: BIZ_A });
    insertDecision(goalId, BIZ_A, { title: 'Grounded decision', evidence: ['metric moved 20%'] });
    insertDecision(goalId, BIZ_A, { title: 'Judgment-call decision', evidence: [] });

    const timeline = buildGoalTimeline(goalId, BIZ_A)!;
    const grounded = timeline.events.find((e) => e.type === 'decision' && e.summary.includes('Grounded'))!;
    const judgment = timeline.events.find((e) => e.type === 'decision' && e.summary.includes('Judgment-call'))!;
    expect(grounded.attribution).toBe('verified_attribution');
    expect(judgment.attribution).toBe('correlation');
  });

  test('every non-gap event exposes source, status, evidence and business scope', () => {
    const goalId = insertGoal({ business_id: BIZ_A });
    insertSignal(goalId, BIZ_A);
    insertTask(goalId, BIZ_A, { status: 'approved' });
    insertDecision(goalId, BIZ_A);

    const timeline = buildGoalTimeline(goalId, BIZ_A)!;
    for (const e of timeline.events.filter((ev) => ev.type !== 'gap')) {
      expect(e.source).toBeTruthy();
      expect(e.business_scope).toBe(BIZ_A);
      expect('status' in e).toBe(true);
      expect('evidence' in e).toBe(true);
    }
  });
});

describe('buildGoalTimeline — isolation', () => {
  test('concurrent goals in the same business do not leak into each other\'s timelines', () => {
    const goalA = insertGoal({ business_id: BIZ_A, title: 'Goal A' });
    const goalB = insertGoal({ business_id: BIZ_A, title: 'Goal B' });
    insertSignal(goalA, BIZ_A, { title: 'Signal for A' });
    insertTask(goalA, BIZ_A, { title: 'Task for A' });
    insertSignal(goalB, BIZ_A, { title: 'Signal for B' });
    insertTask(goalB, BIZ_A, { title: 'Task for B' });

    const timelineA = buildGoalTimeline(goalA, BIZ_A)!;
    const timelineB = buildGoalTimeline(goalB, BIZ_A)!;

    const summariesA = timelineA.events.map((e) => e.summary).join(' | ');
    const summariesB = timelineB.events.map((e) => e.summary).join(' | ');
    expect(summariesA).toContain('Signal for A');
    expect(summariesA).toContain('Task for A');
    expect(summariesA).not.toContain('Signal for B');
    expect(summariesA).not.toContain('Task for B');
    expect(summariesB).toContain('Signal for B');
    expect(summariesB).toContain('Task for B');
    expect(summariesB).not.toContain('Signal for A');
    expect(summariesB).not.toContain('Task for A');
  });

  test('goals across two different businesses do not leak into each other\'s timelines', () => {
    const goalA = insertGoal({ business_id: BIZ_A, title: 'Cross-biz goal A' });
    const goalB = insertGoal({ business_id: BIZ_B, title: 'Cross-biz goal B' });
    insertSignal(goalA, BIZ_A, { title: 'Only in A' });
    insertSignal(goalB, BIZ_B, { title: 'Only in B' });

    const timelineA = buildGoalTimeline(goalA, BIZ_A)!;
    const timelineB = buildGoalTimeline(goalB, BIZ_B)!;
    expect(timelineA.events.map((e) => e.summary).join(' | ')).toContain('Only in A');
    expect(timelineA.events.map((e) => e.summary).join(' | ')).not.toContain('Only in B');
    expect(timelineB.events.map((e) => e.summary).join(' | ')).toContain('Only in B');
    expect(timelineB.events.map((e) => e.summary).join(' | ')).not.toContain('Only in A');
  });

  test('a cross-tenant signal (goal_id from business A, but tagged business B) is excluded from A\'s timeline', () => {
    const goalA = insertGoal({ business_id: BIZ_A, title: 'Tenant-guard goal' });
    // Simulate a data bug / malicious cross-tenant write: goal_id points at
    // A's goal, but the row itself claims to belong to B.
    insertSignal(goalA, BIZ_B, { title: 'Should never appear in A' });

    const timelineA = buildGoalTimeline(goalA, BIZ_A)!;
    expect(timelineA.events.map((e) => e.summary).join(' | ')).not.toContain('Should never appear in A');
  });
});
