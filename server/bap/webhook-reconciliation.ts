/**
 * Reconciliation for BAP agent webhooks that have gone from safe to
 * unsafe since they were registered/last validated (#40).
 *
 * assertSafeWebhookUrl() (server/lib/ssrf-guard.ts) is enforced when a
 * webhook is first set (POST /register, PUT /me/webhook) and again on
 * every delivery attempt (webhook-dispatcher.ts's attemptDelivery). What
 * neither of those catches is a webhook_url that was safe when stored and
 * has since become unsafe — most commonly a legacy bap_agents row created
 * before the SSRF guard existed at all (e.g. a stored `localhost:8644`
 * destination), but also a hostname that resolved publicly at
 * registration time and has since been repointed at a private/internal
 * address. Left alone, every event that agent is subscribed to creates a
 * bap_webhook_deliveries row that is *guaranteed* to fail the same SSRF
 * check the moment attemptDelivery() re-runs it — pure DB churn with zero
 * chance of ever succeeding (one real case produced 3,602 such rows).
 *
 * quarantineAgentWebhook() is the single choke point for disabling a
 * webhook: it sets webhook_disabled_at/webhook_disabled_reason (leaving
 * webhook_url itself in place as an audit trail) and raises exactly one
 * system_issues row, then is a no-op on every subsequent call for the
 * same agent until the quarantine is cleared. It's shared by:
 *   - reconcileUnsafeWebhooks() below, a batch pass over every active,
 *     not-yet-quarantined agent (run at scheduler startup and on the
 *     existing 5-minute BAP webhook maintenance tick — see jobs/scheduler.ts).
 *   - webhook-dispatcher.ts's attemptDelivery(), so a webhook that only
 *     fails *between* reconciliation passes (e.g. DNS rebinding) is
 *     quarantined immediately after its first doomed delivery rather than
 *     generating one per subsequent event too.
 *
 * Quarantining only ever touches the webhook fields — `status` (and
 * therefore bapAuth / GET /me / every other BAP endpoint) is left
 * completely alone. A disabled webhook is a delivery-layer concern, not a
 * reason to lock an agent out of the API it's otherwise using correctly.
 */
import db from '../db/db.js';
import { assertSafeWebhookUrl } from '../lib/ssrf-guard.js';
import { createSystemIssue } from '../system/system-issues.js';

export interface WebhookQuarantineResult {
  id: string;
  name: string;
  webhook_url: string;
  reason: string;
}

export interface ReconcileUnsafeWebhooksResult {
  checked: number;
  quarantined: WebhookQuarantineResult[];
}

/**
 * Disable a single agent's webhook and record why, unless it's already
 * quarantined (or the agent doesn't exist) — safe to call repeatedly.
 * `reason` should be a human-readable explanation (typically
 * UnsafeWebhookUrlError's message).
 */
export function quarantineAgentWebhook(agentId: string, reason: string): void {
  const agent = db.prepare(
    'SELECT id, name, webhook_url, webhook_disabled_at FROM bap_agents WHERE id = ?'
  ).get(agentId) as { id: string; name: string; webhook_url: string | null; webhook_disabled_at: string | null } | undefined;
  if (!agent || agent.webhook_disabled_at) return; // gone, or already quarantined — no-op

  const trimmedReason = reason.slice(0, 500);

  db.prepare(`
    UPDATE bap_agents
    SET webhook_disabled_at = CURRENT_TIMESTAMP, webhook_disabled_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(trimmedReason, agentId);

  createSystemIssue({
    issue_type: 'bap_webhook_unsafe',
    severity: 'warning',
    title: `Webhook disabled for external agent "${agent.name}" — destination failed the SSRF safety check`,
    description:
      `The webhook configured for external agent "${agent.name}" (${agentId}) no longer passes the SSRF safety ` +
      `check and has been disabled to stop generating deliveries that are guaranteed to fail. Reason: ${trimmedReason} ` +
      `Update the webhook to a safe destination via PUT /me/webhook (or Settings → External Agents) to re-enable delivery.`,
    metadata: { agent_id: agentId, agent_name: agent.name, webhook_url: agent.webhook_url, reason: trimmedReason },
  });
}

/**
 * Scan every active bap_agents row with a currently-enabled webhook and
 * quarantine any whose webhook_url fails assertSafeWebhookUrl(). Intended
 * to run at startup and periodically (see jobs/scheduler.ts) so legacy
 * rows — and rows that later become unsafe via DNS changes — are caught
 * without waiting for a live delivery attempt to hit them.
 *
 * Idempotent: an agent already quarantined (webhook_disabled_at set) is
 * excluded from the scan entirely, so re-running this never re-flags the
 * same agent or raises a duplicate system issue for it.
 */
export async function reconcileUnsafeWebhooks(): Promise<ReconcileUnsafeWebhooksResult> {
  const agents = db.prepare(`
    SELECT id, name, webhook_url FROM bap_agents
    WHERE status = 'active'
      AND webhook_url IS NOT NULL AND webhook_url != ''
      AND webhook_disabled_at IS NULL
  `).all() as Array<{ id: string; name: string; webhook_url: string }>;

  const quarantined: WebhookQuarantineResult[] = [];

  for (const agent of agents) {
    try {
      await assertSafeWebhookUrl(agent.webhook_url);
    } catch (err) {
      const reason = (err as Error).message;
      quarantineAgentWebhook(agent.id, reason);
      quarantined.push({ id: agent.id, name: agent.name, webhook_url: agent.webhook_url, reason });
    }
  }

  return { checked: agents.length, quarantined };
}
