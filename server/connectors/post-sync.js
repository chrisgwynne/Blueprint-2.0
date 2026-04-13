/**
 * Post-sync hook — fires after a connector successfully syncs.
 *
 * Responsibilities:
 *   1. Promote any 'pending' agents whose required connectors are now ready.
 *   2. Ask Conductor whether new specialist agents are worth hiring.
 *   3. Queue scheduled runs for agents that care about this connector type
 *      (respecting readiness + minimum-hours-between-runs throttle).
 *
 * Every step is fire-and-forget: sync completion path must not slow down for
 * agent orchestration, and agent orchestration must not block the sync.
 */

import db from '../db/db.js';
import { checkAgentReadiness } from '../agents/readiness.js';

/**
 * Which specialist agents care about a given connector type. An agent run is
 * queued when the connector it depends on has fresh data.
 */
export const CONNECTOR_AGENT_MAP = {
  gsc:          ['seo-sentinel', 'trend-spotter', 'quill'],
  ga4:          ['trend-spotter', 'seo-sentinel', 'quill'],
  pagespeed:    ['velocity'],
  shopify:      ['merchant', 'quill'],
  stripe:       ['ledger'],
  uptimerobot:  ['sentinel'],
  github:       ['dev'],
  gbp:          ['outreach'],
  stannp:       ['outreach'],
  brevo:        ['outreach', 'quill'],
  'meta-ads':   ['outreach', 'merchant'],
};

/**
 * Minimum hours between runs for each agent. Prevents firing the same agent
 * on every connector sync when multiple connectors sync in quick succession.
 */
const MIN_HOURS_BETWEEN_RUNS = {
  'seo-sentinel': 6,
  'trend-spotter': 12,
  'merchant': 4,
  'velocity': 12,
  'sentinel': 1,
  'ledger': 12,
  'dev': 12,
  'outreach': 12,
  'quill': 12,
};
const DEFAULT_MIN_HOURS = 6;

function hoursSince(isoLike) {
  if (!isoLike) return Infinity;
  const iso = typeof isoLike === 'string' && !/[zZ]|[+-]\d{2}/.test(isoLike)
    ? isoLike.replace(' ', 'T') + 'Z'
    : isoLike;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 3600_000;
}

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
 * Queue runs for agents that care about this connector type, throttled by
 * MIN_HOURS_BETWEEN_RUNS and gated by readiness.
 */
export async function queueAgentsForConnector(connectorType, businessId) {
  const interested = CONNECTOR_AGENT_MAP[connectorType] || [];
  if (interested.length === 0) return [];

  const queued = [];
  for (const agentId of interested) {
    const agentRow = db.prepare(
      `SELECT id, status FROM agents WHERE id = ? AND status = 'active'`
    ).get(agentId);
    if (!agentRow) continue; // not installed or not active

    const r = checkAgentReadiness(agentId, businessId);
    if (!r.ready) continue;

    const lastRun = db.prepare(`
      SELECT started_at FROM agent_runs
      WHERE agent_id = ? AND business_id = ? AND status = 'complete'
      ORDER BY started_at DESC LIMIT 1
    `).get(agentId, businessId);
    const minHours = MIN_HOURS_BETWEEN_RUNS[agentId] ?? DEFAULT_MIN_HOURS;
    if (hoursSince(lastRun?.started_at) < minHours) continue;

    // Queue a run — fire and forget, don't block the sync completion path.
    (async () => {
      try {
        const { runAgent } = await import('../agents/agent-runner.js');
        await runAgent(agentId, businessId, `connector_sync_${connectorType}`, null);
      } catch (err) {
        console.warn(`[post-sync] run of '${agentId}' failed:`, err.message);
      }
    })();
    queued.push(agentId);
  }
  return queued;
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

  // 2. Queue runs for agents that care about this connector (fire-and-forget)
  queueAgentsForConnector(connectorType, businessId).catch((err) =>
    console.warn('[post-sync] queueAgents failed:', err.message));

  // 3. Hiring analysis (fire-and-forget, involves LLM call)
  runHiringAnalysis(businessId).catch((err) =>
    console.warn('[post-sync] hiring analysis failed:', err.message));

  return { promoted };
}
