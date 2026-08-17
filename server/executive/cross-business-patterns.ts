/**
 * Executive — cross-business pattern detection.
 *
 * The Executive Command Centre (server/executive/command-centre.ts) and the
 * Multi-Business Portfolio View (server/portfolio/portfolio-comparison.ts)
 * are both operator-driven: you ask "show me A, B and C side by side" or
 * "summarise my businesses". Neither one notices on its own when two or
 * more businesses show a correlated pattern — "the same signal fired in two
 * shops this week", "verified changes dropped by a similar amount in three
 * businesses at once". A single-business tool cannot produce this kind of
 * observation structurally; it only exists at the portfolio level, and
 * nothing in Blueprint surfaces it automatically. This module does.
 *
 * ─── What it looks for ───────────────────────────────────────────────────────
 *
 *   1. SIGNAL CO-OCCURRENCE. The same signals.rule_id firing in 2+
 *      businesses within a short coincidence window (default 48h — roughly
 *      the longest per-rule cool-down in signal-engine.ts, so this catches
 *      genuinely near-simultaneous firings, not "both had this warning
 *      sometime this month"). A weaker secondary pass looks for the same
 *      signals.type (category) fired by GENUINELY DIFFERENT rule_ids across
 *      businesses — e.g. two different traffic-drop rules on two different
 *      connectors — which the strict rule_id pass would miss.
 *
 *   2. METRIC CO-MOVEMENT. A metric moving in the same direction by a
 *      comparable magnitude across 2+ businesses, comparing the current
 *      command-centre window against the equal-length window before it.
 *      "Comparable magnitude" is a plain ratio check (the largest %-move in
 *      a direction-group is at most MAX_MAGNITUDE_RATIO times the smallest),
 *      not a statistical test — this module deliberately stays a
 *      straightforward, honest detector rather than a correlation engine.
 *
 *      Only two metrics qualify, and the reason narrows the field a lot:
 *      almost nothing in a BusinessSummary is reconstructable for a past
 *      window the way "movement" needs. `decisions.total` and
 *      `connectors.unhealthy` are the CURRENT queue / CURRENT health state
 *      — Blueprint does not store what the queue looked like 30 days ago.
 *      Less obviously, `verified_changes.verified_count`
 *      (collectReceiptsSince) and #63's `outcome_measured` taxonomy count
 *      (buildWorkLadder) both filter with `>= windowStart` and NO upper
 *      bound at all — they answer "how many since X", not "how many
 *      between X and Y". Comparing two "since X" reads taken back-to-back
 *      is not a fair two-point comparison: the earlier cutoff is
 *      mechanically guaranteed to include everything the later one does
 *      PLUS whatever happened in between, so "movement" would almost
 *      always read as a manufactured decrease, in every business at once,
 *      regardless of anything actually correlated. Rather than build a
 *      pattern detector on top of a bias like that, this module only uses
 *      metrics it can genuinely bucket on BOTH ends: it reads
 *      `computeROIReport()`'s raw `attributed_improvements` /
 *      `attributed_declines` items directly (each carries its own
 *      `checked_at`) and sums `estimated_monthly_usd` — a real per-item
 *      figure #63's estimator already produced — into the current and
 *      prior window itself, with both a start AND an end. That is reuse of
 *      the real valuation, not a second opinion about it; only the
 *      bucketing by date is new, and it is symmetric on purpose.
 *
 * ─── Reuse, not reimplementation ────────────────────────────────────────────
 *
 *   computeROIReport()       #63  called once per business for its raw,
 *                                 already-valued `attributed_improvements` /
 *                                 `attributed_declines` — this module buckets
 *                                 those items by date, it does not revalue
 *                                 anything.
 *   section()/evidenceLink() #59  the same failure-isolation and drill-down
 *                                 primitives every other section uses; the
 *                                 CURRENT-window `businesses` themselves are
 *                                 also #59's own summariseBusiness() output,
 *                                 passed in by assembleCommandCentre() rather
 *                                 than recomputed here.
 *   resolveComparability()   #71  (moved to server/portfolio/comparability.ts
 *                                 specifically so this module could reuse it
 *                                 without command-centre.ts depending on
 *                                 portfolio-comparison.ts — see that file's
 *                                 docstring). A derivation-sensitive metric
 *                                 is skipped for co-movement entirely when
 *                                 this says `not_comparable`, exactly as
 *                                 #71 skips it for ranking.
 *
 * ─── Not a causal claim ──────────────────────────────────────────────────────
 *
 * Every pattern returned carries a `caveat` stating plainly that this is a
 * correlation, not a shared cause: Blueprint has not checked whether these
 * businesses' events are actually related, only that they co-occurred. This
 * matches the honesty philosophy #63's outcome taxonomy and #71's
 * `not_comparable` cells already enforce — never assert more than the
 * evidence supports.
 *
 * ─── Failure isolation ──────────────────────────────────────────────────────
 *
 * `detectCrossBusinessPatterns()` never throws for one business's data
 * problem: a business whose ROI report cannot be computed is recorded in
 * `excluded_businesses` with a reason and simply left out of metric
 * co-movement (signal co-occurrence does not depend on it at all, so it is
 * unaffected). The caller (assembleCommandCentre) additionally wraps
 * the whole call in `section()`, so an entirely unexpected throw here
 * degrades to a `status: 'failed'` envelope on this one section and leaves
 * every other command-centre section untouched.
 *
 * ─── Zero side effects ───────────────────────────────────────────────────────
 *
 * Read-only throughout. No table is written, no signal is created or
 * mutated, no `cross_business_patterns` row (that table belongs to
 * server/brain/cross-business-patterns.ts — see below) is touched. Every
 * `CrossBusinessPattern.id` here is synthesised from the evidence it cites,
 * not a database primary key, because nothing is ever persisted.
 *
 * ─── Not the other "cross-business patterns" module ─────────────────────────
 *
 * server/brain/cross-business-patterns.ts (Phase 3) is a different thing
 * with a deliberately similar name: it aggregates `task_outcomes` across
 * every business into abstract, ANONYMISED success-rate patterns for agent
 * learning — its `cross_business_patterns` table has structurally no
 * business_id, business name or any tenant-identifying column at all (see
 * that file's docstring). This module is the opposite kind of surface: it
 * names the specific businesses and cites the specific signal/metric records
 * involved, for a human deciding what to look at, and writes nothing.
 */
