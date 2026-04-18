/**
 * Constraint-aware scheduling (Feature 8).
 */
import crypto from 'crypto';
import db from '../db/db.js';
import type { SchedulerLog } from '../types/db.js';
import type { TaskRow as Task } from '../tasks/task-queue.js';

interface AgentMetricMap {
  [agentId: string]: string[];
}

interface AgentDataFreshness {
  [agentId: string]: { connector: string; max_age_hours: number };
}

// Agent → primary metric types this agent analyses.
const AGENT_METRIC_MAP: AgentMetricMap = {
  'seo-sentinel':  ['gsc.total_clicks', 'gsc.avg_ctr', 'gsc.impressions', 'gsc.queries'],
  'quill':         ['gsc.total_clicks', 'ga4.sessions'],
  'velocity':      ['pagespeed.mobile.performance_score', 'pagespeed.mobile.lcp_ms'],
  'merchant':      ['shopify.conversion_rate', 'shopify.revenue'],
  'ledger':        ['stripe.revenue', 'stripe.mrr'],
  'trend-spotter': ['ga4.sessions', 'gsc.impressions'],
};

const AGENT_DATA_FRESHNESS: AgentDataFreshness = {
  'seo-sentinel': { connector: 'gsc', max_age_hours: 24 },
  'quill':        { connector: 'gsc', max_age_hours: 24 },
  'velocity':     { connector: 'pagespeed', max_age_hours: 24 },
  'merchant':     { connector: 'shopify', max_age_hours: 12 },
  'ledger':       { connector: 'stripe', max_age_hours: 12 },
};

interface ConstraintResult {
  allowed: boolean;
  reason: string | null;
  delay_until: string | null;
  constraints: Record<string, unknown>;
}

interface LogDecisionRow {
  job_name: string;
  business_id?: string | null;
  decision: string;
  was_scheduled_for?: string | null;
  delayed_to?: string | null;
  reason?: string | null;
  constraints?: Record<string, unknown> | null;
}

function logDecision(row: LogDecisionRow): void {
  db.prepare(`
    INSERT INTO scheduler_log
    (id, job_name, business_id, decision, was_scheduled_for, delayed_to,
     reason, constraints_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    row.job_name, row.business_id ?? null,
    row.decision,
    row.was_scheduled_for ?? new Date().toISOString(),
    row.delayed_to ?? null,
    row.reason ?? null,
    row.constraints ? JSON.stringify(row.constraints) : null
  );
}

/**
 * Check constraints for an agent run on a business.
 */
export function checkAgentConstraints(agentId: string, businessId: string): ConstraintResult {
  const constraints: Record<string, unknown> = { in_flight_count: 0, data_stale: false };

  // 1. Too many in-flight actions affecting this agent's metrics?
  const metrics = AGENT_METRIC_MAP[agentId] || [];
  if (metrics.length > 0) {
    const placeholders = metrics.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM action_memory am
      WHERE am.business_id = ? AND am.outcome_measured = 0
        AND EXISTS (
          SELECT 1 FROM json_each(am.metrics_expected) me WHERE me.value IN (${placeholders})
        )
    `).get(businessId, ...metrics) as { n: number } | undefined;
    const inFlightCount = row?.n ?? 0;
    constraints.in_flight_count = inFlightCount;
    if (inFlightCount >= 3) {
      const delay = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      return {
        allowed: false,
        reason: `${inFlightCount} in-flight actions affecting this agent's metrics — delay 24h to avoid contaminated analysis.`,
        delay_until: delay,
        constraints,
      };
    }
  }

  // 2. Data freshness check
  const freshness = AGENT_DATA_FRESHNESS[agentId];
  if (freshness) {
    const connector = db.prepare(
      'SELECT id, last_sync FROM connectors WHERE business_id = ? AND type = ? ORDER BY last_sync DESC LIMIT 1'
    ).get(businessId, freshness.connector) as { id: string; last_sync: string } | undefined;
    if (connector?.last_sync) {
      const hoursAgo = (Date.now() - new Date(connector.last_sync).getTime()) / 3600000;
      if (hoursAgo > freshness.max_age_hours) {
        constraints.data_stale = true;
        constraints.data_age_hours = Math.round(hoursAgo);
        const delay = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
        return {
          allowed: false,
          reason: `${freshness.connector.toUpperCase()} data is ${Math.round(hoursAgo)}h stale — wait for next sync.`,
          delay_until: delay,
          constraints,
        };
      }
    }
  }

  return { allowed: true, reason: null, delay_until: null, constraints };
}

/**
 * Run an agent with constraint checks applied.
 */
export async function runAgentWithConstraints(agentId: string, businessId: string, trigger: string, triggerId: string | null, opts?: { skipCooldown?: boolean }): Promise<unknown> {
  const check = checkAgentConstraints(agentId, businessId);
  if (!check.allowed) {
    logDecision({
      job_name: `agent:${agentId}`,
      business_id: businessId,
      decision: 'delayed',
      delayed_to: check.delay_until,
      reason: check.reason,
      constraints: check.constraints,
    });
    console.log(`[scheduler] '${agentId}' delayed: ${check.reason}`);
    return { skipped: true, delayed_until: check.delay_until, reason: check.reason };
  }
  logDecision({
    job_name: `agent:${agentId}`,
    business_id: businessId,
    decision: 'ran',
    reason: null,
    constraints: check.constraints,
  });
  const { runAgent } = await import('../agents/agent-runner.js') as unknown as { runAgent: (...args: any[]) => Promise<any> };
  return runAgent(agentId, businessId, trigger, triggerId, opts);
}

/**
 * Smart spacing — when a task completes, update any pending/deferred tasks
 * affecting the same URL/entity to defer until the measurement window closes.
 */
export function applySmartSpacing(completedTask: Task): number {
  if (!completedTask?.action_type) return 0;
  let payload: Record<string, unknown> = {};
  try { payload = typeof completedTask.action_payload === 'string' ? JSON.parse(completedTask.action_payload) : (completedTask.action_payload || {}); } catch {}
  const url = payload.url;
  if (!url) return 0;

  const mem = db.prepare(
    'SELECT do_not_touch_until FROM action_memory WHERE task_id = ? LIMIT 1'
  ).get(completedTask.id) as { do_not_touch_until: string } | undefined;
  if (!mem?.do_not_touch_until) return 0;

  const affected = db.prepare(`
    UPDATE tasks
    SET status = 'deferred',
        deferred_until = ?,
        deferred_reason = 'Smart-spaced: related task just completed on same URL',
        updated_at = CURRENT_TIMESTAMP
    WHERE business_id = ?
      AND id != ?
      AND status IN ('proposed')
      AND action_payload LIKE ?
  `).run(
    mem.do_not_touch_until,
    completedTask.business_id,
    completedTask.id,
    `%"url":"${url}"%`
  );
  return affected.changes || 0;
}

/**
 * Return recent scheduler decisions for System Health display.
 */
export function listRecentSchedulerLog(limit: number = 50): SchedulerLog[] {
  return db.prepare(`
    SELECT * FROM scheduler_log
    ORDER BY created_at DESC LIMIT ?
  `).all(limit) as SchedulerLog[];
}
