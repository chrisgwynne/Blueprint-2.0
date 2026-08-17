/**
 * Explanation readback contract (issue #60) — server/routes/explanations.ts.
 *
 * The properties that matter at this boundary:
 *   • an unauthenticated caller gets nothing;
 *   • business scoping comes from the records, not from trusting the path,
 *     so another tenant's task is a 404 even when its id is guessed;
 *   • an unknown subject kind is a 400 that names what IS explainable,
 *     rather than a silent empty panel;
 *   • the vocabulary endpoint publishes the meanings, so the panel never
 *     hardcodes a definition that could drift from the server's;
 *   • nothing that reaches the wire contains a credential.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import explanationsRouter from './explanations.ts';
import { EXPLANATION_SCHEMA_VERSION } from '../explain/index.ts';

const BIZ_A = 'biz_explain_route_a';
const BIZ_B = 'biz_explain_route_b';
// Not a real credential — synthetic, non-hex fixture shaped like a Shopify
// token only closely enough to exercise redactSensitiveText()'s pattern.
const SECRET = 'shpat_TESTFIXTUREVALUEQQQ111222333';

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let taskA = '';
let taskB = '';
let decisionA = '';

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, authed = true): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authed ? { 'X-Test-User': 'owner' } : {} });
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
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Explain Route A', 'explain-route-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Explain Route B', 'explain-route-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  taskA = insertTask(BIZ_A, 'Route fixture task A');
  taskB = insertTask(BIZ_B, 'Route fixture task B');

  decisionA = generateId();
  db.prepare(`
    INSERT INTO decisions (id, business_id, decision_type, title, decision, reasoning, evidence, author, related_task_id, created_at)
    VALUES (?, ?, 'task_rejection', 'Reject the price change', 'Rejected', 'Too much exposure for the evidence available.', '[]', 'dashboard:owner', ?, CURRENT_TIMESTAMP)
  `).run(decisionA, BIZ_A, taskA);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) (req.session as unknown as Record<string, unknown>).userId = String(req.headers['x-test-user']);
    next();
  });
  app.use('/api/explanations', explanationsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM decisions WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
});

describe('GET /api/explanations', () => {
  test('requires an authenticated session', async () => {
    const { status } = await get(`/api/explanations/${BIZ_A}/task/${taskA}`, false);
    expect(status).toBe(401);
  });

  test('returns a versioned explanation for a task', async () => {
    const { status, body } = await get(`/api/explanations/${BIZ_A}/task/${taskA}`);
    expect(status).toBe(200);
    expect(body.schema_version).toBe(EXPLANATION_SCHEMA_VERSION);
    expect(body.explanation.subject.kind).toBe('task');
    expect(body.explanation.subject.id).toBe(taskA);
    expect(body.explanation.disposition).toBe('awaiting_decision');
    expect(Array.isArray(body.explanation.evidence.items)).toBe(true);
    expect(body.explanation.limitations.length).toBeGreaterThan(0);
  });

  test('returns an explanation for a decision-memory row', async () => {
    const { status, body } = await get(`/api/explanations/${BIZ_A}/decision/${decisionA}`);
    expect(status).toBe(200);
    expect(body.explanation.subject.kind).toBe('decision');
    expect(body.explanation.disposition).toBe('rejected');
    expect(body.explanation.headline).toContain('Nothing was done');
  });

  test('another business\'s task is not explainable through this business\'s path', async () => {
    const { status, body } = await get(`/api/explanations/${BIZ_A}/task/${taskB}`);
    expect(status).toBe(404);
    expect(body.error).toContain('nothing to explain');
  });

  test('an unknown subject kind is refused, and the refusal names what IS explainable', async () => {
    const { status, body } = await get(`/api/explanations/${BIZ_A}/invoice/${taskA}`);
    expect(status).toBe(400);
    expect(body.explainable_kinds).toContain('task');
    expect(body.explainable_kinds).toContain('hiring_candidate');
  });

  test('a missing id is a 404, not an empty explanation', async () => {
    const { status } = await get(`/api/explanations/${BIZ_A}/task/does_not_exist`);
    expect(status).toBe(404);
  });

  test('no credential from the underlying record reaches the wire', async () => {
    const res = await fetch(`${baseUrl}/api/explanations/${BIZ_A}/task/${taskA}`, { headers: { 'X-Test-User': 'owner' } });
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
  });

  test('the vocabulary endpoint publishes every meaning the panel renders', async () => {
    const { status, body } = await get('/api/explanations/kinds');
    expect(status).toBe(200);
    expect(body.kinds).toEqual(['task', 'decision', 'hiring_analysis', 'hiring_candidate']);
    // Missing and negative must be documented as different things, since
    // that distinction is the whole point of the evidence model.
    expect(body.evidence_quality.missing).toContain('not evidence that the answer is no');
    expect(body.evidence_quality.negative).toContain('real finding');
    expect(body.causal_claim.correlational).toContain('has NOT established');
    expect(body.disposition.no_op).toContain('deliberately did nothing');
  });

  test('a hiring candidate with no history is explainable rather than a 404', async () => {
    const { status, body } = await get(`/api/explanations/${BIZ_A}/hiring_candidate/tpl_unknown`);
    expect(status).toBe(200);
    expect(body.explanation.disposition).toBe('no_op');
    expect(body.explanation.headline).toContain('has ever recorded a decision');
    expect(body.explanation.limitations.join(' ')).toContain('has never been assessed');
  });
});
