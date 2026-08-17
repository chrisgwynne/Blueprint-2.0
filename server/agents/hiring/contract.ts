/**
 * The durable BAP contract for the hiring-analysis lifecycle (#53) and the
 * safe read-back surface for business-scoped observability (#54).
 *
 * The contract is versioned (`contract_version`) and stable: external agents
 * and the dashboard read analysis state through this shape only, never by
 * poking at the hiring tables. Every outcome an analysis can have — success,
 * no candidates, coalesced, suppressed, cooled down, provider failure, stale
 * input, partial — is a documented status + terminal_reason pair rather than
 * an absent record.
 *
 * Redaction: nothing here may leak a provider response body, an API key, a
 * URL with credentials, or another business's data. Errors are already
 * sanitized upstream by lib/provider-errors.ts; redact() is a second pass so
 * a future code path cannot accidentally widen what is exposed.
 */

import { CONTRACT_VERSION, getAnalysisRun, getCoordination, listAnalysisRuns } from './store.js';
import { resolveHiringPolicy } from './policy.js';
import { evaluateRetention, type RetentionAssessment } from './retention.js';
import type { HiringAnalysisRunRecord } from './types.js';

export { CONTRACT_VERSION };

/**
 * Documented terminal outcomes. Kept next to the contract so a consumer can
 * enumerate them without reading the engine.
 */
export const TERMINAL_REASONS: Record<string, string> = {
  proposals_created: 'The analysis completed and created one or more hire proposals.',
  no_proposals: 'The analysis completed and deliberately proposed nothing.',
  no_active_connectors: 'The business has no connected data sources.',
  no_candidates: 'No uninstalled agent template has its required connectors available.',
  no_fresh_evidence: 'Connectors are connected but none has fresh data behind it.',
  all_already_proposed: 'Every eligible template already has an open hire proposal.',
  all_suppressed: 'Every eligible template is suppressed by a prior operator decision.',
  all_gated: 'Every candidate failed an evidence, coverage, WIP, ROI or outcome gate.',
  hiring_disabled: 'Autonomous hiring is disabled by policy for this business.',
  dry_run: 'Dry-run mode: decisions were evaluated and persisted, nothing was created.',
  cooldown: 'The business was analysed too recently; the trigger was paced.',
  no_material_change: 'Inputs are unchanged since the last analysis.',
  coalesced: 'Folded into an analysis already in flight for this business.',
  lease_held: 'Another analysis for this business held the coordination lease.',
  duplicate_trigger: 'An analysis with this idempotency key already exists.',
  provider_failure: 'The reasoning provider failed terminally.',
  reasoning_unavailable: 'Reasoning was unavailable; no proposals were created.',
  stale_run_reconciled: 'The analysis was abandoned mid-flight and reconciled as failed.',
  internal_error: 'The analysis failed with an internal error.',
  business_not_found: 'The business id does not exist.',
};

const REDACTIONS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/AIza[0-9A-Za-z_-]+/g, 'AIza[redacted]'],
  [/sk-[A-Za-z0-9._-]+/gi, 'sk-[redacted]'],
  [/https?:\/\/\S+/gi, '[redacted-url]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
];

