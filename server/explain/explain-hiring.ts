/**
 * Explain a hiring decision (issue #60).
 *
 * The hiring engine is the most mature "explain a decision" surface in the
 * codebase already: #53's contract.ts records the trigger and its reason,
 * the input snapshot with connector freshness, the gate failures, the
 * suppressed templates, the provider provenance and a documented terminal
 * reason for every outcome. This file therefore adds NO new computation —
 * it maps that contract onto the shared explanation shape so a hiring
 * decision reads identically to a task decision in the same panel.
 *
 * Two subjects:
 *
 *   hiring_analysis   — one analysis run. Its terminal_reason is the
 *                       honest answer to "why did nothing get hired?", and
 *                       every no-op reason (cooldown, no fresh evidence,
 *                       all suppressed, dry run) becomes its own
 *                       disposition rather than an empty panel.
 *
 *   hiring_candidate  — one agent template. This is where the suppression
 *                       memory of #44/#50 is surfaced: a candidate blocked
 *                       by a prior operator rejection is a first-class
 *                       explainable outcome, complete with the disposition
 *                       that binds it and when it may be reconsidered.
 */

import {
  getAnalysisContract, listAnalysisContracts, type HiringAnalysisContract,
} from '../agents/hiring/contract.js';
import { resolveHiringPolicy } from '../agents/hiring/policy.js';
import { getLatestDecisionByTemplate, getCoordination } from '../agents/hiring/store.js';
import { evaluateSuppression } from '../agents/hiring/gates.js';
import { resolveOperatingPolicy } from '../policy/operating-policy.js';
import type { HiringDecisionRecord } from '../agents/hiring/types.js';
import {
  type Explanation, type ExplanationAlternative, type ExplanationDisposition,
  type ExplanationLink, type ExplanationPolicy, type ExplanationTrigger,
  type EvidenceItem,
  evidenceItem, summariseEvidence, finaliseExplanation, noAction, noOutcome,
} from './explanation.js';

/**
 * Terminal reason → what kind of story it is. Every documented reason in
 * #53's TERMINAL_REASONS appears here, so a hiring run can never fall into
 * a generic "unknown" bucket.
 */
const TERMINAL_DISPOSITION: Record<string, ExplanationDisposition> = {
  proposals_created: 'acted',
  no_proposals: 'no_op',
  no_active_connectors: 'no_op',
  no_candidates: 'no_op',
  no_fresh_evidence: 'no_op',
  all_already_proposed: 'no_op',
  all_suppressed: 'suppressed',
  all_gated: 'no_op',
  hiring_disabled: 'suppressed',
  dry_run: 'no_op',
  cooldown: 'no_op',
  no_material_change: 'no_op',
  coalesced: 'no_op',
  lease_held: 'no_op',
  duplicate_trigger: 'no_op',
  provider_failure: 'failed',
  reasoning_unavailable: 'failed',
  stale_run_reconciled: 'failed',
  internal_error: 'failed',
  business_not_found: 'failed',
};

const TRIGGER_KIND: Record<string, ExplanationTrigger['kind']> = {
  connector_sync: 'external_event',
  signal: 'signal',
  scheduler: 'schedule',
  schedule: 'schedule',
  onboarding: 'human_request',
  manual: 'human_request',
  dashboard: 'human_request',
  bap: 'external_event',
};

// ─── Analysis run ────────────────────────────────────────────────────────────

export function explainHiringAnalysis(businessId: string, analysisId: string): Explanation | null {
  const contract = getAnalysisContract(businessId, analysisId);
  if (!contract) return null;
  return explanationFromContract(businessId, contract);
}

/** Explain whatever the most recent hiring analysis decided. */
export function explainLatestHiringAnalysis(businessId: string): Explanation | null {
  const [latest] = listAnalysisContracts(businessId, 1);
  return latest ? explanationFromContract(businessId, latest) : null;
}

