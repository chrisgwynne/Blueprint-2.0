import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'connector-delete-test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '22'.repeat(32);

const { default: db } = await import('../db/db.js');
const { default: connectorsRouter } = await import('./connectors.js');

const TARGET_BUSINESS = 'biz_connector_delete_target';
const OTHER_BUSINESS = 'biz_connector_delete_other';
const TARGET_CONNECTOR = 'connector_delete_target';
const OTHER_CONNECTOR = 'connector_delete_other';
const TARGET_SIGNAL = 'signal_delete_target';
const USER = 'user_connector_delete';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    (req.session as any).userId = USER;
    next();
  });
  app.use('/api/connectors', connectorsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  db.prepare(`DELETE FROM audit_log WHERE business_id IN (?, ?)`).run(TARGET_BUSINESS, OTHER_BUSINESS);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(TARGET_BUSINESS, OTHER_BUSINESS);
  db.prepare(`DELETE FROM business_capabilities WHERE business_id IN (?, ?)`).run(TARGET_BUSINESS, OTHER_BUSINESS);
  db.prepare(`DELETE FROM connector_confidence WHERE business_id IN (?, ?)`).run(TARGET_BUSINESS, OTHER_BUSINESS);
  db.prepare(`DELETE FROM connector_syncs WHERE connector_id IN (?, ?)`).run(TARGET_CONNECTOR, OTHER_CONNECTOR);
  db.prepare(`DELETE FROM metrics WHERE business_id IN (?, ?)`).run(TARGET_BUSINESS, OTHER_BUSINESS);
  db.prepare(`DELETE FROM signals WHERE business_id IN (?, ?)`).run(TARGET_BUSINESS, OTHER_BUSINESS);
  db.prepare(`DELETE FROM connectors WHERE business_id IN (?, ?)`).run(TARGET_BUSINESS, OTHER_BUSINESS);
  db.prepare(`DELETE FROM businesses WHERE id IN (?, ?)`).run(TARGET_BUSINESS, OTHER_BUSINESS);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function seedConnectorGraph(): void {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Delete Target', 'connector-delete-target'), (?, 'Delete Other', 'connector-delete-other')`)
    .run(TARGET_BUSINESS, OTHER_BUSINESS);
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, credentials)
    VALUES (?, ?, 'ga4', 'Target GA4', 'error', '{}'), (?, ?, 'gsc', 'Other GSC', 'connected', '{}')
  `).run(TARGET_CONNECTOR, TARGET_BUSINESS, OTHER_CONNECTOR, OTHER_BUSINESS);

  db.prepare(`INSERT INTO connector_syncs (id, connector_id, status) VALUES ('sync-target', ?, 'failed'), ('sync-other', ?, 'complete')`)
    .run(TARGET_CONNECTOR, OTHER_CONNECTOR);
  db.prepare(`
    INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value)
    VALUES ('metric-target', ?, ?, 'sessions', 10), ('metric-other', ?, ?, 'clicks', 20)
  `).run(TARGET_BUSINESS, TARGET_CONNECTOR, OTHER_BUSINESS, OTHER_CONNECTOR);
  db.prepare(`
    INSERT INTO signals (id, business_id, connector_id, rule_id, type, severity, title)
    VALUES (?, ?, ?, 'ga4.stale', 'data_quality', 'warning', 'Stale GA4'),
           ('signal-delete-other', ?, ?, 'gsc.ok', 'performance', 'info', 'Other signal')
  `).run(TARGET_SIGNAL, TARGET_BUSINESS, TARGET_CONNECTOR, OTHER_BUSINESS, OTHER_CONNECTOR);
  db.prepare(`
    INSERT INTO tasks (id, business_id, signal_id, title, proposed_by)
    VALUES ('task-from-target-signal', ?, ?, 'Review stale analytics', 'conductor')
  `).run(TARGET_BUSINESS, TARGET_SIGNAL);
  db.prepare(`
    INSERT INTO connector_confidence (id, connector_id, business_id)
    VALUES ('confidence-target', ?, ?), ('confidence-other', ?, ?)
  `).run(TARGET_CONNECTOR, TARGET_BUSINESS, OTHER_CONNECTOR, OTHER_BUSINESS);
  db.prepare(`
    INSERT INTO business_capabilities (id, business_id, capability_key, connector_id)
    VALUES ('capability-target', ?, 'analytics.read', ?), ('capability-other', ?, 'search.read', ?)
  `).run(TARGET_BUSINESS, TARGET_CONNECTOR, OTHER_BUSINESS, OTHER_CONNECTOR);
}

describe('DELETE /api/connectors/:id', () => {
  test('locally deletes an authenticated connector graph without affecting unrelated business data', async () => {
    seedConnectorGraph();

    const response = await fetch(`${baseUrl}/api/connectors/${TARGET_CONNECTOR}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, localDeleted: true });

    expect(db.prepare('SELECT id FROM connectors WHERE id = ?').get(TARGET_CONNECTOR)).toBeNull();
    expect(db.prepare('SELECT id FROM connector_syncs WHERE connector_id = ?').get(TARGET_CONNECTOR)).toBeNull();
    expect(db.prepare('SELECT id FROM metrics WHERE connector_id = ?').get(TARGET_CONNECTOR)).toBeNull();
    expect(db.prepare('SELECT id FROM connector_confidence WHERE connector_id = ?').get(TARGET_CONNECTOR)).toBeNull();

    expect(db.prepare('SELECT connector_id FROM signals WHERE id = ?').get(TARGET_SIGNAL)).toEqual({ connector_id: null });
    expect(db.prepare("SELECT signal_id FROM tasks WHERE id = 'task-from-target-signal'").get()).toEqual({ signal_id: TARGET_SIGNAL });
    expect(db.prepare("SELECT connector_id FROM business_capabilities WHERE id = 'capability-target'").get()).toEqual({ connector_id: null });

    expect(db.prepare('SELECT id FROM connectors WHERE id = ?').get(OTHER_CONNECTOR)).toEqual({ id: OTHER_CONNECTOR });
    expect(db.prepare('SELECT id FROM connector_syncs WHERE connector_id = ?').get(OTHER_CONNECTOR)).toEqual({ id: 'sync-other' });
    expect(db.prepare('SELECT id FROM metrics WHERE connector_id = ?').get(OTHER_CONNECTOR)).toEqual({ id: 'metric-other' });
    expect(db.prepare('SELECT id FROM signals WHERE connector_id = ?').get(OTHER_CONNECTOR)).toEqual({ id: 'signal-delete-other' });
    expect(db.prepare('SELECT id FROM connector_confidence WHERE connector_id = ?').get(OTHER_CONNECTOR)).toEqual({ id: 'confidence-other' });
    expect(db.prepare("SELECT connector_id FROM business_capabilities WHERE id = 'capability-other'").get()).toEqual({ connector_id: OTHER_CONNECTOR });

    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare(`SELECT action, actor FROM audit_log WHERE entity_type = 'connector' AND entity_id = ?`).get(TARGET_CONNECTOR))
      .toEqual({ action: 'delete', actor: USER });
  });
});
