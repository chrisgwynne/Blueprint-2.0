/**
 * Conductor-led agent hiring.
 *
 * Runs after a connector sync completes (or during onboarding) to decide
 * which specialist agents are now worth hiring given the active data
 * connectors. Emits one 'hire_agent' task per recommendation (human-approved
 * at trust_tier yellow).
 *
 * Two phases:
 *   1. Mechanical filter — uninstalled templates whose required_connectors
 *      are all satisfied by active connectors for this business.
 *   2. LLM reasoning — Conductor ranks candidates, explains what each will
 *      do with the available data, assigns confidence + priority.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import db from '../db/db.js';
import { createTask } from '../tasks/task-queue.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, 'templates');

interface AgentProfile {
  id?: string;
  name?: string;
  title?: string;
  avatar?: string;
  personality?: string;
  status?: string;
  required_connectors?: string[];
  connectors_required?: string[];
  preferred_connectors?: string[];
  connectors_optional?: string[];
  [key: string]: unknown;
}

interface ConnectorRow {
  type: string;
  name?: string;
}

interface AgentIdRow {
  id: string;
}

interface HireTaskRow {
  action_payload: string;
}

interface BusinessRow {
  id?: string;
  name?: string;
  type?: string;
}

interface Candidate {
  id: string;
  name: string;
  title: string | null;
  avatar: string | null;
  personality: string | null;
  required: string[];
  preferred: string[];
  preferred_met: string[];
}

interface HireRecommendation {
  agent_id: string;
  reason: string;
  expected_value?: string;
  confidence?: number;
  priority?: 'immediate' | 'suggested' | 'optional';
}

interface EnrichedRecommendation extends HireRecommendation {
  name: string;
  title: string | null;
  avatar: string | null;
  required_connectors: string[];
  preferred_connectors: string[];
  preferred_met: string[];
}

interface LLMRecommendationsResponse {
  recommendations: HireRecommendation[];
}

// Safe parse fallback, shared across files.
function safeJSONParse<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function extractConnectorSpec(profile: AgentProfile): { required: string[]; preferred: string[] } {
  const required = profile?.required_connectors ?? profile?.connectors_required ?? [];
  const preferred = profile?.preferred_connectors ?? profile?.connectors_optional ?? [];
  return {
    required: Array.isArray(required) ? required : [],
    preferred: Array.isArray(preferred) ? preferred : [],
  };
}

function loadAllTemplates(): Array<{ id: string; profile: AgentProfile }> {
  if (!existsSync(TEMPLATES_DIR)) return [];
  const out: Array<{ id: string; profile: AgentProfile }> = [];
  for (const e of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const profilePath = join(TEMPLATES_DIR, e.name, 'profile.yaml');
    if (!existsSync(profilePath)) continue;
    try {
      const profile = (yaml.load(readFileSync(profilePath, 'utf8')) ?? {}) as AgentProfile;
      out.push({ id: e.name, profile });
    } catch {}
  }
  return out;
}

function extractJSONFromLLM(text: string): LLMRecommendationsResponse | null {
  if (!text) return null;
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed) as LLMRecommendationsResponse; } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse((fenced[1] ?? '').trim()) as LLMRecommendationsResponse; } catch {} }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)) as LLMRecommendationsResponse; } catch {}
  }
  return null;
}

/**
 * Run a hiring analysis for a single business. Returns the number of hire
 * proposals created plus the full recommendations list.
 *
 * @param businessId
 * @param opts
 * @param opts.dryRun  — when true, skip creating hire_agent tasks. Used by
 *   the onboarding preview flow which renders recommendations inline and lets
 *   the user hire directly, bypassing the task queue.
 */
