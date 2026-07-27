import { beforeEach, describe, expect, test } from 'bun:test';
import db from '../db/db.js';
import { calculateApprovalTier, calculateScorecard, createCorrection, evaluateApplicability, evaluateDueOutcomeMeasurements, evaluateSignalLifecycle, getProviderPreflight, recordProviderPreflight, requestRunCancellation, scheduleOutcomeMeasurements, upsertCapability, upsertRevenuePath, explainRevenueRelevance } from './trust-engine.js';

const BIZ = 'biz_phase4_test';

beforeEach(() => {
  for (const table of ['agent_scorecard_snapshots','agent_run_events','outcome_measurement_runs','correction_impacts','human_corrections','signal_lifecycle_events','applicability_suppressions','business_capabilities','revenue_paths','task_events','tasks','signals','metrics','connector_syncs','connectors','agent_runs','business_profiles','audit_log']) {
    try { db.prepare(`DELETE FROM ${table} WHERE business_id = ?`).run(BIZ); } catch {}
  }
  db.prepare("DELETE FROM businesses WHERE id = ?").run(BIZ);
  db.prepare("INSERT INTO businesses (id, name, slug, type) VALUES (?, 'Phase 4 Test', 'phase4-test', 'service')").run(BIZ);
});

describe('Phase 4 trust engine', () => {
  test('suppresses inapplicable Merchant Center work and records reason', () => {
    upsertCapability(BIZ, { capability_key: 'google_merchant_center', status: 'unavailable' }, 'test');
    const result = evaluateApplicability({ businessId: BIZ, candidateType: 'recommendation', candidateKey: 'merchant-work', title: 'Optimise Google Merchant Center feed' });
    expect(result.applicable).toBe(false);
    expect(result.status).toBe('not_applicable');
    const row = db.prepare("SELECT * FROM applicability_suppressions WHERE business_id = ? AND candidate_key = 'merchant-work'").get(BIZ) as any;
    expect(row.reason).toContain('google_merchant_center');
  });

  test('human correction updates capability and invalidates dependent signal/task', () => {
    upsertCapability(BIZ, { capability_key: 'etsy', status: 'available' }, 'test');
    db.prepare("INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, data, status) VALUES ('sig_etsy', ?, 'r', 'opportunity', 'info', 'Etsy optimisation', 'Improve Etsy shop', '{}', 'open')").run(BIZ);
    db.prepare("INSERT INTO tasks (id, business_id, title, proposed_by, action_type, action_payload, status) VALUES ('tsk_etsy', ?, 'Etsy listing work', 'agent', 'content_draft', '{}', 'proposed')").run(BIZ);
    const correction = createCorrection({ business_id: BIZ, assertion_key: 'etsy', affected_capability: 'etsy', corrected_value: 'There is no Etsy connector', explanation: 'Human confirmed no Etsy presence' }, 'test');
    expect((correction as any).impacts.length).toBeGreaterThanOrEqual(2);
    expect((db.prepare("SELECT status FROM business_capabilities WHERE business_id = ? AND capability_key = 'etsy'").get(BIZ) as any).status).toBe('unavailable');
    expect((db.prepare("SELECT lifecycle_status FROM signals WHERE id = 'sig_etsy'").get() as any).lifecycle_status).toBe('invalidated');
    expect((db.prepare("SELECT status FROM tasks WHERE id = 'tsk_etsy'").get() as any).status).toBe('cancelled');
  });

  test('signal lifecycle marks stale connector evidence stale', () => {
    db.prepare("INSERT INTO connectors (id, business_id, type, name, status, last_sync) VALUES ('conn_stale', ?, 'gsc', 'GSC', 'stale', datetime('now','-3 days'))").run(BIZ);
    db.prepare("INSERT INTO signals (id, business_id, connector_id, rule_id, type, severity, title, status) VALUES ('sig_stale', ?, 'conn_stale', 'drop', 'risk', 'warning', 'Ranking drop', 'open')").run(BIZ);
    const result = evaluateSignalLifecycle(BIZ);
    expect(result.changed).toBe(1);
    expect((db.prepare("SELECT lifecycle_status FROM signals WHERE id = 'sig_stale'").get() as any).lifecycle_status).toBe('stale');
  });

  test('risk tier escalates with scope and exposure', () => {
    expect(calculateApprovalTier({ actionType: 'report', baseTier: 'green' }).tier).toBe('green');
    expect(calculateApprovalTier({ actionType: 'github_pr', payload: { affected_records: 1 } }).tier).toBe('orange');
    expect(calculateApprovalTier({ actionType: 'shopify_product_update', payload: { affected_records: 5000, financial_exposure_gbp: 750 } }).tier).toBe('red');
  });

  test('revenue relevance explains primary path without fabricating value', () => {
    upsertRevenuePath(BIZ, { name: 'Shopify product sales', role: 'primary', business_model_type: 'ecommerce', sales_channel: 'shopify', primary_metric: 'shopify.conversion_rate' });
    const result = explainRevenueRelevance(BIZ, { title: 'Improve Shopify conversion', action_type: 'shopify_meta_update' });
    expect(result.path_id).toBeTruthy();
    expect(result.explanation).toContain('Shopify product sales');
  });

  test('measurement scheduler creates checkpoints once and missing baseline is blocked, not unsuccessful', () => {
    db.prepare("INSERT INTO tasks (id, business_id, title, proposed_by, action_type, action_payload, status) VALUES ('tsk_measure', ?, 'Measure me', 'agent', 'content_draft', '{}', 'complete')").run(BIZ);
    expect(scheduleOutcomeMeasurements('tsk_measure')).toBeGreaterThan(0);
    expect(scheduleOutcomeMeasurements('tsk_measure')).toBe(0);
    db.prepare("UPDATE outcome_measurement_runs SET checkpoint_at = datetime('now','-1 minute') WHERE task_id = 'tsk_measure'").run();
    evaluateDueOutcomeMeasurements();
    const row = db.prepare("SELECT state FROM outcome_measurement_runs WHERE task_id = 'tsk_measure' LIMIT 1").get() as any;
    expect(row.state).toBe('blocked_by_missing_data');
  });

  test('provider preflight cache and cancellation request preserve truthful states', () => {
    recordProviderPreflight('test-provider', 'missing-model', 'blocked', { model_exists: false });
    expect(getProviderPreflight('test-provider', 'missing-model')[0]!.status).toBe('blocked');
    db.prepare("INSERT INTO agents (id, profile_path, name, status) VALUES ('agent_cancel', 'x', 'Cancel', 'active') ON CONFLICT(id) DO NOTHING").run();
    db.prepare("INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at) VALUES ('run_cancel', 'agent_cancel', ?, 'test', 'running', CURRENT_TIMESTAMP)").run(BIZ);
    expect(requestRunCancellation('run_cancel', 'test').status).toBe('cancellation_requested');
    expect((db.prepare("SELECT status FROM agent_runs WHERE id = 'run_cancel'").get() as any).status).toBe('cancellation_requested');
  });

  test('scorecard reports small sample uncertainty', () => {
    db.prepare("INSERT INTO agents (id, profile_path, name, status) VALUES ('agent_score', 'x', 'Score', 'active') ON CONFLICT(id) DO NOTHING").run();
    db.prepare("INSERT INTO agent_runs (id, agent_id, business_id, trigger, status, started_at, cost_usd) VALUES ('run_score', 'agent_score', ?, 'test', 'complete', CURRENT_TIMESTAMP, 1.25)").run(BIZ);
    const scorecard = calculateScorecard('agent_score', BIZ) as any;
    expect(scorecard.metrics.runs_started).toBe(1);
    expect(scorecard.uncertainty.interval).toBe('wide');
  });
});
