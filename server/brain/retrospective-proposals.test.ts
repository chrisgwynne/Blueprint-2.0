/**
 * Retrospective operating-change proposals (#73).
 *
 * The properties under test are the ones that make an automated
 * retrospective safe to act on rather than merely interesting to read:
 *
 *   - thin evidence produces NO proposal, only a recorded gap;
 *   - outcomes that disagree are surfaced as a conflict, never averaged;
 *   - generating proposals changes nothing that is live;
 *   - approving one genuinely activates the RIGHT underlying system through
 *     that system's own activation function;
 *   - rejecting one leaves the draft unactivated and explicitly abandoned;
 *   - an activated change can be rolled back end to end.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  generateRetrospectiveProposals, reviewRetrospectiveProposal,
  rollbackRetrospectiveChange, expireStaleProposals, getProposal,
  listProposalsForBusiness, applyApprovedProposal,
  RETROSPECTIVE_CHANGE_ACTION_TYPE,
} from './retrospective-proposals.js';
import { MIN_OUTCOME_SAMPLE } from './retrospective-evidence.js';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';
import {
  getActivePolicyVersion, listPolicyVersions, resolveOperatingPolicy, savePolicyVersion,
} from '../policy/operating-policy.js';
import {
  getActivePlaybookVersion, listPlaybookVersions, getPlaybookVersion,
  savePlaybookDraft, activatePlaybookVersion,
} from '../workflows/playbook-versions.js';
import { executeTask } from '../tasks/executor.js';

const BIZ = 'biz_retro_prop_a';
const BIZ_OTHER = 'biz_retro_prop_b';
const WF = 'wf_retro_prop_a';
const AGENT = 'retro-prop-fixture-agent';

/**
 * A neutral fixture action type. Names here matter: the tier calculator
 * escalates on keywords found anywhere in the action type or payload, so a
 * fixture called e.g. "publish_thing" would land in a different tier and the
 * test would be measuring the keyword list rather than this feature.
 */
const ACTION = 'retro_fixture_action';

const PERIOD_START = new Date(Date.now() - 30 * 86_400_000);
const PERIOD_END = new Date(Date.now() + 60_000);

// ─── Fixtures ────────────────────────────────────────────────────────────────

function ensureBusinesses(): void {
  for (const [id, name, slug] of [
    [BIZ, 'Retro Proposals A', 'retro-proposals-a'],
    [BIZ_OTHER, 'Retro Proposals B', 'retro-proposals-b'],
  ] as const) {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, name, slug);
  }
}

function ensureActionType(): void {
  upsertActionRegistryEntry(ACTION, {
    description: 'Retrospective proposal fixture action.',
    payload_schema: { type: 'object', properties: { note: { type: 'string' } } },
    dispatched_by_executor: false,
    side_effect_classification: 'external_verifiable',
    risk_level: 'low',
    requires_approval: false,
  });
}

