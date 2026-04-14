import yaml from 'js-yaml';
import {
  readFileSync, existsSync, writeFileSync,
  appendFileSync, mkdirSync, readdirSync,
} from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db, { generateId, audit } from '../db/db.js';
import { createTask } from '../tasks/task-queue.js';
import { createTaskEvent } from '../tasks/task-events.js';
import { shouldAutoApprove, sendApprovalRequest } from '../tasks/approval.js';
import { approveTask } from '../tasks/task-queue.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { buildMetricsContext } from './context-builders.js';
import { wrapInContentBoundary } from '../lib/content-sanitiser.js';
import { detectAnomalousOutput } from '../lib/security-monitor.js';
import { SecurityError } from '../lib/outbound-allowlist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');

// ─── Agent directory helpers ──────────────────────────────────────────────────

function agentLiveDir(agentId) {
  return join(AGENTS_DIR, agentId);
}

/**
 * Record a skipped run in agent_runs. Skipped runs are purely observational —
 * they never create signals, tasks, KB entries, or notifications. The row
 * exists so /agents/status and /system-health can show "ran but skipped
 * because GSC hasn't synced yet", and audits can reconstruct intent.
 */
function recordSkippedRun(runId, agentId, businessId, trigger, triggerId, startedAt, reason) {
  try {
    db.prepare(`
      INSERT INTO agent_runs (
        id, agent_id, business_id, trigger, trigger_id,
        status, reasoning, started_at, completed_at,
        prompt_tokens, completion_tokens, cost_usd,
        signals_detected, tasks_proposed
      ) VALUES (?, ?, ?, ?, ?, 'skipped', ?, ?, CURRENT_TIMESTAMP, 0, 0, 0, 0, 0)
    `).run(runId, agentId, businessId, trigger, triggerId, reason, startedAt);
  } catch (err) {
    console.warn(`[agent-runner] Failed to record skipped run for '${agentId}':`, err.message);
  }
  console.log(`[agent-runner] Skipped '${agentId}' — ${reason}`);
}

function loadProfile(agentId) {
  const dir = agentLiveDir(agentId);
  const profilePath = join(dir, 'profile.yaml');
  if (!existsSync(profilePath)) {
    throw new Error(`Agent profile not found at: ${profilePath}`);
  }
  return yaml.load(readFileSync(profilePath, 'utf8'));
}

// ─── Soul-file system prompt assembly ────────────────────────────────────────

function assembleSystemPrompt(agentId, profile) {
  const dir = agentLiveDir(agentId);
  const soulFiles = ['IDENTITY.md', 'SOUL.md', 'HEARTBEAT.md', 'AGENTS.md'];
  const sections = [];

  for (const filename of soulFiles) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      sections.push(readFileSync(filePath, 'utf8').trim());
    }
  }

  // Append memory context if present
  const memoryPath = join(dir, 'memory.json');
  if (existsSync(memoryPath)) {
    try {
      const memory = JSON.parse(readFileSync(memoryPath, 'utf8'));
      if (memory.learnings?.length || memory.patterns?.length) {
        const lines = ['## My Memory\n'];
        if (memory.patterns?.length) {
          lines.push('### Observed patterns');
          memory.patterns.slice(-10).forEach(p => lines.push(`- ${p}`));
        }
        if (memory.learnings?.length) {
          lines.push('\n### Learnings from previous runs');
          memory.learnings.slice(-10).forEach(l => lines.push(`- ${l}`));
        }
        sections.push(lines.join('\n'));
      }
    } catch {}
  }

  // Append KB documents from agent's kb/ directory
  const kbDir = join(dir, 'kb');
  if (existsSync(kbDir)) {
    try {
      const files = readdirSync(kbDir).filter(f => /\.(md|txt)$/i.test(f));
      for (const file of files.slice(0, 5)) {
        const content = readFileSync(join(kbDir, file), 'utf8').trim();
        if (content) sections.push(`## Knowledge: ${file}\n\n${content}`);
      }
    } catch {}
  }

  // Fallback: if no soul files found, use the old-style profile-based prompt
  if (sections.length === 0) {
    return buildLegacySystemPrompt(profile);
  }

  // Append output format requirements
  sections.push(buildOutputRequirements(profile));

  return sections.join('\n\n---\n\n');
}

function buildOutputRequirements(profile) {
  return `## Output Requirements

You MUST respond with valid JSON only. No markdown fences, no prose outside the JSON object.

Structure:
{
  "reasoning": "Your analysis — what you observed, what it means, what you recommend",
  "signals_detected": <integer — number of meaningful signals in the data>,
  "tasks": [
    {
      "title": "Clear, action-oriented task title",
      "description": "What to do and why — include specific data points, URLs, metric values",
      "action_type": "content_brief|meta_edit|github_issue|investigation|notification|strategic_review|page_optimisation|product_suggestion",
      "action_payload": {},
      "trust_tier": "${profile?.trust_tier ?? 'yellow'}",
      "priority": "p1|p2|p3",
      "confidence": 0.85,
      "estimated_impact": "Specific expected outcome with a measurable result"
    }
  ],
  "search_queries": [
    {
      "query": "search query string",
      "purpose": "why you need this — what question it answers",
      "depth": "basic|advanced"
    }
  ],
  "data_gaps": [
    {
      "description": "What data you needed but couldn't find",
      "connector_type": "built-in connector id that would provide it, or null",
      "connector_name": "Human-readable name",
      "impact": "How this data would have improved your analysis",
      "priority": "high|medium|low"
    }
  ],
  "connector_wishlist": [
    {
      "description": "Data source that doesn't exist as a Blueprint connector yet",
      "use_case": "Specifically what you would do with this data",
      "search_for_api": true
    }
  ],
  "learnings": ["Any pattern or insight worth remembering for future runs"],
  "summary": "One-sentence summary of this run's findings"
}

Rules:
- Only propose tasks with confidence >= 0.7. Below that threshold, do not propose.
- Do not duplicate tasks already in the pending tasks list.
- p1 = urgent/critical, p2 = important/normal, p3 = nice to have
- Maximum 3 tasks per run unless trigger is p1 signal
- If nothing actionable found, return empty tasks array — never invent busywork
- learnings array: 0-3 concise strings, patterns useful for future runs
- search_queries: only include if you genuinely need external data not in your context. Maximum 3.
- data_gaps: only include data you actually needed and was genuinely missing. Do not pad.
- connector_wishlist: only for data sources Blueprint has no connector for. Omit if empty.`;
}

