/**
 * Cross-business pattern detection — server/executive/cross-business-patterns.ts.
 *
 * The properties under test:
 *
 *   1. signal co-occurrence fires for the same rule (or, weaker, the same
 *      category via genuinely different rules) firing in 2+ businesses
 *      within the coincidence window, citing the real signal records.
 *   2. it does NOT fire for unrelated signals, or the same rule firing too
 *      far apart to be a coincidence.
 *   3. metric co-movement fires for a comparable-magnitude, same-direction
 *      move in a genuinely window-bucketed money metric, citing real ROI
 *      evidence, and stays silent below the noise threshold or outside the
 *      magnitude ratio.
 *   4. a business whose ROI report cannot be computed is excluded with a
 *      reason rather than corrupting the result — and a different
 *      business's signal pattern still comes through, because the two
 *      detection mechanisms do not share a failure path.
 *   5. every returned pattern states the non-causation caveat.
 *
 * Failure isolation for the section as a WHOLE (an unexpected throw
 * degrading to a `status: 'failed'` command-centre envelope rather than
 * propagating) is exercised separately in
 * cross-business-patterns.section.test.ts, which needs its own
 * comparability.js mock and would corrupt every test in this file if it
 * lived here.
 */
import { describe, test, expect, beforeAll, afterEach, afterAll, mock } from 'bun:test';

const BIZ_X = 'biz_cbp2_x';
const BIZ_Y = 'biz_cbp2_y';
const BIZ_Z = 'biz_cbp2_z';
const BIZ_POISON = 'biz_cbp2_poison';
const BIZ_HEALTHY = 'biz_cbp2_healthy';
const ALL = [BIZ_X, BIZ_Y, BIZ_Z, BIZ_POISON, BIZ_HEALTHY];

const POISON_MESSAGE = 'Simulated baseline-store failure for the poisoned business (cross-business-patterns fixture).';

// Declared before the modules under test are imported, so they resolve to
// the stub — same technique command-centre.test.ts uses, and for the same
// reason: getBaselines() is the first thing computeROIReport() calls, so
// this makes a REAL dependency fail from inside its own real code path.
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
const { summariseBusiness } = await import('./command-centre.js');
const {
  detectCrossBusinessPatterns, SIGNAL_COINCIDENCE_HOURS, MIN_ABS_PCT_MOVE, MAX_MAGNITUDE_RATIO,
} = await import('./cross-business-patterns.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function insertBusiness(id: string, name: string, slug: string): void {
  db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .run(id, name, slug);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function insertSignal(businessId: string, ruleId: string, type: string, title: string, createdAt: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, data, status, created_at)
    VALUES (?, ?, ?, ?, 'warning', ?, '', '{}', 'open', ?)
  `).run(id, businessId, ruleId, type, title, createdAt);
  return id;
}

function insertRevenueTask(businessId: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, target_metric, created_at, updated_at)
    VALUES (?, ?, 'Fixture revenue task', 'agent:test', 'complete', 'yellow', 'requires_approval', 'shopify.revenue_30d', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId);
  return id;
}

/** A worsened (declining) outcome: metricValue < baselineValue. */
function insertDecline(taskId: string, baselineValue: number, metricValue: number, checkedAt: string): void {
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict)
    VALUES (?, ?, ?, 4, ?, ?, ?, 'worsened')
  `).run(generateId(), taskId, checkedAt, metricValue, baselineValue, ((metricValue - baselineValue) / baselineValue) * 100);
}

const WINDOW_DAYS = 30;
const WINDOW_START = isoDaysAgo(WINDOW_DAYS);
const WINDOW_END = new Date().toISOString();

async function summarise(businessId: string, name: string) {
  return summariseBusiness(businessId, name, WINDOW_START, WINDOW_END, 5);
}

beforeAll(() => {
  for (const [id, name] of [
    [BIZ_X, 'CBP2 X'], [BIZ_Y, 'CBP2 Y'], [BIZ_Z, 'CBP2 Z'],
    [BIZ_POISON, 'CBP2 Poison'], [BIZ_HEALTHY, 'CBP2 Healthy'],
  ] as const) {
    insertBusiness(id, name, id.replace(/_/g, '-'));
  }
});

