/**
 * Phase 3 Knowledge Graph API tests — server/routes/bap-graph.ts. Runs
 * against a real Express instance mounting the actual router.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import { createEdge } from '../brain/knowledge-graph.ts';
import bapGraphRouter from './bap-graph.ts';

const BIZ_A = 'biz_bap_graph_a';
const BIZ_B = 'biz_bap_graph_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;
let keyTrigger: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Graph A', 'bap-graph-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Graph B', 'bap-graph-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_graph_read', 'agt_graph_trigger')`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Graph Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_graph_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['graph:read']), JSON.stringify([BIZ_A]));

  keyTrigger = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Graph Trigger Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_graph_trigger', await hashApiKey(keyTrigger), keyPrefix(keyTrigger), JSON.stringify(['graph:read', 'graph:trigger']), JSON.stringify([BIZ_A]));

  // Fixture graph: goal <-supports- task <-caused- signal, all real entities.
  createEdge(
    BIZ_A,
    { ref_table: 'tasks', ref_id: 'fixture_task_1' }, 'Fixture task', 'task',
    { ref_table: 'goals', ref_id: 'fixture_goal_1' }, 'Fixture goal', 'goal',
    'supports',
  );
  createEdge(
    BIZ_A,
    { ref_table: 'signals', ref_id: 'fixture_signal_1' }, 'Fixture signal', 'signal',
    { ref_table: 'tasks', ref_id: 'fixture_task_1' }, 'Fixture task', 'task',
    'caused',
  );

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapGraphRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM kg_edges WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM kg_entities WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN ('agt_graph_read', 'agt_graph_trigger')`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_graph_read', 'agt_graph_trigger')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_graph_read', 'agt_graph_trigger')`).run();
});

describe('GET /businesses/:id/graph', () => {
  test('traverses from a starting entity, returns nodes+edges', async () => {
    const { status, body } = await get(
      `/api/bap/v1/businesses/${BIZ_A}/graph?ref_table=goals&ref_id=fixture_goal_1`,
      { 'BAP-Key': keyRead },
    );
    expect(status).toBe(200);
    expect(body.total_nodes).toBeGreaterThanOrEqual(2);
    expect(body.nodes.some((n: any) => n.ref_id === 'fixture_task_1')).toBe(true);
  });

  test('depth=1 excludes the 2-hop signal node', async () => {
    const { body } = await get(
      `/api/bap/v1/businesses/${BIZ_A}/graph?ref_table=goals&ref_id=fixture_goal_1&depth=1`,
      { 'BAP-Key': keyRead },
    );
    expect(body.nodes.some((n: any) => n.ref_id === 'fixture_signal_1')).toBe(false);
  });

  test('edge_types filters to only the requested edge type', async () => {
    const { body } = await get(
      `/api/bap/v1/businesses/${BIZ_A}/graph?ref_table=goals&ref_id=fixture_goal_1&edge_types=supports`,
      { 'BAP-Key': keyRead },
    );
    expect(body.edges.every((e: any) => e.edge_type === 'supports')).toBe(true);
  });

  test('empty graph for an entity with no derived edges', async () => {
    const { status, body } = await get(
      `/api/bap/v1/businesses/${BIZ_A}/graph?ref_table=goals&ref_id=does_not_exist`,
      { 'BAP-Key': keyRead },
    );
    expect(status).toBe(200);
    expect(body.nodes).toHaveLength(0);
    expect(body.edges).toHaveLength(0);
  });

  test('400 when ref_table/ref_id are missing', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/graph`, { 'BAP-Key': keyRead });
    expect(status).toBe(400);
  });

  test('400 for an invalid ref_table', async () => {
    const { status } = await get(
      `/api/bap/v1/businesses/${BIZ_A}/graph?ref_table=not_a_real_table&ref_id=x`,
      { 'BAP-Key': keyRead },
    );
    expect(status).toBe(400);
  });

  test('403 without graph:read on that business', async () => {
    const { status } = await get(
      `/api/bap/v1/businesses/${BIZ_B}/graph?ref_table=goals&ref_id=x`,
      { 'BAP-Key': keyRead },
    );
    expect(status).toBe(403);
  });
});

describe('POST /businesses/:id/graph/rebuild', () => {
  test('requires graph:trigger, not just graph:read', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/graph/rebuild`, {},
      { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() },
    );
    expect(status).toBe(403);
  });

  test('200 synchronously with a valid trigger key and Idempotency-Key', async () => {
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/graph/rebuild`, {},
      { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() },
    );
    expect(status).toBe(200);
    expect(body.business_id).toBe(BIZ_A);
    expect(typeof body.entities).toBe('number');
    expect(typeof body.edges).toBe('number');
  });

  test('400 without Idempotency-Key', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/graph/rebuild`, {}, { 'BAP-Key': keyTrigger });
    expect(status).toBe(400);
  });
});

describe('Concurrent reads', () => {
  test('20 simultaneous traversal requests all succeed', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => get(
      `/api/bap/v1/businesses/${BIZ_A}/graph?ref_table=goals&ref_id=fixture_goal_1`,
      { 'BAP-Key': keyRead },
    )));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
