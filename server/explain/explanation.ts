/**
 * "Why did Blueprint do this?" — one explanation shape for every kind of
 * autonomous decision (issue #60).
 *
 * ── What this module is, and is not ──────────────────────────────────────
 *
 * This is a PRESENTATION layer. It computes no new facts, scores nothing,
 * and writes nothing. Every value in an Explanation is read out of a record
 * that some other module already authored:
 *
 *   trigger         signals / agent_runs / hiring analysis runs / the human
 *                   who requested it
 *   evidence        decisions.evidence (#61), the hiring evidence snapshot
 *                   (#53), connector freshness, applicability (trust-engine)
 *   policy          decisions.effective_policy_* (#68), or the current
 *                   resolved policy — explicitly distinguished, see below
 *   confidence      the confidence a record ACTUALLY carries (#47's
 *                   degraded/fallback markers included). Never invented.
 *   alternatives    decisions.alternatives_rejected (#66), the hiring
 *                   suppression memory and gate diagnostics (#44/#50)
 *   action state    action receipts (#70)
 *   outcome         the four-state outcome taxonomy (#63)
 *
 * If a module did not record something, the explanation says so. There is
 * no code path here that substitutes a default, an average or a zero.
 *
 * ── The three honesty mechanisms, reused not reinvented ──────────────────
 *
 * 1. ComparableField (#66) is imported verbatim, not re-declared. A field
 *    is `known` (with a citation naming the record behind it), `unknown`
 *    (with the reason the data does not exist) or `not_comparable`. The
 *    panel renders an explanation field and a comparison field identically
 *    because they are literally the same envelope.
 *
 * 2. EvidenceQuality adds the freshness/health axis that #65 established
 *    for connectors, because a value can be perfectly KNOWN and still be
 *    six weeks old. `fresh | stale | degraded | missing | negative |
 *    not_applicable`. Crucially `missing` ("we looked and there is no
 *    record") and `negative` ("we looked, a record exists, and it says no")
 *    are different states — collapsing them is how a system starts
 *    claiming absence of evidence is evidence of absence.
 *
 * 3. CausalClaim caps what the explanation is allowed to assert. An
 *    explanation may only say "this caused that" when an independent
 *    measurement verified it (`verified_causal`); everything else is
 *    `correlational`, `expected_only` or `not_established`. This is the
 *    same calibration posture as #63's taxonomy and #43's evidence gate.
 *
 * ── Redaction ────────────────────────────────────────────────────────────
 *
 * finaliseExplanation() is the single choke point every builder must pass
 * through, and it runs the whole structure through lib/redaction.ts (#70).
 * No builder is trusted to have sanitised its own inputs, because the
 * underlying records (task payloads, provider errors, receipt details) are
 * exactly the places a credential would hide.
 */

import { redactSensitive } from '../lib/redaction.js';
import {
  knownField, unknownField, notComparableField,
  type ComparableField, type FieldState,
} from '../brain/comparison-engine.js';

// The #66 envelope is re-exported so an explanation consumer never has to
// import the comparison engine to read an explanation field.
export { knownField, unknownField, notComparableField };
export type { ComparableField, FieldState };

/** Bump when the shape changes in a way a reader must know about. */
export const EXPLANATION_SCHEMA_VERSION = 'explanation.v1';

// ─── Subject ─────────────────────────────────────────────────────────────────

export type ExplanationSubjectKind =
  /** A proposed/approved/executed task or recommendation. */
  | 'task'
  /** A row in decision memory — including comparison selections and deferrals. */
  | 'decision'
  /** One run of the autonomous hiring analysis. */
  | 'hiring_analysis'
  /** One agent template considered (or suppressed) by hiring. */
  | 'hiring_candidate';

export const EXPLANATION_SUBJECT_KINDS: ExplanationSubjectKind[] = [
  'task', 'decision', 'hiring_analysis', 'hiring_candidate',
];

