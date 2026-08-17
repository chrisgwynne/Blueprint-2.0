/**
 * Portfolio metric comparability — extracted from portfolio-comparison.ts
 * (#71) so it can be reused without pulling in that module's dependency on
 * server/executive/command-centre.ts.
 *
 * This is a LEAF module on purpose: it imports nothing from command-centre.ts
 * or portfolio-comparison.ts, only the domain types (`ValuationBasis`,
 * `BusinessType`) and business-profile helpers those two concepts are built
 * from. That makes it safe for command-centre.ts's own cross-business
 * pattern detector (server/executive/cross-business-patterns.ts) to import
 * this directly — command-centre.ts must never depend on portfolio-
 * comparison.ts, which itself depends on command-centre.ts, and importing
 * this module from either side of that relationship cannot create a cycle.
 *
 * portfolio-comparison.ts re-exports `resolveComparability` and
 * `deriveValuationBasis` under their original names, so nothing about #71's
 * public API changed by moving the implementation here.
 */
import { getBusinessProfile, inferBusinessType } from '../business/business-profile.js';
import { valuationBasisForMetric, type ValuationBasis } from '../roi/value-estimator.js';
import type { BusinessType } from '../types/business-profile.js';

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
 * The minimal shape resolveComparability() actually reads. Deliberately
 * narrower than portfolio-comparison.ts's `MetricDefinition` /
 * `ComparedBusiness` — any object with these fields is accepted, so callers
 * pass their own richer types with no import needed here.
 */
export interface ComparabilityMetric {
  label: string;
  derivation_sensitive: boolean;
}

export interface ComparabilityBusiness {
  business_id: string;
  status: 'ok' | 'degraded' | 'unavailable';
  valuation_basis: ValuationBasis | null;
  business_type: BusinessType;
}

/**
 * Decide whether one metric can be ranked/compared across this set of
 * businesses.
 *
 * Only `derivation_sensitive` metrics can ever fail. Counts are counts
 * everywhere; a pending decision in a shop and a pending decision in an
 * agency are the same object. Currency and ratios are different: the same
 * "$/month" column can hold an observed revenue delta for one business and a
 * benchmark coefficient applied to a proxy metric for another, and ranking
 * or comparing those against each other asserts an equivalence that does not
 * exist.
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
 */
export function resolveComparability(
  metric: ComparabilityMetric, businesses: ComparabilityBusiness[],
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
        + 'number, so they are shown per business and deliberately not ranked, summed or compared.',
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
        + 'ranked, summed or compared.',
      incompatible_groups: groups,
    };
  }

  return { comparability: 'comparable', reason: null, incompatible_groups: null };
}

// ─── Valuation basis ──────────────────────────────────────────────────────────

/**
 * The minimal shape deriveValuationBasis() actually reads off a business
 * summary's outcomes section. Structurally compatible with command-centre.ts's
 * `BusinessSummary['outcomes']` (a `SectionEnvelope<OutcomesSection>`) without
 * importing it.
 */
export interface ValuationBasisSource {
  outcomes: {
    status: string;
    data: {
      declines: Array<{ metric_name: string | null }>;
      attributed_value_usd_per_month: number;
      attributed_decline_usd_per_month: number;
      confidence_level: string;
    } | null;
  };
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
export function deriveValuationBasis(summary: ValuationBasisSource | null): ValuationBasis | null {
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

// ─── Business type ────────────────────────────────────────────────────────────

/**
 * A business's type, preferring a human-confirmed business profile over the
 * free-text `businesses.type` column, with inference as the last resort.
 */
export function businessTypeOf(businessId: string, fallbackFreeText: string | null): {
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
