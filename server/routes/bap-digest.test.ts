/**
 * BAP "while you were away" digest (issue #81) — server/routes/bap-digest.ts,
 * exercised against a real Express instance mounting the actual router
 * behind the real bapAuth/rate-limit chain.
 *
 * Five properties carry the weight here:
 *
 *   1. GRANT      `digest:read` gates every route; missing it is a 403.
 *   2. SCOPE      an out-of-grant business id is refused before the digest
 *                 is ever built, matching every other business-scoped BAP
 *                 route (decision-queue, receipts, ...).
 *   3. OVERRIDE   `?since=` reads a different window than the stored
 *                 watermark without mutating it.
 *   4. NO SIDE EFFECT ON READ  a bare GET never advances the watermark, no
 *                 matter how many times it's called.
 *   5. SEPARATE DIMENSION  acknowledging via BAP writes to a table keyed on
 *                 the agent's id, never the dashboard operator's
 *                 (digest_watermarks) — the two never collide.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapDigestRouter from './bap-digest.ts';
import { getWatermark as getDashboardWatermark, advanceWatermark as advanceDashboardWatermark, resetWatermark as resetDashboardWatermark } from '../digest/digest-watermark.ts';
import { getBapWatermark, resetBapWatermark } from '../digest/bap-digest-watermark.ts';

const BIZ_A = 'biz_bap_digest_a';
const BIZ_B = 'biz_bap_digest_b';
const AGENT_IDS = ['agt_digest_a', 'agt_digest_b', 'agt_digest_nogrant'];
const DASHBOARD_OPERATOR = 'dashboard-owner-testfixture';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string;       // scoped to BIZ_A, holds digest:read
let keyB: string;       // scoped to BIZ_B, holds digest:read
let keyNoGrant: string; // scoped to BIZ_A, holds tasks:read only

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, key: string): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'BAP-Key': key } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, key: string, body: unknown = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'BAP-Key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(businessId: string, title: string, completedAt: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (
      id, business_id, title, proposed_by, status, trust_tier, approval_mode,
      action_type, target_metric, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'agent:test', 'complete', 'yellow', 'requires_approval', NULL, NULL, ?, ?, ?)
  `).run(id, businessId, title, completedAt, completedAt, completedAt);
  return id;
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Digest A', 'bap-digest-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Digest B', 'bap-digest-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  for (const id of AGENT_IDS) db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);
  keyA = generateApiKey();
  keyB = generateApiKey();
  keyNoGrant = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_digest_a', 'Digest Agent A', await hashApiKey(keyA), keyPrefix(keyA), JSON.stringify(['digest:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_digest_b', 'Digest Agent B', await hashApiKey(keyB), keyPrefix(keyB), JSON.stringify(['digest:read']), JSON.stringify([BIZ_B]));
  insertAgent.run('agt_digest_nogrant', 'No Grant Agent', await hashApiKey(keyNoGrant), keyPrefix(keyNoGrant), JSON.stringify(['tasks:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapDigestRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  resetBapWatermark('agt_digest_a', BIZ_A);
  resetBapWatermark('agt_digest_b', BIZ_B);
  resetDashboardWatermark(DASHBOARD_OPERATOR, BIZ_A);
  db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (?, ?))').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  const placeholders = AGENT_IDS.map(() => '?').join(', ');
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN (${placeholders})`).run(...AGENT_IDS);
  db.prepare(`DELETE FROM bap_agents WHERE id IN (${placeholders})`).run(...AGENT_IDS);
  db.prepare('DELETE FROM businesses WHERE id IN (?, ?)').run(BIZ_A, BIZ_B);
});

beforeEach(() => {
  resetBapWatermark('agt_digest_a', BIZ_A);
});

// ─── The grant ───────────────────────────────────────────────────────────────

describe('digest:read grant', () => {
  test('is offered as a read-only-plus-watermark grant', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('digest:read');
  });

  test('an agent without the grant cannot read the digest for a business it otherwise has access to', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/digest`, keyNoGrant);
    expect(status).toBe(403);
    expect(body.error).toMatch(/digest:read/);
  });

  test('an agent without the grant cannot acknowledge either', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/digest/acknowledge`, keyNoGrant);
    expect(status).toBe(403);
  });

  test('an unauthenticated request is rejected outright', async () => {
    expect((await get(`/api/bap/v1/businesses/${BIZ_A}/digest`, '')).status).toBe(401);
  });
});

// ─── Business-access-grant denial ────────────────────────────────────────────

describe('business scoping', () => {
  test('an agent scoped to business A cannot read business B\'s digest', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_B}/digest`, keyA);
    expect(status).toBe(403);
    expect(body.businesses).toBeUndefined();
  });

  test('an agent scoped to business A cannot acknowledge business B\'s digest', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_B}/digest/acknowledge`, keyA);
    expect(status).toBe(403);
  });

  test('an unknown business is denied before existence is ever checked', async () => {
    // 403, not 404: requirePermission resolves :businessId from the path and
    // finds it absent from the agent's business_access grant, so the request
    // never reaches the existence check — a 404 here would let an agent
    // probe which business IDs are real.
    const { status } = await get('/api/bap/v1/businesses/biz_does_not_exist/digest', keyA);
    expect(status).toBe(403);
  });
});

// ─── Successful fetch ─────────────────────────────────────────────────────────

describe('GET /businesses/:id/digest', () => {
  test('returns the four-section digest scoped to the named business', async () => {
    const T1 = '2026-01-11T00:00:00.000Z';
    insertTask(BIZ_A, 'Digest fixture task', T1);

    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/digest?since=2026-01-01T00:00:00.000Z`, keyA);
    expect(status).toBe(200);
    expect(body.scope).toBe(BIZ_A);
    expect(body.businesses.every((b: any) => b.business_id === BIZ_A)).toBe(true);
    expect(body.totals).toBeDefined();
    expect(body.window.source).toBe('explicit_since');
    expect(Array.isArray(body.businesses)).toBe(true);

    const item = body.businesses
      .flatMap((b: any) => b.sections.informational_activity)
      .find((i: any) => i.source.row_id && db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(i.source.row_id));
    expect(item).toBeTruthy();
  });

  test('an invalid since is rejected with a validation error', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/digest?since=not-a-date`, keyA);
    expect(status).toBe(400);
    expect(body.code).toBe('validation_error');
  });
});

// ─── Explicit ?since= override ────────────────────────────────────────────────

describe('?since= override', () => {
  test('overrides the stored watermark for one read without mutating it', async () => {
    const T0 = '2026-01-05T00:00:00.000Z';
    const T1 = '2026-01-11T00:00:00.000Z';
    const WINDOW_END = '2026-01-20T00:00:00.000Z';
    insertTask(BIZ_A, 'Pre-watermark activity', T1);

    // Acknowledge everything through T1's day, advancing the BAP watermark.
    await post(`/api/bap/v1/businesses/${BIZ_A}/digest/acknowledge`, keyA, { acknowledged_through: WINDOW_END });
    const watermarkAfterAck = getBapWatermark('agt_digest_a', BIZ_A);
    expect(watermarkAfterAck).toBeTruthy();

    // A plain GET now reports the watermark as the window source and shows
    // nothing new (everything was just acknowledged).
    const plain = await get(`/api/bap/v1/businesses/${BIZ_A}/digest`, keyA);
    expect(plain.body.window.source).toBe('watermark');
    expect(plain.body.window.watermark_applied).toBe(true);

    // An explicit ?since= re-reads the earlier period, ignoring the watermark
    // for both the window floor and suppression.
    const overridden = await get(`/api/bap/v1/businesses/${BIZ_A}/digest?since=${encodeURIComponent(T0)}&until=${encodeURIComponent(WINDOW_END)}`, keyA);
    expect(overridden.body.window.source).toBe('explicit_since');
    expect(overridden.body.window.watermark_applied).toBe(false);

    // The stored watermark itself is untouched by the override read.
    const watermarkAfterOverride = getBapWatermark('agt_digest_a', BIZ_A);
    expect(watermarkAfterOverride!.acknowledged_through).toBe(watermarkAfterAck!.acknowledged_through);
  });
});

// ─── Watermark advances vs. does not advance ─────────────────────────────────

describe('watermark advance behavior', () => {
  test('a bare GET never advances the watermark, however many times it is called', async () => {
    expect(getBapWatermark('agt_digest_a', BIZ_A)).toBeNull();
    await get(`/api/bap/v1/businesses/${BIZ_A}/digest`, keyA);
    await get(`/api/bap/v1/businesses/${BIZ_A}/digest`, keyA);
    await get(`/api/bap/v1/businesses/${BIZ_A}/digest`, keyA);
    expect(getBapWatermark('agt_digest_a', BIZ_A)).toBeNull();
  });

  test('POST /digest/acknowledge advances this agent\'s watermark', async () => {
    expect(getBapWatermark('agt_digest_a', BIZ_A)).toBeNull();
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/digest/acknowledge`, keyA);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.watermark.agent_id).toBe('agt_digest_a');
    expect(body.watermark.business_id).toBe(BIZ_A);
    expect(getBapWatermark('agt_digest_a', BIZ_A)).toBeTruthy();
  });

  test('acknowledging without a body rebuilds and acknowledges exactly what the current digest shows', async () => {
    const T1 = '2026-02-01T00:00:00.000Z';
    insertTask(BIZ_A, 'Ack fixture', T1);

    const before = await get(`/api/bap/v1/businesses/${BIZ_A}/digest`, keyA);
    const dedupKeys = Object.keys(before.body.acknowledgeable);

    await post(`/api/bap/v1/businesses/${BIZ_A}/digest/acknowledge`, keyA);
    const watermark = getBapWatermark('agt_digest_a', BIZ_A)!;
    for (const key of dedupKeys) expect(watermark.acknowledged_items[key]).toBeDefined();
  });

  test('GET /digest/watermark reads the current point with no side effect', async () => {
    const empty = await get(`/api/bap/v1/businesses/${BIZ_A}/digest/watermark`, keyA);
    expect(empty.status).toBe(200);
    expect(empty.body.watermark).toBeNull();

    await post(`/api/bap/v1/businesses/${BIZ_A}/digest/acknowledge`, keyA);
    const after = await get(`/api/bap/v1/businesses/${BIZ_A}/digest/watermark`, keyA);
    expect(after.body.watermark).toBeTruthy();
    expect(after.body.watermark.agent_id).toBe('agt_digest_a');

    // Reading the watermark endpoint itself never changes it.
    const again = await get(`/api/bap/v1/businesses/${BIZ_A}/digest/watermark`, keyA);
    expect(again.body.watermark.acknowledged_through).toBe(after.body.watermark.acknowledged_through);
  });
});

// ─── Separate dimension from the dashboard operator's watermark ─────────────

describe('the BAP watermark is a genuinely separate dimension', () => {
  test('acknowledging via BAP does not create or move a dashboard_watermarks row', async () => {
    expect(getDashboardWatermark(DASHBOARD_OPERATOR, BIZ_A)).toBeNull();
    await post(`/api/bap/v1/businesses/${BIZ_A}/digest/acknowledge`, keyA);
    // The dashboard's own watermark store, keyed by session username, is
    // completely untouched by a BAP acknowledgement.
    expect(getDashboardWatermark(DASHBOARD_OPERATOR, BIZ_A)).toBeNull();
    expect(getDashboardWatermark('agt_digest_a', BIZ_A)).toBeNull();
  });

  test('a dashboard-side acknowledgement does not advance the BAP agent\'s watermark', async () => {
    expect(getBapWatermark('agt_digest_a', BIZ_A)).toBeNull();
    advanceDashboardWatermark({
      operator_key: DASHBOARD_OPERATOR,
      business_id: BIZ_A,
      acknowledged_through: new Date().toISOString(),
      items: {},
    });
    expect(getBapWatermark('agt_digest_a', BIZ_A)).toBeNull();
    resetDashboardWatermark(DASHBOARD_OPERATOR, BIZ_A);
  });

  test('two different agents on two different businesses have independent watermarks', async () => {
    await post(`/api/bap/v1/businesses/${BIZ_A}/digest/acknowledge`, keyA, { acknowledged_through: '2026-03-01T00:00:00.000Z' });
    await post(`/api/bap/v1/businesses/${BIZ_B}/digest/acknowledge`, keyB, { acknowledged_through: '2026-04-01T00:00:00.000Z' });

    const wmA = getBapWatermark('agt_digest_a', BIZ_A)!;
    const wmB = getBapWatermark('agt_digest_b', BIZ_B)!;
    expect(wmA.acknowledged_through).not.toBe(wmB.acknowledged_through);
    expect(getBapWatermark('agt_digest_a', BIZ_B)).toBeNull();
    expect(getBapWatermark('agt_digest_b', BIZ_A)).toBeNull();

    resetBapWatermark('agt_digest_b', BIZ_B);
  });
});
