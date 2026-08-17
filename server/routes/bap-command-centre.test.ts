/**
 * BAP executive command centre (issue #79) — server/routes/bap-command-centre.ts,
 * exercised against a real Express instance mounting the actual routers.
 *
 * Four properties carry the weight:
 *
 *   1. An authorized agent gets the same cross-business summary shape the
 *      dashboard gets, scoped to the businesses it may actually read — and
 *      the no-selection default means "everything in MY grant", never
 *      everything in the database.
 *   2. Naming a business outside the grant is a hard 403 naming it, not a
 *      partial answer and not a silent inclusion. A summary of three
 *      businesses must never be mistaken for a summary of the five that
 *      were asked about.
 *   3. One business's data-fetch failure does not corrupt or hide another's.
 *      Exercised the way #59's own suite does it: a REAL dependency of the
 *      ROI engine is made to throw for exactly one business id.
 *      attribution-engine.ts calls getBaselines() first thing, so stubbing
 *      that makes computeROIReport() fail from inside its own real code
 *      path — the way an outage would — while every other business runs the
 *      genuine engine end to end. Stubbing assembleCommandCentre itself
 *      would have proved only that a stub behaves like a stub.
 *   4. Freshness and evidence survive the trip through BAP: every section
 *      carries its as_of/data_as_of pair and every item its evidence link,
 *      so an agent can tell a fresh section from a stale one and drill from
 *      any summary line back to the record it came from.
 *
 * bap-decision-queue.ts is mounted on the same app throughout, because
 * `command_centre:read` summarises that surface without conferring it —
 * if the two grants ever converge, it shows up here.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';

const BIZ_A = 'biz_bapcc_alpha';
const BIZ_B = 'biz_bapcc_beta';
const BIZ_POISON = 'biz_bapcc_poison';
const BIZ_OUT = 'biz_bapcc_outsider';
const ALL = [BIZ_A, BIZ_B, BIZ_POISON, BIZ_OUT];

const POISON_MESSAGE = 'Simulated baseline-store failure for the poisoned business.';

// Declared before the modules under test are imported, so they resolve to
// the stub. Returning [] for healthy businesses is truthful here — these
// fixtures record no baselines — so the real ROI engine still runs.
mock.module('../roi/baselines.js', () => ({
  getBaselines: (businessId: string) => {
    if (businessId === BIZ_POISON) throw new Error(POISON_MESSAGE);
    return [];
  },
  getBaseline: () => null,
  getCurrentMetric: () => null,
  recordBaseline: () => undefined,
  captureBaselinesForConnector: () => ({ recorded: 0, skipped: 0 }),
  BASELINE_METRICS_BY_CONNECTOR: {},
}));

const { default: db, generateId } = await import('../db/db.js');
const { RECEIPT_SCHEMA_VERSION, buildCorrelationKey } = await import('../tasks/action-receipts.js');
const {
  generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS,
} = await import('../bap/auth.ts');
const { bapRequestContext } = await import('../bap/route-helpers.ts');
const { bapRateLimit } = await import('../bap/rate-limiter.ts');
const { default: bapCommandCentreRouter } = await import('./bap-command-centre.ts');
const { default: bapDecisionQueueRouter } = await import('./bap-decision-queue.ts');
const { MAX_SELECTION } = await import('../executive/command-centre.js');

/** An id in an agent's grant with no matching `businesses` row. */
const GHOST_ID = 'biz_bapcc_ghost';

const AGENT_IDS = [
  'agt_bapcc_ab', 'agt_bapcc_a', 'agt_bapcc_wildcard',
  'agt_bapcc_nogrant', 'agt_bapcc_nobiz', 'agt_bapcc_queueonly', 'agt_bapcc_ghost',
];

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyAB = '';        // [A, B, POISON] + command_centre:read
let keyA = '';         // [A] only + command_centre:read
let keyWildcard = '';  // ['*'] + command_centre:read
let keyNoGrant = '';   // [A] but holds receipts:read only
let keyNoBiz = '';     // command_centre:read with an EMPTY business_access
let keyQueueOnly = ''; // [A] holds decision_queue:read only
let keyGhost = '';     // [A, GHOST_ID] — a grant naming a business that does not exist

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, key: string): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'BAP-Key': key } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ─── Fixtures (mirroring command-centre.test.ts's, so both suites exercise
//     the same real engine over the same kinds of row) ─────────────────────

function insertBusiness(id: string, name: string, slug: string): void {
  db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .run(id, name, slug);
}

function insertTask(
  businessId: string,
  spec: { status: string; title: string; actionType?: string | null; targetMetric?: string | null; completedAt?: string | null },
): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (
      id, business_id, title, description, proposed_by, status, trust_tier,
      approval_mode, action_type, target_metric, completed_at, version,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'Fixture task for the BAP command centre.', 'agent:test', ?, 'yellow',
      'requires_approval', ?, ?, ?, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, businessId, spec.title, spec.status,
    spec.actionType ?? null, spec.targetMetric ?? null, spec.completedAt ?? null,
  );
  return id;
}

