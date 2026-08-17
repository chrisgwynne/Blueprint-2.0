/**
 * Portfolio comparison (issue #71) — businesses side by side, honestly.
 *
 * ─── What this adds that #59 does not ───────────────────────────────────────
 *
 * The executive command centre (#59, server/executive/command-centre.ts) is
 * DECISION-ORIENTED and per-business: it answers "what needs me, across
 * everything I run?" by listing each business's pending decisions, receipts,
 * outcomes and connector health in sequence, then ranking a single attention
 * feed across them.
 *
 * This module is COMPARISON-ORIENTED and per-metric. It answers a different
 * question — "which of these businesses is doing better, on what, and by how
 * much?" — and that question has a shape #59 structurally cannot produce:
 *
 *   #59  one section per business, read down the page. To compare goal
 *        progress across four businesses you read four cards and hold the
 *        numbers in your head.
 *   #71  one row per METRIC, one cell per business, ranked. Comparison is
 *        the layout, not an exercise left to the reader.
 *
 * And it adds the constraint that makes such a layout safe. #59's
 * `portfolio_totals` SUMS `attributed_value_usd_per_month` across every
 * business in the selection. That is correct for its purpose — a total
 * exposure figure — but putting the same numbers in a ranked column is a
 * different claim: that they are the same kind of number. Often they are
 * not. A shop's figure comes from `shopify.revenue_30d`, money that was
 * actually observed; a service business's comes from benchmark coefficients
 * applied to a proxy metric. Both are "$/month". Ranking one against the
 * other is a fabricated result, so this module refuses to, and says why.
 *
 * ─── Reuse, not reimplementation ────────────────────────────────────────────
 *
 * Nothing here recomputes a figure another module owns:
 *
 *   summariseBusiness()   #59  decisions, work ladder, receipts, ROI, health
 *   section()             #59  the per-unit failure-isolation primitive
 *   evidenceLink()        #59  drill-down routes into the owning surface
 *   valuationBasisForMetric() #63 which metrics are money vs derived
 *   ComparableField       #66  the known / unknown / not_comparable envelope
 *
 * Only two new section readers exist, for the two things #59 has no need of:
 * goals (#64's subject matter) and Blueprint spend. Both use #59's section()
 * so they fail exactly like every other section does.
 *
 * ─── Failure isolation ──────────────────────────────────────────────────────
 *
 * Identical to #59's rule, applied one level further out. A business whose
 * ROI report throws contributes `unknown` cells to the ROI rows, carrying
 * the error, and REAL cells to every other row. A business that cannot be
 * read at all becomes an `unavailable` column and leaves every other column
 * untouched. There is no path by which one business's failure changes
 * another's number — cells are keyed by business id throughout, never by
 * position in an array.
 */
import db from '../db/db.js';
import {
  evidenceLink, newestTimestamp, section, summariseBusiness, timestampMs,
  type BusinessSummary, type EvidenceLink, type SectionEnvelope,
} from '../executive/command-centre.js';
import {
  knownField, notComparableField, unknownField, type ComparableField,
} from '../brain/comparison-engine.js';
import { valuationBasisForMetric, type ValuationBasis } from '../roi/value-estimator.js';
import { getBusinessProfile, inferBusinessType } from '../business/business-profile.js';
import {
  accessibleBusinessIds, membershipChangesInWindow, PortfolioError, requirePortfolio,
  type MembershipEvent, type Portfolio,
} from './portfolio-registry.js';
import type { BusinessType } from '../types/business-profile.js';

// ─── The two sections #59 has no need for ────────────────────────────────────

export interface GoalsSection {
  active: number;
  overdue: number;
  achieved_in_window: number;
  /** Mean progress_pct across active goals; null when there are none. */
  average_progress_pct: number | null;
  /** The furthest-behind active goal, for drill-down. */
  worst_goal: { id: string; title: string; progress_pct: number | null } | null;
}

export interface CostsSection {
  /** Blueprint's own spend on this business inside the window, from cost_daily. */
  spend_usd: number;
  runs: number;
  /** Days inside the window that actually have a cost row — the figure's coverage. */
  days_with_data: number;
}

/**
 * Goals for one business over one window.
 *
 * `overdue` is deliberately the only "at risk" notion used: a deadline in
 * the past is an unambiguous fact, whereas "behind schedule" requires a
 * model of expected pace that nothing in this codebase owns. Inventing one
 * here would be exactly the second opinion this module exists to avoid.
 */
export function readGoals(businessId: string, windowStart: string, windowEnd: string): {
  data: GoalsSection; data_as_of: string | null;
} {
  const rows = db.prepare(`
    SELECT id, title, status, progress_pct, deadline, achieved_at, updated_at
      FROM goals WHERE business_id = ?
  `).all(businessId) as Array<{
    id: string; title: string; status: string; progress_pct: number | null;
    deadline: string | null; achieved_at: string | null; updated_at: string;
  }>;

  const now = Date.now();
  const startMs = timestampMs(windowStart) ?? 0;
  const endMs = timestampMs(windowEnd) ?? now;

  const active = rows.filter((g) => g.status === 'active');
  const overdue = active.filter((g) => {
    const d = timestampMs(g.deadline);
    return d != null && d < now;
  });
  const achieved = rows.filter((g) => {
    const a = timestampMs(g.achieved_at);
    return a != null && a >= startMs && a <= endMs;
  });

  const progresses = active
    .map((g) => (typeof g.progress_pct === 'number' && Number.isFinite(g.progress_pct) ? g.progress_pct : null))
    .filter((p): p is number => p != null);

  const worst = [...active]
    .sort((a, b) => (a.progress_pct ?? 0) - (b.progress_pct ?? 0))[0] ?? null;

  return {
    data: {
      active: active.length,
      overdue: overdue.length,
      achieved_in_window: achieved.length,
      average_progress_pct: progresses.length === 0
        ? null
        : Math.round((progresses.reduce((s, p) => s + p, 0) / progresses.length) * 10) / 10,
      worst_goal: worst
        ? { id: worst.id, title: worst.title, progress_pct: worst.progress_pct ?? null }
        : null,
    },
    data_as_of: newestTimestamp(rows.map((g) => g.updated_at)),
  };
}

