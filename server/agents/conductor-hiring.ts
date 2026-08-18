/**
 * Conductor-led agent hiring — the single hiring-analysis service.
 *
 * EVERY trigger path (connector post-sync, signal engine, scheduler, BAP, the
 * onboarding preview, and any manual call) enters through
 * analyseAndProposeHires(). There is no other way to propose a hire, which is
 * what makes the kill switch, dry-run mode, per-business coordination,
 * suppression memory and audit trail enforceable rather than advisory.
 *
 * Pipeline (issue references in brackets):
 *   0. Reconcile stale `running` analyses for this business           [#52]
 *   1. Resolve mode: disabled / dry_run / live from durable policy    [#57]
 *   2. Duplicate-trigger check via idempotency key                    [#53]
 *   3. Coalesce concurrent callers for this business                  [#45]
 *   4. Gather business-scoped inputs + freshness snapshot         [#48,#49,#55]
 *   5. Debounce / cooldown / material-change eligibility              [#46]
 *   6. Take the per-business lease (cross-process mutual exclusion)   [#45]
 *   7. Open the analysis run record (provenance + observability)  [#53,#54]
 *   8. Gate candidates on evidence, coverage, WIP, ROI, outcomes  [#48,#51,#56]
 *      and prior human decisions                                      [#50]
 *   9. Reason (bounded retry, sanitized errors, no fallback burst) [#47,#52]
 *  10. Create proposals idempotently, each with a trial plan      [#45,#51]
 *  11. Close the run, record pacing, release the lease, notify    [#54,#47]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { resolveMode } from './hiring/policy.js';
import {
  attachTaskToProposalSlot, claimProposalSlot, createTrial, finishAnalysisRun,
  getAnalysisRun, getConnectorEvidence, getHiringDecisions, getInstalledAgentIds,
  getOpenProposalTemplateIds, getOutcomeHistory, getActiveGoals,
  getRecentMaterialSignals, incrementCoalescedCallers, findRunByIdempotencyKey,
  reconcileStaleAnalysisRuns, releaseProposalSlot, startAnalysisRun, assertBusiness,
} from './hiring/store.js';
import {
  acquireLease, checkEligibility, coalesce, fingerprintInputs, noteSkip,
  recordAnalysisPacing, releaseLease,
} from './hiring/coordinator.js';
import { buildTrialPlan, gateCandidates } from './hiring/gates.js';
import { deterministicFallback, reasonAboutHires } from './hiring/reasoning.js';
import type {
  AnalyseOptions, Candidate, EnrichedRecommendation, GatedCandidate,
  HireRecommendation, HiringAnalysisResult, HiringTerminalReason, HiringTriggerSource,
} from './hiring/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, 'templates');

export type { HiringAnalysisResult, EnrichedRecommendation } from './hiring/types.js';

interface AgentProfile {
  id?: string;
  name?: string;
  title?: string;
  avatar?: string;
  personality?: string;
  required_connectors?: string[];
  connectors_required?: string[];
  preferred_connectors?: string[];
  connectors_optional?: string[];
  [key: string]: unknown;
}

function extractConnectorSpec(profile: AgentProfile): { required: string[]; preferred: string[] } {
  const required = profile?.required_connectors ?? profile?.connectors_required ?? [];
  const preferred = profile?.preferred_connectors ?? profile?.connectors_optional ?? [];
  return {
    required: Array.isArray(required) ? required : [],
    preferred: Array.isArray(preferred) ? preferred : [],
  };
}

export function loadAllTemplates(): Array<{ id: string; profile: AgentProfile }> {
  if (!existsSync(TEMPLATES_DIR)) return [];
  const out: Array<{ id: string; profile: AgentProfile }> = [];
  for (const e of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const profilePath = join(TEMPLATES_DIR, e.name, 'profile.yaml');
    if (!existsSync(profilePath)) continue;
    try {
      out.push({ id: e.name, profile: (yaml.load(readFileSync(profilePath, 'utf8')) ?? {}) as AgentProfile });
    } catch { /* an unreadable template is simply not hireable */ }
  }
  return out;
}

