/**
 * "What happened while I was away?" digest — assembly (issue #62).
 *
 * These tests target the digest's honesty guarantees rather than its
 * formatting, because the formatting is not what makes it safe to rely on:
 *
 *   - every emitted item resolves to a REAL row (no fabricated events);
 *   - a measured outcome is distinguished from mere activity;
 *   - repeats collapse, but a repeat that got worse is surfaced, not buried;
 *   - acknowledgement is durable and does not replay unchanged items;
 *   - an explicit `since` overrides the watermark.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  buildAwayDigest, deduplicateItems, resolveWindow, toIso,
  type DigestItem, type DigestSeverity,
} from './away-digest.js';
import { advanceWatermark, resetWatermark, getWatermark } from './digest-watermark.js';

const BIZ_A = 'biz_digest_a';
const BIZ_B = 'biz_digest_b';
const OPERATOR = 'digest-operator';

// A fixed, comfortably-past window so nothing depends on wall-clock drift.
const T0 = '2026-01-10T00:00:00.000Z';
const T1 = '2026-01-11T00:00:00.000Z';
const T2 = '2026-01-12T00:00:00.000Z';
const WINDOW_END = '2026-01-20T00:00:00.000Z';

const created: Array<{ table: string; id: string }> = [];

function track(table: string, id: string): string {
  created.push({ table, id });
  return id;
}

function insertTask(params: {
  business_id: string;
  status?: string;
  title?: string;
  action_type?: string | null;
  target_metric?: string | null;
  completed_at?: string | null;
  created_at?: string;
}): string {
  const id = track('tasks', generateId());
  db.prepare(`
    INSERT INTO tasks (
      id, business_id, title, proposed_by, status, trust_tier, approval_mode,
      action_type, target_metric, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'agent:test', ?, 'yellow', 'requires_approval', ?, ?, ?, ?, ?)
  `).run(
    id, params.business_id, params.title ?? 'Digest fixture task',
    params.status ?? 'complete', params.action_type ?? null,
    params.target_metric ?? null, params.completed_at ?? null,
    params.created_at ?? T0, params.created_at ?? T0,
  );
  return id;
}

function insertOutcome(taskId: string, params: {
  verdict: string; weeks_after?: number; check_date?: string; change_pct?: number;
}): string {
  const id = track('task_outcomes', generateId());
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, created_at)
    VALUES (?, ?, ?, ?, 120, 100, ?, ?, ?)
  `).run(
    id, taskId, params.check_date ?? T1, params.weeks_after ?? 2,
    params.change_pct ?? 20, params.verdict, params.check_date ?? T1,
  );
  return id;
}

function insertConnector(params: {
  business_id: string; type: string; name: string;
  status?: string; last_sync?: string | null; last_error?: string | null;
}): string {
  const id = track('connectors', generateId());
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, status, last_sync, last_error, config, created_at)
    VALUES (?, ?, ?, ?, '{}', ?, ?, ?, '{}', ?)
  `).run(
    id, params.business_id, params.type, params.name,
    params.status ?? 'connected', params.last_sync ?? null,
    params.last_error ?? null, T0,
  );
  return id;
}

/** agent_runs.agent_id is a FK to agents, so the agent must exist first. */
function ensureAgent(agentId: string): void {
  db.prepare(`
    INSERT INTO agents (id, profile_path, name, status)
    VALUES (?, ?, ?, 'active') ON CONFLICT(id) DO NOTHING
  `).run(agentId, `test/${agentId}.md`, agentId);
  // Test-only agent ids (never a real agent name), so teardown can remove
  // them without touching a genuine installed agent.
  created.push({ table: 'agents', id: agentId });
}

function insertAgentRun(businessId: string, agentId: string, completedAt: string): string {
  ensureAgent(agentId);
  const id = track('agent_runs', generateId());
  db.prepare(`
    INSERT INTO agent_runs (id, business_id, agent_id, trigger, status, tasks_proposed, signals_detected, started_at, completed_at)
    VALUES (?, ?, ?, 'manual', 'complete', 1, 0, ?, ?)
  `).run(id, businessId, agentId, completedAt, completedAt);
  return id;
}

/** Every item the digest emitted, flattened across businesses and sections. */
function allItems(digest: ReturnType<typeof buildAwayDigest>): DigestItem[] {
  const out: DigestItem[] = [];
  for (const b of digest.businesses) {
    for (const section of Object.values(b.sections)) out.push(...section);
  }
  return out;
}

