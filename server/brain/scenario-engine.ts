/**
 * Brain — Scenario Planning.
 *
 * Answers strategic "what if" questions by modelling 3-4 distinct scenarios
 * side-by-side with projected outcomes, confidence, timelines, and a clear
 * recommendation.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import type { RunLLMResult } from '../lib/llm-providers.js';

const SYSTEM_PROMPT = `You are Blueprint's strategic scenario planner.

Given a business, its current metrics, in-flight actions, existing goals, and
a "what if" question, model 3-4 DISTINCT scenarios that could answer it.

Rules:
- Each scenario is a different strategic choice, not a variation of the same plan.
- Be specific and quantified. Use real numbers from the provided context.
- Name each scenario descriptively (e.g. "Premium positioning", "Aggressive discounting"),
  not "Scenario A/B/C".
- Include a HONEST confidence score. Do not inflate.
- Flag risks explicitly. Scenarios with fatal risks still get modelled.

Return only valid JSON. No prose outside JSON.

Schema:
{
  "scenarios": [
    {
      "name": "short descriptive name",
      "core_assumption": "the main thing this scenario is betting on",
      "projected_impact": {
        "summary": "one line quantified impact",
        "metrics": [{ "metric": "metric name", "change": "+12%", "confidence": 0.0-1.0 }]
      },
      "time_to_results_days": <number>,
      "confidence": 0.0-1.0,
      "confidence_reasoning": "why this confidence level",
      "key_risks": ["risk 1", "risk 2"],
      "requires_to_succeed": ["what must be true"],
      "verdict": "one-sentence verdict"
    }
  ],
  "recommended_scenario": "name of recommended scenario",
  "recommendation_reasoning": "why this one over the others",
  "decision_criteria": ["what data/info would change the recommendation"],
  "next_step": "the single most important thing to do right now"
}`;

function extractJSON(content: string): Record<string, unknown> | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str!.trim()); } catch { return null; }
}

/**
 * Model 3-4 scenarios for a business question.
 */
export async function modelScenarios(
  businessId: string,
  question: string,
  context = ''
): Promise<Record<string, unknown> | null> {
  if (!businessId || !question) throw new Error('businessId and question required');

  const ctx = assembleContext(businessId);
  const prompt = buildPrompt(question, context, ctx);

  const { providerId, model } = resolveProfileLLM({});

  let rawContent = '';
  let parsed: Record<string, unknown> | null = null;
  let llmResult: RunLLMResult | undefined;
  const startedAt = new Date().toISOString();
  const { recordAgentActivity } = await import('../agents/activity.js') as unknown as {
    recordAgentActivity: (params: Record<string, unknown>) => void;
  };
  try {
    llmResult = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 4096,
    });
    rawContent = llmResult.content ?? '';
    parsed = extractJSON(rawContent);
    recordAgentActivity({
      agentId: 'conductor', businessId, trigger: 'scenarios',
      status: 'complete', reasoning: `Scenario modelling: "${(question ?? '').slice(0, 80)}"`,
      usage: llmResult?.usage, cost_usd: llmResult?.cost_usd, startedAt,
    });
  } catch (err) {
    recordAgentActivity({
      agentId: 'conductor', businessId, trigger: 'scenarios',
      status: 'failed', reasoning: `Scenario modelling failed`,
      error: (err as Error).message.slice(0, 500), startedAt,
    });
    // Surface the real reason instead of a silent null. Most common causes:
    //   - no provider credentials configured for the chosen provider
    //   - provider quota / rate limit
    //   - model not available for this key
    console.warn('[scenario-engine] LLM failed:', (err as Error).message);
    throw new Error(`LLM call failed (${providerId}/${model}): ${(err as Error).message}`);
  }

  if (!parsed || !Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    const preview = rawContent ? ` Response preview: ${rawContent.slice(0, 160)}` : ' The provider returned an empty response — check that your LLM provider credentials are configured in Settings.';
    throw new Error(`LLM response could not be parsed into scenarios.${preview}`);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO scenarios
    (id, business_id, question, context, scenarios_json, recommended,
     recommendation_reasoning, decision_criteria, next_step, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, businessId, question, context ?? null,
    JSON.stringify(parsed.scenarios),
    (parsed.recommended_scenario as string | null) ?? null,
    (parsed.recommendation_reasoning as string | null) ?? null,
    JSON.stringify((parsed.decision_criteria as string[] | null) ?? []),
    (parsed.next_step as string | null) ?? null,
    'human'
  );

  // File to KB — best effort
  const kbPath = await fileScenarioToKB(businessId, id, question, parsed).catch(() => null);
  if (kbPath) {
    db.prepare('UPDATE scenarios SET kb_path = ? WHERE id = ?').run(kbPath, id);
  }

  return {
    id,
    question,
    context,
    scenarios: parsed.scenarios,
    recommended_scenario: (parsed.recommended_scenario as string | null) ?? null,
    recommendation_reasoning: (parsed.recommendation_reasoning as string | null) ?? null,
    decision_criteria: (parsed.decision_criteria as string[] | null) ?? [],
    next_step: (parsed.next_step as string | null) ?? null,
    kb_path: kbPath,
  };
}

