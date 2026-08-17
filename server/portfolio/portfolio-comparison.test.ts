/**
 * Portfolio comparison (#71) — server/portfolio/portfolio-comparison.ts.
 *
 * Four properties carry the issue's acceptance criteria:
 *
 *   1. ISOLATION      one business's data failure degrades its own cells and
 *                     no one else's, and never misattributes a number.
 *   2. HONESTY        figures derived differently across business types are
 *                     marked not_comparable rather than ranked or summed.
 *   3. LABELLING      every aggregate names the businesses inside it, the
 *                     window, the freshness and what is missing.
 *   4. AUTHORIZATION  a business outside the actor's scope contributes
 *                     nothing, and drill-down cannot cross the boundary.
 *
 * Scope is driven through setBusinessScopeResolver(), the real seam a
 * per-user ACL will land on, rather than by mocking a shared module — bun's
 * module mocks are process-global and would leak into #59's suite.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  addPortfolioMembers, createPortfolio, removePortfolioMembers,
  setBusinessScopeResolver, PortfolioError,
} from './portfolio-registry.js';
import {
  comparePortfolio, deriveValuationBasis, readCosts, readGoals, resolveComparability,
  PORTFOLIO_METRICS, type BusinessFacts,
} from './portfolio-comparison.js';
import { getOrCreateBusinessProfile, updateBusinessProfile } from '../business/business-profile.js';

const BIZ_SHOP = 'biz_pf_cmp_shop';
const BIZ_SHOP2 = 'biz_pf_cmp_shop2';
const BIZ_SERVICE = 'biz_pf_cmp_service';
const BIZ_SECRET = 'biz_pf_cmp_secret';
/** In scope for the actor, but with no `businesses` row — an unreadable member. */
const BIZ_GHOST = 'biz_pf_cmp_ghost';
const ALL = [BIZ_SHOP, BIZ_SHOP2, BIZ_SERVICE, BIZ_SECRET, BIZ_GHOST];

let accessible: string[] = [...ALL];

const ACTOR = 'dashboard:owner';
const portfolios: string[] = [];

function makePortfolio(name: string, ids: string[]): string {
  const p = createPortfolio({ name, business_ids: ids, actor: ACTOR });
  portfolios.push(p.id);
  return p.id;
}

function insertGoal(businessId: string, title: string, fields: {
  status?: string; progress?: number | null; deadline?: string | null; achievedAt?: string | null;
} = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO goals (id, business_id, title, status, progress_pct, deadline, achieved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, businessId, title, fields.status ?? 'active',
    fields.progress === undefined ? 50 : fields.progress,
    fields.deadline ?? null, fields.achievedAt ?? null,
  );
  return id;
}

function insertCost(businessId: string, date: string, usd: number, runs = 1): void {
  db.prepare(`
    INSERT INTO cost_daily (id, date, agent_id, business_id, provider, cost_usd, run_count)
    VALUES (?, ?, 'agent_test', ?, 'anthropic', ?, ?)
  `).run(generateId(), date, businessId, usd, runs);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function metric(comparison: Awaited<ReturnType<typeof comparePortfolio>>, key: string) {
  const m = comparison.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`No metric '${key}' in comparison.`);
  return m;
}

function cell(comparison: Awaited<ReturnType<typeof comparePortfolio>>, key: string, businessId: string) {
  const c = metric(comparison, key).cells.find((x) => x.business_id === businessId);
  if (!c) throw new Error(`No cell for '${businessId}' on metric '${key}'.`);
  return c;
}

