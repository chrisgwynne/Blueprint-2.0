/**
 * Hiring decision memory.
 *
 * Issue #44 — rejecting a hire proposal must write a durable, business-scoped
 *             suppression record ATOMICALLY with the task rejection. Before
 *             this, rejectTask() only changed task.status, and the engine's
 *             dedup only looked at tasks still in 'proposed'/'approved' — so
 *             a rejected role became invisible and was re-proposed forever.
 * Issue #50 — the engine must CONSUME that memory when building candidates
 *             and when prompting the reasoner, distinguishing hard
 *             suppression, temporary deferral and changed circumstances, and
 *             requiring materially new evidence to override a rejection.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import db from '../../db/db.js';
import {
  assertHiringTestIsolation, cleanupTestBusinesses, createMockConnector,
  createTestBusiness, createTestGoal, createTestSignal,
} from './test-harness.js';
import { analyseAndProposeHires, __setHiringDeps, __resetHiringDeps } from '../conductor-hiring.js';
import { setHiringPolicy } from './policy.js';
import { getHiringDecisions, getTrials } from './store.js';
import { evaluateSuppression } from './gates.js';
import { rejectTask, approveTask } from '../../tasks/task-queue.js';
import type { HiringDecisionRecord } from './types.js';
import type { ReasoningOutcome, ReasoningInput } from './reasoning.js';

assertHiringTestIsolation();

const BIZ_A = createTestBusiness('dec_a');
const BIZ_B = createTestBusiness('dec_b');

const TEMPLATES = [
  { id: 'seo-sentinel', profile: { name: 'SEO Sentinel', required_connectors: ['gsc'], preferred_connectors: [] } },
];

let lastReasoningInput: ReasoningInput | null = null;

function okReason(ids: string[]) {
  return async (input: ReasoningInput): Promise<ReasoningOutcome> => {
    lastReasoningInput = input;
    return {
      status: 'ok',
      recommendations: ids.map((id) => ({
        agent_id: id, reason: 'stub', confidence: 0.9,
        priority: 'suggested' as const, provenance: 'llm' as const, degraded: false,
      })),
      provider: 'stub', model: 'm', attempts: 1, provider_status: 'ok',
      provider_http_status: null, provider_retryable: null, error: null,
      cost_usd: 0, usage: null, raw_unparseable: false,
    };
  };
}

function seed(biz: string): string {
  const conn = createMockConnector(biz, 'gsc', { lastSyncHoursAgo: 1 });
  createTestGoal(biz, { title: 'Grow search clicks', metricName: 'gsc.clicks', baseline: 100, target: 200 });
  return conn;
}

function reset(): void {
  cleanupTestBusinesses(BIZ_A, BIZ_B);
  createTestBusiness('dec_a');
  createTestBusiness('dec_b');
  db.prepare("DELETE FROM settings WHERE key = 'hiring_policy'").run();
  setHiringPolicy({ cooldown_minutes: 0, material_change_required: false });
  lastReasoningInput = null;
  __setHiringDeps({
    loadTemplates: () => TEMPLATES as never,
    reason: okReason(['seo-sentinel']) as never,
    notify: async () => {},
  });
}

beforeEach(reset);
afterAll(() => { __resetHiringDeps(); cleanupTestBusinesses(BIZ_A, BIZ_B); });

describe('#44 rejection persists a durable suppression record', () => {
  test('rejecting a hire proposal writes a business-scoped hiring_decisions row', async () => {
    seed(BIZ_A);
    const result = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const taskId = result.proposal_ids[0]!;
    expect(taskId).toBeTruthy();

    rejectTask(taskId, 'operator@example.com', 'We already outsource SEO.');

    const decisions = getHiringDecisions(BIZ_A);
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.template_id).toBe('seo-sentinel');
    expect(d.business_id).toBe(BIZ_A);
    expect(d.decision).toBe('rejected');
    expect(d.actor).toBe('operator@example.com');
    expect(d.reason).toBe('We already outsource SEO.');
    expect(d.task_id).toBe(taskId);
    expect(d.decided_at).toBeTruthy();
    // The evidence the proposal was built from is captured so "new evidence"
    // is a decidable question later.
    expect(d.evidence_fingerprint).toBeTruthy();
    expect(d.reconsider_policy).toBe('new_evidence');
    expect(getHiringDecisions(BIZ_B)).toHaveLength(0);
  });

  test('the suppression record and the status change are one atomic unit', async () => {
    seed(BIZ_A);
    const result = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const taskId = result.proposal_ids[0]!;

    // A second rejection of an already-rejected task must fail AND must not
    // leave a second, orphaned decision behind.
    rejectTask(taskId, 'operator', 'no thanks');
    expect(() => rejectTask(taskId, 'operator', 'again')).toThrow();
    expect(getHiringDecisions(BIZ_A)).toHaveLength(1);
  });

  test('rejecting abandons the trial planned for that hire', async () => {
    seed(BIZ_A);
    const result = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const taskId = result.proposal_ids[0]!;
    expect(getTrials(BIZ_A, 'seo-sentinel')[0]!.status).toBe('planned');

    rejectTask(taskId, 'operator', 'not now');
    const trial = getTrials(BIZ_A, 'seo-sentinel')[0]!;
    expect(trial.status).toBe('abandoned');
    expect(trial.verdict).toBe('insufficient_data');
  });

  test('approving records the positive decision and activates the trial', async () => {
    seed(BIZ_A);
    const result = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const taskId = result.proposal_ids[0]!;

    approveTask(taskId, 'dashboard:operator');
    const decisions = getHiringDecisions(BIZ_A);
    expect(decisions[0]!.decision).toBe('approved');
    expect(getTrials(BIZ_A, 'seo-sentinel')[0]!.status).toBe('active');
  });

  test('an explicit hard suppression with never-reconsider is recorded as such', async () => {
    seed(BIZ_A);
    const result = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    rejectTask(result.proposal_ids[0]!, 'operator', 'never', {
      disposition: 'hard_suppression', reconsiderPolicy: 'never',
    });
    const d = getHiringDecisions(BIZ_A)[0]!;
    expect(d.disposition).toBe('hard_suppression');
    expect(d.reconsider_policy).toBe('never');
  });
});

describe('#50 the engine consumes decision memory', () => {
  test('a rejected role is not re-proposed when the evidence is unchanged', async () => {
    seed(BIZ_A);
    const first = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    rejectTask(first.proposal_ids[0]!, 'operator', 'not now');

    lastReasoningInput = null;
    const second = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(second.proposed_hires).toBe(0);
    expect(second.suppressed).toContain('seo-sentinel');
    expect(second.terminal_reason).toBe('all_suppressed');
    // A suppressed candidate never reaches the reasoner at all — the whole
    // analysis short-circuits before any provider call is made.
    expect(lastReasoningInput).toBeNull();
  });

  test('materially new evidence DOES override a prior rejection', async () => {
    const conn = seed(BIZ_A);
    const first = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    rejectTask(first.proposal_ids[0]!, 'operator', 'not now');

    const blocked = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(blocked.proposed_hires).toBe(0);

    // New evidence: a material signal appears in this agent's data area.
    createTestSignal(BIZ_A, conn, { title: 'Search clicks fell 40%' });

    const after = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(after.suppressed).not.toContain('seo-sentinel');
    expect(after.proposed_hires).toBe(1);
  });

  test('a hard suppression is NOT overridden by new evidence', async () => {
    const conn = seed(BIZ_A);
    const first = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    rejectTask(first.proposal_ids[0]!, 'operator', 'never', {
      disposition: 'hard_suppression', reconsiderPolicy: 'never',
    });

    createTestSignal(BIZ_A, conn, { title: 'Search clicks fell 40%' });
    const after = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(after.proposed_hires).toBe(0);
    expect(after.suppressed).toContain('seo-sentinel');
  });

  test('a temporary deferral binds until it expires, then releases', async () => {
    seed(BIZ_A);
    const first = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    rejectTask(first.proposal_ids[0]!, 'operator', 'revisit next quarter', {
      disposition: 'temporary_deferral', reconsiderPolicy: 'after_expiry', expiresAt: future,
    });

    const during = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(during.suppressed).toContain('seo-sentinel');

    // Expire it.
    db.prepare('UPDATE hiring_decisions SET expires_at = ? WHERE business_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), BIZ_A);

    const after = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(after.suppressed).not.toContain('seo-sentinel');
    expect(after.proposed_hires).toBe(1);
  });

  test('prior decisions are passed to the reasoner as bounded context', async () => {
    seed(BIZ_A);
    createMockConnector(BIZ_A, 'shopify', { lastSyncHoursAgo: 1 });
    __setHiringDeps({
      loadTemplates: () => ([
        ...TEMPLATES,
        { id: 'merchant', profile: { name: 'Merchant', required_connectors: ['shopify'], preferred_connectors: [] } },
      ]) as never,
      reason: okReason([]) as never,
      notify: async () => {},
    });

    const first = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(first.proposed_hires).toBe(0); // reasoner recommended nothing

    // Reject seo-sentinel out of band so it is remembered but merchant is not.
    const task = db.prepare("SELECT id FROM tasks WHERE business_id = ? AND action_type='hire_agent'").get(BIZ_A) as { id: string } | null;
    if (task) rejectTask(task.id, 'operator', 'no');
    else {
      // No task was created (reasoner recommended nothing) — record the
      // decision directly so the prompt-context assertion is still exercised.
      const { recordHiringDecision } = await import('./store.js');
      recordHiringDecision({
        businessId: BIZ_A, templateId: 'seo-sentinel', decision: 'rejected',
        actor: 'operator', reason: 'no', disposition: 'temporary_deferral',
        reconsiderPolicy: 'after_expiry', expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
    }

    await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(lastReasoningInput).not.toBeNull();
    expect(lastReasoningInput!.priorDecisions.some((d) => d.template_id === 'seo-sentinel')).toBe(true);
    expect(lastReasoningInput!.priorDecisions.length).toBeLessThanOrEqual(25);
  });

  test('decision memory is isolated: A\'s rejection does not suppress B', async () => {
    seed(BIZ_A); seed(BIZ_B);
    const a = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    rejectTask(a.proposal_ids[0]!, 'operator', 'no', {
      disposition: 'hard_suppression', reconsiderPolicy: 'never',
    });

    const aAgain = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const b = await analyseAndProposeHires(BIZ_B, { trigger: 'manual' });
    expect(aAgain.proposed_hires).toBe(0);
    expect(b.proposed_hires).toBe(1);
  });
});

describe('#50 suppression disposition semantics (unit)', () => {
  const base: HiringDecisionRecord = {
    id: 'd1', business_id: 'b', template_id: 't', decision: 'rejected',
    disposition: 'changed_circumstances', actor: 'op', reason: null, task_id: null,
    analysis_id: null, evidence_fingerprint: 'FP_OLD', reconsider_policy: 'new_evidence',
    expires_at: null, decided_at: new Date().toISOString(),
  };

  test('identical evidence keeps a changed-circumstances rejection binding', () => {
    expect(evaluateSuppression(base, 'FP_OLD').suppressed).toBe(true);
    expect(evaluateSuppression(base, 'FP_OLD').reason).toBe('no_new_evidence_since_rejection');
  });

  test('different evidence releases it', () => {
    expect(evaluateSuppression(base, 'FP_NEW').suppressed).toBe(false);
  });

  test('a rejection recorded without an evidence snapshot stays binding', () => {
    const noFp = { ...base, evidence_fingerprint: null };
    expect(evaluateSuppression(noFp, 'FP_NEW').suppressed).toBe(true);
  });

  test('an approval is not a suppression', () => {
    expect(evaluateSuppression({ ...base, decision: 'approved' }, 'FP_NEW').suppressed).toBe(false);
  });

  test('no prior decision means no suppression', () => {
    expect(evaluateSuppression(undefined, 'FP').suppressed).toBe(false);
  });
});
