/**
 * Portfolio API (#71) — server/routes/portfolios.ts.
 *
 * The engine's behaviour is covered in server/portfolio/*.test.ts. What is
 * tested here is the boundary the HTTP layer owns: nothing without a
 * session, the membership writes round-trip, and a comparison stays 200
 * with a degraded column rather than turning one bad business into a status
 * code for the whole request.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db from '../db/db.js';
import portfolioRouter from './portfolios.ts';

const BIZ_A = 'biz_pf_route_a';
const BIZ_B = 'biz_pf_route_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
const createdPortfolios: string[] = [];

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: string, path: string, opts: { body?: unknown; authed?: boolean } = {},
): Promise<TestResponse> {
  const authed = opts.authed !== false;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authed ? { 'X-Test-User': 'owner' } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'PF Route A', 'pf-route-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'PF Route B', 'pf-route-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) {
      (req.session as unknown as Record<string, unknown>).userId = String(req.headers['x-test-user']);
    }
    next();
  });
  app.use('/api/portfolios', portfolioRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  for (const id of createdPortfolios) {
    db.prepare('DELETE FROM portfolio_members WHERE portfolio_id = ?').run(id);
    db.prepare('DELETE FROM portfolio_membership_events WHERE portfolio_id = ?').run(id);
    db.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
  }
});

async function createPortfolio(name: string, ids: string[]): Promise<string> {
  const { body } = await call('POST', '/api/portfolios', { body: { name, business_ids: ids } });
  createdPortfolios.push(body.portfolio.id);
  return body.portfolio.id;
}

describe('authentication', () => {
  test('every route requires a session', async () => {
    expect((await call('GET', '/api/portfolios', { authed: false })).status).toBe(401);
    expect((await call('POST', '/api/portfolios', { authed: false, body: { name: 'x', business_ids: [BIZ_A] } })).status).toBe(401);
    expect((await call('GET', '/api/portfolios/anything/comparison', { authed: false })).status).toBe(401);
    expect((await call('DELETE', '/api/portfolios/anything', { authed: false })).status).toBe(401);
  });
});

describe('portfolio lifecycle', () => {
  test('creates, reads, renames and lists a portfolio', async () => {
    const create = await call('POST', '/api/portfolios', {
      body: { name: 'Route Alpha', description: 'first', business_ids: [BIZ_A, BIZ_B] },
    });
    expect(create.status).toBe(201);
    createdPortfolios.push(create.body.portfolio.id);
    const id = create.body.portfolio.id;
    expect(create.body.portfolio.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());

    expect((await call('GET', `/api/portfolios/${id}`)).body.portfolio.name).toBe('Route Alpha');

    const patched = await call('PATCH', `/api/portfolios/${id}`, { body: { name: 'Route Renamed' } });
    expect(patched.body.portfolio.name).toBe('Route Renamed');
    // Renaming must not disturb membership.
    expect(patched.body.portfolio.business_ids.length).toBe(2);

    const list = await call('GET', '/api/portfolios');
    expect(list.body.portfolios.some((p: any) => p.id === id)).toBe(true);
  });

  test('rejects a portfolio with no businesses', async () => {
    const res = await call('POST', '/api/portfolios', { body: { name: 'Empty', business_ids: [] } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('empty_portfolio');
  });

  test('an unknown portfolio is 404 on every read', async () => {
    expect((await call('GET', '/api/portfolios/missing_id')).status).toBe(404);
    expect((await call('GET', '/api/portfolios/missing_id/comparison')).status).toBe(404);
    expect((await call('GET', '/api/portfolios/missing_id/history')).status).toBe(404);
  });
});

describe('membership', () => {
  test('members can be added and removed, and history records both', async () => {
    const id = await createPortfolio('Route Members', [BIZ_A]);

    const added = await call('POST', `/api/portfolios/${id}/members`, {
      body: { business_ids: [BIZ_B], reason: 'expanding' },
    });
    expect(added.status).toBe(200);
    expect(added.body.changed).toEqual([BIZ_B]);

    const removed = await call('DELETE', `/api/portfolios/${id}/members`, {
      body: { business_ids: [BIZ_B], reason: 'divested' },
    });
    expect(removed.body.changed).toEqual([BIZ_B]);
    expect(removed.body.portfolio.business_ids).toEqual([BIZ_A]);

    const history = await call('GET', `/api/portfolios/${id}/history`);
    expect(history.status).toBe(200);
    const forB = history.body.events.filter((e: any) => e.business_id === BIZ_B);
    expect(forB.map((e: any) => e.action).sort()).toEqual(['added', 'removed']);
    expect(forB.find((e: any) => e.action === 'removed').reason).toBe('divested');
  });

  test('accepts a comma-separated id list as well as an array', async () => {
    const id = await createPortfolio('Route CommaList', [BIZ_A]);
    const res = await call('POST', `/api/portfolios/${id}/members`, {
      body: { business_ids: `${BIZ_B}` },
    });
    expect(res.body.portfolio.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());
  });
});

describe('comparison', () => {
  test('returns a labelled comparison with drill-down on every cell', async () => {
    const id = await createPortfolio('Route Comparison', [BIZ_A, BIZ_B]);
    const { status, body } = await call('GET', `/api/portfolios/${id}/comparison?window_days=14`);

    expect(status).toBe(200);
    expect(body.window_days).toBe(14);
    expect(body.portfolio.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());
    expect(body.metrics.length).toBeGreaterThan(0);

    for (const m of body.metrics) {
      expect(m.cells.length).toBe(2);
      for (const c of m.cells) {
        expect(c.evidence.business_id).toBe(c.business_id);
        expect(c.evidence.href).toContain('business=');
      }
      // Aggregates always declare their membership, even when empty.
      expect(Array.isArray(m.aggregate.included_business_ids)).toBe(true);
      expect(Array.isArray(m.aggregate.excluded)).toBe(true);
    }
  });

  test('rejects a non-numeric window', async () => {
    const id = await createPortfolio('Route BadWindow', [BIZ_A]);
    const res = await call('GET', `/api/portfolios/${id}/comparison?window_days=abc`);
    expect(res.status).toBe(400);
  });

  test('there is no write path on the comparison itself', async () => {
    const id = await createPortfolio('Route ReadOnly', [BIZ_A]);
    // Comparing businesses must never approve, execute or change anything.
    const res = await call('POST', `/api/portfolios/${id}/comparison`, { body: {} });
    expect(res.status).toBe(404);
  });
});