import db from '../db/db.js';
import { computeROIReport } from '../roi/attribution-engine.js';
import {
  evidenceLink, newestTimestamp, timestampMs,
  type BusinessSummary, type EvidenceLink,
} from './command-centre.js';
import {
  businessTypeOf, deriveValuationBasis, resolveComparability,
  type ComparabilityBusiness,
} from '../portfolio/comparability.js';
import type { ValuationBasis } from '../roi/value-estimator.js';
import type { BusinessType } from '../types/business-profile.js';

const CAUSATION_CAVEAT =
  'This is a correlation across businesses, not a causal claim. Blueprint has not determined '
  + 'that these businesses share a root cause, and did not check whether they do — treat it as '
  + 'something worth a human looking at, not a diagnosis.';

/** Roughly the longest per-rule cool-down in signal-engine.ts. */
export const SIGNAL_COINCIDENCE_HOURS = 48;

/** Movements smaller than this are treated as noise, not a "move" worth flagging. */
export const MIN_ABS_PCT_MOVE = 10;

/** The largest %-move in a direction-group must be within this multiple of the smallest. */
export const MAX_MAGNITUDE_RATIO = 3;

// ─── Result shape ─────────────────────────────────────────────────────────────

export type CrossBusinessPatternKind = 'signal_cooccurrence' | 'metric_comovement';

export interface CrossBusinessPatternBusinessEvidence {
  business_id: string;
  business_name: string;
  /** Plain-language rendering of this business's contribution to the pattern. */
  detail: string;
  occurred_at: string | null;
  evidence: EvidenceLink;
}

export interface CrossBusinessPattern {
  /**
   * Deterministic, derived from the cited evidence — NOT a database row id.
   * Nothing here is persisted, so there is no primary key to return.
   */
  id: string;
  kind: CrossBusinessPatternKind;
  /** 'same_rule' / 'category:<type>' for a signal pattern, the metric key for a metric pattern. */
  match_basis: string;
  description: string;
  businesses: CrossBusinessPatternBusinessEvidence[];
  window_start: string;
  window_end: string;
  caveat: string;
}

export interface CrossBusinessPatternsSection {
  /** Businesses actually evaluated (excludes unavailable ones — see excluded_businesses). */
  businesses_considered: string[];
  /** Businesses that could not be evaluated, and why — never silently dropped. */
  excluded_businesses: Array<{ business_id: string; reason: string }>;
  patterns: CrossBusinessPattern[];
  caveat: string;
}

