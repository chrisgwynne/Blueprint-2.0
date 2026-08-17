/**
 * Hiring reasoning — the LLM step, plus what happens when it fails.
 *
 * #47: the old fallback recommended EVERY eligible candidate at a flat
 * confidence of 0.75 the moment reasoning failed. A provider quota error
 * therefore produced MORE hires than a successful analysis, each carrying an
 * ordinary-looking confidence that downstream code could not distinguish from
 * a real judgement. The default on reasoning failure is now NO proposals.
 * A deterministic fallback exists but is gated: it requires an explicit
 * policy opt-in, a hard evidence rule (an unmet capability backed by fresh
 * data AND a linked goal or material signal), a bounded count, a conservative
 * confidence ceiling, and it marks every recommendation as degraded so
 * notifications can say reasoning was unavailable.
 *
 * #52: provider failures are classified, bounded and terminal. Only 429/5xx
 * are retried, at most `maxAttempts` times, honouring Retry-After up to a cap.
 * Errors are sanitized (no keys, no raw provider bodies) before they are
 * persisted or surfaced.
 */

import { classifyProviderError, isProviderErrorLike, safeErrorMessage } from '../../lib/provider-errors.js';
import { runLLM, resolveProfileLLM } from '../../lib/llm-providers.js';
import type { ConnectorEvidence, GatedCandidate, HireRecommendation } from './types.js';

/** Never wait longer than this for a Retry-After, even if the provider asks. */
const MAX_RETRY_DELAY_MS = 5_000;
/** Confidence ceiling for anything not produced by live reasoning. */
export const DEGRADED_CONFIDENCE_CEILING = 0.5;
/** At most this many proposals may come from the deterministic fallback. */
export const MAX_DETERMINISTIC_FALLBACK = 1;

export interface ReasoningOutcome {
  status: 'ok' | 'failed';
  recommendations: HireRecommendation[];
  provider: string | null;
  model: string | null;
  attempts: number;
  provider_status: string | null;
  provider_http_status: number | null;
  provider_retryable: boolean | null;
  error: string | null;
  cost_usd: number;
  usage: unknown;
  raw_unparseable: boolean;
}