function explanationFromContract(businessId: string, c: HiringAnalysisContract): Explanation {
  const hiringPolicy = resolveHiringPolicy(businessId);
  const operating = resolveOperatingPolicy(businessId);

  const disposition: ExplanationDisposition = c.status === 'running'
    ? 'in_progress'
    : TERMINAL_DISPOSITION[c.terminal_reason ?? ''] ?? (c.status === 'failed' ? 'failed' : 'no_op');

  // ── Trigger ───────────────────────────────────────────────────────────────
  const trigger: ExplanationTrigger = {
    kind: TRIGGER_KIND[c.trigger.source] ?? 'unknown',
    summary: c.trigger.reason
      ? `Hiring analysis was triggered by ${c.trigger.source}: ${c.trigger.reason}`
      : `Hiring analysis was triggered by ${c.trigger.source}. No reason was recorded with the trigger.`,
    ref: c.trigger.ref ? { type: c.trigger.source, id: c.trigger.ref, label: null } : null,
    occurred_at: c.started_at,
    actor: c.trigger.source,
    unattributed: false,
  };

  // ── Evidence — straight out of the #53 input snapshot ─────────────────────
  const fresh = c.input.freshness.fresh_connector_count;
  const stale = c.input.freshness.stale_connector_count;
  const items: EvidenceItem[] = [
    evidenceItem({
      key: 'fresh_connectors',
      label: 'Connectors with fresh data',
      // Zero fresh connectors is a NEGATIVE finding — we counted and the
      // answer was none — not a missing one. That distinction is why the
      // engine could honestly conclude "no fresh evidence".
      quality: fresh == null ? 'missing' : fresh > 0 ? 'fresh' : 'negative',
      value: fresh ?? undefined,
      reason: 'The analysis did not record a fresh-connector count.',
      source: `hiring_analysis_runs#${c.analysis_id}.input_snapshot`,
      observed_at: c.started_at,
      caveat: fresh === 0 ? 'No connector had data inside the freshness window, so there was nothing current to reason from.' : null,
    }),
    evidenceItem({
      key: 'stale_connectors',
      label: 'Connectors with stale data',
      quality: stale == null ? 'missing' : stale > 0 ? 'stale' : 'fresh',
      value: stale ?? undefined,
      reason: 'The analysis did not record a stale-connector count.',
      source: `hiring_analysis_runs#${c.analysis_id}.input_snapshot`,
      observed_at: c.started_at,
      caveat: (stale ?? 0) > 0 ? `${stale} connector(s) were outside the ${c.input.freshness.max_age_hours ?? hiringPolicy.freshness_max_age_hours}h freshness window.` : null,
    }),
    evidenceItem({
      key: 'input_snapshot',
      label: 'Input snapshot',
      quality: Object.keys(c.input.snapshot ?? {}).length ? 'fresh' : 'missing',
      value: Object.keys(c.input.snapshot ?? {}).length ? c.input.snapshot : undefined,
      reason: 'No input snapshot was persisted for this analysis, so its inputs cannot be replayed.',
      source: `hiring_analysis_runs#${c.analysis_id}.input_snapshot`,
      observed_at: c.started_at,
    }),
    evidenceItem({
      key: 'candidates_considered',
      label: 'Candidate templates considered',
      quality: c.decision.candidates_considered > 0 ? 'fresh' : 'negative',
      value: c.decision.candidates_considered,
      source: `hiring_analysis_runs#${c.analysis_id}`,
      caveat: c.decision.candidates_considered === 0
        ? 'No uninstalled template had its required connectors available, so there was nothing to choose between.'
        : null,
    }),
    evidenceItem({
      key: 'reasoning_provider',
      label: 'Reasoning provider',
      quality: c.degraded ? 'degraded' : c.provenance.provider ? 'fresh' : 'missing',
      value: c.provenance.provider
        ? { provider: c.provenance.provider, model: c.provenance.model, status: c.provenance.provider_status, attempts: c.provenance.provider_attempts }
        : undefined,
      reason: 'No reasoning provider is recorded — the analysis terminated before reasoning ran.',
      source: `hiring_analysis_runs#${c.analysis_id}.provider`,
      caveat: c.degraded ? `Reasoning was degraded (${c.fallback_mode ?? 'fallback mode not recorded'}).` : null,
    }),
  ];
  const evidence = summariseEvidence(items, c.started_at);

  // ── Policy ────────────────────────────────────────────────────────────────
  const policy: ExplanationPolicy = {
    policy_id: operating.policy_id,
    policy_version: operating.policy_version,
    policy_scope: operating.policy_scope,
    citation: `${operating.citation}; hiring control plane (contract ${c.contract_version})`,
    // The hiring run stores its OWN control-plane settings but not the
    // operating-policy version, so the operating-policy half is the current
    // one and is labelled as such.
    reconstructed_from_current: true,
    provisions: [
      { name: 'hiring.enabled', value: String(hiringPolicy.enabled), effect: hiringPolicy.enabled ? 'Autonomous hiring is switched on for this business.' : `Autonomous hiring is switched OFF${hiringPolicy.disabled_reason ? `: ${hiringPolicy.disabled_reason}` : '.'}` },
      { name: 'hiring.dry_run', value: String(hiringPolicy.dry_run), effect: hiringPolicy.dry_run ? 'Dry run: decisions are evaluated and recorded but nothing is created.' : 'Live: proposals may be created.' },
      { name: 'hiring.cooldown_minutes', value: String(hiringPolicy.cooldown_minutes), effect: `Analyses for one business are paced at least ${hiringPolicy.cooldown_minutes} minutes apart.` },
      { name: 'hiring.max_open_proposals', value: String(hiringPolicy.max_open_proposals), effect: `At most ${hiringPolicy.max_open_proposals} hire proposals may be open at once.` },
      { name: 'hiring.freshness_max_age_hours', value: String(hiringPolicy.freshness_max_age_hours), effect: `Connector data older than ${hiringPolicy.freshness_max_age_hours}h does not count as evidence for a hire.` },
      { name: 'hiring.allow_deterministic_fallback', value: String(hiringPolicy.allow_deterministic_fallback), effect: hiringPolicy.allow_deterministic_fallback ? 'A gated deterministic fallback may run when reasoning is unavailable.' : 'When reasoning is unavailable, NO proposals are created — there is no fallback.' },
    ],
  };

  // ── Alternatives: gated + suppressed candidates ───────────────────────────
  const alternatives: ExplanationAlternative[] = [
    ...c.decision.gated.map((g) => ({
      id: g.template_id,
      label: g.template_id,
      disposition: 'gated' as const,
      reason: g.failures?.length
        ? `Failed ${g.failures.length} gate(s): ${g.failures.join('; ')}.`
        : 'Failed an evidence, coverage, WIP, ROI or outcome gate; the specific failures were not recorded.',
      reconsider: null,
      source: `hiring_analysis_runs#${c.analysis_id}.diagnostics.gated`,
    })),
    ...c.decision.suppressed.map((s) => ({
      id: s.template_id,
      label: s.template_id,
      disposition: 'suppressed' as const,
      reason: `Suppressed by a prior operator decision (${s.reason}).`,
      reconsider: null,
      source: `hiring_analysis_runs#${c.analysis_id}.diagnostics.suppressed`,
    })),
  ];

  // ── Headline ──────────────────────────────────────────────────────────────
  const headline = c.terminal_reason
    ? `${c.terminal_reason_description ?? c.terminal_reason}${c.decision.proposals_created ? ` ${c.decision.proposals_created} proposal(s) created.` : ''}`
    : c.status === 'running'
      ? 'The analysis is still running; nothing has been decided yet.'
      : 'The analysis finished without recording a terminal reason.';

  // ── Confidence — degradation is the headline fact here (#47) ──────────────
  const confidenceLimitations: string[] = [];
  if (c.provenance.provider_attempts > 1) {
    confidenceLimitations.push(`The reasoning provider needed ${c.provenance.provider_attempts} attempts.`);
  }
  if (c.coalesced_into) {
    confidenceLimitations.push(`This run was folded into analysis ${c.coalesced_into}; its conclusions are that run's, not this one's.`);
  }

  const links: ExplanationLink[] = c.decision.proposal_ids.map((id) => ({
    rel: 'task' as const, label: 'Hire proposal', id, href: '/tasks',
  }));
  if (c.coalesced_into) {
    links.push({ rel: 'hiring_analysis', label: 'Coalesced into', id: c.coalesced_into, href: '/agents' });
  }
  if (policy.policy_id) links.push({ rel: 'policy', label: policy.citation, id: policy.policy_id, href: '/policy' });

  return finaliseExplanation({
    subject: {
      kind: 'hiring_analysis',
      id: c.analysis_id,
      business_id: businessId,
      title: `Hiring analysis ${c.analysis_id}`,
      source_record: `hiring_analysis_runs#${c.analysis_id}`,
      created_at: c.started_at,
    },
    headline,
    disposition,
    trigger,
    evidence,
    policy,
    confidence: {
      // The hiring contract records per-recommendation confidence, not a
      // run-level one. Inventing an average would be exactly the kind of
      // fabricated number this schema exists to prevent.
      value: null,
      basis: 'none',
      interpretation: 'A hiring run has no single confidence score. Confidence is recorded per recommendation, not per analysis.',
      limitations: confidenceLimitations,
      degraded: c.degraded,
      degraded_reason: c.degraded
        ? `Reasoning was unavailable or failed; the run fell back to '${c.fallback_mode ?? 'an unrecorded fallback mode'}'.`
        : null,
      causal_claim: 'not_established',
      causal_claim_meaning: '',
    },
    alternatives,
    action: c.decision.proposals_created > 0
      ? {
          receipt_id: null,
          state: 'proposed',
          result_status: 'pending',
          stages: [{ stage: 'requested', reached: true, at: c.completed_at ?? c.started_at, by: c.trigger.source, detail: `${c.decision.proposals_created} hire proposal(s) created.` }],
          blocked_by: null,
          external: null,
          attempts: 1,
          anomalies: [],
          summary: `${c.decision.proposals_created} hire proposal(s) were created. Each is a separate task that still needs its own approval — nothing was hired by this run alone.`,
        }
      : noAction(
          c.terminal_reason === 'dry_run'
            ? 'Nothing was created: the run was in dry-run mode, so decisions were evaluated and persisted but no proposals were made.'
            : `Nothing was created. ${c.terminal_reason_description ?? 'No terminal reason was recorded.'}`,
        ),
    outcome: noOutcome('A hiring analysis has no measurable outcome of its own; outcomes are measured per hired agent trial.'),
    links,
    limitations: [
      ...(c.error ? [`The run recorded an error: ${c.error}`] : []),
      ...(c.status === 'running' ? ['This analysis has not finished; anything shown here may change.'] : []),
    ],
  });
}

