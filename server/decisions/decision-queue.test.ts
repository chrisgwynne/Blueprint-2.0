/**
 * Decision Centre — the human review queue (#61).
 *
 * The acceptance criteria this file covers:
 *   - a reviewer sees pending decisions with evidence, risk, affected
 *     business and the action that would actually be taken
 *   - approve / reject / defer / amend all work and are recorded
 *   - unsupported and high-risk items are in their own lanes, not mixed in
 *     with routine work
 *   - a policy hold can be overridden only with an auditable reason
 *   - every outcome carries the effective operating policy version (#68)
 *   - recurring decision classes read from #68's policy, and promoting one
 *     into a standing rule produces a validated patch without writing policy
 *   - nothing crosses a business boundary
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db from '../db/db.js';
import { createTask, getTask } from '../tasks/task-queue.js';
import { savePolicyVersion } from '../policy/operating-policy.js';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';
import {
  DecisionQueueError, listDecisionClasses, listPendingDecisions,
  proposePolicyRuleFromDecision, reviewDecision,
} from './decision-queue.js';

const BIZ = 'biz_decq_a';
const OTHER = 'biz_decq_b';
const REVIEWER = 'dashboard:reviewer-a';

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Decision Queue A', 'decq-a') ON CONFLICT(id) DO NOTHING").run(BIZ);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Decision Queue B', 'decq-b') ON CONFLICT(id) DO NOTHING").run(OTHER);
});

afterEach(() => {
  for (const id of [BIZ, OTHER]) {
    db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(id);
    db.prepare('DELETE FROM execution_jobs WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM system_issues WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM decisions WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM action_receipts WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM signals WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(id);
    db.prepare('DELETE FROM operating_policy_events WHERE scope_key = ?').run(id);
    db.prepare('DELETE FROM business_profiles WHERE business_id = ?').run(id);
  }
  db.prepare("DELETE FROM action_registry WHERE action_type LIKE 'decq_%'").run();
});

function propose(opts: {
  business?: string;
  title?: string;
  actionType?: string | null;
  payload?: Record<string, unknown>;
  description?: string | null;
  confidence?: number | null;
} = {}) {
  return createTask({
    business_id: opts.business ?? BIZ,
    title: opts.title ?? 'Decision queue fixture task',
    description: opts.description ?? 'Because the connector reported a drop.',
    proposed_by: 'agent:test',
    action_type: opts.actionType ?? null,
    action_payload: opts.payload ?? {},
    confidence: opts.confidence ?? null,
    approval_mode: 'requires_approval',
  })!;
}

function policyFor(businessId: string, patch: Parameters<typeof savePolicyVersion>[0]['patch']) {
  return savePolicyVersion({ scope: 'business', key: businessId, patch, actor: REVIEWER });
}

function decisionsFor(businessId: string) {
  return db.prepare('SELECT * FROM decisions WHERE business_id = ? ORDER BY created_at ASC')
    .all(businessId) as Array<Record<string, unknown>>;
}

function futureIso(days = 7): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

// ─── The queue shows what a reviewer needs ──────────────────────────────────

describe('a reviewer sees pending decisions with evidence, risk and required action', () => {
  test('a proposed task appears with its business, risk tier and the action that would run', () => {
    const task = propose({ title: 'Raise the ad budget' });
    const queue = listPendingDecisions(BIZ);

    expect(queue.decisions).toHaveLength(1);
    const item = queue.decisions[0]!;
    expect(item.task_id).toBe(task.id);
    expect(item.business_id).toBe(BIZ);
    expect(item.title).toBe('Raise the ad budget');
    expect(['green', 'yellow', 'orange', 'red']).toContain(item.risk_tier);
    expect(item.required_action).toBeDefined();
  });

  test('evidence carries the proposal rationale, the risk assessment and the source signal', () => {
    const signalId = 'sig_decq_1';
    db.prepare(`
      INSERT INTO signals (id, business_id, rule_id, type, title, severity, data)
      VALUES (?, ?, 'rule_decq', 'traffic_drop', 'Organic traffic fell 30%', 'high', '{"delta":-0.3}')
    `).run(signalId, BIZ);
    const task = createTask({
      business_id: BIZ, title: 'Investigate the drop', description: 'Traffic fell sharply.',
      proposed_by: 'agent:test', signal_id: signalId, action_payload: {},
      approval_mode: 'requires_approval',
    })!;

    const item = listPendingDecisions(BIZ).decisions.find((d) => d.task_id === task.id)!;
    const types = item.evidence.map((e) => e.type);
    expect(types).toContain('proposal_rationale');
    expect(types).toContain('risk_assessment');
    expect(types).toContain('source_signal');

    const signalEvidence = item.evidence.find((e) => e.type === 'source_signal')!;
    expect(signalEvidence.summary).toContain('Organic traffic fell 30%');
  });

  test('the queue cites the operating policy version in force', () => {
    const v1 = policyFor(BIZ, { notes: 'reviewer governance' });
    propose();
    const queue = listPendingDecisions(BIZ);
    expect(queue.policy.policy_version).toBe(1);
    expect(queue.policy.policy_id).toBe(v1.id);
    expect(queue.decisions[0]!.policy.policy_version).toBe(1);
  });

  test('risk is recalculated under the policy in force, not frozen at proposal time', () => {
    // £250 is below the default £500 block threshold, so this starts orange.
    const task = propose({ payload: { financial_exposure_gbp: 250 } });
    expect(listPendingDecisions(BIZ).decisions[0]!.risk_tier).toBe('orange');

    // Tighten the policy: the SAME task must now read as red to a reviewer.
    policyFor(BIZ, { thresholds: { financial_exposure_block_gbp: 200 } });
    const after = listPendingDecisions(BIZ).decisions.find((d) => d.task_id === task.id)!;
    expect(after.risk_tier).toBe('red');
  });
});

// ─── Lanes: high-risk and unsupported work is visibly distinct ──────────────

describe('unsupported and high-risk actions are not mixed in with routine items', () => {
  test('a manual_review task is in its own lane with an explanation', () => {
    const task = propose({ title: 'Ambiguous outcome' });
    db.prepare("UPDATE tasks SET status = 'manual_review' WHERE id = ?").run(task.id);

    const item = listPendingDecisions(BIZ).decisions.find((d) => d.task_id === task.id)!;
    expect(item.lane).toBe('manual_review');
    expect(item.lane_reason.length).toBeGreaterThan(0);
  });

  test('a red-tier action is policy_gated and held, not routine', () => {
    const task = propose({ payload: { financial_exposure_gbp: 5000 } });
    const item = listPendingDecisions(BIZ).decisions.find((d) => d.task_id === task.id)!;

    expect(item.risk_tier).toBe('red');
    expect(item.lane).toBe('policy_gated');
    expect(item.policy_recommendation).toBe('hold');
    expect(item.requires_override_reason).toBe(true);
    expect(item.hold_reasons.join(' ')).toContain('red');
  });

  test('an action type on always_require_human_action_types is policy_gated', () => {
    upsertActionRegistryEntry('decq_update_copy', {
      description: 'Update page copy', dispatched_by_executor: true, active: true,
    });
    policyFor(BIZ, { approvals: { always_require_human_action_types: ['decq_update_copy'] } });
    const task = propose({ actionType: 'decq_update_copy' });

    const item = listPendingDecisions(BIZ).decisions.find((d) => d.task_id === task.id)!;
    expect(item.lane).toBe('policy_gated');
    expect(item.policy_recommendation).toBe('human_required');
    // "A human must approve" is the policy working, not something to override.
    expect(item.requires_override_reason).toBe(false);
  });

  test('lane counts let the queue be triaged at a glance', () => {
    propose({ payload: { financial_exposure_gbp: 5000 } });   // red -> policy_gated
    const ambiguous = propose({ title: 'Ambiguous' });
    db.prepare("UPDATE tasks SET status = 'manual_review' WHERE id = ?").run(ambiguous.id);

    const { counts } = listPendingDecisions(BIZ);
    expect(counts.total).toBe(2);
    expect(counts.policy_gated).toBe(1);
    expect(counts.manual_review).toBe(1);
  });

  test('the most urgent lane sorts first', () => {
    propose({ title: 'Routine' });
    const ambiguous = propose({ title: 'Ambiguous' });
    db.prepare("UPDATE tasks SET status = 'manual_review' WHERE id = ?").run(ambiguous.id);

    expect(listPendingDecisions(BIZ).decisions[0]!.lane).toBe('manual_review');
  });
});

// ─── Review outcomes ────────────────────────────────────────────────────────

describe('review outcomes: approve, reject, defer and amend', () => {
  test('approve moves the task on and records a policy-citing decision', () => {
    policyFor(BIZ, { notes: 'v1' });
    const task = propose();

    const result = reviewDecision({ businessId: BIZ, taskId: task.id, outcome: 'approve', actor: REVIEWER });
    expect(result.task?.status).toBe('approved');
    expect(getTask(task.id)!.status).toBe('approved');

    const approval = decisionsFor(BIZ).find((d) => d.decision_type === 'task_approval')!;
    expect(approval.effective_policy_version).toBe(1);
    expect(approval.effective_policy_scope).toBe('business');
    expect(approval.author).toBe(REVIEWER);
  });

  test('reject requires a reason and records it', () => {
    const task = propose();
    expect(() => reviewDecision({ businessId: BIZ, taskId: task.id, outcome: 'reject', actor: REVIEWER }))
      .toThrow(/rejection reason is required/i);

    reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'reject', actor: REVIEWER,
      reason: 'The underlying signal was a tracking artefact.',
    });
    expect(getTask(task.id)!.status).toBe('rejected');

    const rejection = decisionsFor(BIZ).find((d) => d.decision_type === 'task_rejection')!;
    expect(String(rejection.reasoning)).toContain('tracking artefact');
    expect(rejection.effective_policy_version).not.toBeNull();
  });

  test('defer pushes the item to a chosen date and records the reason', () => {
    const task = propose();
    const until = futureIso(14);

    const result = reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'defer', actor: REVIEWER,
      reason: 'Waiting for the quarter to close before committing spend.',
      deferUntil: until,
    });
    expect(result.task?.status).toBe('deferred');

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;
    expect(row.deferred_until).toBe(until);
    expect(row.deferred_by).toBe(REVIEWER);
    expect(String(row.deferred_reason)).toContain('quarter to close');

    const deferral = decisionsFor(BIZ).find((d) => d.decision_type === 'task_deferral')!;
    expect(deferral).toBeDefined();
    expect(deferral.effective_policy_version).not.toBeNull();
  });

  test('a deferral needs a resurface date and a reason', () => {
    const task = propose();
    expect(() => reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'defer', actor: REVIEWER, reason: 'later',
    })).toThrow(/defer_until is required/i);

    expect(() => reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'defer', actor: REVIEWER, deferUntil: futureIso(),
    })).toThrow(/deferral reason is required/i);

    expect(() => reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'defer', actor: REVIEWER,
      reason: 'later', deferUntil: '2001-01-01T00:00:00.000Z',
    })).toThrow(/must be in the future/i);
  });

  test('a deferred item is out of the queue until it is asked for', () => {
    const task = propose();
    reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'defer', actor: REVIEWER,
      reason: 'Not this quarter.', deferUntil: futureIso(),
    });

    expect(listPendingDecisions(BIZ).decisions).toHaveLength(0);
    const withDeferred = listPendingDecisions(BIZ, { include_deferred: true });
    expect(withDeferred.decisions).toHaveLength(1);
    expect(withDeferred.decisions[0]!.deferred_until).not.toBeNull();
  });

  test('amend changes the payload, keeps the original, and approves', () => {
    // Deliberately a low-risk payload: 'budget'/'price' and friends are
    // always-red keywords in computeTierUnderPolicy(), and a red item would
    // route through the override path rather than the plain amend path.
    const task = propose({ payload: { affected_records: 8, channel: 'search' } });

    const result = reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'amend', actor: REVIEWER,
      reason: '8 records is broader than needed; narrowing it to 2.',
      amendedPayload: { affected_records: 2, channel: 'search' },
    });

    expect(result.task?.status).toBe('approved');
    expect(result.override).toBe(false);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;
    expect(JSON.parse(String(row.action_payload)).affected_records).toBe(2);
    expect(JSON.parse(String(row.pre_amendment_payload)).affected_records).toBe(8);
    expect(row.amended_by).toBe(REVIEWER);

    const amendment = decisionsFor(BIZ).find((d) => d.decision_type === 'task_amendment')!;
    expect(amendment).toBeDefined();
    expect(String(amendment.reasoning)).toContain('narrowing it to 2');
    // Both the amendment and the approval it led to are recorded.
    expect(decisionsFor(BIZ).some((d) => d.decision_type === 'task_approval')).toBe(true);
  });

  test('amend can stop short of approving, leaving the item in the queue', () => {
    const task = propose({ payload: { budget_gbp: 400 } });
    reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'amend', actor: REVIEWER,
      reason: 'Correcting the figure before I decide.',
      amendedPayload: { budget_gbp: 100 },
      approveAfterAmend: false,
    });

    expect(getTask(task.id)!.status).toBe('proposed');
    const item = listPendingDecisions(BIZ).decisions.find((d) => d.task_id === task.id)!;
    expect(item.amended_by).toBe(REVIEWER);
    expect(item.evidence.some((e) => e.type === 'payload_amendment')).toBe(true);
  });

  test('an amendment requires a reason and a payload', () => {
    const task = propose();
    expect(() => reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'amend', actor: REVIEWER, reason: 'because',
    })).toThrow(/amended_payload is required/i);

    expect(() => reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'amend', actor: REVIEWER, amendedPayload: { a: 1 },
    })).toThrow(/amendment reason is required/i);
  });

  test('an amended payload is re-validated against the action schema at approval', () => {
    upsertActionRegistryEntry('decq_set_price', {
      description: 'Set a price',
      payload_schema: { type: 'object', required: ['price_gbp'], properties: { price_gbp: { type: 'number' } } },
      dispatched_by_executor: true, active: true,
    });
    const task = propose({ actionType: 'decq_set_price', payload: { price_gbp: 10 } });

    expect(() => reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'amend', actor: REVIEWER,
      reason: 'Trying to smuggle a bad payload through.',
      amendedPayload: { price_gbp: 'free' },
      approveAfterAmend: false,
    })).toThrow(/not valid for action type/i);

    // The stored payload is untouched by the rejected amendment.
    expect(getTask(task.id)!.action_payload.price_gbp).toBe(10);
  });
});

// ─── Overrides ──────────────────────────────────────────────────────────────

describe('a policy hold is overridable only with an auditable reason', () => {
  test('approving a held item without a reason is refused', () => {
    const task = propose({ payload: { financial_exposure_gbp: 5000 } }); // red

    let error: DecisionQueueError | null = null;
    try {
      reviewDecision({ businessId: BIZ, taskId: task.id, outcome: 'approve', actor: REVIEWER });
    } catch (err) { error = err as DecisionQueueError; }

    expect(error).not.toBeNull();
    expect(error!.code).toBe('override_reason_required');
    expect(error!.status).toBe(422);
    expect(getTask(task.id)!.status).toBe('proposed');
  });

  test('a token reason is not a reason', () => {
    const task = propose({ payload: { financial_exposure_gbp: 5000 } });
    expect(() => reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'approve', actor: REVIEWER, overrideReason: 'ok',
    })).toThrow(/override/i);
  });

  test('with a written reason the override proceeds and is audited on the decision', () => {
    policyFor(BIZ, { notes: 'v1' });
    const task = propose({ payload: { financial_exposure_gbp: 5000 } });

    const result = reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'approve', actor: REVIEWER,
      overrideReason: 'Board pre-approved this spend on 2026-08-01; minutes attached to the goal.',
    });

    expect(result.override).toBe(true);
    expect(result.policy_recommendation).toBe('hold');
    expect(getTask(task.id)!.status).toBe('approved');

    // The reason is on the task...
    const row = db.prepare('SELECT review_override_reason FROM tasks WHERE id = ?').get(task.id) as { review_override_reason: string };
    expect(row.review_override_reason).toContain('Board pre-approved');

    // ...and on the decision record, with the policy version it overrode.
    const approval = decisionsFor(BIZ).find((d) => d.decision_type === 'task_approval')!;
    expect(String(approval.reasoning)).toContain('POLICY OVERRIDE');
    expect(String(approval.reasoning)).toContain('Board pre-approved');
    expect(approval.effective_policy_version).toBe(1);

    const evidence = JSON.parse(String(approval.evidence)) as Array<Record<string, unknown>>;
    const override = evidence.find((e) => e.type === 'policy_override')!;
    expect(override.override_reason).toContain('Board pre-approved');
    expect(override.policy_version).toBe(1);
  });

  test('approving a routine item is not an override and needs no reason', () => {
    const task = propose();
    const result = reviewDecision({ businessId: BIZ, taskId: task.id, outcome: 'approve', actor: REVIEWER });
    expect(result.override).toBe(false);
    expect(result.override_reason).toBeNull();
  });

  test('amending a held item into an approval is also an override', () => {
    const task = propose({ payload: { financial_exposure_gbp: 5000 } });
    expect(() => reviewDecision({
      businessId: BIZ, taskId: task.id, outcome: 'amend', actor: REVIEWER,
      reason: 'Adjusting the spend.', amendedPayload: { financial_exposure_gbp: 4000 },
    })).toThrow(/override/i);
  });
});

// ─── Recurring decision classes and standing rules ──────────────────────────

describe('recurring decision classes reuse #68 policy rather than redefining it', () => {
  test('classes group by action type and count what is pending', () => {
    upsertActionRegistryEntry('decq_update_copy', { description: 'Update copy', dispatched_by_executor: true, active: true });
    propose({ actionType: 'decq_update_copy' });
    propose({ actionType: 'decq_update_copy' });
    propose({ actionType: null });

    const { classes } = listDecisionClasses(BIZ);
    const copyClass = classes.find((c) => c.decision_class === 'decq_update_copy')!;
    expect(copyClass.pending_count).toBe(2);
    expect(classes.find((c) => c.decision_class === 'manual_task_no_action_type')!.pending_count).toBe(1);
  });

  test('a class reports whether #68 policy already has a standing human rule', () => {
    upsertActionRegistryEntry('decq_update_copy', { description: 'Update copy', dispatched_by_executor: true, active: true });
    propose({ actionType: 'decq_update_copy' });
    expect(listDecisionClasses(BIZ).classes[0]!.already_has_human_rule).toBe(false);

    policyFor(BIZ, { approvals: { always_require_human_action_types: ['decq_update_copy'] } });
    expect(listDecisionClasses(BIZ).classes[0]!.already_has_human_rule).toBe(true);
  });

  test('promoting a decision into a rule returns a validated patch and writes no policy', () => {
    upsertActionRegistryEntry('decq_update_copy', { description: 'Update copy', dispatched_by_executor: true, active: true });
    const task = propose({ actionType: 'decq_update_copy' });

    const proposal = proposePolicyRuleFromDecision({
      businessId: BIZ, taskId: task.id, ruleKind: 'always_require_human',
    });

    expect(proposal.decision_class).toBe('decq_update_copy');
    expect(proposal.patch.approvals?.always_require_human_action_types).toContain('decq_update_copy');
    expect(proposal.already_in_effect).toBe(false);
    expect(proposal.preview.valid).toBe(true);
    expect(proposal.statement).toContain('decq_update_copy');

    // Crucially: still no policy version written. Saving stays in #68's editor.
    const versions = db.prepare('SELECT COUNT(*) AS n FROM operating_policies WHERE scope_key = ?')
      .get(BIZ) as { n: number };
    expect(versions.n).toBe(0);
  });

  test('a tier-cap rule proposes a ceiling below the item that triggered it', () => {
    upsertActionRegistryEntry('decq_big_spend', { description: 'Big spend', dispatched_by_executor: true, active: true });
    const task = propose({ actionType: 'decq_big_spend', payload: { financial_exposure_gbp: 5000 } }); // red

    const proposal = proposePolicyRuleFromDecision({
      businessId: BIZ, taskId: task.id, ruleKind: 'cap_auto_approve_tier',
    });
    // Capped at 'green', not 'orange': the cap must also stay strictly below
    // require_human_approval_at_or_above ('yellow' by default), or #68's
    // validator would reject the rule as a contradiction. A proposal the
    // policy editor could not save would be worse than none.
    expect(proposal.patch.approvals?.auto_approve_max_tier).toBe('green');
    expect(proposal.preview.valid).toBe(true);
  });

  test('a decision with no action type has no bounded class to make a rule from', () => {
    const task = propose({ actionType: null });
    expect(() => proposePolicyRuleFromDecision({
      businessId: BIZ, taskId: task.id, ruleKind: 'always_require_human',
    })).toThrow(/no recurring class/i);
  });

  test('a rule already in force is reported as such rather than proposed again', () => {
    upsertActionRegistryEntry('decq_update_copy', { description: 'Update copy', dispatched_by_executor: true, active: true });
    policyFor(BIZ, { approvals: { always_require_human_action_types: ['decq_update_copy'] } });
    const task = propose({ actionType: 'decq_update_copy' });

    const proposal = proposePolicyRuleFromDecision({
      businessId: BIZ, taskId: task.id, ruleKind: 'always_require_human',
    });
    expect(proposal.already_in_effect).toBe(true);
    // No duplicate entry in the proposed patch.
    expect(proposal.patch.approvals?.always_require_human_action_types)
      .toEqual(['decq_update_copy']);
  });
});

// ─── Cross-business isolation ───────────────────────────────────────────────

describe('a reviewer working business A cannot see or act on business B', () => {
  test('the queue never returns another business\'s pending decisions', () => {
    propose({ business: BIZ, title: 'A task' });
    propose({ business: OTHER, title: 'B task' });

    const queueA = listPendingDecisions(BIZ);
    expect(queueA.decisions).toHaveLength(1);
    expect(queueA.decisions[0]!.title).toBe('A task');
    expect(queueA.decisions.every((d) => d.business_id === BIZ)).toBe(true);

    const queueB = listPendingDecisions(OTHER);
    expect(queueB.decisions.map((d) => d.title)).toEqual(['B task']);
  });

  test('reviewing another business\'s task is reported as not found, not forbidden', () => {
    const taskB = propose({ business: OTHER, title: 'B task' });

    let error: DecisionQueueError | null = null;
    try {
      reviewDecision({ businessId: BIZ, taskId: taskB.id, outcome: 'approve', actor: REVIEWER });
    } catch (err) { error = err as DecisionQueueError; }

    expect(error).not.toBeNull();
    expect(error!.status).toBe(404);
    expect(error!.code).toBe('not_found');
    // The status of B's task is untouched by A's reviewer.
    expect(getTask(taskB.id)!.status).toBe('proposed');
  });

  test('every outcome is blocked across the boundary, not just approve', () => {
    const taskB = propose({ business: OTHER });
    for (const outcome of ['reject', 'defer', 'amend'] as const) {
      expect(() => reviewDecision({
        businessId: BIZ, taskId: taskB.id, outcome, actor: REVIEWER,
        reason: 'crossing the boundary', deferUntil: futureIso(),
        amendedPayload: { x: 1 },
      })).toThrow(/No pending decision/);
    }
    expect(getTask(taskB.id)!.status).toBe('proposed');
  });

  test('a standing rule cannot be proposed from another business\'s decision', () => {
    upsertActionRegistryEntry('decq_update_copy', { description: 'Update copy', dispatched_by_executor: true, active: true });
    const taskB = propose({ business: OTHER, actionType: 'decq_update_copy' });

    expect(() => proposePolicyRuleFromDecision({
      businessId: BIZ, taskId: taskB.id, ruleKind: 'always_require_human',
    })).toThrow(/No pending decision/);
  });

  test('policy isolation: business A\'s policy does not classify business B\'s queue', () => {
    // A holds everything back; B is left on defaults. The action type must be
    // registered before the rule names it — #68 refuses a rule about an
    // action type that could never be proposed.
    upsertActionRegistryEntry('decq_update_copy', { description: 'Update copy', dispatched_by_executor: true, active: true });
    policyFor(BIZ, { approvals: { always_require_human_action_types: ['decq_update_copy'] } });
    propose({ business: BIZ, actionType: 'decq_update_copy' });
    propose({ business: OTHER, actionType: 'decq_update_copy' });

    expect(listPendingDecisions(BIZ).decisions[0]!.lane).toBe('policy_gated');
    expect(listPendingDecisions(OTHER).decisions[0]!.lane).toBe('routine');
    expect(listPendingDecisions(OTHER).policy.policy_version).toBe(0);
  });

  test('decision classes are counted per business', () => {
    upsertActionRegistryEntry('decq_update_copy', { description: 'Update copy', dispatched_by_executor: true, active: true });
    propose({ business: BIZ, actionType: 'decq_update_copy' });
    propose({ business: OTHER, actionType: 'decq_update_copy' });
    propose({ business: OTHER, actionType: 'decq_update_copy' });

    expect(listDecisionClasses(BIZ).classes[0]!.pending_count).toBe(1);
    expect(listDecisionClasses(OTHER).classes[0]!.pending_count).toBe(2);
  });
});