export function redact(value: string | null | undefined, maxLength = 300): string | null {
  if (value == null) return null;
  let out = String(value);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.slice(0, maxLength);
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export interface HiringAnalysisContract {
  contract_version: string;
  analysis_id: string;
  business_id: string;
  trigger: {
    source: string;
    ref: string | null;
    reason: string | null;
    idempotency_key: string | null;
  };
  mode: string;
  status: string;
  terminal_reason: string | null;
  terminal_reason_description: string | null;
  input: {
    snapshot: Record<string, unknown>;
    freshness: {
      fresh_connector_count: number | null;
      stale_connector_count: number | null;
      max_age_hours: number | null;
    };
  };
  decision: {
    candidates_considered: number;
    candidates_gated: number;
    suppressed_count: number;
    recommendations_count: number;
    proposals_created: number;
    proposal_ids: string[];
    gated: Array<{ template_id: string; failures: string[] }>;
    suppressed: Array<{ template_id: string; reason: string }>;
  };
  provenance: {
    provider: string | null;
    model: string | null;
    provider_status: string | null;
    provider_http_status: number | null;
    provider_retryable: boolean | null;
    provider_attempts: number;
    cost_usd: number;
  };
  degraded: boolean;
  fallback_mode: string | null;
  coalesced_into: string | null;
  coalesced_callers: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export function toContract(run: HiringAnalysisRunRecord): HiringAnalysisContract {
  const snapshot = safeParse<Record<string, unknown>>(run.input_snapshot, {});
  const diagnostics = safeParse<Record<string, unknown>>(run.diagnostics, {});
  return {
    contract_version: run.contract_version ?? CONTRACT_VERSION,
    analysis_id: run.id,
    business_id: run.business_id,
    trigger: {
      source: run.trigger_source,
      ref: run.trigger_ref,
      reason: redact(run.trigger_reason, 200),
      idempotency_key: run.idempotency_key,
    },
    mode: run.mode,
    status: run.status,
    terminal_reason: run.terminal_reason,
    terminal_reason_description: run.terminal_reason ? TERMINAL_REASONS[run.terminal_reason] ?? null : null,
    input: {
      snapshot,
      freshness: {
        fresh_connector_count: numberOrNull(snapshot.fresh_connector_count),
        stale_connector_count: numberOrNull(snapshot.stale_connector_count),
        max_age_hours: numberOrNull(snapshot.freshness_max_age_hours),
      },
    },
    decision: {
      candidates_considered: run.candidates_considered,
      candidates_gated: run.candidates_gated,
      suppressed_count: run.suppressed_count,
      recommendations_count: run.recommendations_count,
      proposals_created: run.proposals_created,
      proposal_ids: safeParse<string[]>(run.proposal_ids, []),
      gated: Array.isArray(diagnostics.gated) ? diagnostics.gated as Array<{ template_id: string; failures: string[] }> : [],
      suppressed: Array.isArray(diagnostics.suppressed) ? diagnostics.suppressed as Array<{ template_id: string; reason: string }> : [],
    },
    provenance: {
      provider: run.provider,
      model: run.model,
      provider_status: run.provider_status,
      provider_http_status: run.provider_http_status,
      provider_retryable: run.provider_retryable == null ? null : run.provider_retryable === 1,
      provider_attempts: run.provider_attempts,
      cost_usd: run.cost_usd,
    },
    degraded: run.degraded === 1,
    fallback_mode: run.fallback_mode,
    coalesced_into: run.coalesced_into,
    coalesced_callers: run.coalesced_callers,
    // Double-redacted: the engine sanitizes provider errors before persisting,
    // and this strips anything a future code path might have let through.
    error: redact(run.error),
    started_at: run.started_at,
    completed_at: run.completed_at,
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function getAnalysisContract(businessId: string, analysisId: string): HiringAnalysisContract | null {
  const run = getAnalysisRun(businessId, analysisId);
  return run ? toContract(run) : null;
}

export function listAnalysisContracts(businessId: string, limit = 25): HiringAnalysisContract[] {
  return listAnalysisRuns(businessId, limit).map(toContract);
}

export interface HiringStatusContract {
  contract_version: string;
  business_id: string;
  policy: {
    enabled: boolean;
    dry_run: boolean;
    cooldown_minutes: number;
    max_open_proposals: number;
    freshness_max_age_hours: number;
    allow_deterministic_fallback: boolean;
    disabled_reason: string | null;
  };
  pacing: {
    last_analysis_id: string | null;
    last_analysis_at: string | null;
    last_trigger_source: string | null;
    last_trigger_reason: string | null;
    next_eligible_at: string | null;
    skipped_count: number;
    coalesced_count: number;
    consecutive_failures: number;
    lease_held: boolean;
  };
  latest: HiringAnalysisContract | null;
  recent: HiringAnalysisContract[];
  /** Advisory retain/monitor/downgrade/retire verdicts per installed agent (#56). */
  retention: RetentionAssessment[];
}

/** The business-scoped status/diagnostics read-back (#53 read, #54 dashboard). */
export function getHiringStatus(businessId: string, recentLimit = 10): HiringStatusContract {
  const policy = resolveHiringPolicy(businessId);
  const coord = getCoordination(businessId);
  const recent = listAnalysisContracts(businessId, recentLimit);
  return {
    contract_version: CONTRACT_VERSION,
    business_id: businessId,
    policy: {
      enabled: policy.enabled,
      dry_run: policy.dry_run,
      cooldown_minutes: policy.cooldown_minutes,
      max_open_proposals: policy.max_open_proposals,
      freshness_max_age_hours: policy.freshness_max_age_hours,
      allow_deterministic_fallback: policy.allow_deterministic_fallback,
      disabled_reason: redact(policy.disabled_reason ?? null, 200),
    },
    pacing: {
      last_analysis_id: coord?.last_analysis_id ?? null,
      last_analysis_at: coord?.last_analysis_at ?? null,
      last_trigger_source: coord?.last_trigger_source ?? null,
      last_trigger_reason: redact(coord?.last_trigger_reason ?? null, 200),
      next_eligible_at: coord?.next_eligible_at ?? null,
      skipped_count: coord?.skipped_count ?? 0,
      coalesced_count: coord?.coalesced_count ?? 0,
      consecutive_failures: coord?.consecutive_failures ?? 0,
      lease_held: !!coord?.lease_expires_at && Date.parse(`${coord.lease_expires_at.replace(' ', 'T')}Z`) > Date.now(),
    },
    latest: recent[0] ?? null,
    recent,
    retention: evaluateRetention(businessId),
  };
}
