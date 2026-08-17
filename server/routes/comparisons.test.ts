/**
 * Comparison API (#66) at the route level.
 *
 * The engine's own guarantees are tested in
 * server/brain/comparison-engine.test.ts. This file covers the HTTP
 * contract the dashboard depends on: the candidate pool is business
 * scoped, /compare is inert, a cross-business set is a 422 that names the
 * offending candidate, and /decision writes exactly one decision row
 * without approving or executing anything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import comparisonsRouter from './comparisons.js';

const BIZ_A = 'biz_cmp_rt_a';
const BIZ_B = 'biz_cmp_rt_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(businessId: string, title: string, confidence: number | null = 0.8): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, action_payload, confidence, created_at, updated_at)
    VALUES (?, ?, ?, 'agent:cmp-rt', 'proposed', 'yellow', 'requires_approval', 'content_draft', '{}', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId, title, confidence);
  return id;
}

/**
 * Scoped to this file's fixture businesses — a global count would be
 * polluted by other suites sharing the in-memory database.
 */
function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id IN (?, ?)`).get(BIZ_A, BIZ_B) as { n: number }).n;
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Cmp Rt A', 'cmp-rt-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Cmp Rt B', 'cmp-rt-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { (req.session as any).userId = 'user_cmp_rt'; next(); }); // eslint-disable-line @typescript-eslint/no-explicit-any
  app.use('/api/comparisons', comparisonsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM decisions WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM execution_jobs').run();
});

afterAll(() => {
  server?.close();
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM decisions WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
});

describe('GET /api/comparisons/:businessId/candidates', () => {
  test('returns only this business\'s candidates', async () => {
    insertTask(BIZ_A, 'Mine');
    insertTask(BIZ_B, 'Theirs');
    const { status, body } = await get(`/api/comparisons/${BIZ_A}/candidates`);
    expect(status).toBe(200);
    const titles = body.candidates.map((c: any) => c.title); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(titles).toContain('Mine');
    expect(titles).not.toContain('Theirs');
  });
});

describe('POST /api/comparisons/:businessId/compare', () => {
  test('returns a read-only comparison and writes nothing', async () => {
    const a = insertTask(BIZ_A, 'A', 0.9);
    const b = insertTask(BIZ_A, 'B', 0.3);

    const { status, body } = await post(`/api/comparisons/${BIZ_A}/compare`, {
      candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }],
    });

    expect(status).toBe(200);
    expect(body.read_only).toBe(true);
    expect(body.candidates).toHaveLength(2);
    expect(body.shared_policy.policy_citation).toBeTruthy();
    expect(body.differing_dimension_keys).toContain('agent_confidence');

    expect(count('execution_jobs')).toBe(0);
    expect(count('decisions')).toBe(0);
    const row = db.prepare('SELECT status, approved_at FROM tasks WHERE id = ?').get(a) as Record<string, unknown>;
    expect(row.status).toBe('proposed');
    expect(row.approved_at).toBeNull();
  });

  test('accepts bare id strings as well as { id, kind } objects', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status, body } = await post(`/api/comparisons/${BIZ_A}/compare`, { candidates: [a, b] });
    expect(status).toBe(200);
    expect(body.candidates).toHaveLength(2);
  });

  test('422s a cross-business comparison and names the offending candidate', async () => {
    const mine = insertTask(BIZ_A, 'Mine');
    const theirs = insertTask(BIZ_B, 'Theirs');

    const { status, body } = await post(`/api/comparisons/${BIZ_A}/compare`, {
      candidates: [{ id: mine, kind: 'task' }, { id: theirs, kind: 'task' }],
    });

    expect(status).toBe(422);
    expect(body.rejections.map((r: any) => r.code)).toContain('cross_business_candidate'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.rejections.find((r: any) => r.code === 'cross_business_candidate').candidate_id).toBe(theirs); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(count('decisions')).toBe(0);
  });

  test('400s a malformed candidate kind rather than guessing', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status, body } = await post(`/api/comparisons/${BIZ_A}/compare`, {
      candidates: [{ id: a, kind: 'tsak' }, { id: b, kind: 'task' }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('kind must be one of');
  });
});

describe('POST /api/comparisons/:businessId/decision', () => {
  test('records a selection without approving or executing it', async () => {
    const winner = insertTask(BIZ_A, 'Winner', 0.9);
    const loser = insertTask(BIZ_A, 'Loser', 0.2);

    const { status, body } = await post(`/api/comparisons/${BIZ_A}/decision`, {
      candidates: [{ id: winner, kind: 'task' }, { id: loser, kind: 'task' }],
      outcome: 'selected',
      selected_candidate_id: winner,
      rationale: 'Better confidence at the same policy tier.',
    });

    expect(status).toBe(201);
    expect(body.executed).toBe(false);
    expect(body.approved).toBe(false);
    expect(body.selected_candidate_id).toBe(winner);

    const rows = db.prepare('SELECT * FROM decisions WHERE business_id = ?').all(BIZ_A) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision_type).toBe('comparison_selection');
    expect(rows[0]!.author).toBe('dashboard:user_cmp_rt');
    expect(rows[0]!.effective_policy_version).toBe(0);

    expect(count('execution_jobs')).toBe(0);
    const task = db.prepare('SELECT status, approved_by FROM tasks WHERE id = ?').get(winner) as Record<string, unknown>;
    expect(task.status).toBe('proposed');
    expect(task.approved_by).toBeNull();
  });

  test('records a deferral with no winner', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status, body } = await post(`/api/comparisons/${BIZ_A}/decision`, {
      candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }],
      outcome: 'deferred',
      rationale: 'Waiting on the next measurement window.',
    });
    expect(status).toBe(201);
    expect(body.selected_candidate_id).toBeNull();
    const row = db.prepare('SELECT decision_type, related_task_id FROM decisions WHERE business_id = ?').get(BIZ_A) as Record<string, unknown>;
    expect(row.decision_type).toBe('comparison_deferral');
    expect(row.related_task_id).toBeNull();
  });

  test('400s a decision with no rationale and writes nothing', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status, body } = await post(`/api/comparisons/${BIZ_A}/decision`, {
      candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }],
      outcome: 'selected', selected_candidate_id: a, rationale: '  ',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('rationale');
    expect(count('decisions')).toBe(0);
  });

  test('422s a cross-business decision attempt and writes nothing', async () => {
    const mine = insertTask(BIZ_A, 'Mine');
    const theirs = insertTask(BIZ_B, 'Theirs');
    const { status } = await post(`/api/comparisons/${BIZ_A}/decision`, {
      candidates: [{ id: mine, kind: 'task' }, { id: theirs, kind: 'task' }],
      outcome: 'selected', selected_candidate_id: mine, rationale: 'x',
    });
    expect(status).toBe(422);
    expect(count('decisions')).toBe(0);
  });
});