function itemsIn(digest: ReturnType<typeof buildAwayDigest>, section: keyof ReturnType<typeof buildAwayDigest>['businesses'][number]['sections']): DigestItem[] {
  return digest.businesses.flatMap((b) => b.sections[section]);
}

function digestFor(overrides: Record<string, unknown> = {}) {
  return buildAwayDigest({
    operator_key: OPERATOR,
    business_id: BIZ_A,
    since: T0,
    until: WINDOW_END,
    ...overrides,
  });
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Digest A', 'digest-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Digest B', 'digest-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);
});

afterAll(() => {
  resetWatermark(OPERATOR, BIZ_A);
  resetWatermark(OPERATOR, BIZ_B);
  resetWatermark(OPERATOR, '*');
  for (const { table, id } of created.reverse()) {
    try { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); } catch { /* fixture teardown */ }
  }
  db.prepare('DELETE FROM businesses WHERE id IN (?, ?)').run(BIZ_A, BIZ_B);
});

beforeEach(() => {
  resetWatermark(OPERATOR, BIZ_A);
});

// ─── Window & scope ──────────────────────────────────────────────────────────

describe('digest window and business scope', () => {
  test('an explicit since/until defines the window and reports its source', () => {
    const digest = digestFor();
    expect(digest.window.start).toBe(T0);
    expect(digest.window.end).toBe(WINDOW_END);
    expect(digest.window.source).toBe('explicit_since');
    expect(digest.window.watermark_applied).toBe(false);
  });

  test('with no watermark and no since, it falls back to a bounded lookback', () => {
    const window = resolveWindow(OPERATOR, BIZ_A, {}, new Date(Date.parse(WINDOW_END)));
    expect(window.source).toBe('default_lookback');
    // 7 days, not "everything ever".
    expect(Date.parse(window.end) - Date.parse(window.start)).toBe(7 * 86400000);
  });

  test('a business-scoped digest never reports another business\'s items', () => {
    const taskB = insertTask({ business_id: BIZ_B, title: 'B-only task', completed_at: T1 });

    const digest = digestFor();
    const ids = allItems(digest).map((i) => i.source.row_id);
    expect(ids).not.toContain(taskB);
    expect(digest.businesses.every((b) => b.business_id === BIZ_A)).toBe(true);
  });

  test('the cross-business digest groups items under their own business', () => {
    insertTask({ business_id: BIZ_A, title: 'A task', completed_at: T1 });
    insertTask({ business_id: BIZ_B, title: 'B task', completed_at: T1 });

    const digest = buildAwayDigest({
      operator_key: OPERATOR, business_id: '*', since: T0, until: WINDOW_END,
    });

    const groups = new Map(digest.businesses.map((b) => [b.business_id, b]));
    expect(groups.has(BIZ_A)).toBe(true);
    expect(groups.has(BIZ_B)).toBe(true);
    for (const [businessId, group] of groups) {
      for (const section of Object.values(group.sections)) {
        for (const item of section) expect(item.business_id).toBe(businessId);
      }
    }
  });

  test('items are grouped by status within each section', () => {
    const improved = insertTask({ business_id: BIZ_A, title: 'Improved', target_metric: 'sessions', completed_at: T0 });
    insertOutcome(improved, { verdict: 'improved', check_date: T1 });
    const worsened = insertTask({ business_id: BIZ_A, title: 'Worsened', target_metric: 'sessions', completed_at: T0 });
    insertOutcome(worsened, { verdict: 'worsened', check_date: T1 });

    const digest = digestFor();
    const counts = digest.businesses[0]!.status_counts.verified_outcomes;
    expect(counts['improved']).toBeGreaterThanOrEqual(1);
    expect(counts['worsened']).toBeGreaterThanOrEqual(1);
  });
});

// ─── No claim without evidence ───────────────────────────────────────────────

