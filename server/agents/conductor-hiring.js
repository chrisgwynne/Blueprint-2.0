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

// Safe parse fallback, shared across files.
function safeJSONParse(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function extractConnectorSpec(profile) {
  const required = profile?.required_connectors ?? profile?.connectors_required ?? [];
  const preferred = profile?.preferred_connectors ?? profile?.connectors_optional ?? [];
  return {
    required: Array.isArray(required) ? required : [],
    preferred: Array.isArray(preferred) ? preferred : [],
  };
}

function loadAllTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  const out = [];
  for (const e of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const profilePath = join(TEMPLATES_DIR, e.name, 'profile.yaml');
    if (!existsSync(profilePath)) continue;
    try {
      const profile = yaml.load(readFileSync(profilePath, 'utf8')) ?? {};
      out.push({ id: e.name, profile });
    } catch {}
  }
  return out;
}

function extractJSONFromLLM(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }
  return null;
}

/**
 * Run a hiring analysis for a single business. Returns the number of hire
 * proposals created plus the full recommendations list.
 */
export async function analyseAndProposeHires(businessId) {
  if (!businessId) throw new Error('businessId required');

  // 1. Active connectors for this business
  const activeConnectors = db.prepare(
    `SELECT type, name FROM connectors
     WHERE business_id = ? AND status = 'active'`
  ).all(businessId);
  const activeTypes = new Set(activeConnectors.map((c) => c.type));

  if (activeTypes.size === 0) {
    return { proposed_hires: 0, recommendations: [], reason: 'no_active_connectors' };
  }

  // 2. Currently installed agents (including pending/retired — we don't want
  //    to double-hire or re-propose a retired one without human reset)
  const installed = new Set(
    db.prepare(`SELECT id FROM agents`).all().map((r) => r.id)
  );

  // 3. Templates not yet installed whose required connectors are all live
  const templates = loadAllTemplates();
  const candidates = [];
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
  ).all(businessId);
  const alreadyProposed = new Set();
  for (const t of openHireTasks) {
    const payload = safeJSONParse(t.action_payload, {});
    if (payload?.template_id) alreadyProposed.add(payload.template_id);
  }
  const toReview = candidates.filter((c) => !alreadyProposed.has(c.id));
  if (toReview.length === 0) {
    return { proposed_hires: 0, recommendations: [], reason: 'all_already_proposed' };
  }

  // 5. Ask Conductor to reason about which are worth hiring
  let recommendations;
  try {
    recommendations = await reasonAboutHires(businessId, activeConnectors, toReview);
  } catch (err) {
    console.warn('[hiring] LLM reasoning failed, falling back to mechanical recs:', err.message);
    recommendations = toReview.map((c) => ({
      agent_id: c.id,
      reason: `Required connector${c.required.length !== 1 ? 's' : ''} (${c.required.join(', ') || 'none'}) are active. This agent specialises in ${c.title ?? c.name}.`,
      expected_value: `Adds specialist analysis for ${c.required.join(' + ') || c.name}.`,
      confidence: 0.75,
      priority: 'suggested',
    }));
  }

  // 6. Create a hire_agent task for each high-confidence recommendation
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
      console.warn(`[hiring] failed to create hire task for ${candidate.id}:`, err.message);
    }
  }

  return { proposed_hires: proposed, recommendations, reason: null };
}

async function reasonAboutHires(businessId, activeConnectors, candidates) {
  const { providerId, model } = resolveProfileLLM({
    provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
  });

  const biz = db.prepare('SELECT name, type FROM businesses WHERE id = ?').get(businessId);

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

  const resp = await runLLM(providerId, model, {
    system,
    messages: [{ role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 1024,
  });

  const parsed = extractJSONFromLLM(resp?.content ?? '');
  if (!parsed || !Array.isArray(parsed.recommendations)) {
    throw new Error('LLM response missing recommendations array');
  }
  return parsed.recommendations;
}
