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
import { actionTypeTrackRecord } from '../tasks/historical-learning.js';
import { recordDecision } from './decision-memory.js';

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
  "assumptions": ["thing we are assuming is true for this whole assessment to hold"],
  "paths": [
    {
      "name": "short label",
      "summary": "one sentence",
      "confidence": 0.0-1.0,
      "time_to_impact_days": <number>,
      "effort": "low|medium|high",
      "estimated_cost_gbp": <number|null — rough monthly cost of pursuing this path, or null if effectively free>,
      "action_type_hint": "the closest existing action_type this path resembles (e.g. meta_update, content_draft, github_issue), or null if none fit — used to look up historical track record, not executed directly",
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
  "success_criteria": ["concrete, measurable statement of what 'achieved' looks like — e.g. 'gsc.avg_ctr >= 3.2% for 2 consecutive weeks'"],
  "quick_wins": ["small things to do this week"],
  "do_not_do": ["things to avoid — wasted effort or will break attribution"],
  "agent_briefings": [
    { "agent_id": "seo-sentinel", "focus": "what this agent should prioritize",
      "avoid": "what they should not do toward this goal" }
  ],
  "chat_summary": "2-3 sentence plain-English version the user will see"
}`;

function extractJSON(content: string): Record<string, unknown> | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str!.trim()); } catch { return null; }
}

interface GoalContext {
  goal: Record<string, unknown>;
  business: Record<string, unknown> | null;
  trajectory: Record<string, unknown> | null;
  inFlight: Record<string, unknown>[];
  recentMetrics: Record<string, unknown>[];
  otherGoals: Record<string, unknown>[];
  assignedAgents: string[];
}

/**
 * Orchestrator. Gathers context, runs the LLM, persists results.
 * Fire-and-forget safe — swallows errors and logs.
 */
export async function runGoalReasoning(
  goalId: string,
  businessId: string
): Promise<{ reasoning: Record<string, unknown> | null; tasks_created: number; kb_filed: string | null }> {
  const ctx = assembleGoalContext(goalId, businessId);
  if (!ctx) return { reasoning: null, tasks_created: 0, kb_filed: null };

  const reasoning = await reasonAboutGoal(ctx);
  if (!reasoning) return { reasoning: null, tasks_created: 0, kb_filed: null };

  applyReasoningResults(ctx.goal, reasoning);
  const kbPath = await buildKBDocument(ctx, reasoning).catch(() => null);
  updateAgentGoalContext(ctx.goal, reasoning);
  persistStrategicPlanning(goalId, businessId, reasoning);

  return { reasoning, tasks_created: 0, kb_filed: kbPath };
}

/* ─── Context assembly ───────────────────────────────────────────────── */

function assembleGoalContext(goalId: string, businessId: string): GoalContext | null {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND business_id = ?').get(goalId, businessId) as Record<string, unknown> | null;
  if (!goal) return null;

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Record<string, unknown> | null;

  // Metric trajectory (if the goal has a metric)
  const trajectory = goal.metric_name ? calculateTrajectory(businessId, goal.metric_name as string) : null;

  // In-flight actions (respect their measurement windows)
  const inFlight = (db.prepare(`
    SELECT am.title, am.action_type, am.target_url, am.metrics_expected,
           am.measurement_window_start, am.measurement_window_end,
           am.do_not_touch_until, aw.display_name, aw.expected_days
    FROM action_memory am
    LEFT JOIN action_windows aw ON aw.action_type = am.action_type
    WHERE am.business_id = ? AND am.outcome_measured = 0
    ORDER BY am.measurement_window_start DESC LIMIT 10
  `).all(businessId) as Record<string, unknown>[]).map((r) => {
    let metrics: string[] = [];
    try { metrics = JSON.parse((r.metrics_expected as string) || '[]'); } catch {}
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
  `).all(businessId) as Record<string, unknown>[];

  // Other active goals (don't contradict / de-prioritise them)
  const otherGoals = db.prepare(`
    SELECT title, metric_name, metric_target, deadline, progress_pct
    FROM goals
    WHERE business_id = ? AND id != ? AND status = 'active'
    ORDER BY deadline ASC NULLS LAST LIMIT 5
  `).all(businessId, goalId) as Record<string, unknown>[];

  // Assigned agents (stored as JSON array of ids)
  let assignedAgents: string[] = [];
  try { assignedAgents = JSON.parse((goal.assigned_agents as string) || '[]'); } catch {}

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
export function calculateTrajectory(businessId: string, metricName: string): Record<string, unknown> {
  const points = db.prepare(`
    SELECT metric_value, recorded_at FROM metrics
    WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
      AND recorded_at > datetime('now', '-90 days')
    ORDER BY recorded_at ASC
  `).all(businessId, metricName) as Array<{ metric_value: string | number; recorded_at: string }>;

  if (points.length < 2) return { points: points.length, trend: 'insufficient_data' };

  const latest = Number(points[points.length - 1]!.metric_value);
  const earliest = Number(points[0]!.metric_value);
  const daysSpan = Math.max(
    1,
    (new Date(points[points.length - 1]!.recorded_at).getTime() - new Date(points[0]!.recorded_at).getTime()) / 86400000
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

function buildReasoningPrompt(ctx: GoalContext): string {
  const { goal, business, trajectory, inFlight, recentMetrics, otherGoals, assignedAgents } = ctx;
  const deadline = goal.deadline ? new Date(goal.deadline as string) : null;
  const daysLeft = deadline ? Math.ceil((deadline.getTime() - Date.now()) / 86400000) : null;

  return `Business: ${(business?.name as string) ?? 'unknown'} (${(business?.type as string) ?? 'general'})

GOAL
Title: ${goal.title}
Description: ${(goal.description as string | null) ?? '(none)'}
Metric: ${(goal.metric_name as string | null) ?? '(no metric set)'}
Baseline: ${(goal.metric_baseline as unknown) ?? '?'}
Current: ${(goal.metric_current as unknown) ?? '?'}
Target: ${(goal.metric_target as unknown) ?? '?'}
Deadline: ${(goal.deadline as string | null) ?? '(none)'}${daysLeft != null ? ` (${daysLeft} days from today)` : ''}
Current strategy (if any): ${(goal.strategy as string | null) ?? '(none)'}
Assigned agents: ${assignedAgents.join(', ') || '(none — infer a suitable set)'}

METRIC TRAJECTORY (last 90 days)
${trajectory ? JSON.stringify(trajectory) : '(no metric — cannot compute)'}

RECENT METRICS SAMPLE (last 30 days, grouped by name)
${recentMetrics.map((m) => `- ${m.metric_name}: ${m.metric_value}`).join('\n') || '(none)'}

ACTIONS CURRENTLY IN MEASUREMENT WINDOWS (do not recommend re-touching these)
${inFlight.length === 0 ? '(none)' : inFlight.map((a) => {
  const daysUntil = Math.ceil((new Date(a.do_not_touch_until as string).getTime() - Date.now()) / 86400000);
  return `- ${a.title} (${a.action_type}) — ${daysUntil > 0 ? `${daysUntil}d until touchable` : 'window open'}; affects ${((a.metrics_expected as string[]) || []).join(', ')}`;
}).join('\n')}

OTHER ACTIVE GOALS (don't contradict or cannibalise)
${otherGoals.map((g) => `- ${g.title} — ${(g.progress_pct as number | null) ?? 0}% progress${g.deadline ? `, deadline ${g.deadline}` : ''}`).join('\n') || '(none)'}

Allowed agent ids: conductor, seo-sentinel, quill, velocity, trend-spotter, merchant, ledger, sentinel, researcher, reporter, dev, outreach.

Produce the full JSON schema described in the system prompt.`;
}

async function reasonAboutGoal(ctx: GoalContext): Promise<Record<string, unknown> | null> {
  const user = buildReasoningPrompt(ctx);
  const { providerId, model } = resolveProfileLLM({});

  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.3,
      max_tokens: 4096,
    });
    return extractJSON((result as { content: string } | null)?.content ?? '');
  } catch (err) {
    console.warn('[goal-reasoner] LLM failed:', (err as Error).message);
    return null;
  }
}