describe('every digest item traces to a real source row', () => {
  test('no item is fabricated — each (table, row_id) resolves to an existing row', () => {
    insertTask({ business_id: BIZ_A, title: 'Traceable activity', completed_at: T1 });
    const measured = insertTask({ business_id: BIZ_A, title: 'Traceable outcome', target_metric: 'sessions', completed_at: T0 });
    insertOutcome(measured, { verdict: 'improved', check_date: T1 });
    insertConnector({ business_id: BIZ_A, type: 'ga4', name: 'Broken GA4', status: 'error', last_error: 'connection refused' });
    insertAgentRun(BIZ_A, 'digest-test-agent', T1);

    const items = allItems(digestFor());
    expect(items.length).toBeGreaterThan(0);

    const ALLOWED_TABLES = new Set([
      'tasks', 'task_outcomes', 'connectors', 'system_issues', 'action_receipts', 'agent_runs',
    ]);

    for (const item of items) {
      expect(ALLOWED_TABLES.has(item.source.table)).toBe(true);
      expect(item.source.row_id).toBeTruthy();

      // The load-bearing assertion: the cited row genuinely exists.
      const row = db.prepare(`SELECT 1 AS ok FROM ${item.source.table} WHERE id = ?`).get(item.source.row_id);
      expect(row).toBeTruthy();

      // And every collapsed occurrence is equally traceable.
      for (const occurrence of item.occurrences) {
        const occRow = db.prepare(`SELECT 1 AS ok FROM ${occurrence.table} WHERE id = ?`).get(occurrence.row_id);
        expect(occRow).toBeTruthy();
      }
    }
  });

  test('every item carries a non-empty in-app source link and evidence', () => {
    insertTask({ business_id: BIZ_A, title: 'Linked', completed_at: T1 });
    insertConnector({ business_id: BIZ_A, type: 'gsc', name: 'Stale GSC', status: 'error', last_error: 'quota' });

    for (const item of allItems(digestFor())) {
      expect(typeof item.source.href).toBe('string');
      expect(item.source.href.startsWith('/')).toBe(true);
      expect(item.source.evidence).toBeTruthy();
      expect(Object.keys(item.source.evidence).length).toBeGreaterThan(0);
    }
  });
});

// ─── Verified outcomes vs. activity ──────────────────────────────────────────

describe('verified outcomes are distinguished from mere activity', () => {
  test('a measured outcome lands in verified_outcomes, citing its task_outcomes row', () => {
    const taskId = insertTask({ business_id: BIZ_A, title: 'Measured task', target_metric: 'sessions', completed_at: T0 });
    const outcomeId = insertOutcome(taskId, { verdict: 'improved', check_date: T1 });

    const verified = itemsIn(digestFor(), 'verified_outcomes');
    const item = verified.find((i) => i.dedup_key === `outcome:${taskId}`);

    expect(item).toBeTruthy();
    expect(item!.source.table).toBe('task_outcomes');
    expect(item!.source.row_id).toBe(outcomeId);
    expect(item!.source.evidence.taxonomy_state).toBe('outcome_measured');
    expect(item!.status).toBe('improved');
  });

  test('a completed task with NO measurement is activity, never a verified outcome', () => {
    const taskId = insertTask({ business_id: BIZ_A, title: 'Just completed', completed_at: T1 });

    const digest = digestFor();
    expect(itemsIn(digest, 'verified_outcomes').some((i) => i.source.row_id === taskId)).toBe(false);

    const info = itemsIn(digest, 'informational_activity').find((i) => i.dedup_key === `task_activity:${taskId}`);
    expect(info).toBeTruthy();
    // The honest #63 label travels with it rather than being smoothed away.
    expect(info!.status).toBe('verified_action');
    expect(info!.severity).toBe('info');
  });

  test('a completed task still inside its measurement window is not a verified outcome', () => {
    // target_metric set but no task_outcomes row yet → roi_not_measurable.
    const taskId = insertTask({ business_id: BIZ_A, title: 'Awaiting measurement', target_metric: 'sessions', completed_at: T1 });

    const digest = digestFor();
    expect(itemsIn(digest, 'verified_outcomes').some((i) => i.source.row_id === taskId)).toBe(false);

    const info = itemsIn(digest, 'informational_activity').find((i) => i.dedup_key === `task_activity:${taskId}`);
    expect(info).toBeTruthy();
    expect(info!.status).toBe('roi_not_measurable');
  });

  test('a worsened outcome is reported as a verified outcome, not hidden', () => {
    const taskId = insertTask({ business_id: BIZ_A, title: 'Went backwards', target_metric: 'sessions', completed_at: T0 });
    insertOutcome(taskId, { verdict: 'worsened', check_date: T1, change_pct: -30 });

    const item = itemsIn(digestFor(), 'verified_outcomes').find((i) => i.dedup_key === `outcome:${taskId}`);
    expect(item).toBeTruthy();
    expect(item!.status).toBe('worsened');
    // Bad news outranks good news in the ordering.
    expect(item!.severity).toBe('high');
  });
});