export interface ExplanationSubject {
  kind: ExplanationSubjectKind;
  id: string;
  business_id: string;
  title: string;
  /** The table/record this explanation is read out of. */
  source_record: string;
  created_at: string | null;
}

// ─── Disposition — what kind of story this is ────────────────────────────────

/**
 * A no-op, a suppression and a deferral are first-class explainable
 * outcomes. "Nothing happened" is a decision with a reason, and this
 * vocabulary makes the panel able to say so rather than rendering an empty
 * timeline.
 */
export type ExplanationDisposition =
  | 'acted'               // something was actually done
  | 'in_progress'         // authorized/executing, not settled
  | 'awaiting_decision'   // proposed; waiting on a human or a gate
  | 'no_op'               // deliberately nothing happened, and that is the answer
  | 'suppressed'          // blocked by a prior operator decision / suppression memory
  | 'deferred'            // consciously postponed; no winner chosen
  | 'rejected'            // a human or a gate said no
  | 'failed';             // it was attempted and did not work

export const DISPOSITION_MEANING: Record<ExplanationDisposition, string> = {
  acted: 'Blueprint carried out an action.',
  in_progress: 'The action was authorised and has not settled yet.',
  awaiting_decision: 'Nothing has been done: this is still waiting on a decision.',
  no_op: 'Blueprint deliberately did nothing, and this explains why.',
  suppressed: 'A prior operator decision blocked this from being raised again.',
  deferred: 'The decision was consciously postponed; no option was chosen.',
  rejected: 'This was refused — either by a human or by a policy gate.',
  failed: 'This was attempted and did not succeed.',
};

// ─── Trigger — what caused this ──────────────────────────────────────────────

export type TriggerKind =
  | 'signal'          // a detected signal
  | 'schedule'        // a scheduled/periodic run
  | 'human_request'   // a person asked for it
  | 'agent_run'       // an agent's reasoning pass produced it
  | 'policy_change'   // a policy version activated
  | 'external_event'  // a webhook/BAP call from outside
  | 'unknown';        // we genuinely cannot attribute it

export interface ExplanationTrigger {
  kind: TriggerKind;
  /** One plain sentence. Never speculative. */
  summary: string;
  /** The record that triggered it, when one is identifiable. */
  ref: { type: string; id: string; label: string | null } | null;
  occurred_at: string | null;
  /** Who/what initiated it — an agent id, a user, 'system:scheduler'. */
  actor: string | null;
  /**
   * True when no trigger could be established from the records. Stated
   * rather than guessed: an unattributed decision is a real finding.
   */
  unattributed: boolean;
}

export function unattributedTrigger(reason: string): ExplanationTrigger {
  return {
    kind: 'unknown',
    summary: reason,
    ref: null,
    occurred_at: null,
    actor: null,
    unattributed: true,
  };
}

// ─── Evidence ────────────────────────────────────────────────────────────────

/**
 * Quality of one piece of evidence, on the freshness/health axis #65
 * established for connectors. Orthogonal to the ComparableField state: a
 * field can be `known` and `stale` at the same time, which is precisely the
 * case an operator most needs flagged.
 */
export type EvidenceQuality =
  /** Present, and inside the policy's data-age window. */
  | 'fresh'
  /** Present, but older than the freshness window the decision required. */
  | 'stale'
  /** Present, but produced by a degraded path (fallback reasoning, partial sync, restricted scope). */
  | 'degraded'
  /** We looked and there is NO record. Absence of evidence, not evidence of absence. */
  | 'missing'
  /** We looked, a record exists, and it says the thing is absent/false. */
  | 'negative'
  /** The question does not apply to this subject. */
  | 'not_applicable';

export const EVIDENCE_QUALITY_MEANING: Record<EvidenceQuality, string> = {
  fresh: 'Recorded, and current enough for the decision that used it.',
  stale: 'Recorded, but older than the freshness window this decision required.',
  degraded: 'Recorded, but produced by a degraded or partial path — treat with caution.',
  missing: 'No record exists. This is an absence of evidence, not evidence that the answer is no.',
  negative: 'A record exists and it states the negative — this is a real finding, not a gap.',
  not_applicable: 'This question does not apply to this kind of decision.',
};

