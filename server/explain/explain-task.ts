/**
 * Explain a task / recommendation (issue #60).
 *
 * Reads only. Everything below is pulled out of a record another module
 * already wrote:
 *
 *   tasks                     the subject itself
 *   signals                   the trigger, when the task came from one
 *   decisions (#61)           the human/agent decision, its recorded
 *                             evidence, its policy citation and the
 *                             alternatives it rejected (#66)
 *   action_receipts (#70)     what actually happened, stage by stage
 *   task_outcomes (#63)       whether anything was ever measured
 *   operating policy (#68)    the provisions that gated it
 *   trust-engine              applicability / approval-tier evidence
 *
 * The one piece of judgement this file exercises is CALIBRATION: choosing
 * the disposition and the causal claim that the records actually support,
 * and refusing to go higher. A completed task with no measurement is
 * `expected_only`, never `verified_causal`, no matter how confident the
 * proposing agent was.
 */

import db from '../db/db.js';
import { resolveOperatingPolicy } from '../policy/operating-policy.js';
import { getLatestReceiptForTask, toReceiptView } from '../tasks/action-receipts.js';
import { classifyOutcomeTaxonomy, type TaxonomyCheckLike } from '../tasks/outcome-taxonomy.js';
import {
  type Explanation, type ExplanationAlternative, type ExplanationActionState,
  type ExplanationConfidence, type ExplanationDisposition, type ExplanationLink,
  type ExplanationOutcome, type ExplanationPolicy, type ExplanationTrigger,
  type EvidenceItem, type CausalClaim,
  evidenceItem, summariseEvidence, finaliseExplanation, noAction, noOutcome,
  unattributedTrigger, ageHours, freshnessQuality,
} from './explanation.js';

interface TaskRow {
  id: string; business_id: string; title: string; description: string | null;
  status: string; action_type: string | null; action_payload: string | null;
  signal_id: string | null; goal_id: string | null; proposed_by: string;
  confidence: number | null; priority: string | null; trust_tier: string | null;
  approval_mode: string | null; approved_by: string | null; approved_at: string | null;
  rejection_reason: string | null; deferred_until: string | null; deferred_reason: string | null;
  deferred_by: string | null; degraded_data: number | null;
  applicability_status: string | null; applicability_reason: string | null;
  approval_risk_evidence: string | null; expected_outcome: string | null;
  estimated_impact: string | null; target_metric: string | null;
  outcome: string | null; outcome_data: string | null;
  completed_at: string | null; created_at: string; updated_at: string;
  version: number | null;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

/** Statuses in which nothing has been attempted yet. */
const NOT_YET_ATTEMPTED = new Set(['proposed', 'deferred']);

export function explainTask(businessId: string, taskId: string): Explanation | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND business_id = ?')
    .get(taskId, businessId) as TaskRow | undefined;
  if (!task) return null;

  const policy = resolveOperatingPolicy(businessId);
  const maxAgeHours = policy.document.connectors.max_data_age_hours;
  const now = Date.now();

  // ── Trigger ───────────────────────────────────────────────────────────────
  const signal = task.signal_id
    ? db.prepare('SELECT id, title, type, severity, created_at, status, confidence FROM signals WHERE id = ? AND business_id = ?')
        .get(task.signal_id, businessId) as Record<string, unknown> | undefined
    : undefined;