// ─── Failures & stale data ───────────────────────────────────────────────────

describe('failures and stale data', () => {
  test('a failing connector is reported with impact and a next step', () => {
    const connectorId = insertConnector({
      business_id: BIZ_A, type: 'ga4', name: 'GA4 Prod',
      status: 'error', last_error: 'invalid_grant',
    });

    const failures = itemsIn(digestFor(), 'failures_and_stale_data');
    const item = failures.find((i) => i.source.row_id === connectorId);

    expect(item).toBeTruthy();
    expect(item!.source.table).toBe('connectors');
    expect(item!.source.evidence.health_state).toBeTruthy();
    expect(item!.source.evidence.impact).toBeTruthy();
    expect(item!.source.evidence.next_step).toBeTruthy();
  });

  test('a healthy connector is not reported as a failure', () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const connectorId = insertConnector({
      business_id: BIZ_A, type: 'shopify', name: 'Shopify OK',
      status: 'connected', last_sync: recent,
    });

    const failures = itemsIn(digestFor(), 'failures_and_stale_data');
    expect(failures.some((i) => i.source.row_id === connectorId)).toBe(false);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

function fakeItem(overrides: Partial<DigestItem> & { dedup_key: string; severity: DigestSeverity; occurred_at: string }): DigestItem {
  const source = {
    kind: 'test', table: 'tasks', row_id: `row_${overrides.occurred_at}`,
    href: '/tasks', evidence: { seed: true },
  };
  return {
    change_fingerprint: `fp_${overrides.occurred_at}_${overrides.severity}`,
    section: 'failures_and_stale_data',
    business_id: BIZ_A,
    business_name: 'Digest A',
    status: overrides.severity,
    title: 'Repeating signal',
    detail: null,
    source,
    occurrences: [source],
    occurrence_count: 1,
    first_occurrence_at: overrides.occurred_at,
    last_occurrence_at: overrides.occurred_at,
    escalation: null,
    previously_seen: false,
    replay_reason: null,
    ...overrides,
  } as DigestItem;
}

describe('deduplication collapses repeats without hiding material changes', () => {
  test('repeats of the same signal collapse into one entry with a count', () => {
    const collapsed = deduplicateItems([
      fakeItem({ dedup_key: 'repeat:x', severity: 'medium', occurred_at: T0 }),
      fakeItem({ dedup_key: 'repeat:x', severity: 'medium', occurred_at: T1 }),
      fakeItem({ dedup_key: 'repeat:x', severity: 'medium', occurred_at: T2 }),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.occurrence_count).toBe(3);
    expect(collapsed[0]!.first_occurrence_at).toBe(T0);
    expect(collapsed[0]!.last_occurrence_at).toBe(T2);
    // Collapsing must not destroy evidence: every occurrence is still cited.
    expect(collapsed[0]!.occurrences).toHaveLength(3);
    // A flat group is a genuine duplicate, so no escalation is claimed.
    expect(collapsed[0]!.escalation).toBeNull();
  });

  test('a severity escalation within a dedup group is surfaced, not buried as a repeat', () => {
    const collapsed = deduplicateItems([
      fakeItem({ dedup_key: 'repeat:y', severity: 'medium', occurred_at: T0, status: 'stale' }),
      fakeItem({ dedup_key: 'repeat:y', severity: 'medium', occurred_at: T1, status: 'stale' }),
      fakeItem({ dedup_key: 'repeat:y', severity: 'critical', occurred_at: T2, status: 'failing' }),
    ]);

    expect(collapsed).toHaveLength(1);
    const item = collapsed[0]!;

    // The group takes the WORST severity, so it sorts to the top.
    expect(item.severity).toBe('critical');
    expect(item.escalation).toBeTruthy();
    expect(item.escalation!.from_severity).toBe('medium');
    expect(item.escalation!.to_severity).toBe('critical');
    expect(item.escalation!.reason).toContain('escalated');
    // Both ends of the escalation are independently citable.
    expect(item.escalation!.from_source.row_id).toBe(`row_${T0}`);
    expect(item.escalation!.to_source.row_id).toBe(`row_${T2}`);
  });

  test('a de-escalation is not reported as an escalation', () => {
    const collapsed = deduplicateItems([
      fakeItem({ dedup_key: 'repeat:z', severity: 'critical', occurred_at: T0 }),
      fakeItem({ dedup_key: 'repeat:z', severity: 'low', occurred_at: T2 }),
    ]);
    expect(collapsed[0]!.escalation).toBeNull();
  });

  test('distinct dedup keys never merge', () => {
    const collapsed = deduplicateItems([
      fakeItem({ dedup_key: 'a', severity: 'low', occurred_at: T0 }),
      fakeItem({ dedup_key: 'b', severity: 'low', occurred_at: T0 }),
    ]);
    expect(collapsed).toHaveLength(2);
  });

  test('repeated agent runs for one agent collapse into a single line', () => {
    insertAgentRun(BIZ_A, 'dedupe-agent', T0);
    insertAgentRun(BIZ_A, 'dedupe-agent', T1);
    insertAgentRun(BIZ_A, 'dedupe-agent', T2);

    const runs = itemsIn(digestFor(), 'informational_activity')
      .filter((i) => i.dedup_key === 'agent_run:dedupe-agent');

    expect(runs).toHaveLength(1);
    expect(runs[0]!.occurrence_count).toBe(3);
    expect(runs[0]!.occurrences).toHaveLength(3);
  });
});

// ─── Acknowledgement & replay ────────────────────────────────────────────────

describe('acknowledgement is durable and does not replay unchanged items', () => {
  test('acknowledging then re-requesting does not replay unchanged items', () => {
    const taskId = insertTask({ business_id: BIZ_A, title: 'Ack me', completed_at: T1 });

    const first = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, since: T0, until: WINDOW_END });
    expect(allItems(first).some((i) => i.dedup_key === `task_activity:${taskId}`)).toBe(true);

    advanceWatermark({
      operator_key: OPERATOR, business_id: BIZ_A,
      acknowledged_through: first.window.end,
      items: first.acknowledgeable,
    });

    // Second request uses the watermark (no explicit since).
    const second = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, until: WINDOW_END });
    expect(allItems(second).some((i) => i.dedup_key === `task_activity:${taskId}`)).toBe(false);
    expect(second.window.source).toBe('watermark');
    expect(second.window.watermark_applied).toBe(true);
  });

  test('the watermark survives as a durable row, not in-memory state', () => {
    const digest = digestFor();
    advanceWatermark({
      operator_key: OPERATOR, business_id: BIZ_A,
      acknowledged_through: digest.window.end,
      acknowledged_by: OPERATOR,
      acknowledged_digest_id: digest.digest_id,
      items: digest.acknowledgeable,
    });

    // Read back through a fresh query — this is a real table row.
    const row = db.prepare(
      'SELECT * FROM digest_watermarks WHERE operator_key = ? AND business_id = ?'
    ).get(OPERATOR, BIZ_A) as Record<string, unknown> | undefined;

    expect(row).toBeTruthy();
    expect(toIso(row!.acknowledged_through)).toBe(digest.window.end);
    expect(row!.acknowledged_digest_id).toBe(digest.digest_id);

    const parsed = getWatermark(OPERATOR, BIZ_A);
    expect(parsed!.acknowledged_items).toEqual(digest.acknowledgeable);
  });

  test('suppressed items are counted, so "nothing new" is distinguishable from "nothing happened"', () => {
    insertTask({ business_id: BIZ_A, title: 'Counted suppression', completed_at: T1 });

    const first = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, since: T0, until: WINDOW_END });
    const shown = first.totals.total;
    expect(shown).toBeGreaterThan(0);

    advanceWatermark({
      operator_key: OPERATOR, business_id: BIZ_A,
      acknowledged_through: T0, // deliberately low, so the window still covers the items
      items: first.acknowledgeable,
    });

    const second = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, until: WINDOW_END });
    expect(second.suppressed_as_seen).toBeGreaterThan(0);
    expect(second.totals.suppressed_as_seen).toBe(second.suppressed_as_seen);
  });

  test('a materially changed item IS replayed, flagged as changed rather than as new', () => {
    const connectorId = insertConnector({
      business_id: BIZ_A, type: 'gbp', name: 'Escalating connector',
      status: 'error', last_error: 'temporary failure',
    });

    const first = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, since: T0, until: WINDOW_END });
    const before = allItems(first).find((i) => i.dedup_key === `connector:${connectorId}`);
    expect(before).toBeTruthy();

    advanceWatermark({
      operator_key: OPERATOR, business_id: BIZ_A,
      acknowledged_through: T0,
      items: first.acknowledgeable,
    });

    // Unchanged → suppressed.
    const unchanged = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, until: WINDOW_END });
    expect(allItems(unchanged).some((i) => i.dedup_key === `connector:${connectorId}`)).toBe(false);

    // Now the connector's health materially changes (permission problem).
    db.prepare('UPDATE connectors SET last_error = ? WHERE id = ?')
      .run('403 forbidden — missing scope', connectorId);

    const changed = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, until: WINDOW_END });
    const after = allItems(changed).find((i) => i.dedup_key === `connector:${connectorId}`);

    expect(after).toBeTruthy();
    expect(after!.previously_seen).toBe(true);
    expect(after!.replay_reason).toBeTruthy();
    expect(after!.change_fingerprint).not.toBe(before!.change_fingerprint);
  });

  test('an acknowledgement cannot drag the watermark backwards', () => {
    advanceWatermark({ operator_key: OPERATOR, business_id: BIZ_A, acknowledged_through: T2, items: {} });
    advanceWatermark({ operator_key: OPERATOR, business_id: BIZ_A, acknowledged_through: T0, items: {} });

    const watermark = getWatermark(OPERATOR, BIZ_A);
    expect(toIso(watermark!.acknowledged_through)).toBe(T2);
  });
});

