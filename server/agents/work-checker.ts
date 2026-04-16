/**
 * Work checker — "is there anything for this agent to do right now?"
 *
 * Runs before every agent run (after the existing readiness gate). Uses only
 * DB queries + local inbox reads — no LLM, no external calls. Completes in
 * milliseconds. Returns { hasWork, reasons, lastRunAt }.
 *
 * The point: existing Blueprint triggers are event-driven (signal, connector
 * sync, inbox, chat mention) but once an agent is woken it always burns LLM
 * tokens, even if the event was a duplicate or the work has since been done
 * by someone else. This module is the cheap pre-LLM gate that returns early
 * when nothing material has changed since the last completed run.
 *
 * Per-agent "work" definitions live in WORK_CONDITIONS below. Each agent
 * cares about a specific subset of: inbox briefs, connector syncs, signals
 * on its domain connectors, chat @mentions, assigned tasks. Conductor is
 * special — it watches the whole mesh.
 */

import db from '../db/db.js';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname);

interface WorkCondition {
  conductor_checks?: boolean;
  connectors?: string[];
  signal_connectors?: string[];
  signal_severities?: string[];
  reacts_to?: {
    chat_mention?: boolean;
    inbox?: boolean;
    assigned_tasks?: boolean;
  };
  inbox_min_priority?: string;
}

interface WorkResult {
  hasWork: boolean;
  reasons: string[];
  lastRunAt: string | null;
}

interface SyncRow {
  type: string;
  created_at: string;
}

interface SignalRow {
  id: string;
  title: string;
  severity: string;
}

interface CountRow {
  n: number;
}

interface RunRow {
  started_at: string;
}

interface FailingAgentRow {
  agent_id: string;
  n: number;
}

/**
 * Per-agent work-condition definitions. Fields:
 *   connectors:        connector types whose sync counts as fresh work
 *   signal_connectors: connector types whose signals count as work
 *   signal_severities: severities that count as work
 *   reacts_to:         { chat_mention, assigned_tasks, inbox }
 *   inbox_min_priority: minimum inbox priority that counts as work —
 *                       'fyi' (any), 'next_run' (skips fyi),
 *                       'immediate' (skips fyi+next_run).
 *                       Defaults to 'next_run' so fyi briefs don't wake agents
 *                       (prevents conductor thrashing on every specialist run).
 */
const WORK_CONDITIONS: Record<string, WorkCondition> = {
  conductor: {
    conductor_checks: true,
    inbox_min_priority: 'next_run',  // fyi briefs don't wake conductor
    reacts_to: { chat_mention: true, inbox: true },
  },
  'seo-sentinel': {
    connectors: ['gsc', 'semrush', 'pagespeed'],
    signal_connectors: ['gsc', 'semrush', 'pagespeed'],
    signal_severities: ['alert', 'critical'],
    reacts_to: { chat_mention: true, inbox: true },
  },
  velocity: {
    connectors: ['pagespeed'],
    signal_connectors: ['pagespeed'],
    signal_severities: ['alert', 'critical'],
    reacts_to: { chat_mention: true, inbox: true },
  },
  'trend-spotter': {
    connectors: ['ga4'],
    signal_connectors: ['ga4', 'gsc'],
    signal_severities: ['warning', 'alert', 'critical'],
    reacts_to: { chat_mention: true, inbox: true },
  },
  merchant: {
    connectors: ['shopify', 'stripe'],
    signal_connectors: ['shopify', 'stripe', 'meta-ads', 'klaviyo'],
    signal_severities: ['warning', 'alert', 'critical'],
    reacts_to: { chat_mention: true, inbox: true, assigned_tasks: true },
  },
  ledger: {
    connectors: ['stripe'],
    signal_connectors: ['stripe'],
    signal_severities: ['warning', 'alert', 'critical'],
    reacts_to: { chat_mention: true, inbox: true },
  },
  sentinel: {
    connectors: ['uptimerobot'],
    signal_connectors: ['uptimerobot'],
    signal_severities: ['alert', 'critical'],
    reacts_to: { chat_mention: true, inbox: true },
  },
  researcher: {
    reacts_to: { chat_mention: true, inbox: true, assigned_tasks: true },
  },
  quill: {
    reacts_to: { chat_mention: true, inbox: true, assigned_tasks: true },
  },
  reporter: {
    // Reporter is mostly schedule-driven (weekly briefing cron elsewhere).
    // Poll-driven work is still fine when tasks arrive.
    reacts_to: { chat_mention: true, inbox: true, assigned_tasks: true },
  },
  dev: {
    connectors: ['github'],
    signal_connectors: ['github', 'server-access'],
    signal_severities: ['warning', 'alert', 'critical'],
    reacts_to: { chat_mention: true, inbox: true, assigned_tasks: true },
  },
  outreach: {
    connectors: ['gbp', 'stannp', 'meta-ads'],
    signal_connectors: ['gbp', 'stannp', 'meta-ads', 'klaviyo', 'brevo'],
    signal_severities: ['warning', 'alert', 'critical'],
    reacts_to: { chat_mention: true, inbox: true, assigned_tasks: true },
  },
};

