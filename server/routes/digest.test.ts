/**
 * Digest API (issue #62) — server/routes/digest.ts.
 *
 * Boundary properties: an unauthenticated caller gets nothing; a
 * business-scoped request never leaks another business's items; the
 * operator identity comes from the session and cannot be spoofed by the
 * request body (which would let a caller advance someone else's watermark
 * and make their unread items vanish); and the acknowledge → re-request →
 * override round trip behaves over HTTP the way it does in the engine.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import digestRouter from './digest.ts';
import { resetWatermark, getWatermark } from '../digest/digest-watermark.ts';

const BIZ_A = 'biz_digest_route_a';
const BIZ_B = 'biz_digest_route_b';
const OPERATOR = 'route-operator';

const T0 = '2026-03-01T00:00:00.000Z';
const T1 = '2026-03-02T00:00:00.000Z';
const UNTIL = '2026-03-10T00:00:00.000Z';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let taskA = '';
let taskB = '';

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, user: string | null = OPERATOR): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers: user ? { 'X-Test-User': user } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown, user: string | null = OPERATOR): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Test-User': user } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(businessId: string, title: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, 'agent:test', 'complete', 'yellow', 'requires_approval', ?, ?, ?)
  `).run(id, businessId, title, T1, T0, T0);
  return id;
}

/** Flatten every item in a digest response. */
function allItems(body: any): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (body?.businesses ?? []).flatMap((b: any) => Object.values(b.sections).flat()); // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Digest Route A', 'digest-route-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Digest Route B', 'digest-route-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  taskA = insertTask(BIZ_A, 'Route task A');
  taskB = insertTask(BIZ_B, 'Route task B');

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  // Stands in for a logged-in browser session; the digest router reads
  // req.session.userId exactly as isAuthenticated does.
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) {
      (req.session as unknown as Record<string, unknown>).userId = String(req.headers['x-test-user']);
    }
    next();
  });
  app.use('/api/digest', digestRouter);

  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const op of [OPERATOR, 'other-operator', 'owner']) {
    for (const scope of [BIZ_A, BIZ_B, '*']) resetWatermark(op, scope);
  }
  db.prepare('DELETE FROM tasks WHERE id IN (?, ?)').run(taskA, taskB);
  db.prepare('DELETE FROM businesses WHERE id IN (?, ?)').run(BIZ_A, BIZ_B);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetWatermark(OPERATOR, BIZ_A);
  resetWatermark(OPERATOR, '*');
});

