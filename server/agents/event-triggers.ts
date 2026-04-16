/**
 * Unified event → agent dispatcher.
 *
 * This is the canonical entry point for "something happened, wake the right
 * agent(s)". One call site, one cooldown model, one work-check gate.
 *
 * The three existing dispatchers (post-sync.queueAgentsForConnector,
 * signal-intelligence.triggerRelevantAgents, agent-inbox.deliverAgentBrief
 * with priority='immediate') predate this module. Tranche 6B refactors
 * post-sync to use dispatchAgentEvent. signal-intelligence and agent-inbox
 * keep their specialist logic (profile.signal_triggers YAML lookup,
 * per-brief priority handling) and can migrate to this module later if
 * their logic ever converges.
 *
 * Design:
 *   - Cooldown per wake (not per event): prevents one agent from being
 *     woken 10x by 10 signals in a minute. Conductor gets 5-min cooldown
 *     (orchestrator needs fresh state); others get 15-min default.
 *   - Critical/alert signals and immediate-priority briefs override the
 *     cooldown — these are time-sensitive by definition.
 *   - Every wake goes through hasWorkToDo() before spawning a runAgent
 *     call. If the agent has no actual work, skip silently — no spurious
 *     agent_runs row for "event triggered but nothing to do". The agent
 *     runner's own work-check gate covers races.
 *   - Fire-and-forget: callers never wait for dispatch to finish.
 */

import db from '../db/db.js';

interface EventTriggerConfig {
  event: string;
  condition?: string;
  agent_id?: string;
  [key: string]: unknown;
}

interface EventTarget {
  agentId: string;
  trigger: string;
  triggerId: string | null;
}

interface EventData {
  connector_type?: string;
  connector_id?: string;
  signal_id?: string;
  task_id?: string;
  goal_id?: string;
  to_agent?: string;
  agent_id?: string;
  conversation_id?: string;
  [key: string]: unknown;
}

// Which specialist agents care about which connector type sync.
// Conductor is added to every sync automatically (it's the orchestrator).
const CONNECTOR_AGENT_MAP: Record<string, string[]> = {
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
  klaviyo:      ['merchant', 'quill'],
  semrush:      ['seo-sentinel'],
};

const DEFAULT_COOLDOWN_MINUTES    = 15;
const CONDUCTOR_COOLDOWN_MINUTES  = 5;

// Event types that bypass the cooldown check — they're time-sensitive.
const COOLDOWN_OVERRIDE_EVENTS = new Set<string>([
  'signal.critical',
  'signal.alert',
  'agent.brief.immediate',
]);

// Event types the Conductor always cares about (added as an extra target
// regardless of event-specific routing).
const CONDUCTOR_GENERAL_EVENTS = new Set<string>([
  'signal.critical',
  'signal.alert',
  'signal.created',
  'task.approved',
  'task.complete',
  'task.failed',
  'goal.created',
  'goal.at_risk',
  'kb.ingest.complete',
]);

/**
 * Dispatch an event to the relevant agents.
 *
 * @param eventType  e.g. 'connector.sync.complete', 'signal.critical',
 *                   'task.approved', 'goal.at_risk', 'agent.brief.immediate'
 * @param eventData  event-specific payload
 * @param businessId
 */
export async function dispatchAgentEvent(
  eventType: string,
  eventData: EventData = {},
  businessId: string,
): Promise<void> {
  if (!eventType || !businessId) return;

  try {
    const targets = resolveEventTargets(eventType, eventData);
    if (targets.length === 0) return;

    const overrideCooldown = COOLDOWN_OVERRIDE_EVENTS.has(eventType);

    for (const target of targets) {
      // Fire each wake without awaiting — one agent being slow mustn't
      // delay dispatch to others.
      wakeAgent({
        agentId: target.agentId,
        businessId,
        trigger: target.trigger ?? eventType,
        triggerId: target.triggerId ?? eventData.signal_id ?? eventData.task_id ?? eventData.goal_id ?? null,
        overrideCooldown,
      }).catch((err: unknown) => {
        console.warn(`[event-triggers] wake ${target.agentId} for ${eventType} failed:`, (err as Error).message);
      });
    }
  } catch (err) {
    console.warn(`[event-triggers] dispatchAgentEvent(${eventType}) failed:`, (err as Error).message);
  }
}