function buildLegacySystemPrompt(profile) {
  return `You are ${profile.name}, an AI agent within Blueprint — a personal business operating system.

## Your Role
${profile.title}

## Your Personality
${profile.personality}

## Your Capabilities
- READ: ${(profile.capabilities?.read ?? []).join(', ') || 'none'}
- PROPOSE: ${(profile.capabilities?.propose ?? []).join(', ') || 'none'}
- Write-gated (requires approval): ${(profile.capabilities?.write_gated ?? []).join(', ') || 'none'}
- NEVER touch: ${(profile.capabilities?.never ?? []).join(', ') || 'none'}

## Trust Level: ${profile.trust_tier ?? 'yellow'}

${buildOutputRequirements(profile)}`;
}

// ─── Memory ───────────────────────────────────────────────────────────────────

function loadMemory(agentId) {
  const memPath = join(agentLiveDir(agentId), 'memory.json');
  if (!existsSync(memPath)) {
    return { learnings: [], patterns: [], stats: { total_runs: 0, total_tasks_proposed: 0 }, last_updated: null };
  }
  try { return JSON.parse(readFileSync(memPath, 'utf8')); } catch { return {}; }
}

function updateMemory(agentId, { learnings = [], stats = {} }) {
  const dir = agentLiveDir(agentId);
  mkdirSync(dir, { recursive: true });
  const memPath = join(dir, 'memory.json');
  const memory = loadMemory(agentId);

  if (learnings?.length) {
    memory.learnings = [...(memory.learnings ?? []), ...learnings].slice(-50);
  }
  memory.stats = {
    total_runs: (memory.stats?.total_runs ?? 0) + 1,
    total_tasks_proposed: (memory.stats?.total_tasks_proposed ?? 0) + (stats.tasks_proposed ?? 0),
    ...memory.stats,
    ...stats,
  };
  memory.last_updated = new Date().toISOString();

  writeFileSync(memPath, JSON.stringify(memory, null, 2), 'utf8');
}

// ─── Run log ──────────────────────────────────────────────────────────────────

function appendRunLog(agentId, entry) {
  const dir = agentLiveDir(agentId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'run-log.jsonl');
  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
}

// ─── Conductor briefing ───────────────────────────────────────────────────────

function briefConductor(agentId, parsed, businessId) {
  if (agentId === 'conductor') return; // conductor doesn't brief itself
  try {
    const conductorDir = agentLiveDir('conductor');
    mkdirSync(conductorDir, { recursive: true });
    const inboxPath = join(conductorDir, 'inbox.jsonl');

    const entry = {
      from: agentId,
      business_id: businessId,
      timestamp: new Date().toISOString(),
      summary: parsed.summary ?? null,
      signals_detected: parsed.signals_detected ?? 0,
      tasks_proposed: Array.isArray(parsed.tasks) ? parsed.tasks.length : 0,
      reasoning_excerpt: parsed.reasoning ? parsed.reasoning.slice(0, 500) : null,
    };

    appendFileSync(inboxPath, JSON.stringify(entry) + '\n', 'utf8');

    // Keep last 50 entries
    try {
      const lines = readFileSync(inboxPath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 50) {
        writeFileSync(inboxPath, lines.slice(-50).join('\n') + '\n', 'utf8');
      }
    } catch {}
  } catch (err) {
    console.warn('[agent-runner] briefConductor failed (non-fatal):', err.message);
  }
}

// ─── User context builder ─────────────────────────────────────────────────────

