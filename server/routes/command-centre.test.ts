/**
 * Executive command centre API (#59) — server/routes/command-centre.ts.
 *
 * This is the one deliberately cross-business read in the dashboard API, so
 * the boundary properties matter more than usual: an unauthenticated caller
 * gets nothing, the selection is honoured exactly, an unreadable business
 * degrades to a row rather than a status code, and there is no write path.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import commandCentreRouter from './command-centre.ts';

const BIZ_A = 'biz_cc_route_a';
const BIZ_B = 'biz_cc_route_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, authed = true): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authed ? { 'X-Test-User': 'owner' } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(businessId: string, title: string): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, version, created_at, updated_at)
    VALUES (?, ?, ?, 'agent:test', 'proposed', 'yellow', 'requires_approval', 'github_issue', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, businessId, title);
  return id;
}

beforeAll(async () => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'CC Route A', 'cc-route-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'CC Route B', 'cc-route-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);
  insertTask(BIZ_A, 'Route A proposal');
  insertTask(BIZ_B, 'Route B proposal');

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) (req.session as unknown as Record<string, unknown>).userId = String(req.headers['x-test-user']);
    next();
  });
  app.use('/api/command-centre', commandCentreRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(BIZ_A, BIZ_B);
});

describe('GET /api/command-centre', () => {
  test('requires an authenticated session', async () => {
    expect((await get('/api/command-centre', false)).status).toBe(401);
    expect((await get('/api/command-centre/scope', false)).status).toBe(401);
  });

  test('honours an explicit multi-business selection', async () => {
    const { status, body } = await get(`/api/command-centre?business_ids=${BIZ_A},${BIZ_B}`);
    expect(status).toBe(200);
    expect(body.businesses.map((b: any) => b.business_id).sort()).toEqual([BIZ_A, BIZ_B].sort());
    expect(body.window_days).toBe(30);
    expect(body.generated_at).toBeTruthy();
  });

  test('accepts a repeated business_ids parameter as well as a comma list', async () => {
    const { body } = await get(`/api/command-centre?business_ids=${BIZ_A}&business_ids=${BIZ_B}`);
    expect(body.businesses.length).toBe(2);
  });

  test('a single-business selection returns only that business', async () => {
    const { body } = await get(`/api/command-centre?business_ids=${BIZ_A}`);
    expect(body.businesses.length).toBe(1);
    expect(body.businesses[0].business_id).toBe(BIZ_A);
    expect(body.businesses[0].decisions.data.total).toBeGreaterThan(0);
  });

  test('an unreadable business is a row in a 200, not an error status', async () => {
    const { status, body } = await get(`/api/command-centre?business_ids=${BIZ_A},biz_nope`);
    expect(status).toBe(200);
    const rows = body.businesses;
    expect(rows.find((b: any) => b.business_id === 'biz_nope').status).toBe('unavailable');
    // The readable business is untouched — the whole point of the view.
    expect(rows.find((b: any) => b.business_id === BIZ_A).status).toBe('ok');
  });

  test('window_days is applied and echoed', async () => {
    const { body } = await get(`/api/command-centre?business_ids=${BIZ_A}&window_days=7`);
    expect(body.window_days).toBe(7);
  });

  test('a non-numeric window_days is rejected', async () => {
    const { status } = await get(`/api/command-centre?business_ids=${BIZ_A}&window_days=abc`);
    expect(status).toBe(400);
  });

  test('an unknown portfolio is a 404 with a code', async () => {
    const { status, body } = await get('/api/command-centre?portfolio_id=pf_nope');
    expect(status).toBe(404);
    expect(body.code).toBe('portfolio_not_found');
  });

  test('every item in the payload carries a drill-down href', async () => {
    const { body } = await get(`/api/command-centre?business_ids=${BIZ_A},${BIZ_B}`);
    const links: any[] = [];
    for (const b of body.businesses) {
      links.push(...(b.decisions.data?.items ?? []).map((i: any) => i.evidence));
      links.push(...(b.work_states.data?.items ?? []).map((i: any) => i.evidence));
    }
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.href).toContain(encodeURIComponent(link.id));
    }
  });
});

describe('GET /api/command-centre/scope', () => {
  test('lists the businesses this session may select', async () => {
    const { status, body } = await get('/api/command-centre/scope');
    expect(status).toBe(200);
    const ids = body.businesses.map((b: any) => b.id);
    expect(ids).toContain(BIZ_A);
    expect(ids).toContain(BIZ_B);
    expect(Array.isArray(body.portfolios)).toBe(true);
  });
});

describe('the command centre is read-only', () => {
  test('there is no write path on the summary route', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${baseUrl}/api/command-centre`, {
        method, headers: { 'X-Test-User': 'owner', 'Content-Type': 'application/json' }, body: '{}',
      });
      // Approving from a summary card would skip the policy re-derivation
      // routes/decision-queue.ts does at decision time, so no such route exists.
      expect(res.status).toBe(404);
    }
  });
});
