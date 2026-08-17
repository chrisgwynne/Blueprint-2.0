/**
 * BAP multi-business portfolios (issue #80) — server/routes/bap-portfolios.ts,
 * exercised against a real Express instance mounting the actual router.
 *
 * Four properties carry the weight here:
 *
 *   1. SCOPE       an agent sees portfolios through its own `business_access`
 *                  grant, not through whatever portfolios happen to exist. The
 *                  ambient resolver in #71's registry still returns every
 *                  business (no ACL exists yet), so if this route did not
 *                  apply the grant itself, every test below would leak.
 *   2. HONESTY     `not_comparable` survives the trip to the agent intact —
 *                  distinct from `unknown`, distinct from zero, with no
 *                  ranked number anywhere for an agent to read off.
 *   3. PARTIAL     a portfolio containing a business outside the grant returns
 *                  the accessible slice, explicitly marked incomplete, and
 *                  leaks nothing about the rest.
 *   4. ISOLATION   two agents with disjoint access see disjoint portfolios,
 *                  including by direct id.
 *
 * Scope is driven through real bap_agents rows and real API keys rather than
 * setBusinessScopeResolver(): the resolver seam is process-global and #71's
 * own suites drive it, so using it here would prove nothing about the grant
 * this route is supposed to enforce.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapPortfoliosRouter from './bap-portfolios.ts';
import {
  addPortfolioMembers, createPortfolio, deletePortfolio,
} from '../portfolio/portfolio-registry.js';
import { getOrCreateBusinessProfile, updateBusinessProfile } from '../business/business-profile.js';

/** In the agent's grant, ecommerce. */
const BIZ_A = 'biz_bap_pf_a';
/** In the agent's grant, service — the type mismatch that forces not_comparable. */
const BIZ_B = 'biz_bap_pf_b';
/** NOT in the agent's grant. Nothing about it may ever reach agent A. */
const BIZ_SECRET = 'biz_bap_pf_secret';
const ALL_BIZ = [BIZ_A, BIZ_B, BIZ_SECRET];

const AGENT_IDS = ['agt_pf_a', 'agt_pf_secret', 'agt_pf_nogrant'];
const OWNER = 'dashboard:owner';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string;        // business_access [BIZ_A, BIZ_B], holds portfolios:read
let keySecret: string;   // business_access [BIZ_SECRET], holds portfolios:read
let keyNoGrant: string;  // business_access [BIZ_A, BIZ_B], holds tasks:read only

