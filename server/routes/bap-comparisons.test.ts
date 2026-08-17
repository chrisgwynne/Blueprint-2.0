/**
 * Recommendation comparison over BAP (issue #78) — server/routes/bap-comparisons.ts,
 * exercised against a real Express instance mounting the actual router
 * behind the real bapAuth/rate-limit chain.
 *
 * Four properties carry the weight here, and all four are the reason the
 * endpoint exists rather than incidental plumbing:
 *
 *   1. The grant is `comparisons:read` and nothing else. In particular it is
 *      NOT `recommendations:read` (bap-review.ts's ranked-list endpoint), so
 *      it is always unambiguous which engine served a response, and holding
 *      one grant never silently confers the other.
 *   2. Business scoping matches the dashboard route exactly — a candidate
 *      from another business is a 422 naming it, and an agent with no access
 *      to the path's business never gets that far.
 *   3. Unknowns survive the HTTP boundary as unknowns. The engine's whole
 *      point is that it never fabricates a number; a route that flattened
 *      `{state:'unknown'}` into `0` or dropped it would undo that silently.
 *   4. Serving a comparison over BAP has zero execution/approval side
 *      effects — asserted behaviourally (no rows, no task mutation) and
 *      structurally (the route's import list), the same pair of guards
 *      server/brain/comparison-engine.test.ts uses on the engine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapComparisonsRouter from './bap-comparisons.ts';

const BIZ_A = 'biz_bap_cmp_a';
const BIZ_B = 'biz_bap_cmp_b';
const AGENT_IDS = ['agt_cmp_a', 'agt_cmp_b', 'agt_cmp_nogrant', 'agt_cmp_recs'];

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string;        // scoped to BIZ_A, holds comparisons:read
let keyB: string;        // scoped to BIZ_B, holds comparisons:read
let keyNoGrant: string;  // scoped to BIZ_A, holds tasks:read only
let keyRecsOnly: string; // scoped to BIZ_A, holds recommendations:read only

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(businessId: string, title: string, confidence: number | null = 0.8, actionType = 'content_draft'): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, action_payload, confidence, created_at, updated_at)
    VALUES (?, ?, ?, 'agent:bap-cmp', 'proposed', 'yellow', 'requires_approval', ?, '{}', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId, title, actionType, confidence);
  return id;
}

/** Scoped to this file's fixtures — the in-memory DB is shared with other suites. */
function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id IN (?, ?)`).get(BIZ_A, BIZ_B) as { n: number }).n;
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Cmp A', 'bap-cmp-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Cmp B', 'bap-cmp-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  for (const id of AGENT_IDS) db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);

  keyA = generateApiKey();
  keyB = generateApiKey();
  keyNoGrant = generateApiKey();
  keyRecsOnly = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_cmp_a', 'Comparison Agent A', await hashApiKey(keyA), keyPrefix(keyA), JSON.stringify(['comparisons:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_cmp_b', 'Comparison Agent B', await hashApiKey(keyB), keyPrefix(keyB), JSON.stringify(['comparisons:read']), JSON.stringify([BIZ_B]));
  insertAgent.run('agt_cmp_nogrant', 'No Grant Agent', await hashApiKey(keyNoGrant), keyPrefix(keyNoGrant), JSON.stringify(['tasks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_cmp_recs', 'Recommendations Only', await hashApiKey(keyRecsOnly), keyPrefix(keyRecsOnly), JSON.stringify(['recommendations:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapComparisonsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM decisions WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM execution_jobs WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
});

afterAll(() => {
  server?.close();
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare('DELETE FROM decisions WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN (${AGENT_IDS.map(() => '?').join(',')})`).run(...AGENT_IDS);
  db.prepare(`DELETE FROM bap_agents WHERE id IN (${AGENT_IDS.map(() => '?').join(',')})`).run(...AGENT_IDS);
});

// ─── The grant ───────────────────────────────────────────────────────────────

describe('comparisons:read grant', () => {
  test('is grantable, read-only, and distinct from recommendations:read', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('comparisons:read');
    // No write counterpart: recording which candidate won writes decision
    // memory, and no BAP route writes that (see the router's docstring).
    expect(GRANTABLE_BAP_PERMISSIONS.filter((p) => p.startsWith('comparisons:'))).toEqual(['comparisons:read']);
    // The ranked-recommendations endpoint keeps its own separate grant.
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('recommendations:read');
  });

  test('recommendations:read does not confer comparison access', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
      { candidates: [a, b] }, { 'BAP-Key': keyRecsOnly });
    expect(status).toBe(403);
    expect(body.error).toMatch(/comparisons:read/);
  });

  test('an agent without the grant is refused, and an unauthenticated one never reaches the route', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const denied = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`, { candidates: [a, b] }, { 'BAP-Key': keyNoGrant });
    expect(denied.status).toBe(403);
    const anon = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`, { candidates: [a, b] });
    expect(anon.status).toBe(401);
  });
});