  let trigger: ExplanationTrigger;
  if (signal) {
    trigger = {
      kind: 'signal',
      summary: `A ${String(signal.severity ?? 'detected')} signal — "${String(signal.title)}" — was detected, and this task was proposed in response.`,
      ref: { type: 'signal', id: String(signal.id), label: String(signal.title) },
      occurred_at: (signal.created_at as string | null) ?? null,
      actor: task.proposed_by,
      unattributed: false,
    };
  } else if (task.proposed_by && /^human:|^user:|^dashboard/.test(task.proposed_by)) {
    trigger = {
      kind: 'human_request',
      summary: `A person (${task.proposed_by}) created this task directly.`,
      ref: null,
      occurred_at: task.created_at,
      actor: task.proposed_by,
      unattributed: false,
    };
  } else if (task.proposed_by) {
    trigger = {
      kind: 'agent_run',
      summary: `Agent "${task.proposed_by}" proposed this task during a reasoning pass. No originating signal is recorded on it.`,
      ref: { type: 'agent', id: task.proposed_by, label: task.proposed_by },
      occurred_at: task.created_at,
      actor: task.proposed_by,
      unattributed: false,
    };
  } else {
    trigger = unattributedTrigger(
      'No signal, agent or person is recorded as the origin of this task. Blueprint cannot say what caused it.',
    );
  }

  // ── Decision memory (#61/#66) ─────────────────────────────────────────────
  const decisionRows = db.prepare(
    'SELECT * FROM decisions WHERE business_id = ? AND related_task_id = ? ORDER BY created_at DESC LIMIT 20',
  ).all(businessId, taskId) as Array<Record<string, unknown>>;
  const latestDecision = decisionRows[0] ?? null;

  // ── Evidence snapshot ─────────────────────────────────────────────────────
  const items: EvidenceItem[] = [];

  if (signal) {
    items.push(evidenceItem({
      key: 'source_signal',
      label: 'Source signal',
      quality: freshnessQuality(signal.created_at as string | null, maxAgeHours, now),
      value: { id: signal.id, title: signal.title, type: signal.type, severity: signal.severity, status: signal.status },
      source: `signals#${String(signal.id)}`,
      observed_at: (signal.created_at as string | null) ?? null,
      age_hours: ageHours(signal.created_at as string | null, now),
      caveat: (ageHours(signal.created_at as string | null, now) ?? 0) > maxAgeHours
        ? `The signal is older than the ${maxAgeHours}h data-age window this business's policy sets for acting on data.`
        : null,
    }));
  } else if (task.signal_id) {
    items.push(evidenceItem({
      key: 'source_signal',
      label: 'Source signal',
      quality: 'missing',
      reason: `The task cites signal '${task.signal_id}' but no such signal exists for this business — the record was deleted or never written.`,
      source: `signals#${task.signal_id}`,
    }));
  } else {
    items.push(evidenceItem({
      key: 'source_signal',
      label: 'Source signal',
      quality: 'missing',
      reason: 'This task is not linked to any signal, so there is no detected condition behind it.',
    }));
  }

  const recordedEvidence = latestDecision ? parseJson<unknown[]>(latestDecision.evidence, []) : [];
  items.push(evidenceItem({
    key: 'recorded_evidence',
    label: 'Evidence recorded with the decision',
    quality: recordedEvidence.length ? 'fresh' : 'missing',
    value: recordedEvidence.length ? recordedEvidence : undefined,
    reason: latestDecision
      ? 'The decision was recorded without any evidence attached to it.'
      : 'No decision-memory row exists for this task, so no decision-time evidence was captured.',
    source: latestDecision ? `decisions#${String(latestDecision.id)}` : null,
    observed_at: latestDecision ? String(latestDecision.created_at ?? '') || null : null,
  }));

  // Applicability — a 'not_applicable' verdict is a NEGATIVE finding (we
  // checked, the capability is unavailable), not a missing one.
  if (task.applicability_status && task.applicability_status !== 'unknown') {
    items.push(evidenceItem({
      key: 'applicability',
      label: 'Capability applicability',
      quality: task.applicability_status === 'applicable' ? 'fresh' : 'negative',
      value: { status: task.applicability_status, reason: task.applicability_reason },
      source: `tasks#${task.id}.applicability_status`,
      caveat: task.applicability_status !== 'applicable'
        ? (task.applicability_reason ?? 'A required capability is unavailable or restricted for this business.')
        : null,
    }));
  } else {
    items.push(evidenceItem({
      key: 'applicability',
      label: 'Capability applicability',
      quality: 'missing',
      reason: 'Applicability was never evaluated for this task, so Blueprint does not know whether the required capability exists.',
    }));
  }