function insertReceipt(businessId: string, taskId: string, stage: 'authorized' | 'executed' | 'verified'): string {
  const id = generateId();
  const executedAt = stage === 'executed' || stage === 'verified' ? new Date().toISOString() : null;
  const verifiedAt = stage === 'verified' ? new Date().toISOString() : null;
  db.prepare(`
    INSERT INTO action_receipts (
      id, receipt_version, business_id, task_id, task_version, correlation_key,
      action_type, title, state, result_status,
      requested_at, authorized_at, authorized_by, executed_at, verified_at,
      anomalies, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 2, ?, 'github_issue', ?, ?, 'success',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dashboard:owner', ?, ?, NULL, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, RECEIPT_SCHEMA_VERSION, businessId, taskId, buildCorrelationKey(taskId, 2),
    `Receipt for ${taskId}`, stage, executedAt, verifiedAt,
  );
  return id;
}

function insertConnector(businessId: string, type: string, name: string, opts: { lastError?: string | null; status?: string } = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, last_sync, last_error, config)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, '{}')
  `).run(id, businessId, type, name, opts.status ?? 'connected', opts.lastError ?? null);
  return id;
}

let verifiedTaskA = '';
let verifiedReceiptA = '';
let proposedTaskA = '';
let proposedTaskB = '';
let proposedTaskOut = '';