// ─── The comparison itself ───────────────────────────────────────────────────

describe('POST /businesses/:id/comparisons — authorized comparison within one business', () => {
  test('returns the same normalized comparison model the dashboard gets', async () => {
    const a = insertTask(BIZ_A, 'Draft the launch post', 0.9);
    const b = insertTask(BIZ_A, 'Draft the retention email', 0.3);

    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
      { candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }] }, { 'BAP-Key': keyA });

    expect(status).toBe(200);
    expect(body.read_only).toBe(true);
    expect(body.business_id).toBe(BIZ_A);
    expect(body.candidates.map((c: any) => c.id).sort()).toEqual([a, b].sort()); // eslint-disable-line @typescript-eslint/no-explicit-any

    // One shared policy, cited — every candidate judged against the same rules.
    expect(body.shared_policy.policy_citation).toBeTruthy();
    expect(body.shared_policy.approvals).toBeTruthy();
    for (const c of body.candidates) {
      expect(c.policy.approval_tier.state).toBe('known');
      expect(c.policy.constraint_notes.length).toBeGreaterThan(0);
    }

    // Shared vs. differing is actually computed, not just echoed back.
    expect(body.differing_dimension_keys).toContain('agent_confidence');
    expect(body.shared_dimension_keys).toContain('decision_class');
    expect(body.shared_evidence_window.start).toBeTruthy();
  });

  test('accepts bare id strings as well as { id, kind } objects', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
      { candidates: [a, b] }, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    expect(body.candidates).toHaveLength(2);
  });

  test('400s a malformed candidate kind rather than guessing which record was meant', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
      { candidates: [{ id: a, kind: 'tsak' }, { id: b, kind: 'task' }] }, { 'BAP-Key': keyA });
    expect(status).toBe(400);
    expect(body.code).toBe('validation_error');
    expect(body.error).toContain('kind must be one of');
  });

  test('422s a single-candidate set — a comparison needs something to compare against', async () => {
    const a = insertTask(BIZ_A, 'Alone');
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
      { candidates: [a] }, { 'BAP-Key': keyA });
    expect(status).toBe(422);
    expect(body.rejections.map((r: any) => r.code)).toContain('too_few_candidates'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

describe('GET /businesses/:id/comparisons/candidates', () => {
  test('lists only this business\'s candidates', async () => {
    insertTask(BIZ_A, 'Mine');
    insertTask(BIZ_B, 'Theirs');
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/comparisons/candidates`, { 'BAP-Key': keyA });
    expect(status).toBe(200);
    const titles = body.candidates.map((c: any) => c.title); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(titles).toContain('Mine');
    expect(titles).not.toContain('Theirs');
    expect(body.max_candidates_per_comparison).toBe(6);
  });

  test('an agent scoped to business B cannot list business A\'s candidates', async () => {
    insertTask(BIZ_A, 'Mine');
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/comparisons/candidates`, { 'BAP-Key': keyB });
    expect(status).toBe(403);
    expect(body.candidates).toBeUndefined();
  });
});

// ─── Cross-business, the same way the dashboard rejects it ───────────────────

describe('cross-business comparison is refused', () => {
  test('naming a candidate from another business is a 422 identifying it', async () => {
    const mine = insertTask(BIZ_A, 'Mine');
    const theirs = insertTask(BIZ_B, 'Theirs');

    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
      { candidates: [{ id: mine, kind: 'task' }, { id: theirs, kind: 'task' }] }, { 'BAP-Key': keyA });

    expect(status).toBe(422);
    const rejection = body.rejections.find((r: any) => r.code === 'cross_business_candidate'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(rejection.candidate_id).toBe(theirs);
    expect(rejection.message).toContain('operating policies');
    // Nothing about business B leaked into the response beyond its own id.
    expect(JSON.stringify(body)).not.toContain('Theirs');
  });

  test('an agent scoped to business B cannot compare inside business A at all', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
      { candidates: [a, b] }, { 'BAP-Key': keyB });
    expect(status).toBe(403);
    expect(body.candidates).toBeUndefined();
  });

  test('an agent cannot reach another business\'s candidates by comparing them in its own scope', async () => {
    const theirs1 = insertTask(BIZ_A, 'Theirs one');
    const theirs2 = insertTask(BIZ_A, 'Theirs two');
    // Agent B has access to BIZ_B, so requirePermission lets the request in —
    // the engine's own business check is what stops it, and it stops it
    // before any BIZ_A content is read into the response.
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_B}/comparisons`,
      { candidates: [theirs1, theirs2] }, { 'BAP-Key': keyB });
    expect(status).toBe(422);
    expect(body.rejections.every((r: any) => r.code === 'cross_business_candidate')).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(body)).not.toContain('Theirs one');
  });
});

// ─── Unknowns stay unknown ───────────────────────────────────────────────────

describe('unknown and incomparable fields are marked, never fabricated', () => {
  test('missing numbers arrive as unknown with a reason, not as zero', async () => {
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');

    const { body } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
      { candidates: [a, b] }, { 'BAP-Key': keyA });

    for (const c of body.candidates) {
      // tasks carry no cost estimate column at all — the honest answer.
      expect(c.cost.estimated_cost.state).toBe('unknown');
      expect(c.cost.estimated_cost.value).toBeNull();
      expect(c.cost.estimated_cost.reason).toContain('No cost estimate');
      // "not stated" is explicitly distinguished from "zero".
      expect(c.cost.financial_exposure_gbp.state).toBe('unknown');
      expect(c.cost.financial_exposure_gbp.value).toBeNull();
      expect(c.cost.financial_exposure_gbp.reason).toContain('not "zero"');
      // Known fields still carry their citation, so a reader can check them.
      expect(c.policy.approval_tier.citation).toBeTruthy();
    }

    // A dimension nobody has a value for is called out as such rather than
    // quietly presented as agreement.
    expect(body.unknown_dimension_keys).toContain('estimated_cost');
    const dim = body.dimensions.find((d: any) => d.key === 'estimated_cost'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(dim.status).toBe('unknown_for_all');
    expect(dim.values.every((v: any) => v.display === 'unknown' && v.value === null)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Every hole is collected, with a stated reason and an honest state.
    expect(body.missing_data.length).toBeGreaterThan(0);
    for (const m of body.missing_data) {
      expect(['unknown', 'not_comparable']).toContain(m.state);
      expect(m.reason.length).toBeGreaterThan(0);
    }

    // And an unmeasured track record is surfaced as a warning, not smoothed away.
    expect(body.comparability.warnings.map((w: any) => w.code)).toContain('no_measured_track_record'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

// ─── Zero side effects, from the BAP route specifically ──────────────────────

describe('serving a comparison over BAP does nothing', () => {
  test('no execution job, no decision, no approval, no task mutation', async () => {
    const a = insertTask(BIZ_A, 'A', 0.9, 'shopify_page_create');
    const b = insertTask(BIZ_A, 'B', 0.3, 'content_draft');

    const beforeTasks = db.prepare('SELECT id, status, approved_by, approved_at, updated_at FROM tasks WHERE id IN (?, ?) ORDER BY id').all(a, b);
    const beforeSuppressions = (db.prepare('SELECT COUNT(*) AS n FROM applicability_suppressions WHERE business_id = ?').get(BIZ_A) as { n: number }).n;

    // Repeat it — serving a comparison is idempotent and inert.
    for (let i = 0; i < 3; i += 1) {
      const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons`,
        { candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }] }, { 'BAP-Key': keyA });
      expect(status).toBe(200);
    }
    await get(`/api/bap/v1/businesses/${BIZ_A}/comparisons/candidates`, { 'BAP-Key': keyA });

    expect(count('execution_jobs')).toBe(0);
    expect(count('decisions')).toBe(0);
    expect(db.prepare('SELECT id, status, approved_by, approved_at, updated_at FROM tasks WHERE id IN (?, ?) ORDER BY id').all(a, b))
      .toEqual(beforeTasks);
    // Evaluating applicability for the comparison must not suppress a
    // candidate and thereby hide it from future ranking.
    expect((db.prepare('SELECT COUNT(*) AS n FROM applicability_suppressions WHERE business_id = ?').get(BIZ_A) as { n: number }).n)
      .toBe(beforeSuppressions);
    // (bap_audit DOES gain a row per call — that is BAP's own call log, the
    // one write every authenticated BAP request makes, and it records that
    // the comparison was requested, not that anything was decided.)
  });

  test('the route imports nothing that could execute or approve', async () => {
    // The structural twin of comparison-engine.test.ts's import guard. The
    // engine being inert is worth little if a route wrapping it reaches for
    // an executor "just to enrich one field", so the route's import list is
    // asserted too.
    const source = await Bun.file(new URL('./bap-comparisons.ts', import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    const forbidden = imports.filter((spec) => /executor|execution-worker|task-queue|dispatch/i.test(spec));
    expect(forbidden).toEqual([]);
  });

  test('there is no BAP write path behind the comparison surface', async () => {
    // The dashboard's decision endpoint has no BAP counterpart: recording
    // which candidate won writes to `decisions`, and nothing in BAP writes
    // decision memory. Asserted as a route-level 404 so adding one silently
    // is not possible.
    const a = insertTask(BIZ_A, 'A');
    const b = insertTask(BIZ_A, 'B');
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/comparisons/decision`,
      { candidates: [a, b], outcome: 'selected', selected_candidate_id: a, rationale: 'x' }, { 'BAP-Key': keyA });
    expect(status).toBe(404);
    expect(count('decisions')).toBe(0);
  });
});
