/**
 * Explanation panels (issue #60).
 *
 * Six cases, because an explanation surface that only works when everything
 * went well is worse than none at all — it teaches an operator to trust a
 * panel that goes quiet exactly when something is wrong:
 *
 *   success      full evidence, a clear trigger, a cited policy, a verified
 *                receipt and a measured outcome
 *   no-op        nothing happened, explained honestly, with the reason
 *   suppression  a hiring candidate withheld by a prior operator decision,
 *                and a comparison that ended in deferral
 *   fallback     an LLM-reasoning failure (#47) explained as DEGRADED, not
 *                as a confident recommendation
 *   failure      a rejected/failed action explained with what blocked it
 *   redaction    secrets in the underlying records never reach the payload
 *
 * Plus the two structural properties the schema exists to enforce: missing
 * evidence is never rendered as a negative finding, and no explanation
 * claims causation it cannot support.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { RECEIPT_SCHEMA_VERSION, buildCorrelationKey } from '../tasks/action-receipts.js';
import { explainTask } from './explain-task.js';
import { explainDecision } from './explain-decision.js';
import { explainHiringAnalysis, explainHiringCandidate } from './explain-hiring.js';
import { explainSubject, isExplainableKind } from './index.js';
import { EXPLANATION_SCHEMA_VERSION } from './explanation.js';

/**
 * Substring check rather than the redaction module's own pattern list — a
 * bug that widened a pattern would otherwise make this test pass by
 * agreeing with the bug. The literal secret must simply not be present.
 */
function containsAnySecret(haystack: string, secrets: string[]): boolean {
  return secrets.some((s) => haystack.includes(s));
}

const BIZ = 'biz_explain_test';
const OTHER_BIZ = 'biz_explain_other';

// Deliberately realistic secrets, planted in the exact fields a real record
// would carry them in. Not real credentials — the Shopify one is
// intentionally non-hex so it can't be mistaken for (or trip scanners
// looking for) an actual Shopify access token, while still matching
// redactSensitiveText()'s shpat_ pattern.
const SHOPIFY_SECRET = 'shpat_TESTFIXTUREVALUEZZZ999888777';
const OPENAI_SECRET = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';
const BEARER_SECRET = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij';

let successTaskId = '';
let failedTaskId = '';
let rejectedTaskId = '';
let noOpTaskId = '';
let secretTaskId = '';
let deferralDecisionId = '';
let degradedAnalysisId = '';
let successAnalysisId = '';

