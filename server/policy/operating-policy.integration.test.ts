/**
 * Operating Policy wired into real decision paths (#68).
 *
 * The acceptance criteria this file covers:
 *   - every decision records the effective policy version and business scope
 *   - autonomy limits and approval requirements actually gate approval
 *   - a human is never gated by a policy meant to govern unattended work
 *   - the pre-#68 business_profiles.automation_policy cap still applies
 *   - none of it leaks across businesses
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db from '../db/db.js';
import { createTask, approveTask, rejectTask } from '../tasks/task-queue.js';
import { updateBusinessProfile } from '../business/business-profile.js';
import { listSystemIssues } from '../system/system-issues.js';
import { recordDecision } from '../brain/decision-memory.js';
import { calculateApprovalTier } from '../trust/trust-engine.js';
import { resolveOperatingPolicy, savePolicyVersion, rollbackPolicy } from './operating-policy.js';

const BIZ = 'biz_oppolicy_int_a';
const OTHER = 'biz_oppolicy_int_b';
const ACTOR = 'dashboard:integration-operator';

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Policy Integration A', 'policy-int-a') ON CONFLICT(id) DO NOTHING").run(BIZ);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Policy Integration B', 'policy-int-b') ON CONFLICT(id) DO NOTHING").run(OTHER);
});

afterEach(() => {
  for (const id of [BIZ, OTHER]) {
    db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(id);
    db.prepare('DELETE FROM execution_jobs WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM system_issues WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM decisions WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(id);
    db.prepare('DELETE FROM operating_policy_events WHERE scope_key = ?').run(id);
    db.prepare('DELETE FROM business_profiles WHERE business_id = ?').run(id);
  }
});

function propose(businessId = BIZ, payload: Record<string, unknown> = {}) {
  return createTask({
    business_id: businessId,
    title: 'Policy integration fixture task',
    proposed_by: 'test',
    action_type: null,
    action_payload: payload,
    approval_mode: 'requires_approval',
  })!;
}

function policyFor(businessId: string, patch: Parameters<typeof savePolicyVersion>[0]['patch']) {
  return savePolicyVersion({ scope: 'business', key: businessId, patch, actor: ACTOR });
}

function decisionsFor(businessId: string) {
  return db.prepare('SELECT * FROM decisions WHERE business_id = ? ORDER BY created_at DESC').all(businessId) as Array<Record<string, unknown>>;
}

// ─── Decision records cite the policy version ───────────────────────────────

describe('every decision records the effective policy version and business scope', () => {
  test('an approval decision cites the active business policy version', () => {
    const v1 = policyFor(BIZ, { notes: 'v1 governance' });
    const task = propose();
    approveTask(task.id, 'dashboard:alice');

    const decision = decisionsFor(BIZ).find((d) => d.decision_type === 'task_approval')!;
    expect(decision.effective_policy_version).toBe(1);
    expect(decision.effective_policy_id).toBe(v1.id);
    expect(decision.effective_policy_scope).toBe('business');
  });

  test('with no policy authored, a decision honestly cites system defaults as version 0', () => {
    const task = propose();
    approveTask(task.id, 'dashboard:alice');
    const decision = decisionsFor(BIZ).find((d) => d.decision_type === 'task_approval')!;
    expect(decision.effective_policy_version).toBe(0);
    expect(decision.effective_policy_scope).toBe('system_default');
    expect(decision.effective_policy_id).toBeNull();
  });

  test('the cited version tracks policy edits — later decisions cite the later version', () => {
    policyFor(BIZ, { notes: 'first' });
    approveTask(propose().id, 'dashboard:alice');
    policyFor(BIZ, { notes: 'second' });
    approveTask(propose().id, 'dashboard:alice');

    const versions = decisionsFor(BIZ)
      .filter((d) => d.decision_type === 'task_approval')
      .map((d) => d.effective_policy_version)
      .sort();
    expect(versions).toEqual([1, 2]);
  });

  test('after a rollback, new decisions cite the NEW version number, not the restored one', () => {
    policyFor(BIZ, { thresholds: { financial_exposure_review_gbp: 90 } });
    policyFor(BIZ, { thresholds: { financial_exposure_review_gbp: 5 } });
    rollbackPolicy({ key: BIZ, to_version: 1, actor: ACTOR });

    approveTask(propose().id, 'dashboard:alice');
    const decision = decisionsFor(BIZ).find((d) => d.decision_type === 'task_approval')!;
    expect(decision.effective_policy_version).toBe(3);
    expect(resolveOperatingPolicy(BIZ).document.thresholds.financial_exposure_review_gbp).toBe(90);
  });

  test('a rejection decision carries the citation too, via the shared recordDecision path', () => {
    policyFor(BIZ, { notes: 'v1' });
    const task = propose();
    rejectTask(task.id, 'dashboard:alice', 'Not now');
    const decision = decisionsFor(BIZ).find((d) => d.decision_type === 'task_rejection')!;
    expect(decision.effective_policy_version).toBe(1);
    expect(decision.effective_policy_scope).toBe('business');
  });

  test('a decision recorded directly also gets a citation without the caller supplying one', () => {
    policyFor(BIZ, { notes: 'v1' });
    recordDecision({ business_id: BIZ, decision_type: 'manual', title: 'Ad hoc', decision: 'Did a thing', author: 'human' });
    const decision = decisionsFor(BIZ)[0]!;
    expect(decision.effective_policy_version).toBe(1);
  });

  test('an explicitly supplied citation is preserved, not overwritten by a fresh resolve', () => {
    policyFor(BIZ, { notes: 'v1' });
    policyFor(BIZ, { notes: 'v2' });
    recordDecision({
      business_id: BIZ, decision_type: 'manual', title: 'Decided under v1', decision: 'x', author: 'human',
      effective_policy_id: 'policy-as-applied', effective_policy_version: 1, effective_policy_scope: 'business',
    });
    const decision = decisionsFor(BIZ)[0]!;
    expect(decision.effective_policy_version).toBe(1);
    expect(decision.effective_policy_id).toBe('policy-as-applied');
  });
});

// ─── Risk tiering is policy-driven ──────────────────────────────────────────

describe('approval tiering uses the business policy and records which version produced it', () => {
  test('a business-specific threshold changes the tier the same payload receives', () => {
    policyFor(BIZ, { thresholds: { financial_exposure_review_gbp: 10, financial_exposure_block_gbp: 20 } });

    const strictTask = propose(BIZ, { financial_exposure_gbp: 30 });
    const relaxedTask = propose(OTHER, { financial_exposure_gbp: 30 });

    // Identical payloads, different businesses: the strict policy pushes
    // £30 past its block threshold, the default policy leaves it alone.
    expect(strictTask.trust_tier).toBe('red');
    expect(relaxedTask.trust_tier).toBe('yellow');
  });

  test('the tier evidence stored on the task names the policy version in force', () => {
    const v1 = policyFor(BIZ, { thresholds: { financial_exposure_review_gbp: 10, financial_exposure_block_gbp: 20 } });
    const task = propose(BIZ, { financial_exposure_gbp: 30 });
    const row = db.prepare('SELECT approval_risk_evidence FROM tasks WHERE id = ?').get(task.id) as { approval_risk_evidence: string };
    const evidence = JSON.parse(row.approval_risk_evidence) as Record<string, unknown>;
    expect(evidence.policy_version).toBe(1);
    expect(evidence.policy_id).toBe(v1.id);
    expect(evidence.policy_scope).toBe('business');
    expect((evidence.thresholds_applied as Record<string, number>).financial_exposure_review_gbp).toBe(10);
  });

  test('calculateApprovalTier with no business scope behaves exactly as it did before #68', () => {
    expect(calculateApprovalTier({ actionType: 'report', baseTier: 'green' }).tier).toBe('green');
    expect(calculateApprovalTier({ actionType: 'github_pr', payload: { affected_records: 1 } }).tier).toBe('orange');
    expect(calculateApprovalTier({ actionType: 'shopify_product_update', payload: { affected_records: 5000, financial_exposure_gbp: 750 } }).tier).toBe('red');
  });
});

// ─── Autonomy gating at approval ────────────────────────────────────────────

describe('operating policy gates autonomous approval', () => {
  test('the master autonomy switch blocks a non-human approval and files a system issue', () => {
    policyFor(BIZ, { autonomy: { allow_autonomous_execution: false } });
    const task = propose();
    expect(() => approveTask(task.id, 'bap:some-agent')).toThrow(/allow_autonomous_execution set to false/);

    const issue = listSystemIssues({ business_id: BIZ })
      .find((i) => i.issue_type === 'operating_policy_blocked_autonomous_approval');
    expect(issue).toBeDefined();
    expect(issue!.metadata.policy_code).toBe('autonomy_disabled');
    expect(issue!.metadata.policy_version).toBe(1);
  });

  test('the same policy never blocks an explicit human dashboard approval', () => {
    policyFor(BIZ, { autonomy: { allow_autonomous_execution: false } });
    const task = propose();
    const approved = approveTask(task.id, 'dashboard:alice');
    expect(approved!.status).toBe('approved');
  });

  test('dry-run mode blocks autonomous approval with its own explanation', () => {
    policyFor(BIZ, { autonomy: { dry_run: true } });
    expect(() => approveTask(propose().id, 'bap:agent')).toThrow(/dry-run mode/);
  });

  test('an action type on the always-require-human list is blocked for agents only', () => {
    policyFor(BIZ, { approvals: { always_require_human_action_types: ['content_draft'] } });
    const task = createTask({
      business_id: BIZ, title: 'Draft something', proposed_by: 'test',
      action_type: 'content_draft', action_payload: {}, approval_mode: 'requires_approval',
    })!;
    expect(() => approveTask(task.id, 'bap:agent')).toThrow(/always_require_human_action_types/);
  });

  test('an explicit auto-approval tier ceiling blocks an over-tier autonomous approval', () => {
    policyFor(BIZ, { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } });
    const task = propose(BIZ, { financial_exposure_gbp: 300 }); // orange under default thresholds
    expect(task.trust_tier).toBe('orange');
    expect(() => approveTask(task.id, 'bap:agent')).toThrow(/auto_approve_max_tier/);
    // The human path is unaffected.
    expect(approveTask(task.id, 'dashboard:alice')!.status).toBe('approved');
  });

  test('with no ceiling set (the default) an agent approval is not newly gated', () => {
    const task = propose(BIZ, { financial_exposure_gbp: 300 });
    expect(approveTask(task.id, 'bap:agent')!.status).toBe('approved');
  });
});

// ─── Daily cap: operating policy and the legacy profile setting ─────────────

describe('daily autonomous approval cap', () => {
  test('the operating policy cap blocks further autonomous approvals once reached', () => {
    policyFor(BIZ, { autonomy: { max_autonomous_tasks_per_day: 1 } });
    expect(approveTask(propose().id, 'bap:agent')!.status).toBe('approved');
    expect(() => approveTask(propose().id, 'bap:agent')).toThrow(/caps autonomous approvals at 1\/day/);
  });

  test('the cap does not apply to a human dashboard approval', () => {
    policyFor(BIZ, { autonomy: { max_autonomous_tasks_per_day: 1 } });
    approveTask(propose().id, 'bap:agent');
    expect(approveTask(propose().id, 'dashboard:alice')!.status).toBe('approved');
  });

  test('the stricter of the legacy profile cap and the policy cap wins', () => {
    updateBusinessProfile(BIZ, { business_type: 'other', automation_policy: { max_autonomous_tasks_per_day: 1 } });
    policyFor(BIZ, { autonomy: { max_autonomous_tasks_per_day: 50 } });

    approveTask(propose().id, 'bap:agent');
    let message = '';
    try { approveTask(propose().id, 'bap:agent'); } catch (err) { message = (err as Error).message; }
    expect(message).toContain('at 1/day');
    expect(message).toContain('automation_policy.max_autonomous_tasks_per_day');
  });

  test('the system issue for a cap breach cites the policy version that imposed it', () => {
    policyFor(BIZ, { autonomy: { max_autonomous_tasks_per_day: 1 } });
    approveTask(propose().id, 'bap:agent');
    try { approveTask(propose().id, 'bap:agent'); } catch { /* expected */ }

    const issue = listSystemIssues({ business_id: BIZ })
      .find((i) => i.issue_type === 'automation_policy_daily_cap_reached');
    expect(issue).toBeDefined();
    expect(issue!.metadata.cap_source).toBe('operating_policy');
    expect(issue!.metadata.policy_version).toBe(1);
  });
});

