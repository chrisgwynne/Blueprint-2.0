/**
 * Trigger coordination, concurrency and failure handling.
 *
 * Issue #45 — concurrent hiring analyses must not create duplicate
 *             `hire_agent` tasks; proposal creation is idempotent for
 *             (business_id, template_id, analysis window).
 * Issue #46 — the three independent trigger paths (connector sync, signal
 *             engine, scheduled) share one per-business coordinator with a
 *             documented cooldown and material-change policy, and persist
 *             trigger reason / last analysis / next eligible / skipped counts.
 * Issue #52 — provider failures are terminal, bounded and recoverable: only
 *             429/5xx retry, attempts are capped, Retry-After is honoured,
 *             one business's failure cannot block another, and stale
 *             `running` rows are reconciled with explicit terminal reasons.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import db from '../../db/db.js';
import {
  assertHiringTestIsolation, cleanupTestBusinesses, createMockConnector,
  createTestBusiness, createTestGoal,
} from './test-harness.js';
import {
  analyseAndProposeHires, runScheduledHiringSweep, __setHiringDeps, __resetHiringDeps,
} from '../conductor-hiring.js';
import { setHiringPolicy } from './policy.js';
import { getCoordination, listAnalysisRuns, reconcileStaleAnalysisRuns, startAnalysisRun } from './store.js';
import { reasonAboutHires, type ReasoningOutcome } from './reasoning.js';
import { ProviderHttpError } from '../../lib/provider-errors.js';

assertHiringTestIsolation();

const BIZ_A = createTestBusiness('coord_a');
const BIZ_B = createTestBusiness('coord_b');

const TEMPLATES = [
  { id: 'seo-sentinel', profile: { name: 'SEO Sentinel', required_connectors: ['gsc'], preferred_connectors: [] } },
  { id: 'merchant', profile: { name: 'Merchant', required_connectors: ['shopify'], preferred_connectors: [] } },
];

let reasonCalls = 0;

function okReason(ids: string[]): () => Promise<ReasoningOutcome> {
  return async () => {
    reasonCalls++;
    return {
      status: 'ok',
      recommendations: ids.map((id) => ({
        agent_id: id, reason: 'stub', confidence: 0.9,
        priority: 'suggested' as const, provenance: 'llm' as const, degraded: false,
      })),
      provider: 'stub', model: 'm', attempts: 1, provider_status: 'ok',
      provider_http_status: null, provider_retryable: null, error: null,
      cost_usd: 0.01, usage: null, raw_unparseable: false,
    };
  };
}

function seed(biz: string): void {
  createMockConnector(biz, 'gsc', { lastSyncHoursAgo: 1 });
  createTestGoal(biz, { metricName: 'gsc.clicks' });
}

function reset(): void {
  cleanupTestBusinesses(BIZ_A, BIZ_B);
  createTestBusiness('coord_a');
  createTestBusiness('coord_b');
  db.prepare("DELETE FROM settings WHERE key = 'hiring_policy'").run();
  setHiringPolicy({ cooldown_minutes: 0, material_change_required: false });
  reasonCalls = 0;
  __setHiringDeps({
    loadTemplates: () => TEMPLATES as never,
    reason: okReason(['seo-sentinel']) as never,
    notify: async () => {},
  });
}

beforeEach(reset);
afterAll(() => { __resetHiringDeps(); cleanupTestBusinesses(BIZ_A, BIZ_B); });

describe('#45 concurrent analyses cannot duplicate hire proposals', () => {
  test('simultaneous analyses produce exactly one proposal per template per business', async () => {
    seed(BIZ_A);
    const results = await Promise.all([
      analyseAndProposeHires(BIZ_A, { trigger: 'connector_sync' }),
      analyseAndProposeHires(BIZ_A, { trigger: 'signal' }),
      analyseAndProposeHires(BIZ_A, { trigger: 'scheduled' }),
      analyseAndProposeHires(BIZ_A, { trigger: 'manual' }),
    ]);

    const tasks = db.prepare(
      "SELECT id, action_payload FROM tasks WHERE business_id = ? AND action_type = 'hire_agent'"
    ).all(BIZ_A) as Array<{ id: string; action_payload: string }>;
    expect(tasks).toHaveLength(1);
    expect(JSON.parse(tasks[0]!.action_payload).template_id).toBe('seo-sentinel');

    // Exactly one caller did the work; the rest were coalesced onto it.
    expect(results.filter((r) => r.proposed_hires === 1)).toHaveLength(1);
    expect(results.filter((r) => r.terminal_reason === 'coalesced')).toHaveLength(3);
    // And reasoning ran once, not four times.
    expect(reasonCalls).toBe(1);
  });

  test('coalesced callers are counted on the analysis record, not silently dropped', async () => {
    seed(BIZ_A);
    await Promise.all([
      analyseAndProposeHires(BIZ_A, { trigger: 'connector_sync' }),
      analyseAndProposeHires(BIZ_A, { trigger: 'signal' }),
    ]);
    const runs = listAnalysisRuns(BIZ_A);
    const primary = runs.find((r) => r.proposals_created === 1)!;
    expect(primary.coalesced_callers).toBe(1);
    expect(getCoordination(BIZ_A)!.coalesced_count).toBe(1);
  });

  test('proposal creation is idempotent for (business, template, window)', async () => {
    seed(BIZ_A);
    const first = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(first.proposed_hires).toBe(1);

    // Remove the open task so the open-proposal dedup cannot mask the test —
    // the DB-level window key must still refuse a second proposal.
    db.prepare("UPDATE tasks SET status = 'complete' WHERE business_id = ?").run(BIZ_A);

    const second = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(second.proposed_hires).toBe(0);
    const keys = db.prepare('SELECT * FROM hiring_proposal_keys WHERE business_id = ?').all(BIZ_A);
    expect(keys).toHaveLength(1);
  });
});

describe('#46 per-business trigger coordination', () => {
  test('a second trigger inside the cooldown window is skipped with a recorded reason', async () => {
    setHiringPolicy({ cooldown_minutes: 60, material_change_required: true });
    seed(BIZ_A);

    const first = await analyseAndProposeHires(BIZ_A, { trigger: 'connector_sync', triggerReason: 'gsc sync' });
    expect(first.status).toBe('complete');

    const second = await analyseAndProposeHires(BIZ_A, { trigger: 'signal', triggerReason: '3 new signals' });
    expect(second.status).toBe('skipped');
    expect(['cooldown', 'no_material_change']).toContain(second.terminal_reason);

    const coord = getCoordination(BIZ_A)!;
    expect(coord.last_trigger_source).toBe('connector_sync');
    expect(coord.last_trigger_reason).toBe('gsc sync');
    expect(coord.last_analysis_at).not.toBeNull();
    expect(coord.next_eligible_at).not.toBeNull();
    expect(coord.skipped_count).toBeGreaterThanOrEqual(1);
    expect(coord.last_input_fingerprint).not.toBeNull();
  });

  test('unchanged inputs are not material even after the cooldown expires', async () => {
    setHiringPolicy({ cooldown_minutes: 60, material_change_required: true });
    seed(BIZ_A);
    await analyseAndProposeHires(BIZ_A, { trigger: 'manual', force: true });
    // Fast-forward past the cooldown.
    db.prepare("UPDATE hiring_coordination SET next_eligible_at = datetime('now','-1 hour') WHERE business_id = ?").run(BIZ_A);

    const again = await analyseAndProposeHires(BIZ_A, { trigger: 'scheduled' });
    expect(again.terminal_reason).toBe('no_material_change');
  });

  test('a material change (new connector) makes the business eligible again', async () => {
    setHiringPolicy({ cooldown_minutes: 60, material_change_required: true });
    seed(BIZ_A);
    await analyseAndProposeHires(BIZ_A, { trigger: 'manual', force: true });
    db.prepare("UPDATE hiring_coordination SET next_eligible_at = datetime('now','-1 hour') WHERE business_id = ?").run(BIZ_A);

    createMockConnector(BIZ_A, 'shopify', { lastSyncHoursAgo: 1 });
    const again = await analyseAndProposeHires(BIZ_A, { trigger: 'connector_sync', triggerReason: 'shopify connected' });
    expect(again.status).toBe('complete');
    expect(again.terminal_reason).not.toBe('no_material_change');
  });

  test('an explicit human trigger is never debounced away', async () => {
    setHiringPolicy({ cooldown_minutes: 60, material_change_required: true });
    seed(BIZ_A);
    await analyseAndProposeHires(BIZ_A, { trigger: 'connector_sync' });
    const manual = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(manual.status).not.toBe('skipped');
  });

  test('pacing one business does not pace another', async () => {
    setHiringPolicy({ cooldown_minutes: 60, material_change_required: true });
    seed(BIZ_A); seed(BIZ_B);
    await analyseAndProposeHires(BIZ_A, { trigger: 'connector_sync' });
    const paced = await analyseAndProposeHires(BIZ_A, { trigger: 'signal' });
    const other = await analyseAndProposeHires(BIZ_B, { trigger: 'signal' });
    expect(paced.status).toBe('skipped');
    expect(other.status).toBe('complete');
    expect(other.proposed_hires).toBe(1);
  });

  test('a held lease skips the caller instead of running a parallel analysis', async () => {
    seed(BIZ_A);
    db.prepare(`
      INSERT INTO hiring_coordination (business_id, lease_holder, lease_expires_at)
      VALUES (?, 'someone-else', datetime('now', '+60 seconds'))
      ON CONFLICT(business_id) DO UPDATE SET lease_holder = 'someone-else', lease_expires_at = datetime('now', '+60 seconds')
    `).run(BIZ_A);

    const result = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(result.status).toBe('skipped');
    expect(result.terminal_reason).toBe('lease_held');
    expect(reasonCalls).toBe(0);
  });

  test('an expired lease is reclaimed rather than blocking forever', async () => {
    seed(BIZ_A);
    db.prepare(`
      INSERT INTO hiring_coordination (business_id, lease_holder, lease_expires_at)
      VALUES (?, 'crashed', datetime('now', '-60 seconds'))
      ON CONFLICT(business_id) DO UPDATE SET lease_holder = 'crashed', lease_expires_at = datetime('now', '-60 seconds')
    `).run(BIZ_A);

    const result = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    expect(result.status).toBe('complete');
    expect(result.proposed_hires).toBe(1);
  });
});

describe('#52 provider failures are terminal, bounded and recoverable', () => {
  test('only 429/5xx are retried, and attempts are capped', async () => {
    let calls = 0;
    const outcome = await reasonAboutHires({
      businessName: 'X', businessType: 'ecommerce', connectors: [], candidates: [],
      priorDecisions: [], priorOutcomes: [], maxAttempts: 3,
      provider: 'stub', model: 'stub-model',
      sleep: async () => {},
      runLLMFn: (async () => { calls++; throw new ProviderHttpError('google', 429, true, 250); }) as never,
    });
    expect(calls).toBe(3);
    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(3);
    expect(outcome.provider_http_status).toBe(429);
    expect(outcome.provider_retryable).toBe(true);
  });

  test('a 400 is terminal on the first attempt — no retry burns quota', async () => {
    let calls = 0;
    const outcome = await reasonAboutHires({
      businessName: 'X', businessType: null, connectors: [], candidates: [],
      priorDecisions: [], priorOutcomes: [], maxAttempts: 3,
      provider: 'stub', model: 'stub-model',
      sleep: async () => {},
      runLLMFn: (async () => { calls++; throw new ProviderHttpError('google', 400, false); }) as never,
    });
    expect(calls).toBe(1);
    expect(outcome.provider_retryable).toBe(false);
    expect(outcome.provider_status).toBe('provider_non_retryable_http_400');
  });

  test('Retry-After is honoured but capped', async () => {
    const delays: number[] = [];
    await reasonAboutHires({
      businessName: 'X', businessType: null, connectors: [], candidates: [],
      priorDecisions: [], priorOutcomes: [], maxAttempts: 2,
      provider: 'stub', model: 'stub-model',
      sleep: async (ms) => { delays.push(ms); },
      runLLMFn: (async () => { throw new ProviderHttpError('google', 503, true, 999_999); }) as never,
    });
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeLessThanOrEqual(5_000);
  });

  test('a malformed response is not retried and is reported as unparseable', async () => {
    let calls = 0;
    const outcome = await reasonAboutHires({
      businessName: 'X', businessType: null, connectors: [], candidates: [],
      priorDecisions: [], priorOutcomes: [], maxAttempts: 3,
      provider: 'stub', model: 'stub-model',
      sleep: async () => {},
      runLLMFn: (async () => { calls++; return { content: 'not json at all', usage: null, cost_usd: 0 }; }) as never,
    });
    expect(calls).toBe(1);
    expect(outcome.raw_unparseable).toBe(true);
    expect(outcome.provider_status).toBe('unparseable_response');
  });

  test('persisted error text is sanitized — no keys, no raw provider body', async () => {
    seed(BIZ_A);
    // Uses the REAL reasoner so the sanitization under test is the production
    // path, with only the provider HTTP call faked.
    __setHiringDeps({
      loadTemplates: () => TEMPLATES as never,
      notify: async () => {},
      reason: (async () => reasonAboutHires({
        businessName: 'X', businessType: null, connectors: [], candidates: [],
        priorDecisions: [], priorOutcomes: [], maxAttempts: 1,
        provider: 'google', model: 'gemini-x',
        sleep: async () => {},
        runLLMFn: (async () => {
          throw new Error('Google API error 500: {"key":"AIzaSySUPERSECRETKEY","body":"raw provider body"} https://generativelanguage.googleapis.com/x');
        }) as never,
      })) as never,
    });

    const result = await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const run = listAnalysisRuns(BIZ_A)[0]!;
    expect(run.error).not.toContain('AIzaSySUPERSECRETKEY');
    expect(run.error).not.toContain('raw provider body');
    expect(run.error).not.toContain('generativelanguage');
    expect(result.degraded).toBe(true);
  });

  test('one business\'s provider failure does not block the others in a sweep', async () => {
    seed(BIZ_A); seed(BIZ_B);
    __setHiringDeps({
      loadTemplates: () => TEMPLATES as never,
      notify: async () => {},
      reason: (async (input: { businessName: string | null }) => {
        if (input.businessName?.includes('coord_a')) {
          return {
            status: 'failed' as const, recommendations: [], provider: 'google', model: 'm',
            attempts: 3, provider_status: 'provider_retryable_http_429', provider_http_status: 429,
            provider_retryable: true, error: 'provider google http_429 retryable',
            cost_usd: 0, usage: null, raw_unparseable: false,
          };
        }
        return (await okReason(['seo-sentinel'])());
      }) as never,
    });
    // Name the businesses so the stub can tell them apart.
    db.prepare('UPDATE businesses SET name = ? WHERE id = ?').run('coord_a biz', BIZ_A);
    db.prepare('UPDATE businesses SET name = ? WHERE id = ?').run('coord_b biz', BIZ_B);

    const results = await runScheduledHiringSweep([BIZ_A, BIZ_B]);
    expect(results).toHaveLength(2);
    const a = results.find((r) => r.business_id === BIZ_A)!;
    const b = results.find((r) => r.business_id === BIZ_B)!;
    expect(a.proposed).toBe(0);
    expect(a.terminal_reason).toBe('reasoning_unavailable');
    expect(b.proposed).toBe(1);
    expect(b.status).toBe('complete');
  });

  test('provider metadata is readable back off the analysis record', async () => {
    seed(BIZ_A);
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
    await analyseAndProposeHires(BIZ_A, { trigger: 'manual' });
    const run = listAnalysisRuns(BIZ_A)[0]!;
    expect(run.provider).toBe('google');
    expect(run.model).toBe('gemini-x');
    expect(run.provider_http_status).toBe(503);
    expect(run.provider_retryable).toBe(1);
    expect(run.provider_attempts).toBe(2);
    expect(run.status).toBe('partial');
    expect(run.terminal_reason).toBe('reasoning_unavailable');
    expect(run.completed_at).not.toBeNull();
  });

  test('stale `running` analyses are reconciled with an explicit terminal reason', () => {
    const staleId = startAnalysisRun({
      businessId: BIZ_A, triggerSource: 'scheduled', mode: 'live',
    });
    db.prepare("UPDATE hiring_analysis_runs SET started_at = datetime('now','-90 minutes') WHERE id = ?").run(staleId);
    const freshId = startAnalysisRun({ businessId: BIZ_A, triggerSource: 'manual', mode: 'live' });

    const closed = reconcileStaleAnalysisRuns(30, BIZ_A);
    expect(closed).toEqual([staleId]);

    const stale = db.prepare('SELECT status, terminal_reason, completed_at FROM hiring_analysis_runs WHERE id = ?').get(staleId) as any;
    expect(stale.status).toBe('failed');
    expect(stale.terminal_reason).toBe('stale_run_reconciled');
    expect(stale.completed_at).not.toBeNull();

    // The narrow predicate leaves the healthy in-flight run untouched.
    const fresh = db.prepare('SELECT status FROM hiring_analysis_runs WHERE id = ?').get(freshId) as any;
    expect(fresh.status).toBe('running');
  });

  test('stale reconciliation is business-scoped', () => {
    const a = startAnalysisRun({ businessId: BIZ_A, triggerSource: 'scheduled', mode: 'live' });
    const b = startAnalysisRun({ businessId: BIZ_B, triggerSource: 'scheduled', mode: 'live' });
    db.prepare("UPDATE hiring_analysis_runs SET started_at = datetime('now','-90 minutes') WHERE id IN (?, ?)").run(a, b);

    const closed = reconcileStaleAnalysisRuns(30, BIZ_A);
    expect(closed).toEqual([a]);
    const bRow = db.prepare('SELECT status FROM hiring_analysis_runs WHERE id = ?').get(b) as any;
    expect(bRow.status).toBe('running');
  });
});
