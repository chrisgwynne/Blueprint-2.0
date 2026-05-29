import db from '../db/db.js';
import { runAgent } from './agent-runner.js';
import { runAgentWithConstraints } from '../jobs/constraint-check.js';
import yaml from 'js-yaml';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { matchAgent, recordActivation, MAX_ACTIVE_AGENTS, countBusyAgents, isScopeInFlight, deriveRequirements } from './agentMatcher.js';
import { evaluateActivation } from './agentActivationRules.js';
import { getAgentScope, getLifecycleState, isInCooldown, BUSY_STATES, LIVE_STATES, type AgentLifecycleState } from './agentLifecycle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

interface AgentRow {
  id: string;
  profile_path: string;
  last_run?: string | null;
  status: string;
  [key: string]: unknown;
}

interface SignalRow {
  id: string;
  rule_id: string;
  business_id: string;
  status: string;
  [key: string]: unknown;
}

interface AgentProfile {
  id?: string;
  name?: string;
  description?: string;
  system_prompt?: string;
  signal_triggers?: string[];
  scheduled_jobs?: ScheduledJob[];
  llm?: { provider?: string; model?: string; temperature?: number; max_tokens?: number };
  [key: string]: unknown;
}

interface ScheduledJob {
  id: string;
  cron?: string;
  [key: string]: unknown;
}

interface ConductorRun {
  agentId: string;
  trigger: 'signal' | 'schedule';
  signalId?: string;
  jobId?: string;
  error?: string;
  [key: string]: unknown;
}

interface BusinessRow {
  id: string;
  name: string;
}

interface SignalMatch {
  agent: AgentRow;
  signal: SignalRow;
  matchedAreas: string[];
  reason: string;
  confidence: number;
  alternatives: Array<{ agent_id: string; reason: string }>;
}

/**
 * Deterministically route open signals to the single best-match agent using
 * the scope-aware matcher + activation rules, instead of waking every agent
 * whose signal_triggers list happens to include the rule_id.
 *
 * A signal routes to an agent ONLY when:
 *   - the signal's derived knowledge areas intersect the agent's kb_scope, AND
 *   - the activation gate allows it (not in cooldown, not busy, not a duplicate
 *     of an in-flight scope, within the max-active cap).
 *
 * This is the fix for "agents activate merely because some signal exists".
 */
function matchSignalsToAgents(
  agents: AgentRow[],
  signals: SignalRow[],
  _profileMap: Map<string, AgentProfile>
): SignalMatch[] {
  const matches: SignalMatch[] = [];
  const seenAgents = new Set<string>(); // one signal-driven run per agent per cycle
  const liveAgentIds = new Set(
    agents
      .filter((a) => {
        const state = getLifecycleState(a.id);
        return state ? (LIVE_STATES as readonly string[]).includes(state) : a.status === 'active';
      })
      .map((a) => a.id)
  );

  let activeBudget = Math.max(0, MAX_ACTIVE_AGENTS - countBusyAgents());

  for (const signal of signals) {
    if (activeBudget <= 0) break; // max-active-agents cap
    const businessId = signal.business_id;

    // Resolve the connector type behind the signal so areas derive cleanly.
    const sigExtra = signal as { connector_type?: string | null; connector_id?: string | null; type?: string | null; severity?: string | null };
    const connectorType: string | null = sigExtra.connector_type
      ?? resolveConnectorType(sigExtra.connector_id ?? null);

    const match = matchAgent(
      { rule_id: signal.rule_id, connector_type: connectorType, type: sigExtra.type ?? null, severity: sigExtra.severity ?? null },
      businessId
    );
    const best = match.best;
    if (!best) continue;                       // no owner → leave for a human
    if (match.should_be_manual) continue;      // matcher says route to a human
    if (seenAgents.has(best.agent_id)) continue;
    if (!liveAgentIds.has(best.agent_id)) continue;

    const agent = agents.find((a) => a.id === best.agent_id);
    if (!agent) continue;

    // Activation gate — the central allow/deny with explainable reasons.
    const scope = getAgentScope(best.agent_id);
    const state = getLifecycleState(best.agent_id);
    const decision = evaluateActivation({
      agentId: best.agent_id,
      channel: 'signal',
      agentScope: scope.kb_scope,
      agentDataSources: scope.data_sources_allowed,
      triggerAreas: match.requirements.areas,
      triggerConnectorType: connectorType,
      inCooldown: isInCooldown(best.agent_id),
      busy: state ? (BUSY_STATES as readonly string[]).includes(state) : false,
      duplicateScopeInFlight: isScopeInFlight(match.requirements, businessId, best.agent_id),
      isLive: state ? (LIVE_STATES as readonly string[]).includes(state) : agent.status === 'active',
    });
    if (!decision.allowed) {
      console.log(`[conductor] Skipping '${best.agent_id}' for signal '${signal.rule_id}': ${decision.reason}`);
      continue;
    }

    seenAgents.add(best.agent_id);
    activeBudget -= 1;
    matches.push({
      agent,
      signal,
      matchedAreas: decision.matchedAreas,
      reason: match.assignment_reason,
      confidence: Math.min(1, 0.5 + decision.matchedAreas.length * 0.15),
      alternatives: match.backup ? [{ agent_id: match.backup.agent_id, reason: match.backup.reason }] : [],
    });
  }

  return matches;
}