export interface ReasoningInput {
  businessName: string | null;
  businessType: string | null;
  connectors: ConnectorEvidence[];
  candidates: GatedCandidate[];
  /** Bounded prior-decision context (#50) — what a human already said no to. */
  priorDecisions: Array<{ template_id: string; decision: string; reason: string | null; decided_at: string; disposition: string }>;
  /** Bounded measured-outcome context (#56). */
  priorOutcomes: Array<{ template_id: string; verdict: string; reason: string | null }>;
  maxAttempts: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests — defaults to the real provider call. */
  runLLMFn?: typeof runLLM;
  /**
   * Pin the provider/model instead of resolving it from settings. Used by the
   * hiring test suite so no provider credential is ever required or read.
   */
  provider?: string;
  model?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function extractJSON(text: string): { recommendations: HireRecommendation[] } | null {
  if (!text) return null;
  const trimmed = String(text).trim();
  const attempt = (s: string) => {
    try { return JSON.parse(s) as { recommendations: HireRecommendation[] }; } catch { return null; }
  };
  const direct = attempt(trimmed);
  if (direct) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = attempt((fenced[1] ?? '').trim());
    if (parsed) return parsed;
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return attempt(trimmed.slice(first, last + 1));
  return null;
}

export function buildPrompt(input: ReasoningInput): { system: string; user: string } {
  const system = `You are Blueprint's Conductor agent. You coordinate specialist AI agents.
Your job right now is to decide which specialist agents are worth hiring, given
this business's connected data, its active goals and open signals, and the
hiring decisions its operator has already made.

Rules:
- Only recommend an agent where the AVAILABLE, FRESH data makes it genuinely useful.
- Do NOT recommend agents speculatively, "just in case", or to look busy.
- If you have no good reason, recommend nothing. Recommending nothing is a valid,
  frequently correct answer.
- A role the operator previously rejected must NOT be recommended again unless the
  evidence listed below has materially changed since that rejection — and if you do
  recommend it, your reason must state exactly what is new.
- A role whose previous trial was measured as unsuccessful or produced no evidence
  must NOT be recommended again.
- Higher confidence = more obvious fit. 0.9+ means "definitely needed".
- 'immediate' priority = should run today. 'suggested' = useful but not urgent.
- 'optional' = nice to have but not critical.

Output JSON only, no prose outside the JSON.`;

  const connectorLines = input.connectors.map((c) => {
    const age = c.age_hours == null ? 'never synced' : `last synced ${c.age_hours.toFixed(1)}h ago`;
    return `- ${c.type}${c.name && c.name !== c.type ? ` (${c.name})` : ''} — ${age}${c.fresh ? '' : ' [STALE]'}`;
  }).join('\n') || '- (none)';

  const candidateLines = input.candidates.map((c) => `
  id: ${c.id}
  name: ${c.name}
  title: ${c.title ?? '—'}
  required connectors: ${c.required.join(', ') || 'none'} (fresh: ${c.evidence.fresh_connectors.join(', ') || 'none'})
  optional connectors: ${c.preferred.join(', ') || 'none'} (${c.preferred_met.length}/${c.preferred.length} currently connected)
  linked goal: ${c.evidence.linked_goal_title ?? 'none'}
  open signals in its data area: ${c.evidence.linked_signal_ids.length}
  unmet capability it would cover: ${c.evidence.unmet_capability ?? 'none'}
  prior trials here: ${c.evidence.prior_trials} (successful: ${c.evidence.prior_success}, unsuccessful: ${c.evidence.prior_unsuccessful})
  estimated ROI score: ${c.evidence.roi_score == null ? 'n/a' : c.evidence.roi_score.toFixed(2)}
  role: ${(c.personality ?? '').split('\n')[0]?.slice(0, 240) ?? ''}`).join('\n');

  const decisionLines = input.priorDecisions.length
    ? input.priorDecisions.map((d) =>
        `- ${d.template_id}: ${d.decision} (${d.disposition}) on ${d.decided_at}${d.reason ? ` — "${d.reason.slice(0, 160)}"` : ''}`).join('\n')
    : '- (none)';

  const outcomeLines = input.priorOutcomes.length
    ? input.priorOutcomes.map((o) =>
        `- ${o.template_id}: trial verdict ${o.verdict}${o.reason ? ` — ${o.reason.slice(0, 160)}` : ''}`).join('\n')
    : '- (none)';

  const user = `Business: ${input.businessName ?? '(unnamed)'} (type: ${input.businessType ?? 'unknown'})

Active data connectors:
${connectorLines}

Hiring decisions this operator already made (do not contradict these without new evidence):
${decisionLines}

Measured outcomes of previous hires for this business:
${outcomeLines}

Agents available to hire:
${candidateLines}

Return JSON in this shape:
{
  "recommendations": [
    {
      "agent_id": "string (from ids above)",
      "reason": "1-2 sentence explanation tied to the connected data and, where relevant, what changed since a prior rejection",
      "expected_value": "what concretely this agent will do with the available data",
      "confidence": 0.0-1.0,
      "priority": "immediate" | "suggested" | "optional"
    }
  ]
}

If no agents are worth hiring right now, return { "recommendations": [] }.`;

  return { system, user };
}

/**
 * Run the reasoning step. NEVER throws — a provider failure is a structured
 * terminal outcome, because one business's quota error must not propagate
 * out and abort the scheduler sweep for every other business (#52).
 */
export async function reasonAboutHires(input: ReasoningInput): Promise<ReasoningOutcome> {
  const sleep = input.sleep ?? defaultSleep;
  const call = input.runLLMFn ?? runLLM;

  let providerId = input.provider ?? 'unknown';
  let model = input.model ?? 'unknown';
  if (!input.provider || !input.model) {
    try {
      const resolved = resolveProfileLLM({}, { tier: 'triage' });
      providerId = input.provider ?? resolved.providerId;
      model = input.model ?? resolved.model;
    } catch (err) {
      // No usable provider configuration is a terminal, non-retryable
      // failure — and, per #47, produces no proposals.
      return {
        status: 'failed', recommendations: [], provider: null, model: null, attempts: 0,
        provider_status: 'unconfigured', provider_http_status: null, provider_retryable: false,
        error: safeErrorMessage(err), cost_usd: 0, usage: null, raw_unparseable: false,
      };
    }
  }

  const { system, user } = buildPrompt(input);
  const maxAttempts = Math.max(1, Math.min(5, input.maxAttempts));

  let attempts = 0;
  let lastError: unknown = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const resp = await call(providerId, model, {
        system, messages: [{ role: 'user', content: user }],
        temperature: 0.2, max_tokens: 1024,
      });
      const parsed = extractJSON(resp?.content ?? '');
      if (!parsed || !Array.isArray(parsed.recommendations)) {
        // A malformed response is NOT retryable — retrying a deterministic
        // parse failure just burns quota.
        return {
          status: 'failed', recommendations: [], provider: providerId, model, attempts,
          provider_status: 'unparseable_response', provider_http_status: null, provider_retryable: false,
          error: 'Reasoning response did not contain a recommendations array.',
          cost_usd: resp?.cost_usd ?? 0, usage: resp?.usage ?? null, raw_unparseable: true,
        };
      }
      return {
        status: 'ok',
        recommendations: parsed.recommendations
          .filter((r) => r && typeof r.agent_id === 'string')
          .map((r) => ({ ...r, provenance: 'llm' as const, degraded: false })),
        provider: providerId, model, attempts,
        provider_status: 'ok', provider_http_status: null, provider_retryable: null,
        error: null, cost_usd: resp?.cost_usd ?? 0, usage: resp?.usage ?? null, raw_unparseable: false,
      };
    } catch (err) {
      lastError = err;
      const classified = isProviderErrorLike(err)
        ? classifyProviderError(err, providerId)
        : null;
      const retryable = classified?.retryable === true;
      if (!retryable || attempts >= maxAttempts) {
        return {
          status: 'failed', recommendations: [], provider: classified?.provider ?? providerId, model, attempts,
          provider_status: classified?.terminalReason ?? 'non_provider_error',
          provider_http_status: classified?.status ?? null,
          provider_retryable: classified?.retryable ?? false,
          error: safeErrorMessage(err, providerId),
          cost_usd: 0, usage: null, raw_unparseable: false,
        };
      }
      const delay = Math.min(MAX_RETRY_DELAY_MS, classified?.retryAfterMs ?? Math.min(1000 * attempts, MAX_RETRY_DELAY_MS));
      await sleep(delay);
    }
  }

  const classified = isProviderErrorLike(lastError) ? classifyProviderError(lastError, providerId) : null;
  return {
    status: 'failed', recommendations: [], provider: providerId, model, attempts,
    provider_status: classified?.terminalReason ?? 'retries_exhausted',
    provider_http_status: classified?.status ?? null,
    provider_retryable: classified?.retryable ?? true,
    error: safeErrorMessage(lastError, providerId),
    cost_usd: 0, usage: null, raw_unparseable: false,
  };
}