beforeAll(() => {
  setBusinessScopeResolver((_actor: string) => [...accessible]);
  // BIZ_GHOST is deliberately absent: it is in the actor's scope and can be
  // a portfolio member, but has no `businesses` row, which is what makes it
  // unreadable at compare time.
  const rows: Array<[string, string, string]> = [
    [BIZ_SHOP, 'PF Cmp Shop', 'pf-cmp-shop'],
    [BIZ_SHOP2, 'PF Cmp Shop Two', 'pf-cmp-shop2'],
    [BIZ_SERVICE, 'PF Cmp Service', 'pf-cmp-service'],
    [BIZ_SECRET, 'PF Cmp Secret', 'pf-cmp-secret'],
  ];
  for (const [id, name, slug] of rows) {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, name, slug);
    getOrCreateBusinessProfile(id);
  }
  updateBusinessProfile(BIZ_SHOP, { business_type: 'ecommerce' });
  updateBusinessProfile(BIZ_SHOP2, { business_type: 'ecommerce' });
  updateBusinessProfile(BIZ_SERVICE, { business_type: 'service' });
  updateBusinessProfile(BIZ_SECRET, { business_type: 'ecommerce' });

  // Goals: shop is ahead, service is behind and has one overdue.
  insertGoal(BIZ_SHOP, 'Shop goal A', { progress: 80 });
  insertGoal(BIZ_SHOP, 'Shop goal B', { progress: 60 });
  insertGoal(BIZ_SHOP2, 'Shop2 goal', { progress: 70 });
  insertGoal(BIZ_SERVICE, 'Service goal', { progress: 20, deadline: isoDaysAgo(3) });
  insertGoal(BIZ_SERVICE, 'Service won', { status: 'achieved', progress: 100, achievedAt: isoDaysAgo(2) });

  // Costs inside the window.
  const day = isoDaysAgo(2).slice(0, 10);
  insertCost(BIZ_SHOP, day, 12.5, 4);
  insertCost(BIZ_SHOP2, day, 3.25, 2);
  insertCost(BIZ_SERVICE, day, 7.75, 3);
});

afterAll(() => {
  setBusinessScopeResolver(null);
  accessible = [...ALL];
  for (const id of portfolios) {
    db.prepare('DELETE FROM portfolio_members WHERE portfolio_id = ?').run(id);
    db.prepare('DELETE FROM portfolio_membership_events WHERE portfolio_id = ?').run(id);
    db.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
  }
  for (const id of ALL) {
    db.prepare('DELETE FROM goals WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM cost_daily WHERE business_id = ?').run(id);
  }
});

// ─── Shape and labelling ─────────────────────────────────────────────────────