/** Resolve a connector's type from its id (best-effort). */
function resolveConnectorType(connectorId: string | null): string | null {
  if (!connectorId) return null;
  try {
    const row = db.prepare('SELECT type FROM connectors WHERE id = ?').get(connectorId) as { type: string } | null;
    return row?.type ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a cron expression matches the current time (within a 1-minute window).
 */
function cronMatchesNow(cronExpr: string): boolean {
  try {
    return cron.validate(cronExpr);
  } catch {
    return false;
  }
}

/**
 * Determine which scheduled jobs are due to run now.
 * We compare the last_run time with the expected cron schedule.
 */
function getDueScheduledJobs(agent: AgentRow, profile: AgentProfile): ScheduledJob[] {
  const jobs = profile.scheduled_jobs ?? [];
  const dueJobs: ScheduledJob[] = [];
  const now = Date.now();

  for (const job of jobs) {
    if (!job.cron || !cron.validate(job.cron)) continue;

    const lastRun = agent.last_run ? new Date(agent.last_run).getTime() : 0;
    // Simple heuristic: check if we're within 5 minutes of a scheduled time
    // node-cron doesn't expose next-run time easily, so we check the interval pattern

    // Parse cron to determine minimum interval (in ms)
    const parts = job.cron.split(' ');
    let intervalMs = 60 * 60 * 1000; // default 1 hour

    if (parts[1] === '*') intervalMs = 60 * 60 * 1000; // every hour
    else if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      // Daily: "0 7 * * *" etc.
      intervalMs = 24 * 60 * 60 * 1000;
    } else if (parts[4] !== '*') {
      // Weekly
      intervalMs = 7 * 24 * 60 * 60 * 1000;
    }

    // If last run was more than intervalMs ago, consider it due
    if (now - lastRun >= intervalMs * 0.95) { // 5% tolerance
      dueJobs.push(job);
    }
  }

  return dueJobs;
}

/**
 * Main conductor function.
 * Orchestrates all agents for a business — matches signals and runs scheduled jobs.
 */
export async function runConductor(businessId: string): Promise<{ runs: ConductorRun[]; errors: ConductorRun[] }> {
  console.log(`[conductor] Starting conductor run for business ${businessId}`);

  // 1. Get all active agents
  const agents = db.prepare(`SELECT * FROM agents WHERE status = 'active'`).all() as AgentRow[];
  if (agents.length === 0) {
    console.log('[conductor] No active agents found.');
    return { runs: [], errors: [] };
  }

  // 2. Load all YAML profiles. Canonical location is /server/agents/profiles/{id}.yaml.
  // Falls back to legacy agent.profile_path for any straggler.
  const CANONICAL_PROFILES_DIR = resolve(PROJECT_ROOT, 'server/agents/profiles');
  const profileMap = new Map<string, AgentProfile>();
  for (const agent of agents) {
    const candidates = [
      resolve(CANONICAL_PROFILES_DIR, `${agent.id}.yaml`),
      resolve(PROJECT_ROOT, agent.profile_path),
    ];
    let loaded = false;
    for (const profilePath of candidates) {
      if (!existsSync(profilePath)) continue;
      try {
        const profile = yaml.load(readFileSync(profilePath, 'utf8')) as AgentProfile;
        profileMap.set(agent.id, profile);
        loaded = true;
        break;
      } catch (err) {
        console.error(`[conductor] Failed to parse profile for agent ${agent.id} at ${profilePath}:`, (err as Error).message);
      }
    }
    if (!loaded) {
      console.warn(`[conductor] Profile not found for agent ${agent.id} (tried: ${candidates.join(', ')})`);
    }
  }

  // 3. Get open signals (with the connector type so we can derive knowledge
  //    areas for scope-based routing).
  const openSignals = db.prepare(`
    SELECT s.*, c.type AS connector_type
    FROM signals s
    LEFT JOIN connectors c ON c.id = s.connector_id
    WHERE s.business_id = ? AND s.status IN ('open', 'acknowledged')
    ORDER BY s.created_at DESC LIMIT 50
  `).all(businessId) as SignalRow[];

  // 4. Match signals to agents (deterministic, scope-aware, activation-gated)
  const signalMatches = matchSignalsToAgents(agents, openSignals, profileMap);

  const runs: ConductorRun[] = [];
  const errors: ConductorRun[] = [];

  // 5. Run signal-triggered agents. Each run is preceded by a recorded
  //    activation (trigger source, matched areas, selection reason,
  //    alternatives, confidence, evidence) and bracketed by lifecycle
  //    transitions standby → triggered → working → (verified|standby|blocked).
  for (const m of signalMatches) {
    const { agent, signal } = m;
    const { runWithActivation } = await import('./agentActivationService.js');
    try {
      console.log(`[conductor] Activating '${agent.id}' for signal '${signal.rule_id}' — ${m.reason}`);
      const result = await runWithActivation({
        agentId: agent.id,
        businessId,
        channel: 'signal',
        trigger: 'signal',
        triggerRef: signal.id,
        matchedAreas: m.matchedAreas,
        selectionReason: m.reason,
        alternatives: m.alternatives,
        confidence: m.confidence,
        evidence: [{ type: 'signal', id: signal.id, rule_id: signal.rule_id, severity: signal.severity }],
      });
      runs.push({ agentId: agent.id, trigger: 'signal', signalId: signal.id, ...(result as Record<string, unknown>) });
    } catch (err) {
      console.error(`[conductor] Agent '${agent.id}' failed for signal '${signal.id}':`, (err as Error).message);
      errors.push({ agentId: agent.id, trigger: 'signal', signalId: signal.id, error: (err as Error).message });
    }
  }

  // 6. Run scheduled jobs for agents whose cron is due
  for (const agent of agents) {
    const profile = profileMap.get(agent.id);
    if (!profile) continue;

    const dueJobs = getDueScheduledJobs(agent, profile);

    for (const job of dueJobs) {
      // Check we haven't already run this agent above via signal trigger
      const alreadyRanViaSignal = runs.some(r => r.agentId === agent.id);

      try {
        console.log(`[conductor] Running agent '${agent.id}' for scheduled job '${job.id}'`);
        const result = await runAgentWithConstraints(agent.id, businessId, 'schedule', job.id);
        runs.push({ agentId: agent.id, trigger: 'schedule', jobId: job.id, ...(result as Record<string, unknown>) });
      } catch (err) {
        console.error(`[conductor] Agent '${agent.id}' failed for job '${job.id}':`, (err as Error).message);
        errors.push({ agentId: agent.id, trigger: 'schedule', jobId: job.id, error: (err as Error).message });
      }
    }
  }

  // 7. Run signal clustering (groups related open signals) — non-fatal
  try {
    const { runClustering } = await import('../signals/cluster-engine.js') as unknown as { runClustering: (id: string) => Promise<unknown[]> };
    const clusters = await runClustering(businessId);
    if (clusters.length > 0) {
      console.log(`[conductor] Created ${clusters.length} signal cluster(s).`);
    }
  } catch (err) {
    console.warn('[conductor] Clustering failed (non-fatal):', (err as Error).message);
  }

  console.log(`[conductor] Conductor run complete for business ${businessId}. Runs: ${runs.length}, Errors: ${errors.length}`);

  return { runs, errors };
}

/**
 * Run conductor for ALL businesses.
 */
export async function runConductorAllBusinesses(): Promise<Array<{ businessId: string; businessName: string; error?: string } & Partial<{ runs: ConductorRun[]; errors: ConductorRun[] }>>> {
  const businesses = db.prepare('SELECT id, name FROM businesses').all() as BusinessRow[];
  const allResults: Array<{ businessId: string; businessName: string; error?: string } & Partial<{ runs: ConductorRun[]; errors: ConductorRun[] }>> = [];

  for (const business of businesses) {
    try {
      const result = await runConductor(business.id);
      allResults.push({ businessId: business.id, businessName: business.name, ...result });
    } catch (err) {
      console.error(`[conductor] Failed for business '${business.name}':`, (err as Error).message);
      allResults.push({ businessId: business.id, businessName: business.name, error: (err as Error).message });
    }
  }

  return allResults;
}