// Each test seeds its own signals/tasks/outcomes against the shared fixture
// businesses, so state is reset after every test rather than only at the
// end — otherwise a later test's "5% move" would be measured against an
// earlier test's outcomes still sitting on the same business id.
function cleanupBusinessData(): void {
  const placeholders = ALL.map(() => '?').join(',');
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (${placeholders}))`).run(...ALL);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${placeholders})`).run(...ALL);
  db.prepare(`DELETE FROM signals WHERE business_id IN (${placeholders})`).run(...ALL);
}

afterEach(cleanupBusinessData);
afterAll(cleanupBusinessData);

// ─── Signal co-occurrence ────────────────────────────────────────────────────

describe('signal co-occurrence', () => {
  test('flags the same rule firing in two businesses within the coincidence window, citing the real signals', async () => {
    const sigX = insertSignal(BIZ_X, 'traffic_drop_7day', 'traffic_drop', 'Traffic dropped 30% (X)', isoHoursAgo(2));
    const sigY = insertSignal(BIZ_Y, 'traffic_drop_7day', 'traffic_drop', 'Traffic dropped 28% (Y)', isoHoursAgo(1));
    // An unrelated signal in a third business must not join the pattern.
    insertSignal(BIZ_Z, 'ranking_drop_keyword', 'ranking_drop', 'Rankings fell (Z)', isoHoursAgo(1));

    const businesses = [await summarise(BIZ_X, 'CBP2 X'), await summarise(BIZ_Y, 'CBP2 Y'), await summarise(BIZ_Z, 'CBP2 Z')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    const pattern = result.data.patterns.find((p) => p.kind === 'signal_cooccurrence' && p.match_basis === 'traffic_drop_7day');
    expect(pattern).toBeDefined();
    expect(pattern!.businesses.map((b) => b.business_id).sort()).toEqual([BIZ_X, BIZ_Y].sort());
    expect(pattern!.businesses.find((b) => b.business_id === BIZ_X)!.evidence).toEqual(
      expect.objectContaining({ kind: 'signal', id: sigX, business_id: BIZ_X }),
    );
    expect(pattern!.businesses.find((b) => b.business_id === BIZ_Y)!.evidence).toEqual(
      expect.objectContaining({ kind: 'signal', id: sigY, business_id: BIZ_Y }),
    );
    expect(pattern!.caveat).toMatch(/correlation/i);
    expect(pattern!.caveat).toMatch(/not.*causal claim/i);

    // Z's unrelated rule must not appear anywhere in this pattern's evidence.
    expect(pattern!.businesses.some((b) => b.business_id === BIZ_Z)).toBe(false);
  });

  test('does not flag signals with different rule_id and different type', async () => {
    insertSignal(BIZ_X, 'monitor_down', 'uptime_drop', 'Site down (X)', isoHoursAgo(1));
    insertSignal(BIZ_Y, 'gbp_negative_review', 'gbp_review', 'Bad review (Y)', isoHoursAgo(1));

    const businesses = [await summarise(BIZ_X, 'CBP2 X'), await summarise(BIZ_Y, 'CBP2 Y')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    expect(result.data.patterns.some((p) => p.match_basis === 'monitor_down' || p.match_basis === 'gbp_negative_review')).toBe(false);
    expect(result.data.patterns.some((p) => p.match_basis === 'category:uptime_drop' || p.match_basis === 'category:gbp_review')).toBe(false);
  });

  test('does not flag the same rule firing far outside the coincidence window', async () => {
    insertSignal(BIZ_X, 'shopify_no_orders', 'shopify_no_orders', 'No orders (X, recent)', isoHoursAgo(1));
    insertSignal(BIZ_Y, 'shopify_no_orders', 'shopify_no_orders', 'No orders (Y, weeks ago)', isoHoursAgo(SIGNAL_COINCIDENCE_HOURS * 4));

    const businesses = [await summarise(BIZ_X, 'CBP2 X'), await summarise(BIZ_Y, 'CBP2 Y')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    expect(result.data.patterns.some((p) => p.match_basis === 'shopify_no_orders')).toBe(false);
  });

  test('flags a weaker same-category pattern when rule_ids genuinely differ but the type matches', async () => {
    insertSignal(BIZ_X, 'rule_alpha_traffic', 'shared_traffic_category', 'Alpha rule fired (X)', isoHoursAgo(3));
    insertSignal(BIZ_Y, 'rule_beta_traffic', 'shared_traffic_category', 'Beta rule fired (Y)', isoHoursAgo(2));

    const businesses = [await summarise(BIZ_X, 'CBP2 X'), await summarise(BIZ_Y, 'CBP2 Y')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    const pattern = result.data.patterns.find((p) => p.kind === 'signal_cooccurrence' && p.match_basis === 'category:shared_traffic_category');
    expect(pattern).toBeDefined();
    expect(pattern!.businesses.map((b) => b.business_id).sort()).toEqual([BIZ_X, BIZ_Y].sort());
    expect(pattern!.description).toMatch(/different rules/i);
    // Must NOT also be reported as a strong same-rule match — the rules differ.
    expect(result.data.patterns.some((p) => p.match_basis === 'rule_alpha_traffic')).toBe(false);
  });
});

// ─── Metric co-movement ──────────────────────────────────────────────────────

describe('metric co-movement', () => {
  test('flags a comparable-magnitude decline increase across two businesses, citing real ROI evidence', async () => {
    const taskX1 = insertRevenueTask(BIZ_X);
    insertDecline(taskX1, 1000, 900, isoDaysAgo(45)); // prior window: decline = 100
    const taskX2 = insertRevenueTask(BIZ_X);
    insertDecline(taskX2, 1000, 700, isoDaysAgo(10)); // current window: decline = 300 (+200%)

    const taskY1 = insertRevenueTask(BIZ_Y);
    insertDecline(taskY1, 500, 420, isoDaysAgo(50)); // prior window: decline = 80
    const taskY2 = insertRevenueTask(BIZ_Y);
    insertDecline(taskY2, 500, 300, isoDaysAgo(5)); // current window: decline = 200 (+150%)

    const businesses = [await summarise(BIZ_X, 'CBP2 X'), await summarise(BIZ_Y, 'CBP2 Y')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    const pattern = result.data.patterns.find(
      (p) => p.kind === 'metric_comovement' && p.match_basis === 'decline_value_usd_in_window' && p.id.includes(':up:'),
    );
    expect(pattern).toBeDefined();
    expect(pattern!.businesses.map((b) => b.business_id).sort()).toEqual([BIZ_X, BIZ_Y].sort());
    for (const b of pattern!.businesses) {
      expect(b.evidence.kind).toBe('roi_report');
      expect(b.evidence.business_id).toBe(b.business_id);
    }
    expect(pattern!.caveat).toMatch(/correlation/i);
  });

  test('does not flag movement below the noise threshold', async () => {
    const t1 = insertRevenueTask(BIZ_Z);
    insertDecline(t1, 1000, 950, isoDaysAgo(45)); // prior decline = 50
    const t2 = insertRevenueTask(BIZ_Z);
    insertDecline(t2, 1000, 947, isoDaysAgo(10)); // current decline = 53, a ~6% move — below MIN_ABS_PCT_MOVE

    const tX1 = insertRevenueTask(BIZ_X);
    insertDecline(tX1, 1000, 900, isoDaysAgo(45));
    const tX2 = insertRevenueTask(BIZ_X);
    insertDecline(tX2, 1000, 895, isoDaysAgo(10)); // current decline = 105, a ~5% move too

    const businesses = [await summarise(BIZ_Z, 'CBP2 Z'), await summarise(BIZ_X, 'CBP2 X')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    expect(MIN_ABS_PCT_MOVE).toBeGreaterThan(6);
    expect(result.data.patterns.some((p) => p.kind === 'metric_comovement')).toBe(false);
  });

  test('does not flag magnitudes outside the comparable ratio', async () => {
    const taskX1 = insertRevenueTask(BIZ_X);
    insertDecline(taskX1, 1000, 900, isoDaysAgo(45)); // prior decline = 100
    const taskX2 = insertRevenueTask(BIZ_X);
    insertDecline(taskX2, 1000, 500, isoDaysAgo(10)); // current decline = 500 (+400%)

    const taskY1 = insertRevenueTask(BIZ_Y);
    insertDecline(taskY1, 1000, 900, isoDaysAgo(45)); // prior decline = 100
    const taskY2 = insertRevenueTask(BIZ_Y);
    insertDecline(taskY2, 1000, 880, isoDaysAgo(10)); // current decline = 120 (+20%)

    expect(400 / 20).toBeGreaterThan(MAX_MAGNITUDE_RATIO);

    const businesses = [await summarise(BIZ_X, 'CBP2 X'), await summarise(BIZ_Y, 'CBP2 Y')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    expect(result.data.patterns.some(
      (p) => p.kind === 'metric_comovement' && p.match_basis === 'decline_value_usd_in_window' && p.id.includes(':up:'),
    )).toBe(false);
  });

  test('excludes a business whose ROI report throws, with a stated reason, without corrupting the other', async () => {
    const businesses = [await summarise(BIZ_POISON, 'CBP2 Poison'), await summarise(BIZ_HEALTHY, 'CBP2 Healthy')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    expect(result.data.businesses_considered.sort()).toEqual([BIZ_POISON, BIZ_HEALTHY].sort());
    const excluded = result.data.excluded_businesses.find((e) => e.business_id === BIZ_POISON);
    expect(excluded).toBeDefined();
    expect(excluded!.reason).toMatch(/ROI report/i);
    expect(excluded!.reason).toContain(POISON_MESSAGE);
    // The healthy business is not excluded by the poisoned one's failure.
    expect(result.data.excluded_businesses.some((e) => e.business_id === BIZ_HEALTHY)).toBe(false);
  });

  test("a signal pattern still comes through for a business whose ROI report is poisoned", async () => {
    insertSignal(BIZ_POISON, 'monitor_down', 'uptime_drop', 'Site down (Poison)', isoHoursAgo(1));
    insertSignal(BIZ_HEALTHY, 'monitor_down', 'uptime_drop', 'Site down (Healthy)', isoHoursAgo(1));

    const businesses = [await summarise(BIZ_POISON, 'CBP2 Poison'), await summarise(BIZ_HEALTHY, 'CBP2 Healthy')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    const pattern = result.data.patterns.find((p) => p.kind === 'signal_cooccurrence' && p.match_basis === 'monitor_down');
    expect(pattern).toBeDefined();
    expect(pattern!.businesses.map((b) => b.business_id).sort()).toEqual([BIZ_POISON, BIZ_HEALTHY].sort());
    // ...even though the SAME two businesses are excluded from money movement.
    expect(result.data.excluded_businesses.some((e) => e.business_id === BIZ_POISON)).toBe(true);
  });
});

// ─── General honesty ─────────────────────────────────────────────────────────

describe('general', () => {
  test('fewer than two considered businesses runs no detection at all', async () => {
    const businesses = [await summarise(BIZ_X, 'CBP2 X')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });
    expect(result.data.patterns).toEqual([]);
    expect(result.data.businesses_considered).toEqual([BIZ_X]);
    expect(result.data_as_of).toBeNull();
  });

  test('an unavailable business is reported in excluded_businesses and not considered', async () => {
    const FAILED = { status: 'failed' as const, as_of: '', data_as_of: null, error: { message: 'x', code: 'y' }, data: null };
    const ghost = {
      business_id: 'cbp2_ghost', business_name: 'Ghost', status: 'unavailable' as const, failed_sections: [],
      unavailable_reason: 'Business not found.',
      decisions: FAILED, work_states: FAILED, verified_changes: FAILED, outcomes: FAILED, connectors: FAILED,
    };
    const businesses = [await summarise(BIZ_X, 'CBP2 X'), ghost as never];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });

    expect(result.data.businesses_considered).toEqual([BIZ_X]);
    expect(result.data.excluded_businesses).toEqual([{ business_id: 'cbp2_ghost', reason: 'Business not found.' }]);
    // Only one considered business — detection cannot run at all, honestly.
    expect(result.data.patterns).toEqual([]);
  });

  test('every pattern this module can produce states the correlation-not-causation caveat', async () => {
    insertSignal(BIZ_X, 'traffic_drop_7day', 'traffic_drop', 'X', isoHoursAgo(1));
    insertSignal(BIZ_Y, 'traffic_drop_7day', 'traffic_drop', 'Y', isoHoursAgo(1));
    const businesses = [await summarise(BIZ_X, 'CBP2 X'), await summarise(BIZ_Y, 'CBP2 Y')];
    const result = detectCrossBusinessPatterns({
      businesses, window_start: WINDOW_START, window_end: WINDOW_END, window_days: WINDOW_DAYS,
    });
    expect(result.data.patterns.length).toBeGreaterThan(0);
    for (const p of result.data.patterns) {
      expect(p.caveat).toBe(result.data.caveat);
      expect(p.caveat.toLowerCase()).toContain('correlation');
    }
  });
});
