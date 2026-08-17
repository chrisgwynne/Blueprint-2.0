/**
 * Executive command centre (#59) — server/executive/command-centre.ts.
 *
 * The properties under test are the four acceptance criteria, plus the one
 * structural guarantee the whole design rests on:
 *
 *   1. a multi-business selection produces a coherent per-business summary
 *   2. every item links to supporting evidence and carries a time window
 *   3. proposed / approved / executed / verified / outcome-measured stay
 *      genuinely distinct — the ladder must not collapse into one bucket
 *   4. one failed business or section does not hide unrelated results
 *   5. selection is scoped to what the actor may read
 *
 * Failure isolation is exercised by making a REAL dependency of the ROI
 * engine throw for exactly one business id. attribution-engine.ts calls
 * getBaselines() first thing, so stubbing that to throw for the poisoned
 * business makes computeROIReport() fail from inside its own real code
 * path — the way an actual outage would — while every other business runs
 * the genuine engine. Stubbing computeROIReport itself would have proved
 * only that a stub throws.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

const BIZ_A = 'biz_cc_alpha';
const BIZ_B = 'biz_cc_beta';
const BIZ_POISON = 'biz_cc_poison';
const ALL = [BIZ_A, BIZ_B, BIZ_POISON];

const POISON_MESSAGE = 'Simulated baseline-store failure for the poisoned business.';

// Declared before the modules under test are imported, so they resolve to
// the stub. Returning [] for healthy businesses is truthful here — these
// fixtures record no baselines — so the real engine still runs end to end.
mock.module('../roi/baselines.js', () => ({
  getBaselines: (businessId: string) => {
    if (businessId === BIZ_POISON) throw new Error(POISON_MESSAGE);
    return [];
  },
  getBaseline: () => null,
  getCurrentMetric: () => null,
  recordBaseline: () => undefined,
  captureBaselinesForConnector: () => ({ recorded: 0, skipped: 0 }),
  BASELINE_METRICS_BY_CONNECTOR: {},
}));

const { default: db, generateId } = await import('../db/db.js');
const { RECEIPT_SCHEMA_VERSION, buildCorrelationKey } = await import('../tasks/action-receipts.js');

const {
  assembleCommandCentre, buildWorkLadder, section, evidenceLink,
  receiptLadderState, newestTimestamp, timestampMs, WORK_STATES,
  listAccessibleBusinessIds, CommandCentreError,
} = await import('./command-centre.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function insertBusiness(id: string, name: string, slug: string): void {
  db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .run(id, name, slug);
}

interface TaskSpec {
  status: string;
  title: string;
  actionType?: string | null;
  targetMetric?: string | null;
  completedAt?: string | null;
}

function insertTask(businessId: string, spec: TaskSpec): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (
      id, business_id, title, description, proposed_by, status, trust_tier,
      approval_mode, action_type, target_metric, completed_at, version,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'Fixture task for the command centre.', 'agent:test', ?, 'yellow',
      'requires_approval', ?, ?, ?, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, businessId, spec.title, spec.status,
    spec.actionType ?? null, spec.targetMetric ?? null, spec.completedAt ?? null,
  );
  return id;
}

/** A receipt whose furthest reached stage is controlled by which timestamps are set. */
function insertReceipt(
  businessId: string,
  taskId: string,
  stage: 'authorized' | 'executed' | 'verified',
  opts: { anomalies?: unknown[]; state?: string } = {},
): string {
  const id = generateId();
  const executedAt = stage === 'executed' || stage === 'verified' ? new Date().toISOString() : null;
  const verifiedAt = stage === 'verified' ? new Date().toISOString() : null;
  db.prepare(`
    INSERT INTO action_receipts (
      id, receipt_version, business_id, task_id, task_version, correlation_key,
      action_type, title, state, result_status,
      requested_at, authorized_at, authorized_by, executed_at, verified_at,
      anomalies, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 2, ?, 'github_issue', ?, ?, 'success',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dashboard:owner', ?, ?, ?, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, RECEIPT_SCHEMA_VERSION, businessId, taskId, buildCorrelationKey(taskId, 2),
    `Receipt for ${taskId}`, opts.state ?? stage, executedAt, verifiedAt,
    opts.anomalies ? JSON.stringify(opts.anomalies) : null,
  );
  return id;
}

function insertOutcome(taskId: string, verdict: string, weeksAfter: number): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, 120, 100, 20, ?)
  `).run(id, taskId, weeksAfter, verdict);
  return id;
}