// ─── Cross-business isolation of the gating itself ──────────────────────────

describe('cross-business isolation of policy enforcement', () => {
  test("one business's autonomy shutdown does not stop its neighbour", () => {
    policyFor(BIZ, { autonomy: { allow_autonomous_execution: false } });

    expect(() => approveTask(propose(BIZ).id, 'bap:agent')).toThrow();
    expect(approveTask(propose(OTHER).id, 'bap:agent')!.status).toBe('approved');
  });

  test("one business's daily cap does not consume its neighbour's headroom", () => {
    policyFor(BIZ, { autonomy: { max_autonomous_tasks_per_day: 1 } });
    policyFor(OTHER, { autonomy: { max_autonomous_tasks_per_day: 1 } });

    approveTask(propose(BIZ).id, 'bap:agent');
    expect(() => approveTask(propose(BIZ).id, 'bap:agent')).toThrow(/1\/day/);
    // OTHER still has its own full allowance.
    expect(approveTask(propose(OTHER).id, 'bap:agent')!.status).toBe('approved');
  });

  test('decisions in each business cite their own policy version, not the neighbour\'s', () => {
    policyFor(BIZ, { notes: 'a1' });
    policyFor(BIZ, { notes: 'a2' });
    policyFor(OTHER, { notes: 'b1' });

    approveTask(propose(BIZ).id, 'dashboard:alice');
    approveTask(propose(OTHER).id, 'dashboard:alice');

    expect(decisionsFor(BIZ).find((d) => d.decision_type === 'task_approval')!.effective_policy_version).toBe(2);
    expect(decisionsFor(OTHER).find((d) => d.decision_type === 'task_approval')!.effective_policy_version).toBe(1);
  });
});