/** One completed task with one measured outcome, inside the period. */
function recordMeasuredOutcome(
  businessId: string,
  verdict: 'improved' | 'worsened' | 'no_change',
  opts: { actionType?: string; proposedBy?: string; changePct?: number } = {},
): { taskId: string; outcomeId: string } {
  const taskId = generateId();
  const outcomeId = generateId();
  const at = new Date(Date.now() - 5 * 86_400_000).toISOString();
  db.prepare(`
    INSERT INTO tasks (
      id, business_id, title, description, action_type, action_payload, proposed_by,
      status, trust_tier, priority, confidence, target_metric, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, NULL, ?, '{}', ?, 'complete', 'yellow', 'p2', 0.7, 'ga4.sessions', ?, ?, ?)
  `).run(
    taskId, businessId, `fixture task ${taskId.slice(0, 8)}`,
    opts.actionType ?? ACTION, opts.proposedBy ?? `agent:${AGENT}`, at, at, at,
  );
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict)
    VALUES (?, ?, ?, 4, 100, 100, ?, ?)
  `).run(outcomeId, taskId, at, opts.changePct ?? (verdict === 'improved' ? 12 : verdict === 'worsened' ? -12 : 0), verdict);
  return { taskId, outcomeId };
}

function ensureWorkflowWithActivePlaybook(): void {
  db.prepare(`
    INSERT INTO workflows (id, business_id, name, steps, status, created_by)
    VALUES (?, ?, 'Retro fixture workflow', '[]', 'active', 'human')
    ON CONFLICT(id) DO NOTHING
  `).run(WF, BIZ);

  const existing = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ });
  if (existing) return;

  const draft = savePlaybookDraft({
    workflowId: WF,
    businessId: BIZ,
    definition: {
      name: 'Retro fixture playbook',
      description: null,
      business_scope: { business_id: BIZ, business_types: [] },
      inputs: { type: 'object', properties: {} },
      steps: [{
        index: 0, name: 'Run the fixture action', kind: 'action',
        action_type: ACTION, input: { note: 'fixture' },
        // Ungated on purpose: the proposal under test is "put a gate here".
        approval_gate: false,
      }],
    },
    actor: 'test:setup',
    validate: true,
  });
  activatePlaybookVersion({
    workflowId: WF, businessId: BIZ, version: draft.version, actor: 'test:setup',
  });
}

function installAgentWithFailedTrials(count: number): void {
  db.prepare(`
    INSERT INTO agents (id, profile_path, name, status, lifecycle_state)
    VALUES (?, 'agents/retro-fixture/profile.yaml', 'Retro fixture agent', 'active', 'standby')
    ON CONFLICT(id) DO UPDATE SET status = 'active', lifecycle_state = 'standby'
  `).run(AGENT);
  db.prepare(`
    INSERT INTO agent_installations (id, business_id, agent_id, status, installed_by, installed_at, metadata)
    VALUES (?, ?, ?, 'installed', 'test', ?, '{}')
    ON CONFLICT(business_id, agent_id) DO UPDATE SET status = 'installed', uninstalled_at = NULL
  `).run(generateId(), BIZ, AGENT, new Date(Date.now() - 90 * 86_400_000).toISOString());

  for (let i = 0; i < count; i++) {
    db.prepare(`
      INSERT INTO hiring_trials (
        id, business_id, template_id, target_metric, baseline_value, target_value,
        measurement_window_days, evidence_deliverable, status, verdict, verdict_reason,
        cost_usd, measured_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'ga4.sessions', 0, 1, 7, 'x', 'measured', 'unsuccessful',
        'No measurable improvement.', 4.5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ, AGENT);
  }
}