beforeAll(async () => {
  insertBusiness(BIZ_A, 'BAPCC Alpha', 'bapcc-alpha');
  insertBusiness(BIZ_B, 'BAPCC Beta', 'bapcc-beta');
  insertBusiness(BIZ_POISON, 'BAPCC Poisoned', 'bapcc-poison');
  insertBusiness(BIZ_OUT, 'BAPCC Outsider', 'bapcc-outsider');

  proposedTaskA = insertTask(BIZ_A, { status: 'proposed', title: 'A: awaiting approval', actionType: 'github_issue' });
  verifiedTaskA = insertTask(BIZ_A, {
    status: 'complete', title: 'A: independently verified', actionType: 'github_issue',
    completedAt: new Date().toISOString(),
  });
  verifiedReceiptA = insertReceipt(BIZ_A, verifiedTaskA, 'verified');
  insertConnector(BIZ_A, 'ga4', 'Alpha GA4', { status: 'error', lastError: 'connection refused' });

  proposedTaskB = insertTask(BIZ_B, { status: 'proposed', title: 'B: awaiting approval', actionType: 'github_issue' });
  insertConnector(BIZ_B, 'gsc', 'Beta GSC');

  // Real rows, but this business's ROI section will throw.
  insertTask(BIZ_POISON, { status: 'proposed', title: 'Poison: awaiting approval', actionType: 'github_issue' });
  insertConnector(BIZ_POISON, 'gsc', 'Poison GSC');

  // A business NO test agent is ever granted — its data must never appear.
  proposedTaskOut = insertTask(BIZ_OUT, { status: 'proposed', title: 'OUTSIDER: must never be visible', actionType: 'github_issue' });

  for (const id of AGENT_IDS) db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);
  keyAB = generateApiKey();
  keyA = generateApiKey();
  keyWildcard = generateApiKey();
  keyNoGrant = generateApiKey();
  keyNoBiz = generateApiKey();
  keyQueueOnly = generateApiKey();
  keyGhost = generateApiKey();

  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_bapcc_ab', 'CC Agent AB', await hashApiKey(keyAB), keyPrefix(keyAB),
    JSON.stringify(['command_centre:read']), JSON.stringify([BIZ_A, BIZ_B, BIZ_POISON]));
  insertAgent.run('agt_bapcc_a', 'CC Agent A', await hashApiKey(keyA), keyPrefix(keyA),
    JSON.stringify(['command_centre:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_bapcc_wildcard', 'CC Wildcard', await hashApiKey(keyWildcard), keyPrefix(keyWildcard),
    JSON.stringify(['command_centre:read']), JSON.stringify(['*']));
  insertAgent.run('agt_bapcc_nogrant', 'CC No Grant', await hashApiKey(keyNoGrant), keyPrefix(keyNoGrant),
    JSON.stringify(['receipts:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_bapcc_nobiz', 'CC No Businesses', await hashApiKey(keyNoBiz), keyPrefix(keyNoBiz),
    JSON.stringify(['command_centre:read']), JSON.stringify([]));
  insertAgent.run('agt_bapcc_queueonly', 'CC Queue Only', await hashApiKey(keyQueueOnly), keyPrefix(keyQueueOnly),
    JSON.stringify(['decision_queue:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_bapcc_ghost', 'CC Ghost Grant', await hashApiKey(keyGhost), keyPrefix(keyGhost),
    JSON.stringify(['command_centre:read']), JSON.stringify([BIZ_A, GHOST_ID]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'),
    bapCommandCentreRouter, bapDecisionQueueRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  const placeholders = ALL.map(() => '?').join(',');
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (${placeholders}))`).run(...ALL);
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id IN (${placeholders}))`).run(...ALL);
  db.prepare(`DELETE FROM action_receipts WHERE business_id IN (${placeholders})`).run(...ALL);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${placeholders})`).run(...ALL);
  db.prepare(`DELETE FROM connectors WHERE business_id IN (${placeholders})`).run(...ALL);
  const agentPlaceholders = AGENT_IDS.map(() => '?').join(',');
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN (${agentPlaceholders})`).run(...AGENT_IDS);
  db.prepare(`DELETE FROM bap_agents WHERE id IN (${agentPlaceholders})`).run(...AGENT_IDS);
});

// ─── The grant ───────────────────────────────────────────────────────────────

describe('command_centre:read grant', () => {
  test('is offered as a read-only grant, with no write counterpart', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('command_centre:read');
    // #59 has no write path; approving from a summary card would skip the
    // policy re-check the decision queue performs at the moment of decision.
    const writeish = GRANTABLE_BAP_PERMISSIONS.filter(
      (p) => p.startsWith('command_centre:') && p !== 'command_centre:read',
    );
    expect(writeish).toEqual([]);
  });

  test('is required — another business-scoped grant does not confer it', async () => {
    const res = await get('/api/bap/v1/command-centre', keyNoGrant);
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('command_centre:read');
  });

  test('does not itself confer the surfaces it summarises', async () => {
    // The command centre returns a bounded sample of the decision queue.
    // Holding it must not open the full queue, or the grant separation is
    // decorative.
    const res = await get(`/api/bap/v1/businesses/${BIZ_A}/decision-queue`, keyAB);
    expect(res.status).toBe(403);
  });

  test('and the queue grant does not confer the command centre', async () => {
    const res = await get('/api/bap/v1/command-centre', keyQueueOnly);
    expect(res.status).toBe(403);
  });
});

// ─── 1. Authorized multi-business assembly, correctly scoped ─────────────────

describe('authorized multi-business summary', () => {
  test('returns one summary row per selected business, same shape as the dashboard', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A},${BIZ_B}`, keyAB);
    expect(res.status).toBe(200);

    expect(res.body.businesses.length).toBe(2);
    expect(res.body.businesses.map((b: any) => b.business_id).sort()).toEqual([BIZ_A, BIZ_B].sort());
    expect(res.body.requested_business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());

    const a = res.body.businesses.find((b: any) => b.business_id === BIZ_A);
    expect(a.business_name).toBe('BAPCC Alpha');
    expect(a.status).toBe('ok');
    for (const s of ['decisions', 'work_states', 'verified_changes', 'outcomes', 'connectors']) {
      expect(a[s].status).toBe('ok');
    }

    // The cross-business pieces the agent came for.
    expect(res.body.portfolio_totals.pending_decisions).toBeGreaterThanOrEqual(2);
    expect(res.body.portfolio_totals.businesses_ok).toBe(2);
    expect(Array.isArray(res.body.attention)).toBe(true);
    expect(res.body.window_days).toBe(30);
  });

  test('accepts repeated business_ids params as well as a comma list', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A}&business_ids=${BIZ_B}`, keyAB);
    expect(res.status).toBe(200);
    expect(res.body.businesses.map((b: any) => b.business_id).sort()).toEqual([BIZ_A, BIZ_B].sort());
  });

  test('honours window_days and sample_size', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A}&window_days=7&sample_size=1`, keyAB);
    expect(res.status).toBe(200);
    expect(res.body.window_days).toBe(7);
    const a = res.body.businesses[0];
    expect(a.decisions.data.items.length).toBeLessThanOrEqual(1);
  });

  test('rejects a non-numeric window_days rather than guessing', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A}&window_days=lots`, keyAB);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
  });
});

