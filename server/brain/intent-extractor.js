/**
 * Brain — Intent extraction from chat.
 *
 * Reads each human chat message, extracts goals, decisions, concerns,
 * context, and implicit tasks, and acts on them automatically.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const SYSTEM_PROMPT = `You extract business intelligence from a conversation message.

Detect any of:
- GOAL — a desired outcome with some measurability
- DECISION — something decided that affects strategy
- CONCERN — a worry about a metric or area
- CONTEXT — important upcoming information (launch, sale, event)
- TASK_IMPLICIT — something that clearly needs doing
- SCENARIO_QUESTION — a "what if" / "should we" strategic question
- INVESTIGATION_QUESTION — a "why is X happening" / "why did Y drop" question
- SIGNAL_IMPLIED — the message describes an anomaly, risk or opportunity
    that Blueprint should track as a signal (e.g. "we're seeing a lot of
    refund requests this week", "traffic just doubled overnight")
- AGENT_BRIEF_NEEDED — the user's message contains information a specific
    specialist agent should act on (e.g. "tell the content agent to focus
    on holiday keywords", "make sure the SEO agent knows we renamed the site")
- CONNECTOR_MENTION — the user mentions a data source that would help
    Blueprint but isn't currently connected (e.g. "our shipping data lives
    in ShipStation", "we use Klaviyo for email")
- NONE — normal conversation, no extractable intent

Be conservative — only extract with confidence >= 0.7.
Return only valid JSON. No prose outside JSON.

Shape:
{
  "extractions": [
    {
      "type": "goal|decision|concern|context|task_implicit|scenario_question|investigation_question|signal_implied|agent_brief_needed|connector_mention|none",
      "confidence": 0.0-1.0,
      "raw_text": "exact phrase that triggered this",
      "structured": { ... type-specific fields ... }
    }
  ]
}

Type-specific structured fields:
  goal:                   { title, metric_hint?, timeframe_hint? }
  decision:               { decision, affects?, kb_path? }
  concern:                { area, metric_to_check? }
  context:                { event, date_hint?, implications? }
  task_implicit:          { task_title, action_type?, urgency? }
  scenario_question:      { question }
  investigation_question: { question, metric_hint? }
  signal_implied:         { title, type (anomaly|opportunity|risk), severity (info|warning|alert|critical), description }
  agent_brief_needed:     { to_agent (e.g. seo-sentinel|quill|trend-spotter|merchant|ledger|outreach), brief, priority (immediate|next_run|fyi) }
  connector_mention:      { connector_name, use_case, is_mentioned_as_existing? }`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

export async function extractIntent(messageContent, conversationHistory, businessId) {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) return [];

  const activeGoals = db.prepare(
    "SELECT title FROM goals WHERE business_id = ? AND status = 'active'"
  ).all(businessId).map((g) => g.title);

  const history = (conversationHistory ?? []).slice(-5);
  const userMessage = `Business: ${business.name} (${business.type ?? 'general'})
Active goals: ${activeGoals.join('; ') || 'none'}

Latest message:
"""
${messageContent}
"""

Recent conversation:
${history.map((m) => `${m.sender_name}: ${m.content}`).join('\n') || '(none)'}

Extract any intent with confidence >= 0.7. Empty array if nothing clear.`;

  const { providerId, model } = resolveProfileLLM({
    model: 'claude-haiku-4-5-20251001',
  });

  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.1,
      max_tokens: 1024,
    });
    const parsed = extractJSON(result?.content ?? '');
    const extractions = Array.isArray(parsed?.extractions) ? parsed.extractions : [];
    return extractions.filter((e) => e && e.type && e.type !== 'none' && (e.confidence ?? 0) >= 0.7);
  } catch (err) {
    console.warn('[brain] extractIntent failed:', err.message);
    return [];
  }
}

/**
 * Execute side effects for extracted intents.
 * Returns an array of {type, message} describing what the Brain did.
 */
export async function actOnExtractions(extractions, businessId, conversationId) {
  const actions = [];

  for (const e of extractions) {
    try {
      switch (e.type) {
        case 'goal':
          actions.push(await handleGoal(e, businessId));
          break;
        case 'decision':
          actions.push(await handleDecision(e, businessId));
          break;
        case 'concern':
          actions.push(handleConcern(e, businessId));
          break;
        case 'context':
          actions.push(await handleContext(e, businessId));
          break;
        case 'task_implicit':
          actions.push(await handleTask(e, businessId));
          break;
        case 'scenario_question':
          actions.push(await handleScenario(e, businessId));
          break;
        case 'investigation_question':
          actions.push(await handleInvestigation(e, businessId));
          break;
        case 'signal_implied':
          actions.push(await handleSignalImplied(e, businessId, conversationId));
          break;
        case 'agent_brief_needed':
          actions.push(await handleAgentBriefNeeded(e, businessId));
          break;
        case 'connector_mention':
          actions.push(await handleConnectorMention(e, businessId));
          break;
      }
    } catch (err) {
      console.warn('[brain] actOnExtraction failed:', err.message);
    }
  }

  return actions.filter(Boolean);
}

