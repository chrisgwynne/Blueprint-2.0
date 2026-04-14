/**
 * Post-sync hook — fires after a connector successfully syncs.
 *
 * Responsibilities:
 *   1. Promote any 'pending' agents whose required connectors are now ready.
 *   2. Ask Conductor whether new specialist agents are worth hiring.
 *   3. Dispatch a connector.sync.complete event so the event-triggers module
 *      wakes any agents that care (gated by work-check + cooldown).
 *
 * Every step is fire-and-forget: sync completion path must not slow down for
 * agent orchestration, and agent orchestration must not block the sync.
 */

import db from '../db/db.js';
import { checkAgentReadiness } from '../agents/readiness.js';
import { dispatchAgentEvent, CONNECTOR_AGENT_MAP } from '../agents/event-triggers.js';

// Re-export so callers that imported CONNECTOR_AGENT_MAP from here keep working
export { CONNECTOR_AGENT_MAP };

/**
 * Promote any 'pending' agents whose readiness has flipped to ready.
 */
export function promotePendingAgents(businessId) {
  const pending = db.prepare(
    `SELECT id, name FROM agents WHERE status = 'pending'`
  ).all();
  const promoted = [];
  for (const row of pending) {
    const r = checkAgentReadiness(row.id, businessId);
    if (!r.ready) continue;
    db.prepare("UPDATE agents SET status = 'active' WHERE id = ?").run(row.id);
    promoted.push(row.id);
    console.log(`[post-sync] Promoted '${row.id}' to active (${r.reason})`);
    // Fire-and-forget initial run for the newly-active agent
    (async () => {
      try {
        const { runAgent } = await import('../agents/agent-runner.js');
        await runAgent(row.id, businessId, 'connector_activated', null);
      } catch (err) {
        console.warn(`[post-sync] initial run of '${row.id}' failed:`, err.message);
      }
    })();
  }
  return promoted;
}

/**
 * Fire Conductor hiring analysis. Wrapped in try/catch so it can never
 * poison the sync completion path.
 */
export async function runHiringAnalysis(businessId) {
  try {
    const { analyseAndProposeHires } = await import('../agents/conductor-hiring.js');
    const result = await analyseAndProposeHires(businessId);
    if (result.proposed_hires > 0) {
      console.log(`[post-sync] Conductor proposed ${result.proposed_hires} new hires for ${businessId}`);
      try {
        const { dispatchToAll } = await import('../notifications/dispatcher.js');
        await dispatchToAll(['dashboard'], {
          severity: 'info',
          title: `Conductor recommends ${result.proposed_hires} new agent${result.proposed_hires > 1 ? 's' : ''}`,
          body: 'Based on your connected data sources, new specialist agents may be worth hiring. Review under Tasks.',
        });
      } catch {}
    }
    return result;
  } catch (err) {
    console.warn('[post-sync] hiring analysis failed:', err.message);
    return { proposed_hires: 0, recommendations: [], error: err.message };
  }
}

/**
 * Top-level post-sync orchestrator. Call after a successful connector sync.
 * Fire-and-forget — never awaited by the caller on the critical path.
 */
export function onConnectorSyncSuccess(connectorType, businessId) {
  // 1. Promote pending agents synchronously (cheap DB operation)
  let promoted = [];
  try { promoted = promotePendingAgents(businessId); }
  catch (err) { console.warn('[post-sync] promote failed:', err.message); }

  // 2. Capture ROI baselines for any metric this connector type produces.
  // Idempotent via unique index on (business_id, metric_name) — only the
  // first sync with data actually writes anything, subsequent syncs silently
  // skip. Fire-and-forget.
  import('../roi/baselines.js')
    .then(({ captureBaselinesForConnector }) => {
      const r = captureBaselinesForConnector(businessId, connectorType);
      if (r.recorded > 0) {
        console.log(`[post-sync] ${connectorType}: recorded ${r.recorded} baseline(s) for ${businessId}`);
      }
    })
    .catch((err) => console.warn('[post-sync] baseline capture failed:', err.message));

  // 3. Dispatch the sync event — the event-triggers module handles the
  // canonical wake logic (per-connector agent map + conductor + cooldown +
  // work-check). This replaces the old queueAgentsForConnector + its per-
  // agent MIN_HOURS_BETWEEN_RUNS throttle, which is now redundant: the
  // work-checker skips runs that have nothing new to do regardless of timing.
  dispatchAgentEvent('connector.sync.complete', { connector_type: connectorType }, businessId)
    .catch((err) => console.warn('[post-sync] dispatch failed:', err.message));

  // 3. Hiring analysis (fire-and-forget, involves LLM call)
  runHiringAnalysis(businessId).catch((err) =>
    console.warn('[post-sync] hiring analysis failed:', err.message));

  return { promoted };
}