export async function analyseAndProposeHires(
  businessId: string,
  opts: { dryRun?: boolean } = {}
): Promise<{ proposed_hires: number; recommendations: EnrichedRecommendation[]; reason: string | null }> {
  const { dryRun = false } = opts;
  if (!businessId) throw new Error('businessId required');

  // 1. Active connectors for this business
  const activeConnectors = db.prepare(
    `SELECT type, name FROM connectors
     WHERE business_id = ? AND status = 'connected'`
  ).all(businessId) as ConnectorRow[];
  const activeTypes = new Set(activeConnectors.map((c) => c.type));

  if (activeTypes.size === 0) {
    return { proposed_hires: 0, recommendations: [], reason: 'no_active_connectors' };
  }

  // 2. Currently installed agents (including pending/retired — we don't want
  //    to double-hire or re-propose a retired one without human reset)
  const installed = new Set(
    (db.prepare(`SELECT id FROM agents`).all() as AgentIdRow[]).map((r) => r.id)
  );

  // 3. Templates not yet installed whose required connectors are all live
  const templates = loadAllTemplates();
  const candidates: Candidate[] = [];
  for (const { id, profile } of templates) {
    if (installed.has(id)) continue;
    if (id === 'conductor') continue; // always installed
    const { required, preferred } = extractConnectorSpec(profile);
    const requiredMet = required.every((t) => activeTypes.has(t));
    if (!requiredMet) continue;
    candidates.push({
      id,
      name: profile.name ?? id,
      title: profile.title ?? null,
      avatar: profile.avatar ?? null,
      personality: profile.personality ?? null,
      required,
      preferred,
      preferred_met: preferred.filter((t) => activeTypes.has(t)),
    });
  }

  if (candidates.length === 0) {
    return { proposed_hires: 0, recommendations: [], reason: 'no_candidates' };
  }

  // 4. Check for existing open 'hire_agent' tasks — don't duplicate proposals
  const openHireTasks = db.prepare(
    `SELECT action_payload FROM tasks
     WHERE business_id = ? AND action_type = 'hire_agent' AND status IN ('proposed', 'approved')`
  ).all(businessId) as HireTaskRow[];
  const alreadyProposed = new Set<string>();
  for (const t of openHireTasks) {
    const payload = safeJSONParse<{ template_id?: string }>(t.action_payload, {});
    if (payload?.template_id) alreadyProposed.add(payload.template_id);
  }
  const toReview = candidates.filter((c) => !alreadyProposed.has(c.id));
  if (toReview.length === 0) {
    return { proposed_hires: 0, recommendations: [], reason: 'all_already_proposed' };
  }

  // 5. Ask Conductor to reason about which are worth hiring
  let recommendations: HireRecommendation[];
  try {
    recommendations = await reasonAboutHires(businessId, activeConnectors, toReview);
  } catch (err) {
    console.warn('[hiring] LLM reasoning failed, falling back to mechanical recs:', (err as Error).message);
    recommendations = toReview.map((c) => ({
      agent_id: c.id,
      reason: `Required connector${c.required.length !== 1 ? 's' : ''} (${c.required.join(', ') || 'none'}) are active. This agent specialises in ${c.title ?? c.name}.`,
      expected_value: `Adds specialist analysis for ${c.required.join(' + ') || c.name}.`,
      confidence: 0.75,
      priority: 'suggested' as const,
    }));
  }

  // 6. Enrich recommendations with candidate metadata so callers (incl. the
  //    onboarding preview) can render the agent's required/preferred
  //    connectors alongside Conductor's reasoning.
  const enriched: EnrichedRecommendation[] = recommendations.map((r) => {
    const candidate = candidates.find((c) => c.id === r.agent_id);
    return {
      ...r,
      name: candidate?.name ?? r.agent_id,
      title: candidate?.title ?? null,
      avatar: candidate?.avatar ?? null,
      required_connectors: candidate?.required ?? [],
      preferred_connectors: candidate?.preferred ?? [],
      preferred_met: candidate?.preferred_met ?? [],
    };
  });

  // 7. Dry run — caller handles hiring directly (onboarding preview flow).
  if (dryRun) {
    return { proposed_hires: 0, recommendations: enriched, reason: 'dry_run' };
  }

  // 8. Create a hire_agent task for each high-confidence recommendation
  let proposed = 0;
  for (const r of recommendations) {
    if (!r.agent_id || (r.confidence ?? 0) < 0.7) continue;
    if (alreadyProposed.has(r.agent_id)) continue;
    const candidate = candidates.find((c) => c.id === r.agent_id);
    if (!candidate) continue;

    try {
      createTask({
        business_id: businessId,
        title: `Hire ${candidate.name} agent`,
        description: [
          r.reason,
          r.expected_value ? `\nExpected value: ${r.expected_value}` : '',
          `\nRequired connectors: ${candidate.required.join(', ') || 'none'}`,
          candidate.preferred.length > 0
            ? `\nOptional connectors ${candidate.preferred_met.length === candidate.preferred.length ? '(all connected)' : `(${candidate.preferred_met.length}/${candidate.preferred.length} connected)`}: ${candidate.preferred.join(', ')}`
            : '',
        ].filter(Boolean).join(''),
        proposed_by: 'conductor',
        action_type: 'hire_agent',
        action_payload: { template_id: candidate.id },
        trust_tier: 'yellow',
        priority: r.priority === 'immediate' ? 'p1' : r.priority === 'optional' ? 'p3' : 'p2',
        confidence: r.confidence,
        estimated_impact: r.expected_value ?? null,
        approval_mode: 'requires_approval',
      });
      proposed++;
    } catch (err) {
      console.warn(`[hiring] failed to create hire task for ${candidate.id}:`, (err as Error).message);
    }
  }

  return { proposed_hires: proposed, recommendations: enriched, reason: null };
}

