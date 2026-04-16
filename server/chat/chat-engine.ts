/**
 * Chat engine (Feature 3).
 *
 * Processes a human chat message, routes it to one or more agents (via @mention
 * or default-to-conductor), runs each agent in "chat mode" with conversation
 * history as context, stores their responses, and handles agent-to-agent
 * @mention chains.
 *
 * Auto-files a KB summary to decisions/ every 10 messages.
 */
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { recordAgentActivity } from '../agents/activity.js';
import { buildMetricsContext } from '../agents/context-builders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');

const AVAILABLE_AGENTS = [
  'conductor', 'seo-sentinel', 'quill', 'velocity',
  'trend-spotter', 'merchant', 'ledger', 'sentinel',
  'researcher', 'reporter', 'dev', 'outreach',
];

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'conductor':      'Conductor',
  'seo-sentinel':   'SEO Sentinel',
  'quill':          'Quill',
  'velocity':       'Velocity',
  'trend-spotter':  'Trend Spotter',
  'merchant':       'Merchant',
  'ledger':         'Ledger',
  'sentinel':       'Sentinel',
  'researcher':     'Researcher',
  'reporter':       'Reporter',
  'dev':            'Dev',
  'outreach':       'Outreach',
};

export function getAgentDisplayName(agentId: string): string {
  return AGENT_DISPLAY_NAMES[agentId] ?? agentId;
}

// ─── Mentions extraction ─────────────────────────────────────────────────────

const MENTION_RE = /@([\w-]+)/g;

export function extractMentions(content: string | undefined | null): string[] {
  if (!content) return [];
  const found: string[] = [];
  for (const match of String(content).matchAll(MENTION_RE)) {
    const id = match[1].toLowerCase();
    if (AVAILABLE_AGENTS.includes(id) && !found.includes(id)) found.push(id);
  }
  return found;
}

// ─── Agent profile loader ────────────────────────────────────────────────────

