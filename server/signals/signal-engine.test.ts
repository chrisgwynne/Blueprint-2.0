/**
 * Regression coverage for issue #28: stale Core Web Vitals signals
 * remained open even after a completed investigation task verified the
 * current PageSpeed metrics were healthy again — nothing ever closed the
 * loop, so the dashboard kept showing an alert a human had to notice and
 * manually resolve. runSignalEngine() now auto-resolves a still-open
 * signal for the same rule/connector once the rule's own re-evaluation
 * against real data shows the underlying metric has recovered.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { runSignalEngine } from './signal-engine.js';

const BIZ = 'biz_signal_engine_test';
const CONNECTOR_ID = 'conn_signal_engine_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Signal Engine Test', 'signal-engine-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
    VALUES (?, ?, 'pagespeed', 'PageSpeed', '{}', 'connected', '{}', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `).run(CONNECTOR_ID, BIZ);
});

afterEach(() => {
  db.prepare(`DELETE FROM signals WHERE business_id = ?`).run(BIZ);
});

function openSignal(ruleId: string): { id: string; status: string } {
  return db.prepare(`
    SELECT id, status FROM signals
    WHERE business_id = ? AND connector_id = ? AND rule_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(BIZ, CONNECTOR_ID, ruleId) as { id: string; status: string };
}

describe('runSignalEngine — auto-resolve on healthy re-evaluation (issue #28)', () => {
  test('a failing LCP signal is auto-resolved once a later sync reports a healthy LCP', async () => {
    // First sync: poor mobile LCP — creates an open cwv_lcp_failing signal.
    await runSignalEngine(BIZ, CONNECTOR_ID, { cwv: { lcp: 9783 }, strategy: 'mobile' }, null, 'pagespeed');
    const created = openSignal('cwv_lcp_failing');
    expect(created).toBeTruthy();
    expect(created.status).toBe('open');

    // Second sync: LCP has recovered — the rule re-evaluates as healthy.
    await runSignalEngine(BIZ, CONNECTOR_ID, { cwv: { lcp: 1810 }, strategy: 'mobile' }, null, 'pagespeed');
    const after = db.prepare('SELECT status, resolved_at, description FROM signals WHERE id = ?').get(created.id) as any;

    expect(after.status).toBe('resolved');
    expect(after.resolved_at).not.toBeNull();
    expect(after.description).toMatch(/auto-resolved/i);
  });

  test('a sync with no usable data for the rule (desktop strategy) does not auto-resolve an open signal', async () => {
    await runSignalEngine(BIZ, CONNECTOR_ID, { cwv: { lcp: 9783 }, strategy: 'mobile' }, null, 'pagespeed');
    const created = openSignal('cwv_lcp_failing');
    expect(created.status).toBe('open');

    // Desktop strategy — cwv_lcp_failing's own early-out returns data: {}
    // ("can't evaluate this cycle"), not "evaluated and healthy".
    await runSignalEngine(BIZ, CONNECTOR_ID, { cwv: { lcp: 1200 }, strategy: 'desktop' }, null, 'pagespeed');
    const after = db.prepare('SELECT status FROM signals WHERE id = ?').get(created.id) as any;

    expect(after.status).toBe('open');
  });

  test('a signal already resolved by a human is not touched again', async () => {
    await runSignalEngine(BIZ, CONNECTOR_ID, { cwv: { lcp: 9783 }, strategy: 'mobile' }, null, 'pagespeed');
    const created = openSignal('cwv_lcp_failing');
    db.prepare(`UPDATE signals SET status = 'resolved', resolved_at = '2020-01-01' WHERE id = ?`).run(created.id);

    await runSignalEngine(BIZ, CONNECTOR_ID, { cwv: { lcp: 1200 }, strategy: 'mobile' }, null, 'pagespeed');
    const after = db.prepare('SELECT resolved_at FROM signals WHERE id = ?').get(created.id) as any;

    expect(after.resolved_at).toBe('2020-01-01'); // untouched, not re-stamped with CURRENT_TIMESTAMP
  });
});
