import db from '../db/db.js';
import { runAgent } from './agent-runner.js';
import { runAgentWithConstraints } from '../jobs/constraint-check.js';
import yaml from 'js-yaml';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';

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

/**
 * Match open signals to agents that have those signal_triggers configured.
 */
function matchSignalsToAgents(
  agents: AgentRow[],
  signals: SignalRow[],
  profileMap: Map<string, AgentProfile>
): Array<{ agent: AgentRow; signal: SignalRow }> {
  const matches: Array<{ agent: AgentRow; signal: SignalRow }> = [];
  const seen = new Set<string>(); // Prevent same agent running twice for same signal type

  for (const signal of signals) {
    for (const agent of agents) {
      const profile = profileMap.get(agent.id);
      if (!profile) continue;

      const triggers = profile.signal_triggers ?? [];
      if (!triggers.includes(signal.rule_id)) continue;

      const key = `${agent.id}:${signal.rule_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({ agent, signal });
    }
  }

  return matches;
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

  // 3. Get open signals
  const openSignals = db.prepare(`
    SELECT * FROM signals
    WHERE business_id = ? AND status IN ('open', 'acknowledged')
    ORDER BY created_at DESC LIMIT 50
  `).all(businessId) as SignalRow[];

  // 4. Match signals to agents
  const signalMatches = matchSignalsToAgents(agents, openSignals, profileMap);

  const runs: ConductorRun[] = [];
  const errors: ConductorRun[] = [];

  // 5. Run signal-triggered agents
  for (const { agent, signal } of signalMatches) {
    try {
      console.log(`[conductor] Running agent '${agent.id}' for signal '${signal.rule_id}'`);
      const result = await runAgent(agent.id, businessId, 'signal', signal.id);
      runs.push({ agentId: agent.id, trigger: 'signal', signalId: signal.id, ...result });
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
        runs.push({ agentId: agent.id, trigger: 'schedule', jobId: job.id, ...result });
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
