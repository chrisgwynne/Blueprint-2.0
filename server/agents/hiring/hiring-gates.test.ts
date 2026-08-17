/**
 * Decision quality: evidence gates, outcome gates, the learning loop, and
 * what happens when reasoning is unavailable.
 *
 * Issue #48 — a candidate must clear freshness, business-scoped relevance,
 *             WIP/capacity, existing-coverage, historical-outcome and ROI
 *             gates. `status='connected'` alone is not evidence.
 * Issue #51 — no hire without a bounded trial tied to a measurable outcome;
 *             roles whose prior trials produced nothing are not re-proposed.
 * Issue #56 — measured outcomes feed back into future hiring decisions, with
 *             insufficient-data / neutral / successful / unsuccessful all
 *             distinguished, and business-scoped explainable evidence.
 * Issue #47 — a reasoning failure must NOT recommend every eligible candidate
 *             at ordinary confidence. Default is no proposals.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import db from '../../db/db.js';
import {
  assertHiringTestIsolation, cleanupTestBusinesses, createMockConnector,
  createTestBusiness, createTestGoal, createTestSignal,
} from './test-harness.js';
import { analyseAndProposeHires, __setHiringDeps, __resetHiringDeps } from '../conductor-hiring.js';
import { setHiringPolicy } from './policy.js';
import {
  createTrial, getOutcomeHistory, getTrials, listAnalysisRuns,
  recordInstallation, recordTrialOutcome,
} from './store.js';
import {
  DEGRADED_CONFIDENCE_CEILING, MAX_DETERMINISTIC_FALLBACK, deterministicFallback,
} from './reasoning.js';
import type { ReasoningInput, ReasoningOutcome } from './reasoning.js';
import type { GatedCandidate } from './types.js';

assertHiringTestIsolation();

const BIZ = createTestBusiness('gate_a');
const BIZ_B = createTestBusiness('gate_b');

const TEMPLATES = [
  { id: 'seo-sentinel', profile: { name: 'SEO Sentinel', required_connectors: ['gsc'], preferred_connectors: [] } },
  { id: 'merchant', profile: { name: 'Merchant', required_connectors: ['shopify'], preferred_connectors: [] } },
];

let lastInput: ReasoningInput | null = null;

function okReason(ids: string[], confidence = 0.9) {
  return async (input: ReasoningInput): Promise<ReasoningOutcome> => {
    lastInput = input;
    return {
      status: 'ok',
      recommendations: ids.map((id) => ({
        agent_id: id, reason: 'stub', confidence,
        priority: 'suggested' as const, provenance: 'llm' as const, degraded: false,
      })),
      provider: 'stub', model: 'm', attempts: 1, provider_status: 'ok',
      provider_http_status: null, provider_retryable: null, error: null,
      cost_usd: 0, usage: null, raw_unparseable: false,
    };
  };
}

const failedReason = async (input: ReasoningInput): Promise<ReasoningOutcome> => {
  lastInput = input;
  return {
    status: 'failed', recommendations: [], provider: 'google', model: 'gemini-x',
    attempts: 3, provider_status: 'provider_retryable_http_429', provider_http_status: 429,
    provider_retryable: true, error: 'provider google http_429 retryable',
    cost_usd: 0, usage: null, raw_unparseable: false,
  };
};

function reset(): void {
  cleanupTestBusinesses(BIZ, BIZ_B);
  createTestBusiness('gate_a');
  createTestBusiness('gate_b');
  db.prepare("DELETE FROM settings WHERE key = 'hiring_policy'").run();
  setHiringPolicy({ cooldown_minutes: 0, material_change_required: false });
  lastInput = null;
  __setHiringDeps({
    loadTemplates: () => TEMPLATES as never,
    reason: okReason(['seo-sentinel']) as never,
    notify: async () => {},
  });
}

beforeEach(reset);
afterAll(() => { __resetHiringDeps(); cleanupTestBusinesses(BIZ, BIZ_B); });

describe('#48 evidence gates', () => {
  test('a connected-but-never-synced connector is not evidence — no candidate is admitted', async () => {
    createMockConnector(BIZ, 'gsc', { status: 'connected', lastSyncHoursAgo: null });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(result.proposed_hires).toBe(0);
    expect(result.terminal_reason).toBe('no_fresh_evidence');
    expect(lastInput).toBeNull(); // never even reached the reasoner
  });

  test('a connected-but-stale connector is not proposed', async () => {
    // gsc last synced 30 days ago; another connector keeps the business "alive"
    // so the analysis proceeds past the business-level freshness short-circuit.
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 24 * 30 });
    createMockConnector(BIZ, 'shopify', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    setHiringPolicy({ cooldown_minutes: 0, material_change_required: false, freshness_max_age_hours: 72 });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const seo = result.gated.find((g) => g.template_id === 'seo-sentinel');
    expect(seo).toBeTruthy();
    expect(seo!.failures).toContain('stale_required_connector_data');
    expect(result.recommendations.map((r) => r.agent_id)).not.toContain('seo-sentinel');
  });

  test('a candidate with no goal, no signal and no unmet capability is rejected as irrelevant', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    // An installed agent already covers gsc, so there is no unmet capability;
    // and there is no goal or signal in that data area.
    recordInstallation(BIZ, 'other-gsc-agent', { installedBy: 'test' });
    __setHiringDeps({
      loadTemplates: () => ([
        ...TEMPLATES,
        { id: 'other-gsc-agent', profile: { name: 'Other', required_connectors: ['gsc'], preferred_connectors: [] } },
      ]) as never,
      reason: okReason(['seo-sentinel']) as never,
      notify: async () => {},
    });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const seo = result.gated.find((g) => g.template_id === 'seo-sentinel')!;
    expect(seo.failures).toContain('no_linked_goal_signal_or_unmet_capability');
    expect(seo.failures).toContain('already_covered_by_installed_agent');
    expect(result.proposed_hires).toBe(0);
  });

  test('work already covered by an installed agent is not hired twice', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    recordInstallation(BIZ, 'other-gsc-agent', { installedBy: 'test' });
    __setHiringDeps({
      loadTemplates: () => ([
        ...TEMPLATES,
        { id: 'other-gsc-agent', profile: { name: 'Other', required_connectors: ['gsc'], preferred_connectors: [] } },
      ]) as never,
      reason: okReason(['seo-sentinel']) as never,
      notify: async () => {},
    });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const seo = result.gated.find((g) => g.template_id === 'seo-sentinel')!;
    expect(seo.failures).toContain('already_covered_by_installed_agent');
  });

  test('the WIP cap stops a pile-up of open hire proposals', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    setHiringPolicy({ cooldown_minutes: 0, material_change_required: false, max_open_proposals: 1 });

    // One open hire proposal already exists.
    db.prepare(`
      INSERT INTO tasks (id, business_id, title, status, proposed_by, action_type, action_payload, trust_tier, priority, created_at, updated_at)
      VALUES ('t_wip', ?, 'Hire someone', 'proposed', 'conductor', 'hire_agent', '{"template_id":"merchant"}', 'yellow', 'p2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(BIZ);

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const seo = result.gated.find((g) => g.template_id === 'seo-sentinel')!;
    expect(seo.failures).toContain('hiring_wip_limit_reached');
    expect(result.proposed_hires).toBe(0);
  });

  test('a candidate backed by a goal AND a signal carries explainable evidence and a ROI score', async () => {
    const conn = createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 2 });
    const goalId = createTestGoal(BIZ, { title: 'Grow clicks', metricName: 'gsc.clicks', baseline: 100, target: 200 });
    const sigId = createTestSignal(BIZ, conn, { title: 'clicks down' });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(result.proposed_hires).toBe(1);
    const rec = result.recommendations[0]!;
    expect(rec.evidence!.linked_goal_id).toBe(goalId);
    expect(rec.evidence!.linked_signal_ids).toContain(sigId);
    expect(rec.evidence!.fresh_connectors).toContain('gsc');
    expect(rec.evidence!.roi_score).toBeGreaterThan(0.2);
    expect(rec.evidence!.expected_impact).toBeTruthy();
  });
});

describe('#51 outcome gate on the hire itself', () => {
  test('a proposal always carries a bounded trial plan and a trial record', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    const goalId = createTestGoal(BIZ, { title: 'Grow clicks', metricName: 'gsc.clicks', baseline: 100, target: 200 });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const plan = result.recommendations[0]!.trial_plan!;
    expect(plan.goal_id).toBe(goalId);
    expect(plan.target_metric).toBe('gsc.clicks');
    expect(plan.target_value).toBe(200);
    expect(plan.measurement_window_days).toBeGreaterThan(0);
    expect(plan.evidence_deliverable).toContain('days');

    const trials = getTrials(BIZ, 'seo-sentinel');
    expect(trials).toHaveLength(1);
    expect(trials[0]!.status).toBe('planned');
    expect(trials[0]!.task_id).toBe(result.proposal_ids[0]!);
    expect(trials[0]!.confidence_at_hire).toBe(0.9);

    // The payload the approver sees carries the plan too.
    const payload = JSON.parse(
      (db.prepare('SELECT action_payload FROM tasks WHERE id = ?').get(result.proposal_ids[0]!) as { action_payload: string }).action_payload
    );
    expect(payload.trial_plan.evidence_deliverable).toBeTruthy();
  });

  test('a candidate with no definable measurable outcome is NOT proposed', async () => {
    // A template with no required connectors, no goal and no signal: the
    // relevance gate admits nothing, and even if it did there is no target.
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    __setHiringDeps({
      loadTemplates: () => ([
        { id: 'researcher', profile: { name: 'Researcher', required_connectors: [], preferred_connectors: [] } },
      ]) as never,
      reason: okReason(['researcher']) as never,
      notify: async () => {},
    });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(result.proposed_hires).toBe(0);
    expect(getTrials(BIZ, 'researcher')).toHaveLength(0);
  });

  test('an open trial blocks a duplicate hire of the same role', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    createTrial(BIZ, 'seo-sentinel', {
      goal_id: null, signal_id: null, target_metric: 'gsc.clicks',
      baseline_value: 100, target_value: 200, measurement_window_days: 14,
      evidence_deliverable: 'move clicks',
    }, { confidence: 0.8 });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const seo = result.gated.find((g) => g.template_id === 'seo-sentinel')!;
    expect(seo.failures).toContain('prior_trial_still_open');
    expect(result.proposed_hires).toBe(0);
  });

  test('a role whose prior trials produced nothing useful is not re-proposed', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    for (let i = 0; i < 2; i++) {
      const t = createTrial(BIZ, 'seo-sentinel', {
        goal_id: null, signal_id: null, target_metric: 'gsc.clicks',
        baseline_value: 100, target_value: 200, measurement_window_days: 14,
        evidence_deliverable: 'move clicks',
      }, { confidence: 0.9 });
      recordTrialOutcome(BIZ, t, { verdict: 'insufficient_data', verdictReason: 'produced no deliverable' });
    }

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const seo = result.gated.find((g) => g.template_id === 'seo-sentinel')!;
    expect(seo.failures).toContain('prior_trials_produced_no_evidence');
    expect(result.proposed_hires).toBe(0);
  });
});

describe('#56 measured outcomes feed future decisions', () => {
  test('an outcome record captures baseline, target, actual, verdict, calibration and cost', () => {
    const trialId = createTrial(BIZ, 'merchant', {
      goal_id: null, signal_id: null, target_metric: 'shopify.revenue',
      baseline_value: 1000, target_value: 1500, measurement_window_days: 30,
      evidence_deliverable: 'lift revenue',
    }, { confidence: 0.85 });
    recordTrialOutcome(BIZ, trialId, {
      actualValue: 1480, verdict: 'successful', verdictReason: 'reached 96% of target',
      costUsd: 12.5, effortNotes: '3 agent runs', calibrationError: 0.05,
    });

    const t = getTrials(BIZ, 'merchant')[0]!;
    expect(t.baseline_value).toBe(1000);
    expect(t.target_value).toBe(1500);
    expect(t.actual_value).toBe(1480);
    expect(t.verdict).toBe('successful');
    expect(t.confidence_at_hire).toBe(0.85);
    expect(t.calibration_error).toBe(0.05);
    expect(t.cost_usd).toBe(12.5);
    expect(t.measurement_window_days).toBe(30);
    expect(t.measured_at).not.toBeNull();
  });

  test('history distinguishes successful / neutral / unsuccessful / insufficient-data / incomplete', () => {
    const mk = (verdict: 'successful' | 'neutral' | 'unsuccessful' | 'insufficient_data' | null) => {
      const id = createTrial(BIZ, 'merchant', {
        goal_id: null, signal_id: null, target_metric: 'm', baseline_value: 0,
        target_value: 1, measurement_window_days: 7, evidence_deliverable: 'x',
      }, { confidence: 0.8 });
      if (verdict) recordTrialOutcome(BIZ, id, { verdict, calibrationError: 0.1 });
      return id;
    };
    mk('successful'); mk('neutral'); mk('unsuccessful'); mk('insufficient_data'); mk(null);

    const h = getOutcomeHistory(BIZ, 'merchant');
    expect(h.total).toBe(5);
    expect(h.successful).toBe(1);
    expect(h.neutral).toBe(1);
    expect(h.unsuccessful).toBe(1);
    expect(h.insufficient_data).toBe(1);
    expect(h.open).toBe(1); // the incomplete one is still planned
    expect(h.mean_calibration_error).toBeCloseTo(0.1, 5);
  });

  test('an unsuccessful history with no successes retires the role from re-proposal', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    const t = createTrial(BIZ, 'seo-sentinel', {
      goal_id: null, signal_id: null, target_metric: 'gsc.clicks',
      baseline_value: 100, target_value: 200, measurement_window_days: 14,
      evidence_deliverable: 'x',
    }, { confidence: 0.9 });
    recordTrialOutcome(BIZ, t, { verdict: 'unsuccessful', actualValue: 95, verdictReason: 'no movement' });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const seo = result.gated.find((g) => g.template_id === 'seo-sentinel')!;
    expect(seo.failures).toContain('prior_trials_unsuccessful');
    expect(result.proposed_hires).toBe(0);
    // A second unsuccessful trial pushes ROI under the threshold as well, so
    // the role is doubly disqualified rather than relying on one gate.
    const t2 = createTrial(BIZ, 'seo-sentinel', {
      goal_id: null, signal_id: null, target_metric: 'gsc.clicks',
      baseline_value: 100, target_value: 200, measurement_window_days: 14,
      evidence_deliverable: 'x',
    }, { confidence: 0.9 });
    recordTrialOutcome(BIZ, t2, { verdict: 'unsuccessful', actualValue: 90, verdictReason: 'still nothing' });
    const again = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const seo2 = again.gated.find((g) => g.template_id === 'seo-sentinel')!;
    expect(seo2.failures).toContain('roi_below_threshold');
  });

  test('a successful history is surfaced to the reasoner and lifts ROI', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    const t = createTrial(BIZ, 'seo-sentinel', {
      goal_id: null, signal_id: null, target_metric: 'gsc.clicks',
      baseline_value: 100, target_value: 200, measurement_window_days: 14,
      evidence_deliverable: 'x',
    }, { confidence: 0.9 });
    recordTrialOutcome(BIZ, t, { verdict: 'successful', actualValue: 210, verdictReason: 'target exceeded' });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(result.proposed_hires).toBe(1);
    expect(result.recommendations[0]!.evidence!.prior_success).toBe(1);
    expect(lastInput!.priorOutcomes.some((o) => o.template_id === 'seo-sentinel' && o.verdict === 'successful')).toBe(true);
  });

  test('outcome history never crosses businesses', () => {
    const t = createTrial(BIZ, 'merchant', {
      goal_id: null, signal_id: null, target_metric: 'm', baseline_value: 0,
      target_value: 1, measurement_window_days: 7, evidence_deliverable: 'x',
    }, { confidence: 0.8 });
    recordTrialOutcome(BIZ, t, { verdict: 'successful' });
    expect(getOutcomeHistory(BIZ, 'merchant').successful).toBe(1);
    expect(getOutcomeHistory(BIZ_B, 'merchant').successful).toBe(0);
  });
});

describe('#47 reasoning failure must not produce a proposal burst', () => {
  test('by default a provider failure creates ZERO proposals, not one per candidate', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createMockConnector(BIZ, 'shopify', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    createTestGoal(BIZ, { metricName: 'shopify.revenue' });
    __setHiringDeps({
      loadTemplates: () => TEMPLATES as never,
      reason: failedReason as never,
      notify: async () => {},
    });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(result.proposed_hires).toBe(0);
    expect(result.recommendations).toHaveLength(0);
    expect(result.degraded).toBe(true);
    expect(result.fallback_mode).toBe('manual_review_no_proposals');
    expect(result.terminal_reason).toBe('reasoning_unavailable');
    expect(db.prepare("SELECT COUNT(*) n FROM tasks WHERE business_id = ? AND action_type='hire_agent'").get(BIZ)).toEqual({ n: 0 } as never);
  });

  test('a timeout / non-provider failure is treated the same way', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    __setHiringDeps({
      loadTemplates: () => TEMPLATES as never,
      notify: async () => {},
      reason: (async () => ({
        status: 'failed' as const, recommendations: [], provider: 'stub', model: 'm',
        attempts: 1, provider_status: 'non_provider_error', provider_http_status: null,
        provider_retryable: false, error: 'timeout', cost_usd: 0, usage: null, raw_unparseable: false,
      })) as never,
    });
    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(result.proposed_hires).toBe(0);
    expect(result.degraded).toBe(true);
  });

  test('a malformed response produces no proposals and is recorded as degraded', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { metricName: 'gsc.clicks' });
    __setHiringDeps({
      loadTemplates: () => TEMPLATES as never,
      notify: async () => {},
      reason: (async () => ({
        status: 'failed' as const, recommendations: [], provider: 'stub', model: 'm',
        attempts: 1, provider_status: 'unparseable_response', provider_http_status: null,
        provider_retryable: false, error: 'Reasoning response did not contain a recommendations array.',
        cost_usd: 0, usage: null, raw_unparseable: true,
      })) as never,
    });
    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(result.proposed_hires).toBe(0);
    const run = listAnalysisRuns(BIZ)[0]!;
    expect(run.degraded).toBe(1);
    expect(run.provider_status).toBe('unparseable_response');
    expect(run.fallback_mode).toBe('manual_review_no_proposals');
  });

  test('the notification says reasoning was unavailable when a gated fallback does propose', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ, { title: 'Grow clicks', metricName: 'gsc.clicks', baseline: 100, target: 200 });
    setHiringPolicy({ cooldown_minutes: 0, material_change_required: false, allow_deterministic_fallback: true });

    const notes: Array<{ title: string; body: string; severity: string }> = [];
    __setHiringDeps({
      loadTemplates: () => TEMPLATES as never,
      reason: failedReason as never,
      notify: async (n) => { notes.push({ title: n.title, body: n.body, severity: n.severity }); },
    });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(result.degraded).toBe(true);
    expect(result.fallback_mode).toBe('deterministic_gated');
    expect(result.proposed_hires).toBe(1);
    // Conservative confidence, never ordinary confidence.
    expect(result.recommendations[0]!.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(result.recommendations[0]!.provenance).toBe('manual_review');
    expect(notes[0]!.severity).toBe('warning');
    expect(notes[0]!.title).toContain('reasoning unavailable');
    expect(notes[0]!.body).toContain('rule-based');
    // …and the proposal itself is flagged degraded for the approver.
    const task = db.prepare('SELECT description, degraded_data, confidence FROM tasks WHERE id = ?')
      .get(result.proposal_ids[0]!) as { description: string; degraded_data: number; confidence: number };
    expect(task.degraded_data).toBe(1);
    expect(task.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(task.description).toContain('DEGRADED');
  });

  test('the deterministic fallback is hard-gated and bounded (unit)', () => {
    const mk = (over: Partial<GatedCandidate['evidence']>, id: string): GatedCandidate => ({
      id, name: id, title: null, avatar: null, personality: null,
      required: ['gsc'], preferred: [], preferred_met: [],
      admitted: true, gate_failures: [], evidence_fingerprint: `fp_${id}`,
      evidence: {
        fresh_connectors: ['gsc'], stale_connectors: [], linked_goal_id: 'g1',
        linked_goal_title: 'Goal', linked_signal_ids: [], unmet_capability: 'gsc',
        open_wip: 0, wip_limit: 3, existing_coverage: [], prior_trials: 0,
        prior_success: 0, prior_unsuccessful: 0, expected_impact: null, roi_score: 0.8,
        ...over,
      },
    });

    // Disabled by default — this is the whole point of #47.
    expect(deterministicFallback([mk({}, 'a'), mk({}, 'b')], false)).toHaveLength(0);

    // Enabled: bounded count, never one-per-candidate.
    const many = [mk({}, 'a'), mk({}, 'b'), mk({}, 'c')];
    const out = deterministicFallback(many, true);
    expect(out.length).toBeLessThanOrEqual(MAX_DETERMINISTIC_FALLBACK);
    expect(out[0]!.confidence).toBe(DEGRADED_CONFIDENCE_CEILING);
    expect(out[0]!.degraded).toBe(true);
    expect(out[0]!.reason).toContain('DEGRADED');

    // Each hard requirement individually disqualifies a candidate.
    expect(deterministicFallback([mk({ unmet_capability: null }, 'a')], true)).toHaveLength(0);
    expect(deterministicFallback([mk({ stale_connectors: ['gsc'] }, 'a')], true)).toHaveLength(0);
    expect(deterministicFallback([mk({ linked_goal_id: null, linked_signal_ids: [] }, 'a')], true)).toHaveLength(0);
    expect(deterministicFallback([mk({ prior_unsuccessful: 1 }, 'a')], true)).toHaveLength(0);
    expect(deterministicFallback([mk({ roi_score: 0.3 }, 'a')], true)).toHaveLength(0);
  });
});
