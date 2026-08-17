/**
 * Post-sync hook — fires after a connector successfully syncs.
 */

import db from '../db/db.js';
import { checkAgentReadiness } from '../agents/readiness.js';
import { dispatchAgentEvent, CONNECTOR_AGENT_MAP } from '../agents/event-triggers.js';

// Re-export so callers that imported CONNECTOR_AGENT_MAP from here keep working
export { CONNECTOR_AGENT_MAP };

/**
 * Promote any 'pending' agents whose readiness has flipped to ready.
 */
export function promotePendingAgents(businessId: string): string[] {
  const pending = db.prepare(
    `SELECT id, name FROM agents WHERE status = 'pending'`
  ).all() as Array<{ id: string; name: string }>;
  const promoted: string[] = [];
  for (const row of pending) {
    const r = checkAgentReadiness(row.id, businessId);
    if (!r.ready) continue;
    db.prepare("UPDATE agents SET status = 'active' WHERE id = ?").run(row.id);
    promoted.push(row.id);
    console.log(`[post-sync] Promoted '${row.id}' to active (${r.reason})`);
    // Fire-and-forget initial run for the newly-active agent
    (async () => {
      try {
        const { runAgent } = await import('../agents/agent-runner.js') as unknown as { runAgent: (...args: any[]) => Promise<any> };
        await runAgent(row.id, businessId, 'connector_activated', null);
      } catch (err: any) {
        console.warn(`[post-sync] initial run of '${row.id}' failed:`, err.message);
      }
    })();
  }
  return promoted;
}

/**
 * Fire Conductor hiring analysis after a sync.
 *
 * This is now a thin adapter over the single hiring-analysis service: it
 * supplies the trigger provenance and nothing else. Debounce/cooldown,
 * coalescing with the signal-engine and scheduler triggers, the kill switch,
 * dry-run enforcement and the proposal notification all live in the service
 * (issues #46, #57, #47), so every trigger path behaves identically.
 */
export async function runHiringAnalysis(
  businessId: string,
  opts: { connectorType?: string } = {},
): Promise<{ proposed_hires: number; recommendations: any[]; status?: string; terminal_reason?: string; analysis_id?: string | null; error?: string }> {
  try {
    const { analyseAndProposeHires } = await import('../agents/conductor-hiring.js');
    const result = await analyseAndProposeHires(businessId, {
      trigger: 'connector_sync',
      triggerRef: opts.connectorType ?? null,
      triggerReason: opts.connectorType
        ? `${opts.connectorType} connector sync completed`
        : 'connector sync completed',
    });
    if (result.proposed_hires > 0) {
      console.log(`[post-sync] Conductor proposed ${result.proposed_hires} new hire(s) for ${businessId}`);
    } else {
      console.log(`[post-sync] hiring analysis for ${businessId}: ${result.status}/${result.terminal_reason}`);
    }
    return {
      proposed_hires: result.proposed_hires,
      recommendations: result.recommendations,
      status: result.status,
      terminal_reason: result.terminal_reason,
      analysis_id: result.analysis_id,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err: any) {
    console.warn('[post-sync] hiring analysis failed:', err.message);
    return { proposed_hires: 0, recommendations: [], status: 'failed', terminal_reason: 'internal_error', error: err.message };
  }
}

/**
 * Top-level post-sync orchestrator. Call after a successful connector sync.
 */
export function onConnectorSyncSuccess(connectorType: string, businessId: string): { promoted: string[] } {
  // 1. Promote pending agents synchronously (cheap DB operation)
  let promoted: string[] = [];
  try { promoted = promotePendingAgents(businessId); }
  catch (err: any) { console.warn('[post-sync] promote failed:', err.message); }

  // 2. Capture ROI baselines for any metric this connector type produces.
  import('../roi/baselines.js')
    .then(({ captureBaselinesForConnector }: any) => {
      const r = captureBaselinesForConnector(businessId, connectorType);
      if (r.recorded > 0) {
        console.log(`[post-sync] ${connectorType}: recorded ${r.recorded} baseline(s) for ${businessId}`);
      }
    })
    .catch((err: any) => console.warn('[post-sync] baseline capture failed:', err.message));

  // 3. Dispatch the sync event
  dispatchAgentEvent('connector.sync.complete', { connector_type: connectorType }, businessId)
    .catch((err: any) => console.warn('[post-sync] dispatch failed:', err.message));

  // 4. Hiring analysis (fire-and-forget, involves an LLM call). The service
  //    coordinates this with every other trigger for the same business, so a
  //    burst of connector syncs produces one analysis, not one per connector.
  runHiringAnalysis(businessId, { connectorType }).catch((err: any) =>
    console.warn('[post-sync] hiring analysis failed:', err.message));

  return { promoted };
}
