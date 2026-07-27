/**
 * Phase 2 Signal API tests — server/routes/bap.ts's new GET /signals/:id
 * (detail) and the expanded GET /businesses/:id/signals (search, filters,
 * pagination). Runs against a real Express instance mounting the actual
 * bap router.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from '../bap/auth.ts';
import bapRouter from './bap.ts';

const BIZ_A = 'biz_bap_signals_a';
const BIZ_B = 'biz_bap_signals_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertSignal(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO signals (id, business_id, connector_id, rule_id, type, severity, title, description, status, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, (overrides.business_id as string) ?? BIZ_A, (overrides.connector_id as string) ?? null,
    (overrides.rule_id as string) ?? 'test_rule', (overrides.type as string) ?? 'anomaly',
    (overrides.severity as string) ?? 'warning', (overrides.title as string) ?? 'Fixture signal',
    (overrides.description as string) ?? null, (overrides.status as string) ?? 'open',
    (overrides.confidence as number) ?? null,
  );
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Signals A', 'bap-signals-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Signals B', 'bap-signals-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_signals_a'`).run();
  keyA = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Signals Test Agent A', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_signals_a', await hashApiKey(keyA), keyPrefix(keyA), JSON.stringify(['signals:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM signal_clusters WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM signals WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id = 'agt_signals_a'`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_signals_a'`).run();
});

describe('GET /signals/:signalId (detail)', () => {
  test('returns evidence, attribution, related_tasks, connector_freshness, resolution_history', async () => {
    const connectorId = generateId();
    db.prepare(`INSERT INTO connectors (id, business_id, type, name, status, last_sync, created_at) VALUES (?, ?, 'gsc', 'GSC', 'connected', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(connectorId, BIZ_A);
    const signalId = insertSignal({ connector_id: connectorId, title: 'Ranking drop' });
    db.prepare(`UPDATE signals SET data = ?, attribution_primary_cause = ?, attribution_primary_confidence = ? WHERE id = ?`)
      .run(JSON.stringify({ position_before: 8, position_after: 14 }), 'algorithm update', 0.6, signalId);
    const taskId = generateId();
    db.prepare(`INSERT INTO tasks (id, business_id, signal_id, title, proposed_by, status, trust_tier, approval_mode, created_at, updated_at) VALUES (?, ?, ?, 'Fix ranking', 'test', 'proposed', 'yellow', 'requires_approval', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(taskId, BIZ_A, signalId);

    const { status, body } = await get(`/api/bap/v1/signals/${signalId}`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.signal.id).toBe(signalId);
    expect(body.evidence).toEqual({ position_before: 8, position_after: 14 });
    expect(body.attribution.primary_cause).toBe('algorithm update');
    expect(body.attribution.primary_confidence).toBe(0.6);
    expect(body.related_tasks.length).toBe(1);
    expect(body.related_tasks[0].id).toBe(taskId);
    expect(body.connector_freshness.id).toBe(connectorId);
    expect(Array.isArray(body.resolution_history)).toBe(true);
  });

  test('finds related signals via a signal_clusters row when one exists', async () => {
    const a = insertSignal({ title: 'Traffic drop' });
    const b = insertSignal({ title: 'Ranking drop (related)' });
    db.prepare(`
      INSERT INTO signal_clusters (id, business_id, title, summary, severity, confidence, signal_ids, created_at, updated_at)
      VALUES (?, ?, 'Cluster', 'summary', 'alert', 0.8, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ_A, JSON.stringify([a, b]));

    const { body } = await get(`/api/bap/v1/signals/${a}`, { 'BAP-Key': keyA });
    expect(body.related_signals.length).toBe(1);
    expect(body.related_signals[0].id).toBe(b);
    expect(body.related_signals[0].relation).toBe('cluster');
  });

  test('falls back to same connector+rule siblings when no cluster exists', async () => {
    const a = insertSignal({ title: 'Sibling A', rule_id: 'shared_rule' });
    const b = insertSignal({ title: 'Sibling B', rule_id: 'shared_rule' });
    insertSignal({ title: 'Different rule', rule_id: 'other_rule' });

    const { body } = await get(`/api/bap/v1/signals/${a}`, { 'BAP-Key': keyA });
    expect(body.related_signals.some((s: any) => s.id === b)).toBe(true);
    expect(body.related_signals.every((s: any) => s.relation === 'same_detector')).toBe(true);
  });

  test('resolution_history reflects a status change via audit_log', async () => {
    const signalId = insertSignal({ title: 'Will be resolved' });
    const { audit } = await import('../db/db.js') as unknown as { audit: (...args: any[]) => void };
    audit(BIZ_A, 'signal', signalId, 'status_change:open->resolved', 'test', { status: 'open' }, { status: 'resolved' });

    const { body } = await get(`/api/bap/v1/signals/${signalId}`, { 'BAP-Key': keyA });
    expect(body.resolution_history.length).toBe(1);
    expect(body.resolution_history[0].from_status).toBe('open');
    expect(body.resolution_history[0].to_status).toBe('resolved');
  });

  test('404 for a non-existent signal', async () => {
    const { status } = await get('/api/bap/v1/signals/does-not-exist', { 'BAP-Key': keyA });
    expect(status).toBe(404);
  });

  test('403 across tenants', async () => {
    const signalId = insertSignal({ business_id: BIZ_B, title: 'B signal' });
    const { status } = await get(`/api/bap/v1/signals/${signalId}`, { 'BAP-Key': keyA });
    expect(status).toBe(403);
  });
});

describe('GET /businesses/:id/signals — search, filters, pagination', () => {
  test('q searches title and description', async () => {
    insertSignal({ title: 'LCP regression on mobile' });
    insertSignal({ title: 'Unrelated signal' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/signals?q=LCP&status=all`, { 'BAP-Key': keyA });
    expect(body.signals.every((s: any) => /LCP/i.test(s.title))).toBe(true);
    expect(body.signals.length).toBeGreaterThanOrEqual(1);
  });

  test('type filter (csv)', async () => {
    insertSignal({ title: 'Opportunity sig', type: 'opportunity' });
    insertSignal({ title: 'Risk sig', type: 'risk' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/signals?type=opportunity&status=all`, { 'BAP-Key': keyA });
    expect(body.signals.every((s: any) => s.type === 'opportunity')).toBe(true);
  });

  test('default status=open is preserved for backward compatibility', async () => {
    insertSignal({ title: 'Open one', status: 'open' });
    insertSignal({ title: 'Resolved one', status: 'resolved' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/signals?q=one`, { 'BAP-Key': keyA });
    expect(body.signals.every((s: any) => s.status === 'open')).toBe(true);
  });

  test('pagination shape matches dashboard convention, signals/total kept for backward compat', async () => {
    for (let i = 0; i < 4; i++) insertSignal({ title: `Page sig ${i}` });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/signals?q=Page+sig&status=all&page=1&limit=2`, { 'BAP-Key': keyA });
    expect(body.signals.length).toBe(2);
    expect(body.pagination).toMatchObject({ page: 1, limit: 2, total: 4, pages: 2 });
    expect(body.total).toBe(4);
  });
});
