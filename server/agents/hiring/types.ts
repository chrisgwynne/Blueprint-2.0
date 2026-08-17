/**
 * Shared types for the autonomous hiring engine (issues #44-#58).
 *
 * Everything in this module is business-scoped by construction: a business id
 * is a required, non-optional field on every record, and the store layer
 * refuses to read or write without one.
 */

/** Every code path that can start a hiring analysis. */
export type HiringTriggerSource =
  | 'connector_sync'
  | 'signal'
  | 'scheduled'
  | 'manual'
  | 'bap'
  | 'onboarding_preview';

/** Execution mode resolved from policy, recorded on every analysis run. */
export type HiringMode = 'live' | 'dry_run' | 'disabled';

/** Terminal lifecycle status of an analysis run (#53 contract). */
export type HiringRunStatus =
  | 'running'
  | 'complete'
  | 'skipped'
  | 'coalesced'
  | 'failed'
  | 'partial';

/**
 * Why an analysis ended where it did. Every no-op is a first-class,
 * machine-readable reason rather than a console warning (#54).
 */
export type HiringTerminalReason =
  | 'proposals_created'
  | 'no_proposals'
  | 'no_active_connectors'
  | 'no_candidates'
  | 'no_fresh_evidence'
  | 'all_already_proposed'
  | 'all_suppressed'
  | 'all_gated'
  | 'hiring_disabled'
  | 'dry_run'
  | 'cooldown'
  | 'no_material_change'
  | 'coalesced'
  | 'lease_held'
  | 'duplicate_trigger'
  | 'provider_failure'
  | 'reasoning_unavailable'
  | 'business_not_found'
  | 'stale_run_reconciled'
  | 'internal_error';

/** How strongly a prior negative decision binds future analyses (#50). */
export type SuppressionDisposition =
  | 'hard_suppression'      // never re-propose until a human clears it
  | 'temporary_deferral'    // re-propose after expiry
  | 'changed_circumstances'; // re-propose only when evidence materially differs

export type ReconsiderPolicy = 'never' | 'after_expiry' | 'new_evidence';

export type TrialVerdict = 'successful' | 'neutral' | 'unsuccessful' | 'insufficient_data';

export interface ConnectorEvidence {
  id: string;
  type: string;
  name: string | null;
  last_sync: string | null;
  age_hours: number | null;
  fresh: boolean;
}

export interface Candidate {
  id: string;
  name: string;
  title: string | null;
  avatar: string | null;
  personality: string | null;
  required: string[];
  preferred: string[];
  preferred_met: string[];
}

/** A candidate that survived (or failed) the evidence gates of #48. */
export interface GatedCandidate extends Candidate {
  admitted: boolean;
  gate_failures: string[];
  evidence: {
    fresh_connectors: string[];
    stale_connectors: string[];
    linked_goal_id: string | null;
    linked_goal_title: string | null;
    linked_signal_ids: string[];
    unmet_capability: string | null;
    open_wip: number;
    wip_limit: number;
    existing_coverage: string[];
    prior_trials: number;
    prior_success: number;
    prior_unsuccessful: number;
    expected_impact: string | null;
    roi_score: number | null;
  };
  /** Stable hash of the evidence, used to detect "new evidence" vs a prior rejection. */
  evidence_fingerprint: string;
}

export interface HireRecommendation {
  agent_id: string;
  reason: string;
  expected_value?: string;
  confidence?: number;
  priority?: 'immediate' | 'suggested' | 'optional';
  /** Set when the recommendation did not come from live LLM reasoning (#47). */
  degraded?: boolean;
  provenance?: 'llm' | 'deterministic_gated' | 'manual_review';
}

export interface EnrichedRecommendation extends HireRecommendation {
  name: string;
  title: string | null;
  avatar: string | null;
  required_connectors: string[];
  preferred_connectors: string[];
  preferred_met: string[];
  evidence?: GatedCandidate['evidence'];
  trial_plan?: TrialPlan | null;
}

/** The bounded trial that must exist before a hire can be proposed (#51). */
export interface TrialPlan {
  goal_id: string | null;
  signal_id: string | null;
  target_metric: string | null;
  baseline_value: number | null;
  target_value: number | null;
  measurement_window_days: number;
  evidence_deliverable: string;
}

export interface HiringDecisionRecord {
  id: string;
  business_id: string;
  template_id: string;
  decision: 'rejected' | 'approved' | 'deferred';
  disposition: SuppressionDisposition;
  actor: string;
  reason: string | null;
  task_id: string | null;
  analysis_id: string | null;
  evidence_fingerprint: string | null;
  reconsider_policy: ReconsiderPolicy;
  expires_at: string | null;
  decided_at: string;
}

export interface HiringAnalysisRunRecord {
  id: string;
  business_id: string;
  contract_version: string;
  trigger_source: string;
  trigger_ref: string | null;
  trigger_reason: string | null;
  idempotency_key: string | null;
  mode: HiringMode;
  status: HiringRunStatus;
  terminal_reason: string | null;
  degraded: number;
  fallback_mode: string | null;
  provider: string | null;
  model: string | null;
  provider_status: string | null;
  provider_http_status: number | null;
  provider_retryable: number | null;
  provider_attempts: number;
  error: string | null;
  input_snapshot: string;
  candidates_considered: number;
  candidates_gated: number;
  suppressed_count: number;
  recommendations_count: number;
  proposals_created: number;
  proposal_ids: string;
  coalesced_into: string | null;
  coalesced_callers: number;
  cost_usd: number;
  diagnostics: string;
  started_at: string;
  completed_at: string | null;
}

/** What `analyseAndProposeHires()` resolves to. */
export interface HiringAnalysisResult {
  analysis_id: string | null;
  business_id: string;
  mode: HiringMode;
  status: HiringRunStatus;
  proposed_hires: number;
  proposal_ids: string[];
  recommendations: EnrichedRecommendation[];
  /** Legacy field kept for existing callers: the terminal reason, or null on a clean proposing run. */
  reason: string | null;
  terminal_reason: HiringTerminalReason;
  degraded: boolean;
  fallback_mode: string | null;
  suppressed: string[];
  gated: Array<{ template_id: string; failures: string[] }>;
  error: string | null;
}

export interface AnalyseOptions {
  /**
   * Legacy/preview flag. `true` still means "evaluate but create nothing" and
   * is now folded into the single enforced dry-run path (#57).
   */
  dryRun?: boolean;
  trigger?: HiringTriggerSource;
  triggerRef?: string | null;
  triggerReason?: string | null;
  /**
   * Idempotency key for duplicate-trigger semantics (#53). Two triggers with
   * the same key for the same business resolve to the same analysis record.
   */
  idempotencyKey?: string | null;
  /** Bypass the debounce/cooldown pacing (explicit human/BAP action only). */
  force?: boolean;
  actor?: string;
}
