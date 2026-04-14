/**
 * Brain — Goal Reasoner.
 *
 * When a goal is created (or on a weekly cadence), run a strategic
 * reasoning pass:
 *   - Assemble context (metrics, trajectory, in-flight actions, KB,
 *     existing strategy).
 *   - Ask the LLM for a structured assessment: feasibility, paths,
 *     timeline, milestones, risks, quick wins, do-not-do, agent
 *     briefings, and a chat summary.
 *   - Persist the results back onto the goal row (strategy, milestones,
 *     notes) and file a KB document under decisions/.
 *   - Update per-agent briefings so each assigned agent knows what to
 *     focus on and what to avoid.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const SYSTEM_PROMPT = `You are Blueprint's strategic goal reasoner.

Given a business goal, the current metric trajectory, recent actions already in flight,
and the business context, produce an honest strategic assessment.

Rules:
- Be specific, not generic. Reference real numbers from the context.
- Be honest about feasibility — "unrealistic" is a valid verdict.
- Prefer measurable, high-leverage paths over busywork.
- Respect in-flight actions: do not recommend re-touching areas still in their
  measurement windows.
- Only include agents from the provided list.

Return only valid JSON. No prose outside JSON.

Schema:
{
  "feasibility": {
    "verdict": "achievable|ambitious|unlikely|unrealistic",
    "confidence": 0.0-1.0,
    "honest_assessment": "2-3 sentences of plain-English reasoning",
    "key_constraint": "the single biggest blocker"
  },
  "gap_analysis": {
    "current": <number>,
    "target": <number>,
    "gap_pct": <number>,
    "run_rate_needed": "e.g. '+3% per week'",
    "trajectory_now": "improving|flat|declining",
    "projected_at_deadline": <number|null>
  },
  "paths": [
    {
      "name": "short label",
      "summary": "one sentence",
      "confidence": 0.0-1.0,
      "time_to_impact_days": <number>,
      "effort": "low|medium|high",
      "depends_on": ["other path name if any"]
    }
  ],
  "recommended_path": "name of one path above",
  "timeline": [
    { "month": 1, "focus": "what to do", "expected_progress_pct": <number> }
  ],
  "milestones": [
    { "title": "concrete checkpoint", "target_pct": 25, "notes": "what proves we are on track" }
  ],
  "risks": [
    { "risk": "what could go wrong", "mitigation": "how to reduce it" }
  ],
  "constraints": ["hard limits we must respect"],
  "measurement_plan": {
    "leading_indicators": ["metrics that move first"],
    "decision_points": ["when to re-evaluate the plan"]
  },
  "quick_wins": ["small things to do this week"],
  "do_not_do": ["things to avoid — wasted effort or will break attribution"],
  "agent_briefings": [
    { "agent_id": "seo-sentinel", "focus": "what this agent should prioritize",
      "avoid": "what they should not do toward this goal" }
  ],
  "chat_summary": "2-3 sentence plain-English version the user will see"
}`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

/**
 * Orchestrator. Gathers context, runs the LLM, persists results.
 * Fire-and-forget safe — swallows errors and logs.
 *
 * @param {string} goalId
 * @param {string} businessId
 * @returns {Promise<{reasoning: object|null, tasks_created: number, kb_filed: string|null}>}
 */
export async function runGoalReasoning(goalId, businessId) {
  const ctx = assembleGoalContext(goalId, businessId);
  if (!ctx) return { reasoning: null, tasks_created: 0, kb_filed: null };

  const reasoning = await reasonAboutGoal(ctx);
  if (!reasoning) return { reasoning: null, tasks_created: 0, kb_filed: null };

  applyReasoningResults(ctx.goal, reasoning);
  const kbPath = await buildKBDocument(ctx, reasoning).catch(() => null);
  updateAgentGoalContext(ctx.goal, reasoning);

  return { reasoning, tasks_created: 0, kb_filed: kbPath };
}

/* ─── Context assembly ───────────────────────────────────────────────── */

