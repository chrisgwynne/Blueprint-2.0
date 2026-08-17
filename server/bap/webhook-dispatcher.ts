/**
 * Blueprint Agent Protocol — Webhook dispatcher.
 *
 * Delivers events to external agents that have configured a webhook URL
 * and subscribed to the matching event type.
 *
 * Delivery is fire-and-forget with up to 3 retries at exponential backoff
 * (5 s, 25 s, 125 s). Each delivery is tracked in bap_webhook_deliveries.
 *
 * HMAC-SHA256 signature is included when the agent has a webhook_secret.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { assertSafeWebhookUrl } from '../lib/ssrf-guard.js';
import { quarantineAgentWebhook } from './webhook-reconciliation.js';

interface BapAgent {
  id: string;
  webhook_url: string;
  webhook_secret: string | null;
  webhook_events: unknown;
  business_access?: unknown;
  status?: string;
}

/**
 * Whether an agent is authorized to receive an event for the given
 * business. Events without a business_id (e.g. `system.*`) are instance-
 * wide and are not filtered.
 */
function agentCanReceiveEvent(agent: BapAgent, businessId: unknown): boolean {
  if (!businessId || typeof businessId !== 'string') return true;
  const access = safeJSON<string[]>(agent.business_access);
  return access.includes('*') || access.includes(businessId);
}

/**
 * Dispatch a webhook event to all subscribed external agents.
 *
 * Called from signal-engine, task-queue, agent-runner, connector sync, etc.
 * Non-blocking — queues deliveries and returns immediately.
 *
 * @param eventType - e.g. 'signal.created', 'task.approved'
 * @param payload - event-specific data
 */
export function dispatchWebhookEvent(eventType: string, payload: unknown): void {
  // Find agents subscribed to this event
  let agents: BapAgent[];
  try {
    agents = db.prepare(`
      SELECT * FROM bap_agents
      WHERE status = 'active' AND webhook_url IS NOT NULL AND webhook_url != ''
        AND webhook_disabled_at IS NULL
    `).all() as BapAgent[];
  } catch {
    return;
  }

  const businessId = (payload && typeof payload === 'object')
    ? (payload as Record<string, unknown>).business_id
    : undefined;

  for (const agent of agents) {
    const events = safeJSON<string[]>(agent.webhook_events);
    const subscribed =
      events.includes(eventType) ||
      events.includes('*') ||
      // Also match severity-specific events like 'signal.critical'
      (eventType.startsWith('signal.') && events.includes('signal.*'));

    if (!subscribed) continue;

    // Cross-tenant guard: never fan out a business-scoped event to an
    // agent that isn't authorized for that business, even if it's
    // subscribed to the event type in general.
    if (!agentCanReceiveEvent(agent, businessId)) continue;

    // Queue a delivery record
    const deliveryId = crypto.randomUUID();
    try {
      db.prepare(`
        INSERT INTO bap_webhook_deliveries
        (id, agent_id, event_type, payload, delivery_status, created_at)
        VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
      `).run(deliveryId, agent.id, eventType, JSON.stringify(payload));
    } catch {
      continue;
    }

    // Fire-and-forget delivery attempt
    attemptDelivery(deliveryId, agent, eventType, payload).catch((err) =>
      console.warn(`[BAP Webhook] Delivery ${deliveryId} failed:`, (err as Error).message)
    );
  }
}

/**
 * Attempt to deliver a webhook payload with retries.
 */