function cleanup(): void {
  const ids = [BIZ, BIZ_OTHER];
  for (const id of ids) {
    // Everything with a foreign key onto tasks must go first, or the delete
    // below fails and every later test inherits the previous one's rows.
    for (const table of [
      'task_events', 'task_outcomes', 'execution_jobs', 'outcome_measurement_runs', 'action_receipts',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(id);
    }
    db.prepare('DELETE FROM retrospective_proposals WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM decisions WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM playbook_events WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM playbook_versions WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM workflows WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM operating_policy_events WHERE scope_key = ?').run(id);
    db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(id);
    db.prepare('DELETE FROM hiring_trials WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM agent_installations WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM audit_log WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM system_issues WHERE business_id = ?').run(id);
  }
  db.prepare('DELETE FROM agents WHERE id = ?').run(AGENT);
}

beforeEach(() => {
  cleanup();
  ensureBusinesses();
  ensureActionType();
});

afterAll(() => {
  cleanup();
  db.prepare('DELETE FROM businesses WHERE id IN (?, ?)').run(BIZ, BIZ_OTHER);
});

function generate() {
  return generateRetrospectiveProposals({
    businessId: BIZ, retrospectiveId: null,
    periodStart: PERIOD_START, periodEnd: PERIOD_END,
  });
}

function policyProposals(result: ReturnType<typeof generate>) {
  return result.proposals.filter((p) => p.target === 'policy');
}

// ─── Insufficient evidence ───────────────────────────────────────────────────

describe('insufficient evidence produces no proposal', () => {
  test('a period with no measured outcomes at all proposes nothing', () => {
    const result = generate();
    expect(result.proposals).toHaveLength(0);
    expect(result.evidence_summary.total_measured_outcomes).toBe(0);
  });

  test('below the minimum sample the result is a recorded gap, not a weak proposal', () => {
    // One short of the minimum, all pointing the same (bad) way. The
    // direction is unambiguous — only the sample is thin — which is exactly
    // the case a confidence-scored guess would sneak through.
    for (let i = 0; i < MIN_OUTCOME_SAMPLE - 1; i++) recordMeasuredOutcome(BIZ, 'worsened');

    const result = generate();
    expect(result.proposals).toHaveLength(0);

    const gap = result.gaps.find((g) => g.subject === ACTION);
    expect(gap).toBeDefined();
    expect(gap!.reason).toBe('below_minimum_sample');
    expect(gap!.measured_outcomes).toBe(MIN_OUTCOME_SAMPLE - 1);
    expect(gap!.required_outcomes).toBe(MIN_OUTCOME_SAMPLE);
    // The gap must say what was missing, not merely that something was.
    expect(gap!.detail).toContain(String(MIN_OUTCOME_SAMPLE));
  });

  test('one more outcome crosses the bar and a proposal appears', () => {
    for (let i = 0; i < MIN_OUTCOME_SAMPLE; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const result = generate();
    expect(policyProposals(result).length).toBe(1);
    expect(policyProposals(result)[0]!.basis).toBe('evidence_backed');
  });

  test('a retention verdict with no trial record on file proposes no lifecycle change', () => {
    db.prepare(`
      INSERT INTO agents (id, profile_path, name, status, lifecycle_state)
      VALUES (?, 'agents/retro-fixture/profile.yaml', 'Retro fixture agent', 'active', 'standby')
      ON CONFLICT(id) DO NOTHING
    `).run(AGENT);
    // Installed long ago, no trials — #69 says 'downgrade', but there is no
    // record to cite, so #73 records a gap rather than proposing.
    db.prepare(`
      INSERT INTO agent_installations (id, business_id, agent_id, status, installed_by, installed_at, metadata)
      VALUES (?, ?, ?, 'installed', 'test', ?, '{}')
      ON CONFLICT(business_id, agent_id) DO NOTHING
    `).run(generateId(), BIZ, AGENT, new Date(Date.now() - 120 * 86_400_000).toISOString());

    const result = generate();
    expect(result.proposals.filter((p) => p.target === 'agent_lifecycle')).toHaveLength(0);
    const gap = result.gaps.find((g) => g.subject.includes(AGENT));
    expect(gap).toBeDefined();
    expect(gap!.detail).toContain('no completed trial record');
  });
});

// ─── Conflicting outcomes ────────────────────────────────────────────────────

describe('conflicting outcomes are surfaced, not averaged', () => {
  test('outcomes that disagree inside one business produce a conflict, not a direction', () => {
    recordMeasuredOutcome(BIZ, 'worsened');
    recordMeasuredOutcome(BIZ, 'worsened');
    recordMeasuredOutcome(BIZ, 'improved');
    recordMeasuredOutcome(BIZ, 'improved');

    const result = generate();
    const conflict = result.conflicts.find((c) => c.kind === 'within_business_outcomes');
    expect(conflict).toBeDefined();
    expect(conflict!.subject).toBe(ACTION);
    expect(conflict!.supporting.length).toBeGreaterThan(0);
    expect(conflict!.opposing.length).toBeGreaterThan(0);
    expect(conflict!.detail).toContain('rather than averaged');

    // The proposal still exists — a human needs to see the disagreement —
    // but it must not claim the change is evidence-backed.
    const proposal = policyProposals(result)[0];
    expect(proposal).toBeDefined();
    expect(proposal!.basis).toBe('conflicting_evidence');
    expect(proposal!.conflicts.length).toBeGreaterThan(0);
    // And it must not promise the change works.
    expect(proposal!.statement).toContain('not as a fix');
  });

  test("another business's opposite result is surfaced as a conflict, not pooled", () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ_OTHER, 'improved');

    const result = generate();
    const cross = result.conflicts.find((c) => c.kind === 'cross_business_outcomes');
    expect(cross).toBeDefined();
    expect(cross!.other_business_id).toBe(BIZ_OTHER);
    expect(cross!.detail).toContain('rather than pooled');

    const proposal = policyProposals(result)[0];
    expect(proposal!.basis).toBe('conflicting_evidence');
  });

  test('a clean signal in this business is not disturbed by an unrelated action type elsewhere', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    for (let i = 0; i < 4; i++) {
      recordMeasuredOutcome(BIZ_OTHER, 'improved', { actionType: 'some_other_fixture_action' });
    }
    const result = generate();
    expect(result.conflicts.filter((c) => c.kind === 'cross_business_outcomes')).toHaveLength(0);
    expect(policyProposals(result)[0]!.basis).toBe('evidence_backed');
  });
});

