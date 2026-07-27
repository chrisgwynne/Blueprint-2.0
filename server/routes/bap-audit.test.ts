/**
 * Phase 2 Audit API tests — server/routes/bap-audit.ts. Runs against a
 * real Express instance mounting the actual router.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId, audit } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapAuditRouter from './bap-audit.ts';

const BIZ_A = 'biz_bap_audit_a';
const BIZ_B = 'biz_bap_audit_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Audit A', 'bap-audit-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Audit B', 'bap-audit-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_audit_read'`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Audit Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_audit_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['audit:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapAuditRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM audit_log WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id = 'agt_audit_read'`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id = 'agt_audit_read'`).run();
});

describe('GET /businesses/:id/audit', () => {
  test('returns entries scoped to whitelisted entity_types, with pagination', async () => {
    audit(BIZ_A, 'task', 'tsk_1', 'create', 'test', null, { title: 'x' });
    audit(BIZ_A, 'connector', 'conn_1', 'update', 'test', { status: 'disconnected' }, { status: 'connected' });

    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/audit`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
    expect(body.pagination).toHaveProperty('total');
  });

  test('rejects an entity_type outside the whitelist', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/audit?entity_type=not_a_real_type`, { 'BAP-Key': keyRead });
    expect(status).toBe(400);
    expect(body.code).toBe('validation_error');
  });

  test('filters by entity_type, entity_id, and action', async () => {
    const taskId = generateId();
    audit(BIZ_A, 'task', taskId, 'approve', 'bap:agt_x', { status: 'proposed' }, { status: 'approved' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/audit?entity_type=task&entity_id=${taskId}&action=approve`, { 'BAP-Key': keyRead });
    expect(body.entries.length).toBe(1);
    expect(body.entries[0].entity_id).toBe(taskId);
    expect(body.entries[0].action).toBe('approve');
  });

  test('redacts credential-shaped keys in metadata/before_state/after_state', async () => {
    audit(BIZ_A, 'connector', 'conn_2', 'create', 'test', null, {
      type: 'shopify', credentials: { api_key: 'sk-should-not-leak', shared_secret: 'also-secret' }, safeField: 'visible',
    }, { note: 'has token: abc123', apiKey: 'zzz' });

    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/audit?entity_type=connector`, { 'BAP-Key': keyRead });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('sk-should-not-leak');
    expect(raw).not.toContain('also-secret');
    expect(raw).not.toContain('zzz');
    const entry = body.entries.find((e: any) => e.entity_id === 'conn_2');
    expect(entry.after_state.safeField).toBe('visible');
    // The whole `credentials` object is replaced (key itself matches the
    // pattern), not selectively redacted inside — the more conservative
    // of the two behaviours, and the one actually implemented.
    expect(entry.after_state.credentials).toBe('[redacted]');
    expect(entry.metadata.apiKey).toBe('[redacted]');
  });

  test('audit_log rows with business_id IS NULL are never returned (stricter than the dashboard reader)', async () => {
    db.prepare(`INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, created_at) VALUES (?, NULL, 'agent', 'global_agent', 'retire', 'test', CURRENT_TIMESTAMP)`).run(generateId());
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/audit?entity_type=agent`, { 'BAP-Key': keyRead });
    expect(body.entries.every((e: any) => e.entity_id !== 'global_agent')).toBe(true);
  });

  test('does not return another business\'s audit entries', async () => {
    audit(BIZ_B, 'task', 'tsk_b', 'create', 'test', null, { title: 'b-only' });
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/audit?entity_type=task`, { 'BAP-Key': keyRead });
    expect(body.entries.every((e: any) => e.entity_id !== 'tsk_b')).toBe(true);
  });

  test('403 without audit:read on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/audit`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});