function assembleContext(businessId: string): Record<string, unknown> {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Record<string, unknown> | null;

  const recentMetrics = db.prepare(`
    SELECT metric_name, metric_value, recorded_at
    FROM metrics
    WHERE business_id = ? AND metric_value IS NOT NULL
      AND recorded_at > datetime('now', '-30 days')
    GROUP BY metric_name ORDER BY recorded_at DESC LIMIT 30
  `).all(businessId) as Record<string, unknown>[];

  const activeGoals = db.prepare(`
    SELECT title, metric_name, metric_target, progress_pct, deadline, strategy
    FROM goals WHERE business_id = ? AND status = 'active'
    ORDER BY deadline ASC LIMIT 10
  `).all(businessId) as Record<string, unknown>[];

  const inFlight = (db.prepare(`
    SELECT am.title, am.action_type, am.metrics_expected, am.do_not_touch_until
    FROM action_memory am
    WHERE am.business_id = ? AND am.outcome_measured = 0
    ORDER BY am.measurement_window_start DESC LIMIT 10
  `).all(businessId) as Record<string, unknown>[]).map((r) => {
    let m: string[] = [];
    try { m = JSON.parse((r.metrics_expected as string) || '[]'); } catch {}
    return { ...r, metrics_expected: m };
  });

  const recentOutcomes = db.prepare(`
    SELECT t.title, t.action_type, t.target_metric, o.verdict, o.change_pct
    FROM task_outcomes o JOIN tasks t ON t.id = o.task_id
    WHERE t.business_id = ? AND o.verdict IS NOT NULL
    ORDER BY o.check_date DESC LIMIT 10
  `).all(businessId) as Record<string, unknown>[];

  return { business, recentMetrics, activeGoals, inFlight, recentOutcomes };
}

function buildPrompt(question: string, context: string, ctx: Record<string, unknown>): string {
  const lines: string[] = [];
  const business = ctx.business as Record<string, unknown> | null;
  lines.push(`Business: ${(business?.name as string) ?? 'unknown'} (${(business?.type as string) ?? 'general'})`);
  lines.push('');
  lines.push(`QUESTION: ${question}`);
  if (context) lines.push(`\nADDITIONAL CONTEXT: ${context}`);
  lines.push('');
  lines.push('CURRENT METRICS (last 30d):');
  lines.push((ctx.recentMetrics as Record<string, unknown>[]).map((m) => `- ${m.metric_name}: ${m.metric_value}`).join('\n') || '(none)');
  lines.push('');
  lines.push('ACTIVE GOALS:');
  lines.push((ctx.activeGoals as Record<string, unknown>[]).map((g) => `- ${g.title} (${(g.progress_pct as number | null) ?? 0}%)${g.deadline ? `, deadline ${g.deadline}` : ''}`).join('\n') || '(none)');
  lines.push('');
  lines.push('ACTIONS IN MEASUREMENT WINDOWS (do not recommend re-touching):');
  lines.push((ctx.inFlight as Record<string, unknown>[]).map((a) => `- ${a.title} (${a.action_type})`).join('\n') || '(none)');
  lines.push('');
  lines.push('RECENT OUTCOMES:');
  lines.push((ctx.recentOutcomes as Record<string, unknown>[]).map((o) => `- ${o.title}: ${o.verdict} (${(o.change_pct as number) > 0 ? '+' : ''}${((o.change_pct as number) ?? 0).toFixed(1)}%)`).join('\n') || '(none)');
  lines.push('');
  lines.push('Produce 3-4 distinct scenarios per the JSON schema in the system prompt.');
  return lines.join('\n');
}