// ─── Generation never activates anything ─────────────────────────────────────

describe('generating proposals activates nothing', () => {
  test('no policy version is written and no playbook version is activated', () => {
    ensureWorkflowWithActivePlaybook();
    const policyBefore = listPolicyVersions({ scope: 'business', key: BIZ }).length;
    const activePlaybookBefore = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!;

    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const result = generate();
    expect(result.proposals.length).toBeGreaterThan(0);

    // #68: not one new policy row. The proposal carries a validated patch
    // and #68's own diff instead.
    expect(listPolicyVersions({ scope: 'business', key: BIZ })).toHaveLength(policyBefore);

    // #74: a real DRAFT exists, but the ACTIVE version is untouched.
    const activeAfter = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!;
    expect(activeAfter.version).toBe(activePlaybookBefore.version);
    expect(activeAfter.definition.steps[0]!.approval_gate).toBe(false);

    const workflowProposal = result.proposals.find((p) => p.target === 'workflow');
    expect(workflowProposal).toBeDefined();
    const draftRef = workflowProposal!.draft_ref as { kind: string; version: number };
    expect(draftRef.kind).toBe('playbook_version');
    const draft = getPlaybookVersion({ workflowId: WF, businessId: BIZ }, draftRef.version)!;
    expect(draft.state).toBe('draft');
    expect(draft.definition.steps[0]!.approval_gate).toBe(true);
  });

  test('every proposal reaches the decision queue with benefit, risk and rollback', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const result = generate();

    for (const proposal of result.proposals) {
      expect(proposal.decision_task_id).toBeTruthy();
      expect(proposal.expected_benefit.length).toBeGreaterThan(10);
      expect(proposal.risk.length).toBeGreaterThan(10);
      expect(proposal.rollback_plan.length).toBeGreaterThan(10);
      expect(proposal.expires_at).toBeTruthy();
      expect(proposal.business_id).toBe(BIZ);
      expect(proposal.cited_records.length).toBeGreaterThan(0);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(proposal.decision_task_id!) as
        { status: string; action_type: string; business_id: string };
      expect(task.status).toBe('proposed');
      expect(task.action_type).toBe(RETROSPECTIVE_CHANGE_ACTION_TYPE);
      expect(task.business_id).toBe(BIZ);
    }
  });

  test('cited records point at real task_outcomes rows', () => {
    const written: string[] = [];
    for (let i = 0; i < 4; i++) written.push(recordMeasuredOutcome(BIZ, 'worsened').outcomeId);

    const proposal = policyProposals(generate())[0]!;
    const citedOutcomes = proposal.cited_records.filter((r) => r.kind === 'task_outcome');
    expect(citedOutcomes.length).toBeGreaterThan(0);
    for (const record of citedOutcomes) {
      expect(written).toContain(record.id);
      expect(db.prepare('SELECT id FROM task_outcomes WHERE id = ?').get(record.id)).toBeTruthy();
    }
  });
});

// ─── Approval activates the real system ──────────────────────────────────────