/**
 * The ONLY deterministic path from a reasoning failure to a recommendation.
 *
 * Disabled unless `allowFallback` is explicitly true. Even then it requires a
 * hard evidence rule — an unmet capability, fresh data covering every
 * requirement, and a linked goal or material signal — caps the count at
 * MAX_DETERMINISTIC_FALLBACK, caps confidence at DEGRADED_CONFIDENCE_CEILING,
 * and marks every result as degraded with `manual_review` provenance so no
 * downstream consumer can mistake it for a judgement.
 */
export function deterministicFallback(
  candidates: GatedCandidate[],
  allowFallback: boolean,
): HireRecommendation[] {
  if (!allowFallback) return [];
  const qualifying = candidates.filter((c) =>
    c.admitted
    && !!c.evidence.unmet_capability
    && c.evidence.stale_connectors.length === 0
    && c.evidence.fresh_connectors.length >= c.required.length
    && (!!c.evidence.linked_goal_id || c.evidence.linked_signal_ids.length > 0)
    && c.evidence.prior_unsuccessful === 0
    && (c.evidence.roi_score ?? 0) >= 0.5
  );
  return qualifying
    .sort((a, b) => (b.evidence.roi_score ?? 0) - (a.evidence.roi_score ?? 0))
    .slice(0, MAX_DETERMINISTIC_FALLBACK)
    .map((c) => ({
      agent_id: c.id,
      reason:
        `DEGRADED — Conductor's reasoning was unavailable for this analysis. This is a rule-based `
        + `suggestion only: ${c.evidence.unmet_capability} data is connected and fresh, no hired agent covers it, `
        + `and it is linked to ${c.evidence.linked_goal_title ? `the goal "${c.evidence.linked_goal_title}"` : `${c.evidence.linked_signal_ids.length} open signal(s)`}. `
        + `Review manually before approving.`,
      expected_value: c.evidence.expected_impact ?? `Coverage for ${c.evidence.unmet_capability}.`,
      confidence: DEGRADED_CONFIDENCE_CEILING,
      priority: 'optional' as const,
      degraded: true,
      provenance: 'manual_review' as const,
    }));
}