describe('authentication', () => {
  test('an unauthenticated caller cannot read a digest', async () => {
    const res = await get(`/api/digest/${BIZ_A}`, null);
    expect(res.status).toBe(401);
  });

  test('an unauthenticated caller cannot acknowledge', async () => {
    const res = await post('/api/digest/acknowledge', { business_id: BIZ_A }, null);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/digest/:businessId', () => {
  test('returns a digest scoped to the requested business', async () => {
    const res = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe(BIZ_A);
    expect(res.body.digest_schema_version).toBe(1);

    const ids = allItems(res.body).map((i) => i.source.row_id);
    expect(ids).toContain(taskA);
    expect(ids).not.toContain(taskB);
  });

  test('reports the four sections and per-business status counts', async () => {
    const res = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`);
    const group = res.body.businesses[0];
    for (const section of ['verified_outcomes', 'pending_decisions', 'failures_and_stale_data', 'informational_activity']) {
      expect(group.sections[section]).toBeDefined();
      expect(group.status_counts[section]).toBeDefined();
      expect(res.body.totals[section]).toBeDefined();
    }
  });

  test('every returned item carries a source table, row id and link', async () => {
    const res = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`);
    const items = allItems(res.body);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source.table).toBeTruthy();
      expect(item.source.row_id).toBeTruthy();
      expect(String(item.source.href).startsWith('/')).toBe(true);
    }
  });

  test('a malformed since is rejected rather than silently defaulted', async () => {
    const res = await get(`/api/digest/${BIZ_A}?since=yesterday-ish`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('since');
  });

  test('an inverted window is rejected', async () => {
    const res = await get(`/api/digest/${BIZ_A}?since=${UNTIL}&until=${T0}`);
    expect(res.status).toBe(400);
  });

  test('the cross-business digest covers every business', async () => {
    const res = await get(`/api/digest?since=${T0}&until=${UNTIL}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('*');
    const ids = allItems(res.body).map((i) => i.source.row_id);
    expect(ids).toContain(taskA);
    expect(ids).toContain(taskB);
  });
});

describe('acknowledgement round trip', () => {
  test('acknowledging advances the watermark and stops the replay', async () => {
    const first = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`);
    expect(allItems(first.body).some((i) => i.source.row_id === taskA)).toBe(true);

    const ack = await post('/api/digest/acknowledge', {
      business_id: BIZ_A,
      acknowledged_through: first.body.window.end,
      digest_id: first.body.digest_id,
      items: first.body.acknowledgeable,
    });
    expect(ack.status).toBe(200);
    expect(ack.body.watermark.acknowledged_through).toBe(first.body.window.end);

    const second = await get(`/api/digest/${BIZ_A}?until=${UNTIL}`);
    expect(second.body.window.watermark_applied).toBe(true);
    expect(allItems(second.body).some((i) => i.source.row_id === taskA)).toBe(false);
  });

  test('acknowledging without an items map acknowledges what the server would show', async () => {
    const ack = await post('/api/digest/acknowledge', { business_id: BIZ_A });
    expect(ack.status).toBe(200);
    expect(ack.body.watermark).toBeTruthy();
    expect(getWatermark(OPERATOR, BIZ_A)).toBeTruthy();
  });

  test('the watermark survives a fresh request — it is durable server state', async () => {
    const first = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`);
    await post('/api/digest/acknowledge', {
      business_id: BIZ_A,
      acknowledged_through: first.body.window.end,
      items: first.body.acknowledgeable,
    });

    const readback = await get(`/api/digest/${BIZ_A}/watermark`);
    expect(readback.status).toBe(200);
    expect(readback.body.watermark.acknowledged_through).toBe(first.body.window.end);
  });

  test('an explicit since re-request overrides the watermark', async () => {
    const first = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`);
    await post('/api/digest/acknowledge', {
      business_id: BIZ_A,
      acknowledged_through: first.body.window.end,
      items: first.body.acknowledgeable,
    });

    // Watermarked: hidden.
    const watermarked = await get(`/api/digest/${BIZ_A}?until=${UNTIL}`);
    expect(allItems(watermarked.body).some((i) => i.source.row_id === taskA)).toBe(false);

    // Explicitly asked for: shown again.
    const rerequested = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`);
    expect(rerequested.body.window.watermark_applied).toBe(false);
    expect(rerequested.body.window.source).toBe('explicit_since');
    expect(allItems(rerequested.body).some((i) => i.source.row_id === taskA)).toBe(true);

    // ...and the override did not destroy the watermark.
    expect(getWatermark(OPERATOR, BIZ_A)).toBeTruthy();
  });

  test('reset clears the watermark', async () => {
    await post('/api/digest/acknowledge', { business_id: BIZ_A });
    expect(getWatermark(OPERATOR, BIZ_A)).toBeTruthy();

    const res = await post('/api/digest/reset', { business_id: BIZ_A });
    expect(res.status).toBe(200);
    expect(getWatermark(OPERATOR, BIZ_A)).toBeNull();
  });
});

describe('operator isolation', () => {
  test('the operator comes from the session, not the request body', async () => {
    // A caller naming someone else's operator_key must not be able to
    // advance THEIR watermark and make their unread items disappear.
    await post('/api/digest/acknowledge', {
      business_id: BIZ_A,
      operator_key: 'other-operator',
      acknowledged_through: UNTIL,
      items: { 'task_activity:x': 'fp' },
    }, OPERATOR);

    expect(getWatermark(OPERATOR, BIZ_A)).toBeTruthy();
    expect(getWatermark('other-operator', BIZ_A)).toBeNull();
  });

  test("one operator's acknowledgement does not suppress another's digest", async () => {
    const first = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`, OPERATOR);
    await post('/api/digest/acknowledge', {
      business_id: BIZ_A,
      acknowledged_through: first.body.window.end,
      items: first.body.acknowledgeable,
    }, OPERATOR);

    const other = await get(`/api/digest/${BIZ_A}?since=${T0}&until=${UNTIL}`, 'other-operator');
    expect(allItems(other.body).some((i) => i.source.row_id === taskA)).toBe(true);

    resetWatermark('other-operator', BIZ_A);
  });
});