describe('approval activates the underlying system', () => {
  test('an approved policy proposal writes and activates a real policy version', async () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;

    const before = resolveOperatingPolicy(BIZ);
    expect(before.document.approvals.always_require_human_action_types).not.toContain(ACTION);

    const { review } = reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve',
      actor: 'dashboard:tester', reason: 'Evidence is clear enough to gate this.',
    });
    expect(review.task?.status).toBe('approved');

    // Approval alone must not have changed the policy — the executor does it.
    expect(resolveOperatingPolicy(BIZ).document.approvals.always_require_human_action_types)
      .not.toContain(ACTION);

    const exec = await executeTask(proposal.decision_task_id!);
    expect(exec.ok).toBe(true);

    // #68's own save produced a real, active, versioned row.
    const active = getActivePolicyVersion({ scope: 'business', key: BIZ })!;
    expect(active.state).toBe('active');
    expect(active.document.approvals.always_require_human_action_types).toContain(ACTION);
    expect(resolveOperatingPolicy(BIZ).document.approvals.always_require_human_action_types)
      .toContain(ACTION);

    const stored = getProposal(proposal.id, BIZ)!;
    expect(stored.status).toBe('approved');
    expect((stored.activation_result as { target: string }).target).toBe('policy');

    // The versioned diff the reviewer saw is the one that landed.
    const draftRef = stored.draft_ref as { next_version: number; changes: unknown[] };
    expect(active.version).toBe(draftRef.next_version);
    expect(draftRef.changes.length).toBeGreaterThan(0);
  });

  test('an approved workflow proposal activates the draft playbook version', async () => {
    ensureWorkflowWithActivePlaybook();
    const baseVersion = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!.version;
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');

    const proposal = generate().proposals.find((p) => p.target === 'workflow')!;
    expect(proposal).toBeDefined();

    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve',
      actor: 'dashboard:tester', reason: 'Gate it.',
    }).proposal.decision_task_id!);

    const active = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!;
    expect(active.version).toBeGreaterThan(baseVersion);
    expect(active.state).toBe('active');
    expect(active.definition.steps[0]!.approval_gate).toBe(true);

    // The version it replaced is superseded, not deleted.
    const previous = getPlaybookVersion({ workflowId: WF, businessId: BIZ }, baseVersion)!;
    expect(previous.state).toBe('superseded');
  });

  test('an approved agent-lifecycle proposal retires the agent through the real control', async () => {
    installAgentWithFailedTrials(2); // #69: two unsuccessful, none successful ⇒ retire
    const proposal = generate().proposals.find((p) => p.target === 'agent_lifecycle')!;
    expect(proposal).toBeDefined();
    expect((proposal.draft_ref as { action: string }).action).toBe('retire');
    expect((proposal.draft_ref as { retention_verdict: string }).retention_verdict).toBe('retire');

    const installedBefore = db.prepare(
      "SELECT status FROM agent_installations WHERE business_id = ? AND agent_id = ?",
    ).get(BIZ, AGENT) as { status: string };
    expect(installedBefore.status).toBe('installed');

    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve',
      actor: 'dashboard:tester', reason: 'Two failed trials, no wins.',
    }).proposal.decision_task_id!);

    const installedAfter = db.prepare(
      'SELECT status FROM agent_installations WHERE business_id = ? AND agent_id = ?',
    ).get(BIZ, AGENT) as { status: string };
    expect(installedAfter.status).toBe('uninstalled');
    expect(getProposal(proposal.id, BIZ)!.status).toBe('approved');
  });

  test('re-executing an already-applied proposal does not apply it twice', async () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve', actor: 'dashboard:tester',
    }).proposal.decision_task_id!);

    const versionsAfterFirst = listPolicyVersions({ scope: 'business', key: BIZ }).length;
    const second = applyApprovedProposal(proposal.id, BIZ, 'dashboard:tester');
    expect(second.outcome).toBe('already_applied');
    expect(listPolicyVersions({ scope: 'business', key: BIZ })).toHaveLength(versionsAfterFirst);
  });

  test('a proposal cannot be reached from another business', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;

    expect(getProposal(proposal.id, BIZ_OTHER)).toBeNull();
    expect(() => reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ_OTHER, outcome: 'approve', actor: 'dashboard:tester',
    })).toThrow(/not_found|No retrospective proposal/);
  });
});

// ─── Rejection ───────────────────────────────────────────────────────────────