async function buildUserContext({ agentId, profile, business, signals, existingTasks, connectors, trigger, triggerId, extraUserMessage }) {
  const lines = [];

  lines.push(`## Current Run`);
  lines.push(`Agent: ${agentId}`);
  lines.push(`Trigger: ${trigger}${triggerId ? ` (ID: ${triggerId})` : ''}`);
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push('');

  // Conductor inbox (only for conductor)
  if (agentId === 'conductor') {
    const inboxPath = join(agentLiveDir('conductor'), 'inbox.jsonl');
    if (existsSync(inboxPath)) {
      try {
        const lines2 = readFileSync(inboxPath, 'utf8').trim().split('\n').filter(Boolean);
        const recent = lines2.slice(-20).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (recent.length > 0) {
          lines.push('## Recent Agent Briefings (last 20)');
          for (const b of recent) {
            lines.push(`- [${b.timestamp}] ${b.from}: ${b.summary ?? 'no summary'} (${b.tasks_proposed} tasks proposed)`);
          }
          lines.push('');
        }
      } catch {}
    }
  }

  lines.push(`## Business Context`);
  lines.push(`Name: ${business.name}`);
  lines.push(`Type: ${business.type ?? 'Online business'}`);
  if (business.description) lines.push(`Description: ${business.description}`);
  lines.push('');

  lines.push(`## Active Connectors (${connectors.length})`);
  if (connectors.length === 0) {
    lines.push('No connectors configured.');
  } else {
    for (const c of connectors) {
      lines.push(`- ${c.name} (${c.type}): ${c.status}, last synced: ${c.last_sync ?? 'never'}`);
    }
  }
  lines.push('');

  lines.push(`## Open Signals (${signals.length})`);
  if (signals.length === 0) {
    lines.push('No open signals.');
  } else {
    for (const s of signals) {
      let data = {};
      try { data = JSON.parse(s.data); } catch {}
      lines.push(`### ${s.severity.toUpperCase()}: ${s.title}`);
      lines.push(`Rule: ${s.rule_id} | Confidence: ${s.confidence ?? 'N/A'} | Created: ${s.created_at}`);
      if (s.description) lines.push(s.description);
      if (Object.keys(data).length > 0) {
        lines.push(`Data: ${JSON.stringify(data, null, 2)}`);
      }
      lines.push('');
    }
  }

  // Metrics — use shared builder so chat and scheduled runs see identical data
  const metricsContext = buildMetricsContext(business.id, db);
  if (metricsContext) {
    lines.push(metricsContext);
  } else {
    lines.push('## Current Business Data\nNo recent metrics available — connectors may not have synced yet.');
  }
  lines.push('');

  // Brain — in-flight actions currently in measurement windows.
  // Agents must NOT propose further changes to these areas.
  try {
    const inFlight = db.prepare(`
      SELECT am.title, am.action_type, am.target_url,
             am.measurement_window_start, am.measurement_window_end,
             am.do_not_touch_until, am.metrics_expected,
             aw.measurement_notes
      FROM action_memory am
      LEFT JOIN action_windows aw ON aw.action_type = am.action_type
      WHERE am.business_id = ?
        AND am.outcome_measured = 0
        AND am.do_not_touch_until > CURRENT_TIMESTAMP
      ORDER BY am.measurement_window_start DESC LIMIT 10
    `).all(business.id);
    if (inFlight.length > 0) {
      lines.push('## Actions Currently In Measurement Windows');
      lines.push('These actions have been taken recently and are still in their measurement windows.');
      lines.push('DO NOT propose further changes to these areas until the window closes.');
      lines.push('If you notice an issue in one of these areas, note it as a DEFERRED observation — explain what you see and recommend measuring after the window ends.');
      lines.push('');
      for (const a of inFlight) {
        let metrics = [];
        try { metrics = JSON.parse(a.metrics_expected); } catch {}
        const daysSince = Math.ceil((Date.now() - new Date(a.measurement_window_start)) / 86400000);
        const daysUntilTouchable = Math.ceil((new Date(a.do_not_touch_until) - Date.now()) / 86400000);
        lines.push(`- **${a.title}** (${a.action_type})`);
        lines.push(`  Taken ${daysSince} days ago. Do not touch for ${daysUntilTouchable} more day${daysUntilTouchable === 1 ? '' : 's'}.`);
        if (a.target_url) lines.push(`  Target: ${a.target_url}`);
        if (metrics.length > 0) lines.push(`  Metrics affected: ${metrics.join(', ')}`);
        if (a.measurement_notes) lines.push(`  Notes: ${a.measurement_notes}`);
      }
      lines.push('');
    }
  } catch {}

  // Recent KB decisions — agents must not contradict these
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const kbResult = await getKBForBusiness(business.id);
    if (kbResult?.engine) {
      const files = await kbResult.engine.listFiles('decisions');
      const recent = files.slice(-5);
      if (recent.length > 0) {
        lines.push('## Recent Decisions (do not contradict these)');
        for (const f of recent) {
          try {
            const parsed = await kbResult.engine.readFile(f);
            const title = parsed.frontmatter?.title ?? f;
            const excerpt = (parsed.content || '').slice(0, 180).replace(/\n/g, ' ').trim();
            lines.push(`- **${title}** — ${excerpt}`);
          } catch {}
        }
        lines.push('');
      }
    }
  } catch {}

  // Active goals — agents should keep them in mind on every run
  try {
    const activeGoals = db.prepare(`
      SELECT title, description, metric_name, metric_target, metric_current,
             progress_pct, deadline, strategy
      FROM goals
      WHERE business_id = ? AND status = 'active'
      ORDER BY (deadline IS NULL) ASC, deadline ASC
      LIMIT 5
    `).all(business.id);
    if (activeGoals.length > 0) {
      lines.push('## Active Business Goals');
      lines.push('Consider these when proposing tasks — prefer actions that move the needle.');
      for (const g of activeGoals) {
        lines.push(`- **${g.title}** (${(g.progress_pct ?? 0).toFixed(0)}% complete)`);
        if (g.metric_name) lines.push(`  Target: ${g.metric_name} → ${g.metric_target} (current: ${g.metric_current ?? '?'})`);
        if (g.deadline) lines.push(`  Deadline: ${g.deadline}`);
        if (g.strategy) lines.push(`  Strategy: ${g.strategy}`);
      }
      lines.push('');
    }

    // Cross-business shared KB — tactics, patterns, do-not-do filtered by this agent's role.
    try {
      const { readSharedKBForAgent } = await import('../kb/shared-kb.js');
      const sharedDocs = await readSharedKBForAgent(agentId, { limit: 6 });
      if (sharedDocs.length > 0) {
        lines.push('## Cross-Business Learnings (apply across all businesses)');
        for (const d of sharedDocs) {
          lines.push(`- **${d.title}** — ${d.summary}`);
        }
        lines.push('');
      }
    } catch {}

    // Latest calibration data for this agent — inject into prompt so the
    // agent knows to adjust confidence scores going forward.
    try {
      const { getLatestCalibration } = await import('../brain/calibration.js');
      const cal = getLatestCalibration(agentId, business.id);
      if (cal && cal.tasks_with_outcomes >= 3) {
        lines.push('## Your Calibration Data (last period)');
        lines.push(`You stated an average of ${((cal.avg_stated_confidence ?? 0) * 100).toFixed(0)}% confidence. Actual outcome rate: ${((cal.avg_actual_outcome_rate ?? 0) * 100).toFixed(0)}%.`);
        const errPct = (cal.calibration_error * 100).toFixed(0);
        if (cal.calibration_error > 0.1) {
          lines.push(`You are ${errPct}% OVERCONFIDENT. Be more conservative with your confidence scores.`);
        } else if (cal.calibration_error < -0.1) {
          lines.push(`You are ${Math.abs(errPct)}% underconfident. You can be more assertive when evidence is strong.`);
        } else {
          lines.push('Your confidence is well-calibrated. Continue with the same approach.');
        }
        lines.push('');
      }
    } catch {}

    // Latest retrospective note for this specific agent.
    try {
      const retroRow = db.prepare('SELECT value FROM settings WHERE key = ?')
        .get(`agent_retro_note_${business.id}_${agentId}`);
      if (retroRow?.value) {
        const retro = JSON.parse(retroRow.value);
        if (retro?.note) {
          lines.push('## Last Retrospective Finding (about you)');
          lines.push(`${retro.note}${retro.grade ? ` (grade: ${retro.grade})` : ''}`);
          if (retro.calibration_error != null) {
            const pct = (retro.calibration_error * 100).toFixed(0);
            lines.push(`Your recent confidence scores were ${pct}% ${retro.calibration_error > 0 ? 'overconfident' : 'underconfident'} vs actual outcomes — please adjust.`);
          }
          lines.push('');
        }
      }
    } catch {}

    // Per-agent goal briefings produced by the Goal Reasoner.
    // These tell THIS specific agent what to focus on / avoid for each goal.
    try {
      const briefingRow = db.prepare('SELECT value FROM settings WHERE key = ?')
        .get(`agent_goal_briefing_${business.id}_${agentId}`);
      if (briefingRow?.value) {
        const briefings = JSON.parse(briefingRow.value);
        if (Array.isArray(briefings) && briefings.length > 0) {
          lines.push('## Your Goal Briefings');
          lines.push('The Goal Reasoner has produced specific guidance for you on each goal:');
          for (const b of briefings) {
            lines.push(`- **${b.goal_title}**`);
            if (b.focus) lines.push(`  Focus: ${b.focus}`);
            if (b.avoid) lines.push(`  Avoid: ${b.avoid}`);
          }
          lines.push('');
        }
      }
    } catch {}

    // Active projects
    const activeProjects = db.prepare(`
      SELECT id, name, description, assigned_agents, tags
      FROM projects
      WHERE business_id = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 3
    `).all(business.id);
    if (activeProjects.length > 0) {
      lines.push('## Active Projects');
      for (const p of activeProjects) {
        let agents = [];
        try { agents = JSON.parse(p.assigned_agents); } catch {}
        lines.push(`- **${p.name}**${p.description ? `: ${p.description}` : ''}`);
        if (agents.length) lines.push(`  Assigned: ${agents.join(', ')}`);
      }
      lines.push('');
    }
  } catch {}

  // Search availability — tell the agent what search tools it has
  try {
    const searchRow = db.prepare(`
      SELECT type FROM connectors
      WHERE business_id = ? AND type IN ('tavily', 'brave-search') AND status = 'active'
      ORDER BY CASE type WHEN 'tavily' THEN 1 WHEN 'brave-search' THEN 2 END LIMIT 1
    `).get(business.id);
    if (searchRow) {
      lines.push(`## Web Search Available (${searchRow.type})`);
      lines.push('You can search the web during this run. Include search_queries in your response to request searches.');
      lines.push('Use search when: you need current info not in your connector data, want to check if a metric change is industry-wide, need to research a competitor or API, or want to verify a hypothesis with external evidence.');
      lines.push('Maximum 3 searches per run. Use search_depth "advanced" only when full page content is needed.');
      lines.push('');
    }
  } catch {}

  // Available-but-not-connected built-in connectors
  try {
    const ALL_BUILT_IN_TYPES = [
      'ga4', 'gsc', 'pagespeed', 'gbp', 'google-ads',
      'shopify', 'stripe', 'github', 'brevo', 'klaviyo',
      'semrush', 'meta-ads', 'social', 'buffer', 'wix',
      'stannp', 'todoist', 'uptimerobot', 'wordpress',
      'kirby', 'tavily', 'brave-search', 'server-access',
    ];
    const activeTypes = new Set(connectors.filter(c => c.status === 'active').map(c => c.type));
    const notConnected = ALL_BUILT_IN_TYPES.filter(t => !activeTypes.has(t));
    if (notConnected.length > 0) {
      lines.push('## Built-In Connectors Not Yet Connected');
      lines.push('If any of these would materially improve your analysis, include them in data_gaps:');
      lines.push(notConnected.join(', '));
      lines.push('');
    }
  } catch {}

  lines.push(`## Existing Pending Tasks (do not duplicate these)`);
  if (existingTasks.length === 0) {
    lines.push('No pending tasks.');
  } else {
    for (const t of existingTasks) {
      lines.push(`- [${t.status}] ${t.title} (by ${t.proposed_by}, ${t.created_at})`);
    }
  }
  lines.push('');

  lines.push(`## Your Task`);
  if (trigger === 'workflow' && extraUserMessage) {
    lines.push(extraUserMessage);
  } else if (trigger === 'schedule') {
    const job = profile.scheduled_jobs?.find(j => j.id === triggerId) ?? profile.scheduled_jobs?.[0];
    if (job) {
      lines.push(job.task);
    } else {
      lines.push('Perform your regular scheduled review based on your role and capabilities.');
    }
  } else if (trigger === 'signal') {
    lines.push('A signal has been detected. Review the signals above and propose targeted tasks to address them.');
  } else {
    lines.push('You have been triggered manually. Review all available context and propose the highest-value actions you can identify.');
  }

  return lines.join('\n');
}

