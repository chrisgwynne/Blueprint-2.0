/**
 * Per-business hiring coordinator (#45 concurrency, #46 trigger coordination).
 *
 * PROBLEM: three independent trigger paths (connector post-sync, signal
 * engine, scheduler) each called analyseAndProposeHires() directly with no
 * mutual exclusion and no pacing. Two syncs landing together ran two analyses
 * whose "is this template already proposed?" reads both happened before either
 * write, so both created a hire_agent task for the same template.
 *
 * SOLUTION — three layers, cheapest first:
 *   1. In-process coalescing: concurrent callers for the same business attach
 *      to the single in-flight promise instead of starting a second analysis.
 *   2. A DB lease (hiring_coordination.lease_holder): mutual exclusion that
 *      also holds across processes, with a TTL so a crashed holder frees up.
 *   3. Debounce/cooldown + material-change: even a lease-winning caller is
 *      skipped if the business was analysed recently and nothing material
 *      changed.
 *
 * Every skip is recorded — trigger reason, last analysis time, next eligible
 * time, and skipped/coalesced counters — rather than silently dropped.
 */

import { createHash } from 'node:crypto';
import {
  acquireLease, bumpSkipped, ensureCoordination, getCoordination,
  recordAnalysisPacing, releaseLease,
} from './store.js';
import type { HiringTerminalReason, HiringTriggerSource } from './types.js';

/** Triggers a human/operator explicitly asked for — never debounced away. */
const ALWAYS_ELIGIBLE_TRIGGERS: HiringTriggerSource[] = ['manual', 'onboarding_preview'];

/**
 * Material-change criteria. Two analyses of the same business are considered
 * to have identical inputs when this fingerprint matches: the set of fresh
 * connector types, the count of open material signals, the set of active goal
 * ids, and the set of hireable template ids. Anything else (a re-sync that
 * changed no data, a duplicate webhook) is not material.
 */
export interface MaterialInputs {
  fresh_connector_types: string[];
  stale_connector_types: string[];
  material_signal_count: number;
  active_goal_ids: string[];
  installed_agent_ids: string[];
  candidate_template_ids: string[];
}

export function fingerprintInputs(inputs: MaterialInputs): string {
  const canonical = JSON.stringify({
    fc: [...inputs.fresh_connector_types].sort(),
    sc: [...inputs.stale_connector_types].sort(),
    // Bucketed so one extra low-priority signal is not "material" but a real
    // burst is. Buckets: 0, 1-2, 3-5, 6-10, 11-20, 21+.
    ms: bucket(inputs.material_signal_count),
    g: [...inputs.active_goal_ids].sort(),
    i: [...inputs.installed_agent_ids].sort(),
    c: [...inputs.candidate_template_ids].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function bucket(n: number): number {
  if (n <= 0) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  if (n <= 10) return 3;
  if (n <= 20) return 4;
  return 5;
}

// ─── In-process coalescing ───────────────────────────────────────────────────

interface InFlight<T> {
  promise: Promise<T>;
  analysisIdRef: { id: string | null };
  attached: number;
}

const inFlight = new Map<string, InFlight<unknown>>();

/** Test/diagnostic helper — how many businesses are mid-analysis right now. */
export function inFlightCount(): number {
  return inFlight.size;
}

/**
 * Run `fn` for `businessId`, coalescing concurrent callers onto one execution.
 * `onCoalesced` lets the caller record the fact that it was folded in (so the
 * skipped/coalesced counts are real numbers, not guesses).
 */
export async function coalesce<T>(
  businessId: string,
  fn: (analysisIdRef: { id: string | null }) => Promise<T>,
  onCoalesced?: (analysisId: string | null) => void,
): Promise<{ result: T; coalesced: boolean }> {
  const existing = inFlight.get(businessId) as InFlight<T> | undefined;
  if (existing) {
    existing.attached++;
    try { bumpSkipped(businessId, 'coalesced'); } catch { /* coordination row is best-effort */ }
    onCoalesced?.(existing.analysisIdRef.id);
    const result = await existing.promise;
    return { result, coalesced: true };
  }

  const analysisIdRef: { id: string | null } = { id: null };
  const entry: InFlight<T> = { promise: Promise.resolve() as Promise<T>, analysisIdRef, attached: 0 };
  entry.promise = (async () => fn(analysisIdRef))();
  inFlight.set(businessId, entry as InFlight<unknown>);
  try {
    const result = await entry.promise;
    return { result, coalesced: false };
  } finally {
    if (inFlight.get(businessId) === (entry as InFlight<unknown>)) inFlight.delete(businessId);
  }
}

// ─── Eligibility (debounce / cooldown / material change) ─────────────────────

export interface EligibilityDecision {
  eligible: boolean;
  reason: HiringTerminalReason | null;
  next_eligible_at: string | null;
  last_analysis_at: string | null;
  last_fingerprint: string | null;
}

export function checkEligibility(
  businessId: string,
  opts: {
    trigger: HiringTriggerSource;
    force?: boolean;
    cooldownMinutes: number;
    materialChangeRequired: boolean;
    fingerprint?: string | null;
  },
): EligibilityDecision {
  const row = ensureCoordination(businessId);
  const base = {
    next_eligible_at: row.next_eligible_at,
    last_analysis_at: row.last_analysis_at,
    last_fingerprint: row.last_input_fingerprint,
  };

  if (opts.force || ALWAYS_ELIGIBLE_TRIGGERS.includes(opts.trigger)) {
    return { eligible: true, reason: null, ...base };
  }

  // Cooldown: a business analysed inside its cooldown window is only
  // re-analysed when its inputs materially changed.
  const withinCooldown = !!row.next_eligible_at && Date.parse(`${row.next_eligible_at.replace(' ', 'T')}Z`) > Date.now();
  const unchanged = opts.materialChangeRequired
    && !!opts.fingerprint
    && !!row.last_input_fingerprint
    && opts.fingerprint === row.last_input_fingerprint;

  if (withinCooldown && (unchanged || !opts.fingerprint)) {
    return { eligible: false, reason: unchanged ? 'no_material_change' : 'cooldown', ...base };
  }
  if (!withinCooldown && unchanged && opts.materialChangeRequired && opts.cooldownMinutes > 0) {
    // Outside the cooldown window but with byte-identical inputs: still not
    // worth an LLM call, but recorded as a distinct reason so operators can
    // tell "paced" apart from "nothing changed".
    return { eligible: false, reason: 'no_material_change', ...base };
  }
  return { eligible: true, reason: null, ...base };
}

export function noteSkip(businessId: string): void {
  try { bumpSkipped(businessId, 'skipped'); } catch { /* best-effort */ }
}

export { acquireLease, releaseLease, recordAnalysisPacing, getCoordination };