/**
 * Returns whether an agent has actionable work since its last run.
 */
export function hasWorkToDo(agentId: string, businessId: string): WorkResult {
  const lastRunAt = getLastSuccessfulRunAt(agentId, businessId);
  const cond = WORK_CONDITIONS[agentId];

  // Unknown agent: fall back to "yes, run it" rather than silently blocking.
  // Better to waste one run while we learn what its work conditions should be.
  if (!cond) {
    return {
      hasWork: true,
      reasons: [`no_conditions_defined_for_${agentId}`],
      lastRunAt,
    };
  }

  const reasons: string[] = [];

  // 1. Inbox briefs (all agents that react to inbox)
  if (cond.reacts_to?.inbox) {
    const minPriority = cond.inbox_min_priority ?? 'next_run';
    const unread = countActionableInbox(agentId, minPriority, businessId);
    if (unread > 0) {
      reasons.push(`inbox: ${unread} unread ${minPriority === 'fyi' ? '' : minPriority + ' '}brief(s)`);
    }
  }

  // 2. Conductor gets the full mesh check
  if (cond.conductor_checks) {
    addConductorReasons(reasons, businessId, lastRunAt);
    return { hasWork: reasons.length > 0, reasons, lastRunAt };
  }

  // 3. Connector syncs since last run (for specialist agents)
  if (cond.connectors?.length) {
    const syncs = connectorSyncsSince(cond.connectors, businessId, lastRunAt);
    for (const s of syncs.slice(0, 3)) {
      reasons.push(`sync: ${s.type}`);
    }
  }

  // 4. Signals on this agent's domain
  if (cond.signal_connectors?.length && cond.signal_severities?.length) {
    const sigs = signalsSince(cond.signal_connectors, cond.signal_severities, businessId, lastRunAt);
    for (const s of sigs.slice(0, 3)) {
      reasons.push(`signal: [${s.severity}] ${String(s.title ?? '').slice(0, 60)}`);
    }
  }

  // 5. @mentions in chat
  if (cond.reacts_to?.chat_mention) {
    const n = mentionsSince(agentId, businessId, lastRunAt);
    if (n > 0) reasons.push(`chat: ${n} @mention(s)`);
  }

  // 6. Assigned tasks pending (for agents that execute tasks)
  if (cond.reacts_to?.assigned_tasks) {
    const n = assignedTasksPending(agentId, businessId);
    if (n > 0) reasons.push(`tasks: ${n} assigned`);
  }

  return { hasWork: reasons.length > 0, reasons, lastRunAt };
}

/**
 * Categorise a freeform trigger string into one of the UI buckets so the
 * Settings / System Health pages can count "X event-triggered, Y poll,
 * Z skipped" without each caller maintaining its own mapping.
 */
export function categoriseTrigger(trigger: string | null | undefined): string {
  if (!trigger) return 'unknown';
  const t = String(trigger).toLowerCase();
  if (t === 'manual') return 'manual';
  if (t === 'safety_net_poll' || t === 'scheduled_poll') return 'poll';
  if (t === 'scheduled' || t === 'schedule' || t.startsWith('cron_')) return 'schedule';
  // Everything else (signal, connector_activated, connector_sync_*, brief,
  // chat, bap, post_hire_initial_run, goal_at_risk, etc.) is event-driven.
  return 'event';
}

// ─── Building blocks ──────────────────────────────────────────────────────────