  const riskEvidence = parseJson<Record<string, unknown> | null>(task.approval_risk_evidence, null);
  items.push(evidenceItem({
    key: 'risk_assessment',
    label: 'Risk / approval-tier assessment',
    quality: riskEvidence ? 'fresh' : 'missing',
    value: riskEvidence ?? undefined,
    reason: 'No approval-tier assessment was stored on this task.',
    source: riskEvidence ? `tasks#${task.id}.approval_risk_evidence` : null,
  }));

  items.push(evidenceItem({
    key: 'expected_outcome',
    label: 'Expected outcome',
    // A stated expectation IS a recorded fact about the proposal; the
    // caveat below is what stops it being read as a measured result.
    quality: (task.expected_outcome || task.estimated_impact) ? 'fresh' : 'missing',
    value: task.expected_outcome ?? task.estimated_impact ?? undefined,
    reason: 'Nobody stated what this task was expected to achieve, so there is nothing to check the result against.',
    source: `tasks#${task.id}.expected_outcome`,
    caveat: 'An expected outcome is a projection, not a measurement.',
  }));

  items.push(evidenceItem({
    key: 'target_metric',
    label: 'Target metric',
    quality: task.target_metric ? 'fresh' : 'missing',
    value: task.target_metric ?? undefined,
    reason: 'No target metric is linked to this task, so no business outcome can ever be measured for it.',
    source: `tasks#${task.id}.target_metric`,
  }));

  if (task.degraded_data) {
    items.push(evidenceItem({
      key: 'input_data_quality',
      label: 'Input data quality',
      quality: 'degraded',
      value: 'degraded',
      source: `tasks#${task.id}.degraded_data`,
      caveat: 'This task was produced from partial or degraded connector data.',
    }));
  }

  const evidence = summariseEvidence(items, latestDecision ? String(latestDecision.created_at ?? '') || null : task.created_at);

  // ── Policy (#68) ──────────────────────────────────────────────────────────
  const recordedPolicyVersion = latestDecision?.effective_policy_version;
  const usedRecorded = recordedPolicyVersion !== null && recordedPolicyVersion !== undefined;
  const explanationPolicy: ExplanationPolicy = {
    policy_id: usedRecorded ? (latestDecision!.effective_policy_id as string | null) : policy.policy_id,
    policy_version: usedRecorded ? Number(recordedPolicyVersion) : policy.policy_version,
    policy_scope: usedRecorded ? (latestDecision!.effective_policy_scope as string | null) : policy.policy_scope,
    citation: usedRecorded
      ? `${String(latestDecision!.effective_policy_scope ?? 'unknown')} policy v${Number(recordedPolicyVersion)} (recorded on decision ${String(latestDecision!.id)})`
      : policy.citation,
    reconstructed_from_current: !usedRecorded,
    provisions: [
      {
        name: 'require_human_approval_at_or_above',
        value: policy.document.approvals.require_human_approval_at_or_above,
        effect: `Any action at or above the '${policy.document.approvals.require_human_approval_at_or_above}' tier always needs an explicit human approval.`,
      },
      {
        name: 'auto_approve_max_tier',
        value: String(policy.document.approvals.auto_approve_max_tier ?? 'not enforced'),
        effect: policy.document.approvals.auto_approve_max_tier
          ? `Nothing above the '${policy.document.approvals.auto_approve_max_tier}' tier may be approved without a human.`
          : 'No approval ceiling is enforced by policy; the executor gates decide.',
      },
      {
        name: 'allow_autonomous_execution',
        value: String(policy.document.autonomy.allow_autonomous_execution),
        effect: policy.document.autonomy.allow_autonomous_execution
          ? 'Autonomous execution is permitted for this business.'
          : 'Autonomous execution is switched off — everything needs a human.',
      },
      {
        name: 'max_data_age_hours',
        value: String(maxAgeHours),
        effect: `Connector data older than ${maxAgeHours}h is considered too stale to act on.`,
      },
    ],
  };