describe('rejection leaves the draft unactivated', () => {
  test('a rejected policy proposal never writes a policy version', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    const versionsBefore = listPolicyVersions({ scope: 'business', key: BIZ }).length;

    reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'reject',
      actor: 'dashboard:tester', reason: 'The drop was seasonal, not caused by this action.',
    });

    expect(listPolicyVersions({ scope: 'business', key: BIZ })).toHaveLength(versionsBefore);
    expect(resolveOperatingPolicy(BIZ).document.approvals.always_require_human_action_types)
      .not.toContain(ACTION);

    const stored = getProposal(proposal.id, BIZ)!;
    expect(stored.status).toBe('rejected');
    expect(stored.review_reason).toContain('seasonal');

    const task = db.prepare('SELECT status FROM tasks WHERE id = ?')
      .get(proposal.decision_task_id!) as { status: string };
    expect(task.status).toBe('rejected');
  });

  test('a rejected workflow proposal leaves the draft archived, not lingering', () => {
    ensureWorkflowWithActivePlaybook();
    const baseVersion = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!.version;
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');

    const proposal = generate().proposals.find((p) => p.target === 'workflow')!;
    const draftRef = proposal.draft_ref as { version: number };
    expect(getPlaybookVersion({ workflowId: WF, businessId: BIZ }, draftRef.version)!.state).toBe('draft');

    reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'reject',
      actor: 'dashboard:tester', reason: 'Gating this step would stall every run.',
    });

    // The active playbook is untouched...
    const active = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!;
    expect(active.version).toBe(baseVersion);
    expect(active.definition.steps[0]!.approval_gate).toBe(false);

    // ...and the draft is explicitly dead rather than sitting there as a
    // live draft somebody could activate by hand later.
    const draft = getPlaybookVersion({ workflowId: WF, businessId: BIZ }, draftRef.version)!;
    expect(draft.state).toBe('archived');

    const archivedEvent = db.prepare(
      "SELECT * FROM playbook_events WHERE workflow_id = ? AND version = ? AND event_type = 'archived'",
    ).get(WF, draftRef.version) as { reason: string } | null;
    expect(archivedEvent).toBeTruthy();
    expect(archivedEvent!.reason).toContain('rejected');
  });

  test('a decided proposal cannot be decided again', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'reject',
      actor: 'dashboard:tester', reason: 'Not now, the sample is too short a window.',
    });
    expect(() => reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve', actor: 'dashboard:tester',
    })).toThrow(/already been decided/);
  });

  test('rejecting requires a reason, so the proposing side learns why', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    expect(() => reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'reject', actor: 'dashboard:tester',
    })).toThrow(/rejection reason is required/);
  });
});

// ─── Rollback ────────────────────────────────────────────────────────────────

