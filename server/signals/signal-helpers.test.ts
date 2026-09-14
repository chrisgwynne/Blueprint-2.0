import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { createSignalIfNotDuplicate } from './signal-helpers.js';
import { cancelTask, createTask } from '../tasks/task-queue.js';

const BIZ = 'biz_signal_invariant_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Signal Invariant Test', 'signal-invariant-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterEach(() => {
  db.prepare('DELETE FROM signal_suppressions WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(BIZ);
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM signals WHERE business_id = ?').run(BIZ);
});

describe('signal and task invariant gates', () => {
  test('deduplicates wording variants for one canonical condition', () => {
    const first = createSignalIfNotDuplicate({
      business_id: BIZ, rule_id: 'producer-a', type: 'risk', severity: 'warning',
      title: 'Checkout conversion fell 12%', data: { observed_at: '2026-09-14T10:00:00Z', value: 12 },
      canonical_key: 'shopify:checkout:conversion', condition_key: 'shopify:checkout:conversion:12',
      process_through_mesh: false,
    });
    const second = createSignalIfNotDuplicate({
      business_id: BIZ, rule_id: 'producer-b', type: 'risk', severity: 'warning',
      title: 'Conversion is down 12 percent', data: { timestamp: '2026-09-14T10:05:00Z', value: 12 },
      canonical_key: 'shopify:checkout:conversion', condition_key: 'shopify:checkout:conversion:12',
      process_through_mesh: false,
    });
    expect(first?.created).toBe(true);
    expect(second).toEqual({ id: first!.id, created: false });
    expect((db.prepare('SELECT COUNT(*) AS count FROM signals WHERE business_id = ?').get(BIZ) as any).count).toBe(1);
  });

  test('does not put informational observations into the active queue', () => {
    const result = createSignalIfNotDuplicate({ business_id: BIZ, rule_id: 'telemetry', severity: 'info', title: 'Sync observed', data: { count: 1 }, process_through_mesh: false });
    expect(result?.created).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS count FROM signals WHERE business_id = ? AND status = 'open'").get(BIZ) as any).count).toBe(0);
  });

  test('allows a new condition generation but never resurrects the same resolved condition', () => {
    const first = createSignalIfNotDuplicate({ business_id: BIZ, rule_id: 'monitor', severity: 'alert', title: 'Latency high', canonical_key: 'api:latency', condition_key: 'api:latency:500', process_through_mesh: false })!;
    db.prepare("UPDATE signals SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(first.id);
    const same = createSignalIfNotDuplicate({ business_id: BIZ, rule_id: 'monitor', severity: 'alert', title: 'Latency high again', canonical_key: 'api:latency', condition_key: 'api:latency:500', process_through_mesh: false });
    const changed = createSignalIfNotDuplicate({ business_id: BIZ, rule_id: 'monitor', severity: 'alert', title: 'Latency high again', canonical_key: 'api:latency', condition_key: 'api:latency:900', dedup_hours: 0, process_through_mesh: false })!;
    expect(same?.created).toBe(false);
    expect(changed.created).toBe(true);
    expect((db.prepare('SELECT canonical_generation FROM signals WHERE id = ?').get(changed.id) as any).canonical_generation).toBe(2);
  });

  test('cancelled canonical work blocks task regeneration', () => {
    const signalId = generateId();
    db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, data, status, confidence, canonical_fingerprint, condition_fingerprint) VALUES (?, ?, 'test', 'risk', 'warning', 'Test signal', '{}', 'open', 1, 'signal-key', 'condition-key')`).run(signalId, BIZ);
    const task = createTask({ business_id: BIZ, signal_id: signalId, title: 'Fix test condition', proposed_by: 'test', action_type: null, action_payload: {}, approval_mode: 'requires_approval', dedup_key: 'signal-key:fix' })!;
    cancelTask(task.id, 'test', 'no longer wanted');
    expect(() => createTask({ business_id: BIZ, signal_id: signalId, title: 'Fix test condition', proposed_by: 'test', action_type: null, action_payload: {}, approval_mode: 'requires_approval', dedup_key: 'signal-key:fix' })).toThrow(/Historical rejection\/cancellation/);
  });
});
