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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');

// ─── Agent directory helpers ──────────────────────────────────────────────────

function agentLiveDir(agentId) {
  return join(AGENTS_DIR, agentId);
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
  "learnings": ["Any pattern or insight worth remembering for future runs"],
  "summary": "One-sentence summary of this run's findings"
}

Rules:
- Only propose tasks with confidence >= 0.7. Below that threshold, do not propose.
- Do not duplicate tasks already in the pending tasks list.
- p1 = urgent/critical, p2 = important/normal, p3 = nice to have
- Maximum 3 tasks per run unless trigger is p1 signal
- If nothing actionable found, return empty tasks array — never invent busywork
- learnings array: 0-3 concise strings, patterns useful for future runs`;
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

function buildUserContext({ agentId, profile, business, signals, metrics, existingTasks, connectors, trigger, triggerId }) {
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

  lines.push(`## Recent Metrics (last 14 days)`);
  if (metrics.length === 0) {
    lines.push('No recent metrics available.');
  } else {
    const grouped = {};
    for (const m of metrics) {
      if (!grouped[m.metric_name]) grouped[m.metric_name] = [];
      grouped[m.metric_name].push(m);
    }
    for (const [name, rows] of Object.entries(grouped)) {
      lines.push(`- ${name}: ${rows[0].metric_value ?? 'N/A'} (as of ${rows[0].recorded_at})`);
    }
  }
  lines.push('');

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
  if (trigger === 'schedule') {
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

// ─── Main runAgent function ───────────────────────────────────────────────────

/**
 * Run an agent against a business context.
 */
export async function runAgent(agentId, businessId, trigger, triggerId = null) {
  const runId = generateId();
  const startedAt = new Date().toISOString();

  // 1. Load agent from DB
  const agentRow = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agentRow) throw new Error(`Agent '${agentId}' not found in database.`);
  if (agentRow.status !== 'active') throw new Error(`Agent '${agentId}' is not active (status: ${agentRow.status}).`);

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
    provider: 'anthropic',
    model: profile.model?.primary ?? 'claude-sonnet-4-20250514',
    temperature: 0.7,
    max_tokens: profile.model?.max_tokens ?? 4096,
    fallback_provider: null,
    fallback_model: profile.model?.fallback ?? null,
    cost_cap_daily_usd: profile.model?.cost_cap_daily_usd ?? 2.0,
  };

  // 4. Check cost cap (0 = unlimited, common convention)
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

    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const recentMetrics = db.prepare(`
      SELECT metric_name, metric_value, metric_data, recorded_at, connector_id
      FROM metrics WHERE business_id = ? AND recorded_at >= ?
      ORDER BY recorded_at DESC LIMIT 100
    `).all(businessId, fourteenDaysAgo);

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
    const userContext = buildUserContext({
      agentId,
      profile,
      business,
      signals: relevantSignals,
      metrics: recentMetrics,
      existingTasks,
      connectors,
      trigger,
      triggerId,
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

    const tasksToCreate = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const signalsDetected = parsed.signals_detected ?? relevantSignals.length;

    // 11. Insert tasks
    const createdTasks = [];
    for (const taskDef of tasksToCreate) {
      if (!taskDef.title) continue;
      try {
        const task = createTask({
          business_id: businessId,
          signal_id: triggerId && trigger === 'signal' ? triggerId : null,
          title: taskDef.title,
          description: taskDef.description ?? null,
          proposed_by: agentId,
          action_type: taskDef.action_type ?? null,
          action_payload: taskDef.action_payload ?? {},
          trust_tier: taskDef.trust_tier ?? profile.trust_tier ?? 'yellow',
          priority: taskDef.priority ?? 'p2',
          confidence: taskDef.confidence ?? null,
          estimated_impact: taskDef.estimated_impact ?? null,
          approval_mode: profile.approval_mode ?? 'requires_approval',
        });

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

        if (shouldAutoApprove(task)) {
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

    // 14. Update memory with learnings
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

    console.log(`[agent-runner] '${agentId}' complete. Tasks: ${createdTasks.length}, Cost: $${costUsd.toFixed(6)}`);

    return { runId, tasksProposed: createdTasks.length, signalsDetected, costUsd };

  } catch (err) {
    db.prepare(`
      UPDATE agent_runs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(err.message, runId);

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