function getLastSuccessfulRunAt(agentId: string, businessId: string): string | null {
  try {
    const row = db.prepare(`
      SELECT started_at FROM agent_runs
       WHERE agent_id = ?
         AND business_id = ?
         AND status IN ('complete', 'skipped')
       ORDER BY started_at DESC
       LIMIT 1
    `).get(agentId, businessId) as RunRow | null;
    return row?.started_at ?? null;
  } catch {
    return null;
  }
}

// Read the agent's inbox.jsonl and count entries that are unread AND meet the
// minimum priority bar. 'fyi' briefs are informational noise that shouldn't
// wake an agent — only next_run or immediate priority counts as work.
function countActionableInbox(agentId: string, minPriority: string, businessId: string): number {
  const path = join(AGENTS_DIR, agentId, 'inbox.jsonl');
  if (!existsSync(path)) return 0;
  const RANK: Record<string, number> = { fyi: 0, next_run: 1, immediate: 2 };
  const threshold = RANK[minPriority] ?? 1;
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    let n = 0;
    for (const l of lines) {
      let e: Record<string, unknown>;
      try { e = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
      if (e.read) continue;
      // Optionally scope to this business (conductor's inbox holds briefs
      // across businesses; specialists are per-business).
      if (businessId && e.business_id && e.business_id !== businessId) continue;
      const p = RANK[e.priority as string] ?? 1;
      if (p >= threshold) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

function connectorSyncsSince(types: string[], businessId: string, lastRunAt: string | null): SyncRow[] {
  if (!types?.length) return [];
  const placeholders = types.map(() => '?').join(',');
  try {
    if (lastRunAt) {
      return db.prepare(`
        SELECT c.type, cs.created_at
          FROM connector_syncs cs
          JOIN connectors c ON c.id = cs.connector_id
         WHERE c.business_id = ?
           AND c.type IN (${placeholders})
           AND cs.status = 'complete'
           AND cs.created_at > ?
         ORDER BY cs.created_at DESC
         LIMIT 5
      `).all(businessId, ...types, lastRunAt) as SyncRow[];
    }
    return db.prepare(`
      SELECT c.type, cs.created_at
        FROM connector_syncs cs
        JOIN connectors c ON c.id = cs.connector_id
       WHERE c.business_id = ?
         AND c.type IN (${placeholders})
         AND cs.status = 'complete'
         AND cs.created_at > datetime('now', '-7 days')
       ORDER BY cs.created_at DESC
       LIMIT 5
    `).all(businessId, ...types) as SyncRow[];
  } catch {
    return [];
  }
}

function signalsSince(connectorTypes: string[], severities: string[], businessId: string, lastRunAt: string | null): SignalRow[] {
  if (!connectorTypes?.length || !severities?.length) return [];
  const cPlaceholders = connectorTypes.map(() => '?').join(',');
  const sPlaceholders = severities.map(() => '?').join(',');
  try {
    if (lastRunAt) {
      return db.prepare(`
        SELECT s.id, s.title, s.severity
          FROM signals s
          LEFT JOIN connectors c ON c.id = s.connector_id
         WHERE s.business_id = ?
           AND c.type IN (${cPlaceholders})
           AND s.severity IN (${sPlaceholders})
           AND s.status IN ('open', 'acknowledged')
           AND s.created_at > ?
         ORDER BY s.created_at DESC
         LIMIT 5
      `).all(businessId, ...connectorTypes, ...severities, lastRunAt) as SignalRow[];
    }
    return db.prepare(`
      SELECT s.id, s.title, s.severity
        FROM signals s
        LEFT JOIN connectors c ON c.id = s.connector_id
       WHERE s.business_id = ?
         AND c.type IN (${cPlaceholders})
         AND s.severity IN (${sPlaceholders})
         AND s.status IN ('open', 'acknowledged')
       ORDER BY s.created_at DESC
       LIMIT 5
    `).all(businessId, ...connectorTypes, ...severities) as SignalRow[];
  } catch {
    return [];
  }
}

function mentionsSince(agentId: string, businessId: string, lastRunAt: string | null): number {
  try {
    const pattern = `%@${agentId}%`;
    if (lastRunAt) {
      return (db.prepare(`
        SELECT COUNT(*) as n FROM chat_messages
         WHERE business_id = ?
           AND sender_type = 'human'
           AND content LIKE ?
           AND created_at > ?
      `).get(businessId, pattern, lastRunAt) as CountRow | null)?.n ?? 0;
    }
    return (db.prepare(`
      SELECT COUNT(*) as n FROM chat_messages
       WHERE business_id = ?
         AND sender_type = 'human'
         AND content LIKE ?
         AND created_at > datetime('now', '-24 hours')
    `).get(businessId, pattern) as CountRow | null)?.n ?? 0;
  } catch {
    return 0;
  }
}

function assignedTasksPending(agentId: string, businessId: string): number {
  try {
    return (db.prepare(`
      SELECT COUNT(*) as n FROM tasks
       WHERE business_id = ?
         AND assigned_to = ?
         AND status IN ('approved', 'executing')
    `).get(businessId, agentId) as CountRow | null)?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Conductor's work conditions — the mesh-wide sweep the HEARTBEAT describes.
 * If any of these return something actionable, Conductor has work.
 */
function addConductorReasons(reasons: string[], businessId: string, lastRunAt: string | null): void {
  try {
    // 1. Any signals open right now — conductor's first job is routing.
    //    Even without "since" filtering, any open signal is fair game.
    const openSignals = lastRunAt
      ? (db.prepare(`
          SELECT COUNT(*) as n FROM signals
           WHERE business_id = ? AND status = 'open'
             AND created_at > ?
        `).get(businessId, lastRunAt) as CountRow | null)?.n ?? 0
      : (db.prepare(`
          SELECT COUNT(*) as n FROM signals
           WHERE business_id = ? AND status = 'open'
             AND created_at > datetime('now', '-24 hours')
        `).get(businessId) as CountRow | null)?.n ?? 0;
    if (openSignals > 0) reasons.push(`signals: ${openSignals} open since last run`);

    // 2. Proposed tasks waiting >2 hours without action
    const waitingTasks = (db.prepare(`
      SELECT COUNT(*) as n FROM tasks
       WHERE business_id = ?
         AND status = 'proposed'
         AND created_at < datetime('now', '-2 hours')
    `).get(businessId) as CountRow | null)?.n ?? 0;
    if (waitingTasks > 0) reasons.push(`tasks: ${waitingTasks} proposed >2h`);

    // 3. Active goals at risk (deadline <7d AND progress <70%)
    const goalsAtRisk = (db.prepare(`
      SELECT COUNT(*) as n FROM goals
       WHERE business_id = ?
         AND status = 'active'
         AND deadline IS NOT NULL
         AND deadline < datetime('now', '+7 days')
         AND (progress_pct IS NULL OR progress_pct < 70)
    `).get(businessId) as CountRow | null)?.n ?? 0;
    if (goalsAtRisk > 0) reasons.push(`goals: ${goalsAtRisk} at risk`);

    // 4. Agents failing 3+ times in last 24h
    const failing = db.prepare(`
      SELECT agent_id, COUNT(*) as n FROM agent_runs
       WHERE business_id = ?
         AND agent_id != 'conductor'
         AND status = 'failed'
         AND started_at > datetime('now', '-24 hours')
       GROUP BY agent_id
       HAVING COUNT(*) >= 3
    `).all(businessId) as FailingAgentRow[];
    if (failing.length > 0) {
      reasons.push(`health: ${failing.map(a => a.agent_id).join(', ')} failing`);
    }

    // 5. Pending hiring recommendations
    const pendingHires = (db.prepare(`
      SELECT COUNT(*) as n FROM tasks
       WHERE business_id = ?
         AND action_type = 'hire_agent'
         AND status = 'proposed'
    `).get(businessId) as CountRow | null)?.n ?? 0;
    if (pendingHires > 0) reasons.push(`hiring: ${pendingHires} pending`);

    // 6. Connector failures in last 24h
    const failedSyncs = (db.prepare(`
      SELECT COUNT(*) as n FROM connector_syncs cs
        JOIN connectors c ON c.id = cs.connector_id
       WHERE c.business_id = ?
         AND cs.status = 'failed'
         AND cs.created_at > datetime('now', '-24 hours')
    `).get(businessId) as CountRow | null)?.n ?? 0;
    if (failedSyncs > 0) reasons.push(`connectors: ${failedSyncs} failing`);
  } catch (err) {
    console.warn('[work-checker] conductor checks failed:', (err as Error).message);
  }
}

// Export for tests and the safety-net poll (Tranche 6B).
export const _internal = {
  WORK_CONDITIONS,
  countActionableInbox,
  getLastSuccessfulRunAt,
};