// ─── Signal co-occurrence ────────────────────────────────────────────────────

interface SignalRow {
  id: string;
  business_id: string;
  rule_id: string;
  type: string;
  severity: string;
  title: string;
  created_at: string;
}

function fetchSignalsInWindow(businessIds: string[], windowStart: string, windowEnd: string): SignalRow[] {
  if (businessIds.length === 0) return [];
  const placeholders = businessIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, business_id, rule_id, type, severity, title, created_at
      FROM signals
     WHERE business_id IN (${placeholders})
       AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)
     ORDER BY created_at ASC
  `).all(...businessIds, windowStart, windowEnd) as SignalRow[];
}

/** For each grouping key, the earliest signal per business — the representative firing. */
function earliestPerBusiness(rows: SignalRow[], keyOf: (r: SignalRow) => string): Map<string, Map<string, SignalRow>> {
  const groups = new Map<string, Map<string, SignalRow>>();
  for (const r of rows) {
    const key = keyOf(r);
    let byBiz = groups.get(key);
    if (!byBiz) { byBiz = new Map(); groups.set(key, byBiz); }
    const existing = byBiz.get(r.business_id);
    const rMs = timestampMs(r.created_at) ?? Infinity;
    const existingMs = existing ? (timestampMs(existing.created_at) ?? Infinity) : Infinity;
    if (!existing || rMs < existingMs) byBiz.set(r.business_id, r);
  }
  return groups;
}

function withinCoincidenceWindow(rows: SignalRow[], hours: number): boolean {
  const times = rows.map((r) => timestampMs(r.created_at)).filter((t): t is number => t != null);
  if (times.length < 2) return false;
  return Math.max(...times) - Math.min(...times) <= hours * 3_600_000;
}

function buildSignalPattern(
  basisKind: 'same_rule' | 'same_category', basisValue: string, reps: SignalRow[],
  names: Map<string, string>, windowStart: string, windowEnd: string, coincidenceHours: number,
): CrossBusinessPattern {
  const sorted = [...reps].sort((a, b) => a.business_id.localeCompare(b.business_id));
  const businesses: CrossBusinessPatternBusinessEvidence[] = sorted.map((r) => ({
    business_id: r.business_id,
    business_name: names.get(r.business_id) ?? r.business_id,
    detail: `"${r.title}" (severity: ${r.severity})`,
    occurred_at: r.created_at,
    evidence: evidenceLink('signal', r.id, r.business_id, r.title),
  }));
  const bizNames = businesses.map((b) => b.business_name).join(', ');
  const description = basisKind === 'same_rule'
    ? `The same signal rule ('${basisValue}') fired in ${businesses.length} businesses within `
      + `${coincidenceHours}h of each other: ${bizNames}.`
    : `Signals of the same kind ('${basisValue}') fired in ${businesses.length} businesses within `
      + `${coincidenceHours}h of each other, via different rules `
      + `(${[...new Set(sorted.map((r) => r.rule_id))].join(', ')}): ${bizNames}.`;
  return {
    id: `signal:${basisKind}:${basisValue}:${sorted.map((r) => r.id).join(',')}`,
    kind: 'signal_cooccurrence',
    match_basis: basisKind === 'same_rule' ? basisValue : `category:${basisValue}`,
    description,
    businesses,
    window_start: windowStart,
    window_end: windowEnd,
    caveat: CAUSATION_CAVEAT,
  };
}

function detectSignalCooccurrences(
  businessIds: string[], names: Map<string, string>, windowStart: string, windowEnd: string,
  coincidenceHours: number,
): CrossBusinessPattern[] {
  const rows = fetchSignalsInWindow(businessIds, windowStart, windowEnd);
  const patterns: CrossBusinessPattern[] = [];

  // Strong match: the identical rule fired in 2+ businesses.
  const byRule = earliestPerBusiness(rows, (r) => r.rule_id);
  for (const [ruleId, byBiz] of byRule) {
    if (byBiz.size < 2) continue;
    const reps = Array.from(byBiz.values());
    if (!withinCoincidenceWindow(reps, coincidenceHours)) continue;
    patterns.push(buildSignalPattern('same_rule', ruleId, reps, names, windowStart, windowEnd, coincidenceHours));
  }

  // Weaker match: same category, but genuinely different rules — otherwise
  // this would just duplicate every pattern the strict pass already found.
  const byType = earliestPerBusiness(rows, (r) => r.type);
  for (const [type, byBiz] of byType) {
    if (byBiz.size < 2) continue;
    const reps = Array.from(byBiz.values());
    if (new Set(reps.map((r) => r.rule_id)).size < 2) continue;
    if (!withinCoincidenceWindow(reps, coincidenceHours)) continue;
    patterns.push(buildSignalPattern('same_category', type, reps, names, windowStart, windowEnd, coincidenceHours));
  }

  return patterns;
}

// ─── Metric co-movement ──────────────────────────────────────────────────────

/** Static metadata for the metric keys detectMetricComovements() groups on. */
const METRIC_META: Record<string, { label: string; derivation_sensitive: boolean }> = {
  value_gain_usd_in_window: { label: 'Newly attributed value', derivation_sensitive: true },
  decline_value_usd_in_window: { label: 'Newly attributed decline', derivation_sensitive: true },
};

interface MetricSeriesPoint {
  key: string;
  current: number | null;
  prior: number | null;
  evidence: EvidenceLink;
  data_as_of: string | null;
}

interface MovementContext {
  business_id: string;
  business_name: string;
  status: 'ok' | 'degraded' | 'unavailable';
  business_type: BusinessType;
  valuation_basis: ValuationBasis | null;
  series: MetricSeriesPoint[];
}

interface RoiAttributionItem {
  metric_name: string | null;
  estimated_monthly_usd: number | null;
  checked_at: string | null;
}

/**
 * Sum estimated_monthly_usd for the items whose checked_at falls in
 * [start, end]. `takeAbs` matches #63's own sign convention for its
 * `attributed_decline_usd_per_month` aggregate — declines are summed as a
 * positive magnitude of loss, per item, before summing (not after, which
 * could let mixed-sign items cancel out); gains are summed as-is.
 */
function sumInWindow(items: RoiAttributionItem[], start: string, end: string, takeAbs: boolean): number {
  const startMs = timestampMs(start) ?? -Infinity;
  const endMs = timestampMs(end) ?? Infinity;
  let total = 0;
  for (const item of items) {
    const ms = timestampMs(item.checked_at);
    if (ms == null || ms < startMs || ms > endMs) continue;
    if (typeof item.estimated_monthly_usd === 'number' && Number.isFinite(item.estimated_monthly_usd)) {
      total += takeAbs ? Math.abs(item.estimated_monthly_usd) : item.estimated_monthly_usd;
    }
  }
  return Math.round(total * 100) / 100;
}

function newestChecked(items: RoiAttributionItem[], sinceMs: number): string | null {
  return newestTimestamp(
    items.filter((i) => (timestampMs(i.checked_at) ?? -Infinity) >= sinceMs).map((i) => i.checked_at),
  );
}

/**
 * Build the per-business facts co-movement needs: one raw ROI report per
 * business (via computeROIReport(), the same #63 function
 * command-centre.ts's outcomes section already calls — this reads MORE of
 * its return value, the item-level `attributed_improvements` /
 * `attributed_declines`, which BusinessSummary does not expose because its
 * own `declines` list is truncated to `sample_size` and unfiltered by date).
 *
 * A business whose ROI report cannot be computed is excluded with a reason,
 * not silently dropped — everything else about it is real; only the
 * money-movement comparison is missing. computeROIReport() calls
 * getBaselines() first, exactly like the outcomes section, so a poisoned
 * baseline store fails this the same honest way it fails that section.
 */
function buildMovementContexts(
  businesses: BusinessSummary[], windowStart: string, windowEnd: string,
  priorWindowStart: string, priorWindowEnd: string,
  freeTextTypeById: Map<string, string | null>,
): { contexts: MovementContext[]; excluded: Array<{ business_id: string; reason: string }> } {
  const contexts: MovementContext[] = [];
  const excluded: Array<{ business_id: string; reason: string }> = [];
  const priorWindowStartMs = timestampMs(priorWindowStart) ?? -Infinity;

  for (const b of businesses) {
    const { type } = businessTypeOf(b.business_id, freeTextTypeById.get(b.business_id) ?? null);
    try {
      // No period options: #63's own outcome query is not period-filtered
      // regardless of what is passed, so the report is the same all-time
      // shape the outcomes section already reads — only the item-level
      // `checked_at` dates let this module bucket it by window itself.
      const report = computeROIReport(b.business_id) as Record<string, unknown> | null;
      const gains = ((report?.attributed_improvements as RoiAttributionItem[] | undefined) ?? []);
      const declines = ((report?.attributed_declines as RoiAttributionItem[] | undefined) ?? []);

      const valuationBasis = report ? deriveValuationBasis({
        outcomes: {
          status: 'ok',
          data: {
            declines: declines.map((d) => ({ metric_name: d.metric_name })),
            attributed_value_usd_per_month: Number(report.attributed_value_usd_per_month ?? 0),
            attributed_decline_usd_per_month: Number(report.attributed_decline_usd_per_month ?? 0),
            confidence_level: String(report.confidence_level ?? ''),
          },
        },
      }) : null;

      const series: MetricSeriesPoint[] = [
        {
          key: 'value_gain_usd_in_window',
          current: sumInWindow(gains, windowStart, windowEnd, false),
          prior: sumInWindow(gains, priorWindowStart, priorWindowEnd, false),
          evidence: evidenceLink('roi_report', b.business_id, b.business_id, `ROI report for ${b.business_name}`),
          data_as_of: newestChecked(gains, priorWindowStartMs),
        },
        {
          key: 'decline_value_usd_in_window',
          current: sumInWindow(declines, windowStart, windowEnd, true),
          prior: sumInWindow(declines, priorWindowStart, priorWindowEnd, true),
          evidence: evidenceLink('roi_report', b.business_id, b.business_id, `ROI report for ${b.business_name}`),
          data_as_of: newestChecked(declines, priorWindowStartMs),
        },
      ];

      contexts.push({
        business_id: b.business_id, business_name: b.business_name, status: b.status,
        business_type: type, valuation_basis: valuationBasis, series,
      });
    } catch (err) {
      excluded.push({
        business_id: b.business_id,
        reason: `Could not compute an ROI report for this business: ${(err as Error)?.message ?? String(err)}. `
          + 'Its other command-centre figures are real; only the money-movement comparison is missing.',
      });
    }
  }
  return { contexts, excluded };
}

function detectMetricComovements(contexts: MovementContext[], windowStart: string, windowEnd: string): CrossBusinessPattern[] {
  if (contexts.length < 2) return [];
  const patterns: CrossBusinessPattern[] = [];

  const comparabilityBusinesses: ComparabilityBusiness[] = contexts.map((c) => ({
    business_id: c.business_id, status: c.status, valuation_basis: c.valuation_basis, business_type: c.business_type,
  }));

  for (const [key, meta] of Object.entries(METRIC_META)) {
    const verdict = resolveComparability(
      { label: meta.label, derivation_sensitive: meta.derivation_sensitive },
      comparabilityBusinesses,
    );
    // Exactly #71's rule: a metric whose derivation differs across these
    // businesses (measured revenue vs a benchmark proxy, or a business-type
    // split) is not compared, here any more than it is ranked there.
    if (verdict.comparability !== 'comparable') continue;

    type Movement = { ctx: MovementContext; pctChange: number; current: number; prior: number; point: MetricSeriesPoint };
    const movements: Movement[] = [];
    for (const ctx of contexts) {
      const point = ctx.series.find((s) => s.key === key);
      if (!point || point.current == null || point.prior == null || point.prior === 0) continue;
      const pctChange = ((point.current - point.prior) / Math.abs(point.prior)) * 100;
      if (Math.abs(pctChange) < MIN_ABS_PCT_MOVE) continue;
      movements.push({ ctx, pctChange, current: point.current, prior: point.prior, point });
    }

    for (const direction of ['up', 'down'] as const) {
      const group = movements.filter((m) => (direction === 'up' ? m.pctChange > 0 : m.pctChange < 0));
      if (group.length < 2) continue;

      const magnitudes = group.map((m) => Math.abs(m.pctChange));
      const minAbs = Math.min(...magnitudes);
      const maxAbs = Math.max(...magnitudes);
      // A straightforward ratio check, not a statistical test — if the
      // moves are not within a MAX_MAGNITUDE_RATIO range of each other,
      // this module does not try to find a sub-cluster within the group; a
      // plain yes/no beats an opaque split.
      if (minAbs === 0 || maxAbs / minAbs > MAX_MAGNITUDE_RATIO) continue;

      const sorted = [...group].sort((a, b) => a.ctx.business_id.localeCompare(b.ctx.business_id));
      const businesses: CrossBusinessPatternBusinessEvidence[] = sorted.map((m) => ({
        business_id: m.ctx.business_id,
        business_name: m.ctx.business_name,
        detail: `${meta.label}: ${m.prior} → ${m.current} (${m.pctChange > 0 ? '+' : ''}${m.pctChange.toFixed(1)}%)`,
        occurred_at: m.point.data_as_of,
        evidence: m.point.evidence,
      }));
      const bizNames = businesses.map((b) => b.business_name).join(', ');
      const verb = direction === 'up' ? 'increased' : 'decreased';
      const description =
        `${meta.label} ${verb} by a comparable magnitude across ${businesses.length} businesses: `
        + `${bizNames} (${minAbs.toFixed(1)}%–${maxAbs.toFixed(1)}% change, comparing the current window `
        + 'to the equal-length window before it).';

      patterns.push({
        id: `metric:${key}:${direction}:${sorted.map((m) => m.ctx.business_id).join(',')}`,
        kind: 'metric_comovement',
        match_basis: key,
        description,
        businesses,
        window_start: windowStart,
        window_end: windowEnd,
        caveat: CAUSATION_CAVEAT,
      });
    }
  }

  return patterns;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export interface DetectCrossBusinessPatternsOptions {
  /**
   * Already-scoped, already-computed CURRENT-window summaries — exactly
   * what assembleCommandCentre() built for its own sections. Reused rather
   * than recomputed.
   */
  businesses: BusinessSummary[];
  window_start: string;
  window_end: string;
  window_days: number;
  /** Overridable for tests; defaults to SIGNAL_COINCIDENCE_HOURS. */
  signal_coincidence_hours?: number;
}

/**
 * Detect cross-business patterns over an already-scoped selection.
 *
 * Returns the `{ data, data_as_of }` shape command-centre.ts's `section()`
 * expects, so the caller wraps this in the same failure-isolation primitive
 * every other section uses.
 */
export function detectCrossBusinessPatterns(
  options: DetectCrossBusinessPatternsOptions,
): { data: CrossBusinessPatternsSection; data_as_of: string | null } {
  const { businesses, window_start: windowStart, window_end: windowEnd, window_days: windowDays } = options;
  const coincidenceHours = options.signal_coincidence_hours ?? SIGNAL_COINCIDENCE_HOURS;

  const names = new Map(businesses.map((b) => [b.business_id, b.business_name]));
  const excludedBusinesses: Array<{ business_id: string; reason: string }> = [];
  for (const b of businesses) {
    if (b.status === 'unavailable') {
      excludedBusinesses.push({ business_id: b.business_id, reason: b.unavailable_reason ?? 'Business unavailable.' });
    }
  }

  const available = businesses.filter((b) => b.status !== 'unavailable');
  const consideredIds = available.map((b) => b.business_id);

  if (consideredIds.length < 2) {
    return {
      data: {
        businesses_considered: consideredIds,
        excluded_businesses: excludedBusinesses,
        patterns: [],
        caveat: CAUSATION_CAVEAT,
      },
      data_as_of: null,
    };
  }

  const signalPatterns = detectSignalCooccurrences(consideredIds, names, windowStart, windowEnd, coincidenceHours);

  const priorWindowStart = new Date(
    (timestampMs(windowStart) ?? Date.now()) - windowDays * 86_400_000,
  ).toISOString();

  const freeTextRows = db.prepare(
    `SELECT id, type FROM businesses WHERE id IN (${consideredIds.map(() => '?').join(',')})`,
  ).all(...consideredIds) as Array<{ id: string; type: string | null }>;
  const freeTextTypeById = new Map(freeTextRows.map((r) => [r.id, r.type]));

  const { contexts, excluded: movementExcluded } = buildMovementContexts(
    available, windowStart, windowEnd, priorWindowStart, windowStart, freeTextTypeById,
  );
  excludedBusinesses.push(...movementExcluded);

  const metricPatterns = detectMetricComovements(contexts, windowStart, windowEnd);
  const patterns = [...signalPatterns, ...metricPatterns];

  const dataAsOf = newestTimestamp(patterns.flatMap((p) => p.businesses.map((b) => b.occurred_at)));

  return {
    data: {
      businesses_considered: consideredIds,
      excluded_businesses: excludedBusinesses,
      patterns,
      caveat: CAUSATION_CAVEAT,
    },
    data_as_of: dataAsOf,
  };
}
