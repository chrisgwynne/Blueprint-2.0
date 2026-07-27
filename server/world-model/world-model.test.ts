import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  buildWorldModelSnapshot, writeWorldModelSnapshot, getCurrentWorldModel, getWorldModelHistory,
  getPreviousConnectorData,
} from './world-model.js';

const BIZ = 'biz_world_model_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'World Model Test', 'world-model-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM world_model_snapshots WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM signals WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM metrics WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM connectors WHERE business_id = ?`).run(BIZ);
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

describe('connector_data / getPreviousConnectorData', () => {
  const CONNECTOR_ID = 'conn_world_model_test';

  beforeAll(() => {
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
      VALUES (?, ?, 'ga4', 'GA4', '{}', 'connected', '{}', CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO NOTHING
    `).run(CONNECTOR_ID, BIZ);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM metrics WHERE connector_id = ?`).run(CONNECTOR_ID);
    db.prepare(`DELETE FROM connectors WHERE id = ?`).run(CONNECTOR_ID);
  });

  test('buildWorldModelSnapshot picks up the latest *_sync metrics blob per connector', () => {
    db.prepare(`
      INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_data, period_start, period_end, recorded_at)
      VALUES (?, ?, ?, 'ga4_sync', ?, '2026-01-01', '2026-01-01', CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ, CONNECTOR_ID, JSON.stringify({ sessions: 100 }));

    const snapshot = buildWorldModelSnapshot(BIZ);
    expect(snapshot.connector_data[CONNECTOR_ID]).toBeDefined();
    expect(snapshot.connector_data[CONNECTOR_ID]!.connector_type).toBe('ga4');
    expect(snapshot.connector_data[CONNECTOR_ID]!.data).toEqual({ sessions: 100 });
  });

  test('getPreviousConnectorData returns null when no snapshot has been written yet', () => {
    expect(getPreviousConnectorData(BIZ, CONNECTOR_ID)).toBeNull();
  });

  test('getPreviousConnectorData reflects the last *written* snapshot, not the live metrics table', () => {
    // Write a snapshot capturing the first sync's data.
    writeWorldModelSnapshot(BIZ, 'test-connector-data');
    expect(getPreviousConnectorData(BIZ, CONNECTOR_ID)).toEqual({ sessions: 100 });

    // A second sync writes newer metrics, but getPreviousConnectorData must
    // still report the OLD value until a new snapshot is written — this is
    // the "previous data" a signal rule compares against.
    db.prepare(`
      INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_data, period_start, period_end, recorded_at)
      VALUES (?, ?, ?, 'ga4_sync', ?, '2026-01-02', '2026-01-02', CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ, CONNECTOR_ID, JSON.stringify({ sessions: 250 }));
    expect(getPreviousConnectorData(BIZ, CONNECTOR_ID)).toEqual({ sessions: 100 });

    // Once the new snapshot is written (mirroring scheduler.ts / connectors.ts
    // calling writeWorldModelSnapshot after reading previousData), the World
    // Model's "previous" now reflects the second sync.
    writeWorldModelSnapshot(BIZ, 'test-connector-data-2');
    expect(getPreviousConnectorData(BIZ, CONNECTOR_ID)).toEqual({ sessions: 250 });
  });

  test('getPreviousConnectorData returns null for a connector with no recorded data', () => {
    expect(getPreviousConnectorData(BIZ, 'conn_never_synced_xyz')).toBeNull();
  });
});