/**
 * Blueprint's spend on one business inside the window.
 *
 * `cost_daily.date` is a 'YYYY-MM-DD' TEXT column, so the window bounds are
 * compared as dates rather than through timestampMs() — the one place in
 * this module where that is correct rather than a bug.
 */
export function readCosts(businessId: string, windowStart: string, windowEnd: string): {
  data: CostsSection; data_as_of: string | null;
} {
  const from = windowStart.slice(0, 10);
  const to = windowEnd.slice(0, 10);
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS spend,
           COALESCE(SUM(run_count), 0) AS runs,
           COUNT(DISTINCT date)        AS days,
           MAX(date)                   AS latest
      FROM cost_daily
     WHERE business_id = ? AND date >= ? AND date <= ?
  `).get(businessId, from, to) as {
    spend: number; runs: number; days: number; latest: string | null;
  };

  return {
    data: {
      spend_usd: Math.round(Number(row?.spend ?? 0) * 10000) / 10000,
      runs: Number(row?.runs ?? 0),
      days_with_data: Number(row?.days ?? 0),
    },
    data_as_of: row?.latest ? `${row.latest}T00:00:00Z` : null,
  };
}

// ─── Per-business facts ──────────────────────────────────────────────────────

export interface ComparedBusiness {
  business_id: string;
  business_name: string;
  business_type: BusinessType;
  /** true when business_type was inferred rather than confirmed by a human. */
  business_type_inferred: boolean;
  status: 'ok' | 'degraded' | 'unavailable';
  failed_sections: string[];
  unavailable_reason: string | null;
  /**
   * How this business's currency figures were arrived at, derived from the
   * metrics that actually contributed. Null when it has no valued outcome
   * yet — which is different from "estimated", and is not guessed.
   */
  valuation_basis: ValuationBasis | null;
  goals: SectionEnvelope<GoalsSection>;
  costs: SectionEnvelope<CostsSection>;
}

export interface BusinessFacts extends ComparedBusiness {
  summary: BusinessSummary | null;
}

/**
 * Derive a business's valuation basis from the metrics behind its ROI
 * report, not from its type.
 *
 * Type is a proxy for how value is estimated; the metric list is the thing
 * itself. A "service" business that happens to have Stripe MRR connected
 * really does have measured revenue, and would be mislabelled by a
 * type-based rule. Type is used only as the conservative fallback in
 * resolveComparability() when no business has any valued outcome to read.
 *
 * Mixed within a single business resolves to `estimated_proxy`: the total is
 * only as sound as its weakest component.
 */
export function deriveValuationBasis(summary: BusinessSummary | null): ValuationBasis | null {
  const out = summary?.outcomes;
  if (!out || out.status !== 'ok' || !out.data) return null;
  const metrics = out.data.declines.map((d) => d.metric_name).filter((m): m is string => Boolean(m));
  if (metrics.length === 0 && out.data.attributed_value_usd_per_month === 0
      && out.data.attributed_decline_usd_per_month === 0) {
    return null;
  }
  const bases = new Set(metrics.map((m) => valuationBasisForMetric(m)));
  if (bases.size === 0) {
    // Value exists but the contributing metric names are not exposed on the
    // section; fall back to the report's own confidence as the signal.
    return out.data.confidence_level === 'established' ? 'measured_revenue' : 'estimated_proxy';
  }
  return bases.has('estimated_proxy') ? 'estimated_proxy' : 'measured_revenue';
}

function businessTypeOf(businessId: string, fallbackFreeText: string | null): {
  type: BusinessType; inferred: boolean;
} {
  const profile = getBusinessProfile(businessId);
  if (profile?.business_type) {
    const inferredFields = Array.isArray(profile.inferred_fields) ? profile.inferred_fields : [];
    return {
      type: profile.business_type as BusinessType,
      inferred: inferredFields.includes('business_type') || !profile.confirmed_by_human,
    };
  }
  return { type: inferBusinessType(fallbackFreeText), inferred: true };
}

function collectFacts(
  businessId: string, name: string, freeTextType: string | null,
  windowStart: string, windowEnd: string, sampleSize: number,
): BusinessFacts {
  const { type, inferred } = businessTypeOf(businessId, freeTextType);

  let summary: BusinessSummary | null = null;
  let unavailableReason: string | null = null;
  try {
    summary = summariseBusiness(businessId, name, windowStart, windowEnd, sampleSize);
  } catch (err) {
    // summariseBusiness isolates its own sections; reaching here means the
    // business as a whole could not be assembled. Only this column is lost.
    unavailableReason = (err as Error)?.message ?? String(err);
  }

  const goals = section<GoalsSection>('goals_unavailable', () => readGoals(businessId, windowStart, windowEnd));
  const costs = section<CostsSection>('costs_unavailable', () => readCosts(businessId, windowStart, windowEnd));

  const failed = [
    ...(summary?.failed_sections ?? []),
    ...(goals.status === 'failed' ? ['goals'] : []),
    ...(costs.status === 'failed' ? ['costs'] : []),
  ];

  return {
    business_id: businessId,
    business_name: name,
    business_type: type,
    business_type_inferred: inferred,
    status: summary == null ? 'unavailable' : failed.length > 0 ? 'degraded' : 'ok',
    failed_sections: failed,
    unavailable_reason: unavailableReason,
    valuation_basis: deriveValuationBasis(summary),
    goals,
    costs,
    summary,
  };
}

// ─── Metric catalogue ────────────────────────────────────────────────────────

export type MetricGroup = 'goals' | 'costs' | 'outcomes' | 'risk' | 'health';

/**
 * Which way is better. `neutral` metrics are shown but never ranked — a
 * portfolio with more goals is not thereby winning, and an arrow implying
 * it were would be an opinion this module has no basis for.
 */
export type MetricDirection = 'higher_is_better' | 'lower_is_better' | 'neutral';

export type MetricAggregation = 'sum' | 'average' | 'none';

export interface MetricDefinition {
  key: string;
  label: string;
  group: MetricGroup;
  unit: 'count' | 'usd' | 'usd_per_month' | 'percent' | 'hours' | 'ratio';
  direction: MetricDirection;
  aggregation: MetricAggregation;
  /** What this number means, rendered verbatim; never a bare column header. */
  description: string;
  /**
   * True when the figure's meaning depends on HOW it was derived, and so
   * cannot be ranked across businesses whose derivation differs. Currency
   * and ratio outcome metrics are; counts of things are not — a pending
   * decision is a pending decision in any business.
   */
  derivation_sensitive: boolean;
  extract: (f: BusinessFacts) => MetricExtraction;
}

export interface MetricExtraction {
  field: ComparableField<number>;
  /** Where this cell's number comes from. Present even when the value is not. */
  evidence: EvidenceLink;
  /** Freshness of the section behind this cell. */
  data_as_of: string | null;
}

/**
 * Read a number out of a section envelope, preserving the reason when it is
 * absent. A failed section yields `unknown` carrying the section's own
 * error — never a zero, which would read as a measured absence of the thing.
 */
function fromSection<T>(
  env: SectionEnvelope<T> | undefined,
  sectionLabel: string,
  citation: string,
  pick: (data: T) => number | null,
  missingReason: string,
): { field: ComparableField<number>; data_as_of: string | null } {
  if (!env) {
    return {
      field: unknownField<number>(`${sectionLabel} was not loaded for this business.`),
      data_as_of: null,
    };
  }
  if (env.status === 'failed' || !env.data) {
    return {
      field: unknownField<number>(
        `${sectionLabel} could not be loaded: ${env.error?.message ?? 'unknown error'}. `
        + 'Every other figure for this business is real; only this one is missing.',
      ),
      data_as_of: null,
    };
  }
  const value = pick(env.data);
  if (value == null || !Number.isFinite(value)) {
    return { field: unknownField<number>(missingReason), data_as_of: env.data_as_of };
  }
  return { field: knownField<number>(value, citation), data_as_of: env.data_as_of };
}

function metricFrom<T>(
  f: BusinessFacts,
  env: SectionEnvelope<T> | undefined,
  sectionLabel: string,
  citation: string,
  pick: (data: T) => number | null,
  missingReason: string,
  evidence: EvidenceLink,
): MetricExtraction {
  const { field, data_as_of } = fromSection(env, sectionLabel, citation, pick, missingReason);
  return { field, evidence, data_as_of };
}

/**
 * Hours since a business's connectors last succeeded — its data staleness.
 * Null (not zero) when it has no applicable connector, because "never
 * synced" and "synced this second" must not render the same.
 */
function stalenessHours(freshest: string | null): number | null {
  const ms = timestampMs(freshest);
  if (ms == null) return null;
  return Math.max(0, Math.round(((Date.now() - ms) / 3_600_000) * 10) / 10);
}

export const PORTFOLIO_METRICS: MetricDefinition[] = [
  // ─── Goals ────────────────────────────────────────────────────────────────
  {
    key: 'goals_active',
    label: 'Active goals',
    group: 'goals',
    unit: 'count',
    direction: 'neutral',
    aggregation: 'sum',
    description: 'Goals with status "active". More is not better — this is scale, not performance.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.goals, 'Goals', 'goals table (status = active)',
      (d) => d.active, 'This business has no goals recorded.',
      evidenceLink('goal', f.business_id, f.business_id, `Goals for ${f.business_name}`)),
  },
  {
    key: 'goals_average_progress_pct',
    label: 'Mean goal progress',
    group: 'goals',
    unit: 'percent',
    direction: 'higher_is_better',
    aggregation: 'average',
    // A percentage of a target is already normalised to its own goal, which
    // is what makes it comparable between businesses chasing different
    // metrics entirely.
    description: 'Mean progress_pct across active goals. Each goal is a percentage of its own target, so this is comparable between businesses pursuing different metrics.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.goals, 'Goals', 'goals.progress_pct, averaged over active goals',
      (d) => d.average_progress_pct, 'No active goal has a recorded progress figure.',
      evidenceLink('goal', f.business_id, f.business_id, `Goals for ${f.business_name}`)),
  },
  {
    key: 'goals_overdue',
    label: 'Overdue goals',
    group: 'goals',
    unit: 'count',
    direction: 'lower_is_better',
    aggregation: 'sum',
    description: 'Active goals whose deadline has passed. A deadline in the past is a fact, not an estimate of pace.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.goals, 'Goals', 'goals table (status = active, deadline < now)',
      (d) => d.overdue, 'This business has no goals recorded.',
      evidenceLink('goal', f.business_id, f.business_id, `Goals for ${f.business_name}`)),
  },
  {
    key: 'goals_achieved_in_window',
    label: 'Goals achieved in window',
    group: 'goals',
    unit: 'count',
    direction: 'higher_is_better',
    aggregation: 'sum',
    description: 'Goals whose achieved_at falls inside the comparison window.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.goals, 'Goals', 'goals.achieved_at within window',
      (d) => d.achieved_in_window, 'This business has no goals recorded.',
      evidenceLink('goal', f.business_id, f.business_id, `Goals for ${f.business_name}`)),
  },

  // ─── Costs ────────────────────────────────────────────────────────────────
  {
    key: 'blueprint_spend_usd',
    label: 'Blueprint spend',
    group: 'costs',
    unit: 'usd',
    direction: 'lower_is_better',
    aggregation: 'sum',
    // Spend is one of the few figures that IS directly comparable across
    // business types: it is what Blueprint's own providers billed, in one
    // currency, measured the same way everywhere. Nothing is estimated.
    description: 'What Blueprint itself cost to run this business inside the window (cost_daily). Directly measured in one currency, so comparable across every business type.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.costs, 'Costs', 'cost_daily.cost_usd summed over the window',
      (d) => d.spend_usd, 'No cost rows exist for this business in the window.',
      evidenceLink('roi_report', f.business_id, f.business_id, `ROI and cost for ${f.business_name}`)),
  },

  // ─── Outcomes ─────────────────────────────────────────────────────────────
  {
    key: 'outcomes_measured',
    label: 'Outcomes measured',
    group: 'outcomes',
    unit: 'count',
    direction: 'higher_is_better',
    aggregation: 'sum',
    description: 'Tasks #63 labels outcome_measured — a real measurement was taken, whatever its direction. A count of measurements is comparable; their monetary value is not.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.summary?.work_states, 'Work states', "#63 taxonomy count 'outcome_measured'",
      (d) => d.taxonomy_counts.outcome_measured ?? 0, 'No tasks in the window.',
      evidenceLink('roi_report', f.business_id, f.business_id, `Outcomes for ${f.business_name}`)),
  },
  {
    key: 'verified_changes',
    label: 'Independently verified changes',
    group: 'outcomes',
    unit: 'count',
    direction: 'higher_is_better',
    aggregation: 'sum',
    description: 'Receipts (#70) that reached the verified stage — an independent later measurement confirmed the change took effect.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.summary?.verified_changes, 'Verified changes', '#70 receipts with verified_at set',
      (d) => d.verified_count, 'No receipts in the window.',
      evidenceLink('receipt', f.business_id, f.business_id, `Receipts for ${f.business_name}`)),
  },
  {
    key: 'attributed_value_usd_per_month',
    label: 'Attributed value',
    group: 'outcomes',
    unit: 'usd_per_month',
    direction: 'higher_is_better',
    aggregation: 'sum',
    description: 'Monthly value #63 attributes to Blueprint. Derivation-sensitive: for some businesses this is observed revenue, for others a coefficient applied to a proxy metric.',
    derivation_sensitive: true,
    extract: (f) => metricFrom(f, f.summary?.outcomes, 'Outcomes', '#63 ROI report attributed_value_usd_per_month',
      (d) => (d.confidence_level === 'insufficient' ? null : d.attributed_value_usd_per_month),
      'ROI confidence is "insufficient" — no value figure can be honestly quoted for this business yet.',
      evidenceLink('roi_report', f.business_id, f.business_id, `ROI report for ${f.business_name}`)),
  },
  {
    key: 'attributed_decline_usd_per_month',
    label: 'Attributed decline',
    group: 'outcomes',
    unit: 'usd_per_month',
    direction: 'lower_is_better',
    aggregation: 'sum',
    description: 'Monthly value lost, attributed to Blueprint actions. Reported as prominently as the gains, and derivation-sensitive in the same way.',
    derivation_sensitive: true,
    extract: (f) => metricFrom(f, f.summary?.outcomes, 'Outcomes', '#63 ROI report attributed_decline_usd_per_month',
      (d) => (d.confidence_level === 'insufficient' ? null : d.attributed_decline_usd_per_month),
      'ROI confidence is "insufficient" — no decline figure can be honestly quoted for this business yet.',
      evidenceLink('roi_report', f.business_id, f.business_id, `ROI report for ${f.business_name}`)),
  },
  {
    key: 'roi_ratio',
    label: 'ROI ratio',
    group: 'outcomes',
    unit: 'ratio',
    direction: 'higher_is_better',
    // A ratio of sums is not the sum of ratios, and averaging ratios across
    // businesses of different sizes is a classic way to invent a number.
    aggregation: 'none',
    description: 'Attributed value over Blueprint cost, per #63. Never aggregated: a portfolio ROI is not the mean of its businesses’ ratios.',
    derivation_sensitive: true,
    extract: (f) => metricFrom(f, f.summary?.outcomes, 'Outcomes', '#63 ROI report roi_ratio',
      (d) => (d.confidence_level === 'insufficient' ? null : d.roi_ratio),
      'No ROI ratio is available — either cost or attributed value is missing.',
      evidenceLink('roi_report', f.business_id, f.business_id, `ROI report for ${f.business_name}`)),
  },

  // ─── Risk ─────────────────────────────────────────────────────────────────
  {
    key: 'pending_decisions',
    label: 'Pending decisions',
    group: 'risk',
    unit: 'count',
    direction: 'lower_is_better',
    aggregation: 'sum',
    description: 'Items in #61’s decision queue awaiting a human.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.summary?.decisions, 'Decisions', '#61 pending decision queue',
      (d) => d.total, 'The decision queue is empty for this business.',
      evidenceLink('decision', f.business_id, f.business_id, `Decision queue for ${f.business_name}`)),
  },
  {
    key: 'high_risk_decisions',
    label: 'High-risk decisions pending',
    group: 'risk',
    unit: 'count',
    direction: 'lower_is_better',
    aggregation: 'sum',
    description: 'Pending decisions at orange or red approval tier, per the business’s own effective operating policy (#68).',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.summary?.decisions, 'Decisions', '#61 queue, risk tiers orange + red',
      (d) => (d.by_risk_tier.orange ?? 0) + (d.by_risk_tier.red ?? 0),
      'The decision queue is empty for this business.',
      evidenceLink('decision', f.business_id, f.business_id, `Decision queue for ${f.business_name}`)),
  },
  {
    key: 'oldest_pending_hours',
    label: 'Oldest pending decision',
    group: 'risk',
    unit: 'hours',
    direction: 'lower_is_better',
    aggregation: 'none',
    description: 'Age of the longest-waiting item in the queue. Never aggregated: the oldest item across a portfolio belongs to one business, and summing ages is meaningless.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.summary?.decisions, 'Decisions', '#61 queue, oldest created_at',
      (d) => d.oldest_pending_hours, 'Nothing is pending for this business.',
      evidenceLink('decision', f.business_id, f.business_id, `Decision queue for ${f.business_name}`)),
  },

  // ─── Health ───────────────────────────────────────────────────────────────
  {
    key: 'unhealthy_connectors',
    label: 'Unhealthy connectors',
    group: 'health',
    unit: 'count',
    direction: 'lower_is_better',
    aggregation: 'sum',
    description: 'Connectors #65 rates failing, partial, stale or permission-required. Everything derived from them is less trustworthy.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.summary?.connectors, 'Connectors', '#65 connector health states',
      (d) => d.unhealthy.length, 'This business has no connectors.',
      evidenceLink('connector', f.business_id, f.business_id, `Connectors for ${f.business_name}`)),
  },
  {
    key: 'data_staleness_hours',
    label: 'Data staleness',
    group: 'health',
    unit: 'hours',
    direction: 'lower_is_better',
    aggregation: 'none',
    description: 'Hours since this business’s freshest connector sync. Every other figure in its column is at least this old.',
    derivation_sensitive: false,
    extract: (f) => metricFrom(f, f.summary?.connectors, 'Connectors', '#65 newest connector last_success',
      (d) => stalenessHours(d.freshest_success),
      'No connector has ever synced successfully for this business.',
      evidenceLink('connector', f.business_id, f.business_id, `Connectors for ${f.business_name}`)),
  },
];

// ─── Comparability ───────────────────────────────────────────────────────────

export type Comparability = 'comparable' | 'not_comparable';

export interface ComparabilityVerdict {
  comparability: Comparability;
  reason: string | null;
  /**
   * When not comparable, the groups that cannot be put on one scale, so the
   * UI can show WHICH businesses conflict rather than a bare warning.
   */
  incompatible_groups: Array<{ basis: string; business_ids: string[] }> | null;
}

/**
 * Decide whether one metric can be ranked across this set of businesses.
 *
 * Only `derivation_sensitive` metrics can ever fail. Counts are counts
 * everywhere; a pending decision in a shop and a pending decision in an
 * agency are the same object. Currency and ratios are different: the same
 * "$/month" column can hold an observed revenue delta for one business and a
 * benchmark coefficient applied to a proxy metric for another, and ranking
 * those against each other asserts an equivalence that does not exist.
 *
 * Two signals, in order of strength:
 *
 *   1. VALUATION BASIS — measured directly from the metrics that actually
 *      produced each figure (#63's estimator owns which metrics are money).
 *      Divergence here is evidence, not inference, so it decides first.
 *   2. BUSINESS TYPE — the conservative fallback used when too few
 *      businesses have a valued outcome for signal 1 to say anything. A
 *      portfolio spanning an ecommerce and a service business is assumed
 *      not to be comparing like with like until the data shows otherwise.
 *
 * The failure mode this ordering avoids: a portfolio of two shops that both
 * happen to be 'ecommerce' should not be blocked from comparing revenue,
 * and a shop against a consultancy should not be silently blended even when
 * neither has enough data yet to prove they differ.
 */
export function resolveComparability(
  metric: MetricDefinition, businesses: ComparedBusiness[],
): ComparabilityVerdict {
  if (!metric.derivation_sensitive) {
    return { comparability: 'comparable', reason: null, incompatible_groups: null };
  }

  const live = businesses.filter((b) => b.status !== 'unavailable');
  if (live.length < 2) {
    return { comparability: 'comparable', reason: null, incompatible_groups: null };
  }

  // 1. Measured divergence in how the money figure was produced.
  const withBasis = live.filter((b) => b.valuation_basis != null);
  const bases = new Set(withBasis.map((b) => b.valuation_basis!));
  if (bases.size > 1) {
    const groups = Array.from(bases).map((basis) => ({
      basis,
      business_ids: withBasis.filter((b) => b.valuation_basis === basis).map((b) => b.business_id),
    }));
    return {
      comparability: 'not_comparable',
      reason:
        `${metric.label} is derived differently across these businesses. `
        + 'Some figures are money that was directly observed (measured_revenue); others are '
        + 'estimates produced by applying benchmark coefficients to a proxy metric '
        + '(estimated_proxy). Both are expressed in currency, but they are not the same kind of '
        + 'number, so they are shown per business and deliberately not ranked or summed.',
      incompatible_groups: groups,
    };
  }

  // 2. Conservative fallback: differing business types.
  const types = new Set(live.map((b) => b.business_type));
  if (types.size > 1) {
    const groups = Array.from(types).map((t) => ({
      basis: `business_type:${t}`,
      business_ids: live.filter((b) => b.business_type === t).map((b) => b.business_id),
    }));
    return {
      comparability: 'not_comparable',
      reason:
        `${metric.label} depends on how each business's value is estimated, and this portfolio spans `
        + `more than one business type (${Array.from(types).sort().join(', ')}). `
        + 'An ecommerce business’s revenue-based figure and a service business’s lead-based figure '
        + 'are computed from different metric families, so they are shown separately rather than '
        + 'ranked or combined into one total.',
      incompatible_groups: groups,
    };
  }

  return { comparability: 'comparable', reason: null, incompatible_groups: null };
}

