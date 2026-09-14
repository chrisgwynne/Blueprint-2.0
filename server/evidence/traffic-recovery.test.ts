import { describe, expect, test } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { createTrafficRecoveryProposal } from './traffic-recovery.js';

const BUSINESS = 'traffic_recovery_test_business';

function seedSignal(type = 'traffic_anomaly'): string {
  db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(BUSINESS);
  db.prepare('DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(BUSINESS);
  db.prepare('DELETE FROM outcome_measurement_runs WHERE business_id = ?').run(BUSINESS);
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BUSINESS);
  db.prepare('DELETE FROM signals WHERE business_id = ?').run(BUSINESS);
  db.prepare('DELETE FROM business_profiles WHERE business_id = ?').run(BUSINESS);
  db.prepare(`INSERT INTO businesses (id, name, slug, type) VALUES (?, 'Traffic Recovery Test', 'traffic-recovery-test', 'ecommerce') ON CONFLICT(id) DO UPDATE SET type = 'ecommerce'`).run(BUSINESS);
  const signalId = generateId();
  db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, status, confidence, created_at) VALUES (?, ?, 'test_rule', ?, 'alert', 'Sessions fell on product pages', 'Traffic and conversion weakened this week.', 'open', 0.9, CURRENT_TIMESTAMP)`).run(signalId, BUSINESS, type);
  return signalId;
}

function cleanup(signalId: string): void {
  db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE signal_id = ?)').run(signalId);
  db.prepare('DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE signal_id = ?)').run(signalId);
  db.prepare('DELETE FROM outcome_measurement_runs WHERE task_id IN (SELECT id FROM tasks WHERE signal_id = ?)').run(signalId);
  db.prepare('DELETE FROM tasks WHERE signal_id = ?').run(signalId);
  db.prepare('DELETE FROM signals WHERE id = ?').run(signalId);
  db.prepare('DELETE FROM business_profiles WHERE business_id = ?').run(BUSINESS);
}

describe('traffic recovery golden path', () => {
  test('creates an approval-gated typed Shopify task and is idempotent', () => {
    const signalId = seedSignal();
    const input = { product_id: 'blueprint-product', proposed_description: 'A clearer product description with the key benefits up front.' };
    const first = createTrafficRecoveryProposal(BUSINESS, signalId, input);
    expect('task' in first).toBe(true);
    if (!('task' in first)) return;
    expect(first.idempotent).toBe(false);
    expect(first.task.action_type).toBe('shopify_description_update');
    expect(first.task.approval_mode).toBe('requires_approval');
    expect(first.task.action_payload).toMatchObject({ product_id: 'blueprint-product', proposed_description: input.proposed_description });
    expect((db.prepare('SELECT status FROM signals WHERE id = ?').get(signalId) as { status: string }).status).toBe('acknowledged');

    const second = createTrafficRecoveryProposal(BUSINESS, signalId, input);
    expect('task' in second && second.idempotent).toBe(true);
    cleanup(signalId);
  });

  test('rejects unrelated signals and non-ecommerce businesses', () => {
    const signalId = seedSignal('internal_note');
    db.prepare("UPDATE signals SET title = 'Internal note', description = 'Routine housekeeping.' WHERE id = ?").run(signalId);
    const unrelated = createTrafficRecoveryProposal(BUSINESS, signalId, { product_id: 'p1', proposed_description: 'Copy' });
    expect(unrelated).toMatchObject({ code: 'not_traffic_signal' });
    cleanup(signalId);

    const otherBusiness = 'traffic_recovery_service_business';
    db.prepare(`INSERT INTO businesses (id, name, slug, type) VALUES (?, 'Service', 'traffic-recovery-service', 'service')`).run(otherBusiness);
    const otherSignal = generateId();
    db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, status) VALUES (?, ?, 'r', 'traffic_anomaly', 'warning', 'Traffic drop', 'Sessions down', 'open')`).run(otherSignal, otherBusiness);
    expect(createTrafficRecoveryProposal(otherBusiness, otherSignal, { product_id: 'p1', proposed_description: 'Copy' })).toMatchObject({ code: 'business_type_not_supported' });
    db.prepare('DELETE FROM signals WHERE id = ?').run(otherSignal);
    db.prepare('DELETE FROM business_profiles WHERE business_id = ?').run(otherBusiness);
    db.prepare('DELETE FROM businesses WHERE id = ?').run(otherBusiness);
  });
});
