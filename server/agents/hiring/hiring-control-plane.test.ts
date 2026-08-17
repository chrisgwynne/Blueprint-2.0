/**
 * Control plane, contract and observability.
 *
 * Issue #57 — a durable kill switch and an ENFORCED dry-run mode, applied in
 *             the single hiring-analysis service every trigger path uses, not
 *             as a UI guard. Mode and skip reason appear in audit records.
 * Issue #53 — a versioned BAP contract for the analysis lifecycle: analysis
 *             id, business, trigger/source, input snapshot + freshness,
 *             decision provenance, proposal ids, degraded/fallback state and
 *             terminal status, with idempotent trigger semantics and
 *             documented no-op / coalesced / suppressed / failed / partial
 *             outcomes.
 * Issue #54 — every analysis emits one correlation record tying trigger,
 *             freshness, provider/model, candidate + rejection counts,
 *             proposal ids, fallback state, cost and terminal result
 *             together; skipped/coalesced/no-op/failure reasons are
 *             first-class; secrets and provider bodies are redacted.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import db from '../../db/db.js';
import {
  assertHiringTestIsolation, cleanupTestBusinesses, createMockConnector,
  createTestBusiness, createTestGoal,
} from './test-harness.js';
import { analyseAndProposeHires, __setHiringDeps, __resetHiringDeps } from '../conductor-hiring.js';
import { getHiringPolicy, resolveHiringPolicy, resolveMode, setBusinessHiringPolicy, setHiringPolicy } from './policy.js';
import { listAnalysisRuns } from './store.js';
import {
  CONTRACT_VERSION, TERMINAL_REASONS, getAnalysisContract, getHiringStatus,
  listAnalysisContracts, redact,
} from './contract.js';
import { runHiringAnalysis } from '../../connectors/post-sync.js';
import type { ReasoningInput, ReasoningOutcome } from './reasoning.js';

assertHiringTestIsolation();

const BIZ = createTestBusiness('cp_a');
const BIZ_B = createTestBusiness('cp_b');

const TEMPLATES = [
  { id: 'seo-sentinel', profile: { name: 'SEO Sentinel', required_connectors: ['gsc'], preferred_connectors: [] } },
];

function okReason(ids: string[]) {
  return async (_input: ReasoningInput): Promise<ReasoningOutcome> => ({
    status: 'ok',
    recommendations: ids.map((id) => ({
      agent_id: id, reason: 'stub', confidence: 0.9,
      priority: 'suggested' as const, provenance: 'llm' as const, degraded: false,
    })),
    provider: 'google', model: 'gemini-x', attempts: 1, provider_status: 'ok',
    provider_http_status: null, provider_retryable: null, error: null,
    cost_usd: 0.0042, usage: null, raw_unparseable: false,
  });
}

function seed(biz: string): void {
  createMockConnector(biz, 'gsc', { lastSyncHoursAgo: 2 });
  createTestGoal(biz, { title: 'Grow clicks', metricName: 'gsc.clicks', baseline: 100, target: 200 });
}

function reset(): void {
  cleanupTestBusinesses(BIZ, BIZ_B);
  createTestBusiness('cp_a');
  createTestBusiness('cp_b');
  db.prepare("DELETE FROM settings WHERE key = 'hiring_policy'").run();
  setHiringPolicy({ cooldown_minutes: 0, material_change_required: false });
  __setHiringDeps({
    loadTemplates: () => TEMPLATES as never,
    reason: okReason(['seo-sentinel']) as never,
    notify: async () => {},
  });
}

beforeEach(reset);
afterAll(() => { __resetHiringDeps(); cleanupTestBusinesses(BIZ, BIZ_B); });

describe('#57 kill switch', () => {
  test('the switch is durable — it survives being read back from settings', () => {
    setHiringPolicy({ enabled: false, disabled_reason: 'migration in progress' });
    expect(getHiringPolicy().enabled).toBe(false);
    expect(getHiringPolicy().disabled_reason).toBe('migration in progress');
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'hiring_policy'").get() as { value: string };
    expect(JSON.parse(raw.value).enabled).toBe(false);
  });

  test.each([
    ['connector_sync'], ['signal'], ['scheduled'], ['manual'], ['bap'], ['onboarding_preview'],
  ])('trigger path %s creates nothing while hiring is disabled', async (trigger) => {
    seed(BIZ);
    setHiringPolicy({ enabled: false, disabled_reason: 'degraded state' });

    const result = await analyseAndProposeHires(BIZ, { trigger: trigger as never, force: true });
    expect(result.mode).toBe('disabled');
    expect(result.status).toBe('skipped');
    expect(result.terminal_reason).toBe('hiring_disabled');
    expect(result.proposed_hires).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM tasks WHERE business_id = ? AND action_type='hire_agent'").get(BIZ))
      .toEqual({ n: 0 } as never);
    expect(db.prepare('SELECT COUNT(*) n FROM hiring_trials WHERE business_id = ?').get(BIZ))
      .toEqual({ n: 0 } as never);
  });

  test('the disabled run is still audited, with mode and skip reason', async () => {
    seed(BIZ);
    setHiringPolicy({ enabled: false, disabled_reason: 'migration in progress' });
    await analyseAndProposeHires(BIZ, { trigger: 'connector_sync' });

    const run = listAnalysisRuns(BIZ)[0]!;
    expect(run.mode).toBe('disabled');
    expect(run.status).toBe('skipped');
    expect(run.terminal_reason).toBe('hiring_disabled');
    expect(run.trigger_source).toBe('connector_sync');
    expect(JSON.parse(run.diagnostics).skip_reason).toContain('migration in progress');
  });

  test('the post-sync trigger path honours the switch (not just direct callers)', async () => {
    seed(BIZ);
    setHiringPolicy({ enabled: false });
    const out = await runHiringAnalysis(BIZ, { connectorType: 'gsc' });
    expect(out.proposed_hires).toBe(0);
    expect(out.terminal_reason).toBe('hiring_disabled');
  });

  test('the switch is per-business: disabling A leaves B hiring', async () => {
    seed(BIZ); seed(BIZ_B);
    setBusinessHiringPolicy(BIZ, { enabled: false, disabled_reason: 'A is migrating' });

    expect(resolveHiringPolicy(BIZ).enabled).toBe(false);
    expect(resolveHiringPolicy(BIZ_B).enabled).toBe(true);

    const a = await analyseAndProposeHires(BIZ, { trigger: 'scheduled' });
    const b = await analyseAndProposeHires(BIZ_B, { trigger: 'scheduled' });
    expect(a.terminal_reason).toBe('hiring_disabled');
    expect(b.proposed_hires).toBe(1);
  });
});

describe('#57 dry-run mode', () => {
  test('policy dry-run evaluates and persists decisions but creates nothing', async () => {
    seed(BIZ);
    setHiringPolicy({ cooldown_minutes: 0, material_change_required: false, dry_run: true });

    const result = await analyseAndProposeHires(BIZ, { trigger: 'connector_sync' });
    expect(result.mode).toBe('dry_run');
    expect(result.terminal_reason).toBe('dry_run');
    // Decisions ARE produced and returned…
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]!.agent_id).toBe('seo-sentinel');
    expect(result.recommendations[0]!.trial_plan).toBeTruthy();
    // …but nothing is created.
    expect(result.proposed_hires).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM tasks WHERE business_id = ?").get(BIZ)).toEqual({ n: 0 } as never);
    expect(db.prepare('SELECT COUNT(*) n FROM hiring_trials WHERE business_id = ?').get(BIZ)).toEqual({ n: 0 } as never);
    expect(db.prepare('SELECT COUNT(*) n FROM hiring_proposal_keys WHERE business_id = ?').get(BIZ)).toEqual({ n: 0 } as never);
    expect(db.prepare('SELECT COUNT(*) n FROM agent_installations WHERE business_id = ?').get(BIZ)).toEqual({ n: 0 } as never);
    // …and the analysis record proves it ran.
    const run = listAnalysisRuns(BIZ)[0]!;
    expect(run.mode).toBe('dry_run');
    expect(run.recommendations_count).toBe(1);
    expect(run.proposals_created).toBe(0);
  });

  test.each([
    ['connector_sync'], ['signal'], ['scheduled'], ['bap'],
  ])('automatic trigger path %s respects policy dry-run', async (trigger) => {
    seed(BIZ);
    setHiringPolicy({ cooldown_minutes: 0, material_change_required: false, dry_run: true });
    const result = await analyseAndProposeHires(BIZ, { trigger: trigger as never, force: true });
    expect(result.mode).toBe('dry_run');
    expect(result.proposed_hires).toBe(0);
  });

  test('a caller cannot upgrade itself out of a policy-imposed restriction', () => {
    setHiringPolicy({ dry_run: true });
    // Even a caller that passes dryRun:false gets dry_run.
    expect(resolveMode(BIZ, false).mode).toBe('dry_run');
    setHiringPolicy({ dry_run: false, enabled: false });
    expect(resolveMode(BIZ, false).mode).toBe('disabled');
  });

  test('a caller CAN opt into dry-run when policy is live (onboarding preview)', async () => {
    seed(BIZ);
    const result = await analyseAndProposeHires(BIZ, { dryRun: true, trigger: 'onboarding_preview', force: true });
    expect(result.mode).toBe('dry_run');
    expect(result.recommendations).toHaveLength(1);
    expect(result.proposed_hires).toBe(0);
  });
});

describe('#53 versioned lifecycle contract', () => {
  test('a successful analysis produces a complete, versioned contract', async () => {
    seed(BIZ);
    const result = await analyseAndProposeHires(BIZ, {
      trigger: 'connector_sync', triggerRef: 'gsc', triggerReason: 'gsc sync completed',
    });
    const c = getAnalysisContract(BIZ, result.analysis_id!)!;

    expect(c.contract_version).toBe(CONTRACT_VERSION);
    expect(c.analysis_id).toBe(result.analysis_id!);
    expect(c.business_id).toBe(BIZ);
    expect(c.trigger).toEqual({
      source: 'connector_sync', ref: 'gsc', reason: 'gsc sync completed', idempotency_key: null,
    });
    expect(c.mode).toBe('live');
    expect(c.status).toBe('complete');
    expect(c.terminal_reason).toBe('proposals_created');
    expect(c.terminal_reason_description).toBeTruthy();
    expect(c.input.freshness.fresh_connector_count).toBe(1);
    expect(c.input.freshness.stale_connector_count).toBe(0);
    expect(c.input.freshness.max_age_hours).toBe(72);
    expect(c.decision.proposal_ids).toEqual(result.proposal_ids);
    expect(c.decision.candidates_considered).toBe(1);
    expect(c.provenance.provider).toBe('google');
    expect(c.provenance.model).toBe('gemini-x');
    expect(c.provenance.cost_usd).toBeCloseTo(0.0042, 6);
    expect(c.degraded).toBe(false);
    expect(c.completed_at).not.toBeNull();
  });

  test('no-candidates is a documented terminal outcome, not an absent record', async () => {
    createMockConnector(BIZ, 'shopify', { lastSyncHoursAgo: 1 });
    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    const c = getAnalysisContract(BIZ, result.analysis_id!)!;
    expect(c.status).toBe('complete');
    expect(c.terminal_reason).toBe('no_candidates');
    expect(TERMINAL_REASONS.no_candidates).toBeTruthy();
    expect(c.decision.proposals_created).toBe(0);
  });

  test('a duplicate trigger with the same idempotency key resolves to the same analysis', async () => {
    seed(BIZ);
    const first = await analyseAndProposeHires(BIZ, { trigger: 'bap', idempotencyKey: 'k-1' });
    const second = await analyseAndProposeHires(BIZ, { trigger: 'bap', idempotencyKey: 'k-1' });

    expect(second.analysis_id).toBe(first.analysis_id!);
    expect(second.terminal_reason).toBe('duplicate_trigger');
    // Exactly one analysis and one proposal exist.
    expect(listAnalysisRuns(BIZ).filter((r) => r.idempotency_key === 'k-1')).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM tasks WHERE business_id = ? AND action_type='hire_agent'").get(BIZ))
      .toEqual({ n: 1 } as never);
  });

  test('a provider failure is a terminal contract state with provenance', async () => {
    seed(BIZ);
    __setHiringDeps({
      loadTemplates: () => TEMPLATES as never,
      notify: async () => {},
      reason: (async () => ({
        status: 'failed' as const, recommendations: [], provider: 'google', model: 'gemini-x',
        attempts: 3, provider_status: 'provider_retryable_http_429', provider_http_status: 429,
        provider_retryable: true, error: 'provider google http_429 retryable',
        cost_usd: 0, usage: null, raw_unparseable: false,
      })) as never,
    });
    const result = await analyseAndProposeHires(BIZ, { trigger: 'scheduled' });
    const c = getAnalysisContract(BIZ, result.analysis_id!)!;
    expect(c.status).toBe('partial');
    expect(c.terminal_reason).toBe('reasoning_unavailable');
    expect(c.degraded).toBe(true);
    expect(c.fallback_mode).toBe('manual_review_no_proposals');
    expect(c.provenance.provider_http_status).toBe(429);
    expect(c.provenance.provider_retryable).toBe(true);
    expect(c.provenance.provider_attempts).toBe(3);
  });

  test('stale input is a documented terminal outcome', async () => {
    createMockConnector(BIZ, 'gsc', { lastSyncHoursAgo: 24 * 90 });
    const result = await analyseAndProposeHires(BIZ, { trigger: 'scheduled' });
    const c = getAnalysisContract(BIZ, result.analysis_id!)!;
    expect(c.terminal_reason).toBe('no_fresh_evidence');
    expect(c.input.freshness.fresh_connector_count).toBe(0);
    expect(c.input.freshness.stale_connector_count).toBe(1);
  });

  test('a contract belonging to another business is not readable', async () => {
    seed(BIZ);
    const result = await analyseAndProposeHires(BIZ, { trigger: 'manual' });
    expect(getAnalysisContract(BIZ_B, result.analysis_id!)).toBeNull();
    expect(listAnalysisContracts(BIZ_B).every((c) => c.business_id === BIZ_B)).toBe(true);
  });
});

describe('#54 business-scoped observability', () => {
  test('one correlation record ties trigger, freshness, provider, counts, proposals, cost and result together', async () => {
    seed(BIZ);
    const result = await analyseAndProposeHires(BIZ, {
      trigger: 'signal', triggerRef: 'sig_1', triggerReason: '2 new signals',
    });
    const run = listAnalysisRuns(BIZ)[0]!;

    expect(run.trigger_source).toBe('signal');
    expect(run.trigger_ref).toBe('sig_1');
    expect(run.trigger_reason).toBe('2 new signals');
    expect(JSON.parse(run.input_snapshot).fresh_connector_count).toBe(1);
    expect(run.provider).toBe('google');
    expect(run.model).toBe('gemini-x');
    expect(run.candidates_considered).toBe(1);
    expect(run.recommendations_count).toBe(1);
    expect(run.proposals_created).toBe(1);
    expect(JSON.parse(run.proposal_ids)).toEqual(result.proposal_ids);
    expect(run.cost_usd).toBeCloseTo(0.0042, 6);
    expect(run.degraded).toBe(0);
    expect(run.terminal_reason).toBe('proposals_created');
    expect(run.completed_at).not.toBeNull();
  });

  test('skipped, coalesced, no-op and failure reasons are all first-class records', async () => {
    seed(BIZ);
    setHiringPolicy({ cooldown_minutes: 60, material_change_required: true });

    await analyseAndProposeHires(BIZ, { trigger: 'connector_sync' });        // complete
    await analyseAndProposeHires(BIZ, { trigger: 'signal' });                // skipped (paced)
    await Promise.all([                                                      // one coalesced
      analyseAndProposeHires(BIZ, { trigger: 'manual' }),
      analyseAndProposeHires(BIZ, { trigger: 'manual' }),
    ]);

    const reasons = listAnalysisRuns(BIZ, 50).map((r) => `${r.status}:${r.terminal_reason}`);
    expect(reasons.some((r) => r.startsWith('complete:'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('skipped:'))).toBe(true);
    // The coalesced caller is counted on the primary run rather than fabricating
    // a second analysis record.
    const status = getHiringStatus(BIZ);
    expect(status.pacing.skipped_count).toBeGreaterThanOrEqual(1);
    expect(status.pacing.coalesced_count).toBeGreaterThanOrEqual(1);
  });

  test('the status read-back is business-scoped and reports policy + pacing', async () => {
    seed(BIZ); seed(BIZ_B);
    await analyseAndProposeHires(BIZ, { trigger: 'connector_sync', triggerReason: 'gsc sync' });

    const status = getHiringStatus(BIZ);
    expect(status.contract_version).toBe(CONTRACT_VERSION);
    expect(status.business_id).toBe(BIZ);
    expect(status.policy.enabled).toBe(true);
    expect(status.policy.dry_run).toBe(false);
    expect(status.pacing.last_trigger_source).toBe('connector_sync');
    expect(status.pacing.last_trigger_reason).toBe('gsc sync');
    expect(status.pacing.last_analysis_at).not.toBeNull();
    expect(status.latest!.business_id).toBe(BIZ);
    expect(status.recent.every((c) => c.business_id === BIZ)).toBe(true);

    // B has done nothing and its status says exactly that.
    const statusB = getHiringStatus(BIZ_B);
    expect(statusB.latest).toBeNull();
    expect(statusB.recent).toHaveLength(0);
  });

  test('secrets, provider bodies and URLs are redacted from the read surface', () => {
    expect(redact('key AIzaSyABCDEF12345 leaked')).not.toContain('AIzaSyABCDEF12345');
    expect(redact('Bearer abc.def.ghi')).toContain('[redacted]');
    expect(redact('token sk-livesecret123')).not.toContain('sk-livesecret123');
    expect(redact('see https://api.example.com/v1?key=abc')).not.toContain('api.example.com');
    expect(redact('mail ops@example.com')).not.toContain('ops@example.com');
    expect(redact(null)).toBeNull();
    expect(redact('x'.repeat(500))!.length).toBe(300);
  });

  test('trace-based acceptance: connector, signal, scheduled and provider-failure triggers are all attributable', async () => {
    seed(BIZ);
    setHiringPolicy({ cooldown_minutes: 0, material_change_required: false });

    await analyseAndProposeHires(BIZ, { trigger: 'connector_sync', triggerRef: 'gsc', triggerReason: 'sync' });
    await analyseAndProposeHires(BIZ, { trigger: 'signal', triggerRef: 'sig_9', triggerReason: 'new signal' });
    await analyseAndProposeHires(BIZ, { trigger: 'scheduled', triggerReason: 'daily sweep' });

    // Close out the proposal the first run created so the failure run has a
    // live candidate to fail ON, rather than short-circuiting as
    // 'all_already_proposed'.
    db.prepare("UPDATE tasks SET status = 'complete' WHERE business_id = ?").run(BIZ);
    db.prepare('DELETE FROM hiring_proposal_keys WHERE business_id = ?').run(BIZ);
    db.prepare('DELETE FROM hiring_trials WHERE business_id = ?').run(BIZ);

    __setHiringDeps({
      loadTemplates: () => TEMPLATES as never,
      notify: async () => {},
      reason: (async () => ({
        status: 'failed' as const, recommendations: [], provider: 'google', model: 'gemini-x',
        attempts: 2, provider_status: 'provider_retryable_http_503', provider_http_status: 503,
        provider_retryable: true, error: 'provider google http_503 retryable',
        cost_usd: 0, usage: null, raw_unparseable: false,
      })) as never,
    });
    await analyseAndProposeHires(BIZ, { trigger: 'scheduled', triggerReason: 'retry sweep' });

    const contracts = listAnalysisContracts(BIZ, 50);
    const bySource = new Map(contracts.map((c) => [`${c.trigger.source}:${c.trigger.reason}`, c]));
    expect(bySource.has('connector_sync:sync')).toBe(true);
    expect(bySource.has('signal:new signal')).toBe(true);
    expect(bySource.has('scheduled:daily sweep')).toBe(true);

    const failure = bySource.get('scheduled:retry sweep')!;
    expect(failure.degraded).toBe(true);
    expect(failure.provenance.provider_http_status).toBe(503);
    expect(failure.error).toBeTruthy();

    // Every trace is attributable end to end: id, business, trigger, terminal
    // reason and completion time are present on every single record.
    for (const c of contracts) {
      expect(c.analysis_id).toBeTruthy();
      expect(c.business_id).toBe(BIZ);
      expect(c.trigger.source).toBeTruthy();
      expect(c.terminal_reason).toBeTruthy();
      expect(c.completed_at).not.toBeNull();
      expect(c.contract_version).toBe(CONTRACT_VERSION);
    }
  });
});