let pMixed = '';    // [BIZ_A, BIZ_B]      — wholly inside agent A's grant
let pPartial = '';  // [BIZ_A, BIZ_SECRET] — partly outside it
let pForeign = '';  // [BIZ_SECRET]        — wholly outside it

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, key: string): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'BAP-Key': key } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertGoal(businessId: string, title: string, progress: number): void {
  db.prepare(`
    INSERT INTO goals (id, business_id, title, status, progress_pct, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(generateId(), businessId, title, progress);
}

function insertCost(businessId: string, usd: number): void {
  db.prepare(`
    INSERT INTO cost_daily (id, date, agent_id, business_id, provider, cost_usd, run_count)
    VALUES (?, ?, 'agent_test', ?, 'anthropic', ?, 1)
  `).run(generateId(), new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10), businessId, usd);
}

function metricOf(body: any, key: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = body.metrics.find((x: { key: string }) => x.key === key);
  if (!m) throw new Error(`No metric '${key}' in comparison.`);
  return m;
}

beforeAll(async () => {
  const rows: Array<[string, string, string]> = [
    [BIZ_A, 'BAP PF Shop', 'bap-pf-shop'],
    [BIZ_B, 'BAP PF Agency', 'bap-pf-agency'],
    [BIZ_SECRET, 'BAP PF Secret', 'bap-pf-secret'],
  ];
  for (const [id, name, slug] of rows) {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, name, slug);
    getOrCreateBusinessProfile(id);
  }
  // Differing business types are what make the derivation-sensitive currency
  // metrics not_comparable — an ecommerce revenue figure and a service
  // business's proxy-derived figure are both "$/month" and are not the same
  // kind of number.
  updateBusinessProfile(BIZ_A, { business_type: 'ecommerce' });
  updateBusinessProfile(BIZ_B, { business_type: 'service' });
  updateBusinessProfile(BIZ_SECRET, { business_type: 'ecommerce' });

  insertGoal(BIZ_A, 'Shop goal', 80);
  insertGoal(BIZ_B, 'Agency goal', 20);
  // BIZ_SECRET deliberately gets a distinctive cost figure: if it ever
  // contributed to an aggregate agent A can see, the number would show it.
  insertCost(BIZ_A, 11.5);
  insertCost(BIZ_B, 4.25);
  insertCost(BIZ_SECRET, 999.99);

  pMixed = createPortfolio({ name: 'BAP PF Mixed', business_ids: [BIZ_A, BIZ_B], actor: OWNER }).id;
  pPartial = createPortfolio({ name: 'BAP PF Partial', business_ids: [BIZ_A, BIZ_SECRET], actor: OWNER }).id;
  pForeign = createPortfolio({ name: 'BAP PF Foreign', business_ids: [BIZ_SECRET], actor: OWNER }).id;

  for (const id of AGENT_IDS) db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);
  keyA = generateApiKey();
  keySecret = generateApiKey();
  keyNoGrant = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_pf_a', 'PF Agent A', await hashApiKey(keyA), keyPrefix(keyA),
    JSON.stringify(['portfolios:read']), JSON.stringify([BIZ_A, BIZ_B]));
  insertAgent.run('agt_pf_secret', 'PF Agent Secret', await hashApiKey(keySecret), keyPrefix(keySecret),
    JSON.stringify(['portfolios:read']), JSON.stringify([BIZ_SECRET]));
  insertAgent.run('agt_pf_nogrant', 'PF No Grant', await hashApiKey(keyNoGrant), keyPrefix(keyNoGrant),
    JSON.stringify(['tasks:read']), JSON.stringify([BIZ_A, BIZ_B]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapPortfoliosRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  for (const id of [pMixed, pPartial, pForeign]) {
    try { deletePortfolio(id, OWNER); } catch { /* already gone */ }
    db.prepare('DELETE FROM portfolio_membership_events WHERE portfolio_id = ?').run(id);
  }
  for (const id of ALL_BIZ) {
    db.prepare('DELETE FROM goals WHERE business_id = ?').run(id);
    db.prepare('DELETE FROM cost_daily WHERE business_id = ?').run(id);
  }
  const placeholders = AGENT_IDS.map(() => '?').join(', ');
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN (${placeholders})`).run(...AGENT_IDS);
  db.prepare(`DELETE FROM bap_agents WHERE id IN (${placeholders})`).run(...AGENT_IDS);
});

// ─── The grant ───────────────────────────────────────────────────────────────

describe('portfolios:read grant', () => {
  test('is offered as a read-only grant, with no write counterpart', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('portfolios:read');
    expect(GRANTABLE_BAP_PERMISSIONS.filter((p) => p.startsWith('portfolios:'))).toEqual(['portfolios:read']);
  });

  test('is distinct from operating_policies:read — #68 policy portfolios are a different concept', () => {
    // Both grants exist and neither implies the other: #68's portfolios
    // partition businesses for policy inheritance, #71's overlap for
    // reporting. An agent that wants both must be granted both.
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('operating_policies:read');
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('portfolios:read');
  });

  test('an agent without the grant is refused on every endpoint', async () => {
    for (const path of ['/api/bap/v1/portfolios', `/api/bap/v1/portfolios/${pMixed}`, `/api/bap/v1/portfolios/${pMixed}/comparison`]) {
      const res = await get(path, keyNoGrant);
      expect(res.status).toBe(403);
    }
  });

  test('no key at all is a 401', async () => {
    const res = await fetch(`${baseUrl}/api/bap/v1/portfolios`);
    expect(res.status).toBe(401);
  });
});

// ─── Listing is filtered by the agent's business_access ──────────────────────

