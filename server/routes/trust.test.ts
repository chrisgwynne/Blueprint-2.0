import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import trustRouter from './trust.js';

const BIZ_A = 'biz_session_trust_a';
const BIZ_B = 'biz_session_trust_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function seedCorrection(businessId: string): string {
  const correctionId = generateId();
  db.prepare(`
    INSERT INTO human_corrections (id, business_id, correction_type, assertion_key, previous_value, corrected_value, explanation, evidence_source, corrected_by, effective_at, confidence, permanence, suppression_behavior, status, created_at)
    VALUES (?, ?, 'business_fact', 'google_merchant_center', 'available', 'unavailable', 'Human confirmed no Merchant Center', 'test', 'test', CURRENT_TIMESTAMP, 1, 'permanent', 'suppress_until_changed', 'confirmed', CURRENT_TIMESTAMP)
  `).run(correctionId, businessId);
  db.prepare(`
    INSERT INTO correction_impacts (id, correction_id, business_id, entity_type, entity_id, previous_status, new_status, reason, created_at)
    VALUES (?, ?, ?, 'signal', 'sig_merchant_center', 'open', 'invalidated', 'Human confirmed no Merchant Center', CURRENT_TIMESTAMP)
  `).run(generateId(), correctionId, businessId);
  return correctionId;
}

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Session Trust A', 'session-trust-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Session Trust B', 'session-trust-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { (req.session as any).userId = 'user_session_trust'; next(); }); // eslint-disable-line @typescript-eslint/no-explicit-any
  app.use('/api/trust', trustRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  db.prepare(`DELETE FROM correction_impacts WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM human_corrections WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
});

describe('session trust correction impacts', () => {
  test('returns affected records for a correction owned by the requested business', async () => {
    const correctionId = seedCorrection(BIZ_A);
    const { status, body } = await get(`/api/trust/corrections/${BIZ_A}/${correctionId}/impacts`);

    expect(status).toBe(200);
    expect(body).toMatchObject({ correction_id: correctionId, business_id: BIZ_A });
    expect(body.impacts).toHaveLength(1);
    expect(body.impacts[0]).toMatchObject({ business_id: BIZ_A, correction_id: correctionId, entity_type: 'signal' });
  });

  test('returns 404 instead of an empty impact list for a correction from another business', async () => {
    const correctionId = seedCorrection(BIZ_B);
    const { status, body } = await get(`/api/trust/corrections/${BIZ_A}/${correctionId}/impacts`);

    expect(status).toBe(404);
    expect(body.error).toContain('not found for this business');
  });
});