/** Qualities that represent a hole rather than a fact. */
const HOLE_QUALITIES: EvidenceQuality[] = ['missing'];

export interface EvidenceItem {
  key: string;
  label: string;
  quality: EvidenceQuality;
  /** The #66 envelope. `value` is meaningful only when state === 'known'. */
  field: ComparableField<unknown>;
  /** Record/table/computation this came from, e.g. `signals#sig_1`. */
  source: string | null;
  observed_at: string | null;
  age_hours: number | null;
  /** Set for stale/degraded/negative — what specifically is wrong or absent. */
  caveat: string | null;
}

export interface EvidenceSnapshot {
  items: EvidenceItem[];
  /** Keys with NO record behind them. */
  missing_keys: string[];
  /** Keys whose record exists but is out of date. */
  stale_keys: string[];
  /** Keys whose record exists but came from a degraded path. */
  degraded_keys: string[];
  /** Keys where a record exists and states the negative — deliberately NOT missing. */
  negative_keys: string[];
  /** One honest sentence describing the state of the evidence overall. */
  summary: string;
  /** Point in time the snapshot describes, when the source recorded one. */
  captured_at: string | null;
}

export interface EvidenceItemInput {
  key: string;
  label: string;
  quality: EvidenceQuality;
  value?: unknown;
  citation?: string | null;
  /** Required whenever the value is not `known` — the specific reason. */
  reason?: string | null;
  source?: string | null;
  observed_at?: string | null;
  age_hours?: number | null;
  caveat?: string | null;
}

/**
 * Build one evidence item, choosing the #66 field state from the quality so
 * the two can never disagree. A `missing` item is structurally incapable of
 * carrying a value.
 */
export function evidenceItem(input: EvidenceItemInput): EvidenceItem {
  const hasValue = input.value !== undefined && input.value !== null
    && !(typeof input.value === 'string' && input.value.trim() === '');

  let field: ComparableField<unknown>;
  if (input.quality === 'missing') {
    field = unknownField(input.reason ?? `No record of ${input.label.toLowerCase()} exists.`);
  } else if (input.quality === 'not_applicable') {
    field = notComparableField(input.reason ?? `${input.label} does not apply to this decision.`);
  } else if (!hasValue) {
    // Declared present but nothing came through — that is a hole, and it is
    // reported as one rather than rendered as an empty "known" value.
    field = unknownField(input.reason ?? `${input.label} was expected but no value was recorded.`);
  } else {
    field = knownField(input.value, input.citation ?? input.source ?? 'unattributed');
  }

  return {
    key: input.key,
    label: input.label,
    // A quality that claims presence but produced no value is downgraded to
    // 'missing', so the rollups below cannot understate what we do not know.
    quality: (!hasValue && input.quality !== 'missing' && input.quality !== 'not_applicable' && input.quality !== 'negative')
      ? 'missing'
      : input.quality,
    field,
    source: input.source ?? null,
    observed_at: input.observed_at ?? null,
    age_hours: input.age_hours ?? null,
    caveat: input.caveat ?? null,
  };
}

export function summariseEvidence(items: EvidenceItem[], capturedAt: string | null = null): EvidenceSnapshot {
  const missing = items.filter((i) => HOLE_QUALITIES.includes(i.quality)).map((i) => i.key);
  const stale = items.filter((i) => i.quality === 'stale').map((i) => i.key);
  const degraded = items.filter((i) => i.quality === 'degraded').map((i) => i.key);
  const negative = items.filter((i) => i.quality === 'negative').map((i) => i.key);
  const usable = items.filter((i) => i.quality === 'fresh').length;

  const parts: string[] = [];
  if (!items.length) {
    parts.push('No evidence was recorded for this decision.');
  } else {
    parts.push(`${usable} of ${items.length} evidence item(s) are recorded and current.`);
    if (stale.length) parts.push(`${stale.length} are out of date.`);
    if (degraded.length) parts.push(`${degraded.length} came from a degraded source.`);
    if (missing.length) parts.push(`${missing.length} have no record at all — that is a gap in what we know, not a finding.`);
    if (negative.length) parts.push(`${negative.length} record a definite negative finding.`);
  }

  return {
    items,
    missing_keys: missing,
    stale_keys: stale,
    degraded_keys: degraded,
    negative_keys: negative,
    summary: parts.join(' '),
    captured_at: capturedAt,
  };
}