/**
 * Injectable seams. Tests supply templates and a fake reasoning function so
 * the hiring suite never touches the real templates directory or a live LLM
 * provider (#58); production passes nothing.
 */
export interface HiringDeps {
  loadTemplates?: () => Array<{ id: string; profile: AgentProfile }>;
  reason?: typeof reasonAboutHires;
  notify?: (n: { business_id: string; severity: string; title: string; body: string }) => Promise<void>;
}

let deps: HiringDeps = {};
export function __setHiringDeps(next: HiringDeps): void { deps = next; }
export function __resetHiringDeps(): void { deps = {}; }

function emptyResult(
  businessId: string,
  over: Partial<HiringAnalysisResult> & { terminal_reason: HiringTerminalReason },
): HiringAnalysisResult {
  return {
    analysis_id: null, business_id: businessId, mode: 'live', status: 'skipped',
    proposed_hires: 0, proposal_ids: [], recommendations: [],
    reason: over.terminal_reason, degraded: false, fallback_mode: null,
    suppressed: [], gated: [], error: null,
    ...over,
  };
}

/**
 * Run a hiring analysis for a single business.
 *
 * Never throws for operational reasons — provider failures, lease contention,
 * cooldowns and policy blocks all resolve to a structured result with a
 * machine-readable terminal reason, so one business can never abort a sweep
 * over its neighbours (#52, #55). Programmer errors (missing businessId,
 * unknown business) still throw.
 */