// ─── Data gap + connector wishlist processors ─────────────────────────────────
//
// Both of these used to have their own task-creation + dedup logic. They now
// funnel through surfaceConnectorGap() so KB, signals, chat, and agents all
// share the same connector-gap pipeline (with a single dedup row per
// business+connector and a single place to change policy).

/**
 * Handle data_gaps from an agent response.
 * For built-in connectors that aren't connected, surface a gap.
 */
async function processDataGaps(gaps, agentId, businessId) {
  if (!Array.isArray(gaps) || gaps.length === 0) return;
  const { surfaceConnectorGap } = await import('../lib/connector-gap-handler.js');

  for (const gap of gaps) {
    if (!gap?.connector_type || gap.priority === 'low') continue;

    await surfaceConnectorGap({
      business_id: businessId,
      connector_name: gap.connector_name || gap.connector_type,
      source: `agent:${agentId}`,
      reason: gap.description,
      use_case: gap.impact,
      implied_by: `${agentId} analysis`,
      priority: gap.priority === 'high' ? 'p2' : 'p3',
    }).catch((err) =>
      console.warn(`[agent-runner] surfaceConnectorGap failed for ${gap.connector_type}:`, err.message)
    );
  }
}

/**
 * Handle connector_wishlist from an agent response.
 * Surfaces research-needed gaps for data sources without a built-in connector.
 */
async function processConnectorWishlist(wishlist, agentId, businessId) {
  if (!Array.isArray(wishlist) || wishlist.length === 0) return;
  const { surfaceConnectorGap } = await import('../lib/connector-gap-handler.js');

  for (const item of wishlist) {
    if (!item?.description || !item.search_for_api) continue;

    await surfaceConnectorGap({
      business_id: businessId,
      connector_name: item.description,  // free-form → research_connector path
      source: `agent:${agentId}`,
      reason: item.use_case,
      use_case: item.description,
      implied_by: `${agentId} connector wishlist`,
      priority: 'p3',
    }).catch((err) =>
      console.warn(`[agent-runner] surfaceConnectorGap failed for wishlist item:`, err.message)
    );
  }
}

// ─── Main runAgent function ───────────────────────────────────────────────────

/**
 * Run an agent against a business context.
 */
