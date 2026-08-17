/**
 * BAP natural-language audit search tests — server/routes/bap-audit-search.ts
 * (issue #83). Runs against a real Express instance mounting the actual
 * router, same pattern as bap-decisions.test.ts / bap-audit.test.ts.
 *
 * No LLM is configured in the test environment, so interpretation always
 * falls through to the deterministic (literal keyword) path — the same
 * fallback searchAuditHistory() uses in production when no provider is
 * configured. That is exercised deliberately here rather than mocked:
 * literal matching is itself a first-class, always-available code path.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapAuditSearchRouter from './bap-audit-search.ts';

const BIZ_A = 'biz_bap_audit_search_a';
const BIZ_B = 'biz_bap_audit_search_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keySearch: string;
let keyAuditOnly: string;
let keyWildcard: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function insertTask(p: { business_id: string; title: string; description?: string; status?: string; created_at?: string }): string {
  const id = generateId();
  const at = p.created_at ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, description, proposed_by, status,
                       trust_tier, approval_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'agent:test', ?, 'yellow', 'requires_approval', ?, ?)
  `).run(id, p.business_id, p.title, p.description ?? null, p.status ?? 'complete', at, at);
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Audit Search A', 'bap-audit-search-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Audit Search B', 'bap-audit-search-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_audit_search_read', 'agt_audit_only', 'agt_audit_search_wild')`).run();

  keySearch = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Audit Search Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_audit_search_read', await hashApiKey(keySearch), keyPrefix(keySearch), JSON.stringify(['audit_search:read']), JSON.stringify([BIZ_A]));

  // Distinct from audit_search:read on purpose — proves the two grants are
  // independent, per the issue's requirement that this not collide with
  // the pre-existing audit:read (raw audit-log listing) permission.
  keyAuditOnly = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Audit-Only Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_audit_only', await hashApiKey(keyAuditOnly), keyPrefix(keyAuditOnly), JSON.stringify(['audit:read']), JSON.stringify([BIZ_A]));

  keyWildcard = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Audit Search Wildcard Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_audit_search_wild', await hashApiKey(keyWildcard), keyPrefix(keyWildcard), JSON.stringify(['audit_search:read']), JSON.stringify(['*']));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapAuditSearchRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_audit_search_read', 'agt_audit_only', 'agt_audit_search_wild')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_audit_search_read', 'agt_audit_only', 'agt_audit_search_wild')`).run();
});

describe('POST /businesses/:id/audit-search', () => {
  test('successful query returns cited, evidence-backed results', async () => {
    const taskId = insertTask({
      business_id: BIZ_A,
      title: 'Shopify wholesale pricing update',
      description: 'Raised the wholesale catalogue pricing by one increment.',
    });

    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/audit-search`,
      { query: 'What happened with the wholesale pricing?' },
      { 'BAP-Key': keySearch },
    );

    expect(status).toBe(200);
    expect(['results', 'results_stale']).toContain(body.state);
    expect(body.results.length).toBeGreaterThan(0);
    const hit = body.results.find((r: any) => r.citation.record_id === taskId);
    expect(hit).toBeTruthy();
    expect(hit.citation.ref).toBe(`task#${taskId}`);
    expect(hit.citation.table).toBe('tasks');
    // The engine's grounding guarantee: every result is a real, cited row —
    // never a synthesised or paraphrased answer.
    expect(typeof body.applied_filters.description).toBe('string');
    expect(Array.isArray(body.limitations)).toBe(true);
    expect(body.limitations.length).toBeGreaterThan(0);
  });

  test('empty/no-match query is a distinct no_results state, not a bare empty array', async () => {
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/audit-search`,
      { query: 'unmatchable-nonexistent-keyword-zzq' },
      { 'BAP-Key': keySearch },
    );

    expect(status).toBe(200);
    expect(body.state).toBe('no_results');
    expect(body.state_meaning).toBeTruthy();
    expect(body.results).toEqual([]);
    expect(body.total_matched).toBe(0);
    // Distinguishable from ambiguous_query: the search actually ran, and
    // applied_filters proves it (not just an unrun question).
    expect(body.applied_filters).toBeTruthy();
  });

  test('403 when the agent lacks audit_search:read, even with audit:read', async () => {
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/audit-search`,
      { query: 'anything' },
      { 'BAP-Key': keyAuditOnly },
    );
    expect(status).toBe(403);
    expect(body.error).toContain('audit_search:read');
  });

  test('403 for a business outside the agent\'s business_access grant', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_B}/audit-search`,
      { query: 'anything' },
      { 'BAP-Key': keySearch },
    );
    expect(status).toBe(403);
  });

  test('404 for an unknown business (agent with wildcard business access)', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/does-not-exist/audit-search`,
      { query: 'anything' },
      { 'BAP-Key': keyWildcard },
    );
    expect(status).toBe(404);
  });

  test('too-short a query is ambiguous, not silently empty', async () => {
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/audit-search`,
      { query: 'x' },
      { 'BAP-Key': keySearch },
    );
    expect(status).toBe(200);
    expect(body.state).toBe('ambiguous_query');
    expect(body.interpretation.clarification).toBeTruthy();
    expect(body.results).toEqual([]);
  });

  test('does not return another business\'s task from a shared keyword', async () => {
    insertTask({ business_id: BIZ_B, title: 'Cross-tenant pricing task should never surface' });
    const { body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/audit-search`,
      { query: 'cross-tenant' },
      { 'BAP-Key': keySearch },
    );
    expect(body.results.every((r: any) => r.citation.record_id !== undefined)).toBe(true);
    expect(body.results.length).toBe(0);
  });
});