async function reasonAboutHires(
  businessId: string,
  activeConnectors: ConnectorRow[],
  candidates: Candidate[]
): Promise<HireRecommendation[]> {
  const { providerId, model } = resolveProfileLLM({}, { tier: 'triage' });

  const biz = db.prepare('SELECT name, type FROM businesses WHERE id = ?').get(businessId) as BusinessRow | null;

  const system = `You are Blueprint's Conductor agent. You coordinate specialist AI agents.
Your job right now is to decide which specialist agents are worth hiring based
on what data connectors this business has connected.

Rules:
- Only recommend agents where the available data makes them genuinely useful.
- Do NOT recommend agents speculatively, "just in case", or to look busy.
- If you have no good reason, recommend nothing.
- Higher confidence = more obvious fit. 0.9+ means "definitely needed".
- 'immediate' priority = should run today. 'suggested' = useful but not urgent.
- 'optional' = nice to have but not critical.

Output JSON only, no prose outside the JSON.`;

  const user = `Business: ${biz?.name ?? '(unnamed)'} (type: ${biz?.type ?? 'unknown'})

Active data connectors:
${activeConnectors.map((c) => `- ${c.type}${c.name && c.name !== c.type ? ` (${c.name})` : ''}`).join('\n')}

Agents available to hire:
${candidates.map((c) => `
  id: ${c.id}
  name: ${c.name}
  title: ${c.title ?? '—'}
  required connectors: ${c.required.join(', ') || 'none'}
  optional connectors: ${c.preferred.join(', ') || 'none'} (${c.preferred_met.length}/${c.preferred.length} currently connected)
  role: ${(c.personality ?? '').split('\n')[0]?.slice(0, 240) ?? ''}
`).join('\n')}

Return JSON in this shape:
{
  "recommendations": [
    {
      "agent_id": "string (from ids above)",
      "reason": "1-2 sentence explanation tied to the connected data",
      "expected_value": "what concretely this agent will do with the available data",
      "confidence": 0.0-1.0,
      "priority": "immediate" | "suggested" | "optional"
    }
  ]
}

If no agents are worth hiring right now, return { "recommendations": [] }.`;

  const startedAt = new Date().toISOString();
  const { recordAgentActivity } = await import('./activity.js') as unknown as {
    recordAgentActivity: (opts: {
      agentId: string;
      businessId: string;
      trigger: string;
      status: string;
      reasoning: string;
      error?: string;
      usage?: unknown;
      cost_usd?: number;
      startedAt: string;
    }) => void;
  };
  let resp: { content: string; usage?: unknown; cost_usd?: number } | undefined;
  try {
    resp = await runLLM(providerId, model, {
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      max_tokens: 1024,
    });
  } catch (err) {
    recordAgentActivity({
      agentId: 'conductor', businessId, trigger: 'hiring_analysis',
      status: 'failed', reasoning: 'Hiring analysis failed',
      error: (err as Error).message.slice(0, 500), startedAt,
    });
    throw err;
  }

  const parsed = extractJSONFromLLM(resp?.content ?? '');
  if (!parsed || !Array.isArray(parsed.recommendations)) {
    recordAgentActivity({
      agentId: 'conductor', businessId, trigger: 'hiring_analysis',
      status: 'failed', reasoning: 'Hiring analysis — unparseable response',
      usage: resp?.usage, cost_usd: resp?.cost_usd, startedAt,
    });
    throw new Error('LLM response missing recommendations array');
  }

  recordAgentActivity({
    agentId: 'conductor', businessId, trigger: 'hiring_analysis',
    status: 'complete',
    reasoning: `Hiring analysis: considered ${candidates.length} agent${candidates.length === 1 ? '' : 's'}, recommended ${parsed.recommendations.length}`,
    usage: resp?.usage, cost_usd: resp?.cost_usd, startedAt,
  });
  return parsed.recommendations;
}