describe('comparison shape', () => {
  test('produces one row per metric with one cell per business', () => {
    const id = makePortfolio('Cmp Shape', [BIZ_SHOP, BIZ_SHOP2]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    expect(c.metrics.length).toBe(PORTFOLIO_METRICS.length);
    for (const m of c.metrics) {
      expect(m.cells.map((x) => x.business_id).sort()).toEqual([BIZ_SHOP, BIZ_SHOP2].sort());
      // The label and description are the comparison's own contract with the
      // reader — a bare column header would leave the metric ambiguous.
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
    }
    expect(c.portfolio.business_ids.sort()).toEqual([BIZ_SHOP, BIZ_SHOP2].sort());
    expect(c.window_days).toBe(30);
    expect(c.generated_at).toBeTruthy();
  });

  test('every aggregate names its window, its members and its exclusions', () => {
    const id = makePortfolio('Cmp Aggregate', [BIZ_SHOP, BIZ_SHOP2]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR, windowDays: 14 });

    expect(c.window_days).toBe(14);
    expect(new Date(c.window_start).getTime()).toBeLessThan(new Date(c.window_end).getTime());

    const spend = metric(c, 'blueprint_spend_usd');
    expect(spend.aggregate.field.state).toBe('known');
    expect(spend.aggregate.field.value).toBeCloseTo(15.75, 2);
    // The aggregate is auditable: it says exactly who is in it.
    expect(spend.aggregate.included_business_ids.sort()).toEqual([BIZ_SHOP, BIZ_SHOP2].sort());
    expect(spend.aggregate.field.citation).toContain('2 of 2');
  });

  test('a mean is a mean and a sum is a sum — never silently swapped', () => {
    const id = makePortfolio('Cmp Mean', [BIZ_SHOP, BIZ_SHOP2]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    const progress = metric(c, 'goals_average_progress_pct');
    expect(progress.aggregate.kind).toBe('average');
    // Shop averages (80+60)/2 = 70; Shop2 is 70. Mean of the two is 70.
    expect(progress.aggregate.field.value).toBeCloseTo(70, 1);

    expect(metric(c, 'goals_active').aggregate.kind).toBe('sum');
    expect(metric(c, 'goals_active').aggregate.field.value).toBe(3);
  });

  test('metrics that cannot be meaningfully aggregated are not aggregated', () => {
    const id = makePortfolio('Cmp NoAgg', [BIZ_SHOP, BIZ_SHOP2]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    // A portfolio ROI is not the mean of its businesses' ratios, and the
    // oldest pending decision across a portfolio belongs to one business.
    for (const key of ['roi_ratio', 'oldest_pending_hours', 'data_staleness_hours']) {
      expect(metric(c, key).aggregate.field.state).toBe('not_comparable');
      expect(metric(c, key).aggregate.field.value).toBeNull();
      expect(metric(c, key).aggregate.field.reason).toBeTruthy();
    }
  });
});

// ─── Ranking ─────────────────────────────────────────────────────────────────

describe('ranking', () => {
  test('ranks comparable metrics best-first, honouring direction', () => {
    const id = makePortfolio('Cmp Rank', [BIZ_SHOP, BIZ_SHOP2]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    // higher_is_better: Shop 70 vs Shop2 70 — tie, but both ranked.
    const progress = metric(c, 'goals_average_progress_pct');
    expect(progress.ranking).not.toBeNull();
    expect(progress.ranking!.length).toBe(2);

    // lower_is_better: Shop2 spends 3.25, Shop spends 12.50 — Shop2 wins.
    const spend = metric(c, 'blueprint_spend_usd');
    expect(spend.ranking![0]).toBe(BIZ_SHOP2);
    expect(cell(c, 'blueprint_spend_usd', BIZ_SHOP2).rank).toBe(1);
    expect(cell(c, 'blueprint_spend_usd', BIZ_SHOP).rank).toBe(2);
  });

  test('neutral metrics are never ranked — scale is not performance', () => {
    const id = makePortfolio('Cmp Neutral', [BIZ_SHOP, BIZ_SHOP2]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });
    const active = metric(c, 'goals_active');
    expect(active.direction).toBe('neutral');
    expect(active.ranking).toBeNull();
    expect(active.cells.every((x) => x.rank === null)).toBe(true);
  });

  test('an unknown cell is unranked, not ranked last', () => {
    // The ghost business has no readable data at all; it must not appear as
    // "worst" on a metric it simply could not be measured on.
    const id = makePortfolio('Cmp Unranked', [BIZ_SHOP, BIZ_GHOST]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    const spend = metric(c, 'blueprint_spend_usd');
    const ghostCell = spend.cells.find((x) => x.business_id === BIZ_GHOST)!;
    expect(ghostCell.field.state).not.toBe('known');
    expect(ghostCell.rank).toBeNull();
    if (spend.ranking) expect(spend.ranking).not.toContain(BIZ_GHOST);
  });
});

// ─── Failure isolation ───────────────────────────────────────────────────────

describe('failure isolation', () => {
  test('an unreadable business is one unavailable column and nothing else changes', () => {
    const clean = makePortfolio('Cmp Clean', [BIZ_SHOP]);
    const cleanOnly = comparePortfolio({ portfolioId: clean, actor: ACTOR });
    const cleanSpend = cell(cleanOnly, 'blueprint_spend_usd', BIZ_SHOP).field.value;
    const cleanGoals = cell(cleanOnly, 'goals_active', BIZ_SHOP).field.value;
    const cleanProgress = cell(cleanOnly, 'goals_average_progress_pct', BIZ_SHOP).field.value;

    const mixed = makePortfolio('Cmp Mixed', [BIZ_SHOP, BIZ_GHOST]);
    const c = comparePortfolio({ portfolioId: mixed, actor: ACTOR });

    const ghost = c.businesses.find((b) => b.business_id === BIZ_GHOST)!;
    expect(ghost.status).toBe('unavailable');
    expect(ghost.unavailable_reason).toMatch(/no longer exists/i);

    // The healthy business's numbers are exactly what they were when it was
    // compared alone: no blanking, no misattribution, no shifted column.
    expect(cell(c, 'blueprint_spend_usd', BIZ_SHOP).field.value).toBe(cleanSpend);
    expect(cell(c, 'goals_active', BIZ_SHOP).field.value).toBe(cleanGoals);
    expect(cell(c, 'goals_average_progress_pct', BIZ_SHOP).field.value).toBe(cleanProgress);
    expect(c.businesses.find((b) => b.business_id === BIZ_SHOP)!.status).toBe('ok');
    expect(c.coverage.businesses_unavailable).toBe(1);
    expect(c.caveats.some((x) => /could not be loaded/i.test(x))).toBe(true);
  });

  test('a failed section yields "unknown" carrying its reason, never a zero', () => {
    const id = makePortfolio('Cmp NotZero', [BIZ_SHOP, BIZ_GHOST]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    const f = cell(c, 'blueprint_spend_usd', BIZ_GHOST).field;
    // "We could not look" and "there is nothing there" must not render alike:
    // BIZ_SHOP legitimately has 0 overdue goals, the ghost has no value.
    expect(f.value).toBeNull();
    expect(f.state).toBe('unknown');
    expect(f.reason).toBeTruthy();
    expect(cell(c, 'goals_overdue', BIZ_SHOP).field.state).toBe('known');
    expect(cell(c, 'goals_overdue', BIZ_SHOP).field.value).toBe(0);
  });

  test('an aggregate excludes the unreadable business and names the exclusion', () => {
    const id = makePortfolio('Cmp Excluded', [BIZ_SHOP, BIZ_GHOST]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    const spend = metric(c, 'blueprint_spend_usd');
    expect(spend.aggregate.field.state).toBe('known');
    // The total is real, covers only the readable business, and says so.
    expect(spend.aggregate.field.value).toBeCloseTo(12.5, 2);
    expect(spend.aggregate.included_business_ids).toEqual([BIZ_SHOP]);
    expect(spend.aggregate.field.citation).toContain('1 of 2');
    const excl = spend.aggregate.excluded.find((e) => e.business_id === BIZ_GHOST);
    expect(excl).toBeTruthy();
    expect(excl!.reason).toBeTruthy();
  });

  test('a section failure degrades only its own metric, not the business\u2019s others', () => {
    // Unit-level on the extraction primitive, so the assertion is about this
    // module's isolation rather than about whichever upstream engine happens
    // to be easy to break today.
    const MSG = 'Simulated ROI store failure.';
    const okEnv = <T,>(data: T) => ({
      status: 'ok' as const, as_of: new Date().toISOString(),
      data_as_of: new Date().toISOString(), error: null, data,
    });
    const failedEnv = {
      status: 'failed' as const, as_of: new Date().toISOString(), data_as_of: null,
      error: { message: MSG, code: 'outcomes_unavailable' }, data: null,
    };

    const facts = {
      business_id: BIZ_SHOP,
      business_name: 'PF Cmp Shop',
      business_type: 'ecommerce',
      business_type_inferred: false,
      status: 'degraded',
      failed_sections: ['outcomes'],
      unavailable_reason: null,
      valuation_basis: null,
      goals: okEnv({ active: 2, overdue: 0, achieved_in_window: 1, average_progress_pct: 70, worst_goal: null }),
      costs: okEnv({ spend_usd: 12.5, runs: 4, days_with_data: 1 }),
      summary: {
        outcomes: failedEnv,
        decisions: okEnv({ total: 3, lanes: {}, by_risk_tier: { orange: 1, red: 1 }, oldest_pending_hours: 9 }),
        work_states: okEnv({ taxonomy_counts: { outcome_measured: 5 } }),
        verified_changes: okEnv({ verified_count: 2 }),
        connectors: okEnv({ unhealthy: [], freshest_success: null }),
      },
    } as unknown as BusinessFacts;

    const roi = PORTFOLIO_METRICS.find((m) => m.key === 'attributed_value_usd_per_month')!.extract(facts);
    expect(roi.field.state).toBe('unknown');
    expect(roi.field.value).toBeNull();
    expect(roi.field.reason).toContain(MSG);
    // Drill-down survives the failure — it never depended on the number.
    expect(roi.evidence.business_id).toBe(BIZ_SHOP);

    // Every other metric on the SAME business is untouched and real.
    for (const [key, expected] of [
      ['goals_active', 2], ['blueprint_spend_usd', 12.5],
      ['pending_decisions', 3], ['high_risk_decisions', 2],
      ['outcomes_measured', 5], ['verified_changes', 2],
    ] as Array<[string, number]>) {
      const got = PORTFOLIO_METRICS.find((m) => m.key === key)!.extract(facts);
      expect(got.field.state).toBe('known');
      expect(got.field.value).toBe(expected);
    }
  });
});

// ─── Incompatible metric types ───────────────────────────────────────────────

describe('incompatible metric types', () => {
  test('currency outcomes across differing business types are not comparable', () => {
    const id = makePortfolio('Cmp Types', [BIZ_SHOP, BIZ_SERVICE]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    for (const key of ['attributed_value_usd_per_month', 'attributed_decline_usd_per_month', 'roi_ratio']) {
      const m = metric(c, key);
      expect(m.comparability).toBe('not_comparable');
      expect(m.ranking).toBeNull();
      expect(m.aggregate.field.state).toBe('not_comparable');
      // The reason names the actual types in play, not a generic warning.
      expect(m.comparability_reason).toMatch(/ecommerce/);
      expect(m.comparability_reason).toMatch(/service/);
      expect(m.incompatible_groups).toBeTruthy();
      expect(m.incompatible_groups!.length).toBe(2);
    }
    expect(c.coverage.not_comparable_metrics.length).toBeGreaterThanOrEqual(3);
    expect(c.caveats.some((x) => /not ranked or totalled/i.test(x))).toBe(true);
  });

  test('counts stay comparable across business types — a decision is a decision', () => {
    const id = makePortfolio('Cmp Counts', [BIZ_SHOP, BIZ_SERVICE]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    for (const key of ['goals_active', 'goals_overdue', 'pending_decisions', 'unhealthy_connectors', 'blueprint_spend_usd']) {
      expect(metric(c, key).comparability).toBe('comparable');
    }
    // Real comparison still happens: only the service business is overdue.
    expect(cell(c, 'goals_overdue', BIZ_SERVICE).field.value).toBe(1);
    expect(cell(c, 'goals_overdue', BIZ_SHOP).field.value).toBe(0);
    expect(metric(c, 'goals_overdue').ranking![0]).toBe(BIZ_SHOP);
  });

  test('a single-type portfolio compares currency figures normally', () => {
    const id = makePortfolio('Cmp SameType', [BIZ_SHOP, BIZ_SHOP2]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });
    // Both are ecommerce with no divergent valuation basis — nothing to block.
    expect(metric(c, 'attributed_value_usd_per_month').comparability).toBe('comparable');
  });

  test('a measured divergence in valuation basis outranks the type heuristic', () => {
    // Unit-level, because manufacturing two real ROI reports with different
    // estimator paths would test the estimator, not this rule.
    const base = {
      business_type: 'ecommerce' as const,
      business_type_inferred: false,
      status: 'ok' as const,
      failed_sections: [],
      unavailable_reason: null,
      goals: { status: 'ok' as const, as_of: '', data_as_of: null, error: null, data: null },
      costs: { status: 'ok' as const, as_of: '', data_as_of: null, error: null, data: null },
    };
    const measured = { ...base, business_id: 'b1', business_name: 'Shop', valuation_basis: 'measured_revenue' as const };
    const proxied = { ...base, business_id: 'b2', business_name: 'Also Shop', valuation_basis: 'estimated_proxy' as const };

    const money = PORTFOLIO_METRICS.find((m) => m.key === 'attributed_value_usd_per_month')!;
    const verdict = resolveComparability(money, [measured, proxied]);

    // Same business type, so only the basis can have produced this.
    expect(verdict.comparability).toBe('not_comparable');
    expect(verdict.reason).toMatch(/directly observed/i);
    expect(verdict.reason).toMatch(/benchmark coefficients/i);
    expect(verdict.incompatible_groups!.map((g) => g.basis).sort())
      .toEqual(['estimated_proxy', 'measured_revenue']);

    // A count metric over the very same pair stays comparable.
    const count = PORTFOLIO_METRICS.find((m) => m.key === 'pending_decisions')!;
    expect(resolveComparability(count, [measured, proxied]).comparability).toBe('comparable');
  });

  test('a business with no valued outcome has no invented valuation basis', () => {
    expect(deriveValuationBasis(null)).toBeNull();
    expect(deriveValuationBasis({
      outcomes: { status: 'failed', as_of: '', data_as_of: null, error: { message: 'x', code: 'y' }, data: null },
    } as never)).toBeNull();
  });
});

// ─── Membership changes ──────────────────────────────────────────────────────

describe('membership changes', () => {
  test('adding a business adds its column; removing it removes the column', () => {
    const id = makePortfolio('Cmp Membership', [BIZ_SHOP]);
    expect(comparePortfolio({ portfolioId: id, actor: ACTOR }).businesses.map((b) => b.business_id))
      .toEqual([BIZ_SHOP]);

    addPortfolioMembers(id, [BIZ_SHOP2], ACTOR, 'acquired');
    const after = comparePortfolio({ portfolioId: id, actor: ACTOR });
    expect(after.businesses.map((b) => b.business_id).sort()).toEqual([BIZ_SHOP, BIZ_SHOP2].sort());
    expect(metric(after, 'blueprint_spend_usd').aggregate.field.value).toBeCloseTo(15.75, 2);

    removePortfolioMembers(id, [BIZ_SHOP2], ACTOR, 'divested');
    const back = comparePortfolio({ portfolioId: id, actor: ACTOR });
    expect(back.businesses.map((b) => b.business_id)).toEqual([BIZ_SHOP]);
    expect(metric(back, 'blueprint_spend_usd').aggregate.field.value).toBeCloseTo(12.5, 2);
  });

  test('a membership change inside the window is reported as a caveat, not hidden', () => {
    const id = makePortfolio('Cmp Window Change', [BIZ_SHOP]);
    addPortfolioMembers(id, [BIZ_SHOP2], ACTOR, 'joined mid-window');

    const c = comparePortfolio({ portfolioId: id, actor: ACTOR, windowDays: 30 });
    expect(c.membership_changes_in_window.length).toBeGreaterThanOrEqual(2);
    expect(c.caveats.some((x) => /membership changed during this 30-day window/i.test(x))).toBe(true);
    // The caveat spells out the consequence, not just the fact.
    expect(c.caveats.some((x) => /observed for less of the window/i.test(x))).toBe(true);
  });
});

// ─── Authorization and drill-down ────────────────────────────────────────────

describe('authorization', () => {
  test('a business the actor cannot read contributes to nothing, and is counted', () => {
    const id = makePortfolio('Cmp Scoped', [BIZ_SHOP, BIZ_SECRET]);
    const full = comparePortfolio({ portfolioId: id, actor: ACTOR });
    expect(full.businesses.length).toBe(2);

    accessible = ALL.filter((x) => x !== BIZ_SECRET);
    try {
      const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

      expect(c.businesses.map((b) => b.business_id)).toEqual([BIZ_SHOP]);
      expect(c.portfolio.business_ids).not.toContain(BIZ_SECRET);
      expect(c.portfolio.hidden_member_count).toBe(1);

      // No cell, no evidence link, and no aggregate mentions it anywhere.
      for (const m of c.metrics) {
        expect(m.cells.some((x) => x.business_id === BIZ_SECRET)).toBe(false);
        expect(m.aggregate.included_business_ids).not.toContain(BIZ_SECRET);
        expect(m.cells.every((x) => !x.evidence.href.includes(BIZ_SECRET))).toBe(true);
      }
      // But the operator is told their view is partial.
      expect(c.caveats.some((x) => /outside your access/i.test(x))).toBe(true);
    } finally {
      accessible = [...ALL];
    }
  });

  test('a portfolio with nothing readable in it is refused, not shown empty', () => {
    const id = makePortfolio('Cmp AllHidden', [BIZ_SECRET]);
    accessible = ALL.filter((x) => x !== BIZ_SECRET);
    try {
      let caught: unknown;
      try { comparePortfolio({ portfolioId: id, actor: ACTOR }); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(PortfolioError);
      expect((caught as InstanceType<typeof PortfolioError>).status).toBe(403);
    } finally {
      accessible = [...ALL];
    }
  });

  test('every cell drills into its own business, never another’s', () => {
    const id = makePortfolio('Cmp Drilldown', [BIZ_SHOP, BIZ_SERVICE]);
    const c = comparePortfolio({ portfolioId: id, actor: ACTOR });

    for (const m of c.metrics) {
      for (const x of m.cells) {
        // Drill-down exists even when the value does not.
        expect(x.evidence).toBeTruthy();
        expect(x.evidence.business_id).toBe(x.business_id);
        expect(x.evidence.href).toContain(`business=${encodeURIComponent(x.business_id)}`);
        // The link points at a real business-scoped surface.
        expect(x.evidence.href).toMatch(/^\/(goals|roi|receipts|connectors|decision-centre|outcomes|tasks)\?/);
      }
    }
  });

  test('a missing portfolio is a 404, not an empty comparison', () => {
    let caught: unknown;
    try { comparePortfolio({ portfolioId: 'nope_not_here', actor: ACTOR }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(PortfolioError);
    expect((caught as InstanceType<typeof PortfolioError>).status).toBe(404);
  });
});

// ─── Section readers ─────────────────────────────────────────────────────────

describe('section readers', () => {
  test('readGoals separates active, overdue and achieved-in-window', () => {
    const { data } = readGoals(BIZ_SERVICE, isoDaysAgo(30), new Date().toISOString());
    expect(data.active).toBe(1);
    expect(data.overdue).toBe(1);
    expect(data.achieved_in_window).toBe(1);
    expect(data.average_progress_pct).toBe(20);
    expect(data.worst_goal?.title).toBe('Service goal');
  });

  test('readGoals reports no average rather than zero when nothing is measured', () => {
    const { data } = readGoals(BIZ_SECRET, isoDaysAgo(30), new Date().toISOString());
    expect(data.active).toBe(0);
    // Zero progress and no goals must not render the same.
    expect(data.average_progress_pct).toBeNull();
  });

  test('readCosts sums only inside the window and reports its coverage', () => {
    const inWindow = readCosts(BIZ_SHOP, isoDaysAgo(30), new Date().toISOString());
    expect(inWindow.data.spend_usd).toBeCloseTo(12.5, 2);
    expect(inWindow.data.days_with_data).toBe(1);
    expect(inWindow.data.runs).toBe(4);

    // A window that closed before the cost row was written excludes it.
    const before = readCosts(BIZ_SHOP, isoDaysAgo(60), isoDaysAgo(30));
    expect(before.data.spend_usd).toBe(0);
    expect(before.data.days_with_data).toBe(0);
  });
});