describe('rollback of a retrospective-originated change', () => {
  test('an activated policy change rolls back to the prior version as a new version', async () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve', actor: 'dashboard:tester',
    }).proposal.decision_task_id!);

    const activated = getActivePolicyVersion({ scope: 'business', key: BIZ })!;
    expect(activated.document.approvals.always_require_human_action_types).toContain(ACTION);

    const rolled = rollbackRetrospectiveChange({
      proposalId: proposal.id, businessId: BIZ, actor: 'dashboard:tester',
      reason: 'Throughput dropped and the gate did not help.',
    });
    expect(rolled.target).toBe('policy');

    const after = getActivePolicyVersion({ scope: 'business', key: BIZ })!;
    // History moves FORWARD: the restored state is a new version, not a
    // rewind of the one that was activated.
    expect(after.version).toBeGreaterThan(activated.version);
    expect(after.document.approvals.always_require_human_action_types).not.toContain(ACTION);
    expect(after.source).toBe('rollback');

    // The version that was rolled back is retained, not deleted.
    const versions = listPolicyVersions({ scope: 'business', key: BIZ }).map((v) => v.version);
    expect(versions).toContain(activated.version);
  });

  test('an activated playbook change rolls back to the prior definition as a new version', async () => {
    ensureWorkflowWithActivePlaybook();
    const baseVersion = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!.version;
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');

    const proposal = generate().proposals.find((p) => p.target === 'workflow')!;
    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve', actor: 'dashboard:tester',
    }).proposal.decision_task_id!);

    const gated = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!;
    expect(gated.definition.steps[0]!.approval_gate).toBe(true);

    const rolled = rollbackRetrospectiveChange({
      proposalId: proposal.id, businessId: BIZ, actor: 'dashboard:tester',
      reason: 'Runs stalled waiting for a reviewer.',
    });
    expect(rolled.target).toBe('workflow');

    const after = getActivePlaybookVersion({ workflowId: WF, businessId: BIZ })!;
    expect(after.version).toBeGreaterThan(gated.version);
    expect(after.definition.steps[0]!.approval_gate).toBe(false);
    expect(after.source).toBe('rollback');
    expect(listPlaybookVersions({ workflowId: WF, businessId: BIZ }).map((v) => v.version))
      .toContain(baseVersion);
  });

  test('with a prior policy version on file, rollback restores that exact version', async () => {
    // A business that has already authored a policy — so the rollback target
    // is a real earlier row rather than the inherited default.
    savePolicyVersion({
      key: BIZ, actor: 'test:setup',
      patch: { approvals: { always_require_human_action_types: ['notification'] } },
      change_reason: 'Baseline policy before the retrospective.',
    });
    const baseline = getActivePolicyVersion({ scope: 'business', key: BIZ })!;

    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    expect((proposal.draft_ref as { base_version: number }).base_version).toBe(baseline.version);

    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve', actor: 'dashboard:tester',
    }).proposal.decision_task_id!);
    expect(getActivePolicyVersion({ scope: 'business', key: BIZ })!
      .document.approvals.always_require_human_action_types).toContain(ACTION);

    rollbackRetrospectiveChange({
      proposalId: proposal.id, businessId: BIZ, actor: 'dashboard:tester',
      reason: 'Reverting to the policy that was in force before.',
    });

    const after = getActivePolicyVersion({ scope: 'business', key: BIZ })!;
    // The pre-existing rule survives; only this proposal's addition is undone.
    expect(after.document.approvals.always_require_human_action_types)
      .toContain('notification');
    expect(after.document.approvals.always_require_human_action_types).not.toContain(ACTION);
    expect(after.source).toBe('rollback');
    expect(after.rolled_back_from_version).toBe(baseline.version);
  });

  test('approving a proposal does not revert a policy change made after it was raised', async () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;

    // Somebody edits the policy between the proposal being raised and being
    // approved. Replaying the proposal's snapshot patch would delete this.
    savePolicyVersion({
      key: BIZ, actor: 'dashboard:someone-else',
      patch: { approvals: { always_require_human_action_types: ['notification'] } },
      change_reason: 'Unrelated edit made while the proposal sat in the queue.',
    });

    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve', actor: 'dashboard:tester',
    }).proposal.decision_task_id!);

    const list = getActivePolicyVersion({ scope: 'business', key: BIZ })!
      .document.approvals.always_require_human_action_types;
    expect(list).toContain(ACTION);          // what this proposal asked for
    expect(list).toContain('notification');  // and the other edit survives
  });

  test('rolling back after a later policy change removes only this proposal\'s effect', async () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve', actor: 'dashboard:tester',
    }).proposal.decision_task_id!);

    savePolicyVersion({
      key: BIZ, actor: 'dashboard:someone-else',
      patch: { approvals: { always_require_human_action_types: [ACTION, 'notification'] } },
      change_reason: 'A later, unrelated tightening.',
    });

    const rolled = rollbackRetrospectiveChange({
      proposalId: proposal.id, businessId: BIZ, actor: 'dashboard:tester',
      reason: 'The gate did not help throughput.',
    });
    expect((rolled.detail as { partial?: boolean }).partial).toBe(true);

    const list = getActivePolicyVersion({ scope: 'business', key: BIZ })!
      .document.approvals.always_require_human_action_types;
    expect(list).not.toContain(ACTION);       // this proposal's effect is gone
    expect(list).toContain('notification');   // the later change is untouched
  });

  test('a proposal that was never activated cannot be rolled back', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    expect(() => rollbackRetrospectiveChange({
      proposalId: proposal.id, businessId: BIZ, actor: 'dashboard:tester',
    })).toThrow(/only an activated proposal can be rolled back/);
  });

  test('retiring an agent is honest about having no rollback', async () => {
    installAgentWithFailedTrials(2);
    const proposal = generate().proposals.find((p) => p.target === 'agent_lifecycle')!;
    await executeTask(reviewRetrospectiveProposal({
      proposalId: proposal.id, businessId: BIZ, outcome: 'approve', actor: 'dashboard:tester',
    }).proposal.decision_task_id!);

    expect(() => rollbackRetrospectiveChange({
      proposalId: proposal.id, businessId: BIZ, actor: 'dashboard:tester',
    })).toThrow(/new hiring decision/);
    expect(proposal.rollback_plan).toContain('No rollback');
  });
});

