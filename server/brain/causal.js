/**
 * Brain — Causal reasoning.
 *
 * When a metric changes, checks whether a recent action plausibly caused
 * it. Returns an assessment that signal-engine uses to either suppress
 * the signal (if the change is attributable to a known in-flight action)
 * or enrich it with causal context.
 */
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const PROMPT_SYSTEM = `You assess causal links between a metric change and
recent business actions. Be conservative about claiming causation.
Return only valid JSON. No prose outside JSON.

Shape:
{
  "likely_cause": "action title or null",
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentences explaining the causal assessment",
  "recommendation": "wait_for_more_data | attribute_to_action | investigate_further | likely_unrelated",
  "do_not_change": true|false,
  "do_not_change_reason": "why agents should not re-act yet"
}`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

/**
 * Assess whether a metric change was likely caused by a recent known action.
 *
 * @param {string} metricName   e.g. 'gsc.avg_ctr'
 * @param {number} currentValue
 * @param {number} previousValue
 * @param {string} businessId
 * @returns {Promise<object>}   assessment
 */
export async function analyseMetricChange(metricName, currentValue, previousValue, businessId) {
  const result = { has_candidate_cause: false, recommendation: 'investigate' };
  if (previousValue == null || currentValue == null) return result;
  if (previousValue === 0) return result;

  const changePct = ((currentValue - previousValue) / Math.abs(previousValue)) * 100;

  // Find recent actions that affect this metric
  const recentActions = db.prepare(`
    SELECT am.*, aw.min_days, aw.expected_days, aw.volatility, aw.measurement_notes
    FROM action_memory am
    JOIN action_windows aw ON aw.action_type = am.action_type
    WHERE am.business_id = ?
      AND am.outcome_measured = 0
      AND am.measurement_window_start > datetime('now', '-120 days')
      AND EXISTS (
        SELECT 1 FROM json_each(am.metrics_expected) me WHERE me.value = ?
      )
    ORDER BY am.measurement_window_start DESC
    LIMIT 10
  `).all(businessId, metricName);

  if (recentActions.length === 0) return result;

  // Filter to those in their expected timing window
  const candidates = [];
  for (const action of recentActions) {
    const daysSince = Math.ceil((Date.now() - new Date(action.measurement_window_start)) / 86400000);
    if (daysSince >= action.min_days && daysSince <= action.expected_days * 1.5) {
      candidates.push({
        action,
        days_since: daysSince,
        timing_match: 'good',
        direction_match: changePct > 0 ? 'improvement' : 'decline',
      });
    }
  }

  if (candidates.length === 0) {
    return { ...result, has_candidate_cause: false, change_pct: changePct };
  }

  // Ask the LLM for a causal reasoning pass
  const assessment = await reason(metricName, changePct, candidates);
  return { ...assessment, has_candidate_cause: true, change_pct: changePct, candidates: candidates.length };
}

async function reason(metric, changePct, candidates) {
  const userMessage = `A business metric changed. Assess causation.

Metric: ${metric}
Change: ${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%

Candidate causes (recent actions in expected windows):
${candidates.map((c) => `- ${c.action.title} (${c.action.action_type}), taken ${c.days_since} days ago. Window: ${c.action.min_days}–${c.action.expected_days} days. Notes: ${c.action.measurement_notes ?? ''}`).join('\n')}

Consider: timing match, direction match, other plausible explanations (seasonal, algorithm update).
Be conservative — only claim a likely_cause with confidence >= 0.7.`;

  const { providerId, model } = resolveProfileLLM({
    provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
  });

  try {
    const result = await runLLM(providerId, model, {
      system: PROMPT_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.2,
      max_tokens: 800,
    });
    const parsed = extractJSON(result?.content ?? '');
    if (!parsed) return { recommendation: 'investigate' };
    return parsed;
  } catch (err) {
    console.warn('[brain] causal LLM failed:', err.message);
    // Fallback — if there's any candidate and timing matches, default to wait
    return {
      recommendation: 'wait_for_more_data',
      confidence: 0.6,
      do_not_change: true,
      do_not_change_reason: `A recent action "${candidates[0].action.title}" is within its expected window — its effect may not yet be measurable.`,
      likely_cause: candidates[0].action.title,
    };
  }
}