/* ─── Persistence ────────────────────────────────────────────────────── */

function applyReasoningResults(goal: Record<string, unknown>, reasoning: Record<string, unknown>): void {
  // Merge milestones: keep human-authored ones, append new ones the reasoner produced.
  let existingMilestones: Record<string, unknown>[] = [];
  try { existingMilestones = JSON.parse((goal.milestones as string) || '[]'); } catch {}
  const newMilestones = Array.isArray(reasoning.milestones) ? reasoning.milestones as Record<string, unknown>[] : [];
  const merged = [...existingMilestones];
  for (const m of newMilestones) {
    if (!merged.some((e) => e.title === m.title)) merged.push(m);
  }

  // Append a note capturing this reasoning pass.
  let notes: Record<string, unknown>[] = [];
  try { notes = JSON.parse((goal.notes as string) || '[]'); } catch {}
  const feasibility = reasoning.feasibility as Record<string, unknown> | null;
  notes.push({
    at: new Date().toISOString(),
    source: 'goal-reasoner',
    text: (reasoning.chat_summary as string) || (feasibility?.honest_assessment as string) || '',
    feasibility: feasibility?.verdict ?? null,
    confidence: feasibility?.confidence ?? null,
    recommended_path: reasoning.recommended_path ?? null,
  });

  // Strategy text — prefer a concise combined blob the UI can show.
  const strategyParts: string[] = [];
  if (feasibility?.honest_assessment) {
    strategyParts.push(`**Feasibility:** ${feasibility.verdict} — ${feasibility.honest_assessment}`);
  }
  if (reasoning.recommended_path) {
    strategyParts.push(`**Recommended path:** ${reasoning.recommended_path}`);
  }
  if (feasibility?.key_constraint) {
    strategyParts.push(`**Key constraint:** ${feasibility.key_constraint}`);
  }
  const strategyText = strategyParts.join('\n\n') || (goal.strategy as string | null) || null;

  const updateParams: any[] = [strategyText, JSON.stringify(merged), JSON.stringify(notes), goal.id as string];
  db.prepare(`
    UPDATE goals
    SET strategy = COALESCE(?, strategy),
        milestones = ?,
        notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...updateParams);
}

async function buildKBDocument(ctx: GoalContext, reasoning: Record<string, unknown>): Promise<string | null> {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as { getKBForBusiness: (id: string) => Promise<{ engine: Record<string, unknown> } | null> };
    const result = await getKBForBusiness(ctx.goal.business_id as string);
    if (!result?.engine) return null;

    const today = new Date().toISOString().split('T')[0]!;
    const path = `decisions/goal-reasoning-${(ctx.goal.id as string).slice(0, 8)}-${today}.md`;

    const lines: string[] = [];
    lines.push(`# Goal Reasoning: ${ctx.goal.title}`);
    lines.push('');
    lines.push(`**Goal:** ${ctx.goal.title}`);
    lines.push(`**Metric:** ${(ctx.goal.metric_name as string | null) ?? '(none)'} — target ${(ctx.goal.metric_target as unknown) ?? '?'}`);
    lines.push(`**Deadline:** ${(ctx.goal.deadline as string | null) ?? '(none)'}`);
    lines.push(`**Reasoned on:** ${today}`);
    lines.push('');

    const feasibility = reasoning.feasibility as Record<string, unknown> | null;
    if (feasibility) {
      lines.push('## Feasibility');
      lines.push('');
      lines.push(`**Verdict:** ${feasibility.verdict} (confidence ${Math.round(((feasibility.confidence as number) ?? 0) * 100)}%)`);
      lines.push('');
      if (feasibility.honest_assessment) {
        lines.push(feasibility.honest_assessment as string);
        lines.push('');
      }
      if (feasibility.key_constraint) {
        lines.push(`**Key constraint:** ${feasibility.key_constraint}`);
        lines.push('');
      }
    }

    if (Array.isArray(reasoning.paths) && reasoning.paths.length > 0) {
      lines.push('## Paths considered');
      lines.push('');
      for (const p of reasoning.paths as Record<string, unknown>[]) {
        const star = p.name === reasoning.recommended_path ? ' ⭐ recommended' : '';
        lines.push(`- **${p.name}**${star} (confidence ${Math.round(((p.confidence as number) ?? 0) * 100)}%, ${p.effort} effort, ${(p.time_to_impact_days as number | null) ?? '?'}d to impact)`);
        if (p.summary) lines.push(`  ${p.summary}`);
      }
      lines.push('');
    }

    if (Array.isArray(reasoning.timeline) && reasoning.timeline.length > 0) {
      lines.push('## Month-by-month timeline');
      lines.push('');
      for (const t of reasoning.timeline as Record<string, unknown>[]) {
        lines.push(`- **Month ${t.month}:** ${t.focus} (target ${(t.expected_progress_pct as number | null) ?? '?'}%)`);
      }
      lines.push('');
    }

    if (Array.isArray(reasoning.milestones) && reasoning.milestones.length > 0) {
      lines.push('## Milestones');
      lines.push('');
      for (const m of reasoning.milestones as Record<string, unknown>[]) {
        lines.push(`- ${m.title} (${(m.target_pct as number | null) ?? '?'}%)${m.notes ? ` — ${m.notes}` : ''}`);
      }
      lines.push('');
    }

    const measurementPlan = reasoning.measurement_plan as Record<string, unknown> | null;
    if (measurementPlan) {
      lines.push('## Measurement plan');
      lines.push('');
      if ((measurementPlan.leading_indicators as string[] | null)?.length) {
        lines.push('**Leading indicators:**');
        for (const i of measurementPlan.leading_indicators as string[]) lines.push(`- ${i}`);
        lines.push('');
      }
      if ((measurementPlan.decision_points as string[] | null)?.length) {
        lines.push('**Decision points:**');
        for (const d of measurementPlan.decision_points as string[]) lines.push(`- ${d}`);
        lines.push('');
      }
    }

    if (Array.isArray(reasoning.risks) && reasoning.risks.length > 0) {
      lines.push('## Risks');
      lines.push('');
      for (const r of reasoning.risks as Record<string, unknown>[]) lines.push(`- **${r.risk}** — ${(r.mitigation as string | null) ?? ''}`);
      lines.push('');
    }

    if (Array.isArray(reasoning.quick_wins) && reasoning.quick_wins.length > 0) {
      lines.push('## Quick wins');
      lines.push('');
      for (const q of reasoning.quick_wins as string[]) lines.push(`- ${q}`);
      lines.push('');
    }

    if (Array.isArray(reasoning.do_not_do) && reasoning.do_not_do.length > 0) {
      lines.push('## Do not do');
      lines.push('');
      for (const d of reasoning.do_not_do as string[]) lines.push(`- ${d}`);
      lines.push('');
    }

    if (Array.isArray(reasoning.agent_briefings) && reasoning.agent_briefings.length > 0) {
      lines.push('## Agent briefings');
      lines.push('');
      for (const b of reasoning.agent_briefings as Record<string, unknown>[]) {
        lines.push(`### ${b.agent_id}`);
        if (b.focus) lines.push(`- **Focus:** ${b.focus}`);
        if (b.avoid) lines.push(`- **Avoid:** ${b.avoid}`);
        lines.push('');
      }
    }

    const engine = result.engine as { writeFile: (...args: unknown[]) => Promise<void> };
    await engine.writeFile(
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
      `goal reasoning: ${(ctx.goal.title as string).slice(0, 60)}`
    );
    return path;
  } catch (err) {
    console.warn('[goal-reasoner] KB write failed:', (err as Error).message);
    return null;
  }
}

