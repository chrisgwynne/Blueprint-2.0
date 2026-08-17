/**
 * Explanation readback via BAP (issue #82) — server/routes/bap-explanations.ts,
 * exercised against a real Express instance mounting the actual router.
 *
 * The load-bearing property here is the same one the dashboard route
 * (explanations.test.ts) already proves for session auth: an agent scoped
 * to business B must not be able to read business A's explanation, whether
 * denied by permission or by business grant, and an unknown subject must be
 * a 404 rather than a leak of existence. This file adds the BAP-specific
 * layer on top — permission grant vs. business-access grant are two
 * independently deniable things.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapExplanationsRouter from './bap-explanations.ts';
import { EXPLANATION_SCHEMA_VERSION } from '../explain/index.ts';

const BIZ_A = 'biz_bap_explain_a';
const BIZ_B = 'biz_bap_explain_b';
// Not a real credential — synthetic, non-hex fixture, same convention as
// the dashboard route's own test (explanations.test.ts).
const SECRET = 'shpat_TESTFIXTUREVALUEQQQ111222333';

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let taskA = '';
let taskB = '';

let keyA: string;         // scoped to BIZ_A, holds explanations:read
let keyB: string;         // scoped to BIZ_B, holds explanations:read
let keyNoGrant: string;   // scoped to BIZ_A, but without explanations:read

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(businessId: string, title: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, action_payload, version, created_at, updated_at)
    VALUES (?, ?, ?, 'agent:analyst', 'proposed', 'yellow', 'requires_approval', 'shopify_product_update', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId, title, JSON.stringify({ access_token: SECRET }));
  return id;
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Explain A', 'bap-explain-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Explain B', 'bap-explain-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  taskA = insertTask(BIZ_A, 'BAP explain fixture task A');
  taskB = insertTask(BIZ_B, 'BAP explain fixture task B');

  for (const id of ['agt_explain_a', 'agt_explain_b', 'agt_explain_nogrant']) {
    db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);
  }
  keyA = generateApiKey();
  keyB = generateApiKey();
  keyNoGrant = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_explain_a', 'Explain Agent A', await hashApiKey(keyA), keyPrefix(keyA), JSON.stringify(['explanations:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_explain_b', 'Explain Agent B', await hashApiKey(keyB), keyPrefix(keyB), JSON.stringify(['explanations:read']), JSON.stringify([BIZ_B]));
  insertAgent.run('agt_explain_nogrant', 'No Grant Agent', await hashApiKey(keyNoGrant), keyPrefix(keyNoGrant), JSON.stringify(['tasks:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapExplanationsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_explain_a', 'agt_explain_b', 'agt_explain_nogrant')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_explain_a', 'agt_explain_b', 'agt_explain_nogrant')`).run();
});

describe('explanations:read grant', () => {
  test('is offered as a read-only grant, with no write counterpart', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('explanations:read');
    expect(GRANTABLE_BAP_PERMISSIONS.some((p) => p.startsWith('explanations:') && p !== 'explanations:read')).toBe(false);
  });

  test('an unauthenticated request is rejected outright', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/explanations/task/${taskA}`);
    expect(status).toBe(401);
  });
});

describe('GET /businesses/:id/explanations/:kind/:id — successful fetch', () => {
  test('returns the same versioned, calibrated explanation shape the dashboard panel gets', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/explanations/task/${taskA}`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.schema_version).toBe(EXPLANATION_SCHEMA_VERSION);
    expect(body.explanation.subject.kind).toBe('task');
    expect(body.explanation.subject.id).toBe(taskA);
    expect(body.explanation.disposition).toBe('awaiting_decision');
    expect(Array.isArray(body.explanation.evidence.items)).toBe(true);
    expect(body.explanation.limitations.length).toBeGreaterThan(0);
  });

  test('no credential from the underlying record reaches the wire', async () => {
    const res = await fetch(`${baseUrl}/api/bap/v1/businesses/${BIZ_A}/explanations/task/${taskA}`, { headers: { 'BAP-Key': keyA } });
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
  });

  test('the vocabulary endpoint publishes every meaning the panel renders', async () => {
    const { status, body } = await get('/api/bap/v1/explanations/kinds', { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.kinds).toEqual(['task', 'decision', 'hiring_analysis', 'hiring_candidate']);
    expect(body.evidence_quality.missing).toContain('not evidence that the answer is no');
    expect(body.evidence_quality.negative).toContain('real finding');
    expect(body.causal_claim.correlational).toContain('has NOT established');
    expect(body.disposition.no_op).toContain('deliberately did nothing');
  });
});

describe('permission denial', () => {
  test('an agent without explanations:read cannot fetch an explanation for a business it otherwise has access to', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/explanations/task/${taskA}`, { 'BAP-Key': keyNoGrant });
    expect(status).toBe(403);
    expect(body.error).toMatch(/Permission denied/);
    expect(body.explanation).toBeUndefined();
  });

  test('the vocabulary endpoint also requires the grant', async () => {
    const { status } = await get('/api/bap/v1/explanations/kinds', { 'BAP-Key': keyNoGrant });
    expect(status).toBe(403);
  });
});

describe('business-access-grant denial', () => {
  test('an agent scoped to business B cannot fetch business A\'s explanation, despite holding explanations:read', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/explanations/task/${taskA}`, { 'BAP-Key': keyB });
    expect(status).toBe(403);
    expect(body.error).toMatch(/Permission denied/);
    expect(body.explanation).toBeUndefined();
  });

  test('the same agent can fetch its own business\'s explanation', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_B}/explanations/task/${taskB}`, { 'BAP-Key': keyB });
    expect(status).toBe(200);
    expect(body.explanation.subject.id).toBe(taskB);
  });
});

describe('not-found behavior', () => {
  test('an unknown task id is a 404, not an empty explanation', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/explanations/task/does_not_exist`, { 'BAP-Key': keyA });
    expect(status).toBe(404);
  });

  test('another business\'s task id is not explainable through this business\'s path', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/explanations/task/${taskB}`, { 'BAP-Key': keyA });
    expect(status).toBe(404);
    expect(body.error).toContain('nothing to explain');
  });

  test('an unknown subject kind is refused with a 400 naming what IS explainable, not a 404', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/explanations/invoice/${taskA}`, { 'BAP-Key': keyA });
    expect(status).toBe(400);
    expect(body.explainable_kinds).toContain('task');
    expect(body.explainable_kinds).toContain('hiring_candidate');
  });

  test('a hiring candidate with no history is explainable rather than a 404', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/explanations/hiring_candidate/tpl_unknown`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.explanation.disposition).toBe('no_op');
  });
});
