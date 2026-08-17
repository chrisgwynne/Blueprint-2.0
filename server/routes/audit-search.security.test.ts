/**
 * Audit search API — authorization and cross-business isolation (#72).
 *
 * Run against a real, locally-bound Express instance mounting the actual
 * router (the same harness decision-queue.security.test.ts and
 * operating-policies.security.test.ts use), because these are properties of
 * the HTTP surface rather than of the engine:
 *
 *   - no session, no search, and nothing leaked in the error
 *   - a searcher working business A cannot retrieve business B's records,
 *     even when A's records and B's records use identical wording
 *   - a citation token from another business does not resolve
 *   - the search endpoint writes nothing (an audit surface you can edit is
 *     not evidence)
 *   - a credential in a matched row does not reach the HTTP response
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import auditSearchRouter from './audit-search.ts';

const BIZ_A = 'biz_as_sec_a';
const BIZ_B = 'biz_as_sec_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let sessionUserId: string | null = null;

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

const created: Array<{ table: string; id: string }> = [];
function insertDecision(businessId: string, title: string, reasoning: string): string {
  const id = generateId();
  created.push({ table: 'decisions', id });
  db.prepare(`
    INSERT INTO decisions (id, business_id, decision_type, title, decision, reasoning, author, created_at)
    VALUES (?, ?, 'task_rejection', ?, 'A decision.', ?, 'agent:test', CURRENT_TIMESTAMP)
  `).run(id, businessId, title, reasoning);
  return id;
}

let decisionA = '';
let decisionB = '';
let leakyDecision = '';

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Audit Sec A', 'audit-sec-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Audit Sec B', 'audit-sec-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  // Deliberately identical wording in both businesses: if scoping were done
  // by relevance rather than by SQL, this is the case that would leak.
  decisionA = insertDecision(BIZ_A, 'Quarterly margin review', 'Business A margin reasoning.');
  decisionB = insertDecision(BIZ_B, 'Quarterly margin review', 'Business B margin reasoning.');
  // Obviously-synthetic credential-shaped text (words, not hex).
  leakyDecision = insertDecision(
    BIZ_A, 'Credential handling review',
    'The old header was Authorization: Bearer ThisIsAFakeTokenForTestFixtureOnly and has been replaced.',
  );

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
  app.use('/api/audit-search', auditSearchRouter);

  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  for (const { table, id } of [...created].reverse()) {
    try { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); } catch { /* teardown */ }
  }
  try { db.prepare('DELETE FROM businesses WHERE id IN (?, ?)').run(BIZ_A, BIZ_B); } catch { /* teardown */ }
});

afterEach(() => { sessionUserId = null; });

describe('authentication', () => {
  test('an unauthenticated search is refused', async () => {
    const res = await post(`/api/audit-search/${BIZ_A}`, { query: 'margin' });
    expect(res.status).toBe(401);
  });

  test('an unauthenticated vocabulary read is refused', async () => {
    const res = await get(`/api/audit-search/${BIZ_A}/vocabulary`);
    expect(res.status).toBe(401);
  });

  test('an unauthenticated citation lookup is refused', async () => {
    const res = await get(`/api/audit-search/${BIZ_A}/record/decision%23${decisionA}`);
    expect(res.status).toBe(401);
  });

  test('the 401 body leaks no record content', async () => {
    const res = await post(`/api/audit-search/${BIZ_A}`, { query: 'margin' });
    expect(JSON.stringify(res.body)).not.toContain('margin reasoning');
  });
});