async function handleGoal(e, businessId) {
  const s = e.structured ?? {};
  if (!s.title) return null;
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO goals
    (id, business_id, title, description, status, created_by, tags)
    VALUES (?, ?, ?, ?, 'active', 'brain', ?)
  `).run(
    id, businessId, s.title,
    `Extracted from chat conversation. Source: "${e.raw_text}"${s.metric_hint ? `\n\nSuggested metric: ${s.metric_hint}` : ''}${s.timeframe_hint ? `\nTimeframe hint: ${s.timeframe_hint}` : ''}`,
    JSON.stringify(['chat-extracted'])
  );
  return {
    type: 'goal_created', id,
    message: `I've drafted a goal from what you said: "${s.title}". Open Goals to set a target metric and deadline.`,
  };
}

async function handleDecision(e, businessId) {
  const s = e.structured ?? {};
  const decision = s.decision ?? e.raw_text?.slice(0, 120);
  if (!decision) return null;

  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(businessId);
    if (!result?.engine) return null;
    const today = new Date().toISOString().split('T')[0];
    const kbPath = s.kb_path || `decisions/decision-${today}-${crypto.randomUUID().slice(0, 6)}.md`;
    const body = `# Decision: ${decision}

**Date:** ${today}
**Affects:** ${s.affects ?? 'not specified'}

## Context

Recorded from conversation. Original: "${e.raw_text}"

## Implications for agents

Agents should be aware of this decision when proposing related tasks.`;
    await result.engine.writeFile(
      kbPath, body,
      { title: decision.slice(0, 100), tags: ['decision', 'chat-extracted'],
        created: today, updated: today, written_by: 'brain',
        review_status: 'pending_review' },
      `decision: ${decision.slice(0, 60)}`
    );
    return {
      type: 'decision_filed',
      message: `Filed that decision to the knowledge base so agents remember it.`,
    };
  } catch {
    return null;
  }
}

function handleConcern(e, businessId) {
  const s = e.structured ?? {};
  if (!s.area) return null;
  db.prepare(`
    INSERT INTO signals
    (id, business_id, rule_id, type, severity, title, description, data, status, confidence, created_at)
    VALUES (?, ?, 'chat_concern', 'risk', 'info', ?, ?, ?, 'open', ?, CURRENT_TIMESTAMP)
  `).run(
    crypto.randomUUID(), businessId,
    `Human concern: ${s.area}`,
    `Flagged in conversation: "${e.raw_text}". ${s.metric_to_check ? `Metric to investigate: ${s.metric_to_check}` : ''}`,
    JSON.stringify({ area: s.area, metric_to_check: s.metric_to_check, source: 'chat' }),
    e.confidence ?? 0.8
  );
  return {
    type: 'concern_flagged',
    message: `Flagged that concern as a signal so agents will investigate.`,
  };
}

async function handleContext(e, businessId) {
  const s = e.structured ?? {};
  if (!s.event) return null;
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(businessId);
    if (!result?.engine) return null;
    const today = new Date().toISOString().split('T')[0];
    const body = `# Upcoming Context: ${s.event}

**When:** ${s.date_hint ?? 'not specified'}

## What this means for Blueprint

${s.implications ?? ''}

Agents should factor this into their analysis and avoid attributing metric changes to other causes during this period.`;
    await result.engine.writeFile(
      `signals/upcoming-context-${today}-${crypto.randomUUID().slice(0, 6)}.md`,
      body,
      { title: s.event.slice(0, 100), tags: ['context', 'upcoming'],
        created: today, updated: today, written_by: 'brain',
        review_status: 'auto_approved' },
      `context: ${s.event.slice(0, 60)}`
    );
    return {
      type: 'context_noted',
      message: `Noted. Added "${s.event}" to the knowledge base so agents factor it into their analysis.`,
    };
  } catch {
    return null;
  }
}

async function handleScenario(e, businessId) {
  const s = e.structured ?? {};
  const question = s.question || e.raw_text;
  if (!question) return null;
  try {
    const { modelScenarios } = await import('./scenario-engine.js');
    const result = await modelScenarios(businessId, question, '');
    if (!result) return null;
    const rec = result.recommended_scenario ? ` Recommended: **${result.recommended_scenario}**.` : '';
    return {
      type: 'scenario_modelled',
      id: result.id,
      message: `I've modelled ${result.scenarios.length} scenarios for "${question}".${rec} [View full scenario →](/scenarios?id=${result.id})`,
    };
  } catch (err) {
    console.warn('[brain] scenario from chat failed:', err.message);
    return null;
  }
}