/**
 * Map an event type + data to a list of { agentId, trigger, triggerId } targets.
 * Deliberately a pure function so it's easy to test.
 */
export function resolveEventTargets(eventType: string, eventData: EventData = {}): EventTarget[] {
  const targets: EventTarget[] = [];
  const seen = new Set<string>();
  const push = (agentId: string, trigger: string, triggerId: string | null = null): void => {
    if (!agentId) return;
    const key = `${agentId}|${trigger}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ agentId, trigger, triggerId });
  };

  // Connector syncs → specialists per map + Conductor
  if (eventType === 'connector.sync.complete') {
    const type = eventData.connector_type;
    const trigger = type ? `connector_sync_${type}` : 'connector_sync';
    if (type && CONNECTOR_AGENT_MAP[type]) {
      for (const agentId of CONNECTOR_AGENT_MAP[type]) push(agentId, trigger);
    }
    push('conductor', trigger);
    return targets;
  }

  // Agent briefs with immediate priority → the specific target
  if (eventType === 'agent.brief.immediate') {
    if (eventData.to_agent) push(eventData.to_agent, 'brief');
    return targets;
  }

  // Chat mentions → the specific mentioned agent
  if (eventType === 'chat.mention') {
    if (eventData.agent_id) push(eventData.agent_id, 'chat');
    return targets;
  }

  // Signals → domain routing is handled by signal-intelligence for YAML-based
  // signal_triggers matching. Here we add Conductor as the generic orchestrator
  // target so it always sees a new signal. signal-intelligence runs in parallel
  // and handles the specialist wake via its own path.
  if (eventType.startsWith('signal.') && CONDUCTOR_GENERAL_EVENTS.has(eventType)) {
    push('conductor', eventType, eventData.signal_id ?? null);
    return targets;
  }

  // Task, goal, KB events → Conductor routes
  if (CONDUCTOR_GENERAL_EVENTS.has(eventType)) {
    push('conductor', eventType);
    return targets;
  }

  return targets;
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function wakeAgent({
  agentId,
  businessId,
  trigger,
  triggerId,
  overrideCooldown,
}: {
  agentId: string;
  businessId: string;
  trigger: string;
  triggerId: string | null;
  overrideCooldown: boolean;
}): Promise<void> {
  // Agent must be installed + active (agents table has no business_id —
  // installed agents are global, activeness is per-install).
  const agent = db.prepare("SELECT id, status FROM agents WHERE id = ?").get(agentId) as { id: string; status: string } | null;
  if (!agent || agent.status !== 'active') return;

  // Cooldown check (unless overridden by a time-sensitive event).
  if (!overrideCooldown) {
    const cooldownMin = agentId === 'conductor'
      ? CONDUCTOR_COOLDOWN_MINUTES
      : DEFAULT_COOLDOWN_MINUTES;
    const recent = db.prepare(`
      SELECT id FROM agent_runs
       WHERE agent_id = ? AND business_id = ?
         AND started_at > datetime('now', '-' || ? || ' minutes')
       LIMIT 1
    `).get(agentId, businessId, cooldownMin) as { id: string } | null;
    if (recent) return; // in cooldown — stay quiet
  }

  // Work check — if nothing material changed, don't spawn a run.
  // The runner's own gate is a belt-and-braces race catcher; skipping
  // here avoids polluting agent_runs with "event triggered but no work" rows.
  const { hasWorkToDo } = await import('./work-checker.js') as unknown as { hasWorkToDo: (agentId: string, businessId: string) => { hasWork: boolean } };
  const work = hasWorkToDo(agentId, businessId);
  if (!work.hasWork) return;

  // Spawn the run. runAgent is fire-and-forget from here — the dispatcher
  // doesn't await individual agent completion.
  const { runAgent } = await import('./agent-runner.js') as unknown as { runAgent: (agentId: string, businessId: string, trigger: string, triggerId: string | null) => Promise<void> };
  runAgent(agentId, businessId, trigger, triggerId).catch((err: unknown) => {
    console.warn(`[event-triggers] runAgent(${agentId}) failed:`, (err as Error).message);
  });
}

// Re-export the map so callers (post-sync, settings UI) can see the
// canonical connector → agent routing without maintaining a parallel copy.
export { CONNECTOR_AGENT_MAP };
export type { EventTriggerConfig };
