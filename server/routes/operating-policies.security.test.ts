/**
 * Operating Policy API — authorization and cross-business isolation (#68).
 *
 * Run against a real, locally-bound Express instance mounting the actual
 * routers (same harness as bap.security.test.ts), because the properties
 * under test are properties of the HTTP surface, not of the engine:
 *
 *   - no session, no access (dashboard surface)
 *   - no BAP grant / no business grant, no access (agent surface)
 *   - an agent scoped to business A cannot read business B's policy
 *   - a policy version number is only resolvable inside its own business
 *   - BAP has no write path to policy at all
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from '../bap/auth.ts';
import bapRouter from './bap.ts';
import operatingPoliciesRouter from './operating-policies.ts';
import { savePolicyVersion } from '../policy/operating-policy.js';

const BIZ_A = 'biz_oppol_sec_a';
const BIZ_B = 'biz_oppol_sec_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
/** BAP key scoped to BIZ_A only, holding operating_policies:read. */
let keyA: string;
/** BAP key scoped to BIZ_A only, WITHOUT the operating_policies:read grant. */
let keyNoGrant: string;
/** Flipped by the fake auth middleware to simulate logged in / logged out. */
let sessionUserId: string | null = null;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function registerAgent(name: string, permissions: string[]): Promise<string> {
  const raw = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, permissions, business_access, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
  `).run(
    `agent_${name}`, name, await hashApiKey(raw), keyPrefix(raw),
    JSON.stringify(permissions), JSON.stringify([BIZ_A]),
  );
  return raw;
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Policy Sec A', 'policy-sec-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Policy Sec B', 'policy-sec-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  keyA = await registerAgent('oppol_reader', ['operating_policies:read']);
  keyNoGrant = await registerAgent('oppol_nogrant', ['tasks:read']);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  // Stand-in for the real login flow: isAuthenticated only checks that
  // req.session.userId is set, so setting/clearing it here exercises the
  // exact same authorization branch the real app uses.
  app.use((req, _res, next) => {
    if (sessionUserId) (req.session as unknown as { userId: string }).userId = sessionUserId;
    next();
  });
  app.use('/api/operating-policies', operatingPoliciesRouter);
  app.use('/api/bap/v1', bapRouter);

  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server?.close(); });

afterEach(() => {
  sessionUserId = null;
  for (const id of [BIZ_A, BIZ_B]) {
    db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(id);
    db.prepare('DELETE FROM operating_policy_events WHERE scope_key = ?').run(id);
  }
  db.prepare("DELETE FROM operating_policies WHERE scope = 'portfolio'").run();
  db.prepare("DELETE FROM operating_policy_events WHERE scope = 'portfolio'").run();
  db.prepare('DELETE FROM operating_policy_portfolios').run();
});

// ─── Dashboard surface: session required ────────────────────────────────────

describe('dashboard authorization', () => {
  test('every policy route rejects an unauthenticated caller', async () => {
    sessionUserId = null;
    expect((await get(`/api/operating-policies/${BIZ_A}`)).status).toBe(401);
    expect((await post(`/api/operating-policies/${BIZ_A}`, { patch: { notes: 'x' } })).status).toBe(401);
    expect((await post(`/api/operating-policies/${BIZ_A}/preview`, { patch: { notes: 'x' } })).status).toBe(401);
    expect((await post(`/api/operating-policies/${BIZ_A}/rollback`, { to_version: 1 })).status).toBe(401);
    expect((await get('/api/operating-policies/portfolios')).status).toBe(401);
  });

  test('an unauthenticated write leaves no policy version behind', async () => {
    sessionUserId = null;
    await post(`/api/operating-policies/${BIZ_A}`, { patch: { notes: 'sneaky' } });
    sessionUserId = 'operator-1';
    const after = await get(`/api/operating-policies/${BIZ_A}`);
    expect(after.body.versions).toHaveLength(0);
  });

  test('an authenticated operator can read and write, and the actor is recorded', async () => {
    sessionUserId = 'operator-1';
    const created = await post(`/api/operating-policies/${BIZ_A}`, {
      patch: { notes: 'Careful business' }, change_reason: 'initial setup',
    });
    expect(created.status).toBe(201);
    expect(created.body.policy.version).toBe(1);
    expect(created.body.policy.created_by).toBe('dashboard:operator-1');
  });

  test('a policy for a business that does not exist is a 404, not an implicit create', async () => {
    sessionUserId = 'operator-1';
    expect((await get('/api/operating-policies/biz_nope')).status).toBe(404);
    expect((await post('/api/operating-policies/biz_nope', { patch: { notes: 'x' } })).status).toBe(404);
  });
});

// ─── Validation feedback over HTTP ──────────────────────────────────────────

describe('validation feedback', () => {
  test('an invalid policy is a 422 carrying every violation with its field and message', async () => {
    sessionUserId = 'operator-1';
    const res = await post(`/api/operating-policies/${BIZ_A}`, {
      patch: { thresholds: { financial_exposure_review_gbp: -1 }, connectors: { allowed_connector_types: ['x'], blocked_connector_types: ['x'] } },
    });
    expect(res.status).toBe(422);
    const codes = (res.body.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain('threshold_negative');
    expect(codes).toContain('connector_allow_block_conflict');
    expect((res.body.violations as Array<{ message: string }>)[0]!.message.length).toBeGreaterThan(30);
  });

  test('preview returns violations as data with a 200, so a form can render them inline', async () => {
    sessionUserId = 'operator-1';
    const res = await post(`/api/operating-policies/${BIZ_A}/preview`, {
      patch: { thresholds: { min_agent_confidence: 55 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.preview.valid).toBe(false);
    expect((res.body.preview.violations as Array<{ code: string }>).map((v) => v.code)).toContain('confidence_out_of_range');
    // ...and nothing was written.
    expect((await get(`/api/operating-policies/${BIZ_A}`)).body.versions).toHaveLength(0);
  });
});

// ─── Cross-business isolation over HTTP ─────────────────────────────────────

describe('cross-business isolation', () => {
  test("business A's policy never appears in business B's response", async () => {
    sessionUserId = 'operator-1';
    await post(`/api/operating-policies/${BIZ_A}`, { patch: { notes: 'A only' } });

    const b = await get(`/api/operating-policies/${BIZ_B}`);
    expect(b.body.versions).toHaveLength(0);
    expect(b.body.active).toBeNull();
    expect(b.body.events).toHaveLength(0);
    expect(b.body.effective.policy_scope).toBe('system_default');
    expect(JSON.stringify(b.body)).not.toContain('A only');
  });

  test('a version number is only resolvable inside its own business', async () => {
    sessionUserId = 'operator-1';
    await post(`/api/operating-policies/${BIZ_A}`, { patch: { notes: 'A v1' } });

    expect((await get(`/api/operating-policies/${BIZ_A}/versions/1`)).status).toBe(200);
    expect((await get(`/api/operating-policies/${BIZ_B}/versions/1`)).status).toBe(404);
  });

  test('rolling back business B cannot reach into business A history', async () => {
    sessionUserId = 'operator-1';
    await post(`/api/operating-policies/${BIZ_A}`, { patch: { notes: 'A v1' } });
    await post(`/api/operating-policies/${BIZ_A}`, { patch: { notes: 'A v2' } });

    const res = await post(`/api/operating-policies/${BIZ_B}/rollback`, { to_version: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No policy versions have been authored yet/);
    // A is untouched.
    expect((await get(`/api/operating-policies/${BIZ_A}`)).body.effective.document.notes).toBe('A v2');
  });

  test('writing to business B does not disturb business A', async () => {
    sessionUserId = 'operator-1';
    await post(`/api/operating-policies/${BIZ_A}`, { patch: { thresholds: { financial_exposure_review_gbp: 11 } } });
    await post(`/api/operating-policies/${BIZ_B}`, { patch: { thresholds: { financial_exposure_review_gbp: 22 } } });

    expect((await get(`/api/operating-policies/${BIZ_A}`)).body.effective.document.thresholds.financial_exposure_review_gbp).toBe(11);
    expect((await get(`/api/operating-policies/${BIZ_B}`)).body.effective.document.thresholds.financial_exposure_review_gbp).toBe(22);
  });
});

// ─── Portfolio scope must be explicitly selected ────────────────────────────

describe('portfolio scope', () => {
  test('a portfolio must be created explicitly before it can hold a policy', async () => {
    sessionUserId = 'operator-1';
    expect((await post('/api/operating-policies/portfolios/pf_nope', { patch: { notes: 'x' } })).status).toBe(404);
  });

  test('a portfolio policy reaches only the businesses explicitly selected into it', async () => {
    sessionUserId = 'operator-1';
    const created = await post('/api/operating-policies/portfolios', { name: 'Group', business_ids: [BIZ_A] });
    expect(created.status).toBe(201);
    const portfolioId = created.body.portfolio.id as string;

    await post(`/api/operating-policies/portfolios/${portfolioId}`, { patch: { priorities: { max_open_tasks: 9 } } });

    expect((await get(`/api/operating-policies/${BIZ_A}`)).body.effective.document.priorities.max_open_tasks).toBe(9);
    expect((await get(`/api/operating-policies/${BIZ_B}`)).body.effective.document.priorities.max_open_tasks).toBeNull();
  });
});

// ─── BAP surface ────────────────────────────────────────────────────────────

describe('BAP authorization', () => {
  test('no key at all is rejected', async () => {
    expect((await get(`/api/bap/v1/businesses/${BIZ_A}/operating-policy`)).status).toBe(401);
  });

  test('a valid key without the operating_policies:read grant is rejected', async () => {
    const res = await get(`/api/bap/v1/businesses/${BIZ_A}/operating-policy`, { 'BAP-Key': keyNoGrant });
    expect(res.status).toBe(403);
  });

  test('a granted agent reads the policy of the business it is scoped to', async () => {
    savePolicyVersion({ scope: 'business', key: BIZ_A, patch: { notes: 'visible to agent' }, actor: 'dashboard:operator-1' });
    const res = await get(`/api/bap/v1/businesses/${BIZ_A}/operating-policy`, { 'BAP-Key': keyA });
    expect(res.status).toBe(200);
    expect(res.body.effective.document.notes).toBe('visible to agent');
    expect(res.body.versions).toHaveLength(1);
  });

  test('a granted agent scoped to A cannot read business B, even with the grant', async () => {
    savePolicyVersion({ scope: 'business', key: BIZ_B, patch: { notes: 'B secret' }, actor: 'dashboard:operator-1' });
    const res = await get(`/api/bap/v1/businesses/${BIZ_B}/operating-policy`, { 'BAP-Key': keyA });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('B secret');
  });

  test('BAP has no write path to policy — governance is an operator act', async () => {
    const res = await post(`/api/bap/v1/businesses/${BIZ_A}/operating-policy`, { patch: { notes: 'agent authored' } }, { 'BAP-Key': keyA });
    expect(res.status).toBe(404);
  });
});