// ─── Policy ──────────────────────────────────────────────────────────────────

export interface ExplanationPolicy {
  policy_id: string | null;
  /** 0 means "system defaults" — a real, citable answer, not a null hole. */
  policy_version: number | null;
  policy_scope: string | null;
  citation: string;
  /**
   * TRUE when the record did not store which policy version it used, so
   * this cites the policy in force NOW. The current policy may not be the
   * one the decision was actually made under, and the panel says so.
   */
  reconstructed_from_current: boolean;
  /** Specific policy provisions that bore on this decision. */
  provisions: Array<{ name: string; value: string; effect: string }>;
}

export function unknownPolicy(reason: string): ExplanationPolicy {
  return {
    policy_id: null,
    policy_version: null,
    policy_scope: null,
    citation: reason,
    reconstructed_from_current: false,
    provisions: [],
  };
}

// ─── Confidence ──────────────────────────────────────────────────────────────

export type ConfidenceBasis =
  /** A number the deciding module actually recorded. */
  | 'recorded'
  /** No number was recorded and none is invented. */
  | 'none';

/**
 * The strongest claim the evidence supports. An explanation must never
 * render language above its causal claim.
 */
export type CausalClaim =
  /** An independent measurement confirmed the change took effect. */
  | 'verified_causal'
  /** The action and the change were observed together; causation is not established. */
  | 'correlational'
  /** A projection only. Nothing has been measured. */
  | 'expected_only'
  /** There is no basis for any claim about effect. */
  | 'not_established';

export const CAUSAL_CLAIM_MEANING: Record<CausalClaim, string> = {
  verified_causal:
    'An independent check confirmed the change took effect. This is the only level at which Blueprint claims it caused the result.',
  correlational:
    'The action and the observed change happened together. Blueprint has NOT established that one caused the other.',
  expected_only:
    'This is a projection of what was expected. Nothing has been measured, so no effect can be claimed.',
  not_established:
    'There is no basis for any claim about what effect this had.',
};

export interface ExplanationConfidence {
  /** 0..1, or null. Null when nothing recorded one — never fabricated. */
  value: number | null;
  basis: ConfidenceBasis;
  /** What the number means, and what it does not. */
  interpretation: string;
  /** Every reason the number should be trusted less than its face value. */
  limitations: string[];
  /**
   * True when the decision came from a fallback/degraded path — an LLM
   * reasoning failure, a deterministic fallback, a partial sync (#47).
   * A degraded decision is never presented as a confident one.
   */
  degraded: boolean;
  degraded_reason: string | null;
  causal_claim: CausalClaim;
  causal_claim_meaning: string;
}

export function noConfidence(reason: string, causal: CausalClaim = 'not_established'): ExplanationConfidence {
  return {
    value: null,
    basis: 'none',
    interpretation: reason,
    limitations: [],
    degraded: false,
    degraded_reason: null,
    causal_claim: causal,
    causal_claim_meaning: CAUSAL_CLAIM_MEANING[causal],
  };
}

// ─── Alternatives ────────────────────────────────────────────────────────────

export type AlternativeDisposition =
  /** Considered side by side and not chosen. */
  | 'rejected'
  /** Blocked by durable suppression memory from a prior operator decision. */
  | 'suppressed'
  /** Failed an evidence / coverage / WIP / ROI gate before it could be proposed. */
  | 'gated'
  /** Postponed rather than refused. */
  | 'deferred'
  /** Named here for completeness — it was never actually evaluated. */
  | 'not_considered';