async function handleInvestigation(e, businessId) {
  const s = e.structured ?? {};
  const question = s.question || e.raw_text;
  if (!question) return null;
  try {
    const { runInvestigation } = await import('./investigation-engine.js');
    const result = await runInvestigation({
      businessId,
      metricName: s.metric_hint ?? null,
      question,
      triggeredBy: 'chat',
    });
    if (!result) return null;
    return {
      type: 'investigation_ran',
      id: result.id,
      message: `I investigated: ${result.plain_english ?? '(see full report)'} [View full report →](/signals?investigation=${result.id})`,
    };
  } catch (err) {
    console.warn('[brain] investigation from chat failed:', err.message);
    return null;
  }
}

async function handleTask(e, businessId) {
  const s = e.structured ?? {};
  if (!s.task_title) return null;
  try {
    const m = await import('../tasks/task-queue.js');
    const task = m.createTask({
      business_id: businessId,
      title: s.task_title,
      description: `Identified from conversation: "${e.raw_text}"`,
      proposed_by: 'brain',
      action_type: s.action_type || 'investigation',
      action_payload: {},
      trust_tier: 'yellow',
      priority: s.urgency || 'p3',
      confidence: e.confidence,
      approval_mode: 'requires_approval',
    });
    return {
      type: 'task_created', id: task.id,
      message: `Added "${s.task_title}" to the task queue.`,
    };
  } catch { return null; }
}

// ─── Mesh extensions (Tranche 4) ─────────────────────────────────────────────

async function handleSignalImplied(e, businessId, conversationId) {
  const s = e.structured ?? {};
  if (!s.title) return null;
  try {
    const { createSignalIfNotDuplicate } = await import('../signals/signal-helpers.js');

    // Build a stable rule id from the slugified title so repeat mentions
    // of the same concern in chat merge rather than spawn fresh signals.
    const slug = String(s.title).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat_signal';
    const rule_id = `chat:${slug}`;

    const res = createSignalIfNotDuplicate({
      business_id: businessId,
      rule_id,
      type: ['anomaly', 'opportunity', 'risk', 'correlation'].includes(s.type) ? s.type : 'anomaly',
      severity: ['info', 'warning', 'alert', 'critical'].includes(s.severity) ? s.severity : 'info',
      title: s.title,
      description: s.description ?? `From conversation: "${e.raw_text}"`,
      confidence: e.confidence ?? 0.75,
      data: { source: 'chat', conversation_id: conversationId ?? null },
      source_label: 'chat',
    });
    if (!res) return null;
    return {
      type: 'signal_raised',
      id: res.id,
      message: res.created
        ? `Raised a signal from what you said so agents can investigate.`
        : `Updated an existing signal with the new context from your message.`,
    };
  } catch (err) {
    console.warn('[brain] handleSignalImplied failed:', err.message);
    return null;
  }
}

async function handleAgentBriefNeeded(e, businessId) {
  const s = e.structured ?? {};
  if (!s.to_agent || !s.brief) return null;

  // Only deliver to installed, active agents
  const agent = db.prepare("SELECT id FROM agents WHERE id = ? AND status = 'active'").get(s.to_agent);
  if (!agent) return null;

  try {
    const { deliverAgentBrief } = await import('../agents/agent-inbox.js');
    const priority = ['immediate', 'next_run', 'fyi'].includes(s.priority) ? s.priority : 'next_run';
    const { delivered, triggered } = await deliverAgentBrief({
      from: 'chat',
      to: s.to_agent,
      businessId,
      brief: s.brief,
      priority,
      metadata: { conversation_source: e.raw_text?.slice(0, 200) },
    });
    if (!delivered) return null;
    return {
      type: 'agent_briefed',
      id: s.to_agent,
      message: triggered
        ? `Briefed ${s.to_agent} and triggered an immediate run.`
        : `Briefed ${s.to_agent} — they'll see this on their next run.`,
    };
  } catch (err) {
    console.warn('[brain] handleAgentBriefNeeded failed:', err.message);
    return null;
  }
}

async function handleConnectorMention(e, businessId) {
  const s = e.structured ?? {};
  if (!s.connector_name) return null;
  try {
    const { surfaceConnectorGap } = await import('../lib/connector-gap-handler.js');
    const res = await surfaceConnectorGap({
      business_id: businessId,
      connector_name: s.connector_name,
      source: 'chat',
      reason: s.use_case ?? `Mentioned in conversation: "${e.raw_text}"`,
      use_case: s.use_case ?? null,
      implied_by: 'conversation',
      priority: 'p3',
    });
    if (!res) return null;
    return {
      type: res.first_time ? 'connector_gap_surfaced' : 'connector_gap_noted',
      message: res.first_time
        ? `Noted: ${s.connector_name} would help. Added a task so it can be connected or researched.`
        : `Noted: already tracking ${s.connector_name} as a connector gap — bumped its priority context.`,
    };
  } catch (err) {
    console.warn('[brain] handleConnectorMention failed:', err.message);
    return null;
  }
}