describe('cross-business isolation', () => {
  test('a search of business A returns only A rows, with identical wording in B', async () => {
    sessionUserId = 'searcher';
    const res = await post(`/api/audit-search/${BIZ_A}`, {
      query: 'margin review',
      filters: { terms: ['margin'], record_types: ['decision'] },
    });
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r: { citation: { record_id: string } }) => r.citation.record_id);
    expect(ids).toContain(decisionA);
    expect(ids).not.toContain(decisionB);
    expect(res.body.results.every((r: { business_id: string }) => r.business_id === BIZ_A)).toBe(true);
  });

  test('a business id the caller pointed at in the body cannot widen the search', async () => {
    sessionUserId = 'searcher';
    const res = await post(`/api/audit-search/${BIZ_A}`, {
      query: 'margin review',
      filters: { terms: ['margin'], record_types: ['decision'], business_ids: [BIZ_B] },
    });
    expect(res.status).toBe(200);
    expect(res.body.applied_filters.business_ids).toEqual([BIZ_A]);
    const ids = res.body.results.map((r: { citation: { record_id: string } }) => r.citation.record_id);
    expect(ids).not.toContain(decisionB);
  });

  test("a citation from another business does not resolve through A's path", async () => {
    sessionUserId = 'searcher';
    const res = await get(`/api/audit-search/${BIZ_A}/record/${encodeURIComponent(`decision#${decisionB}`)}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Business B margin reasoning');
  });

  test("a citation from this business does resolve", async () => {
    sessionUserId = 'searcher';
    const res = await get(`/api/audit-search/${BIZ_A}/record/${encodeURIComponent(`decision#${decisionA}`)}`);
    expect(res.status).toBe(200);
    expect(res.body.record.citation.record_id).toBe(decisionA);
  });

  test('an unknown business is 404, not an empty successful search', async () => {
    sessionUserId = 'searcher';
    const res = await post('/api/audit-search/biz_not_real', { query: 'margin' });
    expect(res.status).toBe(404);
  });
});

describe('redaction at the HTTP boundary', () => {
  test('a credential in a matched row never reaches the response', async () => {
    sessionUserId = 'searcher';
    const res = await post(`/api/audit-search/${BIZ_A}`, {
      query: 'credential handling',
      filters: { terms: ['credential'], record_types: ['decision'] },
    });
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r: { citation: { record_id: string } }) => r.citation.record_id);
    expect(ids).toContain(leakyDecision);
    expect(JSON.stringify(res.body)).not.toContain('ThisIsAFakeTokenForTestFixtureOnly');
  });

  test('citation refs survive redaction — they are the checkable part', async () => {
    sessionUserId = 'searcher';
    const res = await post(`/api/audit-search/${BIZ_A}`, {
      query: 'margin',
      filters: { terms: ['margin'], record_types: ['decision'] },
    });
    for (const r of res.body.results) {
      expect(r.citation.ref).toMatch(/^decision#/);
      expect(r.citation.ref).not.toBe('[redacted]');
    }
  });
});

describe('the search surface is read-only', () => {
  test('running a search leaves the record count unchanged', async () => {
    sessionUserId = 'searcher';
    const before = (db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE business_id = ?').get(BIZ_A) as { n: number }).n;
    await post(`/api/audit-search/${BIZ_A}`, { query: 'margin review', filters: { terms: ['margin'] } });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE business_id = ?').get(BIZ_A) as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('vocabulary readback', () => {
  test('reports the statuses this business actually has', async () => {
    sessionUserId = 'searcher';
    const res = await get(`/api/audit-search/${BIZ_A}/vocabulary`);
    expect(res.status).toBe(200);
    const decision = res.body.record_types.find((t: { type: string }) => t.type === 'decision');
    expect(decision.statuses).toContain('task_rejection');
  });
});

describe('input bounds', () => {
  test('an absurd limit is clamped rather than honoured', async () => {
    sessionUserId = 'searcher';
    const res = await post(`/api/audit-search/${BIZ_A}`, {
      query: 'margin', filters: { terms: ['margin'] }, limit: 100000,
    });
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeLessThanOrEqual(100);
  });

  test('a missing query is an explicit ambiguous state, not a 500', async () => {
    sessionUserId = 'searcher';
    const res = await post(`/api/audit-search/${BIZ_A}`, {});
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ambiguous_query');
  });
});