describe('an explicit re-request overrides the watermark', () => {
  test('since= replays acknowledged items that the watermark would suppress', () => {
    const taskId = insertTask({ business_id: BIZ_A, title: 'Re-requestable', completed_at: T1 });

    const first = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, since: T0, until: WINDOW_END });
    advanceWatermark({
      operator_key: OPERATOR, business_id: BIZ_A,
      acknowledged_through: first.window.end,
      items: first.acknowledgeable,
    });

    // Watermarked request hides it...
    const watermarked = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, until: WINDOW_END });
    expect(allItems(watermarked).some((i) => i.dedup_key === `task_activity:${taskId}`)).toBe(false);

    // ...but explicitly asking for the period brings it back.
    const rerequested = buildAwayDigest({
      operator_key: OPERATOR, business_id: BIZ_A, since: T0, until: WINDOW_END,
    });
    expect(allItems(rerequested).some((i) => i.dedup_key === `task_activity:${taskId}`)).toBe(true);
    expect(rerequested.window.watermark_applied).toBe(false);
    expect(rerequested.suppressed_as_seen).toBe(0);
  });

  test('an explicit re-request still reports where the watermark sits', () => {
    advanceWatermark({ operator_key: OPERATOR, business_id: BIZ_A, acknowledged_through: T1, items: {} });

    const digest = buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, since: T0, until: WINDOW_END });
    expect(digest.window.watermark_applied).toBe(false);
    expect(digest.window.watermark_at).toBe(T1);
  });

  test('an explicit re-request does not destroy the watermark', () => {
    advanceWatermark({ operator_key: OPERATOR, business_id: BIZ_A, acknowledged_through: T1, items: {} });
    buildAwayDigest({ operator_key: OPERATOR, business_id: BIZ_A, since: T0, until: WINDOW_END });

    // A one-off look back must not cost the operator their catch-up point.
    expect(getWatermark(OPERATOR, BIZ_A)).toBeTruthy();
  });
});

// ─── Timestamp handling ──────────────────────────────────────────────────────

describe('timestamp normalisation', () => {
  test("SQLite's CURRENT_TIMESTAMP form is read as UTC, not local time", () => {
    // Left unnormalised, Date.parse() reads this as local time and shifts
    // the event by the host's UTC offset — moving items across the window
    // boundary depending on where the server runs.
    expect(toIso('2026-01-11 12:00:00')).toBe('2026-01-11T12:00:00.000Z');
  });

  test('ISO input is preserved and junk is rejected', () => {
    expect(toIso('2026-01-11T12:00:00.000Z')).toBe('2026-01-11T12:00:00.000Z');
    expect(toIso('not a date')).toBeNull();
    expect(toIso(null)).toBeNull();
  });
});