// ─── 2. Scoping: the grant is the accessible set ─────────────────────────────

describe('selection is scoped to the agent business_access grant', () => {
  test('no selection means every business in MY grant, not every business', async () => {
    const res = await get('/api/bap/v1/command-centre', keyA);
    expect(res.status).toBe(200);
    // The agent is granted only A. B, POISON and OUT all exist and all have
    // pending work; none may appear.
    expect(res.body.businesses.map((b: any) => b.business_id)).toEqual([BIZ_A]);
    expect(res.body.granted_business_ids).toEqual([BIZ_A]);

    const serialized = JSON.stringify(res.body);
    for (const hidden of [BIZ_B, BIZ_POISON, BIZ_OUT, proposedTaskB, proposedTaskOut]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  test('the totals for a narrow grant cover only that grant', async () => {
    const res = await get('/api/bap/v1/command-centre', keyA);
    expect(res.body.portfolio_totals.businesses_ok
      + res.body.portfolio_totals.businesses_degraded
      + res.body.portfolio_totals.businesses_unavailable).toBe(1);
  });

  test('a wildcard grant sees every business', async () => {
    const res = await get('/api/bap/v1/command-centre', keyWildcard);
    expect(res.status).toBe(200);
    const ids = res.body.businesses.map((b: any) => b.business_id);
    for (const id of ALL) expect(ids).toContain(id);
  });

  test('an agent with the grant but no businesses is refused, not shown everything', async () => {
    // The dangerous failure mode: an empty business_access falling through
    // to "every business I can see".
    const res = await get('/api/bap/v1/command-centre', keyNoBiz);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_denied');
    expect(JSON.stringify(res.body)).not.toContain(BIZ_A);
  });
});

// ─── 3. Out-of-grant ids: hard 403, naming them ──────────────────────────────

describe('a business outside the grant', () => {
  test('is a 403 naming it, not a partial summary of the rest', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A},${BIZ_B}`, keyA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_denied');
    expect(res.body.denied_business_ids).toEqual([BIZ_B]);

    // The critical assertion: no summary at all came back. Serving the one
    // business that WAS allowed would be indistinguishable, to the caller,
    // from "you asked about two and only one has anything".
    expect(res.body.businesses).toBeUndefined();
    expect(res.body.portfolio_totals).toBeUndefined();
  });

  test('names every offending id, so the caller can fix the selection in one round trip', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A},${BIZ_B},${BIZ_OUT}`, keyA);
    expect(res.status).toBe(403);
    expect(res.body.denied_business_ids.sort()).toEqual([BIZ_B, BIZ_OUT].sort());
  });

  test('leaks nothing about whether the id exists', async () => {
    const real = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_OUT}`, keyA);
    const fake = await get('/api/bap/v1/command-centre?business_ids=biz_bapcc_not_a_real_id', keyA);
    expect(real.status).toBe(403);
    expect(fake.status).toBe(403);
    // Same status and same code for a real business and an invented one.
    expect(real.body.code).toBe(fake.body.code);
    // And no business name or task title from the real one is disclosed.
    expect(JSON.stringify(real.body)).not.toContain('BAPCC Outsider');
    expect(JSON.stringify(real.body)).not.toContain('must never be visible');
  });

  test('points the caller at /scope rather than leaving it to guess', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_OUT}`, keyA);
    expect(String(res.body.error)).toContain('/command-centre/scope');
  });
});

// ─── /scope ──────────────────────────────────────────────────────────────────

