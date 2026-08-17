/**
 * Multi-business isolation across the hiring lifecycle.
 *
 * Issue #49 — installed-agent lookup must be business-scoped.
 * Issue #55 — EVERY hiring-related read/write must be business-scoped:
 *             candidate discovery, installed state, suppression memory,
 *             analysis runs, proposals, notifications and outcome evidence.
 * Issue #58 — the suite itself must be provably isolated from any production
 *             DB, must use reserved test ids, and must mock external
 *             connectors rather than performing network I/O.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import db from '../../db/db.js';
import {
  assertHiringTestIsolation, cleanupTestBusinesses, createMockConnector,
  createTestBusiness, createTestGoal, TEST_ID_PREFIX,
} from './test-harness.js';
import {
  analyseAndProposeHires, __setHiringDeps, __resetHiringDeps,
} from '../conductor-hiring.js';
import { setHiringPolicy } from './policy.js';
import {
  getAnalysisRun, getHiringDecisions, getInstalledAgentIds, getOutcomeHistory,
  listAnalysisRuns, recordHiringDecision, recordInstallation, recordTrialOutcome,
  createTrial, assertBusiness,
} from './store.js';
import type { ReasoningOutcome } from './reasoning.js';

// #58: fails fast at import time unless the process is provably isolated.
const isolation = assertHiringTestIsolation();

const BIZ_A = createTestBusiness('iso_a', { name: 'Business A' });
const BIZ_B = createTestBusiness('iso_b', { name: 'Business B' });

const TEMPLATES = [
  { id: 'seo-sentinel', profile: { name: 'SEO Sentinel', required_connectors: ['gsc'], preferred_connectors: [] } },
  { id: 'merchant', profile: { name: 'Merchant', required_connectors: ['shopify'], preferred_connectors: [] } },
];

/** A reasoning stub — hiring tests never call a live provider (#58). */
function stubReason(recommend: string[]): () => Promise<ReasoningOutcome> {
  return async () => ({
    status: 'ok',
    recommendations: recommend.map((id) => ({
      agent_id: id, reason: 'stub', expected_value: 'stub',
      confidence: 0.9, priority: 'suggested' as const, provenance: 'llm' as const, degraded: false,
    })),
    provider: 'stub', model: 'stub-model', attempts: 1,
    provider_status: 'ok', provider_http_status: null, provider_retryable: null,
    error: null, cost_usd: 0, usage: null, raw_unparseable: false,
  });
}

const notifications: Array<{ business_id: string; title: string }> = [];

function resetAll(): void {
  cleanupTestBusinesses(BIZ_A, BIZ_B);
  createTestBusiness('iso_a', { name: 'Business A' });
  createTestBusiness('iso_b', { name: 'Business B' });
  db.prepare("DELETE FROM settings WHERE key = 'hiring_policy'").run();
  setHiringPolicy({ cooldown_minutes: 0, material_change_required: false });
  notifications.length = 0;
  __setHiringDeps({
    loadTemplates: () => TEMPLATES as never,
    reason: stubReason(['seo-sentinel']) as never,
    notify: async (n) => { notifications.push({ business_id: n.business_id, title: n.title }); },
  });
}

beforeEach(resetAll);
afterAll(() => { __resetHiringDeps(); cleanupTestBusinesses(BIZ_A, BIZ_B); });

describe('#58 test isolation harness', () => {
  test('runs against an in-memory database, with connectors mocked by default', () => {
    expect(isolation.mode).toBe('memory');
    expect(isolation.database_path).toBe(':memory:');
    expect(isolation.connectors_mocked).toBe(true);
  });

  test('every id this suite creates carries the reserved test prefix', () => {
    expect(BIZ_A.startsWith(TEST_ID_PREFIX)).toBe(true);
    expect(BIZ_B.startsWith(TEST_ID_PREFIX)).toBe(true);
    const connId = createMockConnector(BIZ_A, 'gsc', { lastSyncHoursAgo: 1 });
    expect(connId.startsWith(TEST_ID_PREFIX)).toBe(true);
    const config = db.prepare('SELECT config FROM connectors WHERE id = ?').get(connId) as { config: string };
    expect(JSON.parse(config.config).mock).toBe(true);
  });

  test('a hiring store call without a valid business id is a hard error, not a silent no-op', () => {
    expect(() => assertBusiness('')).toThrow(/businessId is required/);
    expect(() => assertBusiness('no_such_business')).toThrow(/not found/);
  });
});

describe('#49 installed-agent lookup is business-scoped', () => {
  test('an agent installed for business A is still a candidate for business B', async () => {
    createMockConnector(BIZ_A, 'gsc', { lastSyncHoursAgo: 1 });
    createMockConnector(BIZ_B, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ_A, { metricName: 'gsc.clicks' });
    createTestGoal(BIZ_B, { metricName: 'gsc.clicks' });

    // Business A hires seo-sentinel. The instance-wide `agents` roster row is
    // what the OLD code read — seed it too, to prove the fix does not depend
    // on that table being empty.
    recordInstallation(BIZ_A, 'seo-sentinel', { installedBy: 'test' });
    db.prepare(`INSERT INTO agents (id, profile_path, name, status) VALUES ('seo-sentinel', 'p', 'SEO Sentinel', 'active')
                ON CONFLICT(id) DO NOTHING`).run();

    expect([...getInstalledAgentIds(BIZ_A)]).toEqual(['seo-sentinel']);
    expect([...getInstalledAgentIds(BIZ_B)]).toEqual([]);

    const resultA = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const resultB = await analyseAndProposeHires(BIZ_B, { trigger: 'manual' });

    // A already has it, so it is not a candidate there…
    expect(resultA.recommendations.map((r) => r.agent_id)).not.toContain('seo-sentinel');
    // …but B has never hired it, so it is.
    expect(resultB.recommendations.map((r) => r.agent_id)).toContain('seo-sentinel');
    expect(resultB.proposed_hires).toBe(1);

    db.prepare("DELETE FROM agents WHERE id = 'seo-sentinel'").run();
  });

  test('retiring an installation for one business does not affect the other', () => {
    recordInstallation(BIZ_A, 'merchant', { installedBy: 'test' });
    recordInstallation(BIZ_B, 'merchant', { installedBy: 'test' });
    db.prepare(`UPDATE agent_installations SET status = 'uninstalled' WHERE business_id = ? AND agent_id = 'merchant'`).run(BIZ_A);
    expect(getInstalledAgentIds(BIZ_A).has('merchant')).toBe(false);
    expect(getInstalledAgentIds(BIZ_B).has('merchant')).toBe(true);
  });
});