async function fileScenarioToKB(
  businessId: string,
  scenarioId: string,
  question: string,
  parsed: Record<string, unknown>
): Promise<string | null> {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
      getKBForBusiness: (id: string) => Promise<{ engine: Record<string, unknown> } | null>;
    };
    const result = await getKBForBusiness(businessId);
    if (!result?.engine) return null;

    const today = new Date().toISOString().split('T')[0]!;
    const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const path = `decisions/scenario-${today}-${slug || scenarioId.slice(0, 8)}.md`;

    const lines: string[] = [];
    lines.push(`# Scenario Analysis: ${question}`);
    lines.push('');
    lines.push(`**Date:** ${today}`);
    if (parsed.recommended_scenario) {
      lines.push(`**Recommended:** ${parsed.recommended_scenario}`);
    }
    lines.push('');
    for (const s of parsed.scenarios as Record<string, unknown>[]) {
      const star = s.name === parsed.recommended_scenario ? ' ⭐' : '';
      lines.push(`## ${s.name}${star}`);
      lines.push('');
      lines.push(`**Assumption:** ${s.core_assumption}`);
      lines.push(`**Projected impact:** ${(s.projected_impact as Record<string, unknown> | null)?.summary ?? ''}`);
      lines.push(`**Time to results:** ${(s.time_to_results_days as number | null) ?? '?'} days`);
      lines.push(`**Confidence:** ${Math.round(((s.confidence as number | null) ?? 0) * 100)}% — ${(s.confidence_reasoning as string | null) ?? ''}`);
      if (Array.isArray(s.key_risks) && (s.key_risks as string[]).length) {
        lines.push('**Risks:**');
        for (const r of s.key_risks as string[]) lines.push(`- ${r}`);
      }
      if (s.verdict) lines.push(`\n> ${s.verdict}`);
      lines.push('');
    }
    if (parsed.recommendation_reasoning) {
      lines.push('## Why this recommendation');
      lines.push('');
      lines.push(parsed.recommendation_reasoning as string);
      lines.push('');
    }
    if (Array.isArray(parsed.decision_criteria) && (parsed.decision_criteria as string[]).length) {
      lines.push('## Decision criteria');
      lines.push('');
      for (const d of parsed.decision_criteria as string[]) lines.push(`- ${d}`);
      lines.push('');
    }
    if (parsed.next_step) {
      lines.push(`## Next step\n\n${parsed.next_step}`);
    }

    const engine = result.engine as { writeFile: (...args: unknown[]) => Promise<void> };
    await engine.writeFile(
      path, lines.join('\n'),
      {
        title: `Scenario: ${question}`.slice(0, 100),
        tags: ['scenario', 'decision', 'strategy'],
        created: today, updated: today,
        written_by: 'scenario-engine',
        review_status: 'auto_approved',
      },
      `scenario: ${question.slice(0, 60)}`
    );
    return path;
  } catch (err) {
    console.warn('[scenario-engine] KB write failed:', (err as Error).message);
    return null;
  }
}

export function listScenarios(businessId: string, limit = 50): Record<string, unknown>[] {
  const rows = db.prepare(`
    SELECT * FROM scenarios WHERE business_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(businessId, limit) as Record<string, unknown>[];
  return rows.map(parseScenarioRow).filter(Boolean) as Record<string, unknown>[];
}

export function getScenario(id: string, businessId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ? AND business_id = ?').get(id, businessId) as Record<string, unknown> | null;
  return row ? parseScenarioRow(row) : null;
}

function parseScenarioRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  let scenarios: Record<string, unknown>[] = [];
  let criteria: string[] = [];
  try { scenarios = JSON.parse(row.scenarios_json as string); } catch {}
  try { criteria = JSON.parse((row.decision_criteria as string) || '[]'); } catch {}
  return { ...row, scenarios, decision_criteria: criteria };
}