describe('GET /portfolios', () => {
  test('lists portfolios containing a business the agent may read', async () => {
    const res = await get('/api/bap/v1/portfolios', keyA);
    expect(res.status).toBe(200);
    const ids = res.body.portfolios.map((p: { id: string }) => p.id);
    expect(ids).toContain(pMixed);
    expect(ids).toContain(pPartial);
  });

  test('omits a portfolio in which the agent can read nothing', async () => {
    const res = await get('/api/bap/v1/portfolios', keyA);
    const ids = res.body.portfolios.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(pForeign);
    // …and the inaccessible business is nowhere in the payload at all.
    expect(JSON.stringify(res.body)).not.toContain(BIZ_SECRET);
  });

  test('total counts what was returned, never what exists', async () => {
    const res = await get('/api/bap/v1/portfolios', keyA);
    expect(res.body.total).toBe(res.body.portfolios.length);
  });

  test('marks a wholly-accessible portfolio complete and a partial one not', async () => {
    const res = await get('/api/bap/v1/portfolios', keyA);
    const mixed = res.body.portfolios.find((p: { id: string }) => p.id === pMixed);
    const partial = res.body.portfolios.find((p: { id: string }) => p.id === pPartial);

    expect(mixed.access.complete).toBe(true);
    expect(mixed.access.excluded_member_count).toBe(0);
    expect(mixed.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());

    expect(partial.access.complete).toBe(false);
    expect(partial.access.excluded_member_count).toBe(1);
    expect(partial.business_ids).toEqual([BIZ_A]);
    expect(res.body.partial_portfolios).toBeGreaterThanOrEqual(1);
  });

  test('two agents with disjoint access see disjoint portfolios', async () => {
    const mine = await get('/api/bap/v1/portfolios', keyA);
    const theirs = await get('/api/bap/v1/portfolios', keySecret);

    const myIds = mine.body.portfolios.map((p: { id: string }) => p.id);
    const theirIds = theirs.body.portfolios.map((p: { id: string }) => p.id);

    expect(myIds).toContain(pMixed);
    expect(theirIds).not.toContain(pMixed);
    expect(theirIds).toContain(pForeign);
    expect(myIds).not.toContain(pForeign);

    // pPartial is visible to both, but each sees only its own slice.
    const myPartial = mine.body.portfolios.find((p: { id: string }) => p.id === pPartial);
    const theirPartial = theirs.body.portfolios.find((p: { id: string }) => p.id === pPartial);
    expect(myPartial.business_ids).toEqual([BIZ_A]);
    expect(theirPartial.business_ids).toEqual([BIZ_SECRET]);
  });
});

// ─── One portfolio, plus its membership history ─────────────────────────────