describe('#55 isolation across the whole hiring lifecycle', () => {
  test('business A cannot read, suppress, propose, notify or learn from business B', async () => {
    createMockConnector(BIZ_A, 'gsc', { lastSyncHoursAgo: 1 });
    createMockConnector(BIZ_B, 'gsc', { lastSyncHoursAgo: 1 });
    createTestGoal(BIZ_A, { metricName: 'gsc.clicks' });
    createTestGoal(BIZ_B, { metricName: 'gsc.clicks' });

    // ── Suppression memory: A rejects seo-sentinel.
    recordHiringDecision({
      businessId: BIZ_A, templateId: 'seo-sentinel', decision: 'rejected',
      actor: 'operator-a', reason: 'not now', disposition: 'hard_suppression',
      reconsiderPolicy: 'never',
    });
    expect(getHiringDecisions(BIZ_A)).toHaveLength(1);
    expect(getHiringDecisions(BIZ_B)).toHaveLength(0);

    const resultA = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const resultB = await analyseAndProposeHires(BIZ_B, { trigger: 'manual' });

    // A's suppression binds A only.
    expect(resultA.suppressed).toContain('seo-sentinel');
    expect(resultA.proposed_hires).toBe(0);
    expect(resultB.proposed_hires).toBe(1);

    // ── Proposals: each business sees only its own.
    const tasksA = db.prepare("SELECT id FROM tasks WHERE business_id = ? AND action_type = 'hire_agent'").all(BIZ_A);
    const tasksB = db.prepare("SELECT id FROM tasks WHERE business_id = ? AND action_type = 'hire_agent'").all(BIZ_B);
    expect(tasksA).toHaveLength(0);
    expect(tasksB).toHaveLength(1);

    // ── Analysis runs: a run belonging to B is invisible to A.
    expect(getAnalysisRun(BIZ_A, resultB.analysis_id!)).toBeNull();
    expect(getAnalysisRun(BIZ_B, resultB.analysis_id!)).not.toBeNull();
    expect(listAnalysisRuns(BIZ_A).every((r) => r.business_id === BIZ_A)).toBe(true);

    // ── Notifications carry the owning business id (they previously did not,
    //    so a dashboard notification was not attributable to any business).
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.business_id).toBe(BIZ_B);
  });

  test('outcome evidence is business-scoped: A\'s failed trial does not penalise B', () => {
    const trialA = createTrial(BIZ_A, 'merchant', {
      goal_id: null, signal_id: null, target_metric: 'shopify.revenue',
      baseline_value: 100, target_value: 200, measurement_window_days: 14,
      evidence_deliverable: 'move revenue',
    }, { confidence: 0.9 });
    recordTrialOutcome(BIZ_A, trialA, { verdict: 'unsuccessful', actualValue: 90, verdictReason: 'no movement' });

    expect(getOutcomeHistory(BIZ_A, 'merchant').unsuccessful).toBe(1);
    expect(getOutcomeHistory(BIZ_B, 'merchant').unsuccessful).toBe(0);
    expect(getOutcomeHistory(BIZ_B, 'merchant').total).toBe(0);
  });

  test('concurrent analyses for two businesses with identical template ids stay separate', async () => {
    for (const biz of [BIZ_A, BIZ_B]) {
      createMockConnector(biz, 'gsc', { lastSyncHoursAgo: 1 });
      createTestGoal(biz, { metricName: 'gsc.clicks' });
    }

    const [ra, rb] = await Promise.all([
      analyseAndProposeHires(BIZ_A, { trigger: 'manual' }),
      analyseAndProposeHires(BIZ_B, { trigger: 'manual' }),
    ]);

    expect(ra.proposed_hires).toBe(1);
    expect(rb.proposed_hires).toBe(1);
    expect(ra.analysis_id).not.toBe(rb.analysis_id);

    // Each proposal, proposal key and trial belongs to exactly one business.
    for (const [biz, result] of [[BIZ_A, ra], [BIZ_B, rb]] as const) {
      const task = db.prepare('SELECT business_id FROM tasks WHERE id = ?').get(result.proposal_ids[0]!) as { business_id: string };
      expect(task.business_id).toBe(biz);
      const keys = db.prepare('SELECT business_id FROM hiring_proposal_keys WHERE template_id = ?').all('seo-sentinel') as Array<{ business_id: string }>;
      expect(keys.some((k) => k.business_id === biz)).toBe(true);
      const trials = db.prepare('SELECT business_id FROM hiring_trials WHERE business_id = ?').all(biz);
      expect(trials).toHaveLength(1);
    }
  });
});
