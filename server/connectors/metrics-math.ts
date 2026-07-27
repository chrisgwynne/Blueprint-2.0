/**
 * Small pure helpers for connector metric maths. Kept dependency-free and
 * separately unit-tested so the tricky bits (period maths, weighted ratios)
 * aren't buried inside fetch loops.
 */

function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The `days`-day window immediately BEFORE the trailing `days`-day window that
 * ends yesterday (matching Google Ads' DURING LAST_30_DAYS, which excludes
 * today). For days=30 and today T: returns [T-60, T-31].
 *
 * Replaces a previously hard-coded 'BETWEEN 2025-03-01 AND 2025-03-31' that
 * made every previous-period comparison permanently wrong.
 */
export function previousPeriodRange(now: Date, days = 30): { start: string; end: string } {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - (days + 1));
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 2 * days);
  return { start: fmtDate(start), end: fmtDate(end) };
}

/**
 * Weighted average of per-row ratios (e.g. a period bounce rate weighted by
 * each day's sessions), not the unweighted mean of daily rates. Rows with a
 * non-positive or non-finite weight are ignored. Returns 0 when there is no
 * positive weight.
 */
export function sessionsWeightedAverage(pairs: Array<{ value: number; weight: number }>): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const p of pairs) {
    if (!Number.isFinite(p.value) || !Number.isFinite(p.weight) || p.weight <= 0) continue;
    weighted += p.value * p.weight;
    totalWeight += p.weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : 0;
}