// ─── Comparison assembly ─────────────────────────────────────────────────────

export interface MetricCell {
  business_id: string;
  field: ComparableField<number>;
  /** Present on every cell, value or not — drill-down never depends on a number existing. */
  evidence: EvidenceLink;
  data_as_of: string | null;
  /** Rank among businesses with a known value, 1 = best. Null when unranked. */
  rank: number | null;
  /** How this business's figure was derived; set only for derivation-sensitive metrics. */
  valuation_basis: ValuationBasis | null;
}

export interface MetricAggregate {
  /** `not_comparable` here means the number was deliberately not computed. */
  field: ComparableField<number>;
  kind: MetricAggregation;
  /** Exactly which businesses are inside the number above. */
  included_business_ids: string[];
  /** Why each other business is not, one entry per exclusion. */
  excluded: Array<{ business_id: string; reason: string }>;
}

export interface MetricComparison {
  key: string;
  label: string;
  group: MetricGroup;
  unit: MetricDefinition['unit'];
  direction: MetricDirection;
  description: string;
  comparability: Comparability;
  comparability_reason: string | null;
  incompatible_groups: ComparabilityVerdict['incompatible_groups'];
  cells: MetricCell[];
  /** Business ids best-first. Null when the metric is unranked or not comparable. */
  ranking: string[] | null;
  aggregate: MetricAggregate;
  /** Newest source record behind any cell in this row. */
  data_as_of: string | null;
}