function assembleGoalContext(goalId, businessId) {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND business_id = ?').get(goalId, businessId);
  if (!goal) return null;

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);

  // Metric trajectory (if the goal has a metric)
  const trajectory = goal.metric_name ? calculateTrajectory(businessId, goal.metric_name) : null;

  // In-flight actions (respect their measurement windows)
  const inFlight = db.prepare(`
    SELECT am.title, am.action_type, am.target_url, am.metrics_expected,
           am.measurement_window_start, am.measurement_window_end,
           am.do_not_touch_until, aw.display_name, aw.expected_days
    FROM action_memory am
    LEFT JOIN action_windows aw ON aw.action_type = am.action_type
    WHERE am.business_id = ? AND am.outcome_measured = 0
    ORDER BY am.measurement_window_start DESC LIMIT 10
  `).all(businessId).map((r) => {
    let metrics = [];
    try { metrics = JSON.parse(r.metrics_expected || '[]'); } catch {}
    return { ...r, metrics_expected: metrics };
  });

  // Recent metrics sample (to ground the reasoning in reality)
  const recentMetrics = db.prepare(`
    SELECT metric_name, metric_value, recorded_at
    FROM metrics
    WHERE business_id = ? AND metric_value IS NOT NULL
      AND recorded_at > datetime('now', '-30 days')
    GROUP BY metric_name
    ORDER BY recorded_at DESC LIMIT 30
  `).all(businessId);

  // Other active goals (don't contradict / de-prioritise them)
  const otherGoals = db.prepare(`
    SELECT title, metric_name, metric_target, deadline, progress_pct
    FROM goals
    WHERE business_id = ? AND id != ? AND status = 'active'
    ORDER BY deadline ASC NULLS LAST LIMIT 5
  `).all(businessId, goalId);

  // Assigned agents (stored as JSON array of ids)
  let assignedAgents = [];
  try { assignedAgents = JSON.parse(goal.assigned_agents || '[]'); } catch {}

  return {
    goal,
    business,
    trajectory,
    inFlight,
    recentMetrics,
    otherGoals,
    assignedAgents,
  };
}

/**
 * Compute simple trajectory: latest vs 30-day-ago value, weekly rate.
 */
export function calculateTrajectory(businessId, metricName) {
  const points = db.prepare(`
    SELECT metric_value, recorded_at FROM metrics
    WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
      AND recorded_at > datetime('now', '-90 days')
    ORDER BY recorded_at ASC
  `).all(businessId, metricName);

  if (points.length < 2) return { points: points.length, trend: 'insufficient_data' };

  const latest = Number(points[points.length - 1].metric_value);
  const earliest = Number(points[0].metric_value);
  const daysSpan = Math.max(
    1,
    (new Date(points[points.length - 1].recorded_at) - new Date(points[0].recorded_at)) / 86400000
  );
  const dailyDelta = (latest - earliest) / daysSpan;
  const weeklyDelta = dailyDelta * 7;
  const pctChange = earliest !== 0 ? ((latest - earliest) / Math.abs(earliest)) * 100 : 0;

  let trend = 'flat';
  if (Math.abs(pctChange) >= 5) trend = pctChange > 0 ? 'improving' : 'declining';

  return {
    points: points.length,
    latest,
    earliest,
    days_span: Math.round(daysSpan),
    daily_delta: dailyDelta,
    weekly_delta: weeklyDelta,
    pct_change: pctChange,
    trend,
  };
}

/* ─── LLM reasoning ──────────────────────────────────────────────────── */

function buildReasoningPrompt(ctx) {
  const { goal, business, trajectory, inFlight, recentMetrics, otherGoals, assignedAgents } = ctx;
  const deadline = goal.deadline ? new Date(goal.deadline) : null;
  const daysLeft = deadline ? Math.ceil((deadline - Date.now()) / 86400000) : null;

  return `Business: ${business?.name ?? 'unknown'} (${business?.type ?? 'general'})

GOAL
Title: ${goal.title}
Description: ${goal.description ?? '(none)'}
Metric: ${goal.metric_name ?? '(no metric set)'}
Baseline: ${goal.metric_baseline ?? '?'}
Current: ${goal.metric_current ?? '?'}
Target: ${goal.metric_target ?? '?'}
Deadline: ${goal.deadline ?? '(none)'}${daysLeft != null ? ` (${daysLeft} days from today)` : ''}
Current strategy (if any): ${goal.strategy ?? '(none)'}
Assigned agents: ${assignedAgents.join(', ') || '(none — infer a suitable set)'}

METRIC TRAJECTORY (last 90 days)
${trajectory ? JSON.stringify(trajectory) : '(no metric — cannot compute)'}

RECENT METRICS SAMPLE (last 30 days, grouped by name)
${recentMetrics.map((m) => `- ${m.metric_name}: ${m.metric_value}`).join('\n') || '(none)'}

ACTIONS CURRENTLY IN MEASUREMENT WINDOWS (do not recommend re-touching these)
${inFlight.length === 0 ? '(none)' : inFlight.map((a) => {
  const daysUntil = Math.ceil((new Date(a.do_not_touch_until) - Date.now()) / 86400000);
  return `- ${a.title} (${a.action_type}) — ${daysUntil > 0 ? `${daysUntil}d until touchable` : 'window open'}; affects ${(a.metrics_expected || []).join(', ')}`;
}).join('\n')}

OTHER ACTIVE GOALS (don't contradict or cannibalise)
${otherGoals.map((g) => `- ${g.title} — ${g.progress_pct ?? 0}% progress${g.deadline ? `, deadline ${g.deadline}` : ''}`).join('\n') || '(none)'}

Allowed agent ids: conductor, seo-sentinel, quill, velocity, trend-spotter, merchant, ledger, sentinel, researcher, reporter, dev, outreach.

Produce the full JSON schema described in the system prompt.`;
}