// ─── Candidate (template) ────────────────────────────────────────────────────

/**
 * Explain what happened to one agent template — most importantly, why it is
 * NOT being recommended. A suppressed candidate is the canonical no-op that
 * an operator most needs explained: something they rejected once is being
 * silently withheld, and they are entitled to know that, by whom, and until
 * when.
 */
export function explainHiringCandidate(businessId: string, templateId: string): Explanation | null {
  const decisions = getLatestDecisionByTemplate(businessId);
  const decision: HiringDecisionRecord | undefined = decisions.get(templateId);
  const [latestRun] = listAnalysisContracts(businessId, 1);
  const hiringPolicy = resolveHiringPolicy(businessId);
  const operating = resolveOperatingPolicy(businessId);
  const coord = getCoordination(businessId);

  // Diagnostics from the most recent run that mentioned this template.
  const runs = listAnalysisContracts(businessId, 10);
  const mentioning = runs.find((r) =>
    r.decision.gated.some((g) => g.template_id === templateId)
    || r.decision.suppressed.some((s) => s.template_id === templateId));
  const gateEntry = mentioning?.decision.gated.find((g) => g.template_id === templateId) ?? null;
  const suppressedEntry = mentioning?.decision.suppressed.find((s) => s.template_id === templateId) ?? null;

  // Nothing whatsoever is recorded about this template. That is itself an
  // honest answer, and it is returned rather than a 404, because "we have
  // never considered this" is exactly the kind of thing an operator asks.
  const neverConsidered = !decision && !mentioning;

  // The suppression verdict, evaluated the same way the engine evaluates it.
  // Passing an empty fingerprint deliberately cannot match a stored one, so
  // a 'new_evidence' suppression reports as still binding unless the engine
  // itself has already cleared it — the honest, conservative reading.
  const verdict = evaluateSuppression(decision, '');

  let disposition: ExplanationDisposition;
  let headline: string;
  if (verdict.suppressed) {
    disposition = 'suppressed';
    headline = `Not being recommended: a prior decision (${decision!.disposition.replace(/_/g, ' ')}) suppresses this candidate — ${verdict.reason?.replace(/_/g, ' ')}.`;
  } else if (decision?.decision === 'approved') {
    disposition = 'acted';
    headline = `This candidate was approved${decision.task_id ? ` and became task ${decision.task_id}` : ''}.`;
  } else if (decision?.decision === 'deferred') {
    disposition = 'deferred';
    headline = 'This candidate was deferred rather than refused. It may be re-proposed.';
  } else if (gateEntry) {
    disposition = 'no_op';
    headline = `Not proposed: it failed ${gateEntry.failures?.length ?? 0} gate(s) in the last analysis that considered it.`;
  } else if (suppressedEntry) {
    disposition = 'suppressed';
    headline = `Not proposed: suppressed in the last analysis (${suppressedEntry.reason}).`;
  } else if (neverConsidered) {
    disposition = 'no_op';
    headline = 'No hiring analysis has ever recorded a decision about this candidate.';
  } else {
    disposition = 'awaiting_decision';
    headline = 'This candidate is eligible and has no blocking decision against it.';
  }

  // ── Trigger ───────────────────────────────────────────────────────────────
  const trigger: ExplanationTrigger = decision
    ? {
        kind: /^(human|user|dashboard)/i.test(decision.actor) ? 'human_request' : 'agent_run',
        summary: `${decision.actor} recorded a '${decision.decision}' decision about this candidate on ${decision.decided_at}.`,
        ref: decision.analysis_id ? { type: 'hiring_analysis', id: decision.analysis_id, label: null } : null,
        occurred_at: decision.decided_at,
        actor: decision.actor,
        unattributed: false,
      }
    : mentioning
      ? {
          kind: TRIGGER_KIND[mentioning.trigger.source] ?? 'unknown',
          summary: `Considered during hiring analysis ${mentioning.analysis_id}, triggered by ${mentioning.trigger.source}.`,
          ref: { type: 'hiring_analysis', id: mentioning.analysis_id, label: null },
          occurred_at: mentioning.started_at,
          actor: mentioning.trigger.source,
          unattributed: false,
        }
      : {
          kind: 'unknown',
          summary: 'No trigger applies: nothing has ever caused this candidate to be evaluated.',
          ref: null,
          occurred_at: null,
          actor: null,
          unattributed: true,
        };

  // ── Evidence ──────────────────────────────────────────────────────────────
  const items: EvidenceItem[] = [
    evidenceItem({
      key: 'prior_decision',
      label: 'Prior operator decision',
      // A recorded rejection is a NEGATIVE finding (a real, deliberate
      // "no"), never a missing one.
      quality: decision ? 'negative' : 'missing',
      value: decision
        ? {
            decision: decision.decision,
            disposition: decision.disposition,
            actor: decision.actor,
            reason: decision.reason,
            decided_at: decision.decided_at,
            reconsider_policy: decision.reconsider_policy,
            expires_at: decision.expires_at,
          }
        : undefined,
      reason: 'No operator has ever recorded a decision about this candidate.',
      source: decision ? `hiring_decisions#${decision.id}` : null,
      observed_at: decision?.decided_at ?? null,
      caveat: decision ? `A person or agent explicitly decided '${decision.decision}' here. This is a finding, not a gap.` : null,
    }),
    evidenceItem({
      key: 'evidence_fingerprint',
      label: 'Evidence fingerprint at rejection',
      quality: decision?.evidence_fingerprint ? 'fresh' : 'missing',
      value: decision?.evidence_fingerprint ?? undefined,
      reason: decision
        ? 'The rejection was recorded without an evidence snapshot, so Blueprint cannot prove anything has changed since — the suppression stays binding until it expires.'
        : 'There is no prior rejection, so there is no fingerprint to compare against.',
      source: decision ? `hiring_decisions#${decision.id}.evidence_fingerprint` : null,
    }),
    evidenceItem({
      key: 'gate_failures',
      label: 'Gate failures in the last analysis',
      quality: gateEntry ? 'negative' : mentioning ? 'fresh' : 'missing',
      value: gateEntry?.failures ?? (mentioning ? 'No gate failures were recorded for this candidate.' : undefined),
      reason: 'No analysis has evaluated gates for this candidate.',
      source: mentioning ? `hiring_analysis_runs#${mentioning.analysis_id}.diagnostics.gated` : null,
      observed_at: mentioning?.started_at ?? null,
      caveat: gateEntry ? 'These gates are why the candidate was not proposed.' : null,
    }),
    evidenceItem({
      key: 'last_analysis',
      label: 'Most recent hiring analysis',
      quality: latestRun ? 'fresh' : 'missing',
      value: latestRun
        ? { analysis_id: latestRun.analysis_id, status: latestRun.status, terminal_reason: latestRun.terminal_reason, started_at: latestRun.started_at }
        : undefined,
      reason: 'No hiring analysis has ever run for this business.',
      source: latestRun ? `hiring_analysis_runs#${latestRun.analysis_id}` : null,
      observed_at: latestRun?.started_at ?? null,
    }),
  ];
  const evidence = summariseEvidence(items, decision?.decided_at ?? latestRun?.started_at ?? null);

  const policy: ExplanationPolicy = {
    policy_id: operating.policy_id,
    policy_version: operating.policy_version,
    policy_scope: operating.policy_scope,
    citation: `${operating.citation}; hiring control plane`,
    reconstructed_from_current: true,
    provisions: [
      { name: 'hiring.enabled', value: String(hiringPolicy.enabled), effect: hiringPolicy.enabled ? 'Autonomous hiring is switched on.' : 'Autonomous hiring is switched off — no candidate can be proposed automatically.' },
      { name: 'hiring.max_open_proposals', value: String(hiringPolicy.max_open_proposals), effect: `At most ${hiringPolicy.max_open_proposals} hire proposals may be open at once.` },
      {
        name: 'suppression.reconsider_policy',
        value: decision?.reconsider_policy ?? 'not applicable',
        effect: decision
          ? reconsiderEffect(decision)
          : 'No suppression applies to this candidate.',
      },
    ],
  };

  const alternatives: ExplanationAlternative[] = [];
  if (decision && (decision.decision === 'rejected' || decision.decision === 'deferred')) {
    alternatives.push({
      id: templateId,
      label: 'Proposing this candidate now',
      disposition: verdict.suppressed ? 'suppressed' : 'rejected',
      reason: decision.reason ?? `Recorded as '${decision.decision}' by ${decision.actor} with no stated reason.`,
      reconsider: { policy: decision.reconsider_policy, expires_at: decision.expires_at },
      source: `hiring_decisions#${decision.id}`,
    });
  }
  if (gateEntry?.failures?.length) {
    for (const failure of gateEntry.failures) {
      alternatives.push({
        id: templateId,
        label: `Gate: ${failure}`,
        disposition: 'gated',
        reason: failure,
        reconsider: null,
        source: `hiring_analysis_runs#${mentioning!.analysis_id}.diagnostics.gated`,
      });
    }
  }

  const links: ExplanationLink[] = [];
  if (decision?.task_id) links.push({ rel: 'task', label: 'Resulting hire proposal', id: decision.task_id, href: '/tasks' });
  if (decision?.analysis_id) links.push({ rel: 'hiring_analysis', label: 'Deciding analysis', id: decision.analysis_id, href: '/agents' });
  if (latestRun) links.push({ rel: 'hiring_analysis', label: 'Most recent analysis', id: latestRun.analysis_id, href: '/agents' });
  if (policy.policy_id) links.push({ rel: 'policy', label: policy.citation, id: policy.policy_id, href: '/policy' });

  const limitations: string[] = [];
  if (neverConsidered) {
    limitations.push('Nothing is recorded about this candidate. Blueprint is not saying it is unsuitable — it is saying it has never been assessed.');
  }
  if (coord?.next_eligible_at) {
    limitations.push(`The next hiring analysis for this business is not eligible to run until ${coord.next_eligible_at}, so this picture will not change before then.`);
  }

  return finaliseExplanation({
    subject: {
      kind: 'hiring_candidate',
      id: templateId,
      business_id: businessId,
      title: `Hiring candidate ${templateId}`,
      source_record: decision ? `hiring_decisions#${decision.id}` : `agent template ${templateId}`,
      created_at: decision?.decided_at ?? null,
    },
    headline,
    disposition,
    trigger,
    evidence,
    policy,
    confidence: {
      value: null,
      basis: 'none',
      interpretation: 'No confidence score attaches to a suppression or a gate result — these are rule outcomes, not predictions.',
      limitations: [],
      degraded: !!latestRun?.degraded,
      degraded_reason: latestRun?.degraded
        ? `The most recent hiring analysis ran degraded ('${latestRun.fallback_mode ?? 'fallback mode not recorded'}'), so its candidate list is less trustworthy than usual.`
        : null,
      causal_claim: 'not_established',
      causal_claim_meaning: '',
    },
    alternatives,
    action: decision?.task_id
      ? {
          receipt_id: null,
          state: 'proposed',
          result_status: 'pending',
          stages: [{ stage: 'requested', reached: true, at: decision.decided_at, by: decision.actor, detail: `Hire proposal ${decision.task_id} created.` }],
          blocked_by: null,
          external: null,
          attempts: 1,
          anomalies: [],
          summary: `A hire proposal was created (task ${decision.task_id}). It still needed its own approval.`,
        }
      : noAction(
          verdict.suppressed
            ? 'Nothing was requested, and nothing will be while the suppression holds.'
            : 'Nothing was requested for this candidate.',
        ),
    outcome: noOutcome(
      decision?.task_id
        ? 'Any outcome belongs to the resulting hire proposal and its trial, not to this candidate record.'
        : 'No outcome exists: this candidate never became an action.',
    ),
    links,
    limitations,
  });
}

function reconsiderEffect(d: HiringDecisionRecord): string {
  switch (d.reconsider_policy) {
    case 'never':
      return 'This candidate will never be re-proposed automatically. A human must clear the decision.';
    case 'after_expiry':
      return d.expires_at
        ? `This candidate may be re-proposed after ${d.expires_at}.`
        : 'This candidate is set to be re-proposed after expiry, but no expiry date was recorded — so it stays suppressed.';
    case 'new_evidence':
    default:
      return d.evidence_fingerprint
        ? 'This candidate may be re-proposed only when the underlying evidence differs from the snapshot taken at rejection.'
        : 'This candidate may be re-proposed on new evidence, but no evidence snapshot was taken at rejection, so nothing can be proven to have changed.';
  }
}
