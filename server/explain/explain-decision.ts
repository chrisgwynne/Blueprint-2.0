/**
 * Explain a decision-memory row (issue #60).
 *
 * decisions (#61) is already the durable "why did we decide X" record: it
 * carries the rationale, the evidence, the confidence, the policy version
 * in force (#68) and — since #66 — the alternatives that were rejected.
 * This file does no recomputation; it maps that row into the one shared
 * explanation shape so a comparison deferral, a task approval and a
 * conflict resolution all read the same way in the same panel.
 *
 * The case this file exists to handle honestly is the NO-OP:
 * `comparison_deferral` and `opportunity_dismissed` are decisions where
 * nothing happened, and "nothing happened" is the answer, complete with
 * the alternatives that were on the table and the reason none was taken.
 */

import db from '../db/db.js';
import { resolveOperatingPolicy } from '../policy/operating-policy.js';
import { getLatestReceiptForTask } from '../tasks/action-receipts.js';
import {
  type Explanation, type ExplanationAlternative, type ExplanationDisposition,
  type ExplanationLink, type ExplanationPolicy, type ExplanationTrigger,
  type EvidenceItem, type CausalClaim,
  evidenceItem, summariseEvidence, finaliseExplanation, noAction, noOutcome,
} from './explanation.js';
import { actionFromReceipt } from './explain-task.js';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

/**
 * Decision types where the recorded outcome is deliberately "nothing was
 * done". Rendering these as an empty panel would be the exact failure this
 * issue is about, so they get their own disposition and headline.
 */
const NO_OP_TYPES: Record<string, { disposition: ExplanationDisposition; headline: string }> = {
  comparison_deferral: {
    disposition: 'deferred',
    headline: 'Compared the options and chose none of them. Nothing was approved or executed.',
  },
  opportunity_dismissed: {
    disposition: 'rejected',
    headline: 'This opportunity was dismissed. Nothing was done.',
  },
  conflict_dismissal: {
    disposition: 'no_op',
    headline: 'The conflict was dismissed without action.',
  },
  task_rejection: {
    disposition: 'rejected',
    headline: 'The proposed task was rejected. Nothing was done.',
  },
  task_cancellation: {
    disposition: 'no_op',
    headline: 'The task was cancelled. Nothing further was done.',
  },
  task_deferral: {
    disposition: 'deferred',
    headline: 'The task was deferred. Nothing has been done yet.',
  },
};

/**
 * A comparison SELECTION states a preference. It is emphatically not an
 * approval — #66 enforces that structurally — so the explanation must not
 * describe it as an action taken.
 */
const PREFERENCE_ONLY_TYPES = new Set(['comparison_selection']);