export interface ExplanationAlternative {
  id: string | null;
  label: string;
  disposition: AlternativeDisposition;
  /** Why this option is not the one that happened. Always specific. */
  reason: string;
  /** For suppressions: how strongly it binds, and when it can come back (#50). */
  reconsider: { policy: string; expires_at: string | null } | null;
  /** Record this came from. */
  source: string | null;
}

// ─── Action state (#70 receipts) ─────────────────────────────────────────────

export interface ExplanationActionStage {
  stage: string;
  reached: boolean;
  at: string | null;
  by: string | null;
  detail: string | null;
}

export interface ExplanationActionState {
  /** Null when no action was ever requested — a genuine no-op. */
  receipt_id: string | null;
  state: string | null;
  result_status: string | null;
  stages: ExplanationActionStage[];
  /** What stopped it, when it never ran or failed. */
  blocked_by: string | null;
  external: { system: string | null; id: string | null; permalink: string | null } | null;
  attempts: number;
  anomalies: unknown[];
  /** Plain-English one-liner an operator can read without knowing the states. */
  summary: string;
}

export function noAction(summary: string): ExplanationActionState {
  return {
    receipt_id: null,
    state: null,
    result_status: null,
    stages: [],
    blocked_by: null,
    external: null,
    attempts: 0,
    anomalies: [],
    summary,
  };
}

// ─── Outcome (#63 taxonomy) ──────────────────────────────────────────────────

export interface ExplanationOutcome {
  /** activity | verified_action | outcome_measured | roi_not_measurable, or null. */
  state: string | null;
  reason: string | null;
  /** The #63 citation: task, outcome row and measurement window. */
  citation: Record<string, unknown> | null;
  /** True when there is nothing measurable and there never will be. */
  measurable: boolean;
  summary: string;
}

export function noOutcome(summary: string): ExplanationOutcome {
  return { state: null, reason: null, citation: null, measurable: false, summary };
}

// ─── Links ───────────────────────────────────────────────────────────────────

export type ExplanationLinkRel =
  | 'receipt' | 'outcome' | 'decision' | 'task' | 'signal' | 'goal'
  | 'hiring_analysis' | 'policy' | 'agent';

export interface ExplanationLink {
  rel: ExplanationLinkRel;
  label: string;
  /** Record id being linked. */
  id: string;
  /** Dashboard route, when one exists for this record type. */
  href: string | null;
}

// ─── The explanation ─────────────────────────────────────────────────────────

export interface Explanation {
  schema_version: string;
  subject: ExplanationSubject;
  /** One honest sentence: what happened and why, at a glance. */
  headline: string;
  disposition: ExplanationDisposition;
  disposition_meaning: string;
  trigger: ExplanationTrigger;
  evidence: EvidenceSnapshot;
  policy: ExplanationPolicy;
  confidence: ExplanationConfidence;
  alternatives: ExplanationAlternative[];
  action: ExplanationActionState;
  outcome: ExplanationOutcome;
  links: ExplanationLink[];
  /** What this explanation cannot tell you. Never empty by accident. */
  limitations: string[];
  generated_at: string;
}

export interface ExplanationDraft {
  subject: ExplanationSubject;
  headline: string;
  disposition: ExplanationDisposition;
  trigger: ExplanationTrigger;
  evidence: EvidenceSnapshot;
  policy: ExplanationPolicy;
  confidence: ExplanationConfidence;
  alternatives?: ExplanationAlternative[];
  action?: ExplanationActionState;
  outcome?: ExplanationOutcome;
  links?: ExplanationLink[];
  limitations?: string[];
}

/**
 * The single choke point every builder passes through.
 *
 * Three jobs, in order:
 *   1. Derive the limitations that follow mechanically from the evidence
 *      and confidence, so a builder cannot forget to disclose a gap it
 *      already reported.
 *   2. Stamp schema version and generation time.
 *   3. Redact. The WHOLE structure goes through lib/redaction.ts — no
 *      builder is trusted to have sanitised task payloads, provider errors
 *      or receipt details, because those are exactly where a credential
 *      would be hiding.
 */