function insertTask(businessId: string, fields: Record<string, unknown>): string {
  const id = generateId();
  const row = {
    id,
    business_id: businessId,
    title: 'Explain fixture task',
    proposed_by: 'agent:analyst',
    status: 'proposed',
    trust_tier: 'yellow',
    approval_mode: 'requires_approval',
    version: 1,
    ...fields,
  };
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO tasks (${keys.join(', ')}, created_at, updated_at) VALUES (${keys.map(() => '?').join(', ')}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(...keys.map((k) => (row as Record<string, unknown>)[k] as never));
  return id;
}

function insertReceipt(businessId: string, taskId: string, fields: Record<string, unknown>): string {
  const id = generateId();
  const row = {
    id,
    receipt_version: RECEIPT_SCHEMA_VERSION,
    business_id: businessId,
    task_id: taskId,
    task_version: 1,
    correlation_key: buildCorrelationKey(taskId, 1),
    action_type: 'github_issue',
    title: 'Explain fixture receipt',
    state: 'executed',
    result_status: 'success',
    attempt_count: 1,
    ...fields,
  };
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO action_receipts (${keys.join(', ')}, created_at, updated_at) VALUES (${keys.map(() => '?').join(', ')}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(...keys.map((k) => (row as Record<string, unknown>)[k] as never));
  return id;
}

function insertAnalysisRun(businessId: string, fields: Record<string, unknown>): string {
  const id = generateId();
  const row = {
    id,
    business_id: businessId,
    contract_version: 'hiring.analysis.v1',
    trigger_source: 'connector_sync',
    mode: 'live',
    status: 'succeeded',
    provider_attempts: 0,
    candidates_considered: 0,
    candidates_gated: 0,
    suppressed_count: 0,
    recommendations_count: 0,
    proposals_created: 0,
    coalesced_callers: 0,
    cost_usd: 0,
    degraded: 0,
    ...fields,
  };
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO hiring_analysis_runs (${keys.join(', ')}, started_at) VALUES (${keys.map(() => '?').join(', ')}, CURRENT_TIMESTAMP)`,
  ).run(...keys.map((k) => (row as Record<string, unknown>)[k] as never));
  return id;
}

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Explain Test', 'explain-test') ON CONFLICT(id) DO NOTHING").run(BIZ);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Explain Other', 'explain-other') ON CONFLICT(id) DO NOTHING").run(OTHER_BIZ);

  // ── success: signal → task → verified receipt → measured outcome ──────────
  const signalId = generateId();
  db.prepare(`
    INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, status, created_at)
    VALUES (?, ?, 'rule_conv_drop', 'conversion', 'high', 'Checkout conversion fell 18%', 'Observed across three days', 'open', CURRENT_TIMESTAMP)
  `).run(signalId, BIZ);

  successTaskId = insertTask(BIZ, {
    title: 'Fix the broken checkout upsell block',
    signal_id: signalId,
    status: 'verified',
    action_type: 'github_issue',
    confidence: 0.82,
    target_metric: 'checkout_conversion_rate',
    expected_outcome: 'Recover roughly half the lost conversion within two weeks.',
    applicability_status: 'applicable',
    applicability_reason: 'Applicable based on available capabilities: repo.write.',
    approval_risk_evidence: JSON.stringify({ calculated_tier: 'yellow', policy_version: 0 }),
    completed_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  });
  insertReceipt(BIZ, successTaskId, {
    state: 'verified',
    result_status: 'success',
    requested_at: new Date().toISOString(),
    authorized_at: new Date().toISOString(),
    authorized_by: 'dashboard:owner',
    executed_at: new Date().toISOString(),
    externally_acknowledged_at: new Date().toISOString(),
    verified_at: new Date().toISOString(),
    external_system: 'github',
    external_id: '4821',
    external_permalink: 'https://github.com/acme/widgets/issues/4821',
    verification_evidence: JSON.stringify({ method: 'metric_delta', source: 'task_outcomes', verdict: 'improved' }),
  });
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, 4, 3.4, 2.8, 21.4, 'improved', CURRENT_TIMESTAMP)
  `).run(generateId(), successTaskId);

  db.prepare(`
    INSERT INTO decisions (id, business_id, decision_type, title, decision, reasoning, evidence, confidence,
      alternatives_rejected, author, related_task_id, related_signal_id,
      effective_policy_id, effective_policy_version, effective_policy_scope, created_at)
    VALUES (?, ?, 'task_approval', 'Approve checkout fix', 'Approved', 'The signal is corroborated by three days of data.',
      ?, 0.82, ?, 'dashboard:owner', ?, ?, 'pol_biz_1', 3, 'business', CURRENT_TIMESTAMP)
  `).run(
    generateId(), BIZ,
    JSON.stringify([{ type: 'signal', id: signalId, detail: 'conversion fell 18%' }]),
    JSON.stringify([{ id: 'alt_1', title: 'Roll back the theme release', not_selected_reason: 'Higher blast radius for the same expected gain.' }]),
    successTaskId, signalId,
  );

  // ── failure: an execution that ran and failed ─────────────────────────────
  failedTaskId = insertTask(BIZ, {
    title: 'Publish the restock email',
    status: 'failed',
    action_type: 'email_campaign',
    confidence: 0.6,
    outcome: 'Provider rejected the send.',
  });
  insertReceipt(BIZ, failedTaskId, {
    state: 'failed',
    result_status: 'failure',
    attempt_count: 3,
    requested_at: new Date().toISOString(),
    authorized_at: new Date().toISOString(),
    authorized_by: 'dashboard:owner',
    execution_started_at: new Date().toISOString(),
    result_summary: 'The email provider returned 422: sender domain is not verified.',
  });

  // ── failure (never ran): rejected before execution ────────────────────────
  rejectedTaskId = insertTask(BIZ, {
    title: 'Change the storefront price of the hero product',
    status: 'rejected',
    action_type: 'shopify_price_update',
    rejection_reason: 'Financial exposure above the review threshold with no second reviewer available.',
  });
  insertReceipt(BIZ, rejectedTaskId, {
    state: 'rejected_pre_execution',
    result_status: 'rejected',
    attempt_count: 0,
    requested_at: new Date().toISOString(),
    rejected_at: new Date().toISOString(),
    rejected_by: 'policy:operating-policy',
    rejection_stage: 'policy_gate',
    rejection_reason: 'financial_exposure_block_gbp exceeded',
  });

  // ── no-op: proposed, nothing done, almost nothing known ───────────────────
  noOpTaskId = insertTask(BIZ, {
    title: 'Investigate the unexplained refund spike',
    status: 'proposed',
    proposed_by: '',
  });

  // ── redaction: a task whose payload and receipt carry real secrets ────────
  secretTaskId = insertTask(BIZ, {
    title: 'Rotate the Shopify integration',
    status: 'complete',
    action_type: 'shopify_product_update',
    action_payload: JSON.stringify({ access_token: SHOPIFY_SECRET, note: `called with ${BEARER_SECRET}` }),
    completed_at: new Date().toISOString(),
  });
  insertReceipt(BIZ, secretTaskId, {
    state: 'executed',
    result_status: 'success',
    requested_at: new Date().toISOString(),
    executed_at: new Date().toISOString(),
    result_summary: `Authenticated with ${SHOPIFY_SECRET} and ${OPENAI_SECRET}`,
    result_detail: JSON.stringify({ api_key: OPENAI_SECRET, raw_response: '<html>the entire provider body</html>' }),
    external_reference: JSON.stringify({ authorization: BEARER_SECRET, id: '5001' }),
  });
  db.prepare(`
    INSERT INTO decisions (id, business_id, decision_type, title, decision, reasoning, evidence, author, related_task_id, created_at)
    VALUES (?, ?, 'task_approval', 'Approve rotation', 'Approved', ?, ?, 'dashboard:owner', ?, CURRENT_TIMESTAMP)
  `).run(
    generateId(), BIZ,
    `Verified the connector using ${OPENAI_SECRET}.`,
    JSON.stringify([{ type: 'connector', credential: SHOPIFY_SECRET, token: BEARER_SECRET }]),
    secretTaskId,
  );

  // ── no-op / suppression: a comparison that ended in deferral (#66) ────────
  deferralDecisionId = generateId();
  db.prepare(`
    INSERT INTO decisions (id, business_id, decision_type, title, decision, reasoning, evidence, confidence,
      alternatives_rejected, author, effective_policy_id, effective_policy_version, effective_policy_scope, created_at)
    VALUES (?, ?, 'comparison_deferral', 'Comparison: deferred all 2 candidate(s)',
      'Deferred: none of the 2 compared candidates was selected. No candidate was approved or executed.',
      'Neither option has a measured track record and both financial exposures are unstated.',
      ?, NULL, ?, 'dashboard:owner', 'pol_biz_1', 3, 'business', CURRENT_TIMESTAMP)
  `).run(
    deferralDecisionId, BIZ,
    JSON.stringify([{
      type: 'comparison',
      policy_citation: 'business policy v3',
      missing_data: [
        { candidate_id: 'task_a', field: 'financial_exposure_gbp', reason: 'not stated on the task' },
        { candidate_id: 'task_b', field: 'historical_success_rate', reason: 'no completed measured tasks for this action type' },
      ],
      dimensions_unknown_for_all: ['time_to_impact_days'],
    }]),
    JSON.stringify([
      { id: 'task_a', title: 'Rewrite the product descriptions', not_selected_reason: 'All candidates were deferred; no winner was chosen.' },
      { id: 'task_b', title: 'Re-run the abandoned cart flow', not_selected_reason: 'All candidates were deferred; no winner was chosen.' },
    ]),
  );

  // ── fallback: a degraded hiring analysis (#47) ────────────────────────────
  degradedAnalysisId = insertAnalysisRun(BIZ, {
    trigger_source: 'scheduler',
    trigger_reason: 'nightly hiring sweep',
    status: 'succeeded',
    terminal_reason: 'reasoning_unavailable',
    degraded: 1,
    fallback_mode: 'deterministic_gated',
    provider: 'anthropic',
    model: 'claude-x',
    provider_status: 'failed',
    provider_attempts: 3,
    error: `provider rejected key ${OPENAI_SECRET}`,
    input_snapshot: JSON.stringify({ fresh_connector_count: 0, stale_connector_count: 2, freshness_max_age_hours: 72 }),
    candidates_considered: 4,
    candidates_gated: 4,
    diagnostics: JSON.stringify({ gated: [{ template_id: 'tpl_seo', failures: ['no_fresh_evidence', 'wip_limit'] }] }),
    completed_at: new Date().toISOString(),
  });

  // ── success: a hiring analysis that created proposals ─────────────────────
  successAnalysisId = insertAnalysisRun(BIZ, {
    trigger_source: 'connector_sync',
    trigger_reason: 'shopify sync completed',
    status: 'succeeded',
    terminal_reason: 'proposals_created',
    provider: 'anthropic',
    model: 'claude-x',
    provider_status: 'ok',
    provider_attempts: 1,
    input_snapshot: JSON.stringify({ fresh_connector_count: 3, stale_connector_count: 0, freshness_max_age_hours: 72 }),
    candidates_considered: 5,
    candidates_gated: 3,
    suppressed_count: 1,
    recommendations_count: 1,
    proposals_created: 1,
    proposal_ids: JSON.stringify(['task_hire_1']),
    diagnostics: JSON.stringify({
      gated: [{ template_id: 'tpl_ads', failures: ['roi_gate'] }],
      suppressed: [{ template_id: 'tpl_social', reason: 'hard_suppression' }],
    }),
    completed_at: new Date().toISOString(),
  });

  // ── suppression: a candidate the operator rejected outright (#44/#50) ─────
  db.prepare(`
    INSERT INTO hiring_decisions (id, business_id, template_id, decision, disposition, actor, reason,
      analysis_id, evidence_fingerprint, reconsider_policy, expires_at, decided_at, created_at)
    VALUES (?, ?, 'tpl_social', 'rejected', 'hard_suppression', 'dashboard:owner',
      'We do not want an autonomous social agent touching our brand accounts.',
      ?, 'fp_abc123', 'never', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(generateId(), BIZ, successAnalysisId);
});

afterAll(() => {
  for (const table of ['tasks', 'signals', 'decisions', 'action_receipts', 'hiring_analysis_runs', 'hiring_decisions']) {
    try { db.prepare(`DELETE FROM ${table} WHERE business_id IN (?, ?)`).run(BIZ, OTHER_BIZ); } catch { /* table may not be business-scoped */ }
  }
});

// ─── Success ─────────────────────────────────────────────────────────────────

describe('success case — a task with full evidence, policy, receipt and outcome', () => {
  test('names the trigger, cites the recorded policy version, and does not reconstruct it', () => {
    const e = explainTask(BIZ, successTaskId)!;
    expect(e.schema_version).toBe(EXPLANATION_SCHEMA_VERSION);
    expect(e.disposition).toBe('acted');
    expect(e.trigger.kind).toBe('signal');
    expect(e.trigger.unattributed).toBe(false);
    expect(e.trigger.ref?.type).toBe('signal');
    // The decision recorded its policy version, so the explanation cites
    // that one rather than whatever policy is active today.
    expect(e.policy.policy_version).toBe(3);
    expect(e.policy.reconstructed_from_current).toBe(false);
  });

  test('shows the evidence that existed, each with a citation', () => {
    const e = explainTask(BIZ, successTaskId)!;
    const signal = e.evidence.items.find((i) => i.key === 'source_signal')!;
    expect(signal.field.state).toBe('known');
    expect(signal.field.citation).toContain('signals#');
    const recorded = e.evidence.items.find((i) => i.key === 'recorded_evidence')!;
    expect(recorded.field.state).toBe('known');
  });

  test('links to the action receipt and the outcome measurement', () => {
    const e = explainTask(BIZ, successTaskId)!;
    expect(e.links.some((l) => l.rel === 'receipt')).toBe(true);
    expect(e.links.some((l) => l.rel === 'outcome')).toBe(true);
    expect(e.links.some((l) => l.rel === 'decision')).toBe(true);
  });

  test('walks the receipt stages and reaches verified', () => {
    const e = explainTask(BIZ, successTaskId)!;
    expect(e.action.state).toBe('verified');
    expect(e.action.stages.map((s) => s.stage)).toEqual([
      'requested', 'authorized', 'executed', 'externally_acknowledged', 'verified',
    ]);
    expect(e.action.stages.every((s) => s.reached)).toBe(true);
    expect(e.action.external?.system).toBe('github');
  });

  test('only a verified receipt plus a measured outcome earns a causal claim', () => {
    const e = explainTask(BIZ, successTaskId)!;
    expect(e.outcome.state).toBe('outcome_measured');
    expect(e.confidence.causal_claim).toBe('verified_causal');
  });

  test('surfaces the alternative that was rejected', () => {
    const e = explainTask(BIZ, successTaskId)!;
    const alt = e.alternatives.find((a) => a.id === 'alt_1')!;
    expect(alt.disposition).toBe('rejected');
    expect(alt.reason).toContain('blast radius');
  });
});

// ─── Calibration: never claim more than the evidence supports ────────────────

describe('calibration — an explanation never implies unsupported causal certainty', () => {
  test('a completed task with no measurement is expected_only, never causal', () => {
    const e = explainTask(BIZ, secretTaskId)!;
    expect(e.confidence.causal_claim).toBe('expected_only');
    expect(e.limitations.join(' ')).toContain('projection');
  });

  test('a proposal with nothing done establishes no causal claim at all', () => {
    const e = explainTask(BIZ, noOpTaskId)!;
    expect(e.confidence.causal_claim).toBe('not_established');
  });

  test('a self-reported confidence is labelled as such, not as a success rate', () => {
    const e = explainTask(BIZ, successTaskId)!;
    expect(e.confidence.basis).toBe('recorded');
    expect(e.confidence.limitations.join(' ')).toContain('not a measured success rate');
  });
});

// ─── No-op ───────────────────────────────────────────────────────────────────

describe('no-op case — nothing happened, and that is the answer', () => {
  test('a proposed task explains that nothing has been done, without inventing a reason', () => {
    const e = explainTask(BIZ, noOpTaskId)!;
    expect(e.disposition).toBe('awaiting_decision');
    expect(e.headline).toContain('Nothing has been done');
    expect(e.action.receipt_id).toBeNull();
    expect(e.action.summary).toContain('No action has been attempted');
  });

  test('an unattributable task says so instead of guessing a trigger', () => {
    const e = explainTask(BIZ, noOpTaskId)!;
    expect(e.trigger.unattributed).toBe(true);
    expect(e.trigger.kind).toBe('unknown');
    expect(e.trigger.summary).toContain('cannot say what caused it');
  });

  test('missing evidence is reported as a gap, never as a negative finding', () => {
    const e = explainTask(BIZ, noOpTaskId)!;
    expect(e.evidence.missing_keys).toContain('source_signal');
    expect(e.evidence.missing_keys).toContain('target_metric');
    // The #66 envelope guarantees a missing field can carry no value.
    for (const key of e.evidence.missing_keys) {
      const item = e.evidence.items.find((i) => i.key === key)!;
      expect(item.field.state).toBe('unknown');
      expect(item.field.value).toBeNull();
      expect(item.field.reason).toBeTruthy();
    }
    expect(e.limitations.join(' ')).toContain('not asserting they are absent or zero');
  });

  test('a comparison deferral is a first-class explanation, not an empty one', () => {
    const e = explainDecision(BIZ, deferralDecisionId)!;
    expect(e.disposition).toBe('deferred');
    expect(e.headline).toContain('Nothing was approved or executed');
    expect(e.action.receipt_id).toBeNull();
    expect(e.action.summary).toContain('Nothing was requested');
    // Both losing candidates are still explained, with the deferral reason.
    expect(e.alternatives.length).toBe(2);
    expect(e.alternatives.every((a) => a.disposition === 'deferred')).toBe(true);
  });

  test('a deferral surfaces the gaps the reviewer decided with', () => {
    const e = explainDecision(BIZ, deferralDecisionId)!;
    const gaps = e.evidence.items.find((i) => i.key === 'comparison_gaps')!;
    expect(gaps.quality).toBe('negative');
    expect(gaps.caveat).toContain('2 field(s)');
    const unknownDims = e.evidence.items.find((i) => i.key === 'dimensions_unknown_for_all')!;
    expect(unknownDims.quality).toBe('missing');
    expect(unknownDims.field.reason).toContain('time_to_impact_days');
  });

  test('a deferral records no confidence rather than inventing one', () => {
    const e = explainDecision(BIZ, deferralDecisionId)!;
    expect(e.confidence.value).toBeNull();
    expect(e.confidence.basis).toBe('none');
    expect(e.confidence.limitations.join(' ')).toContain('deferring is a decision not to decide');
  });

  test('a hiring run that hired nobody explains why, with its documented reason', () => {
    const noCandidates = insertAnalysisRun(BIZ, {
      trigger_source: 'scheduler',
      status: 'succeeded',
      terminal_reason: 'no_candidates',
      input_snapshot: JSON.stringify({ fresh_connector_count: 2, stale_connector_count: 0 }),
      candidates_considered: 0,
      completed_at: new Date().toISOString(),
    });
    const e = explainHiringAnalysis(BIZ, noCandidates)!;
    expect(e.disposition).toBe('no_op');
    expect(e.headline).toContain('No uninstalled agent template');
    expect(e.action.summary).toContain('Nothing was created');
    // Zero candidates is a counted finding, not an unknown.
    const considered = e.evidence.items.find((i) => i.key === 'candidates_considered')!;
    expect(considered.quality).toBe('negative');
    expect(considered.field.value).toBe(0);
  });
});

// ─── Suppression ─────────────────────────────────────────────────────────────

describe('suppression case — a candidate withheld by a prior operator decision', () => {
  test('explains that it is suppressed, by whom, and why', () => {
    const e = explainHiringCandidate(BIZ, 'tpl_social')!;
    expect(e.disposition).toBe('suppressed');
    expect(e.headline).toContain('hard suppression');
    expect(e.trigger.actor).toBe('dashboard:owner');
    const prior = e.evidence.items.find((i) => i.key === 'prior_decision')!;
    // A recorded rejection is a real finding, not a data gap.
    expect(prior.quality).toBe('negative');
    expect((prior.field.value as Record<string, unknown>).reason).toContain('brand accounts');
  });

  test('states when — or whether — the suppression can be reconsidered', () => {
    const e = explainHiringCandidate(BIZ, 'tpl_social')!;
    const alt = e.alternatives.find((a) => a.disposition === 'suppressed')!;
    expect(alt.reconsider?.policy).toBe('never');
    expect(e.policy.provisions.some((p) => p.effect.includes('never be re-proposed automatically'))).toBe(true);
  });

  test('nothing was requested, and nothing will be while the suppression holds', () => {
    const e = explainHiringCandidate(BIZ, 'tpl_social')!;
    expect(e.action.receipt_id).toBeNull();
    expect(e.action.summary).toContain('while the suppression holds');
  });

  test('a candidate nobody ever assessed is explained as unassessed, not unsuitable', () => {
    const e = explainHiringCandidate(BIZ, 'tpl_never_seen')!;
    expect(e.disposition).toBe('no_op');
    expect(e.limitations.join(' ')).toContain('has never been assessed');
    const prior = e.evidence.items.find((i) => i.key === 'prior_decision')!;
    expect(prior.quality).toBe('missing');
    expect(prior.field.value).toBeNull();
  });

  test('a gated candidate reports the specific gates it failed', () => {
    const e = explainHiringCandidate(BIZ, 'tpl_ads')!;
    expect(e.alternatives.some((a) => a.disposition === 'gated' && a.reason === 'roi_gate')).toBe(true);
  });

  test('a hiring run where everything was suppressed is dispositioned as suppressed', () => {
    const allSuppressed = insertAnalysisRun(BIZ, {
      trigger_source: 'scheduler',
      status: 'succeeded',
      terminal_reason: 'all_suppressed',
      input_snapshot: JSON.stringify({ fresh_connector_count: 2, stale_connector_count: 0 }),
      candidates_considered: 2,
      suppressed_count: 2,
      diagnostics: JSON.stringify({ suppressed: [{ template_id: 'tpl_social', reason: 'hard_suppression' }] }),
      completed_at: new Date().toISOString(),
    });
    const e = explainHiringAnalysis(BIZ, allSuppressed)!;
    expect(e.disposition).toBe('suppressed');
    expect(e.alternatives.some((a) => a.disposition === 'suppressed')).toBe(true);
  });
});

// ─── Fallback / degraded ─────────────────────────────────────────────────────

describe('fallback case — a degraded decision is explained as degraded, not as confident', () => {
  test('marks the run degraded, names the fallback mode, and refuses a confidence figure', () => {
    const e = explainHiringAnalysis(BIZ, degradedAnalysisId)!;
    expect(e.disposition).toBe('failed');
    expect(e.confidence.degraded).toBe(true);
    expect(e.confidence.degraded_reason).toContain('deterministic_gated');
    expect(e.confidence.value).toBeNull();
    expect(e.confidence.basis).toBe('none');
    expect(e.limitations.join(' ')).toContain('must not be read as a confident recommendation');
  });

  test('the degraded reasoning provider is flagged in the evidence itself', () => {
    const e = explainHiringAnalysis(BIZ, degradedAnalysisId)!;
    const provider = e.evidence.items.find((i) => i.key === 'reasoning_provider')!;
    expect(provider.quality).toBe('degraded');
    expect(e.evidence.degraded_keys).toContain('reasoning_provider');
    expect(e.evidence.summary).toContain('degraded source');
  });

  test('zero fresh connectors reads as a counted negative, stale ones as stale', () => {
    const e = explainHiringAnalysis(BIZ, degradedAnalysisId)!;
    const fresh = e.evidence.items.find((i) => i.key === 'fresh_connectors')!;
    expect(fresh.quality).toBe('negative');
    expect(fresh.caveat).toContain('nothing current to reason from');
    expect(e.evidence.stale_keys).toContain('stale_connectors');
  });

  test('a task built from degraded connector data discloses it', () => {
    const degradedTask = insertTask(BIZ, {
      title: 'Reprice from partial catalogue data',
      status: 'complete',
      degraded_data: 1,
      confidence: 0.9,
      completed_at: new Date().toISOString(),
    });
    const e = explainTask(BIZ, degradedTask)!;
    expect(e.confidence.degraded).toBe(true);
    expect(e.confidence.limitations.join(' ')).toContain('worth less than its face value');
    expect(e.evidence.degraded_keys).toContain('input_data_quality');
  });
});

// ─── Failure ─────────────────────────────────────────────────────────────────

describe('failure case — what was attempted, and what blocked it', () => {
  test('a failed execution names the blocking error and the attempt count', () => {
    const e = explainTask(BIZ, failedTaskId)!;
    expect(e.disposition).toBe('failed');
    expect(e.action.state).toBe('failed');
    expect(e.action.attempts).toBe(3);
    expect(e.action.blocked_by).toContain('sender domain is not verified');
    expect(e.confidence.limitations.join(' ')).toContain('3 attempts');
  });

  test('a pre-execution rejection is explained as never having run', () => {
    const e = explainTask(BIZ, rejectedTaskId)!;
    expect(e.disposition).toBe('rejected');
    expect(e.action.state).toBe('rejected_pre_execution');
    expect(e.action.blocked_by).toContain('financial_exposure_block_gbp');
    expect(e.action.stages.find((s) => s.stage === 'executed')!.reached).toBe(false);
    expect(e.outcome.state).toBe('activity');
  });

  test('a rejected task claims no outcome and no causation', () => {
    const e = explainTask(BIZ, rejectedTaskId)!;
    expect(e.confidence.causal_claim).toBe('not_established');
    expect(e.outcome.summary).toContain('Nothing beyond "work was attempted"');
  });
});

// ─── Redaction ───────────────────────────────────────────────────────────────

describe('redaction — secrets in the source records never reach an explanation', () => {
  test('a task whose payload, receipt and decision all carry credentials leaks none of them', () => {
    const e = explainTask(BIZ, secretTaskId)!;
    const serialised = JSON.stringify(e);
    expect(containsAnySecret(serialised, [SHOPIFY_SECRET, OPENAI_SECRET, BEARER_SECRET])).toBe(false);
    expect(serialised).not.toContain('the entire provider body');
  });

  test('a hiring run whose stored error embeds a provider key leaks nothing', () => {
    const e = explainHiringAnalysis(BIZ, degradedAnalysisId)!;
    const serialised = JSON.stringify(e);
    expect(containsAnySecret(serialised, [OPENAI_SECRET])).toBe(false);
  });

  test('redaction removes the secret without removing the explanation', () => {
    const e = explainTask(BIZ, secretTaskId)!;
    // The point of redacting rather than dropping: the operator still gets a
    // usable account of what happened.
    expect(e.subject.title).toBe('Rotate the Shopify integration');
    expect(e.action.state).toBe('executed');
    expect(e.evidence.items.length).toBeGreaterThan(0);
  });
});

// ─── Scoping and dispatch ────────────────────────────────────────────────────

describe('dispatch and business scoping', () => {
  test('every subject kind is routable, and unknown kinds are rejected', () => {
    expect(isExplainableKind('task')).toBe(true);
    expect(isExplainableKind('decision')).toBe(true);
    expect(isExplainableKind('hiring_analysis')).toBe(true);
    expect(isExplainableKind('hiring_candidate')).toBe(true);
    expect(isExplainableKind('invoice')).toBe(false);
  });

  test('another business cannot explain this business\'s task', () => {
    expect(explainSubject(OTHER_BIZ, 'task', successTaskId)).toBeNull();
    expect(explainSubject(OTHER_BIZ, 'decision', deferralDecisionId)).toBeNull();
    expect(explainSubject(OTHER_BIZ, 'hiring_analysis', successAnalysisId)).toBeNull();
  });

  test('every explanation carries a non-empty limitations list', () => {
    for (const [kind, id] of [
      ['task', successTaskId], ['task', noOpTaskId], ['task', failedTaskId],
      ['decision', deferralDecisionId],
      ['hiring_analysis', degradedAnalysisId], ['hiring_analysis', successAnalysisId],
      ['hiring_candidate', 'tpl_social'],
    ] as const) {
      const e = explainSubject(BIZ, kind, id)!;
      expect(e).not.toBeNull();
      expect(e.limitations.length).toBeGreaterThan(0);
      expect(e.disposition_meaning.length).toBeGreaterThan(0);
      expect(e.confidence.causal_claim_meaning.length).toBeGreaterThan(0);
    }
  });
});
