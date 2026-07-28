import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from '../bap/auth.ts';
import bapRouter from './bap.ts';

const BIZ_A = 'biz_bap_trust_a';
const BIZ_B = 'biz_bap_trust_b';
const AGENT_A = 'agt_bap_trust_a';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyA: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function seedCorrection(businessId: string): string {
  const correctionId = generateId();
  db.prepare(`
    INSERT INTO human_corrections (id, business_id, correction_type, assertion_key, previous_value, corrected_value, explanation, evidence_source, corrected_by, effective_at, confidence, permanence, suppression_behavior, status, created_at)
    VALUES (?, ?, 'business_fact', 'etsy', 'available', 'unavailable', 'Human confirmed no Etsy presence', 'test', 'test', CURRENT_TIMESTAMP, 1, 'permanent', 'suppress_until_changed', 'confirmed', CURRENT_TIMESTAMP)
  `).run(correctionId, businessId);
  db.prepare(`
    INSERT INTO correction_impacts (id, correction_id, business_id, entity_type, entity_id, previous_status, new_status, reason, created_at)
    VALUES (?, ?, ?, 'signal', 'sig_etsy', 'open', 'invalidated', 'Human confirmed no Etsy presence', CURRENT_TIMESTAMP)
  `).run(generateId(), correctionId, businessId);
  db.prepare(`
    INSERT INTO correction_impacts (id, correction_id, business_id, entity_type, entity_id, previous_status, new_status, reason, created_at)
    VALUES (?, ?, ?, 'task', 'tsk_etsy', 'proposed', 'cancelled', 'Human confirmed no Etsy presence', CURRENT_TIMESTAMP)
  `).run(generateId(), correctionId, businessId);
  return correctionId;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Trust A', 'bap-trust-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'BAP Trust B', 'bap-trust-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);
  db.prepare(`DELETE FROM bap_agents WHERE id = ?`).run(AGENT_A);
  keyA = generateApiKey();
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, 'Trust Test Agent A', ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run(AGENT_A, await hashApiKey(keyA), keyPrefix(keyA), JSON.stringify(['corrections:read']), JSON.stringify([BIZ_A]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM correction_impacts WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM human_corrections WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id = ?`).run(AGENT_A);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id = ?`).run(AGENT_A);
  db.prepare(`DELETE FROM bap_agents WHERE id = ?`).run(AGENT_A);
});

describe('BAP trust correction impacts', () => {
  test('GET /businesses/:id/corrections/:correctionId/impacts returns affected records for an owned correction', async () => {
    const correctionId = seedCorrection(BIZ_A);
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/corrections/${correctionId}/impacts`, { 'BAP-Key': keyA });

    expect(status).toBe(200);
    expect(body).toMatchObject({ correction_id: correctionId, business_id: BIZ_A });
    expect(body.impacts).toHaveLength(2);
    expect(body.impacts.map((i: Record<string, unknown>) => i.entity_type).sort()).toEqual(['signal', 'task']);
    expect(body.impacts.every((i: Record<string, unknown>) => i.business_id === BIZ_A)).toBe(true);
  });

  test('returns 404 when the correction id is not part of the requested business', async () => {
    const correctionId = seedCorrection(BIZ_B);
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/corrections/${correctionId}/impacts`, { 'BAP-Key': keyA });
    expect(status).toBe(404);
  });

  test('returns 403 when the caller lacks access to the requested business', async () => {
    const correctionId = seedCorrection(BIZ_B);
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_B}/corrections/${correctionId}/impacts`, { 'BAP-Key': keyA });
    expect(status).toBe(403);
  });
});