describe('GET /command-centre/scope', () => {
  test('reports exactly what this agent may select, and the cap', async () => {
    const res = await get('/api/bap/v1/command-centre/scope', keyA);
    expect(res.status).toBe(200);
    expect(res.body.granted_business_ids).toEqual([BIZ_A]);
    expect(res.body.businesses.map((b: any) => b.id)).toEqual([BIZ_A]);
    expect(res.body.max_selection).toBe(MAX_SELECTION);
    expect(JSON.stringify(res.body)).not.toContain(BIZ_B);
  });

  test('a selection built from /scope is accepted by the summary endpoint', async () => {
    const scope = await get('/api/bap/v1/command-centre/scope', keyAB);
    const ids = scope.body.granted_business_ids.join(',');
    const res = await get(`/api/bap/v1/command-centre?business_ids=${ids}`, keyAB);
    expect(res.status).toBe(200);
    expect(res.body.businesses.length).toBe(scope.body.granted_business_ids.length);
  });
});

// ─── 4. Failure isolation, through the route ─────────────────────────────────

describe("one business's failure does not corrupt or hide another's", () => {
  test('the poisoned ROI section fails alone, leaving its own siblings real', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_POISON}`, keyAB);
    expect(res.status).toBe(200); // not a 500 — the request itself succeeded

    const poison = res.body.businesses[0];
    expect(poison.status).toBe('degraded');
    expect(poison.failed_sections).toEqual(['outcomes']);
    expect(poison.outcomes.status).toBe('failed');
    expect(poison.outcomes.error.message).toContain(POISON_MESSAGE);
    expect(poison.outcomes.data).toBeNull();

    // Everything else on the SAME business is genuine.
    expect(poison.decisions.status).toBe('ok');
    expect(poison.decisions.data.total).toBeGreaterThan(0);
    expect(poison.work_states.status).toBe('ok');
    expect(poison.verified_changes.status).toBe('ok');
    expect(poison.connectors.status).toBe('ok');
  });

  test('the healthy businesses in the same request are untouched', async () => {
    const res = await get(
      `/api/bap/v1/command-centre?business_ids=${BIZ_A},${BIZ_POISON},${BIZ_B}`, keyAB,
    );
    expect(res.status).toBe(200);
    expect(res.body.businesses.length).toBe(3);

    const a = res.body.businesses.find((b: any) => b.business_id === BIZ_A);
    const b = res.body.businesses.find((b: any) => b.business_id === BIZ_B);
    const poison = res.body.businesses.find((b: any) => b.business_id === BIZ_POISON);

    expect(poison.status).toBe('degraded');
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(a.outcomes.status).toBe('ok');
    expect(b.outcomes.status).toBe('ok');
    expect(a.decisions.data.total).toBeGreaterThan(0);
    expect(b.decisions.data.total).toBeGreaterThan(0);

    // A's real data is identical to what it is when asked for alone — the
    // neighbour's outage did not degrade it.
    const alone = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A}`, keyAB);
    const aAlone = alone.body.businesses[0];
    expect(a.decisions.data.total).toBe(aAlone.decisions.data.total);
    expect(a.work_states.data.counts).toEqual(aAlone.work_states.data.counts);
    expect(a.verified_changes.data.verified_count).toBe(aAlone.verified_changes.data.verified_count);
  });

  test('the failure is stated in the totals rather than quietly omitted', async () => {
    const res = await get(
      `/api/bap/v1/command-centre?business_ids=${BIZ_A},${BIZ_POISON},${BIZ_B}`, keyAB,
    );
    const totals = res.body.portfolio_totals;
    expect(totals.businesses_ok).toBe(2);
    expect(totals.businesses_degraded).toBe(1);
    // A total computed over a partial set must never read as complete.
    const excluded = totals.excluded.find(
      (e: any) => e.business_id === BIZ_POISON && e.section === 'outcomes',
    );
    expect(excluded).toBeTruthy();
    expect(excluded.reason).toContain(POISON_MESSAGE);
  });

  test('the failure raises an attention item, so "broken" differs from "clean"', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_POISON}`, keyAB);
    const alert = res.body.attention.find((a: any) => a.id === `section_failed:${BIZ_POISON}:outcomes`);
    expect(alert).toBeTruthy();
    expect(alert.severity).toBe('high');
    expect(alert.detail).toContain('Everything else on this business is real');
  });

  test('a granted business that does not exist is one unavailable row, not a 403', async () => {
    // Deliberately distinct from the out-of-grant 403 above. This id IS in
    // the agent's grant, so refusing the request would misreport a data
    // problem as a permissions one — and only its own row is lost.
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A},${GHOST_ID}`, keyGhost);
    expect(res.status).toBe(200);
    expect(res.body.businesses.length).toBe(2);

    const ghost = res.body.businesses.find((b: any) => b.business_id === GHOST_ID);
    expect(ghost.status).toBe('unavailable');
    expect(ghost.unavailable_reason).toContain(GHOST_ID);

    const a = res.body.businesses.find((b: any) => b.business_id === BIZ_A);
    expect(a.status).toBe('ok');
    expect(a.decisions.data.total).toBeGreaterThan(0);

    // And the totals say so rather than quietly counting one business.
    expect(res.body.portfolio_totals.businesses_unavailable).toBe(1);
    expect(res.body.portfolio_totals.excluded.some(
      (e: any) => e.business_id === GHOST_ID && e.section === 'all',
    )).toBe(true);
  });

  test('a grant naming a missing business is surfaced by /scope too', async () => {
    const res = await get('/api/bap/v1/command-centre/scope', keyGhost);
    expect(res.status).toBe(200);
    expect(res.body.unknown_business_ids).toEqual([GHOST_ID]);
    expect(res.body.granted_business_ids).toContain(GHOST_ID);
    expect(res.body.businesses.map((b: any) => b.id)).toEqual([BIZ_A]);
  });
});