function insertConnector(businessId: string, type: string, name: string, opts: { lastError?: string | null; status?: string } = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, last_sync, last_error, config)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, '{}')
  `).run(id, businessId, type, name, opts.status ?? 'connected', opts.lastError ?? null);
  return id;
}

// Ids captured at setup so assertions can name the exact expected record.
let proposedTaskA = '';
let approvedTaskA = '';
let executedTaskA = '';
let verifiedTaskA = '';
let measuredTaskA = '';
let verifiedReceiptA = '';
let executedReceiptA = '';
let failingConnectorA = '';
let proposedTaskB = '';

beforeAll(() => {
  insertBusiness(BIZ_A, 'Alpha Trading', 'cc-alpha');
  insertBusiness(BIZ_B, 'Beta Retail', 'cc-beta');
  insertBusiness(BIZ_POISON, 'Poisoned Co', 'cc-poison');

  // ── Business A: one task at each rung of the ladder ──────────────────────
  proposedTaskA = insertTask(BIZ_A, { status: 'proposed', title: 'A: awaiting approval', actionType: 'github_issue' });

  approvedTaskA = insertTask(BIZ_A, { status: 'approved', title: 'A: approved, not run', actionType: 'github_issue' });
  insertReceipt(BIZ_A, approvedTaskA, 'authorized');

  executedTaskA = insertTask(BIZ_A, {
    status: 'complete', title: 'A: ran, unverified', actionType: 'github_issue',
    completedAt: new Date().toISOString(),
  });
  executedReceiptA = insertReceipt(BIZ_A, executedTaskA, 'executed');

  // Verified receipt but NO target metric — so #63 cannot claim an outcome,
  // and this task must stay at 'verified' rather than being promoted.
  verifiedTaskA = insertTask(BIZ_A, {
    status: 'complete', title: 'A: independently verified', actionType: 'github_issue',
    completedAt: new Date().toISOString(),
  });
  verifiedReceiptA = insertReceipt(BIZ_A, verifiedTaskA, 'verified');

  // Verified receipt AND a measured outcome — must be promoted past
  // 'verified' to 'outcome_measured'.
  measuredTaskA = insertTask(BIZ_A, {
    status: 'complete', title: 'A: outcome measured', actionType: 'github_issue',
    targetMetric: 'ga4.sessions', completedAt: new Date().toISOString(),
  });
  insertReceipt(BIZ_A, measuredTaskA, 'verified');
  insertOutcome(measuredTaskA, 'improved', 4);

  failingConnectorA = insertConnector(BIZ_A, 'ga4', 'Alpha GA4', {
    status: 'error', lastError: 'connection refused',
  });

  // ── Business B: independent, healthy, must survive A's and Poison's woes ──
  proposedTaskB = insertTask(BIZ_B, { status: 'proposed', title: 'B: awaiting approval', actionType: 'github_issue' });
  insertConnector(BIZ_B, 'gsc', 'Beta GSC');

  // ── Poisoned business: real rows, but its ROI section will throw ─────────
  insertTask(BIZ_POISON, { status: 'proposed', title: 'Poison: awaiting approval', actionType: 'github_issue' });
});

afterAll(() => {
  const placeholders = ALL.map(() => '?').join(',');
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (${placeholders}))`).run(...ALL);
  db.prepare(`DELETE FROM action_receipts WHERE business_id IN (${placeholders})`).run(...ALL);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${placeholders})`).run(...ALL);
  db.prepare(`DELETE FROM connectors WHERE business_id IN (${placeholders})`).run(...ALL);
});

// ─── 1. Multi-business assembly ──────────────────────────────────────────────

describe('multi-business summary assembly', () => {
  test('returns one coherent summary row per selected business', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A, BIZ_B] });

    expect(result.businesses.length).toBe(2);
    expect(result.businesses.map((b) => b.business_id).sort()).toEqual([BIZ_A, BIZ_B].sort());
    expect(result.requested_business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());

    const a = result.businesses.find((b) => b.business_id === BIZ_A)!;
    expect(a.business_name).toBe('Alpha Trading');
    expect(a.decisions.status).toBe('ok');
    expect(a.work_states.status).toBe('ok');
    expect(a.verified_changes.status).toBe('ok');
    expect(a.connectors.status).toBe('ok');
  });

  test('cross-business totals sum the per-business sections', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A, BIZ_B] });
    const a = result.businesses.find((b) => b.business_id === BIZ_A)!;
    const b = result.businesses.find((b) => b.business_id === BIZ_B)!;

    expect(result.portfolio_totals.pending_decisions)
      .toBe((a.decisions.data?.total ?? 0) + (b.decisions.data?.total ?? 0));
    // Both businesses have a proposal awaiting a human.
    expect(result.portfolio_totals.pending_decisions).toBeGreaterThanOrEqual(2);
    expect(result.portfolio_totals.businesses_ok).toBe(2);
  });

  test('an explicit selection larger than the cap is refused, never silently trimmed', () => {
    // Dropping 15 of 40 businesses the caller specifically named would be a
    // lie about what the summary covers.
    const tooMany = Array.from({ length: 26 }, (_, i) => `biz_${i}`);
    expect(() => assembleCommandCentre({ actor: 'dashboard:test', businessIds: tooMany }))
      .toThrow(CommandCentreError);
  });

  test('an oversized DEFAULT selection is truncated with a stated notice, not an error', () => {
    // An operator with more businesses than the cap must not be met with an
    // error they can only escape by guessing a selection.
    const created: string[] = [];
    try {
      for (let i = 0; i < 30; i++) {
        const id = `biz_cc_bulk_${i}`;
        db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
          .run(id, `Bulk ${i}`, `cc-bulk-${i}`);
        created.push(id);
      }
      const result = assembleCommandCentre({ actor: 'dashboard:test' });
      expect(result.businesses.length).toBeLessThanOrEqual(25);
      expect(result.selection_notice).toContain('truncation, not a total');
    } finally {
      db.prepare(`DELETE FROM businesses WHERE id IN (${created.map(() => '?').join(',')})`).run(...created);
    }
  });

  test('a selection within the cap carries no truncation notice', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A, BIZ_B] });
    expect(result.selection_notice).toBeNull();
  });
});

// ─── 2. Evidence links and freshness ─────────────────────────────────────────

describe('every item carries evidence and a time window', () => {
  test('the summary declares the window it covers', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A], windowDays: 7 });
    expect(result.window_days).toBe(7);
    expect(timestampMs(result.window_start)).toBeLessThan(timestampMs(result.window_end)!);
    // The window really is seven days wide, not a label over a 30-day query.
    const spanDays = (timestampMs(result.window_end)! - timestampMs(result.window_start)!) / 86_400_000;
    expect(Math.round(spanDays)).toBe(7);
  });

  test('every section reports both when it was computed and how old its data is', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A] });
    const a = result.businesses[0]!;
    for (const name of ['decisions', 'work_states', 'verified_changes', 'connectors'] as const) {
      const env = a[name];
      expect(env.as_of).toBeTruthy();
      expect(timestampMs(env.as_of)).not.toBeNull();
      // data_as_of may legitimately be null (no source records), but must
      // never be a value that cannot be parsed.
      if (env.data_as_of !== null) expect(timestampMs(env.data_as_of)).not.toBeNull();
    }
  });

  test('every decision, ladder item and verified change links to a real record', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A] });
    const a = result.businesses[0]!;

    const allLinked = [
      ...(a.decisions.data?.items ?? []),
      ...(a.work_states.data?.items ?? []),
      ...(a.verified_changes.data?.items ?? []),
      ...(a.connectors.data?.unhealthy ?? []),
    ];
    expect(allLinked.length).toBeGreaterThan(0);

    for (const item of allLinked) {
      const link = item.evidence;
      expect(link.id).toBeTruthy();
      expect(link.business_id).toBe(BIZ_A);
      // The href must actually carry the record id, not just a bare route —
      // a "drill-down" that lands on an unfiltered list is decorative.
      expect(link.href).toContain(encodeURIComponent(link.id));
      expect(link.href.startsWith('/')).toBe(true);
    }
  });

  test('an evidence id resolves to the row it claims to point at', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A] });
    const a = result.businesses[0]!;

    for (const item of a.verified_changes.data?.items ?? []) {
      const row = db.prepare('SELECT id, business_id FROM action_receipts WHERE id = ?').get(item.evidence.id) as { id: string; business_id: string } | undefined;
      expect(row).toBeTruthy();
      expect(row!.business_id).toBe(BIZ_A);
    }
    for (const item of a.decisions.data?.items ?? []) {
      const row = db.prepare('SELECT id, business_id FROM tasks WHERE id = ?').get(item.evidence.id) as { business_id: string } | undefined;
      expect(row).toBeTruthy();
      expect(row!.business_id).toBe(BIZ_A);
    }
  });

  test('items carry the timestamp of the event that produced them', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A] });
    const items = result.businesses[0]!.work_states.data?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    // Proposed items may have no completion event; everything that actually
    // happened must be timestamped.
    for (const item of items.filter((i) => i.state !== 'proposed')) {
      expect(item.occurred_at).toBeTruthy();
      expect(timestampMs(item.occurred_at)).not.toBeNull();
    }
  });
});

// ─── 3. The five states stay distinct ────────────────────────────────────────

describe('the work ladder genuinely distinguishes all five states', () => {
  test('each of the five states is populated, not collapsed into one bucket', () => {
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const ladder = buildWorkLadder(BIZ_A, windowStart, new Date().toISOString(), 25);

    for (const state of WORK_STATES) {
      expect(ladder.counts[state]).toBeGreaterThan(0);
    }
    // Five tasks, five distinct rungs — nothing double-counted.
    const total = WORK_STATES.reduce((sum, s) => sum + ladder.counts[s], 0);
    expect(total).toBe(5);
  });

  test('each fixture task lands on exactly the rung it was built for', () => {
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const ladder = buildWorkLadder(BIZ_A, windowStart, new Date().toISOString(), 25);
    const byTask = new Map(ladder.items.map((i) => [i.task_id, i]));

    expect(byTask.get(proposedTaskA)?.state).toBe('proposed');
    expect(byTask.get(approvedTaskA)?.state).toBe('approved');
    expect(byTask.get(executedTaskA)?.state).toBe('executed');
    expect(byTask.get(verifiedTaskA)?.state).toBe('verified');
    expect(byTask.get(measuredTaskA)?.state).toBe('outcome_measured');
  });

  test('an executed-but-unverified action is never reported as verified', () => {
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const ladder = buildWorkLadder(BIZ_A, windowStart, new Date().toISOString(), 25);
    const executed = ladder.items.find((i) => i.task_id === executedTaskA)!;

    expect(executed.state).toBe('executed');
    expect(executed.evidence.id).toBe(executedReceiptA);
    // This is the specific dishonesty #70 exists to prevent.
    expect(executed.state).not.toBe('verified');
  });

  test('a measured outcome outranks a verified receipt on the same task', () => {
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const ladder = buildWorkLadder(BIZ_A, windowStart, new Date().toISOString(), 25);

    const measured = ladder.items.find((i) => i.task_id === measuredTaskA)!;
    expect(measured.state).toBe('outcome_measured');
    expect(measured.evidence_source).toBe('outcome_measurement');
    // ...while the verified-receipt task with no metric stays at 'verified'.
    const verified = ladder.items.find((i) => i.task_id === verifiedTaskA)!;
    expect(verified.state).toBe('verified');
    expect(verified.evidence.id).toBe(verifiedReceiptA);
  });

  test("#63's four-state taxonomy is reported alongside the ladder, not merged into it", () => {
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const ladder = buildWorkLadder(BIZ_A, windowStart, new Date().toISOString(), 25);

    // The taxonomy is its own axis: the two verified/executed tasks with no
    // target metric are 'verified_action', the measured one is
    // 'outcome_measured', the proposal is 'activity'.
    expect(ladder.taxonomy_counts.outcome_measured).toBeGreaterThan(0);
    expect(ladder.taxonomy_counts.verified_action).toBeGreaterThan(0);
    expect(ladder.taxonomy_counts.activity).toBeGreaterThan(0);

    // And the two axes are genuinely different numbers, not one relabelled.
    expect(ladder.counts.verified).not.toBe(ladder.taxonomy_counts.verified_action);
  });

  test('receiptLadderState reads the furthest stage a receipt attests to', () => {
    expect(receiptLadderState({ verified_at: 'x', executed_at: 'y', externally_acknowledged_at: null, authorized_at: 'z', state: 'verified' })?.state).toBe('verified');
    expect(receiptLadderState({ verified_at: null, executed_at: 'y', externally_acknowledged_at: null, authorized_at: 'z', state: 'executed' })?.state).toBe('executed');
    // An external acknowledgement is execution, never verification.
    expect(receiptLadderState({ verified_at: null, executed_at: null, externally_acknowledged_at: 'y', authorized_at: 'z', state: 'externally_acknowledged' })?.state).toBe('executed');
    expect(receiptLadderState({ verified_at: null, executed_at: null, externally_acknowledged_at: null, authorized_at: 'z', state: 'authorized' })?.state).toBe('approved');
    // A receipt that never got anywhere is not ladder progress.
    expect(receiptLadderState({ verified_at: null, executed_at: null, externally_acknowledged_at: null, authorized_at: null, state: 'rejected_pre_execution' })).toBeNull();
  });
});

// ─── 4. Failure isolation ────────────────────────────────────────────────────

describe('one failure does not hide unrelated results', () => {
  test('section() converts a throw into a failed envelope rather than propagating', () => {
    const failed = section<string>('boom', () => { throw new Error('kaboom'); });
    expect(failed.status).toBe('failed');
    expect(failed.error?.message).toBe('kaboom');
    expect(failed.error?.code).toBe('boom');
    expect(failed.data).toBeNull();
    // Still timestamped: the UI must be able to say when we tried.
    expect(failed.as_of).toBeTruthy();

    const ok = section<string>('fine', () => ({ data: 'value', data_as_of: null }));
    expect(ok.status).toBe('ok');
    expect(ok.data).toBe('value');
  });

  test("a business whose ROI section throws still returns all its other sections", () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_POISON] });
    const poison = result.businesses[0]!;

    expect(poison.status).toBe('degraded');
    expect(poison.failed_sections).toEqual(['outcomes']);
    expect(poison.outcomes.status).toBe('failed');
    expect(poison.outcomes.error?.message).toContain(POISON_MESSAGE);

    // The point: everything else on this business is real.
    expect(poison.decisions.status).toBe('ok');
    expect(poison.decisions.data!.total).toBeGreaterThan(0);
    expect(poison.work_states.status).toBe('ok');
    expect(poison.connectors.status).toBe('ok');
  });

  test("one business's failure does not blank out the others in the same request", () => {
    const result = assembleCommandCentre({
      actor: 'dashboard:test', businessIds: [BIZ_A, BIZ_POISON, BIZ_B],
    });
    expect(result.businesses.length).toBe(3);

    const a = result.businesses.find((b) => b.business_id === BIZ_A)!;
    const b = result.businesses.find((b) => b.business_id === BIZ_B)!;
    const poison = result.businesses.find((b) => b.business_id === BIZ_POISON)!;

    expect(poison.status).toBe('degraded');
    // A and B are entirely unaffected.
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(a.decisions.data!.total).toBeGreaterThan(0);
    expect(b.decisions.data!.total).toBeGreaterThan(0);
    expect(a.outcomes.status).toBe('ok');
    expect(b.outcomes.status).toBe('ok');
  });

  test("cross_business_patterns excludes the poisoned business with a reason, without corrupting its own patterns or any other section", () => {
    const result = assembleCommandCentre({
      actor: 'dashboard:test', businessIds: [BIZ_A, BIZ_POISON, BIZ_B],
    });

    // The new section detects its own money-comovement patterns via
    // computeROIReport(), same as the outcomes section — so the SAME
    // poisoned baseline store fails it the same honest way, but only for
    // BIZ_POISON's contribution, not the section as a whole.
    expect(result.cross_business_patterns.status).toBe('ok');
    const excluded = result.cross_business_patterns.data!.excluded_businesses.find((e) => e.business_id === BIZ_POISON);
    expect(excluded).toBeDefined();
    expect(excluded!.reason).toContain(POISON_MESSAGE);
    expect(result.cross_business_patterns.data!.businesses_considered).toContain(BIZ_A);
    expect(result.cross_business_patterns.data!.businesses_considered).toContain(BIZ_B);

    // Every other section, of every business, is untouched by this.
    const a = result.businesses.find((b) => b.business_id === BIZ_A)!;
    const b = result.businesses.find((b) => b.business_id === BIZ_B)!;
    const poison = result.businesses.find((b) => b.business_id === BIZ_POISON)!;
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(poison.decisions.status).toBe('ok');
    expect(poison.work_states.status).toBe('ok');
    expect(poison.connectors.status).toBe('ok');
  });

  test('an unknown business becomes one unavailable row, not a failed request', () => {
    const result = assembleCommandCentre({
      actor: 'dashboard:test', businessIds: [BIZ_A, 'biz_does_not_exist'],
    });
    expect(result.businesses.length).toBe(2);

    const missing = result.businesses.find((b) => b.business_id === 'biz_does_not_exist')!;
    expect(missing.status).toBe('unavailable');
    expect(missing.unavailable_reason).toContain('not available');

    const a = result.businesses.find((b) => b.business_id === BIZ_A)!;
    expect(a.status).toBe('ok');
    expect(a.decisions.data!.total).toBeGreaterThan(0);
  });

  test('totals record what they had to leave out instead of quietly under-reporting', () => {
    const result = assembleCommandCentre({
      actor: 'dashboard:test', businessIds: [BIZ_A, BIZ_POISON, 'biz_does_not_exist'],
    });
    const excluded = result.portfolio_totals.excluded;

    // The poisoned business's ROI is missing from the money totals...
    expect(excluded.some((e) => e.business_id === BIZ_POISON && e.section === 'outcomes')).toBe(true);
    // ...and the unknown business is missing entirely.
    expect(excluded.some((e) => e.business_id === 'biz_does_not_exist' && e.section === 'all')).toBe(true);

    expect(result.portfolio_totals.businesses_ok).toBe(1);
    expect(result.portfolio_totals.businesses_degraded).toBe(1);
    expect(result.portfolio_totals.businesses_unavailable).toBe(1);
  });

  test('a failed section raises an attention item so "broken" is distinguishable from "clean"', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_POISON] });
    const alert = result.attention.find((a) => a.id === `section_failed:${BIZ_POISON}:outcomes`);
    expect(alert).toBeTruthy();
    expect(alert!.detail).toContain('Everything else on this business is real');
  });
});

// ─── 5. Authorization scoping ────────────────────────────────────────────────

describe('authorization scoping', () => {
  test('the accessible set is the basis of the default selection', () => {
    const accessible = listAccessibleBusinessIds('dashboard:test');
    expect(accessible).toContain(BIZ_A);
    expect(accessible).toContain(BIZ_B);

    // Default selection is drawn only from the accessible set — asserted
    // against whatever else the wider suite has created in this DB, which is
    // exactly the condition that matters.
    const result = assembleCommandCentre({ actor: 'dashboard:test' });
    expect(result.businesses.length).toBeGreaterThan(0);
    for (const b of result.businesses) {
      expect(accessible).toContain(b.business_id);
    }
  });

  test('an id outside the accessible set yields no data for that id', () => {
    const result = assembleCommandCentre({
      actor: 'dashboard:test', businessIds: ['biz_not_mine'],
    });
    const row = result.businesses[0]!;
    expect(row.status).toBe('unavailable');
    // Nothing about the business leaks through — every section is empty.
    expect(row.decisions.data).toBeNull();
    expect(row.work_states.data).toBeNull();
    expect(row.verified_changes.data).toBeNull();
    expect(row.outcomes.data).toBeNull();
    expect(row.connectors.data).toBeNull();
  });

  test('an unknown and an inaccessible id are reported identically', () => {
    // Distinguishing them would confirm which ids are real.
    const a = assembleCommandCentre({ actor: 'dashboard:test', businessIds: ['biz_ghost_one'] }).businesses[0]!;
    const b = assembleCommandCentre({ actor: 'dashboard:test', businessIds: ['biz_ghost_two'] }).businesses[0]!;
    expect(a.status).toBe(b.status);
    expect(a.unavailable_reason?.replace('biz_ghost_one', 'X'))
      .toBe(b.unavailable_reason?.replace('biz_ghost_two', 'X'));
  });
});

// ─── Attention ranking & connector rollup ────────────────────────────────────

describe('attention ranking and connector health rollup', () => {
  test('a failing connector is surfaced with its impact and a drill-down link', () => {
    const result = assembleCommandCentre({ actor: 'dashboard:test', businessIds: [BIZ_A] });
    const conn = result.businesses[0]!.connectors.data!;

    const failing = conn.unhealthy.find((c) => c.connector_id === failingConnectorA);
    expect(failing).toBeTruthy();
    expect(failing!.summary).toBeTruthy();
    expect(failing!.evidence.href).toContain(failingConnectorA);
  });

  test('attention is ordered with the items only a human can unblock first', () => {
    const result = assembleCommandCentre({
      actor: 'dashboard:test', businessIds: [BIZ_A, BIZ_B],
    });
    const rank = { critical: 0, high: 1, medium: 2 } as const;
    for (let i = 1; i < result.attention.length; i++) {
      expect(rank[result.attention[i]!.severity])
        .toBeGreaterThanOrEqual(rank[result.attention[i - 1]!.severity]);
    }
  });

  test('attention items name the business they belong to', () => {
    const result = assembleCommandCentre({
      actor: 'dashboard:test', businessIds: [BIZ_A, BIZ_B],
    });
    expect(result.attention.length).toBeGreaterThan(0);
    for (const item of result.attention) {
      expect([BIZ_A, BIZ_B]).toContain(item.business_id);
      expect(item.business_name).toBeTruthy();
      expect(item.evidence.href.startsWith('/')).toBe(true);
    }
  });
});

// ─── Timestamp handling ──────────────────────────────────────────────────────

describe('timestamp normalization', () => {
  test("SQLite's naive UTC format is not parsed as local time", () => {
    // The bug this guards: 'YYYY-MM-DD HH:MM:SS' handed to new Date() is
    // interpreted in the host's zone, shifting every freshness figure.
    expect(timestampMs('2026-08-17 12:00:00')).toBe(Date.UTC(2026, 7, 17, 12, 0, 0));
    expect(timestampMs('2026-08-17T12:00:00.000Z')).toBe(Date.UTC(2026, 7, 17, 12, 0, 0));
    expect(timestampMs(null)).toBeNull();
    expect(timestampMs('not a date')).toBeNull();
  });

  test('newestTimestamp compares the two stored formats correctly', () => {
    // Naive-format value is genuinely newer despite sorting earlier as a string.
    expect(newestTimestamp(['2026-08-17T10:00:00.000Z', '2026-08-17 11:00:00']))
      .toBe('2026-08-17 11:00:00');
    expect(newestTimestamp([null, undefined])).toBeNull();
  });

  test('evidenceLink escapes ids into the drill-down href', () => {
    const link = evidenceLink('receipt', 'rec/1', 'biz a', 'label');
    expect(link.href).toBe('/receipts?business=biz%20a&receipt=rec%2F1');
    expect(link.id).toBe('rec/1');
  });
});