  // ── Action state (#70) ────────────────────────────────────────────────────
  const receiptRow = getLatestReceiptForTask(taskId);
  const action = receiptRow && receiptRow.business_id === businessId
    ? actionFromReceipt(receiptRow)
    : noAction(
        NOT_YET_ATTEMPTED.has(task.status)
          ? `No action has been attempted: the task is '${task.status}'. Nothing external has been touched.`
          : `No action receipt exists for this task (status '${task.status}'). Blueprint cannot show stage-by-stage proof of what was done.`,
      );

  // ── Outcome (#63) ─────────────────────────────────────────────────────────
  const checks = db.prepare(
    'SELECT id, weeks_after, verdict, metric_value, baseline_value, change_pct, check_date FROM task_outcomes WHERE task_id = ? ORDER BY weeks_after ASC',
  ).all(taskId) as TaxonomyCheckLike[];
  const taxonomy = classifyOutcomeTaxonomy({
    task_id: task.id,
    task_status: task.status,
    action_type: task.action_type,
    target_metric: task.target_metric,
    completed_at: task.completed_at,
    checks,
  });
  const outcome: ExplanationOutcome = {
    state: taxonomy.state,
    reason: taxonomy.reason,
    citation: taxonomy.citation as unknown as Record<string, unknown>,
    measurable: taxonomy.state !== 'verified_action',
    summary: taxonomy.state === 'outcome_measured'
      ? 'A real measurement exists for this task.'
      : taxonomy.state === 'verified_action'
        ? 'The work was confirmed done, but no business outcome can ever be measured for it — nothing was linked to measure.'
        : taxonomy.state === 'roi_not_measurable'
          ? 'The measurement window has not produced a result yet. No value may be claimed.'
          : 'Nothing beyond "work was attempted" can honestly be claimed.',
  };

  // ── Disposition + causal claim ────────────────────────────────────────────
  const { disposition, headline } = dispositionForTask(task, action, taxonomy.state);
  const causal: CausalClaim = taxonomy.state === 'outcome_measured'
    ? (action.state === 'verified' ? 'verified_causal' : 'correlational')
    : disposition === 'acted' || disposition === 'in_progress'
      ? 'expected_only'
      : 'not_established';

  // ── Confidence ────────────────────────────────────────────────────────────
  const confidence = confidenceForTask(task, latestDecision, causal, action);

  // ── Alternatives (#66 comparisons, deferrals, rejections) ─────────────────
  const alternatives: ExplanationAlternative[] = [];
  for (const d of decisionRows) {
    for (const alt of parseJson<Array<Record<string, unknown>>>(d.alternatives_rejected, [])) {
      alternatives.push({
        id: alt.id ? String(alt.id) : null,
        label: alt.title ? String(alt.title) : String(alt.id ?? 'unnamed option'),
        disposition: String(d.decision_type) === 'comparison_deferral' ? 'deferred' : 'rejected',
        reason: alt.not_selected_reason
          ? String(alt.not_selected_reason)
          : `Considered alongside this task in decision "${String(d.title)}" and not chosen.`,
        reconsider: null,
        source: `decisions#${String(d.id)}.alternatives_rejected`,
      });
    }
  }
  if (task.status === 'deferred') {
    alternatives.push({
      id: task.id,
      label: 'Acting on this task now',
      disposition: 'deferred',
      reason: task.deferred_reason
        ? `Deferred${task.deferred_until ? ` until ${task.deferred_until}` : ''}: ${task.deferred_reason}`
        : `Deferred${task.deferred_until ? ` until ${task.deferred_until}` : ''} without a stated reason.`,
      reconsider: { policy: 'after_expiry', expires_at: task.deferred_until },
      source: `tasks#${task.id}.deferred_reason`,
    });
  }

