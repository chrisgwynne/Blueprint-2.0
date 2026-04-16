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
 * Fire Conductor hiring analysis.
 */
export async function runHiringAnalysis(businessId: string): Promise<{ proposed_hires: number; recommendations: any[]; error?: string }> {
  try {
    const { analyseAndProposeHires } = await import('../agents/conductor-hiring.js') as unknown as { analyseAndProposeHires: (id: string) => Promise<{ proposed_hires: number; recommendations: any[] }> };
    const result = await analyseAndProposeHires(businessId);
    if (result.proposed_hires > 0) {
      console.log(`[post-sync] Conductor proposed ${result.proposed_hires} new hires for ${businessId}`);
      try {
        const { dispatchToAll } = await import('../notifications/dispatcher.js') as unknown as { dispatchToAll: (channels: string[], notification: any) => Promise<any> };
        await dispatchToAll(['dashboard'], {
          severity: 'info',
          title: `Conductor recommends ${result.proposed_hires} new agent${result.proposed_hires > 1 ? 's' : ''}`,
          body: 'Based on your connected data sources, new specialist agents may be worth hiring. Review under Tasks.',
        });
      } catch {}
    }
    return result;
  } catch (err: any) {
    console.warn('[post-sync] hiring analysis failed:', err.message);
    return { proposed_hires: 0, recommendations: [], error: err.message };
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

  // 3. Hiring analysis (fire-and-forget, involves LLM call)
  runHiringAnalysis(businessId).catch((err: any) =>
    console.warn('[post-sync] hiring analysis failed:', err.message));

  return { promoted };
}