// ─── 5. Freshness and evidence survive the trip ──────────────────────────────

describe('freshness and evidence links', () => {
  test('every section carries both timestamps, computed-at and data-as-of', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A},${BIZ_B}`, keyAB);
    for (const b of res.body.businesses) {
      for (const name of ['decisions', 'work_states', 'verified_changes', 'outcomes', 'connectors']) {
        const env = b[name];
        // as_of is always populated — the UI must be able to say when we tried.
        expect(typeof env.as_of).toBe('string');
        expect(Number.isFinite(Date.parse(env.as_of))).toBe(true);
        // data_as_of is present as a key even when null: "we have no source
        // record" is an answer, and must not be confused with "we forgot".
        expect(Object.hasOwn(env, 'data_as_of')).toBe(true);
        expect(env.data_as_of === null || typeof env.data_as_of === 'string').toBe(true);
      }
    }
  });

  test('a section computed now from older data reports the older data_as_of', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A}`, keyAB);
    const vc = res.body.businesses[0].verified_changes;
    expect(vc.status).toBe('ok');
    expect(vc.data_as_of).toBeTruthy();
    // Computed no earlier than the newest record behind it — the two are
    // genuinely different timestamps, not one value copied twice.
    expect(Date.parse(vc.as_of)).toBeGreaterThanOrEqual(Date.parse(vc.data_as_of));
  });

  test('each summary item links back to the real record it came from', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A}`, keyAB);
    const a = res.body.businesses[0];

    const decision = a.decisions.data.items.find((i: any) => i.task_id === proposedTaskA);
    expect(decision).toBeTruthy();
    expect(decision.evidence).toMatchObject({
      kind: 'decision', id: proposedTaskA, business_id: BIZ_A,
    });
    expect(decision.evidence.href).toContain(encodeURIComponent(proposedTaskA));

    // A receipt-backed change points at the RECEIPT id, not the task id —
    // the receipt is the record that attests the change actually happened.
    const change = a.verified_changes.data.items.find((i: any) => i.receipt_id === verifiedReceiptA);
    expect(change).toBeTruthy();
    expect(change.evidence).toMatchObject({ kind: 'receipt', id: verifiedReceiptA, business_id: BIZ_A });
    expect(change.independently_verified).toBe(true);
    expect(change.occurred_at).toBeTruthy();

    // And every ranked attention item is drillable too.
    for (const item of res.body.attention) {
      expect(typeof item.evidence.kind).toBe('string');
      expect(typeof item.evidence.id).toBe('string');
      expect(typeof item.evidence.href).toBe('string');
    }
  });

  test('the work ladder keeps its five states distinct through BAP', async () => {
    const res = await get(`/api/bap/v1/command-centre?business_ids=${BIZ_A}`, keyAB);
    const counts = res.body.businesses[0].work_states.data.counts;
    for (const s of ['proposed', 'approved', 'executed', 'verified', 'outcome_measured']) {
      expect(typeof counts[s]).toBe('number');
    }
    // The verified receipt must not have been collapsed into 'executed'.
    expect(counts.verified).toBeGreaterThanOrEqual(1);
    expect(counts.proposed).toBeGreaterThanOrEqual(1);
  });
});