  // ── Links ─────────────────────────────────────────────────────────────────
  const links: ExplanationLink[] = [];
  if (action.receipt_id) links.push({ rel: 'receipt', label: 'Action receipt', id: action.receipt_id, href: '/receipts' });
  if (checks.length) {
    for (const c of checks) {
      if (c.id) links.push({ rel: 'outcome', label: `Outcome check (week ${c.weeks_after ?? '?'})`, id: String(c.id), href: '/outcomes' });
    }
  }
  for (const d of decisionRows.slice(0, 5)) {
    links.push({ rel: 'decision', label: String(d.title), id: String(d.id), href: '/decisions' });
  }
  if (signal) links.push({ rel: 'signal', label: String(signal.title), id: String(signal.id), href: '/signals' });
  if (task.goal_id) links.push({ rel: 'goal', label: 'Linked goal', id: task.goal_id, href: '/goals' });
  if (explanationPolicy.policy_id) {
    links.push({ rel: 'policy', label: explanationPolicy.citation, id: explanationPolicy.policy_id, href: '/policy' });
  }

  return finaliseExplanation({
    subject: {
      kind: 'task',
      id: task.id,
      business_id: businessId,
      title: task.title,
      source_record: `tasks#${task.id}`,
      created_at: task.created_at,
    },
    headline,
    disposition,
    trigger,
    evidence,
    policy: explanationPolicy,
    confidence,
    alternatives,
    action,
    outcome,
    links,
    limitations: !decisionRows.length
      ? ['No decision-memory row was written for this task, so its approval reasoning cannot be replayed.']
      : [],
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Shape a #70 receipt into the explanation's action-state view. */
export function actionFromReceipt(row: NonNullable<ReturnType<typeof getLatestReceiptForTask>>): ExplanationActionState {
  const view = toReceiptView(row);
  const s = view.states;
  const rejection = view.rejection as { at: string; by: string | null; stage: string | null; reason: string | null } | null;

  const stages = [
    { stage: 'requested', reached: s.requested.reached, at: s.requested.at, by: s.requested.by, detail: null as string | null },
    { stage: 'authorized', reached: s.authorized.reached, at: s.authorized.at, by: s.authorized.by, detail: null as string | null },
    { stage: 'executed', reached: s.executed.reached, at: s.executed.at, by: null, detail: null as string | null },
    {
      stage: 'externally_acknowledged',
      reached: s.externally_acknowledged.reached,
      at: s.externally_acknowledged.at,
      by: null,
      detail: s.externally_acknowledged.reached
        ? 'The external system accepted the request and returned a reference. This is an acknowledgement, NOT proof the change took effect.'
        : null,
    },
    {
      stage: 'verified',
      reached: s.verified.reached,
      at: s.verified.at,
      by: null,
      detail: s.verified.reached ? 'An independent check confirmed the change took effect.' : null,
    },
  ];

  const blocked = rejection
    ? `${rejection.stage ? `${rejection.stage}: ` : ''}${rejection.reason ?? 'rejected without a stated reason'}`
    : row.state === 'failed'
      ? (view.result_summary as string | null) ?? 'Execution failed; no failure summary was recorded.'
      : null;

  let summary: string;
  if (row.state === 'rejected_pre_execution') {
    summary = `Never ran — ${blocked ?? 'a gate rejected it before execution'}.`;
  } else if (row.state === 'failed') {
    summary = `Attempted and failed after ${row.attempt_count} attempt(s). ${blocked ?? ''}`.trim();
  } else if (row.state === 'verified') {
    summary = 'Executed, acknowledged externally, and independently verified.';
  } else if (row.state === 'externally_acknowledged') {
    summary = 'The external system accepted it and returned a reference. Nothing has checked the result yet.';
  } else if (row.state === 'executed') {
    summary = 'Blueprint completed the action. There was nothing external to acknowledge, or none was returned.';
  } else if (row.state === 'ambiguous') {
    summary = 'The outcome cannot be determined without a human — see the anomalies below.';
  } else if (row.state === 'cancelled') {
    summary = 'Cancelled before execution completed.';
  } else if (row.state === 'executing') {
    summary = 'Execution is in flight.';
  } else {
    summary = 'Authorised. Execution has not started (or does not apply to this action).';
  }

  return {
    receipt_id: row.id,
    state: row.state,
    result_status: row.result_status,
    stages,
    blocked_by: blocked,
    external: s.externally_acknowledged.reached
      ? { system: s.externally_acknowledged.system, id: s.externally_acknowledged.external_id, permalink: s.externally_acknowledged.permalink }
      : null,
    attempts: row.attempt_count,
    anomalies: (view.anomalies as unknown[]) ?? [],
    summary,
  };
}

function dispositionForTask(
  task: TaskRow,
  action: ExplanationActionState,
  taxonomyState: string,
): { disposition: ExplanationDisposition; headline: string } {
  if (task.status === 'rejected') {
    return {
      disposition: 'rejected',
      headline: `Rejected — ${task.rejection_reason ?? 'no reason was recorded'}. Nothing was done.`,
    };
  }
  if (task.status === 'deferred') {
    return {
      disposition: 'deferred',
      headline: `Deferred${task.deferred_until ? ` until ${task.deferred_until}` : ''} — ${task.deferred_reason ?? 'no reason was recorded'}. Nothing has been done.`,
    };
  }
  if (task.status === 'cancelled') {
    return { disposition: 'no_op', headline: 'Cancelled before anything was done.' };
  }
  if (task.status === 'failed' || action.state === 'failed') {
    return {
      disposition: 'failed',
      headline: `Attempted and failed — ${action.blocked_by ?? task.outcome ?? 'no failure detail was recorded'}.`,
    };
  }
  if (action.state === 'rejected_pre_execution') {
    return { disposition: 'rejected', headline: `Never ran — ${action.blocked_by ?? 'a gate blocked it before execution'}.` };
  }
  if (task.status === 'proposed') {
    return { disposition: 'awaiting_decision', headline: 'Proposed and waiting on a decision. Nothing has been done yet.' };
  }
  if (task.status === 'approved' || task.status === 'executing') {
    return { disposition: 'in_progress', headline: 'Approved and in flight. No result exists yet.' };
  }
  if (task.status === 'complete' || task.status === 'verified') {
    return {
      disposition: 'acted',
      headline: taxonomyState === 'outcome_measured'
        ? 'Done, and a measurement of the result exists.'
        : taxonomyState === 'verified_action'
          ? 'Done and confirmed, but no business outcome can be measured for it.'
          : 'Done. The measurement window has not produced a result yet — no value may be claimed.',
    };
  }
  return { disposition: 'no_op', headline: `Task status is '${task.status}'; nothing has been done.` };
}

function confidenceForTask(
  task: TaskRow,
  latestDecision: Record<string, unknown> | null,
  causal: CausalClaim,
  action: ExplanationActionState,
): ExplanationConfidence {
  const recorded = typeof latestDecision?.confidence === 'number'
    ? (latestDecision.confidence as number)
    : (typeof task.confidence === 'number' ? task.confidence : null);

  const limitations: string[] = [];
  if (recorded != null) {
    limitations.push('This is the proposing agent\'s own self-reported confidence at proposal time. It is not a measured success rate.');
  }
  if (task.degraded_data) {
    limitations.push('The task was produced from partial or degraded connector data, so the confidence is worth less than its face value.');
  }
  if (action.attempts > 1) {
    limitations.push(`The action needed ${action.attempts} attempts, which the proposal-time confidence did not anticipate.`);
  }

  return {
    value: recorded,
    basis: recorded == null ? 'none' : 'recorded',
    interpretation: recorded == null
      ? 'No confidence score was recorded for this task by any module, and none has been invented here.'
      : `${Math.round(recorded * 100)}% is the confidence the proposing agent recorded when it raised this. It is a statement about the proposal, not about the result.`,
    limitations,
    degraded: !!task.degraded_data,
    degraded_reason: task.degraded_data ? 'The task was produced from partial or degraded connector data.' : null,
    causal_claim: causal,
    causal_claim_meaning: '',
  };
}