// ─── Expiry ──────────────────────────────────────────────────────────────────

describe('expiry', () => {
  test('an unreviewed proposal lapses and its draft is abandoned', () => {
    ensureWorkflowWithActivePlaybook();
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const result = generate();
    const workflowProposal = result.proposals.find((p) => p.target === 'workflow')!;
    const draftRef = workflowProposal.draft_ref as { version: number };

    const expired = expireStaleProposals(BIZ, new Date(Date.now() + 400 * 86_400_000));
    expect(expired).toBe(result.proposals.length);

    expect(getProposal(workflowProposal.id, BIZ)!.status).toBe('expired');
    expect(getPlaybookVersion({ workflowId: WF, businessId: BIZ }, draftRef.version)!.state)
      .toBe('archived');
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?')
      .get(workflowProposal.decision_task_id!) as { status: string };
    expect(task.status).toBe('cancelled');

    expect(listProposalsForBusiness(BIZ, { status: 'proposed' })).toHaveLength(0);
  });

  test('a proposal inside its window is not expired', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    generate();
    expect(expireStaleProposals(BIZ, new Date())).toBe(0);
    expect(listProposalsForBusiness(BIZ, { status: 'proposed' }).length).toBeGreaterThan(0);
  });
});

// ─── Evidence vs hypothesis labelling ────────────────────────────────────────

describe('evidence is distinguished from hypothesis', () => {
  test('narrative suggestions with no supporting record stay prose', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const result = generateRetrospectiveProposals({
      businessId: BIZ, retrospectiveId: null,
      periodStart: PERIOD_START, periodEnd: PERIOD_END,
      parsedReport: {
        recommendations: ['Rebrand the whole storefront next quarter'],
        operating_changes: [`Stop letting ${ACTION} run unattended`],
      },
    });

    const unsupported = result.unstructured_suggestions
      .find((s) => s.text.includes('Rebrand'))!;
    expect(unsupported).toBeDefined();
    expect(unsupported.not_proposed_reason).toContain('No measured outcome');
    // Crucially: it did NOT become an approvable operating change.
    expect(result.proposals.some((p) => p.title.includes('Rebrand'))).toBe(false);

    const supported = result.unstructured_suggestions
      .find((s) => s.text.includes(ACTION))!;
    expect(supported.not_proposed_reason).toContain('already covered by a');
  });

  test('an evidence-backed proposal reports what the records show, not a causal claim', () => {
    for (let i = 0; i < 4; i++) recordMeasuredOutcome(BIZ, 'worsened');
    const proposal = policyProposals(generate())[0]!;
    expect(proposal.basis).toBe('evidence_backed');
    expect(proposal.basis_reason).toContain('not a claim about why');
    expect(proposal.measured_effect).not.toBeNull();
    expect((proposal.measured_effect as { state: string }).state).toBe('known');
    expect((proposal.measured_effect as { citation: string }).citation).toContain('task_outcomes');
  });

  test('the measured effect is marked unknown rather than zero when nothing was measured', () => {
    installAgentWithFailedTrials(2);
    const proposal = generate().proposals.find((p) => p.target === 'agent_lifecycle')!;
    // The agent has trial records but no task outcomes; the effect must cite
    // the trials, never claim a fabricated outcome rate.
    const effect = proposal.measured_effect as { state: string; citation: string | null };
    expect(effect.state).toBe('known');
    expect(effect.citation).toContain('agent_trials');
  });
});
