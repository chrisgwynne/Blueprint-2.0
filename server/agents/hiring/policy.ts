/**
 * Hiring policy — the durable control plane for autonomous hiring (#57) and
 * the pacing configuration for the per-business trigger coordinator (#46).
 *
 * The switch lives in `settings` (durable, survives restart) rather than in a
 * UI flag, and is read by the SINGLE hiring-analysis service that every
 * trigger path funnels through — connector sync, signal engine, scheduler,
 * BAP and the onboarding preview alike. There is no code path that proposes a
 * hire without passing resolveHiringPolicy() first.
 */

import db from '../../db/db.js';
import type { HiringMode } from './types.js';

const SETTINGS_KEY = 'hiring_policy';

export interface HiringPolicy {
  /** Master kill switch. When false, no automatic trigger may hire. */
  enabled: boolean;
  /** Evaluate + persist decisions but create no tasks/installs/first-runs. */
  dry_run: boolean;
  /** Minimum gap between analyses for one business. */
  cooldown_minutes: number;
  /** Analyses whose inputs are unchanged inside this window are skipped. */
  material_change_required: boolean;
  /** How long a coordination lease is valid before it is considered abandoned. */
  lease_ttl_seconds: number;
  /** Max concurrent open hire proposals per business (WIP cap, #48). */
  max_open_proposals: number;
  /** Connector data older than this fails the freshness gate (#48). */
  freshness_max_age_hours: number;
  /** Cap on retried provider attempts for one analysis (#52). */
  max_provider_attempts: number;
  /** Analyses stuck in `running` beyond this are reconciled as failed (#52). */
  stale_run_timeout_minutes: number;
  /**
   * Opt-in to the gated deterministic fallback when reasoning is unavailable
   * (#47). OFF by default: a reasoning failure produces no proposals.
   */
  allow_deterministic_fallback: boolean;
  /** Measurement window for the trial plan attached to each hire (#51). */
  trial_window_days: number;
  /** Per-business overrides, keyed by business id. */
  per_business: Record<string, Partial<Omit<HiringPolicy, 'per_business'>>>;
  /** Free-text note explaining why hiring is disabled, surfaced in audit records. */
  disabled_reason?: string | null;
}

export const DEFAULT_HIRING_POLICY: HiringPolicy = {
  enabled: true,
  dry_run: false,
  cooldown_minutes: 60,
  material_change_required: true,
  lease_ttl_seconds: 120,
  max_open_proposals: 3,
  freshness_max_age_hours: 72,
  max_provider_attempts: 3,
  stale_run_timeout_minutes: 30,
  allow_deterministic_fallback: false,
  trial_window_days: 14,
  per_business: {},
  disabled_reason: null,
};

function readRaw(): Partial<HiringPolicy> {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | null;
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value) as unknown;
    return (parsed && typeof parsed === 'object') ? parsed as Partial<HiringPolicy> : {};
  } catch {
    return {};
  }
}

/** The instance-wide policy, defaults filled in. */
export function getHiringPolicy(): HiringPolicy {
  const raw = readRaw();
  return {
    ...DEFAULT_HIRING_POLICY,
    ...raw,
    per_business: (raw.per_business && typeof raw.per_business === 'object') ? raw.per_business : {},
  };
}

/**
 * Effective policy for one business — instance defaults with that business's
 * overrides applied. Business scoping is deliberate: disabling hiring for a
 * business under migration must not disable it for its neighbours (#55).
 */
export function resolveHiringPolicy(businessId: string): HiringPolicy & { business_id: string } {
  const base = getHiringPolicy();
  const override = base.per_business[businessId] ?? {};
  return { ...base, ...override, per_business: base.per_business, business_id: businessId };
}

/** Partial update, merged over whatever is stored. */
export function setHiringPolicy(patch: Partial<HiringPolicy>): HiringPolicy {
  const next: HiringPolicy = { ...getHiringPolicy(), ...patch };
  if (patch.per_business) {
    next.per_business = { ...getHiringPolicy().per_business, ...patch.per_business };
  }
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function setBusinessHiringPolicy(
  businessId: string,
  patch: Partial<Omit<HiringPolicy, 'per_business'>>,
): HiringPolicy {
  const current = getHiringPolicy();
  return setHiringPolicy({
    per_business: { ...current.per_business, [businessId]: { ...(current.per_business[businessId] ?? {}), ...patch } },
  });
}

export interface ResolvedMode {
  mode: HiringMode;
  /** Set when mode is not 'live' — recorded on the analysis run (#57). */
  skip_reason: string | null;
  policy: HiringPolicy & { business_id: string };
}

/**
 * The single mode decision. `requestedDryRun` is the legacy per-call preview
 * flag; policy can force dry-run or disable hiring outright but a caller can
 * never upgrade itself out of a policy-imposed restriction.
 */
export function resolveMode(businessId: string, requestedDryRun = false): ResolvedMode {
  const policy = resolveHiringPolicy(businessId);
  if (!policy.enabled) {
    return {
      mode: 'disabled',
      skip_reason: policy.disabled_reason
        ? `autonomous_hiring_disabled: ${String(policy.disabled_reason).slice(0, 200)}`
        : 'autonomous_hiring_disabled',
      policy,
    };
  }
  if (policy.dry_run) return { mode: 'dry_run', skip_reason: 'policy_dry_run', policy };
  if (requestedDryRun) return { mode: 'dry_run', skip_reason: 'caller_dry_run', policy };
  return { mode: 'live', skip_reason: null, policy };
}