describe('GET /portfolios/:id', () => {
  test('returns membership and the membership-change history', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pMixed}`, keyA);
    expect(res.status).toBe(200);
    expect(res.body.portfolio.id).toBe(pMixed);
    expect(res.body.portfolio.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());

    // createPortfolio records an 'added' event per founding member.
    const actions = res.body.membership_history.map((e: { action: string }) => e.action);
    expect(actions).toContain('added');
    const businesses = res.body.membership_history.map((e: { business_id: string }) => e.business_id);
    expect(businesses.sort()).toEqual([BIZ_A, BIZ_B].sort());
    expect(res.body.membership_history[0].business_name).toBeTruthy();
  });

  test('a later membership change appears in the history', async () => {
    const temp = createPortfolio({ name: 'BAP PF Temp', business_ids: [BIZ_A], actor: OWNER });
    try {
      addPortfolioMembers(temp.id, [BIZ_B], OWNER, 'Added for the Q3 review.');
      const res = await get(`/api/bap/v1/portfolios/${temp.id}`, keyA);
      const added = res.body.membership_history.find(
        (e: { business_id: string; action: string }) => e.business_id === BIZ_B && e.action === 'added',
      );
      expect(added).toBeTruthy();
      expect(added.reason).toBe('Added for the Q3 review.');
      // Newest first, so the later change leads.
      expect(res.body.membership_history[0].business_id).toBe(BIZ_B);
    } finally {
      deletePortfolio(temp.id, OWNER);
      db.prepare('DELETE FROM portfolio_membership_events WHERE portfolio_id = ?').run(temp.id);
    }
  });

  test('history about an inaccessible business is withheld, not just its membership', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pPartial}`, keyA);
    expect(res.status).toBe(200);
    expect(res.body.portfolio.business_ids).toEqual([BIZ_A]);
    expect(res.body.access.complete).toBe(false);
    expect(res.body.access.excluded_member_count).toBe(1);
    for (const event of res.body.membership_history) {
      expect(event.business_id).toBe(BIZ_A);
    }
    expect(JSON.stringify(res.body)).not.toContain(BIZ_SECRET);
    expect(JSON.stringify(res.body)).not.toContain('BAP PF Secret');
  });

  test('history_limit=0 omits the history; a bad value is a 400', async () => {
    const none = await get(`/api/bap/v1/portfolios/${pMixed}?history_limit=0`, keyA);
    expect(none.status).toBe(200);
    expect(none.body.membership_history).toEqual([]);

    const bad = await get(`/api/bap/v1/portfolios/${pMixed}?history_limit=-4`, keyA);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation_error');
  });

  test('a portfolio with no accessible member is refused, not returned empty', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pForeign}`, keyA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_denied');
    expect(JSON.stringify(res.body)).not.toContain(BIZ_SECRET);
  });

  test('an unknown portfolio is a 404', async () => {
    const res = await get('/api/bap/v1/portfolios/portfolio_does_not_exist', keyA);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});

// ─── The comparison, and its honesty markings ───────────────────────────────

describe('GET /portfolios/:id/comparison', () => {
  test('returns the per-metric comparative view over the portfolio', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pMixed}/comparison`, keyA);
    expect(res.status).toBe(200);
    expect(res.body.portfolio.id).toBe(pMixed);
    expect(res.body.businesses.map((b: { business_id: string }) => b.business_id).sort())
      .toEqual([BIZ_A, BIZ_B].sort());
    expect(res.body.metrics.length).toBeGreaterThan(0);
    expect(res.body.window_days).toBe(30);

    // One row per metric, one cell per business — the layout is the comparison.
    for (const m of res.body.metrics) {
      expect(m.cells.map((c: { business_id: string }) => c.business_id).sort())
        .toEqual([BIZ_A, BIZ_B].sort());
    }
  });

  test('a comparable metric is ranked and totalled', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pMixed}/comparison`, keyA);
    const spend = metricOf(res.body, 'blueprint_spend_usd');
    expect(spend.comparability).toBe('comparable');
    expect(spend.ranking).toEqual([BIZ_B, BIZ_A]); // lower_is_better: 4.25 then 11.50
    expect(spend.aggregate.field.state).toBe('known');
    expect(spend.aggregate.field.value).toBeCloseTo(15.75, 2);
    expect(spend.aggregate.included_business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());
  });

  test('not_comparable survives to the agent as its own state, not null or zero', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pMixed}/comparison`, keyA);
    const value = metricOf(res.body, 'attributed_value_usd_per_month');

    expect(value.comparability).toBe('not_comparable');
    expect(value.comparability_reason).toBeTruthy();
    expect(value.incompatible_groups).toBeTruthy();

    // The aggregate is marked, not blanked: a distinct state plus a reason.
    expect(value.aggregate.field.state).toBe('not_comparable');
    expect(value.aggregate.field.state).not.toBe('unknown');
    expect(value.aggregate.field.reason).toBeTruthy();
    expect(value.aggregate.field.value).toBeNull();
    expect(value.aggregate.field.value).not.toBe(0);
    expect(value.aggregate.included_business_ids).toEqual([]);
  });

  test('a not_comparable metric offers the agent no ranked number at all', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pMixed}/comparison`, keyA);
    for (const m of res.body.metrics) {
      if (m.comparability !== 'not_comparable') continue;
      expect(m.ranking).toBeNull();
      // Per-business cells are still present — they are just not ordered.
      expect(m.cells.length).toBe(2);
      for (const c of m.cells) expect(c.rank).toBeNull();
      // And every such row is named up front so it cannot be missed.
      expect(res.body.coverage.not_comparable_metrics.map((n: { key: string }) => n.key)).toContain(m.key);
    }
    expect(res.body.coverage.not_comparable_metrics.length).toBeGreaterThan(0);
    for (const n of res.body.coverage.not_comparable_metrics) expect(n.reason).toBeTruthy();
  });

  test('unknown and not_comparable stay distinguishable, and neither reads as zero', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pMixed}/comparison`, keyA);
    const states = new Set<string>();
    for (const m of res.body.metrics) for (const c of m.cells) states.add(c.field.state);
    expect(states.has('unknown')).toBe(true);

    for (const m of res.body.metrics) {
      for (const c of m.cells) {
        expect(['known', 'unknown', 'not_comparable']).toContain(c.field.state);
        if (c.field.state === 'known') {
          expect(c.field.citation).toBeTruthy();
        } else {
          // Never substituted with a number — the reason travels instead.
          expect(c.field.value).toBeNull();
          expect(c.field.reason).toBeTruthy();
        }
        // Drill-down never depends on a value existing.
        expect(c.evidence).toBeTruthy();
      }
    }
  });

  test('caveats are carried verbatim so the table cannot be over-read', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pMixed}/comparison`, keyA);
    expect(Array.isArray(res.body.caveats)).toBe(true);
    expect(res.body.caveats.join(' ')).toContain('not ranked or totalled');
    expect(Array.isArray(res.body.membership_changes_in_window)).toBe(true);
  });

  test('window_days is honoured, and a non-numeric one is a 400', async () => {
    const ok = await get(`/api/bap/v1/portfolios/${pMixed}/comparison?window_days=7`, keyA);
    expect(ok.status).toBe(200);
    expect(ok.body.window_days).toBe(7);

    const bad = await get(`/api/bap/v1/portfolios/${pMixed}/comparison?window_days=soon`, keyA);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation_error');
  });
});

// ─── A partially-inaccessible portfolio ─────────────────────────────────────

describe('a portfolio containing a business outside the grant', () => {
  test('compares the accessible slice only, and says so', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pPartial}/comparison`, keyA);
    expect(res.status).toBe(200);
    expect(res.body.portfolio.business_ids).toEqual([BIZ_A]);
    expect(res.body.portfolio.hidden_member_count).toBe(1);
    expect(res.body.access.complete).toBe(false);
    expect(res.body.access.excluded_member_count).toBe(1);
    expect(res.body.access.visible_member_count).toBe(1);
    expect(res.body.caveats.join(' ')).toContain('outside your access');
  });

  test('the inaccessible business contributes to no cell, rank or total', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pPartial}/comparison`, keyA);
    for (const m of res.body.metrics) {
      expect(m.cells.map((c: { business_id: string }) => c.business_id)).toEqual([BIZ_A]);
      expect(m.aggregate.included_business_ids.every((id: string) => id === BIZ_A)).toBe(true);
    }
    const spend = metricOf(res.body, 'blueprint_spend_usd');
    // BIZ_SECRET's 999.99 must be nowhere near this total.
    expect(spend.aggregate.field.value).toBeCloseTo(11.5, 2);
  });

  test('nothing identifying the inaccessible business appears anywhere in the payload', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pPartial}/comparison`, keyA);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(BIZ_SECRET);
    expect(raw).not.toContain('BAP PF Secret');
    expect(raw).not.toContain('999.99');
  });

  test('a portfolio with no accessible member is refused rather than compared', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pForeign}/comparison`, keyA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_denied');
    expect(JSON.stringify(res.body)).not.toContain(BIZ_SECRET);
  });
});

// ─── Cross-business isolation ───────────────────────────────────────────────

describe('cross-business isolation', () => {
  test('an agent cannot reach another business’s portfolio by guessing its id', async () => {
    for (const path of [`/api/bap/v1/portfolios/${pForeign}`, `/api/bap/v1/portfolios/${pForeign}/comparison`]) {
      const res = await get(path, keyA);
      expect(res.status).toBe(403);
    }
    // …and the reverse direction is refused just as firmly.
    for (const path of [`/api/bap/v1/portfolios/${pMixed}`, `/api/bap/v1/portfolios/${pMixed}/comparison`]) {
      const res = await get(path, keySecret);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(BIZ_A);
    }
  });

  test('the other agent sees only its own slice of the shared portfolio', async () => {
    const res = await get(`/api/bap/v1/portfolios/${pPartial}/comparison`, keySecret);
    expect(res.status).toBe(200);
    expect(res.body.portfolio.business_ids).toEqual([BIZ_SECRET]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(BIZ_A);
    expect(raw).not.toContain('BAP PF Shop');
  });
});

// ─── Read-only by construction ──────────────────────────────────────────────

describe('read-only surface', () => {
  test('there is no BAP path to create, change or delete a portfolio', async () => {
    const attempts: Array<[string, string]> = [
      ['POST', '/api/bap/v1/portfolios'],
      ['PATCH', `/api/bap/v1/portfolios/${pMixed}`],
      ['DELETE', `/api/bap/v1/portfolios/${pMixed}`],
      ['POST', `/api/bap/v1/portfolios/${pMixed}/members`],
      ['DELETE', `/api/bap/v1/portfolios/${pMixed}/members`],
    ];
    for (const [method, path] of attempts) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'BAP-Key': keyA, 'Content-Type': 'application/json' },
        body: method === 'POST' || method === 'PATCH'
          ? JSON.stringify({ name: 'x', business_ids: [BIZ_A] })
          : undefined,
      });
      expect(res.status).toBe(404);
    }
    // The portfolio is untouched by all of that.
    const after = await get(`/api/bap/v1/portfolios/${pMixed}`, keyA);
    expect(after.status).toBe(200);
    expect(after.body.portfolio.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());
  });

  test('the router imports no portfolio write path', async () => {
    const src = await Bun.file(`${import.meta.dir}/bap-portfolios.ts`).text();
    for (const forbidden of [
      'createPortfolio', 'updatePortfolio', 'deletePortfolio',
      'addPortfolioMembers', 'removePortfolioMembers', 'importPolicyPortfolio',
    ]) {
      expect(src.includes(`  ${forbidden},`)).toBe(false);
    }
    // And it reads #71's registry, never #68's policy-portfolio table. The
    // docstring names operating_policy_portfolios to say what this is NOT,
    // so the check is on the imports rather than on the prose.
    expect(src).toContain("from '../portfolio/portfolio-registry.js'");
    expect(src).toContain("from '../portfolio/portfolio-comparison.js'");
    expect(src).not.toContain("from '../policy/operating-policy.js'");
    expect(src).not.toContain('getPolicyPortfolio(');
  });
});
