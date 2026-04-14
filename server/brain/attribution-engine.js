/**
 * Brain — Attribution Engine (Feature 4).
 *
 * Runs a full attribution analysis on a newly created signal so the user
 * can see: known cause in measurement window? seasonal? industry event?
 * truly unknown? — and get a clear act/wait/monitor/ignore recommendation.
 */
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { isWithinSeasonalVariation } from './seasonality.js';

const SYSTEM_PROMPT = `You assess why a metric changed and produce a probability-weighted attribution.

Rules:
- Probabilities across candidate causes must sum to 1.0 (include "unknown" as catch-all).
- Be honest about uncertainty. If evidence is thin, say so and keep the primary_confidence low.
- Only recommend act_now when evidence is clear AND the measurement window is closed.
- If a known action is still in its window, recommend wait.
- If change is plausibly seasonal, recommend ignore.

Return only valid JSON. No prose outside JSON.

Schema:
{
  "attribution": [
    { "cause": "name", "category": "known_action|seasonal|external|correlated_metric|unknown",
      "probability": 0.0-1.0, "reasoning": "why" }
  ],
  "primary_cause": "the most likely cause",
  "primary_confidence": 0.0-1.0,
  "recommendation": "act_now|wait|monitor|investigate|ignore",
  "recommended_action": "concrete next step or null",
  "do_not_act_until": "YYYY-MM-DD or null",
  "plain_english": "2-3 sentence explanation"
}`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

/**
 * Gather raw evidence for a signal's metric change.
 */
function gatherEvidence(signal, businessId) {
  const data = typeof signal.data === 'string' ? (() => { try { return JSON.parse(signal.data); } catch { return {}; } })() : (signal.data || {});
  const metricName = data.metric_name ?? data.metric ?? null;
  const changePct = data.change_pct ?? data.pct_change ?? null;
  const currentValue = data.current_value ?? data.value ?? null;
  const previousValue = data.previous_value ?? data.baseline ?? null;

  // Known actions in flight that affect this metric
  let candidates = [];
  if (metricName) {
    candidates = db.prepare(`
      SELECT am.*, aw.min_days, aw.expected_days, aw.display_name
      FROM action_memory am
      JOIN action_windows aw ON aw.action_type = am.action_type
      WHERE am.business_id = ?
        AND am.outcome_measured = 0
        AND am.measurement_window_start > datetime('now', '-120 days')
        AND EXISTS (SELECT 1 FROM json_each(am.metrics_expected) me WHERE me.value = ?)
      ORDER BY am.measurement_window_start DESC LIMIT 10
    `).all(businessId, metricName);
  }

  // Correlated metrics — did others move in the same timeframe?
  let correlated = [];
  if (metricName) {
    const others = db.prepare(`
      SELECT metric_name, metric_value, recorded_at FROM metrics
      WHERE business_id = ? AND metric_name != ? AND metric_value IS NOT NULL
        AND recorded_at > datetime('now', '-14 days')
      GROUP BY metric_name ORDER BY recorded_at DESC LIMIT 15
    `).all(businessId, metricName);
    correlated = others;
  }

  // Seasonal check
  let seasonal = { within_seasonal: false };
  if (metricName && changePct != null) {
    try {
      const within = isWithinSeasonalVariation(metricName, Number(changePct), businessId);
      seasonal = { within_seasonal: !!within };
    } catch {}
  }

  return { metricName, changePct, currentValue, previousValue, candidates, correlated, seasonal };
}

function buildPrompt(signal, evidence) {
  const lines = [];
  lines.push(`Signal: "${signal.title}"`);
  lines.push(`Description: ${signal.description ?? '(none)'}`);
  lines.push(`Type/severity: ${signal.type}/${signal.severity}`);
  if (evidence.metricName) lines.push(`Metric: ${evidence.metricName}`);
  if (evidence.changePct != null) lines.push(`Change: ${evidence.changePct > 0 ? '+' : ''}${Number(evidence.changePct).toFixed(1)}%`);
  if (evidence.currentValue != null) lines.push(`Current: ${evidence.currentValue}, previous: ${evidence.previousValue ?? '?'}`);
  lines.push('');
  lines.push(`KNOWN ACTIONS AFFECTING THIS METRIC (${evidence.candidates.length}):`);
  for (const c of evidence.candidates) {
    const daysSince = Math.ceil((Date.now() - new Date(c.measurement_window_start)) / 86400000);
    const inWindow = daysSince >= c.min_days && daysSince <= c.expected_days * 1.5;
    lines.push(`- "${c.title}" (${c.action_type}), ${daysSince}d ago, window ${c.min_days}-${c.expected_days}d, ${inWindow ? 'IN WINDOW' : 'out of window'}`);
  }
  lines.push('');
  lines.push(`SEASONAL CHECK: ${evidence.seasonal.within_seasonal ? 'Change is within expected seasonal variation for this day' : 'Not explained by seasonal pattern'}`);
  lines.push('');
  lines.push(`CORRELATED METRICS SAMPLE:`);
  for (const m of evidence.correlated.slice(0, 8)) {
    lines.push(`- ${m.metric_name}: ${m.metric_value}`);
  }
  lines.push('');
  lines.push('Produce the attribution JSON per the schema.');
  return lines.join('\n');
}

/**
 * Analyse a signal and store attribution directly on the signals row.
 */
export async function analyseAndStoreSignalAttribution(signalId) {
  const signal = db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId);
  if (!signal) return null;
  return analyseAndStore(signal);
}

export async function analyseAndStore(signal) {
  try {
    const evidence = gatherEvidence(signal, signal.business_id);
    const prompt = buildPrompt(signal, evidence);

    const { providerId, model } = resolveProfileLLM({}, { tier: 'triage' });

    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2, max_tokens: 1200,
    });
    const parsed = extractJSON(result?.content ?? '');
    if (!parsed) return null;

    const doNotAct = parsed.do_not_act_until || null;
    db.prepare(`
      UPDATE signals
      SET attribution_analysis = ?,
          attribution_recommendation = ?,
          attribution_primary_cause = ?,
          attribution_primary_confidence = ?,
          do_not_act_until = ?
      WHERE id = ?
    `).run(
      JSON.stringify(parsed),
      parsed.recommendation ?? null,
      parsed.primary_cause ?? null,
      parsed.primary_confidence ?? null,
      doNotAct,
      signal.id
    );
    return parsed;
  } catch (err) {
    console.warn('[attribution] analyse failed:', err.message);
    return null;
  }
}
