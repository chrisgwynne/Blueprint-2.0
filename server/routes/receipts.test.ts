/**
 * Dashboard receipt readback (issue #70) — server/routes/receipts.ts.
 *
 * Checks the two properties that matter at this boundary: an unauthenticated
 * caller gets nothing, and every response is scoped to the business in the
 * path (a receipt belonging to another business stays invisible even when
 * its own ID is supplied).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import receiptsRouter from './receipts.ts';
import { buildCorrelationKey, RECEIPT_SCHEMA_VERSION } from '../tasks/action-receipts.ts';

const BIZ_A = 'biz_receipts_route_a';
const BIZ_B = 'biz_receipts_route_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let receiptA = '';
let receiptB = '';
let taskA = '';

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, authed = true): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authed ? { 'X-Test-User': 'owner' } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(businessId: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, version, created_at, updated_at)
    VALUES (?, ?, 'Route fixture task', 'agent:test', 'complete', 'yellow', 'requires_approval', 'github_issue', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId);
  return id;
}

function insertReceipt(businessId: string, taskId: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO action_receipts (
      id, receipt_version, business_id, task_id, task_version, correlation_key,
      action_type, title, state, result_status, requested_at, authorized_at, authorized_by,
      executed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 2, ?, 'github_issue', 'Route fixture receipt', 'executed', 'success',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dashboard:owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, RECEIPT_SCHEMA_VERSION, businessId, taskId, buildCorrelationKey(taskId, 2));
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Receipts Route A', 'receipts-route-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Receipts Route B', 'receipts-route-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  taskA = insertTask(BIZ_A);
  receiptA = insertReceipt(BIZ_A, taskA);
  receiptB = insertReceipt(BIZ_B, insertTask(BIZ_B));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  // The dashboard's session-auth middleware reads req.session.userId; this
  // stands in for a logged-in browser session without a real login round-trip.
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) (req.session as unknown as Record<string, unknown>).userId = String(req.headers['x-test-user']);
    next();
  });
  app.use('/api/receipts', receiptsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
});

describe('GET /api/receipts/:businessId', () => {
  test('requires an authenticated session', async () => {
    const { status } = await get(`/api/receipts/${BIZ_A}`, false);
    expect(status).toBe(401);
  });

  test('returns only the requested business\'s receipts, with a state summary', async () => {
    const { status, body } = await get(`/api/receipts/${BIZ_A}`);
    expect(status).toBe(200);
    expect(body.receipt_schema_version).toBe(RECEIPT_SCHEMA_VERSION);
    expect(body.receipts.length).toBe(1);
    expect(body.receipts[0].id).toBe(receiptA);
    expect(body.summary.executed).toBe(1);
    expect(body.pagination.total).toBe(1);
  });

  test('another business\'s receipt is not readable through this business\'s path', async () => {
    const { status } = await get(`/api/receipts/${BIZ_A}/${receiptB}`);
    expect(status).toBe(404);
  });

  test('a receipt is readable by ID under its own business', async () => {
    const { status, body } = await get(`/api/receipts/${BIZ_A}/${receiptA}`);
    expect(status).toBe(200);
    expect(body.receipt.states.authorized.by).toBe('dashboard:owner');
    expect(body.receipt.states.verified.reached).toBe(false);
  });

  test('per-task lookup is scoped to the business in the path', async () => {
    const mine = await get(`/api/receipts/${BIZ_A}/task/${taskA}`);
    expect(mine.body.receipts.length).toBe(1);
    const theirs = await get(`/api/receipts/${BIZ_B}/task/${taskA}`);
    expect(theirs.body.receipts.length).toBe(0);
  });
});
