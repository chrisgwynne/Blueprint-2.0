/**
 * Candidate gating — the "should we even be considering this?" layer.
 *
 * Before this existed, a candidate was admitted purely because every required
 * connector row had status='connected' (conductor-hiring.ts:152-187). A
 * connector that had never synced, whose data was months stale, that related
 * to nothing the business was working on, and whose role a previously-hired
 * agent already covered, all passed identically.
 *
 * Gates implemented here:
 *   #48 freshness, business-scoped relevance (goal / material signal / unmet
 *       capability), WIP + capacity, existing coverage, ROI/expected impact.
 *   #50 prior-decision memory: hard suppression, temporary deferral, and
 *       "changed circumstances" which requires materially NEW evidence before
 *       a previously-rejected role may be proposed again.
 *   #51/#56 outcome history: a role whose prior trials produced nothing
 *       useful is not re-proposed, and an open trial blocks a duplicate hire.
 */

import { createHash } from 'node:crypto';
import {
  countOpenProposals, getActiveGoals, getLatestDecisionByTemplate,
  getOutcomeHistory, getRecentMaterialSignals,
} from './store.js';
import type {
  Candidate, ConnectorEvidence, GatedCandidate, HiringDecisionRecord, TrialPlan,
} from './types.js';

/** How far back a signal still counts as "material" evidence for a hire. */
const SIGNAL_LOOKBACK_HOURS = 24 * 14;
/** Below this ROI score a candidate is not worth an LLM call, let alone a hire. */
const MIN_ROI_SCORE = 0.2;

export interface GateContext {
  businessId: string;
  connectors: ConnectorEvidence[];
  /** Template ids this business has installed, mapped to their required connectors. */
  installedRequirements: Map<string, string[]>;
  maxOpenProposals: number;
}