function loadAgentProfile(agentId: string): Record<string, unknown> | null {
  const path = join(AGENTS_DIR, agentId, 'profile.yaml');
  if (!existsSync(path)) return null;
  try { return yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function loadAgentSoulFiles(agentId: string): string {
  const dir = join(AGENTS_DIR, agentId);
  const files = ['IDENTITY.md', 'SOUL.md', 'HEARTBEAT.md'];
  const sections: string[] = [];
  for (const f of files) {
    const path = join(dir, f);
    if (existsSync(path)) {
      sections.push(readFileSync(path, 'utf8').trim());
    }
  }
  return sections.join('\n\n---\n\n');
}

// ─── Chat-mode system prompt ──────────────────────────────────────────────────

interface Business {
  id: string;
  name: string;
  type?: string;
}

interface ChatMessage {
  sender_name: string;
  sender_id: string;
  sender_type: string;
  content: string;
}

interface Signal {
  severity: string;
  title: string;
  description?: string;
}

function assembleChatSystemPrompt(
  agentId: string,
  business: Business,
  history: ChatMessage[],
  recentSignals: Signal[]
): string {
  const profile = loadAgentProfile(agentId);
  const soul = loadAgentSoulFiles(agentId);
  const displayName = getAgentDisplayName(agentId);

  const parts: string[] = [];

  if (soul) {
    parts.push(soul);
  } else if (profile) {
    parts.push(`You are ${displayName}. Role: ${String(profile.title ?? '')}\n${String(profile.personality ?? '')}`);
  } else {
    parts.push(`You are ${displayName}, a Blueprint agent.`);
  }

  parts.push(`## Current Business\nName: ${business.name}\nType: ${business.type ?? 'business'}`);

  // Tell the agent what is ACTUALLY connected so it cannot invent data sources.
  try {
    const connectors = db.prepare(
      `SELECT type, name, status FROM connectors
       WHERE business_id = ?
       ORDER BY created_at ASC`
    ).all(business.id) as { type: string; name: string; status?: string }[];
    if (connectors.length === 0) {
      parts.push(`## Connected Data Sources\nNone. The user has not connected any data source yet. Do NOT claim they have Shopify, Google, GitHub, or any other integration. If asked about data, say you cannot see any yet and point them at the Connectors page.`);
    } else {
      const lines = connectors.map(c =>
        `- ${c.type} (${c.name})${c.status && c.status !== 'active' ? ` [${c.status}]` : ''}`
      ).join('\n');
      parts.push(`## Connected Data Sources\nThese are the ONLY data sources connected to this business. Do not reference any other integrations:\n${lines}`);
    }
  } catch {
    parts.push(`## Connected Data Sources\n(Unable to query connectors — do not assume any are connected.)`);
  }

  // Inject real metric values so agents can answer data questions without
  // asking the user to share numbers Blueprint already has.
  try {
    const metricsSection = buildMetricsContext(business.id, db);
    if (metricsSection) parts.push(metricsSection);
  } catch {}

  if (recentSignals?.length > 0) {
    parts.push(`## Recent open signals (${recentSignals.length})\n` + recentSignals.slice(0, 5).map(s =>
      `- [${s.severity}] ${s.title}${s.description ? ': ' + s.description.slice(0, 140) : ''}`
    ).join('\n'));
  }

  if (history?.length > 0) {
    const tail = history.slice(-10);
    parts.push(`## Conversation so far\n` + tail.map(m =>
      `${m.sender_name}: ${m.content}`
    ).join('\n'));
  }

  parts.push(`## Chat Mode Instructions

You are responding in a direct conversation. Be concise. Use markdown for structure
when it helps (lists, bold). Cite specific numbers when referencing data.

If you propose a task, say so explicitly:
  "I've proposed a task: [title]"

If you need another agent's help, @mention them naturally:
  "I'll ask @quill to draft this" or "@velocity can fix the LCP issue"

CRITICAL — Grounding rules:
- ONLY reference data sources listed under "Connected Data Sources" above.
- Do NOT claim the user has connected anything that isn't on that list.
- Do NOT invent progress on SEO, content, integrations, or any other work.
- On a first "hello", keep it brief (under 80 words). Do not summarise business
  status unless the user asks — you have no data to summarise yet.
- If the list is empty, suggest they connect a data source first.

Respond as ${displayName} — do not include a "Name:" prefix; the UI shows that.`);

  return parts.join('\n\n---\n\n');
}

// ─── Run an agent in chat mode ────────────────────────────────────────────────

async function runAgentChat(
  agentId: string,
  userMessage: string,
  history: ChatMessage[],
  businessId: string
): Promise<{
  content: string;
  mentions_in_response: string[];
  tasks_proposed: number;
  cost_usd?: number;
} | null> {
  const profile = loadAgentProfile(agentId);

  // Gather minimal business + signal context
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Business | null;
  if (!business) return null;

  const recentSignals = db.prepare(
    `SELECT severity, title, description FROM signals
     WHERE business_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 8`
  ).all(businessId) as Signal[];

  const systemPrompt = assembleChatSystemPrompt(agentId, business, history, recentSignals);

  // Provider + model come from user settings (llm_default_*), not profile.
  // If the agent profile overrides temperature/max_tokens we use those;
  // otherwise sensible defaults for chat.
  const llmConfig = (profile?.llm as Record<string, unknown>) ?? {
    temperature: 0.4,
    max_tokens: 2048,
  };

  const { providerId, model, temperature, max_tokens } = resolveProfileLLM({
    ...llmConfig,
    temperature: 0.4,
    max_tokens: 2048,
  });

  // Record this chat response as an agent_run so the sidebar "last seen
  // Xh ago" reflects chat activity, not just scheduled agent runs. Chat
  // is real work the agent did — it should count.
  const startedAt = new Date().toISOString();

  try {
    const result = await runLLM(providerId, model, {
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      temperature,
      max_tokens,
    });

    const content = result.content?.trim() ?? '';
    if (!content) {
      recordAgentActivity({
        agentId, businessId, trigger: 'chat', status: 'failed',
        reasoning: 'Empty response from LLM',
        usage: result.usage, cost_usd: result.cost_usd, startedAt,
      });
      return null;
    }

    const tasksProposed = (content.match(/proposed a task/gi) ?? []).length;
    recordAgentActivity({
      agentId, businessId, trigger: 'chat', status: 'complete',
      reasoning: `Chat: "${userMessage.slice(0, 80)}"`,
      tasks_proposed: tasksProposed,
      usage: result.usage, cost_usd: result.cost_usd, startedAt,
    });

    return {
      content,
      mentions_in_response: extractMentions(content),
      tasks_proposed: tasksProposed,
      cost_usd: result.cost_usd ?? 0,
    };
  } catch (err) {
    console.warn(`[chat-engine] Agent '${agentId}' chat run failed:`, (err as Error).message);
    recordAgentActivity({
      agentId, businessId, trigger: 'chat', status: 'failed',
      reasoning: `Chat run failed: ${(err as Error).message.slice(0, 200)}`,
      error: (err as Error).message.slice(0, 500),
      startedAt,
    });
    return {
      content: `⚠️ ${getAgentDisplayName(agentId)} is unavailable right now (${(err as Error).message.slice(0, 100)}).`,
      mentions_in_response: [],
      tasks_proposed: 0,
    };
  }
}

// ─── File conversation summary to KB ──────────────────────────────────────────

async function fileConversationToKB(conversationId: string, businessId: string): Promise<void> {
  const messages = db.prepare(
    `SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC`
  ).all(conversationId) as { sender_name: string; content: string }[];

  if (messages.length < 3) return;

  try {
    const transcript = messages.map(m => `${m.sender_name}: ${m.content}`).join('\n\n');

    // Generate summary via LLM — uses the user's configured triage tier.
    let summary = transcript.slice(0, 3000);
    try {
      const { providerId: sumProvider, model: sumModel } =
        resolveProfileLLM({}, { tier: 'triage' });
      const result = await runLLM(sumProvider, sumModel, {
        system: 'Summarise this agent conversation in 2 paragraphs. Extract key decisions, findings, and tasks proposed. Plain markdown.',
        messages: [{ role: 'user', content: transcript.slice(0, 12000) }],
        temperature: 0.2,
        max_tokens: 1024,
      });
      if (result?.content) summary = result.content;
    } catch {
      // Fall back to the transcript itself
    }

    const today = new Date().toISOString().split('T')[0];
    const slug = `chat-${conversationId.slice(0, 8)}-${today}`;

    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const kbResult = await getKBForBusiness(businessId);
    if (!kbResult?.engine) return;

    await kbResult.engine.writeFile(
      `decisions/${slug}.md`,
      summary,
      {
        title: `Chat Session — ${today}`,
        tags: ['chat', 'decisions'],
        conversation_id: conversationId,
        created: today,
        updated: today,
        written_by: 'system',
        review_status: 'auto_approved',
      },
      `chat: filed conversation ${conversationId.slice(0, 8)}`
    );
  } catch (err) {
    console.warn('[chat-engine] KB file failed (non-fatal):', (err as Error).message);
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Process an incoming human chat message.
 *
 * @param message
 * @param conversationId
 * @param businessId
 */
export async function processMessage(
  message: { content: string },
  conversationId: string,
  businessId: string
): Promise<{ agentId: string; messageId: string; content: string }[]> {
  const conversation = db.prepare(
    'SELECT * FROM chat_conversations WHERE id = ?'
  ).get(conversationId) as { id: string; title: string | null } | null;
  if (!conversation) throw new Error(`Conversation ${conversationId} not found`);

  // Extract mentions
  const mentions = extractMentions(message.content);

  // Load recent history (for context)
  const history = db.prepare(
    `SELECT sender_name, sender_id, sender_type, content
     FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 20`
  ).all(conversationId) as ChatMessage[];

  // Store the human message
  const humanMsgId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO chat_messages
    (id, conversation_id, business_id, sender_type, sender_id, sender_name, content, mentions, created_at)
    VALUES (?, ?, ?, 'human', 'human', 'You', ?, ?, CURRENT_TIMESTAMP)
  `).run(humanMsgId, conversationId, businessId, message.content, JSON.stringify(mentions));

  // Brain — extract intent from the human message (non-blocking for agent response)
  (async () => {
    try {
      const { extractIntent, actOnExtractions } = await import('../brain/intent-extractor.js') as unknown as {
        extractIntent: (content: string, history: ChatMessage[], businessId: string) => Promise<unknown[]>;
        actOnExtractions: (extractions: unknown[], businessId: string, conversationId: string) => Promise<({ type?: string; message?: string } | null)[]>;
      };
      const extractions = await extractIntent(message.content, history, businessId);
      if (extractions.length === 0) return;
      const actions = await actOnExtractions(extractions, businessId, conversationId);

      // Filter: if an agent already responded after the human message, skip Brain
      // actions that merely duplicate or contradict that response. Actions that
      // create durable objects (goals, KB decisions, concerns, context) are always
      // posted — they represent side effects, not commentary.
      const ALWAYS_POST_TYPES = new Set([
        'goal_created', 'decision_recorded', 'concern_flagged', 'context_noted', 'task_created',
      ]);
      const AGENT_COVERED_TYPES = new Set([
        'scenario_modelled', 'investigation_ran',
      ]);

      let filteredActions = actions.filter(Boolean);

      const hasCoverableActions = filteredActions.some((a) => AGENT_COVERED_TYPES.has(a?.type ?? ''));
      if (hasCoverableActions) {
        // Check if an agent replied since the human message was stored
        const agentReplied = db.prepare(`
          SELECT 1 FROM chat_messages
          WHERE conversation_id = ?
            AND sender_type = 'agent'
            AND created_at >= (
              SELECT created_at FROM chat_messages WHERE id = ? LIMIT 1
            )
          LIMIT 1
        `).get(conversationId, humanMsgId);

        if (agentReplied) {
          // Suppress investigation/scenario messages — agent already covered it
          filteredActions = filteredActions.filter((a) => !AGENT_COVERED_TYPES.has(a?.type ?? ''));
        }
      }

      // Suppress unused variable warnings
      void ALWAYS_POST_TYPES;

      const messages = filteredActions.map((a) => a?.message).filter(Boolean);
      if (messages.length === 0) return;
      const combined = messages.join(' ');
      db.prepare(`
        INSERT INTO chat_messages
        (id, conversation_id, business_id, sender_type, sender_id, sender_name, content, metadata, created_at)
        VALUES (?, ?, ?, 'system', 'brain', 'Blueprint Brain', ?, ?, CURRENT_TIMESTAMP)
      `).run(
        crypto.randomUUID(), conversationId, businessId,
        combined,
        JSON.stringify({ intent_extractions: extractions.length, actions: filteredActions.map((a) => a?.type) })
      );
    } catch (err) {
      console.warn('[brain] intent extraction failed (non-fatal):', (err as Error).message);
    }
  })();

  // Touch conversation
  db.prepare(`UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(conversationId);

  // Auto-title from first message if empty
  if (!conversation.title) {
    const title = message.content.slice(0, 60).replace(/\n/g, ' ').trim();
    db.prepare(`UPDATE chat_conversations SET title = ? WHERE id = ?`).run(title, conversationId);
  }

  // Route to agents (mentioned, or default to conductor)
  const targets = mentions.length > 0 ? mentions : ['conductor'];
  const responses: { agentId: string; messageId: string; content: string }[] = [];

  // Include the new human message in the history we pass to each agent
  const fullHistory: ChatMessage[] = [
    ...history,
    { sender_name: 'You', sender_id: 'human', sender_type: 'human', content: message.content },
  ];

  for (const agentId of targets) {
    // Check agent is active
    const agentRow = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | null;
    if (!agentRow || agentRow.status !== 'active') continue;

    const response = await runAgentChat(agentId, message.content, fullHistory, businessId);
    if (!response) continue;

    const responseId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO chat_messages
      (id, conversation_id, business_id, sender_type, sender_id, sender_name,
       content, mentions, metadata, created_at)
      VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      responseId, conversationId, businessId,
      agentId, getAgentDisplayName(agentId),
      response.content,
      JSON.stringify(response.mentions_in_response),
      JSON.stringify({ tasks_proposed: response.tasks_proposed, cost_usd: response.cost_usd }),
    );

    responses.push({ agentId, messageId: responseId, content: response.content });

    // Handle chain mentions — delayed to feel natural
    for (const chainId of response.mentions_in_response) {
      if (chainId === agentId) continue;
      if (targets.includes(chainId)) continue;

      setTimeout(async () => {
        try {
          const chainAgentRow = db.prepare('SELECT status FROM agents WHERE id = ?').get(chainId) as { status: string } | null;
          if (!chainAgentRow || chainAgentRow.status !== 'active') return;

          const relayedMessage = `${getAgentDisplayName(agentId)} asked: ${response.content}`;
          const chainResponse = await runAgentChat(
            chainId,
            relayedMessage,
            [...fullHistory, { sender_name: getAgentDisplayName(agentId), sender_id: agentId, sender_type: 'agent', content: response.content }],
            businessId,
          );
          if (!chainResponse) return;
          db.prepare(`
            INSERT INTO chat_messages
            (id, conversation_id, business_id, sender_type, sender_id, sender_name,
             content, mentions, created_at)
            VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(
            crypto.randomUUID(), conversationId, businessId,
            chainId, getAgentDisplayName(chainId),
            chainResponse.content,
            JSON.stringify(chainResponse.mentions_in_response),
          );
          db.prepare(`UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(conversationId);
        } catch (err) {
          console.warn('[chat-engine] chain mention failed:', (err as Error).message);
        }
      }, 2000);
    }
  }

  // Every 10 messages, file a KB summary
  const countRow = db.prepare(
    'SELECT COUNT(*) as c FROM chat_messages WHERE conversation_id = ?'
  ).get(conversationId) as { c: number } | null;
  const count = countRow?.c ?? 0;
  if (count > 0 && count % 10 === 0) {
    fileConversationToKB(conversationId, businessId).catch(() => {});
  }

  return responses;
}