async function attemptDelivery(
  deliveryId: string,
  agent: BapAgent,
  eventType: string,
  payload: unknown,
  maxAttempts = 3
): Promise<void> {
  // SSRF guard — re-checked on every delivery attempt (not just at
  // registration time) so a hostname that later resolves to a private/
  // internal address (DNS rebinding, or a re-pointed DNS record) is still
  // caught before Blueprint's server makes the request.
  try {
    await assertSafeWebhookUrl(agent.webhook_url);
  } catch (err) {
    db.prepare(`
      UPDATE bap_webhook_deliveries
      SET delivery_status = 'failed', attempts = ?, last_attempt = CURRENT_TIMESTAMP,
          response_body = ?
      WHERE id = ?
    `).run(maxAttempts, `Blocked: ${(err as Error).message}`.slice(0, 500), deliveryId);
    console.warn(`[BAP Webhook] Delivery ${deliveryId} blocked — unsafe URL:`, (err as Error).message);
    // Quarantine the destination itself (#40), not just this one delivery
    // — without this, every future event this agent is subscribed to
    // would queue and then fail an identical, guaranteed-to-fail check.
    // No-ops if reconcileUnsafeWebhooks() already quarantined it first.
    quarantineAgentWebhook(agent.id, (err as Error).message);
    return;
  }

  const body = JSON.stringify({
    id: deliveryId,
    event: eventType,
    timestamp: new Date().toISOString(),
    blueprint_version: '1.0.0',
    data: payload,
  });

  // HMAC signature so the receiver can verify authenticity
  const signature = agent.webhook_secret
    ? 'sha256=' +
      crypto.createHmac('sha256', agent.webhook_secret).update(body).digest('hex')
    : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Blueprint-Event': eventType,
    'Blueprint-Delivery': deliveryId,
    'Blueprint-Timestamp': String(Date.now()),
    ...(signature && { 'Blueprint-Signature': signature }),
  };

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      // redirect: 'manual' — a validated, safe webhook_url could otherwise
      // 3xx-redirect to a private/internal address and have that followed
      // automatically, silently defeating the SSRF guard above. Any
      // redirect is treated as a delivery failure rather than followed;
      // if the receiver genuinely needs to move endpoints, the agent
      // should update its webhook_url directly via PUT /me/webhook
      // (which re-validates), not rely on an HTTP redirect.
      const res = await fetch(agent.webhook_url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });

      const isRedirect = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
      const resBody = isRedirect ? '' : await res.text().catch(() => '');

      db.prepare(`
        UPDATE bap_webhook_deliveries
        SET delivery_status = ?, attempts = ?, last_attempt = CURRENT_TIMESTAMP,
            response_code = ?, response_body = ?
        WHERE id = ?
      `).run(
        res.ok && !isRedirect ? 'delivered' : 'failed',
        attempt,
        isRedirect ? 0 : res.status,
        isRedirect ? 'Blocked: webhook endpoint returned a redirect, which is not followed (SSRF hardening).' : resBody.slice(0, 500),
        deliveryId
      );

      if (isRedirect) {
        console.warn(`[BAP Webhook] Delivery ${deliveryId} blocked — endpoint attempted a redirect.`);
        return; // do not retry — a redirecting endpoint won't stop redirecting
      }

      if (res.ok) return; // success
    } catch (err) {
      const isLast = attempt >= maxAttempts;
      db.prepare(`
        UPDATE bap_webhook_deliveries
        SET delivery_status = ?, attempts = ?, last_attempt = CURRENT_TIMESTAMP,
            response_body = ?
        WHERE id = ?
      `).run(isLast ? 'failed' : 'retrying', attempt, (err as Error).message, deliveryId);

      if (!isLast) {
        // Exponential backoff: 5s, 25s
        await new Promise((r) => setTimeout(r, 5000 * Math.pow(5, attempt - 1)));
      }
    }
  }
}

/**
 * Retry all deliveries that are in 'retrying' or 'failed' state with
 * attempts < 3 and last_attempt > 5 minutes ago.
 * Called by the scheduler every 5 minutes.
 */
export async function retryPendingDeliveries(): Promise<number> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const pending = db.prepare(`
    SELECT d.*, a.webhook_url, a.webhook_secret
    FROM bap_webhook_deliveries d
    JOIN bap_agents a ON a.id = d.agent_id
    WHERE d.delivery_status IN ('retrying', 'pending')
      AND d.attempts < 3
      AND (d.last_attempt IS NULL OR d.last_attempt < ?)
      AND a.status = 'active'
      AND a.webhook_url IS NOT NULL
      AND a.webhook_disabled_at IS NULL
    ORDER BY d.created_at ASC
    LIMIT 50
  `).all(fiveMinAgo) as (BapAgent & {
    agent_id: string;
    payload: string;
    event_type: string;
    attempts: number;
  })[];

  for (const row of pending) {
    const payload = safeJSON<unknown>(row.payload, {});
    const agent: BapAgent = { id: row.agent_id, webhook_url: row.webhook_url, webhook_secret: row.webhook_secret, webhook_events: [] };
    attemptDelivery(row.id, agent, row.event_type, payload, 3 - row.attempts).catch(() => {});
  }

  return pending.length;
}

function safeJSON<T = string[]>(val: unknown, fallback: T = [] as unknown as T): T {
  if (typeof val === 'object' && val !== null) return val as T;
  if (!val) return fallback;
  try { return JSON.parse(val as string) as T; } catch { return fallback; }
}