function parseSqlDate(value: string | null): number | null {
  if (!value) return null;
  const ts = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Stable hash of the evidence behind a candidate. Two analyses produce the
 * same fingerprint when nothing that justified the hire has changed — which
 * is exactly the test for "is this new evidence?" when reconsidering a
 * previously-rejected role (#50).
 */
export function fingerprintEvidence(e: GatedCandidate['evidence']): string {
  return createHash('sha256').update(JSON.stringify({
    fc: [...e.fresh_connectors].sort(),
    g: e.linked_goal_id ?? null,
    s: [...e.linked_signal_ids].sort().slice(0, 20),
    u: e.unmet_capability ?? null,
    cov: [...e.existing_coverage].sort(),
  })).digest('hex').slice(0, 32);
}

export interface SuppressionVerdict {
  suppressed: boolean;
  reason: string | null;
  decision: HiringDecisionRecord | null;
}

/**
 * Apply a prior negative decision to a candidate (#50).
 *
 *   hard_suppression      — never re-propose until a human clears it.
 *   temporary_deferral    — re-propose only after `expires_at`.
 *   changed_circumstances — re-propose only when the evidence fingerprint
 *                           differs from the one recorded at rejection.
 */
export function evaluateSuppression(
  decision: HiringDecisionRecord | undefined,
  evidenceFingerprint: string,
): SuppressionVerdict {
  if (!decision) return { suppressed: false, reason: null, decision: null };
  if (decision.decision !== 'rejected' && decision.decision !== 'deferred') {
    return { suppressed: false, reason: null, decision };
  }

  const expiresAt = parseSqlDate(decision.expires_at);
  const expired = expiresAt != null && expiresAt <= Date.now();

  switch (decision.disposition) {
    case 'hard_suppression':
      return decision.reconsider_policy === 'after_expiry' && expired
        ? { suppressed: false, reason: null, decision }
        : { suppressed: true, reason: 'hard_suppression', decision };

    case 'temporary_deferral':
      if (expiresAt == null) return { suppressed: true, reason: 'temporary_deferral', decision };
      return expired
        ? { suppressed: false, reason: null, decision }
        : { suppressed: true, reason: 'temporary_deferral', decision };

    case 'changed_circumstances':
    default: {
      if (decision.reconsider_policy === 'never') {
        return { suppressed: true, reason: 'hard_suppression', decision };
      }
      if (decision.reconsider_policy === 'after_expiry') {
        return expired
          ? { suppressed: false, reason: null, decision }
          : { suppressed: true, reason: 'temporary_deferral', decision };
      }
      // 'new_evidence': identical evidence means nothing has changed since the
      // human said no, so the answer is still no.
      if (decision.evidence_fingerprint && decision.evidence_fingerprint === evidenceFingerprint) {
        return { suppressed: true, reason: 'no_new_evidence_since_rejection', decision };
      }
      if (!decision.evidence_fingerprint) {
        // A rejection recorded without an evidence snapshot cannot prove
        // anything changed — treat it as binding until it expires.
        return expired
          ? { suppressed: false, reason: null, decision }
          : { suppressed: true, reason: 'no_new_evidence_since_rejection', decision };
      }
      return { suppressed: false, reason: null, decision };
    }
  }
}

export interface GateResult {
  admitted: GatedCandidate[];
  rejected: GatedCandidate[];
  suppressed: Array<{ template_id: string; reason: string }>;
}

/**
 * Run every candidate through the evidence gates. Returns admitted and
 * rejected candidates separately — a rejected candidate is never sent to the
 * LLM and never proposed, but its gate failures are recorded so an operator
 * can see WHY the engine declined.
 */
export function gateCandidates(ctx: GateContext, candidates: Candidate[]): GateResult {
  const goals = getActiveGoals(ctx.businessId);
  const signals = getRecentMaterialSignals(ctx.businessId, SIGNAL_LOOKBACK_HOURS);
  const decisions = getLatestDecisionByTemplate(ctx.businessId);
  const openProposals = countOpenProposals(ctx.businessId);

  const freshTypes = new Set(ctx.connectors.filter((c) => c.fresh).map((c) => c.type));
  const staleTypes = new Set(ctx.connectors.filter((c) => !c.fresh).map((c) => c.type));
  const connectorById = new Map(ctx.connectors.map((c) => [c.id, c]));

  // Connector types already covered by an agent this business has installed.
  const coveredTypes = new Set<string>();
  for (const reqs of ctx.installedRequirements.values()) for (const t of reqs) coveredTypes.add(t);

  const admitted: GatedCandidate[] = [];
  const rejected: GatedCandidate[] = [];
  const suppressed: Array<{ template_id: string; reason: string }> = [];

  for (const c of candidates) {
    const freshRequired = c.required.filter((t) => freshTypes.has(t));
    const staleRequired = c.required.filter((t) => !freshTypes.has(t) && staleTypes.has(t));

    // Relevance: signals that came from a connector type this candidate needs.
    const relevantSignals = signals.filter((s) => {
      const conn = s.connector_id ? connectorById.get(s.connector_id) : undefined;
      return !!conn && c.required.includes(conn.type);
    });

    // Relevance: a goal whose tracked metric names one of the candidate's
    // required connector types (e.g. metric_name 'ga4.sessions' ↔ 'ga4').
    const linkedGoal = goals.find((g) =>
      !!g.metric_name && c.required.some((t) => g.metric_name!.toLowerCase().includes(t.toLowerCase()))
    ) ?? null;

    // Explicit unmet capability: a required connector type no installed agent
    // for THIS business currently covers.
    const unmet = c.required.find((t) => !coveredTypes.has(t)) ?? null;

    const existingCoverage = [...ctx.installedRequirements.entries()]
      .filter(([, reqs]) => c.required.length > 0 && c.required.every((t) => reqs.includes(t)))
      .map(([id]) => id);

    const history = getOutcomeHistory(ctx.businessId, c.id);

    const evidence: GatedCandidate['evidence'] = {
      fresh_connectors: freshRequired,
      stale_connectors: staleRequired,
      linked_goal_id: linkedGoal?.id ?? null,
      linked_goal_title: linkedGoal?.title ?? null,
      linked_signal_ids: relevantSignals.map((s) => s.id).slice(0, 20),
      unmet_capability: unmet,
      open_wip: openProposals,
      wip_limit: ctx.maxOpenProposals,
      existing_coverage: existingCoverage,
      prior_trials: history.total,
      prior_success: history.successful,
      prior_unsuccessful: history.unsuccessful,
      expected_impact: null,
      roi_score: null,
    };

    const failures: string[] = [];

    // ── Gate 1: freshness. Every required connector must have FRESH data.
    // `status='connected'` on a connector that has never synced (or whose last
    // sync is ancient) is not evidence of anything.
    if (c.required.length > 0 && freshRequired.length < c.required.length) {
      failures.push(staleRequired.length > 0 ? 'stale_required_connector_data' : 'missing_fresh_required_connector_data');
    }
    // A candidate with no required connectors at all needs at least one fresh
    // connector in the business before it has any data to work with.
    if (c.required.length === 0 && freshTypes.size === 0) {
      failures.push('no_fresh_business_data');
    }

    // ── Gate 2: business-scoped relevance. A hire must attach to something
    // the business is actually doing.
    if (!linkedGoal && relevantSignals.length === 0 && !unmet) {
      failures.push('no_linked_goal_signal_or_unmet_capability');
    }

    // ── Gate 3: existing coverage. Don't hire a second agent for work an
    // already-hired agent covers.
    if (existingCoverage.length > 0) failures.push('already_covered_by_installed_agent');

    // ── Gate 4: WIP / capacity.
    if (openProposals >= ctx.maxOpenProposals) failures.push('hiring_wip_limit_reached');

    // ── Gate 5: historical outcomes (#51/#56). An open trial means we are
    // still measuring the last attempt; a run of unsuccessful trials with no
    // successes means the evidence says this role does not pay off here.
    if (history.open > 0) failures.push('prior_trial_still_open');
    if (history.unsuccessful > 0 && history.successful === 0) failures.push('prior_trials_unsuccessful');
    if (history.insufficient_data >= 2 && history.successful === 0) failures.push('prior_trials_produced_no_evidence');

    // ── Gate 6: ROI / expected impact.
    const roi = scoreROI({ evidence, history, freshRequiredCount: freshRequired.length, requiredCount: c.required.length });
    evidence.roi_score = roi.score;
    evidence.expected_impact = roi.expected_impact;
    if (roi.score < MIN_ROI_SCORE) failures.push('roi_below_threshold');

    const fingerprint = fingerprintEvidence(evidence);
    const gated: GatedCandidate = {
      ...c, admitted: failures.length === 0, gate_failures: failures,
      evidence, evidence_fingerprint: fingerprint,
    };

    // ── Gate 7: prior human decision (#50). Checked last so the fingerprint
    // reflects the full evidence set.
    const verdict = evaluateSuppression(decisions.get(c.id), fingerprint);
    if (verdict.suppressed) {
      suppressed.push({ template_id: c.id, reason: verdict.reason ?? 'suppressed' });
      gated.admitted = false;
      gated.gate_failures = [...failures, `suppressed:${verdict.reason}`];
      rejected.push(gated);
      continue;
    }

    (gated.admitted ? admitted : rejected).push(gated);
  }

  return { admitted, rejected, suppressed };
}

function scoreROI(input: {
  evidence: GatedCandidate['evidence'];
  history: ReturnType<typeof getOutcomeHistory>;
  freshRequiredCount: number;
  requiredCount: number;
}): { score: number; expected_impact: string | null } {
  const { evidence, history } = input;
  let score = 0;
  const parts: string[] = [];

  // Fresh data behind every requirement is the baseline for any value at all.
  if (input.requiredCount === 0 || input.freshRequiredCount === input.requiredCount) {
    score += 0.3;
  } else if (input.freshRequiredCount > 0) {
    score += 0.1;
  }

  if (evidence.linked_goal_id) {
    score += 0.3;
    parts.push(`supports active goal "${evidence.linked_goal_title ?? evidence.linked_goal_id}"`);
  }
  const signalCount = evidence.linked_signal_ids.length;
  if (signalCount > 0) {
    score += Math.min(0.25, 0.05 * signalCount);
    parts.push(`${signalCount} open signal${signalCount === 1 ? '' : 's'} in its data area`);
  }
  if (evidence.unmet_capability) {
    score += 0.15;
    parts.push(`no hired agent currently covers ${evidence.unmet_capability}`);
  }
  if (history.successful > 0) {
    score += 0.15;
    parts.push(`${history.successful} prior successful trial${history.successful === 1 ? '' : 's'}`);
  }
  if (history.unsuccessful > 0) {
    score -= 0.3 * history.unsuccessful;
    parts.push(`${history.unsuccessful} prior unsuccessful trial${history.unsuccessful === 1 ? '' : 's'}`);
  }
  if (evidence.existing_coverage.length > 0) score -= 0.4;

  return {
    score: Math.max(0, Math.min(1, score)),
    expected_impact: parts.length ? parts.join('; ') : null,
  };
}

/**
 * Build the bounded trial/activation plan a hire must carry before it can be
 * proposed (#51). Returns null when no measurable outcome can be defined —
 * in which case the hire is NOT proposed, because there would be no way to
 * tell later whether it was worth it.
 */
export function buildTrialPlan(
  businessId: string,
  candidate: GatedCandidate,
  windowDays = 14,
): TrialPlan | null {
  const goals = getActiveGoals(businessId);
  const goal = candidate.evidence.linked_goal_id
    ? goals.find((g) => g.id === candidate.evidence.linked_goal_id) ?? null
    : null;

  const signalId = candidate.evidence.linked_signal_ids[0] ?? null;

  // A trial needs a target: either a goal metric to move, or a concrete
  // signal to resolve, or an explicitly unmet capability to demonstrate.
  if (!goal && !signalId && !candidate.evidence.unmet_capability) return null;

  const deliverable = goal
    ? `Within ${windowDays} days, produce evidence of movement on "${goal.title}"${goal.metric_name ? ` (${goal.metric_name})` : ''}.`
    : signalId
      ? `Within ${windowDays} days, produce a substantiated finding or proposed action addressing signal ${signalId}.`
      : `Within ${windowDays} days, produce at least one substantiated finding from ${candidate.evidence.unmet_capability} data that no currently hired agent could produce.`;

  return {
    goal_id: goal?.id ?? null,
    signal_id: signalId,
    target_metric: goal?.metric_name ?? null,
    baseline_value: goal?.metric_current ?? goal?.metric_baseline ?? null,
    target_value: goal?.metric_target ?? null,
    measurement_window_days: windowDays,
    evidence_deliverable: deliverable,
  };
}
