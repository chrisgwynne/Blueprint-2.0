/**
 * Phase 3 Review-surfaces API tests — server/routes/bap-review.ts
 * (recommendations, retrospectives, calibration, cross-business patterns).
 * Runs against a real Express instance mounting the actual router.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapReviewRouter, { explanationDepthLabel } from './bap-review.ts';

const BIZ_A = 'biz_bap_rev_a';
const BIZ_B = 'biz_bap_rev_b';

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

function insertRetrospective(businessId: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO retrospectives (id, business_id, period_start, period_end, executive_summary, what_worked, what_didnt, learnings, agent_assessments, open_windows, recommendations, operating_changes, calibration_notes, triggered_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, businessId,
    (overrides.period_start as string) ?? '2026-06-01T00:00:00.000Z',
    (overrides.period_end as string) ?? '2026-06-30T00:00:00.000Z',
    (overrides.executive_summary as string) ?? 'Fixture retrospective summary.',
    JSON.stringify(['SEO wins']), JSON.stringify(['Slow content approvals']), JSON.stringify(['Ship faster']),
    JSON.stringify([{ agent: 'seo', accuracy: 0.8 }]), JSON.stringify([]), JSON.stringify(['Try X next']),
    JSON.stringify([]), JSON.stringify([]),
    (overrides.triggered_by as string) ?? 'scheduler',
  );
  return id;
}

function insertCalibration(businessId: string, agentId: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO agent_calibration (id, agent_id, business_id, period_start, period_end, tasks_with_outcomes, avg_stated_confidence, avg_actual_outcome_rate, calibration_error, calibration_score, calibration_method, conservatism_factor, bins, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, agentId, businessId,
    (overrides.period_start as string) ?? '2026-06-01T00:00:00.000Z',
    (overrides.period_end as string) ?? '2026-06-30T00:00:00.000Z',
    (overrides.tasks_with_outcomes as number) ?? 10, 0.75, 0.6, 0.15, 0.7,
    'recency_weighted_binned', 1.0, JSON.stringify([{ bin: '0.7-0.8', n: 5, actual: 0.6 }]),
  );
  return id;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug, type) VALUES (?, 'BAP Review A', 'bap-rev-a', 'ecommerce') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug, type) VALUES (?, 'BAP Review B', 'bap-rev-b', 'ecommerce') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_rev_read', 'agt_rev_trigger')`).run();
  keyRead = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Review Read Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_rev_read', await hashApiKey(keyRead), keyPrefix(keyRead), JSON.stringify(['recommendations:read', 'retrospectives:read', 'calibration:read']), JSON.stringify([BIZ_A]));

  keyTrigger = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Review Trigger Agent', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run('agt_rev_trigger', await hashApiKey(keyTrigger), keyPrefix(keyTrigger), JSON.stringify(['retrospectives:read', 'retrospectives:trigger']), JSON.stringify([BIZ_A]));

  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, action_type, confidence, priority, created_at, updated_at)
    VALUES (?, ?, 'Fixture recommendation task', 'test', 'proposed', 'yellow', 'requires_approval', 'seo_meta_rewrite', 0.8, 'p1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(generateId(), BIZ_A);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapReviewRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM tasks WHERE business_id IN (?, ?) AND title = 'Fixture recommendation task'`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM retrospectives WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM agent_calibration WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN ('agt_rev_read', 'agt_rev_trigger')`).run();
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN ('agt_rev_read', 'agt_rev_trigger')`).run();
  db.prepare(`DELETE FROM bap_agents WHERE id IN ('agt_rev_read', 'agt_rev_trigger')`).run();
});

describe('GET /businesses/:id/recommendations', () => {
  test('ranks candidates with explainability attached', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/recommendations`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.recommendations.length).toBeGreaterThanOrEqual(1);
    const rec = body.recommendations.find((r: any) => r.title === 'Fixture recommendation task');
    expect(rec).toBeTruthy();
    expect(rec.explanation).toBeTruthy();
    expect(Array.isArray(rec.explanation.evidence)).toBe(true);
    expect(typeof body.explanation_depth).toBe('string');
  });

  test('403 for a business not in the calling agent\'s business_access', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/recommendations`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });

  test('limit caps the number of returned recommendations', async () => {
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/recommendations?limit=1`, { 'BAP-Key': keyRead });
    expect(body.recommendations.length).toBeLessThanOrEqual(1);
  });
});

describe('explanationDepthLabel', () => {
  test('does not render "top 0" when there are no recommendations to explain', () => {
    expect(explanationDepthLabel(0)).toBe('no recommendations to explain');
  });

  test('caps at FULL_EXPLANATION_LIMIT for a large recommendation count', () => {
    expect(explanationDepthLabel(50)).toBe('full for the top 5, partial (no KB search) for the rest');
  });
});

describe('GET /businesses/:id/retrospectives', () => {
  test('lists retrospectives, most recent first, with pagination', async () => {
    insertRetrospective(BIZ_A);
    insertRetrospective(BIZ_A, { period_start: '2026-05-01T00:00:00.000Z', period_end: '2026-05-31T00:00:00.000Z' });
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/retrospectives`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.retrospectives.length).toBeGreaterThanOrEqual(2);
    expect(body.pagination).toBeTruthy();
  });

  test('does not leak another business\'s retrospectives', async () => {
    insertRetrospective(BIZ_B);
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/retrospectives`, { 'BAP-Key': keyRead });
    expect(body.retrospectives.every((r: any) => r.business_id === BIZ_A)).toBe(true);
  });
});

describe('GET /retrospectives/:id', () => {
  test('returns detail with parsed JSON arrays', async () => {
    const id = insertRetrospective(BIZ_A);
    const { status, body } = await get(`/api/bap/v1/retrospectives/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.retrospective.id).toBe(id);
    expect(Array.isArray(body.retrospective.what_worked)).toBe(true);
    expect(Array.isArray(body.retrospective.learnings)).toBe(true);
  });

  test('404 for an unknown retrospective', async () => {
    const { status } = await get('/api/bap/v1/retrospectives/does-not-exist', { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });

  test('403 across tenants (cross-tenant IDOR safe)', async () => {
    const id = insertRetrospective(BIZ_B);
    const { status } = await get(`/api/bap/v1/retrospectives/${id}`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('POST /businesses/:id/retrospectives/run', () => {
  test('requires retrospectives:trigger, not just retrospectives:read', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/retrospectives/run`, {}, { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() });
    expect(status).toBe(403);
  });

  test('202 with a valid trigger key and Idempotency-Key', async () => {
    const { status, body } = await post(`/api/bap/v1/businesses/${BIZ_A}/retrospectives/run`, {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() });
    expect(status).toBe(202);
    expect(body.status).toBe('running');
  });

  test('400 without Idempotency-Key', async () => {
    const { status } = await post(`/api/bap/v1/businesses/${BIZ_A}/retrospectives/run`, {}, { 'BAP-Key': keyTrigger });
    expect(status).toBe(400);
  });
});

describe('GET /businesses/:id/calibration', () => {
  test('returns latest calibration per agent by default', async () => {
    insertCalibration(BIZ_A, 'agt_seo');
    insertCalibration(BIZ_A, 'agt_seo', { period_start: '2026-05-01T00:00:00.000Z', period_end: '2026-05-31T00:00:00.000Z' });
    insertCalibration(BIZ_A, 'agt_ads');
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/calibration`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.calibration.length).toBe(2);
  });

  test('agent_id filters to one agent', async () => {
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/calibration?agent_id=agt_seo`, { 'BAP-Key': keyRead });
    expect(body.calibration.every((c: any) => c.agent_id === 'agt_seo')).toBe(true);
  });

  test('history=1 returns full history, not just the latest', async () => {
    const { body } = await get(`/api/bap/v1/businesses/${BIZ_A}/calibration?agent_id=agt_seo&history=1`, { 'BAP-Key': keyRead });
    expect(body.calibration_history.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.calibration_history[0].bins)).toBe(true);
  });

  test('403 without calibration:read on that business', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/calibration`, { 'BAP-Key': keyRead });
    expect(status).toBe(403);
  });
});

describe('GET /businesses/:id/patterns', () => {
  test('returns cross-business patterns with no tenant-identifying fields', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/patterns`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(Array.isArray(body.patterns)).toBe(true);
    for (const p of body.patterns) {
      expect(Object.keys(p)).not.toContain('business_id');
    }
  });
});

describe('Concurrent reads', () => {
  test('20 simultaneous recommendation requests all succeed', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => get(`/api/bap/v1/businesses/${BIZ_A}/recommendations`, { 'BAP-Key': keyRead })));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