export async function analyseAndProposeHires(
  businessId: string,
  opts: AnalyseOptions = {},
): Promise<HiringAnalysisResult> {
  if (!businessId) throw new Error('businessId required');
  const business = assertBusiness(businessId);

  const trigger: HiringTriggerSource = opts.trigger
    ?? (opts.dryRun ? 'onboarding_preview' : 'manual');
  const triggerReason = opts.triggerReason ?? null;

  // 0. Close out any analysis this business abandoned mid-flight, so a crashed
  //    run can never hold its lease/state hostage (#52).
  const { policy, mode, skip_reason: modeSkipReason } = resolveMode(businessId, opts.dryRun === true);
  try { reconcileStaleAnalysisRuns(policy.stale_run_timeout_minutes, businessId); } catch { /* best-effort */ }

  // 1. Kill switch (#57). Recorded as a real run so the audit trail shows the
  //    trigger fired and was refused, with the mode and skip reason.
  if (mode === 'disabled') {
    const id = startAnalysisRun({
      businessId, triggerSource: trigger, triggerRef: opts.triggerRef ?? null,
      triggerReason, idempotencyKey: null, mode: 'disabled',
      inputSnapshot: { skip_reason: modeSkipReason },
    });
    finishAnalysisRun(businessId, id, {
      status: 'skipped', terminalReason: 'hiring_disabled', diagnostics: { skip_reason: modeSkipReason },
    });
    noteSkip(businessId);
    return emptyResult(businessId, {
      analysis_id: id, mode: 'disabled', status: 'skipped', terminal_reason: 'hiring_disabled',
    });
  }

  // 2. Duplicate-trigger semantics (#53): the same idempotency key for the
  //    same business resolves to the same analysis instead of a second one.
  if (opts.idempotencyKey) {
    const existing = findRunByIdempotencyKey(businessId, opts.idempotencyKey);
    if (existing) {
      return emptyResult(businessId, {
        analysis_id: existing.id, mode: existing.mode, status: existing.status,
        proposed_hires: existing.proposals_created,
        proposal_ids: safeParse<string[]>(existing.proposal_ids, []),
        terminal_reason: 'duplicate_trigger',
        degraded: existing.degraded === 1, fallback_mode: existing.fallback_mode,
      });
    }
  }

  // 3. Coalesce concurrent in-process callers onto one analysis (#45).
  const { result, coalesced } = await coalesce<HiringAnalysisResult>(
    businessId,
    (ref) => runAnalysis(businessId, business, { ...opts, trigger, triggerReason }, mode, policy, ref),
    (analysisId) => {
      if (analysisId) { try { incrementCoalescedCallers(businessId, analysisId); } catch { /* best-effort */ } }
    },
  );

  if (coalesced) {
    // The caller did not run an analysis of its own; it observed the result of
    // the one already in flight. Reported honestly rather than as its own work.
    return { ...result, terminal_reason: 'coalesced', reason: 'coalesced', status: 'coalesced', proposed_hires: 0, proposal_ids: [] };
  }
  return result;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

async function runAnalysis(
  businessId: string,
  business: { id: string; name: string | null; type: string | null },
  opts: AnalyseOptions & { trigger: HiringTriggerSource; triggerReason: string | null },
  mode: 'live' | 'dry_run',
  policy: ReturnType<typeof resolveMode>['policy'],
  analysisIdRef: { id: string | null },
): Promise<HiringAnalysisResult> {
  const trigger = opts.trigger;

  // ── 4. Business-scoped inputs. Note getInstalledAgentIds(): the old code
  //    read `SELECT id FROM agents` with no business predicate, so an agent
  //    hired by ANY business counted as installed for ALL of them (#49).
  const connectors = getConnectorEvidence(businessId, policy.freshness_max_age_hours);
  const activeTypes = new Set(connectors.map((c) => c.type));
  const installed = getInstalledAgentIds(businessId);
  const templates = (deps.loadTemplates ?? loadAllTemplates)();

  const candidates: Candidate[] = [];
  for (const { id, profile } of templates) {
    if (id === 'conductor') continue; // always present, never hired
    if (installed.has(id)) continue;
    const { required, preferred } = extractConnectorSpec(profile);
    if (!required.every((t) => activeTypes.has(t))) continue;
    candidates.push({
      id,
      name: profile.name ?? id,
      title: profile.title ?? null,
      avatar: profile.avatar ?? null,
      personality: profile.personality ?? null,
      required, preferred,
      preferred_met: preferred.filter((t) => activeTypes.has(t)),
    });
  }

  const goals = getActiveGoals(businessId);
  const materialSignals = getRecentMaterialSignals(businessId, 24 * 14);
  const fingerprint = fingerprintInputs({
    fresh_connector_types: connectors.filter((c) => c.fresh).map((c) => c.type),
    stale_connector_types: connectors.filter((c) => !c.fresh).map((c) => c.type),
    material_signal_count: materialSignals.length,
    active_goal_ids: goals.map((g) => g.id),
    installed_agent_ids: [...installed],
    candidate_template_ids: candidates.map((c) => c.id),
  });

  const inputSnapshot = {
    connectors: connectors.map((c) => ({ type: c.type, fresh: c.fresh, age_hours: c.age_hours == null ? null : Math.round(c.age_hours * 10) / 10 })),
    fresh_connector_count: connectors.filter((c) => c.fresh).length,
    stale_connector_count: connectors.filter((c) => !c.fresh).length,
    active_goal_count: goals.length,
    material_signal_count: materialSignals.length,
    installed_agent_count: installed.size,
    mechanical_candidate_count: candidates.length,
    input_fingerprint: fingerprint,
    freshness_max_age_hours: policy.freshness_max_age_hours,
  };

  // ── 5. Debounce / cooldown / material-change (#46).
  const eligibility = checkEligibility(businessId, {
    trigger, force: opts.force,
    cooldownMinutes: policy.cooldown_minutes,
    materialChangeRequired: policy.material_change_required,
    fingerprint,
  });
  if (!eligibility.eligible) {
    const id = startAnalysisRun({
      businessId, triggerSource: trigger, triggerRef: opts.triggerRef ?? null,
      triggerReason: opts.triggerReason, idempotencyKey: opts.idempotencyKey ?? null,
      mode, inputSnapshot,
    });
    analysisIdRef.id = id;
    finishAnalysisRun(businessId, id, {
      status: 'skipped', terminalReason: eligibility.reason ?? 'cooldown',
      candidatesConsidered: candidates.length, inputSnapshot,
      diagnostics: {
        next_eligible_at: eligibility.next_eligible_at,
        last_analysis_at: eligibility.last_analysis_at,
        fingerprint_matched: eligibility.last_fingerprint === fingerprint,
      },
    });
    noteSkip(businessId);
    return emptyResult(businessId, {
      analysis_id: id, mode, status: 'skipped',
      terminal_reason: eligibility.reason ?? 'cooldown',
    });
  }

  // ── 6. Cross-process mutual exclusion (#45).
  const leaseHolder = `hiring:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  if (!acquireLease(businessId, leaseHolder, policy.lease_ttl_seconds)) {
    const id = startAnalysisRun({
      businessId, triggerSource: trigger, triggerRef: opts.triggerRef ?? null,
      triggerReason: opts.triggerReason, idempotencyKey: opts.idempotencyKey ?? null,
      mode, inputSnapshot,
    });
    analysisIdRef.id = id;
    finishAnalysisRun(businessId, id, {
      status: 'skipped', terminalReason: 'lease_held', inputSnapshot,
      diagnostics: { note: 'another hiring analysis for this business holds the lease' },
    });
    noteSkip(businessId);
    return emptyResult(businessId, { analysis_id: id, mode, status: 'skipped', terminal_reason: 'lease_held' });
  }

  // ── 7. Open the run record.
  const analysisId = startAnalysisRun({
    businessId, triggerSource: trigger, triggerRef: opts.triggerRef ?? null,
    triggerReason: opts.triggerReason, idempotencyKey: opts.idempotencyKey ?? null,
    mode, inputSnapshot,
  });
  analysisIdRef.id = analysisId;

  let failed = false;
  try {
    return await analysisBody(businessId, business, opts, mode, policy, analysisId, {
      connectors, candidates, inputSnapshot, fingerprint,
    });
  } catch (err) {
    failed = true;
    const message = (err as Error)?.message ?? 'unknown error';
    finishAnalysisRun(businessId, analysisId, {
      status: 'failed', terminalReason: 'internal_error',
      error: message.slice(0, 300), inputSnapshot,
      candidatesConsidered: candidates.length,
    });
    console.warn(`[hiring] analysis ${analysisId} for ${businessId} failed:`, message);
    return emptyResult(businessId, {
      analysis_id: analysisId, mode, status: 'failed',
      terminal_reason: 'internal_error', error: message.slice(0, 300),
    });
  } finally {
    recordAnalysisPacing(businessId, {
      analysisId, triggerSource: trigger, triggerReason: opts.triggerReason ?? null,
      fingerprint, cooldownMinutes: policy.cooldown_minutes, failed,
    });
    releaseLease(businessId, leaseHolder);
  }
}

async function analysisBody(
  businessId: string,
  business: { id: string; name: string | null; type: string | null },
  opts: AnalyseOptions & { trigger: HiringTriggerSource; triggerReason: string | null },
  mode: 'live' | 'dry_run',
  policy: ReturnType<typeof resolveMode>['policy'],
  analysisId: string,
  ctx: {
    connectors: ReturnType<typeof getConnectorEvidence>;
    candidates: Candidate[];
    inputSnapshot: Record<string, unknown>;
    fingerprint: string;
  },
): Promise<HiringAnalysisResult> {
  const { connectors, candidates, inputSnapshot } = ctx;

  if (connectors.length === 0) {
    return finishEmpty(businessId, analysisId, mode, 'no_active_connectors', inputSnapshot, 0);
  }
  if (!connectors.some((c) => c.fresh)) {
    // Connected but nothing has ever synced / everything is stale: the exact
    // "status='connected' is not evidence" case issue #48 calls out.
    return finishEmpty(businessId, analysisId, mode, 'no_fresh_evidence', inputSnapshot, candidates.length);
  }
  if (candidates.length === 0) {
    return finishEmpty(businessId, analysisId, mode, 'no_candidates', inputSnapshot, 0);
  }

  // Templates already carrying an open proposal — re-read AFTER taking the
  // lease so a proposal another process just created is visible.
  const alreadyProposed = getOpenProposalTemplateIds(businessId);
  const notYetProposed = candidates.filter((c) => !alreadyProposed.has(c.id));
  if (notYetProposed.length === 0) {
    return finishEmpty(businessId, analysisId, mode, 'all_already_proposed', inputSnapshot, candidates.length);
  }

  // ── 8. Evidence, coverage, WIP, ROI, outcome-history and prior-decision gates.
  const installedRequirements = buildInstalledRequirements(businessId);
  const gateResult = gateCandidates(
    { businessId, connectors, installedRequirements, maxOpenProposals: policy.max_open_proposals },
    notYetProposed,
  );

  const gatedSummary = gateResult.rejected.map((c) => ({ template_id: c.id, failures: c.gate_failures }));

  if (gateResult.admitted.length === 0) {
    const reason: HiringTerminalReason = gateResult.suppressed.length > 0 && gateResult.suppressed.length === gateResult.rejected.length
      ? 'all_suppressed'
      : 'all_gated';
    finishAnalysisRun(businessId, analysisId, {
      status: 'complete', terminalReason: reason, inputSnapshot,
      candidatesConsidered: candidates.length,
      candidatesGated: gateResult.rejected.length,
      suppressedCount: gateResult.suppressed.length,
      diagnostics: { gated: gatedSummary, suppressed: gateResult.suppressed },
    });
    return emptyResult(businessId, {
      analysis_id: analysisId, mode, status: 'complete', terminal_reason: reason,
      suppressed: gateResult.suppressed.map((s) => s.template_id), gated: gatedSummary,
    });
  }

  // ── 9. Reasoning. Bounded retries, sanitized errors, and — critically — NO
  //    proposal burst when it fails (#47).
  const priorDecisions = getHiringDecisions(businessId, 25).map((d) => ({
    template_id: d.template_id, decision: d.decision, reason: d.reason,
    decided_at: d.decided_at, disposition: d.disposition,
  }));
  const priorOutcomes = gateResult.admitted.flatMap((c) => {
    const h = getOutcomeHistory(businessId, c.id);
    return h.last_verdict ? [{ template_id: c.id, verdict: h.last_verdict, reason: h.last_verdict_reason }] : [];
  });

  const reasoner = deps.reason ?? reasonAboutHires;
  const outcome = await reasoner({
    businessName: business.name, businessType: business.type,
    connectors, candidates: gateResult.admitted,
    priorDecisions, priorOutcomes,
    maxAttempts: policy.max_provider_attempts,
  });

  let recommendations: HireRecommendation[] = outcome.recommendations;
  let degraded = false;
  let fallbackMode: string | null = null;

  if (outcome.status === 'failed') {
    degraded = true;
    recommendations = deterministicFallback(gateResult.admitted, policy.allow_deterministic_fallback);
    fallbackMode = recommendations.length > 0 ? 'deterministic_gated' : 'manual_review_no_proposals';
    console.warn(
      `[hiring] reasoning unavailable for ${businessId} (${outcome.provider_status ?? 'unknown'}); `
      + `${recommendations.length === 0 ? 'no proposals created' : `${recommendations.length} gated fallback recommendation(s)`}.`
    );
  }

  // Only admitted candidates may be recommended — a hallucinated id, or one
  // the gates rejected, is dropped rather than proposed.
  const admittedById = new Map(gateResult.admitted.map((c) => [c.id, c]));
  recommendations = recommendations.filter((r) => admittedById.has(r.agent_id));

  // Degraded recommendations can never carry ordinary confidence (#47).
  if (degraded) {
    recommendations = recommendations.map((r) => ({
      ...r, degraded: true,
      confidence: Math.min(r.confidence ?? 0.5, 0.5),
      provenance: r.provenance ?? 'manual_review',
    }));
  }

  const enriched: EnrichedRecommendation[] = recommendations.map((r) => {
    const c = admittedById.get(r.agent_id)!;
    return {
      ...r,
      name: c.name, title: c.title, avatar: c.avatar,
      required_connectors: c.required, preferred_connectors: c.preferred,
      preferred_met: c.preferred_met, evidence: c.evidence,
      trial_plan: buildTrialPlan(businessId, c, policy.trial_window_days),
    };
  });

  // ── 10. Proposal creation. Skipped entirely in dry-run mode (#57): the
  //    decisions are still evaluated, persisted and returned, but nothing is
  //    created — no task, no install, no first run.
  const proposalIds: string[] = [];
  const windowKey = analysisWindowKey(policy.cooldown_minutes);
  const creationNotes: Array<{ template_id: string; result: string }> = [];

  if (mode === 'live') {
    // Resolved at call time rather than via a top-level import: task-queue
    // pulls in the trust engine, action registry and business profile, and a
    // static binding here also made the hiring engine capture whatever the
    // module registry held at first load.
    const { createTask } = await import('../tasks/task-queue.js');
    for (const rec of enriched) {
      const candidate = admittedById.get(rec.agent_id)!;
      if ((rec.confidence ?? 0) < 0.7 && !rec.degraded) {
        creationNotes.push({ template_id: rec.agent_id, result: 'below_confidence_threshold' });
        continue;
      }
      // #51: no measurable outcome ⇒ no hire. A hire we cannot later judge is
      // exactly the "activity, not outcomes" failure mode.
      if (!rec.trial_plan) {
        creationNotes.push({ template_id: rec.agent_id, result: 'no_measurable_outcome_gate' });
        continue;
      }
      // #45: DB-level claim. Two concurrent analyses cannot both win this.
      if (!claimProposalSlot(businessId, rec.agent_id, windowKey, analysisId)) {
        creationNotes.push({ template_id: rec.agent_id, result: 'duplicate_slot_claimed_elsewhere' });
        continue;
      }
      try {
        const task = createTask({
          business_id: businessId,
          title: `Hire ${candidate.name} agent`,
          description: buildDescription(rec, candidate, degraded),
          proposed_by: 'conductor',
          action_type: 'hire_agent',
          action_payload: {
            template_id: candidate.id,
            analysis_id: analysisId,
            degraded,
            evidence_fingerprint: candidate.evidence_fingerprint,
            trial_plan: rec.trial_plan,
          },
          trust_tier: 'yellow',
          priority: rec.priority === 'immediate' ? 'p1' : rec.priority === 'optional' ? 'p3' : 'p2',
          confidence: rec.confidence ?? null,
          estimated_impact: rec.expected_value ?? null,
          approval_mode: 'requires_approval',
          degraded_data: degraded ? 1 : 0,
        });
        if (!task) {
          releaseProposalSlot(businessId, rec.agent_id, windowKey);
          creationNotes.push({ template_id: rec.agent_id, result: 'task_creation_returned_null' });
          continue;
        }
        attachTaskToProposalSlot(businessId, rec.agent_id, windowKey, task.id);
        createTrial(businessId, candidate.id, rec.trial_plan, {
          taskId: task.id, analysisId, confidence: rec.confidence ?? null,
        });
        proposalIds.push(task.id);
        creationNotes.push({ template_id: rec.agent_id, result: 'proposed' });
      } catch (err) {
        releaseProposalSlot(businessId, rec.agent_id, windowKey);
        creationNotes.push({ template_id: rec.agent_id, result: `error: ${(err as Error).message.slice(0, 120)}` });
        console.warn(`[hiring] failed to create hire task for ${candidate.id}:`, (err as Error).message);
      }
    }
  }

  // ── 11. Close the run.
  const terminalReason: HiringTerminalReason = mode === 'dry_run'
    ? 'dry_run'
    : outcome.status === 'failed' && proposalIds.length === 0
      ? 'reasoning_unavailable'
      : proposalIds.length > 0 ? 'proposals_created' : 'no_proposals';

  finishAnalysisRun(businessId, analysisId, {
    status: outcome.status === 'failed' && proposalIds.length === 0 && mode === 'live' ? 'partial' : 'complete',
    terminalReason,
    degraded, fallbackMode,
    provider: outcome.provider, model: outcome.model,
    providerStatus: outcome.provider_status,
    providerHttpStatus: outcome.provider_http_status,
    providerRetryable: outcome.provider_retryable,
    providerAttempts: outcome.attempts,
    error: outcome.error,
    candidatesConsidered: candidates.length,
    candidatesGated: gateResult.rejected.length,
    suppressedCount: gateResult.suppressed.length,
    recommendationsCount: enriched.length,
    proposalsCreated: proposalIds.length,
    proposalIds,
    costUsd: outcome.cost_usd,
    inputSnapshot,
    diagnostics: {
      gated: gatedSummary,
      suppressed: gateResult.suppressed,
      creation: creationNotes,
      window_key: windowKey,
      trigger_source: opts.trigger,
      trigger_reason: opts.triggerReason,
    },
  });

  // A recommendation that did not become a proposal is a decision, not a
  // silent drop — surface it (#54).
  for (const note of creationNotes) {
    if (note.result !== 'proposed') {
      console.log(`[hiring] ${businessId}: ${note.template_id} not proposed — ${note.result}`);
    }
  }

  if (proposalIds.length > 0) {
    await notifyProposals(businessId, proposalIds.length, degraded);
  }

  return {
    analysis_id: analysisId, business_id: businessId, mode,
    status: outcome.status === 'failed' && proposalIds.length === 0 && mode === 'live' ? 'partial' : 'complete',
    proposed_hires: proposalIds.length,
    proposal_ids: proposalIds,
    recommendations: enriched,
    reason: proposalIds.length > 0 ? null : terminalReason,
    terminal_reason: terminalReason,
    degraded, fallback_mode: fallbackMode,
    suppressed: gateResult.suppressed.map((s) => s.template_id),
    gated: gatedSummary,
    error: outcome.error,
  };
}

function finishEmpty(
  businessId: string, analysisId: string, mode: 'live' | 'dry_run',
  reason: HiringTerminalReason, inputSnapshot: unknown, considered: number,
): HiringAnalysisResult {
  finishAnalysisRun(businessId, analysisId, {
    status: 'complete', terminalReason: reason, inputSnapshot, candidatesConsidered: considered,
  });
  return emptyResult(businessId, {
    analysis_id: analysisId, mode, status: 'complete', terminal_reason: reason,
  });
}

/** Required-connector map for the agents THIS business has installed (#49). */
function buildInstalledRequirements(businessId: string): Map<string, string[]> {
  const installed = getInstalledAgentIds(businessId);
  const map = new Map<string, string[]>();
  if (installed.size === 0) return map;
  for (const { id, profile } of (deps.loadTemplates ?? loadAllTemplates)()) {
    if (!installed.has(id) || id === 'conductor') continue;
    map.set(id, extractConnectorSpec(profile).required);
  }
  return map;
}

/**
 * The analysis window for proposal idempotency (#45). One window per business
 * per cooldown period: within it, a given template can be proposed exactly
 * once no matter how many analyses race.
 *
 * Minimum window is 60 minutes regardless of the configured cooldown. A shorter
 * minimum (e.g. 1 minute when cooldown_minutes=0) means two analyses that
 * cross a minute boundary get different window keys, allowing both to claim
 * proposal slots — the dedup breaks at boundary edges. 60 minutes aligns with
 * the default cooldown and is wide enough that any two analyses within a
 * normal lease TTL share the same key. (Issue #89 root cause.)
 */
function analysisWindowKey(cooldownMinutes: number): string {
  const windowMs = Math.max(60, cooldownMinutes) * 60_000;
  return `w${Math.floor(Date.now() / windowMs)}`;
}

function buildDescription(rec: EnrichedRecommendation, candidate: GatedCandidate, degraded: boolean): string {
  const ev = candidate.evidence;
  return [
    degraded
      ? '⚠️ DEGRADED ANALYSIS — Conductor\'s reasoning was unavailable; this is a rule-based suggestion that needs manual review.\n\n'
      : '',
    rec.reason,
    rec.expected_value ? `\n\nExpected value: ${rec.expected_value}` : '',
    `\n\nEvidence:`,
    `\n- Fresh required connectors: ${ev.fresh_connectors.join(', ') || 'none'}`,
    ev.linked_goal_title ? `\n- Linked goal: ${ev.linked_goal_title}` : '',
    ev.linked_signal_ids.length ? `\n- Open signals in its data area: ${ev.linked_signal_ids.length}` : '',
    ev.unmet_capability ? `\n- Unmet capability: ${ev.unmet_capability}` : '',
    ev.roi_score != null ? `\n- ROI score: ${ev.roi_score.toFixed(2)}` : '',
    ev.prior_trials > 0 ? `\n- Prior trials here: ${ev.prior_trials} (successful ${ev.prior_success}, unsuccessful ${ev.prior_unsuccessful})` : '',
    rec.trial_plan ? `\n\nTrial plan (${rec.trial_plan.measurement_window_days} days): ${rec.trial_plan.evidence_deliverable}` : '',
    candidate.preferred.length > 0
      ? `\n\nOptional connectors (${candidate.preferred_met.length}/${candidate.preferred.length} connected): ${candidate.preferred.join(', ')}`
      : '',
  ].filter(Boolean).join('');
}

/**
 * Notification. business_id is set explicitly so a dashboard notification for
 * one business is never surfaced to another (#55), and a degraded analysis
 * says so in the body (#47).
 */
async function notifyProposals(businessId: string, count: number, degraded: boolean): Promise<void> {
  const payload = {
    business_id: businessId,
    severity: degraded ? 'warning' : 'info',
    title: degraded
      ? `Conductor suggests ${count} agent${count > 1 ? 's' : ''} — reasoning unavailable`
      : `Conductor recommends ${count} new agent${count > 1 ? 's' : ''}`,
    body: degraded
      ? 'Conductor\'s reasoning provider was unavailable, so these are rule-based suggestions only, not a judgement. '
        + 'Review the evidence carefully under Tasks before approving.'
      : 'Based on your connected data sources, new specialist agents may be worth hiring. Review under Tasks.',
  };
  try {
    if (deps.notify) { await deps.notify(payload); return; }
    const { dispatchToAll } = await import('../notifications/dispatcher.js') as unknown as {
      dispatchToAll: (channels: string[], n: Record<string, unknown>) => Promise<unknown>;
    };
    await dispatchToAll(['dashboard'], payload);
  } catch (err) {
    console.warn('[hiring] proposal notification failed:', (err as Error).message);
  }
}

// ─── Scheduled sweep (#46 trigger coordination, #52 fault isolation) ─────────

/**
 * Run a hiring analysis for every business. One business's provider failure,
 * lease contention or internal error must never stop the sweep — each is
 * isolated and reported independently.
 */
export async function runScheduledHiringSweep(
  businessIds: string[],
): Promise<Array<{ business_id: string; status: string; terminal_reason: string; proposed: number; error: string | null }>> {
  const out: Array<{ business_id: string; status: string; terminal_reason: string; proposed: number; error: string | null }> = [];
  for (const businessId of businessIds) {
    try {
      const r = await analyseAndProposeHires(businessId, {
        trigger: 'scheduled',
        triggerReason: 'scheduled hiring review',
      });
      out.push({
        business_id: businessId, status: r.status, terminal_reason: r.terminal_reason,
        proposed: r.proposed_hires, error: r.error,
      });
    } catch (err) {
      out.push({
        business_id: businessId, status: 'failed', terminal_reason: 'internal_error',
        proposed: 0, error: (err as Error).message.slice(0, 200),
      });
    }
  }
  return out;
}

export { getAnalysisRun };