async function reasonAboutGoal(ctx) {
  const user = buildReasoningPrompt(ctx);
  const { providerId, model } = resolveProfileLLM({});

  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.3,
      max_tokens: 4096,
    });
    return extractJSON(result?.content ?? '');
  } catch (err) {
    console.warn('[goal-reasoner] LLM failed:', err.message);
    return null;
  }
}

/* ─── Persistence ────────────────────────────────────────────────────── */

function applyReasoningResults(goal, reasoning) {
  // Merge milestones: keep human-authored ones, append new ones the reasoner produced.
  let existingMilestones = [];
  try { existingMilestones = JSON.parse(goal.milestones || '[]'); } catch {}
  const newMilestones = Array.isArray(reasoning.milestones) ? reasoning.milestones : [];
  const merged = [...existingMilestones];
  for (const m of newMilestones) {
    if (!merged.some((e) => e.title === m.title)) merged.push(m);
  }

  // Append a note capturing this reasoning pass.
  let notes = [];
  try { notes = JSON.parse(goal.notes || '[]'); } catch {}
  notes.push({
    at: new Date().toISOString(),
    source: 'goal-reasoner',
    text: reasoning.chat_summary || reasoning.feasibility?.honest_assessment || '',
    feasibility: reasoning.feasibility?.verdict ?? null,
    confidence: reasoning.feasibility?.confidence ?? null,
    recommended_path: reasoning.recommended_path ?? null,
  });

  // Strategy text — prefer a concise combined blob the UI can show.
  const strategyParts = [];
  if (reasoning.feasibility?.honest_assessment) {
    strategyParts.push(`**Feasibility:** ${reasoning.feasibility.verdict} — ${reasoning.feasibility.honest_assessment}`);
  }
  if (reasoning.recommended_path) {
    strategyParts.push(`**Recommended path:** ${reasoning.recommended_path}`);
  }
  if (reasoning.feasibility?.key_constraint) {
    strategyParts.push(`**Key constraint:** ${reasoning.feasibility.key_constraint}`);
  }
  const strategyText = strategyParts.join('\n\n') || goal.strategy || null;

  db.prepare(`
    UPDATE goals
    SET strategy = COALESCE(?, strategy),
        milestones = ?,
        notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(strategyText, JSON.stringify(merged), JSON.stringify(notes), goal.id);
}

async function buildKBDocument(ctx, reasoning) {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(ctx.business.id);
    if (!result?.engine) return null;

    const today = new Date().toISOString().split('T')[0];
    const path = `decisions/goal-reasoning-${ctx.goal.id.slice(0, 8)}-${today}.md`;

    const lines = [];
    lines.push(`# Goal Reasoning: ${ctx.goal.title}`);
    lines.push('');
    lines.push(`**Goal:** ${ctx.goal.title}`);
    lines.push(`**Metric:** ${ctx.goal.metric_name ?? '(none)'} — target ${ctx.goal.metric_target ?? '?'}`);
    lines.push(`**Deadline:** ${ctx.goal.deadline ?? '(none)'}`);
    lines.push(`**Reasoned on:** ${today}`);
    lines.push('');

    if (reasoning.feasibility) {
      lines.push('## Feasibility');
      lines.push('');
      lines.push(`**Verdict:** ${reasoning.feasibility.verdict} (confidence ${Math.round((reasoning.feasibility.confidence ?? 0) * 100)}%)`);
      lines.push('');
      if (reasoning.feasibility.honest_assessment) {
        lines.push(reasoning.feasibility.honest_assessment);
        lines.push('');
      }
      if (reasoning.feasibility.key_constraint) {
        lines.push(`**Key constraint:** ${reasoning.feasibility.key_constraint}`);
        lines.push('');
      }
    }

    if (Array.isArray(reasoning.paths) && reasoning.paths.length > 0) {
      lines.push('## Paths considered');
      lines.push('');
      for (const p of reasoning.paths) {
        const star = p.name === reasoning.recommended_path ? ' ⭐ recommended' : '';
        lines.push(`- **${p.name}**${star} (confidence ${Math.round((p.confidence ?? 0) * 100)}%, ${p.effort} effort, ${p.time_to_impact_days ?? '?'}d to impact)`);
        if (p.summary) lines.push(`  ${p.summary}`);
      }
      lines.push('');
    }

    if (Array.isArray(reasoning.timeline) && reasoning.timeline.length > 0) {
      lines.push('## Month-by-month timeline');
      lines.push('');
      for (const t of reasoning.timeline) {
        lines.push(`- **Month ${t.month}:** ${t.focus} (target ${t.expected_progress_pct ?? '?'}%)`);
      }
      lines.push('');
    }

    if (Array.isArray(reasoning.milestones) && reasoning.milestones.length > 0) {
      lines.push('## Milestones');
      lines.push('');
      for (const m of reasoning.milestones) {
        lines.push(`- ${m.title} (${m.target_pct ?? '?'}%)${m.notes ? ` — ${m.notes}` : ''}`);
      }
      lines.push('');
    }

    if (reasoning.measurement_plan) {
      lines.push('## Measurement plan');
      lines.push('');
      if (reasoning.measurement_plan.leading_indicators?.length) {
        lines.push('**Leading indicators:**');
        for (const i of reasoning.measurement_plan.leading_indicators) lines.push(`- ${i}`);
        lines.push('');
      }
      if (reasoning.measurement_plan.decision_points?.length) {
        lines.push('**Decision points:**');
        for (const d of reasoning.measurement_plan.decision_points) lines.push(`- ${d}`);
        lines.push('');
      }
    }

    if (Array.isArray(reasoning.risks) && reasoning.risks.length > 0) {
      lines.push('## Risks');
      lines.push('');
      for (const r of reasoning.risks) lines.push(`- **${r.risk}** — ${r.mitigation ?? ''}`);
      lines.push('');
    }

    if (Array.isArray(reasoning.quick_wins) && reasoning.quick_wins.length > 0) {
      lines.push('## Quick wins');
      lines.push('');
      for (const q of reasoning.quick_wins) lines.push(`- ${q}`);
      lines.push('');
    }

    if (Array.isArray(reasoning.do_not_do) && reasoning.do_not_do.length > 0) {
      lines.push('## Do not do');
      lines.push('');
      for (const d of reasoning.do_not_do) lines.push(`- ${d}`);
      lines.push('');
    }

    if (Array.isArray(reasoning.agent_briefings) && reasoning.agent_briefings.length > 0) {
      lines.push('## Agent briefings');
      lines.push('');
      for (const b of reasoning.agent_briefings) {
        lines.push(`### ${b.agent_id}`);
        if (b.focus) lines.push(`- **Focus:** ${b.focus}`);
        if (b.avoid) lines.push(`- **Avoid:** ${b.avoid}`);
        lines.push('');
      }
    }

    await result.engine.writeFile(
      path,
      lines.join('\n'),
      {
        title: `Goal reasoning: ${ctx.goal.title}`.slice(0, 100),
        tags: ['goal', 'reasoning', 'strategy'],
        created: today,
        updated: today,
        written_by: 'goal-reasoner',
        review_status: 'auto_approved',
      },
      `goal reasoning: ${ctx.goal.title.slice(0, 60)}`
    );
    return path;
  } catch (err) {
    console.warn('[goal-reasoner] KB write failed:', err.message);
    return null;
  }
}

/**
 * Store a per-agent briefing as a setting so agent-runner can surface it
 * in the system prompt for that agent + business.
 */
function updateAgentGoalContext(goal, reasoning) {
  const briefings = Array.isArray(reasoning.agent_briefings) ? reasoning.agent_briefings : [];
  if (briefings.length === 0) return;

  for (const b of briefings) {
    if (!b?.agent_id) continue;
    const key = `agent_goal_briefing_${goal.business_id}_${b.agent_id}`;
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    let payload = [];
    if (existing?.value) {
      try { payload = JSON.parse(existing.value); } catch {}
    }
    // Replace any previous briefing for this goal, then push the new one.
    payload = payload.filter((p) => p.goal_id !== goal.id);
    payload.push({
      goal_id: goal.id,
      goal_title: goal.title,
      focus: b.focus ?? null,
      avoid: b.avoid ?? null,
      updated_at: new Date().toISOString(),
    });
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(payload));
  }
}