export async function runAgent(agentId, businessId, trigger, triggerId = null, options = {}) {
  const runId = generateId();
  const startedAt = new Date().toISOString();

  // 0. Check global kill switch
  const globallyPaused = db.prepare("SELECT value FROM settings WHERE key = 'agents_globally_paused'").get();
  if (globallyPaused && JSON.parse(globallyPaused.value ?? 'false') === true) {
    console.warn(`[agent-runner] Agents globally paused — skipping '${agentId}'.`);
    return { runId: null, tasksProposed: 0, signalsDetected: 0, skipped: true, reason: 'globally_paused' };
  }

  // 1. Load agent from DB
  const agentRow = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agentRow) throw new Error(`Agent '${agentId}' not found in database.`);

  // 1a. Soft-skip if agent is not active (pending, paused, retired). We used
  // to throw here, but throwing from the scheduler would surface as a
  // notification — pending/paused agents should simply not run quietly.
  if (agentRow.status !== 'active') {
    recordSkippedRun(runId, agentId, businessId, trigger, triggerId, startedAt,
      `Agent status is '${agentRow.status}'; only 'active' agents run.`);
    return { runId, tasksProposed: 0, signalsDetected: 0, skipped: true, reason: `status_${agentRow.status}` };
  }

  // 1b. Readiness gate — required connectors must be connected AND have
  // synced at least once within the staleness window. If not ready, record
  // a skipped run and return. Do NOT file to KB, create signals, or tasks.
  const { checkAgentReadiness } = await import('./readiness.js');
  const readiness = checkAgentReadiness(agentId, businessId);
  if (!readiness.ready) {
    recordSkippedRun(runId, agentId, businessId, trigger, triggerId, startedAt, readiness.reason);
    return {
      runId,
      tasksProposed: 0,
      signalsDetected: 0,
      skipped: true,
      reason: readiness.status,
      readiness,
    };
  }

  // 2. Load profile (live dir → canonical profiles/ → legacy DB profile_path)
  let profile;
  try {
    profile = loadProfile(agentId);
  } catch {
    const candidates = [
      resolve(PROJECT_ROOT, 'server/agents/profiles', `${agentId}.yaml`),
      resolve(PROJECT_ROOT, agentRow.profile_path ?? ''),
    ].filter(Boolean);
    let found = null;
    for (const path of candidates) {
      if (existsSync(path)) { found = path; break; }
    }
    if (!found) {
      throw new Error(`Agent profile not found for '${agentId}'. Install the agent first.`);
    }
    profile = yaml.load(readFileSync(found, 'utf8'));
  }

  // 3. Resolve LLM settings (new format: profile.llm, old format: profile.model)
  const llmConfig = profile.llm ?? {
    model: profile.model?.primary ?? 'claude-sonnet-4-20250514',
    temperature: 0.7,
    max_tokens: profile.model?.max_tokens ?? 4096,
    fallback_provider: null,
    fallback_model: profile.model?.fallback ?? null,
    cost_cap_daily_usd: profile.model?.cost_cap_daily_usd ?? 2.0,
  };

  // 3b. Check global monthly budget
  const monthlyBudget = JSON.parse(
    db.prepare("SELECT value FROM settings WHERE key = 'cost_monthly_budget_usd'").get()?.value ?? '20'
  );
  if (monthlyBudget > 0) {
    const monthSpent = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_daily WHERE date >= date('now', 'start of month')"
    ).get()?.total ?? 0;
    if (monthSpent >= monthlyBudget) {
      console.warn(`[agent-runner] Monthly budget exhausted ($${monthSpent.toFixed(2)}/$${monthlyBudget}). Skipping '${agentId}'.`);
      return { runId: null, tasksProposed: 0, signalsDetected: 0, skipped: true, reason: 'monthly_budget' };
    }
  }

  // 4. Check per-agent daily cost cap (0 = unlimited)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCost = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM agent_runs
    WHERE agent_id = ? AND started_at >= ? AND status NOT IN ('running')
  `).get(agentId, todayStart.toISOString())?.total ?? 0;

  const costCap = llmConfig.cost_cap_daily_usd ?? 2.0;
  if (costCap > 0 && todayCost >= costCap) {
    console.warn(`[agent-runner] Agent '${agentId}' has hit daily cost cap ($${costCap}). Skipping.`);
    return { runId: null, tasksProposed: 0, signalsDetected: 0, skipped: true, reason: 'cost_cap' };
  }

  // Create the run record
  db.prepare(`
    INSERT INTO agent_runs (id, agent_id, business_id, trigger, trigger_id, status, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?)
  `).run(runId, agentId, businessId, trigger, triggerId, startedAt);

  try {
    const { pushDashboardEvent } = await import('../lib/sse-bus.js');
    pushDashboardEvent(businessId, 'agent_run_started', { agentId, runId, trigger });
  } catch {}

  try {
    // 5. Load business context
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    if (!business) throw new Error(`Business '${businessId}' not found.`);

    // 6. Gather context data
    const signalTriggers = profile.signal_triggers ?? [];
    const openSignals = db.prepare(`
      SELECT * FROM signals WHERE business_id = ? AND status IN ('open', 'acknowledged')
      ORDER BY created_at DESC LIMIT 20
    `).all(businessId);
    const relevantSignals = signalTriggers.length > 0
      ? openSignals.filter(s => signalTriggers.includes(s.rule_id))
      : openSignals;

    const existingTasks = db.prepare(`
      SELECT id, title, status, proposed_by, created_at FROM tasks
      WHERE business_id = ? AND status IN ('proposed', 'approved', 'executing')
      ORDER BY created_at DESC LIMIT 20
    `).all(businessId);

    const connectors = db.prepare(`
      SELECT id, type, name, status, last_sync FROM connectors WHERE business_id = ?
    `).all(businessId);

    // 7. Assemble system prompt from soul files
    const systemPrompt = assembleSystemPrompt(agentId, profile);

    // 8. Build user context message
    const userContext = await buildUserContext({
      agentId,
      profile,
      business,
      signals: relevantSignals,
      existingTasks,
      connectors,
      trigger,
      triggerId,
      extraUserMessage: options.extra_user_message,
    });

    // 9. Run LLM (with fallback)
    const { providerId, model, temperature, max_tokens } = resolveProfileLLM(llmConfig);

    let llmResult;
    try {
      llmResult = await runLLM(providerId, model, {
        messages: [{ role: 'user', content: userContext }],
        system: systemPrompt,
        temperature,
        max_tokens,
      });
    } catch (primaryErr) {
      console.warn(`[agent-runner] Primary provider '${providerId}' failed: ${primaryErr.message}`);
      if (llmConfig.fallback_provider) {
        const { providerId: fbPid, model: fbModel } = resolveProfileLLM({
          provider: llmConfig.fallback_provider,
          model: llmConfig.fallback_model,
          temperature,
          max_tokens,
        });
        llmResult = await runLLM(fbPid, fbModel, {
          messages: [{ role: 'user', content: userContext }],
          system: systemPrompt,
          temperature,
          max_tokens,
        });
      } else {
        throw primaryErr;
      }
    }

    const rawContent = llmResult.content;
    const costUsd = llmResult.cost_usd ?? 0;

    // 10. Parse JSON response
    let parsed;
    try {
      const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                        rawContent.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1] : rawContent;
      parsed = JSON.parse(jsonStr.trim());
    } catch {
      console.error('[agent-runner] Failed to parse agent response:', rawContent.substring(0, 500));
      parsed = { tasks: [], reasoning: rawContent, signals_detected: 0, learnings: [] };
    }

    // 10a. Two-phase execution: if agent requested web searches, run them
    // and re-run the LLM with search results injected before final analysis.
    const searchQueries = Array.isArray(parsed.search_queries) ? parsed.search_queries.slice(0, 3) : [];
    if (searchQueries.length > 0) {
      try {
        const { agentSearch } = await import('./tools/search.js');
        const searchResults = {};
        for (const sq of searchQueries) {
          const r = await agentSearch(
            sq.query,
            { search_depth: sq.depth || 'basic' },
            businessId, db,
            { agentId, runId }
          );
          if (r.available) searchResults[sq.query] = r;
        }

        if (Object.keys(searchResults).length > 0) {
          const searchBlock = Object.entries(searchResults).map(([query, r]) => {
            const snippets = (r.results ?? []).slice(0, 3).map(res =>
              `**${res.title}** (${res.url})\n${(res.content || res.description || '').slice(0, 300)}`
            ).join('\n\n');
            return `### Search: "${query}"\n${r.answer ? `Summary: ${r.answer}\n\n` : ''}${snippets}`;
          }).join('\n\n---\n\n');

          // Wrap the search block in an explicit external_content boundary so
          // the LLM treats it as untrusted data, not instructions. The search
          // tool already sanitised injection patterns; the boundary is
          // defence-in-depth.
          const wrappedSearchBlock = wrapInContentBoundary(searchBlock, `search:${agentId}`);

          const secondPassContent = await runLLM(providerId, model, {
            messages: [{
              role: 'user',
              content: userContext + `\n\n## Web Search Results\n\n${wrappedSearchBlock}\n\nNow produce your final analysis incorporating these search results.`,
            }],
            system: systemPrompt,
            temperature,
            max_tokens,
          });
          const rawSecond = secondPassContent?.content ?? '';
          try {
            const m2 = rawSecond.match(/```(?:json)?\s*([\s\S]*?)```/) || rawSecond.match(/(\{[\s\S]*\})/);
            parsed = JSON.parse((m2 ? m2[1] : rawSecond).trim());
          } catch {
            // Keep first-pass parsed if second-pass fails to parse
          }
        }
      } catch (searchErr) {
        console.warn(`[agent-runner] Search phase failed for '${agentId}' (non-fatal):`, searchErr.message);
      }
    }

    let tasksToCreate = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const signalsDetected = parsed.signals_detected ?? relevantSignals.length;

    // 10b. Output validation — defence in depth against speculation.
    //
    // The readiness gate (step 1b) prevents runs when required connectors are
    // absent. A run is degraded only when required data is present but going
    // stale (> 24h since last sync). In that case we cap confidence and force
    // red tier so tasks land in front of a human reviewer.
    //
    // Missing PREFERRED connectors do NOT trigger degraded mode. Conductor's
    // hiring decision already accounted for which connectors are connected —
    // if Conductor approved hiring Merchant with only Shopify, running Merchant
    // without Klaviyo/Stripe is expected and valid, not degraded.
    const missingPreferred = Array.isArray(readiness?.missing_preferred)
      ? readiness.missing_preferred : [];
    const anyStale = Object.values(readiness?.last_sync_ages ?? {})
      .some((h) => typeof h === 'number' && h > 24);
    const degradedRun = anyStale;

    if (degradedRun) {
      tasksToCreate = tasksToCreate.map((t) => ({
        ...t,
        confidence: typeof t.confidence === 'number'
          ? Math.min(t.confidence, 0.3) : 0.3,
        trust_tier: 'red',
        _degraded_data: true,
      }));
      console.warn(
        `[agent-runner] '${agentId}' ran with stale required data (stale: ${anyStale}, missing preferred: ${missingPreferred.join(',') || 'none'}). ` +
        `Tasks capped at confidence 0.3 / trust_tier=red.`
      );
    }

    // Reject tasks with zero citation of real data. A task is a citation if
    // reasoning mentions at least one active connector name/type, or if any
    // signals were detected, or if the task's action_payload references a
    // connector_id that belongs to this business.
    const activeConnectorKeys = new Set();
    for (const c of connectors) {
      if (c.status === 'active') {
        if (c.type) activeConnectorKeys.add(String(c.type).toLowerCase());
        if (c.name) activeConnectorKeys.add(String(c.name).toLowerCase());
      }
    }
    const reasoningText = String(parsed.reasoning ?? '').toLowerCase();
    const reasoningCitesData = Array.from(activeConnectorKeys)
      .some((k) => k && reasoningText.includes(k));
    const hasSignalEvidence = (signalsDetected ?? 0) > 0;

    if (!hasSignalEvidence && !reasoningCitesData && tasksToCreate.length > 0) {
      console.warn(
        `[agent-runner] '${agentId}' proposed ${tasksToCreate.length} task(s) with no data citation ` +
        `(no signals, no connector reference in reasoning). Dropping tasks to prevent speculative KB pollution.`
      );
      tasksToCreate = [];
    }

    // 10c. Anomalous output detection — layer 4 of prompt injection defence.
    // Scan the parsed output for high-severity anomalies (unexpected URLs,
    // credentials, exfiltration verbiage, base64 blobs). High-severity hits
    // block the run entirely; the output is discarded, a critical signal is
    // raised, and we notify the operator immediately.
    try {
      const anomalies = detectAnomalousOutput(parsed, agentId);
      const highSeverity = anomalies.filter(a => a.severity === 'high');
      if (anomalies.length > 0) {
        console.warn(
          `[security:agent] '${agentId}' output: ${anomalies.length} anomaly(s), ` +
          `${highSeverity.length} high-severity`
        );
      }
      if (highSeverity.length > 0) {
        // Record a critical security signal so the operator sees it.
        try {
          db.prepare(`
            INSERT INTO signals (
              id, business_id, connector_id, rule_id, type, severity,
              title, description, data, status, confidence, created_at, agent_id
            ) VALUES (?, ?, NULL, 'security:anomalous_output', 'security_risk', 'critical',
                      ?, ?, ?, 'open', 1.0, CURRENT_TIMESTAMP, ?)
          `).run(
            generateId(),
            businessId,
            `Security: anomalous output blocked from ${agentId}`,
            `Agent output contained suspicious patterns (${highSeverity.map(a => a.type).join(', ')}). ` +
            `Output was blocked; no tasks or KB writes occurred. This may indicate a prompt injection attack via ` +
            `external content (search results, connector data). Review recent ingestion sources.`,
            JSON.stringify({ anomalies, run_id: runId }),
            agentId
          );
        } catch (sigErr) {
          console.warn('[security:agent] Failed to record anomaly signal:', sigErr.message);
        }

        // Immediate Telegram + dashboard notification.
        try {
          const { dispatch } = await import('../notifications/dispatcher.js');
          const body = `Agent '${agentId}' produced output with suspicious patterns:\n` +
            highSeverity.map(a => `• ${a.type}${a.value ? `: ${a.value}` : ''}`).join('\n') +
            `\n\nOutput was blocked. Check Signals page.`;
          dispatch({
            business_id: businessId,
            channel: 'dashboard',
            severity: 'critical',
            title: `Security alert: ${agentId} output blocked`,
            body,
            entity_type: 'security',
            entity_id: runId,
          }).catch(() => {});
          if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            dispatch({
              business_id: businessId,
              channel: 'telegram',
              severity: 'critical',
              title: `🚨 Blueprint security alert: agent output blocked`,
              body,
              entity_type: 'security',
              entity_id: runId,
            }).catch(() => {});
          }
        } catch {}

        // Block the run — throw so it's recorded as failed.
        throw new SecurityError(
          `Agent output blocked due to high-severity security anomalies: ` +
          highSeverity.map(a => a.type).join(', '),
          { anomalies, agentId, runId }
        );
      }
    } catch (secErr) {
      if (secErr instanceof SecurityError) throw secErr;
      console.warn('[security:agent] Anomaly detection errored (fail-open):', secErr.message);
    }

    // 11. Insert tasks (with brain restraint check)
    const createdTasks = [];
    for (const taskDef of tasksToCreate) {
      if (!taskDef.title) continue;
      try {
        // Brain — check restraint before creating
        let restraint = { allowed: true };
        try {
          const { checkRestraint } = await import('../brain/restraint.js');
          restraint = await checkRestraint(taskDef, businessId);
        } catch (err) {
          console.warn('[brain] restraint check failed (allowing):', err.message);
        }

        let deferredUntil = null;
        let deferredReason = null;
        let description = taskDef.description ?? null;

        if (!restraint.allowed) {
          deferredUntil = restraint.measurement_window_ends;
          deferredReason = restraint.reason;
          if (description) description += `\n\n⏳ Deferred: ${restraint.reason}`;
          else description = `⏳ Deferred: ${restraint.reason}`;
        } else if (restraint.confounding_warning) {
          description = `${description ?? ''}\n\n⚠️ ${restraint.confounding_warning}`.trim();
        }

        const task = createTask({
          business_id: businessId,
          signal_id: triggerId && trigger === 'signal' ? triggerId : null,
          title: taskDef.title,
          description,
          proposed_by: agentId,
          action_type: taskDef.action_type ?? null,
          action_payload: taskDef.action_payload ?? {},
          trust_tier: taskDef.trust_tier ?? profile.trust_tier ?? 'yellow',
          priority: taskDef.priority ?? 'p2',
          confidence: taskDef.confidence ?? null,
          estimated_impact: taskDef.estimated_impact ?? null,
          approval_mode: profile.approval_mode ?? 'requires_approval',
          degraded_data: taskDef._degraded_data ? 1 : 0,
        });

        // If deferred, immediately move to 'deferred' status with the wake-up time
        if (deferredUntil) {
          try {
            db.prepare(`
              UPDATE tasks
              SET status = 'deferred', deferred_until = ?, deferred_reason = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(deferredUntil, deferredReason, task.id);
            task.status = 'deferred';
            task.deferred_until = deferredUntil;
            task.deferred_reason = deferredReason;
          } catch (err) {
            console.warn('[brain] failed to mark task deferred:', err.message);
          }
        }

        createdTasks.push(task);

        // Record creation event so /api/tasks/:id/history has a timeline
        try {
          createTaskEvent(
            task.id,
            'created',
            agentId,
            `Task created by ${agentId} agent (${trigger}${triggerId ? ':' + triggerId : ''}): "${task.title}"`,
            {
              run_id: runId,
              trigger,
              trigger_id: triggerId,
              signal_id: task.signal_id,
              source: 'agent',
            }
          );
        } catch (evErr) {
          console.warn('[agent-runner] task_events insert failed (non-fatal):', evErr.message);
        }

        // Deferred tasks skip approval flow — they will re-surface automatically
        if (deferredUntil) {
          try {
            createTaskEvent(task.id, 'deferred', 'system:brain',
              `Deferred until ${deferredUntil}`, { reason: deferredReason });
          } catch {}
        } else if (shouldAutoApprove(task)) {
          try { approveTask(task.id, `agent:${agentId}`); } catch {}
        } else {
          try { await sendApprovalRequest(task, business); } catch {}
        }
      } catch (err) {
        console.error('[agent-runner] Failed to create task:', err.message);
      }
    }

    // 12. Update run record
    db.prepare(`
      UPDATE agent_runs SET
        status = 'complete',
        reasoning = ?,
        prompt_tokens = ?,
        completion_tokens = ?,
        cost_usd = ?,
        signals_detected = ?,
        tasks_proposed = ?,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      parsed.reasoning ?? null,
      llmResult.usage?.input_tokens ?? 0,
      llmResult.usage?.output_tokens ?? 0,
      costUsd,
      signalsDetected,
      createdTasks.length,
      runId,
    );

    // 13. Update agent stats (non-fatal — never let stats failure kill a successful run)
    try {
      db.prepare(`
        UPDATE agents SET
          last_run = CURRENT_TIMESTAMP,
          run_count = run_count + 1,
          total_cost_usd = total_cost_usd + ?
        WHERE id = ?
      `).run(costUsd, agentId);
    } catch (statsErr) {
      console.warn('[agent-runner] Failed to update agent stats (non-fatal):', statsErr.message);
    }

    // 13b. Track cost in cost_daily table
    try {
      db.prepare(`
        INSERT INTO cost_daily (id, date, agent_id, business_id, provider,
          prompt_tokens, completion_tokens, cost_usd, run_count)
        VALUES (lower(hex(randomblob(16))), date('now'), ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(date, agent_id, business_id, provider) DO UPDATE SET
          prompt_tokens = prompt_tokens + excluded.prompt_tokens,
          completion_tokens = completion_tokens + excluded.completion_tokens,
          cost_usd = cost_usd + excluded.cost_usd,
          run_count = run_count + 1
      `).run(agentId, businessId, providerId,
        llmResult.usage?.input_tokens ?? 0, llmResult.usage?.output_tokens ?? 0, costUsd);
    } catch {}

    // 14. Process data gaps and connector wishlist (non-blocking)
    processDataGaps(parsed.data_gaps, agentId, businessId)
      .catch(e => console.warn('[agent-runner] processDataGaps failed (non-fatal):', e.message));
    processConnectorWishlist(parsed.connector_wishlist, agentId, businessId)
      .catch(e => console.warn('[agent-runner] processConnectorWishlist failed (non-fatal):', e.message));

    // 15. Update memory with learnings
    const learnings = Array.isArray(parsed.learnings) ? parsed.learnings : [];
    updateMemory(agentId, {
      learnings,
      stats: { tasks_proposed: createdTasks.length, last_run: startedAt },
    });

    // 15. Append to run log
    appendRunLog(agentId, {
      run_id: runId,
      timestamp: startedAt,
      trigger,
      trigger_id: triggerId,
      business_id: businessId,
      provider: providerId,
      model,
      cost_usd: costUsd,
      input_tokens: llmResult.usage?.input_tokens ?? 0,
      output_tokens: llmResult.usage?.output_tokens ?? 0,
      signals_detected: signalsDetected,
      tasks_proposed: createdTasks.length,
      summary: parsed.summary ?? null,
    });

    // 16. Brief conductor (non-conductor runs only)
    briefConductor(agentId, parsed, businessId);

    // 16b. Dispatch BAP webhook for agent.run.complete
    try {
      const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js');
      dispatchWebhookEvent('agent.run.complete', {
        run_id: runId, agent_id: agentId, business_id: businessId,
        status: 'complete', tasks_proposed: createdTasks.length,
        signals_detected: signalsDetected, cost_usd: costUsd,
      });
    } catch {}

    // 17. Write significant findings to the KB (non-fatal — never blocks the run)
    if (createdTasks.length > 0 || (parsed.reasoning && parsed.reasoning.length > 200)) {
      try {
        const { getKBForBusiness } = await import('../kb/kb-config.js');
        const result = await getKBForBusiness(businessId);
        if (result?.engine) {
          const slug = `agent-${agentId}-${runId.slice(0, 8)}`;
          const taskList = createdTasks.length > 0
            ? createdTasks.map(t => `- **[${t.priority}]** ${t.title}`).join('\n')
            : '_(no tasks proposed)_';
          const body = `# ${profile.name ?? agentId} Run

**Run ID:** \`${runId}\`
**Trigger:** ${trigger}${triggerId ? ` (${triggerId})` : ''}
**Started:** ${startedAt}
**Cost:** $${(costUsd ?? 0).toFixed(4)}

## Summary

${parsed.summary ?? '_(no summary)_'}

## Reasoning

${(parsed.reasoning ?? '').slice(0, 4000)}

## Tasks Proposed (${createdTasks.length})

${taskList}

## Signals Considered

${signalsDetected} signal(s) reviewed.
`;
          await result.engine.writeFile(
            `signals/${slug}.md`,
            body,
            {
              title: `${profile.name ?? agentId} run ${runId.slice(0, 8)}`,
              tags: ['agent-run', agentId, trigger],
              created: startedAt.split('T')[0],
              source_count: 1,
              run_id: runId,
            },
            `agent-run: ${agentId}/${runId.slice(0, 8)}`
          );
        }
      } catch (kbErr) {
        console.warn('[agent-runner] KB write failed (non-fatal):', kbErr.message);
      }
    }

    // 18. Reporter agent → send email briefing (Feature 5, non-fatal)
    if (agentId === 'reporter') {
      try {
        const { sendReporterEmail } = await import('../notifications/reporter-email.js');
        await sendReporterEmail(parsed, business, businessId, startedAt);
      } catch (err) {
        console.warn('[agent-runner] Reporter email send failed (non-fatal):', err.message);
      }
    }

    console.log(`[agent-runner] '${agentId}' complete. Tasks: ${createdTasks.length}, Cost: $${costUsd.toFixed(6)}`);

    try {
      const { pushDashboardEvent } = await import('../lib/sse-bus.js');
      pushDashboardEvent(businessId, 'agent_run_complete', {
        agentId, runId, tasksProposed: createdTasks.length, costUsd, signalsDetected,
      });
    } catch {}

    return { runId, tasksProposed: createdTasks.length, signalsDetected, costUsd };

  } catch (err) {
    db.prepare(`
      UPDATE agent_runs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(err.message, runId);

    // Self-healing: diagnose, search for solution, create GitHub issue + draft PR
    import('./self-healer.js')
      .then(m => m.healAgentError(err, { agentId, runId, businessId, trigger }))
      .catch(healErr => console.warn('[self-heal] Agent healing failed (non-fatal):', healErr.message));

    try {
      const { pushDashboardEvent } = await import('../lib/sse-bus.js');
      pushDashboardEvent(businessId, 'agent_run_failed', { agentId, runId, error: err.message });
    } catch {}

    // Update agent stats even on failure so last_run + run_count reflect reality
    try {
      db.prepare(`
        UPDATE agents SET
          last_run = CURRENT_TIMESTAMP,
          run_count = run_count + 1
        WHERE id = ?
      `).run(agentId);
    } catch (statsErr) {
      console.warn('[agent-runner] Failed to update agent stats on failure (non-fatal):', statsErr.message);
    }

    appendRunLog(agentId, {
      run_id: runId,
      timestamp: startedAt,
      trigger,
      status: 'failed',
      error: err.message,
    });
    console.error(`[agent-runner] Agent '${agentId}' run failed:`, err);
    throw err;
  }
}
