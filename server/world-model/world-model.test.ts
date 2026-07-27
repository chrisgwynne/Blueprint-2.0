import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { buildWorldModelSnapshot, writeWorldModelSnapshot, getCurrentWorldModel, getWorldModelHistory } from './world-model.js';

const BIZ = 'biz_world_model_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'World Model Test', 'world-model-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM world_model_snapshots WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM signals WHERE business_id = ?`).run(BIZ);
});

describe('buildWorldModelSnapshot', () => {
  test('returns a well-formed snapshot for a business with no data yet', () => {
    const snapshot = buildWorldModelSnapshot(BIZ);
    expect(snapshot.business_health.status).toBe('stable');
    expect(snapshot.operational_health.open_signals).toBe(0);
    expect(snapshot.connector_confidence.total).toBe(0);
    expect(Array.isArray(snapshot.goal_progress)).toBe(true);
  });

  test('a critical open signal marks business_health as declining', () => {
    db.prepare(`
      INSERT INTO signals (id, business_id, rule_id, type, severity, title, status, created_at)
      VALUES (?, ?, 'test_rule', 'revenue_drop', 'critical', 'Revenue crashed', 'open', CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ);

    const snapshot = buildWorldModelSnapshot(BIZ);
    expect(snapshot.business_health.status).toBe('declining');
    expect(snapshot.business_health.open_critical_signals).toBe(1);
    expect(snapshot.revenue_trend.open_signal_count).toBe(1);
  });
});

describe('writeWorldModelSnapshot / getCurrentWorldModel / getWorldModelHistory', () => {
  test('writes a timestamped snapshot retrievable as "current"', () => {
    writeWorldModelSnapshot(BIZ, 'test');
    const current = getCurrentWorldModel(BIZ);
    expect(current).not.toBeNull();
    expect(current!.business_id).toBe(BIZ);
    expect(current!.trigger_source).toBe('test');
  });

  test('history returns snapshots newest-first', () => {
    writeWorldModelSnapshot(BIZ, 'test-2');
    const history = getWorldModelHistory(BIZ, 5);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(new Date(history[0]!.created_at).getTime()).toBeGreaterThanOrEqual(new Date(history[1]!.created_at).getTime());
  });

  test('a business with no snapshots yet returns null for current', () => {
    expect(getCurrentWorldModel('biz_never_synced_xyz')).toBeNull();
  });
});
