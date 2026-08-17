/**
 * Coverage for checkStaleConnectors()'s new "critically stale" system_issue
 * — reuses the exact 2x-stale-threshold escalation this same sweep already
 * computes for the connector_stale signal's severity, rather than a
 * separately invented threshold. Only crossing into critically-stale
 * raises a system_issue, and only once per crossing (a still-open issue
 * for the connector means this tick is a no-op).
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { checkStaleConnectors } from './scheduler.js';

const BIZ = 'biz_stale_connectors_test';

function cleanup() {
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM signals WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM connectors WHERE business_id = ?`).run(BIZ);
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Stale Connectors Test', 'stale-connectors-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

beforeEach(cleanup);
afterAll(cleanup);

// uptimerobot's stale threshold is 2h — the smallest in the table, so tests
// run fast without needing to fabricate multi-day-old timestamps.
function insertConnector(hoursAgo: number): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, last_sync)
    VALUES (?, ?, 'uptimerobot', 'Test Monitor', 'connected', datetime('now', '-' || ? || ' hours'))
  `).run(id, BIZ, hoursAgo);
  return id;
}

function openIssues() {
  return db.prepare(`SELECT * FROM system_issues WHERE business_id = ? AND issue_type = 'connector_critically_stale' AND status = 'open'`).all(BIZ) as Array<Record<string, unknown>>;
}

describe('checkStaleConnectors', () => {
  test('a fresh connector is untouched', async () => {
    const id = insertConnector(1);
    await checkStaleConnectors();
    const row = db.prepare('SELECT status FROM connectors WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('connected');
    expect(openIssues()).toHaveLength(0);
  });

  test('stale but not critically stale (>2h, <4h): signal warning, no system_issue', async () => {
    const id = insertConnector(3);
    await checkStaleConnectors();
    const row = db.prepare('SELECT status FROM connectors WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('stale');
    const signal = db.prepare(`SELECT severity FROM signals WHERE connector_id = ?`).get(id) as { severity: string };
    expect(signal.severity).toBe('warning');
    expect(openIssues()).toHaveLength(0);
  });

  test('critically stale (>4h, over 2x threshold): signal alert + one system_issue', async () => {
    const id = insertConnector(5);
    await checkStaleConnectors();
    const signal = db.prepare(`SELECT severity FROM signals WHERE connector_id = ?`).get(id) as { severity: string };
    expect(signal.severity).toBe('alert');

    const issues = openIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.related_connector_id).toBe(id);
  });

  test('does not raise a second system_issue on a repeated sweep', async () => {
    insertConnector(5);
    await checkStaleConnectors();
    expect(openIssues()).toHaveLength(1);

    await checkStaleConnectors();
    await checkStaleConnectors();
    expect(openIssues()).toHaveLength(1);
  });
});