/**
 * Store a per-agent briefing as a setting so agent-runner can surface it
 * in the system prompt for that agent + business.
 */
function updateAgentGoalContext(goal: Record<string, unknown>, reasoning: Record<string, unknown>): void {
  const briefings = Array.isArray(reasoning.agent_briefings) ? reasoning.agent_briefings as Record<string, unknown>[] : [];
  if (briefings.length === 0) return;

  for (const b of briefings) {
    if (!b?.agent_id) continue;
    const key = `agent_goal_briefing_${goal.business_id}_${b.agent_id}`;
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
    let payload: Record<string, unknown>[] = [];
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

/* ─── Phase 3: Strategic Planning Engine + Multi-Strategy Planning ─────────
 *
 * Everything above this point (applyReasoningResults/buildKBDocument/
 * updateAgentGoalContext) is the original Phase-0/1/2-era behaviour —
 * unchanged. This section is what turns a single reasoning pass into two
 * durable, independently queryable object sets: one goal_assessments row
 * (the "strategic assessment" — feasibility/risks/assumptions/measurement
 * plan/success criteria) and one goal_strategies row per candidate path
 * (comparable side-by-side: confidence/effort/cost/evidence/historical
 * success), rather than only the flattened `goal.strategy` text blob and
 * a rendered KB page a caller could read but never query structurally.
 */

function persistStrategicPlanning(goalId: string, businessId: string, reasoning: Record<string, unknown>): void {
  try {
    const feasibility = (reasoning.feasibility as Record<string, unknown> | null) ?? null;
    const paths = Array.isArray(reasoning.paths) ? reasoning.paths as Record<string, unknown>[] : [];
    const successCriteria = Array.isArray(reasoning.success_criteria) ? reasoning.success_criteria as string[] : [];

    const assessmentId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO goal_assessments (
        id, goal_id, business_id, feasibility_verdict, feasibility_confidence,
        feasibility_reasoning, key_constraint, expected_impact, gap_analysis,
        assumptions, risks, dependencies, measurement_plan, success_criteria,
        created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'goal-reasoner', CURRENT_TIMESTAMP)
    `).run(
      assessmentId, goalId, businessId,
      (feasibility?.verdict as string | null) ?? null,
      (feasibility?.confidence as number | null) ?? null,
      (feasibility?.honest_assessment as string | null) ?? null,
      (feasibility?.key_constraint as string | null) ?? null,
      (reasoning.recommended_path as string | null) ?? null,
      JSON.stringify(reasoning.gap_analysis ?? null),
      JSON.stringify(Array.isArray(reasoning.assumptions) ? reasoning.assumptions : []),
      JSON.stringify(Array.isArray(reasoning.risks) ? reasoning.risks : []),
      JSON.stringify(Array.isArray(reasoning.constraints) ? reasoning.constraints : []),
      JSON.stringify(reasoning.measurement_plan ?? null),
      JSON.stringify(successCriteria),
    );

    let recommendedStrategyId: string | null = null;
    for (const p of paths) {
      const strategyId = crypto.randomUUID();
      const isRecommended = p.name === reasoning.recommended_path;
      if (isRecommended) recommendedStrategyId = strategyId;

      // Historical success rate is best-effort: only populated when the
      // LLM's action_type_hint matches a real, previously-used action_type
      // for this business. A miss (hint is null, or no track record yet)
      // leaves it null rather than guessing.
      const hint = (p.action_type_hint as string | null) ?? null;
      const track = hint ? actionTypeTrackRecord(businessId, hint) : null;

      db.prepare(`
        INSERT INTO goal_strategies (
          id, goal_id, business_id, assessment_id, name, summary,
          expected_impact_summary, confidence, estimated_effort, estimated_cost,
          estimated_cost_unit, time_to_impact_days, historical_success_rate,
          historical_sample_size, evidence, depends_on, is_recommended, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gbp', ?, ?, ?, ?, ?, ?, 'candidate', CURRENT_TIMESTAMP)
      `).run(
        strategyId, goalId, businessId, assessmentId,
        String(p.name ?? 'Unnamed strategy'), (p.summary as string | null) ?? null,
        (p.summary as string | null) ?? null,
        typeof p.confidence === 'number' ? p.confidence : null,
        (p.effort as string | null) ?? null,
        typeof p.estimated_cost_gbp === 'number' ? p.estimated_cost_gbp : null,
        typeof p.time_to_impact_days === 'number' ? p.time_to_impact_days : null,
        track?.success_rate ?? null,
        track?.sample_size ?? 0,
        JSON.stringify(hint ? [`Historical track record for action_type "${hint}": ${track?.success_count ?? 0}/${track?.sample_size ?? 0} succeeded.`] : []),
        JSON.stringify(Array.isArray(p.depends_on) ? p.depends_on : []),
        isRecommended ? 1 : 0,
      );
    }

    if (recommendedStrategyId) {
      db.prepare('UPDATE goal_assessments SET recommended_strategy_id = ? WHERE id = ?').run(recommendedStrategyId, assessmentId);
    }

    if (reasoning.recommended_path && paths.length > 0) {
      const alternatives = paths.filter((p) => p.name !== reasoning.recommended_path).map((p) => ({ name: p.name, summary: p.summary, confidence: p.confidence }));
      recordDecision({
        business_id: businessId, decision_type: 'strategy_selection',
        title: `Strategy selected for goal: ${reasoning.recommended_path}`,
        decision: `Recommended strategy "${reasoning.recommended_path}" over ${alternatives.length} alternative(s).`,
        reasoning: (feasibility?.honest_assessment as string | null) ?? null,
        confidence: (feasibility?.confidence as number | null) ?? null,
        alternatives_rejected: alternatives,
        author: 'goal-reasoner', related_goal_id: goalId,
      });
    }
  } catch (err) {
    console.warn('[goal-reasoner] Phase 3 strategic planning persistence failed:', (err as Error).message);
  }
}