export function explainDecision(businessId: string, decisionId: string): Explanation | null {
  const row = db.prepare('SELECT * FROM decisions WHERE id = ? AND business_id = ?')
    .get(decisionId, businessId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const decisionType = String(row.decision_type);
  const recordedEvidence = parseJson<unknown[]>(row.evidence, []);
  const rejected = parseJson<Array<Record<string, unknown>>>(row.alternatives_rejected, []);
  const author = String(row.author ?? 'unknown');

  // ── Trigger ───────────────────────────────────────────────────────────────
  const isHuman = /^(human|user|dashboard)/i.test(author);
  const trigger: ExplanationTrigger = row.related_signal_id
    ? {
        kind: 'signal',
        summary: `Decided in response to signal ${String(row.related_signal_id)}.`,
        ref: { type: 'signal', id: String(row.related_signal_id), label: null },
        occurred_at: (row.created_at as string | null) ?? null,
        actor: author,
        unattributed: false,
      }
    : {
        kind: isHuman ? 'human_request' : 'agent_run',
        summary: isHuman
          ? `A person (${author}) made this decision.`
          : `"${author}" made this decision autonomously.`,
        ref: null,
        occurred_at: (row.created_at as string | null) ?? null,
        actor: author,
        unattributed: false,
      };

  // ── Evidence ──────────────────────────────────────────────────────────────
  const items: EvidenceItem[] = [
    evidenceItem({
      key: 'recorded_evidence',
      label: 'Evidence recorded with the decision',
      quality: recordedEvidence.length ? 'fresh' : 'missing',
      value: recordedEvidence.length ? recordedEvidence : undefined,
      reason: 'This decision was recorded without any evidence attached to it.',
      source: `decisions#${decisionId}.evidence`,
      observed_at: (row.created_at as string | null) ?? null,
    }),
    evidenceItem({
      key: 'rationale',
      label: 'Stated reasoning',
      quality: row.reasoning ? 'fresh' : 'missing',
      value: row.reasoning ?? undefined,
      reason: 'No reasoning was written down when this decision was made.',
      source: `decisions#${decisionId}.reasoning`,
    }),
  ];

  // A comparison decision carries the #66 missing_data roll-up. Surfacing
  // it verbatim is the whole point: the reviewer decided WITH those holes,
  // and the explanation must show them rather than smooth them over.
  const comparisonEvidence = recordedEvidence.find(
    (e) => e && typeof e === 'object' && (e as Record<string, unknown>).type === 'comparison',
  ) as Record<string, unknown> | undefined;

  if (comparisonEvidence) {
    const missingData = Array.isArray(comparisonEvidence.missing_data) ? comparisonEvidence.missing_data : [];
    items.push(evidenceItem({
      key: 'comparison_gaps',
      label: 'Known gaps at comparison time',
      quality: missingData.length ? 'negative' : 'fresh',
      value: missingData.length ? missingData : 'No fields were missing across the compared candidates.',
      source: `decisions#${decisionId}.evidence[comparison].missing_data`,
      caveat: missingData.length
        ? `${missingData.length} field(s) had no value for at least one candidate. The comparison was made without them.`
        : null,
    }));
    const unknownDims = Array.isArray(comparisonEvidence.dimensions_unknown_for_all)
      ? comparisonEvidence.dimensions_unknown_for_all
      : [];
    if (unknownDims.length) {
      items.push(evidenceItem({
        key: 'dimensions_unknown_for_all',
        label: 'Dimensions unknown for every candidate',
        quality: 'missing',
        reason: `These dimensions had no data for any candidate and could not be compared: ${unknownDims.join(', ')}.`,
        source: `decisions#${decisionId}.evidence[comparison]`,
      }));
    }
  }

  const evidence = summariseEvidence(items, (row.created_at as string | null) ?? null);

  // ── Policy (#68) — recorded, so it needs no reconstruction ────────────────
  const recordedVersion = row.effective_policy_version;
  const hasRecorded = recordedVersion !== null && recordedVersion !== undefined;
  const current = resolveOperatingPolicy(businessId);
  const policy: ExplanationPolicy = {
    policy_id: hasRecorded ? (row.effective_policy_id as string | null) : current.policy_id,
    policy_version: hasRecorded ? Number(recordedVersion) : current.policy_version,
    policy_scope: hasRecorded ? (row.effective_policy_scope as string | null) : current.policy_scope,
    citation: hasRecorded
      ? `${String(row.effective_policy_scope ?? 'unknown')} policy v${Number(recordedVersion)}, cited by the decision itself`
      : current.citation,
    reconstructed_from_current: !hasRecorded,
    provisions: [
      {
        name: 'require_human_approval_at_or_above',
        value: current.document.approvals.require_human_approval_at_or_above,
        effect: 'Shown from the current policy — the exact provisions in force at decision time are not stored per-field, only the version.',
      },
    ],
  };

  // ── Disposition ───────────────────────────────────────────────────────────
  const noOp = NO_OP_TYPES[decisionType];
  let disposition: ExplanationDisposition;
  let headline: string;
  if (noOp) {
    disposition = noOp.disposition;
    headline = noOp.headline;
  } else if (PREFERENCE_ONLY_TYPES.has(decisionType)) {
    disposition = 'awaiting_decision';
    headline = 'A preferred option was chosen. This records a preference only — it did not approve or execute anything.';
  } else {
    disposition = 'acted';
    headline = String(row.decision ?? row.title);
  }

  // ── Alternatives ──────────────────────────────────────────────────────────
  const alternatives: ExplanationAlternative[] = rejected.map((alt) => ({
    id: alt.id ? String(alt.id) : null,
    label: alt.title ? String(alt.title) : String(alt.id ?? 'unnamed option'),
    disposition: decisionType === 'comparison_deferral' ? 'deferred' : 'rejected',
    reason: alt.not_selected_reason
      ? String(alt.not_selected_reason)
      : 'Recorded as a rejected alternative without a specific reason.',
    reconsider: null,
    source: `decisions#${decisionId}.alternatives_rejected`,
  }));

  // ── Action state ──────────────────────────────────────────────────────────
  // A decision only has an action state when it decided about a task AND
  // that task actually produced a receipt. A preference, a dismissal and a
  // deferral all correctly show "nothing was requested".
  const relatedTaskId = row.related_task_id ? String(row.related_task_id) : null;
  const receipt = relatedTaskId ? getLatestReceiptForTask(relatedTaskId) : null;
  const action = receipt && receipt.business_id === businessId && !noOp && !PREFERENCE_ONLY_TYPES.has(decisionType)
    ? actionFromReceipt(receipt)
    : noAction(
        noOp
          ? 'Nothing was requested — this decision was to take no action.'
          : PREFERENCE_ONLY_TYPES.has(decisionType)
            ? 'Nothing was requested. Recording a preference does not approve, schedule or execute anything.'
            : 'No action receipt is linked to this decision.',
      );

  // ── Confidence ────────────────────────────────────────────────────────────
  const recordedConfidence = typeof row.confidence === 'number' ? (row.confidence as number) : null;
  const causal: CausalClaim = 'not_established';
  const confidenceLimitations: string[] = [];
  if (recordedConfidence != null) {
    confidenceLimitations.push('This is the confidence recorded on the decision itself, not a measured success rate for the outcome.');
  }
  if (decisionType === 'comparison_deferral') {
    confidenceLimitations.push('A deferral carries no confidence of its own; deferring is a decision not to decide.');
  }

  // ── Links ─────────────────────────────────────────────────────────────────
  const links: ExplanationLink[] = [];
  if (relatedTaskId) links.push({ rel: 'task', label: 'Related task', id: relatedTaskId, href: '/tasks' });
  if (row.related_goal_id) links.push({ rel: 'goal', label: 'Related goal', id: String(row.related_goal_id), href: '/goals' });
  if (row.related_signal_id) links.push({ rel: 'signal', label: 'Related signal', id: String(row.related_signal_id), href: '/signals' });
  if (row.related_outcome_id) links.push({ rel: 'outcome', label: 'Related outcome', id: String(row.related_outcome_id), href: '/outcomes' });
  if (action.receipt_id) links.push({ rel: 'receipt', label: 'Action receipt', id: action.receipt_id, href: '/receipts' });
  if (policy.policy_id) links.push({ rel: 'policy', label: policy.citation, id: policy.policy_id, href: '/policy' });

  return finaliseExplanation({
    subject: {
      kind: 'decision',
      id: decisionId,
      business_id: businessId,
      title: String(row.title),
      source_record: `decisions#${decisionId}`,
      created_at: (row.created_at as string | null) ?? null,
    },
    headline,
    disposition,
    trigger,
    evidence,
    policy,
    confidence: {
      value: recordedConfidence,
      basis: recordedConfidence == null ? 'none' : 'recorded',
      interpretation: recordedConfidence == null
        ? 'No confidence was recorded on this decision, and none has been invented here.'
        : `${Math.round(recordedConfidence * 100)}% was recorded on the decision by ${author}.`,
      limitations: confidenceLimitations,
      degraded: false,
      degraded_reason: null,
      causal_claim: causal,
      causal_claim_meaning: '',
    },
    alternatives,
    action,
    outcome: noOutcome(
      noOp
        ? 'No outcome will ever exist for this decision, because it was a decision to do nothing.'
        : 'No outcome measurement is linked to this decision record.',
    ),
    links,
    limitations: rejected.length === 0 && (decisionType.startsWith('comparison') || decisionType === 'strategy_selection')
      ? ['No rejected alternatives were recorded, so it cannot be shown what else was on the table.']
      : [],
  });
}