export interface PortfolioComparison {
  generated_at: string;
  window_start: string;
  window_end: string;
  window_days: number;
  portfolio: {
    id: string;
    name: string;
    description: string | null;
    /** Members compared here. Excludes anything outside the actor's scope. */
    business_ids: string[];
    hidden_member_count: number;
  };
  businesses: ComparedBusiness[];
  metrics: MetricComparison[];
  /**
   * Membership changes inside the comparison window. A business that joined
   * partway through has not been observed for the same span as the others,
   * and every figure in its column covers less time.
   */
  membership_changes_in_window: MembershipEvent[];
  /** Plain-language caveats an operator must read before acting on the table. */
  caveats: string[];
  coverage: {
    businesses_ok: number;
    businesses_degraded: number;
    businesses_unavailable: number;
    /** Metric rows that could not be ranked or totalled, and why. */
    not_comparable_metrics: Array<{ key: string; reason: string }>;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function roundTo(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/**
 * Rank businesses on one metric, best first.
 *
 * Only cells with a KNOWN value participate. An unknown cell is not last —
 * it is unranked, because "we could not measure this" is not a bad score.
 * Neutral metrics are never ranked at all.
 */
function rankCells(cells: MetricCell[], direction: MetricDirection): string[] | null {
  if (direction === 'neutral') return null;
  const scored = cells.filter((c) => c.field.state === 'known' && c.field.value != null);
  if (scored.length < 2) return null;
  const sorted = [...scored].sort((a, b) => {
    const av = a.field.value!;
    const bv = b.field.value!;
    return direction === 'higher_is_better' ? bv - av : av - bv;
  });
  sorted.forEach((c, i) => { c.rank = i + 1; });
  return sorted.map((c) => c.business_id);
}

/**
 * Total or average one metric row.
 *
 * The aggregate is computed ONLY over cells that actually have a value, and
 * every omission is named. A total that quietly skipped two businesses reads
 * as complete and would be acted on as complete — the same rule #59 applies
 * to its own rollup, enforced here per metric rather than per section.
 */
function aggregateCells(
  metric: MetricDefinition, cells: MetricCell[], verdict: ComparabilityVerdict,
): MetricAggregate {
  const excluded: Array<{ business_id: string; reason: string }> = [];

  if (verdict.comparability === 'not_comparable') {
    return {
      field: notComparableField<number>(
        verdict.reason ?? `${metric.label} cannot be combined across these businesses.`,
      ),
      kind: 'none',
      included_business_ids: [],
      excluded: cells.map((c) => ({
        business_id: c.business_id,
        reason: 'Excluded from any total because this metric is not comparable across this portfolio.',
      })),
    };
  }

  if (metric.aggregation === 'none') {
    return {
      field: notComparableField<number>(
        `${metric.label} is deliberately not aggregated. ${metric.description}`,
      ),
      kind: 'none',
      included_business_ids: [],
      excluded: [],
    };
  }

  const included: string[] = [];
  let total = 0;
  for (const c of cells) {
    if (c.field.state === 'known' && c.field.value != null) {
      included.push(c.business_id);
      total += c.field.value;
    } else {
      excluded.push({
        business_id: c.business_id,
        reason: c.field.reason ?? 'No value available for this business.',
      });
    }
  }

  if (included.length === 0) {
    return {
      field: unknownField<number>(
        `No business in this portfolio has a value for ${metric.label}, so no total exists.`,
      ),
      kind: metric.aggregation,
      included_business_ids: [],
      excluded,
    };
  }

  const value = metric.aggregation === 'average' ? total / included.length : total;
  const citation =
    `${metric.aggregation === 'average' ? 'Mean' : 'Sum'} over ${included.length} of ${cells.length} `
    + `business(es): ${included.join(', ')}.`;

  return {
    field: knownField<number>(roundTo(value, metric.unit === 'count' ? 0 : 2), citation),
    kind: metric.aggregation,
    included_business_ids: included,
    excluded,
  };
}

export interface PortfolioComparisonOptions {
  portfolioId: string;
  actor: string;
  windowDays?: number;
  sampleSize?: number;
  /**
   * An additional narrowing of the actor's scope, intersected with it and
   * never widening it (see ScopeNarrowing in portfolio-registry.ts). Added
   * for #80 so a BAP agent's `business_access` grant is applied while the
   * comparison is COMPUTED rather than filtered off the finished object —
   * ranks, aggregates and caveats are derived from the member set, so a
   * business removed afterwards would still have moved every other
   * business's rank and every total.
   */
  businessScope?: readonly string[];
}

/**
 * Build the comparison for one saved portfolio.
 *
 * The portfolio is resolved through the registry, which has already removed
 * every member outside the actor's scope — so there is no code path here
 * that reads a business the caller may not see, and the count of what was
 * withheld travels with the response rather than being dropped.
 */
export function comparePortfolio(options: PortfolioComparisonOptions): PortfolioComparison {
  const windowDays = Math.min(365, Math.max(1, options.windowDays ?? 30));
  const sampleSize = Math.min(25, Math.max(1, options.sampleSize ?? 5));
  const windowEnd = nowIso();
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const portfolio: Portfolio = requirePortfolio(options.portfolioId, options.actor, {
    scope: options.businessScope,
  });

  // Belt and braces: the registry already scoped membership, but the
  // accessible set is re-read here so a portfolio can never be the thing
  // that widens what a request may see.
  const accessible = new Set(accessibleBusinessIds(options.actor, options.businessScope));
  const memberIds = portfolio.business_ids.filter((id) => accessible.has(id));

  if (memberIds.length === 0) {
    throw new PortfolioError(
      `No business in portfolio '${portfolio.name}' is available in the current scope.`,
      403, 'empty_scope',
    );
  }

  const nameRows = db.prepare(
    `SELECT id, name, type FROM businesses WHERE id IN (${memberIds.map(() => '?').join(',')})`
  ).all(...memberIds) as Array<{ id: string; name: string; type: string | null }>;
  const meta = new Map(nameRows.map((r) => [r.id, r]));

  const facts: BusinessFacts[] = memberIds.map((id) => {
    const row = meta.get(id);
    if (!row) {
      // In the portfolio but no longer a business — a deleted record, not a
      // permission problem. One unavailable column, everything else intact.
      return {
        business_id: id,
        business_name: id,
        business_type: 'other' as BusinessType,
        business_type_inferred: true,
        status: 'unavailable' as const,
        failed_sections: [],
        unavailable_reason: `Business '${id}' no longer exists but is still a member of this portfolio.`,
        valuation_basis: null,
        goals: section<GoalsSection>('business_unavailable', () => { throw new Error('Business not found.'); }),
        costs: section<CostsSection>('business_unavailable', () => { throw new Error('Business not found.'); }),
        summary: null,
      };
    }
    try {
      return collectFacts(id, row.name, row.type ?? null, windowStart, windowEnd, sampleSize);
    } catch (err) {
      return {
        business_id: id,
        business_name: row.name,
        business_type: 'other' as BusinessType,
        business_type_inferred: true,
        status: 'unavailable' as const,
        failed_sections: [],
        unavailable_reason: (err as Error)?.message ?? String(err),
        valuation_basis: null,
        goals: section<GoalsSection>('business_unavailable', () => { throw err as Error; }),
        costs: section<CostsSection>('business_unavailable', () => { throw err as Error; }),
        summary: null,
      };
    }
  });

  const businesses: ComparedBusiness[] = facts.map(({ summary: _summary, ...rest }) => rest);

  const metrics: MetricComparison[] = PORTFOLIO_METRICS.map((metric) => {
    const verdict = resolveComparability(metric, businesses);
    const cells: MetricCell[] = facts.map((f) => {
      // A per-cell try/catch on top of section()'s: an extractor bug must
      // cost one cell, not the whole row, and certainly not another
      // business's number.
      let extraction: MetricExtraction;
      try {
        extraction = metric.extract(f);
      } catch (err) {
        extraction = {
          field: unknownField<number>(
            `${metric.label} could not be read for this business: ${(err as Error)?.message ?? String(err)}`,
          ),
          evidence: evidenceLink('task', f.business_id, f.business_id, f.business_name),
          data_as_of: null,
        };
      }
      return {
        business_id: f.business_id,
        field: extraction.field,
        evidence: extraction.evidence,
        data_as_of: extraction.data_as_of,
        rank: null,
        valuation_basis: metric.derivation_sensitive ? f.valuation_basis : null,
      };
    });

    const ranking = verdict.comparability === 'comparable'
      ? rankCells(cells, metric.direction)
      : null;

    return {
      key: metric.key,
      label: metric.label,
      group: metric.group,
      unit: metric.unit,
      direction: metric.direction,
      description: metric.description,
      comparability: verdict.comparability,
      comparability_reason: verdict.reason,
      incompatible_groups: verdict.incompatible_groups,
      cells,
      ranking,
      aggregate: aggregateCells(metric, cells, verdict),
      data_as_of: newestTimestamp(cells.map((c) => c.data_as_of)),
    };
  });

  const membershipChanges = membershipChangesInWindow(
    portfolio.id, windowStart, windowEnd, options.actor, { scope: options.businessScope },
  );

  return {
    generated_at: nowIso(),
    window_start: windowStart,
    window_end: windowEnd,
    window_days: windowDays,
    portfolio: {
      id: portfolio.id,
      name: portfolio.name,
      description: portfolio.description,
      business_ids: memberIds,
      hidden_member_count: portfolio.hidden_member_count,
    },
    businesses,
    metrics,
    membership_changes_in_window: membershipChanges,
    caveats: buildCaveats(portfolio, businesses, metrics, membershipChanges, windowDays),
    coverage: {
      businesses_ok: businesses.filter((b) => b.status === 'ok').length,
      businesses_degraded: businesses.filter((b) => b.status === 'degraded').length,
      businesses_unavailable: businesses.filter((b) => b.status === 'unavailable').length,
      not_comparable_metrics: metrics
        .filter((m) => m.comparability === 'not_comparable')
        .map((m) => ({ key: m.key, reason: m.comparability_reason ?? '' })),
    },
  };
}

/**
 * The caveats an operator must read before acting on the table.
 *
 * Deliberately plain sentences rather than flags: this is the paragraph that
 * stops a comparison being over-read, and it is the response's job to write
 * it rather than the UI's to infer it.
 */
function buildCaveats(
  portfolio: Portfolio,
  businesses: ComparedBusiness[],
  metrics: MetricComparison[],
  membershipChanges: MembershipEvent[],
  windowDays: number,
): string[] {
  const caveats: string[] = [];

  if (portfolio.hidden_member_count > 0) {
    caveats.push(
      `${portfolio.hidden_member_count} business(es) in this portfolio are outside your access and are `
      + 'excluded from every figure below. This comparison covers part of the portfolio, not all of it.',
    );
  }

  const unavailable = businesses.filter((b) => b.status === 'unavailable');
  if (unavailable.length > 0) {
    caveats.push(
      `${unavailable.length} business(es) could not be loaded (${unavailable.map((b) => b.business_name).join(', ')}). `
      + 'Their columns are empty; no other business’s figures were affected.',
    );
  }

  const degraded = businesses.filter((b) => b.status === 'degraded');
  if (degraded.length > 0) {
    caveats.push(
      `${degraded.length} business(es) are missing at least one section `
      + `(${degraded.map((b) => `${b.business_name}: ${b.failed_sections.join(', ')}`).join('; ')}). `
      + 'Affected cells read "unknown" rather than zero.',
    );
  }

  if (membershipChanges.length > 0) {
    const joined = membershipChanges.filter((m) => m.action === 'added');
    const left = membershipChanges.filter((m) => m.action === 'removed');
    caveats.push(
      `Portfolio membership changed during this ${windowDays}-day window `
      + `(${joined.length} added, ${left.length} removed). `
      + 'Businesses that joined partway through have been observed for less of the window than the '
      + 'others, so their totals cover a shorter span and are not like-for-like.',
    );
  }

  const notComparable = metrics.filter((m) => m.comparability === 'not_comparable');
  if (notComparable.length > 0) {
    caveats.push(
      `${notComparable.length} metric(s) are shown per business but not ranked or totalled `
      + `(${notComparable.map((m) => m.label).join(', ')}), because they are derived differently `
      + 'across these business types. Each row states why.',
    );
  }

  const inferredTypes = businesses.filter((b) => b.business_type_inferred && b.status !== 'unavailable');
  if (inferredTypes.length > 0 && notComparable.length > 0) {
    caveats.push(
      `Business type is inferred rather than human-confirmed for ${inferredTypes.length} business(es) `
      + `(${inferredTypes.map((b) => b.business_name).join(', ')}). Confirming it in the business profile `
      + 'will make the comparability judgements above more precise.',
    );
  }

  const stale = metrics.find((m) => m.key === 'data_staleness_hours');
  const worst = stale?.cells
    .filter((c) => c.field.state === 'known' && c.field.value != null)
    .sort((a, b) => (b.field.value ?? 0) - (a.field.value ?? 0))[0];
  if (worst && (worst.field.value ?? 0) > 48) {
    const name = businesses.find((b) => b.business_id === worst.business_id)?.business_name ?? worst.business_id;
    caveats.push(
      `${name}’s freshest connector sync is ${Math.round(worst.field.value ?? 0)} hours old, so every `
      + 'figure in its column is at least that stale.',
    );
  }

  return caveats;
}
