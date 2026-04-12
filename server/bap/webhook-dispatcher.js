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

/**
 * Dispatch a webhook event to all subscribed external agents.
 *
 * Called from signal-engine, task-queue, agent-runner, connector sync, etc.
 * Non-blocking — queues deliveries and returns immediately.
 *
 * @param {string} eventType - e.g. 'signal.created', 'task.approved'
 * @param {Object} payload   - event-specific data
 */
export function dispatchWebhookEvent(eventType, payload) {
  // Find agents subscribed to this event
  let agents;
  try {
    agents = db.prepare(`
      SELECT * FROM bap_agents
      WHERE status = 'active' AND webhook_url IS NOT NULL AND webhook_url != ''
    `).all();
  } catch {
    return;
  }

  for (const agent of agents) {
    const events = safeJSON(agent.webhook_events);
    const subscribed =
      events.includes(eventType) ||
      events.includes('*') ||
      // Also match severity-specific events like 'signal.critical'
      (eventType.startsWith('signal.') && events.includes('signal.*'));

    if (!subscribed) continue;

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
      console.warn(`[BAP Webhook] Delivery ${deliveryId} failed:`, err.message)
    );
  }
}

/**
 * Attempt to deliver a webhook payload with retries.
 */
async function attemptDelivery(deliveryId, agent, eventType, payload, maxAttempts = 3) {
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

  const headers = {
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
      const res = await fetch(agent.webhook_url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      const resBody = await res.text().catch(() => '');

      db.prepare(`
        UPDATE bap_webhook_deliveries
        SET delivery_status = ?, attempts = ?, last_attempt = CURRENT_TIMESTAMP,
            response_code = ?, response_body = ?
        WHERE id = ?
      `).run(
        res.ok ? 'delivered' : 'failed',
        attempt,
        res.status,
        resBody.slice(0, 500),
        deliveryId
      );

      if (res.ok) return; // success
    } catch (err) {
      const isLast = attempt >= maxAttempts;
      db.prepare(`
        UPDATE bap_webhook_deliveries
        SET delivery_status = ?, attempts = ?, last_attempt = CURRENT_TIMESTAMP,
            response_body = ?
        WHERE id = ?
      `).run(isLast ? 'failed' : 'retrying', attempt, err.message, deliveryId);

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
export async function retryPendingDeliveries() {
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
    ORDER BY d.created_at ASC
    LIMIT 50
  `).all(fiveMinAgo);

  for (const row of pending) {
    const payload = safeJSON(row.payload, {});
    const agent = { id: row.agent_id, webhook_url: row.webhook_url, webhook_secret: row.webhook_secret };
    attemptDelivery(row.id, agent, row.event_type, payload, 3 - row.attempts).catch(() => {});
  }

  return pending.length;
}

function safeJSON(val, fallback = []) {
  if (typeof val === 'object' && val !== null) return val;
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}
