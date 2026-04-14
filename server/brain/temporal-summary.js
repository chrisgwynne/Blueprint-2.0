/**
 * Brain — Temporal summary.
 *
 * Produces a human-readable status of in-flight actions, what's ready
 * to measure, and what needs patience. Included in Reporter email
 * briefings and the /health brain status panel.
 */
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

export function getTemporalState(businessId) {
  const inFlight = db.prepare(`
    SELECT am.*, aw.expected_days, aw.volatility, aw.display_name
    FROM action_memory am
    LEFT JOIN action_windows aw ON aw.action_type = am.action_type
    WHERE am.business_id = ? AND am.outcome_measured = 0
    ORDER BY am.measurement_window_start ASC
  `).all(businessId);

  const now = Date.now();
  const readyForMeasurement = inFlight.filter((a) => new Date(a.measurement_window_end) < new Date());
  const stillWaiting = inFlight.filter((a) => new Date(a.measurement_window_end) >= new Date());

  return {
    in_flight: inFlight,
    ready_for_measurement: readyForMeasurement,
    still_waiting: stillWaiting.map((a) => ({
      ...a,
      days_until_measurable: Math.ceil((new Date(a.do_not_touch_until) - now) / 86400000),
      days_until_window_close: Math.ceil((new Date(a.measurement_window_end) - now) / 86400000),
    })),
  };
}

export async function generateTemporalSummary(businessId) {
  const state = getTemporalState(businessId);
  if (state.in_flight.length === 0) {
    return {
      summary: 'No actions are currently in measurement windows. The system is ready to take new actions.',
      ...state,
    };
  }

  const userMessage = `Review the temporal state of this business.

READY TO MEASURE (windows have closed — outcomes should be checked):
${state.ready_for_measurement.map((a) => {
  const days = Math.ceil((Date.now() - new Date(a.measurement_window_start)) / 86400000);
  return `- ${a.title} (${a.action_type}, taken ${days}d ago)`;
}).join('\n') || 'None'}

STILL IN WINDOW (do not re-act yet):
${state.still_waiting.map((a) => `- ${a.title}: ${a.days_until_measurable} days until we can touch this area again`).join('\n') || 'None'}

Write 2-3 sentences: what should the human know about the current state of
in-flight changes? Are outcomes ready to measure? Are there areas to be
patient about? Plain text, no markdown.`;

  try {
    const { providerId, model } = resolveProfileLLM({
      model: 'claude-haiku-4-5-20251001',
    });
    const result = await runLLM(providerId, model, {
      system: 'Write a concise 2-3 sentence temporal health summary. Plain text. No JSON. No markdown.',
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.3,
      max_tokens: 250,
    });
    return { summary: (result?.content || '').trim(), ...state };
  } catch {
    // Fallback — build a deterministic summary
    const summary = [
      `${state.in_flight.length} action${state.in_flight.length === 1 ? '' : 's'} in flight.`,
      state.ready_for_measurement.length > 0
        ? `${state.ready_for_measurement.length} ready to measure.`
        : null,
      state.still_waiting.length > 0
        ? `${state.still_waiting.length} still in measurement windows — do not re-act yet.`
        : null,
    ].filter(Boolean).join(' ');
    return { summary, ...state };
  }
}