export function finaliseExplanation(draft: ExplanationDraft): Explanation {
  const limitations = [...(draft.limitations ?? [])];

  if (draft.evidence.missing_keys.length) {
    limitations.push(
      `No record exists for: ${draft.evidence.missing_keys.join(', ')}. Blueprint does not know these values — it is not asserting they are absent or zero.`,
    );
  }
  if (draft.evidence.stale_keys.length) {
    limitations.push(
      `Out-of-date evidence was used for: ${draft.evidence.stale_keys.join(', ')}. The underlying data may have changed since.`,
    );
  }
  if (draft.evidence.degraded_keys.length) {
    limitations.push(
      `Degraded evidence was used for: ${draft.evidence.degraded_keys.join(', ')}. These came from a partial or fallback source.`,
    );
  }
  if (draft.confidence.degraded) {
    limitations.push(
      draft.confidence.degraded_reason
        ? `This decision came from a degraded path: ${draft.confidence.degraded_reason} It must not be read as a confident recommendation.`
        : 'This decision came from a degraded path and must not be read as a confident recommendation.',
    );
  }
  if (draft.confidence.basis === 'none') {
    limitations.push('No confidence score was recorded for this decision, and none has been invented for this explanation.');
  }
  if (draft.confidence.causal_claim !== 'verified_causal') {
    limitations.push(CAUSAL_CLAIM_MEANING[draft.confidence.causal_claim]);
  }
  if (draft.policy.reconstructed_from_current) {
    limitations.push(
      'This record did not store which operating policy version it was decided under, so the CURRENT policy is shown. It may not be the policy that actually applied.',
    );
  }

  // Always last, and always present. An explanation is a rendering of the
  // records that happen to exist; the reader is entitled to know that its
  // completeness is bounded by what the deciding modules chose to write
  // down, even when nothing specific went wrong.
  limitations.push(
    'This explanation is assembled from the records Blueprint wrote at the time. Anything a module did not record cannot appear here, and its absence is not evidence that it did not happen.',
  );

  const explanation: Explanation = {
    schema_version: EXPLANATION_SCHEMA_VERSION,
    subject: draft.subject,
    headline: draft.headline,
    disposition: draft.disposition,
    disposition_meaning: DISPOSITION_MEANING[draft.disposition],
    trigger: draft.trigger,
    evidence: draft.evidence,
    policy: draft.policy,
    confidence: { ...draft.confidence, causal_claim_meaning: CAUSAL_CLAIM_MEANING[draft.confidence.causal_claim] },
    alternatives: draft.alternatives ?? [],
    action: draft.action ?? noAction('No action was requested for this decision.'),
    outcome: draft.outcome ?? noOutcome('No outcome is tracked for this decision.'),
    links: draft.links ?? [],
    limitations: dedupe(limitations),
    generated_at: new Date().toISOString(),
  };

  // Depth 10 rather than the default 6: an explanation legitimately nests
  // explanation → evidence → items[] → field → value → the value's own
  // structure, and collapsing a real evidence value to '[truncated]' would
  // itself be a dishonest rendering.
  return redactSensitive<Explanation>(explanation, { maxDepth: 10, maxArrayLength: 60 });
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ─── Small shared helpers ────────────────────────────────────────────────────

export function ageHours(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const parsed = Date.parse(String(iso).includes('T') ? String(iso) : `${String(iso).replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, (now - parsed) / 3_600_000);
}

/**
 * Freshness quality for a timestamp, against the policy's data-age window.
 * Returns 'missing' when there is no timestamp at all — deliberately not
 * 'stale', because "we have never seen this" and "we saw this a while ago"
 * are different problems with different fixes.
 */
export function freshnessQuality(iso: string | null | undefined, maxAgeHours: number, now = Date.now()): EvidenceQuality {
  const age = ageHours(iso, now);
  if (age === null) return 'missing';
  return age <= maxAgeHours ? 'fresh' : 'stale';
}
