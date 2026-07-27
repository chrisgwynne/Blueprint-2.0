/**
 * Regression tests for F-06 (cross-tenant webhook fan-out) and F-16/F-17
 * (SSRF via webhook delivery).
 *
 * Mocks global fetch so no real network calls are made — these tests
 * assert on which deliveries get queued/blocked, not on actual HTTP
 * behavior.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from './auth.ts';
import { dispatchWebhookEvent } from './webhook-dispatcher.ts';

const BIZ_A = 'biz_webhook_sec_a';
const BIZ_B = 'biz_webhook_sec_b';

let agentAId: string;
let agentBId: string;
let agentGlobalId: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Webhook Sec A', 'webhook-sec-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Webhook Sec B', 'webhook-sec-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);

  agentAId = 'agt_wh_a';
  agentBId = 'agt_wh_b';
  agentGlobalId = 'agt_wh_global';

  const mkAgent = async (id: string, businessAccess: string[], webhookUrl: string) => {
    const key = generateApiKey();
    db.prepare(`
      INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, webhook_url, webhook_events, created_at)
      VALUES (?, ?, ?, ?, 'active', '[]', ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET business_access = excluded.business_access, webhook_url = excluded.webhook_url, webhook_events = excluded.webhook_events
    `).run(id, id, await hashApiKey(key), keyPrefix(key), JSON.stringify(businessAccess), webhookUrl, JSON.stringify(['signal.created']));
  };

  await mkAgent(agentAId, [BIZ_A], 'https://8.8.8.8/webhook-a');
  await mkAgent(agentBId, [BIZ_B], 'https://8.8.8.8/webhook-b');
  await mkAgent(agentGlobalId, ['*'], 'https://8.8.8.8/webhook-global');
});

beforeEach(() => {
  db.prepare(`DELETE FROM bap_webhook_deliveries WHERE agent_id IN (?, ?, ?)`).run(agentAId, agentBId, agentGlobalId);
  // Stub fetch so any delivery attempt that gets past the SSRF guard
  // "succeeds" without making a real network call.
  globalThis.fetch = (async () =>
    new Response('ok', { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function deliveriesFor(agentId: string): Array<{ event_type: string }> {
  return db.prepare('SELECT event_type FROM bap_webhook_deliveries WHERE agent_id = ?').all(agentId) as Array<{ event_type: string }>;
}

describe('F-06 — dispatchWebhookEvent does not fan out cross-tenant', () => {
  test('a business-A event is only queued for the business-A-scoped and wildcard agents, not business B', async () => {
    dispatchWebhookEvent('signal.created', { signal_id: 'sig_1', business_id: BIZ_A, severity: 'warning' });

    // Delivery queuing happens synchronously before the fire-and-forget
    // network attempt, so we can assert immediately.
    expect(deliveriesFor(agentAId).length).toBe(1);
    expect(deliveriesFor(agentGlobalId).length).toBe(1);
    expect(deliveriesFor(agentBId).length).toBe(0);
  });

  test('a business-B event is only queued for the business-B-scoped and wildcard agents, not business A', async () => {
    dispatchWebhookEvent('signal.created', { signal_id: 'sig_2', business_id: BIZ_B, severity: 'warning' });

    expect(deliveriesFor(agentBId).length).toBe(1);
    expect(deliveriesFor(agentGlobalId).length).toBe(1);
    expect(deliveriesFor(agentAId).length).toBe(0);
  });

  test('an event with no business_id (instance-wide) still reaches every subscribed agent', async () => {
    dispatchWebhookEvent('signal.created', { signal_id: 'sig_3' });

    expect(deliveriesFor(agentAId).length).toBe(1);
    expect(deliveriesFor(agentBId).length).toBe(1);
    expect(deliveriesFor(agentGlobalId).length).toBe(1);
  });
});

describe('F-16/F-17 — webhook delivery is blocked for unsafe destinations', () => {
  test('a webhook_url pointing at the cloud metadata address is blocked before any fetch is attempted', async () => {
    const key = generateApiKey();
    const id = 'agt_wh_ssrf';
    db.prepare(`
      INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, webhook_url, webhook_events, created_at)
      VALUES (?, 'SSRF Target', ?, ?, 'active', '[]', ?, 'http://169.254.169.254/latest/meta-data/', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET webhook_url = excluded.webhook_url
    `).run(id, await hashApiKey(key), keyPrefix(key), JSON.stringify([BIZ_A]), JSON.stringify(['signal.created']));

    // Track called URLs rather than a single boolean: dispatchWebhookEvent
    // is fire-and-forget, so a delivery queued by an *earlier* test (to a
    // different agent/URL) can still be in flight and hit whatever fetch
    // mock is active when it happens to resolve. Asserting on the specific
    // SSRF-target URL avoids false positives from that unrelated traffic.
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calledUrls.push(String(input));
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    dispatchWebhookEvent('signal.created', { signal_id: 'sig_ssrf', business_id: BIZ_A });

    // Let the fire-and-forget delivery attempt run.
    await new Promise((r) => setTimeout(r, 50));

    expect(calledUrls.some((u) => u.includes('169.254.169.254'))).toBe(false);
    const delivery = db.prepare('SELECT delivery_status, response_body FROM bap_webhook_deliveries WHERE agent_id = ?').get(id) as
      | { delivery_status: string; response_body: string }
      | undefined;
    expect(delivery?.delivery_status).toBe('failed');
    expect(delivery?.response_body).toContain('Blocked');
  });
});
