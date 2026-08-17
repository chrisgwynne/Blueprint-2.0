/**
 * Regression tests for #40 — legacy/unsafe BAP webhooks must be quarantined
 * once, not generate a failed delivery for every subscribed event.
 */
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from './auth.ts';
import { dispatchWebhookEvent } from './webhook-dispatcher.ts';
import { listSystemIssues } from '../system/system-issues.js';
import { quarantineAgentWebhook, reconcileUnsafeWebhooks } from './webhook-reconciliation.ts';

const BIZ = 'biz_webhook_reconcile_test';
const LEGACY_AGENT_ID = 'agt_legacy_unsafe_webhook';

async function seedLegacyAgent(webhookUrl: string): Promise<void> {
  const key = generateApiKey();
  // Direct DB insert — bypasses assertSafeWebhookUrl() the way a row
  // created before the SSRF guard existed (or before it covered this
  // address) would have. status is 'active': this is the exact "legacy
  // active agent with a now-unsafe webhook" scenario from the issue.
  db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, webhook_url, webhook_events, created_at)
    VALUES (?, 'Legacy Unsafe Webhook Agent', ?, ?, 'active', '[]', ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      webhook_url = excluded.webhook_url, webhook_disabled_at = NULL, webhook_disabled_reason = NULL
  `).run(LEGACY_AGENT_ID, await hashApiKey(key), keyPrefix(key), JSON.stringify([BIZ]), webhookUrl, JSON.stringify(['signal.created']));
}

function agentRow(): { webhook_disabled_at: string | null; webhook_disabled_reason: string | null; status: string } {
  return db.prepare(
    'SELECT webhook_disabled_at, webhook_disabled_reason, status FROM bap_agents WHERE id = ?'
  ).get(LEGACY_AGENT_ID) as { webhook_disabled_at: string | null; webhook_disabled_reason: string | null; status: string };
}

function deliveryCount(): number {
  return (db.prepare('SELECT COUNT(*) as n FROM bap_webhook_deliveries WHERE agent_id = ?').get(LEGACY_AGENT_ID) as { n: number }).n;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Webhook Reconcile Test', 'webhook-reconcile-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterEach(() => {
  db.prepare('DELETE FROM bap_webhook_deliveries WHERE agent_id = ?').run(LEGACY_AGENT_ID);
  db.prepare('DELETE FROM system_issues WHERE issue_type = ? AND json_extract(metadata, "$.agent_id") = ?').run('bap_webhook_unsafe', LEGACY_AGENT_ID);
  db.prepare('DELETE FROM bap_agents WHERE id = ?').run(LEGACY_AGENT_ID);
});

afterAll(() => {
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
});

describe('reconcileUnsafeWebhooks', () => {
  test('quarantines a legacy active agent whose stored webhook fails assertSafeWebhookUrl(), exactly once', async () => {
    await seedLegacyAgent('http://localhost:8644/hook');

    const result = await reconcileUnsafeWebhooks();

    const quarantinedRow = result.quarantined.find((q) => q.id === LEGACY_AGENT_ID);
    expect(quarantinedRow).toBeDefined();
    expect(quarantinedRow?.reason).toContain('localhost');

    const after = agentRow();
    expect(after.webhook_disabled_at).not.toBeNull();
    expect(after.webhook_disabled_reason).toContain('localhost');
    // The agent itself is untouched — only the webhook is quarantined.
    expect(after.status).toBe('active');
  });

  test('raises exactly one durable system issue for the agent, even across repeated reconciliation runs', async () => {
    await seedLegacyAgent('http://127.0.0.1:9999/hook');

    await reconcileUnsafeWebhooks();
    await reconcileUnsafeWebhooks();
    await reconcileUnsafeWebhooks();

    const issues = listSystemIssues({ issue_type: 'bap_webhook_unsafe' }).filter(
      (i) => (i.metadata as Record<string, unknown>).agent_id === LEGACY_AGENT_ID
    );
    expect(issues.length).toBe(1);
    expect(issues[0]!.status).toBe('open');
  });

  test('a safe webhook_url is left completely alone', async () => {
    await seedLegacyAgent('https://8.8.8.8/hook');

    const result = await reconcileUnsafeWebhooks();

    expect(result.quarantined.find((q) => q.id === LEGACY_AGENT_ID)).toBeUndefined();
    expect(agentRow().webhook_disabled_at).toBeNull();
  });

  test('an already-quarantined agent is skipped on a subsequent run (no duplicate quarantine work)', async () => {
    await seedLegacyAgent('http://localhost:8644/hook');
    quarantineAgentWebhook(LEGACY_AGENT_ID, 'Manually quarantined for this test.');
    const disabledAtBefore = agentRow().webhook_disabled_at;

    const result = await reconcileUnsafeWebhooks();

    expect(result.quarantined.find((q) => q.id === LEGACY_AGENT_ID)).toBeUndefined();
    expect(agentRow().webhook_disabled_at).toBe(disabledAtBefore); // unchanged, not re-stamped
  });
});

describe('dispatchWebhookEvent after reconciliation', () => {
  test('no new delivery rows are created for a quarantined agent across multiple dispatched events', async () => {
    await seedLegacyAgent('http://localhost:8644/hook');
    await reconcileUnsafeWebhooks();
    expect(deliveryCount()).toBe(0);

    dispatchWebhookEvent('signal.created', { signal_id: generateId(), business_id: BIZ });
    dispatchWebhookEvent('signal.critical', { signal_id: generateId(), business_id: BIZ, severity: 'critical' });
    dispatchWebhookEvent('task.approved', { task_id: generateId(), business_id: BIZ });

    // dispatchWebhookEvent queues delivery rows synchronously before any
    // fire-and-forget network attempt, so no async wait is needed here —
    // the quarantined agent should never even be selected by the query.
    expect(deliveryCount()).toBe(0);
  });

  test('a webhook that only fails at delivery time (not yet reconciled) is quarantined after its first doomed attempt, and generates no further delivery rows', async () => {
    await seedLegacyAgent('http://localhost:8644/hook');
    // Deliberately skip reconcileUnsafeWebhooks() — this simulates the
    // gap between reconciliation passes where dispatch still queues a
    // delivery, but attemptDelivery()'s own SSRF re-check catches it.
    dispatchWebhookEvent('signal.created', { signal_id: generateId(), business_id: BIZ });

    // Let the fire-and-forget attemptDelivery() run and self-quarantine.
    await new Promise((r) => setTimeout(r, 50));

    expect(agentRow().webhook_disabled_at).not.toBeNull();
    expect(deliveryCount()).toBe(1); // the one doomed delivery, marked failed — not deleted (audit trail)

    // Further events must not add more doomed deliveries now that the
    // agent is quarantined.
    dispatchWebhookEvent('signal.created', { signal_id: generateId(), business_id: BIZ });
    dispatchWebhookEvent('task.approved', { task_id: generateId(), business_id: BIZ });
    expect(deliveryCount()).toBe(1);
  });
});

describe('/me access is unaffected by webhook quarantine', () => {
  test('the underlying auth lookup (status = active) still finds the agent after its webhook is quarantined', async () => {
    await seedLegacyAgent('http://localhost:8644/hook');
    await reconcileUnsafeWebhooks();
    expect(agentRow().webhook_disabled_at).not.toBeNull();

    // Mirrors bap/auth.ts's bapAuth lookup used by every BAP endpoint
    // including GET /me — same query, same expectation: status is still
    // 'active' so the agent authenticates exactly as before.
    const authRow = db.prepare(
      "SELECT id, status FROM bap_agents WHERE id = ? AND status = 'active'"
    ).get(LEGACY_AGENT_ID) as { id: string; status: string } | undefined;
    expect(authRow).toBeDefined();
    expect(authRow?.status).toBe('active');
  });
});
