/**
 * Permission-scoped receipt readback (issue #70) — server/routes/bap-receipts.ts,
 * exercised against a real Express instance mounting the actual router.
 *
 * The load-bearing property here is negative: an agent scoped to business B
 * must not be able to read business A's receipts, whether it asks by
 * business, by task, or by receipt ID. Redaction is re-checked at the HTTP
 * boundary too, because a row written before a redaction rule existed must
 * still not leak through the API.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapReceiptsRouter from './bap-receipts.ts';
import { buildCorrelationKey, RECEIPT_SCHEMA_VERSION } from '../tasks/action-receipts.ts';

const BIZ_A = 'biz_bap_receipts_a';
const BIZ_B = 'biz_bap_receipts_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string;   // scoped to BIZ_A, holds receipts:read
let keyB: string;   // scoped to BIZ_B, holds receipts:read
let keyNoGrant: string; // scoped to BIZ_A, but without receipts:read

let receiptA = '';
let taskA = '';

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(businessId: string, title: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, version, created_at, updated_at)
    VALUES (?, ?, ?, 'agent:test', 'complete', 'yellow', 'requires_approval', 'github_issue', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId, title);
  return id;
}

function insertReceipt(businessId: string, taskId: string, overrides: Record<string, unknown> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO action_receipts (
      id, receipt_version, business_id, task_id, task_version, correlation_key,
      action_type, title, state, result_status, result_summary,
      requested_at, requested_by, authorized_at, authorized_by, executed_at,
      externally_acknowledged_at, external_system, external_id, external_permalink,
      external_reference, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 2, ?, 'github_issue', ?, 'externally_acknowledged', 'success', ?,
      CURRENT_TIMESTAMP, 'agent:test', CURRENT_TIMESTAMP, 'dashboard:owner', CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, 'github', '412', 'https://github.com/acme/widgets/issues/412', ?, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, RECEIPT_SCHEMA_VERSION, businessId, taskId, buildCorrelationKey(taskId, 2),
    (overrides.title as string) ?? 'Receipt fixture',
    (overrides.result_summary as string) ?? 'GitHub issue #412 created in acme/widgets',
    JSON.stringify((overrides.external_reference as Record<string, unknown>) ?? { issue_number: 412 }),
  );
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Receipts A', 'bap-receipts-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Receipts B', 'bap-receipts-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  for (const id of ['agt_rcpt_a', 'agt_rcpt_b', 'agt_rcpt_nogrant']) {
    db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);
  }
  keyA = generateApiKey();
  keyB = generateApiKey();
  keyNoGrant = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_rcpt_a', 'Receipts Agent A', await hashApiKey(keyA), keyPrefix(keyA), JSON.stringify(['receipts:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_rcpt_b', 'Receipts Agent B', await hashApiKey(keyB), keyPrefix(keyB), JSON.stringify(['receipts:read']), JSON.stringify([BIZ_B]));
  insertAgent.run('agt_rcpt_nogrant', 'No Grant Agent', await hashApiKey(keyNoGrant), keyPrefix(keyNoGrant), JSON.stringify(['tasks:read']), JSON.stringify([BIZ_A]));

  taskA = insertTask(BIZ_A, 'Business A action');
  receiptA = insertReceipt(BIZ_A, taskA, {
    // A row deliberately written with credential-shaped content, standing in
    // for one persisted before a redaction rule existed.
    external_reference: {
      issue_number: 412,
      access_token: 'ghp_legacyleakedtokenvalue123456',
      note: 'Authorization: Bearer legacyheadersecretvalue',
    },
  });
  const taskB = insertTask(BIZ_B, 'Business B action');
  insertReceipt(BIZ_B, taskB, { title: 'B receipt' });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapReceiptsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_rcpt_a', 'agt_rcpt_b', 'agt_rcpt_nogrant')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_rcpt_a', 'agt_rcpt_b', 'agt_rcpt_nogrant')`).run();
});

describe('receipts:read grant', () => {
  test('is offered as a read-only grant, with no write counterpart', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('receipts:read');
    expect(GRANTABLE_BAP_PERMISSIONS.some((p) => p.startsWith('receipts:') && p !== 'receipts:read')).toBe(false);
  });

  test('an agent without the grant cannot read receipts for a business it otherwise has access to', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/receipts`, { 'BAP-Key': keyNoGrant });
    expect(status).toBe(403);
  });

  test('an unauthenticated request is rejected outright', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/receipts`);
    expect(status).toBe(401);
  });
});

describe('GET /businesses/:id/receipts — permission-scoped listing', () => {
  test('returns the business\'s receipts with the five states kept separate', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/receipts`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.receipt_schema_version).toBe(RECEIPT_SCHEMA_VERSION);
    expect(body.receipts.length).toBe(1);

    const receipt = body.receipts[0];
    expect(receipt.id).toBe(receiptA);
    expect(receipt.states.requested.reached).toBe(true);
    expect(receipt.states.authorized.reached).toBe(true);
    expect(receipt.states.authorized.by).toBe('dashboard:owner');
    expect(receipt.states.executed.reached).toBe(true);
    expect(receipt.states.externally_acknowledged.reached).toBe(true);
    expect(receipt.states.externally_acknowledged.external_id).toBe('412');
    expect(receipt.states.externally_acknowledged.permalink).toBe('https://github.com/acme/widgets/issues/412');
    // Acknowledged is not verified — the distinction survives readback.
    expect(receipt.states.verified.reached).toBe(false);
    expect(body.summary.externally_acknowledged).toBe(1);
  });

  test('an agent scoped to business B cannot list business A\'s receipts', async () => {
    // Denied by requirePermission itself, which resolves :businessId from
    // the path and checks it against the agent's business_access.
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/receipts`, { 'BAP-Key': keyB });
    expect(status).toBe(403);
    expect(body.error).toMatch(/Permission denied/);
    expect(body.receipts).toBeUndefined();
  });

  test('filters by state', async () => {
    const match = await get(`/api/bap/v1/businesses/${BIZ_A}/receipts?state=externally_acknowledged`, { 'BAP-Key': keyA });
    expect(match.body.receipts.length).toBe(1);
    const none = await get(`/api/bap/v1/businesses/${BIZ_A}/receipts?state=verified`, { 'BAP-Key': keyA });
    expect(none.body.receipts.length).toBe(0);
  });
});

describe('ID-addressed reads re-check the row\'s own business', () => {
  test('an agent scoped to business B cannot read business A\'s receipt by ID', async () => {
    const { status, body } = await get(`/api/bap/v1/receipts/${receiptA}`, { 'BAP-Key': keyB });
    expect(status).toBe(403);
    expect(body.code).toBe('permission_denied');
  });

  test('an agent scoped to business B cannot read business A\'s receipts by task ID', async () => {
    const { status } = await get(`/api/bap/v1/tasks/${taskA}/receipts`, { 'BAP-Key': keyB });
    expect(status).toBe(403);
  });

  test('the authorized agent can read the same receipt by ID and by task', async () => {
    const byId = await get(`/api/bap/v1/receipts/${receiptA}`, { 'BAP-Key': keyA });
    expect(byId.status).toBe(200);
    expect(byId.body.receipt.id).toBe(receiptA);

    const byTask = await get(`/api/bap/v1/tasks/${taskA}/receipts`, { 'BAP-Key': keyA });
    expect(byTask.status).toBe(200);
    expect(byTask.body.receipts[0].id).toBe(receiptA);
  });

  test('an unknown receipt is a 404, not a leak of existence', async () => {
    const { status } = await get('/api/bap/v1/receipts/does-not-exist', { 'BAP-Key': keyA });
    expect(status).toBe(404);
  });
});

describe('redaction at the readback boundary', () => {
  test('credential-shaped content stored on a receipt never reaches the API response', async () => {
    const { body } = await get(`/api/bap/v1/receipts/${receiptA}`, { 'BAP-Key': keyA });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('ghp_legacyleakedtokenvalue123456');
    expect(serialized).not.toContain('legacyheadersecretvalue');
    expect(body.receipt.external_reference.access_token).toBe('[redacted]');
    // The useful part of the reference is still there.
    expect(body.receipt.external_reference.issue_number).toBe(412);
  });
});
