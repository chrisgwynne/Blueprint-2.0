/**
 * Per-agent inbox — generalises the existing Conductor briefing mechanism.
 *
 * Any agent (or the chat intent extractor) can deliver a brief to any other
 * agent. Target agents read their inbox at the start of each run so they see
 * what other parts of the system want them to know.
 *
 * Storage: JSONL at server/agents/{toAgent}/inbox.jsonl — one line per brief,
 * last 50 kept. Matches the pre-existing conductor pattern.
 *
 * Priorities:
 *   immediate  — if the target agent hasn't run in 30 min, trigger a run now
 *   next_run   — will be delivered next time the agent is scheduled or invoked
 *   fyi        — delivered but not actionable (informational)
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logIntelligenceEvent, parseSourceLabel } from '../lib/intelligence-events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname, '../agents');

const MAX_INBOX_ENTRIES = 50;
const TRIGGER_COOLDOWN_MINUTES = 30;

function inboxPathFor(agentId) {
  return join(AGENTS_DIR, agentId, 'inbox.jsonl');
}

function ensureInboxDir(agentId) {
  mkdirSync(join(AGENTS_DIR, agentId), { recursive: true });
}

/**
 * Deliver a brief from one agent (or any mesh source) to another agent.
 *
 * @param {object}  opts
 * @param {string}  opts.from           source label: 'agent:<id>' | 'chat' | 'kb-analyser' | etc.
 * @param {string}  opts.to             target agent id (e.g. 'seo-sentinel')
 * @param {string}  opts.businessId
 * @param {string}  opts.brief          what the source wants the target to know/do
 * @param {'immediate'|'next_run'|'fyi'} [opts.priority='next_run']
 * @param {object}  [opts.metadata]     optional structured payload
 * @returns {Promise<{delivered: boolean, triggered: boolean}>}
 */
export async function deliverAgentBrief({
  from,
  to,
  businessId,
  brief,
  priority = 'next_run',
  metadata = null,
}) {
  if (!from || !to || !brief) return { delivered: false, triggered: false };
  if (from === `agent:${to}`) {
    // An agent shouldn't brief itself — no-op rather than loop
    return { delivered: false, triggered: false };
  }

  try {
    ensureInboxDir(to);
    const entry = {
      from,
      to,
      business_id: businessId ?? null,
      timestamp: new Date().toISOString(),
      priority,
      brief: String(brief).slice(0, 2000),
      metadata: metadata ?? null,
      read: false,
    };
    appendFileSync(inboxPathFor(to), JSON.stringify(entry) + '\n', 'utf8');
    trimInbox(to);
  } catch (err) {
    console.warn(`[agent-inbox] deliver to ${to} failed:`, err.message);
    return { delivered: false, triggered: false };
  }

  // Intelligence event so the Timeline can show "agent A briefed agent B"
  if (businessId) {
    const { type, id } = parseSourceLabel(from);
    logIntelligenceEvent({
      business_id: businessId,
      source_type: type,
      source_id: id,
      target_type: 'agent',
      target_id: to,
      event_type: 'briefed_agent',
      description: `${priority}: ${String(brief).slice(0, 140)}`,
      metadata: { priority, ...(metadata ?? {}) },
    });
  }

  // Immediate priority → trigger the target agent now (with cooldown).
  // Fire-and-forget — don't make the caller wait for the agent run.
  let triggered = false;
  if (priority === 'immediate' && businessId) {
    try {
      const db = (await import('../db/db.js')).default;
      const recent = db.prepare(`
        SELECT id FROM agent_runs
         WHERE agent_id = ? AND business_id = ?
           AND started_at > datetime('now', '-' || ? || ' minutes')
         LIMIT 1
      `).get(to, businessId, TRIGGER_COOLDOWN_MINUTES);
      if (!recent) {
        triggered = true;
        (async () => {
          try {
            const { runAgent } = await import('./agent-runner.js');
            await runAgent(to, businessId, 'brief', null);
          } catch (err) {
            console.warn(`[agent-inbox] runAgent ${to} from brief failed:`, err.message);
          }
        })();
      }
    } catch {}
  }

  return { delivered: true, triggered };
}

/**
 * Read an agent's inbox. Returns the most-recent N entries.
 * `unreadOnly: true` filters to entries where read=false.
 */
export function readInbox(agentId, { limit = 20, unreadOnly = false } = {}) {
  const path = inboxPathFor(agentId);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const filtered = unreadOnly ? entries.filter((e) => !e.read) : entries;
    return filtered.slice(-limit);
  } catch (err) {
    console.warn(`[agent-inbox] read ${agentId} failed:`, err.message);
    return [];
  }
}

/**
 * Mark entries as read by their timestamps. Used by agent-runner after it
 * has included inbox contents in the system prompt — so the same brief
 * isn't re-shown on every run.
 */
export function markInboxAsRead(agentId, timestamps = []) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return;
  const path = inboxPathFor(agentId);
  if (!existsSync(path)) return;
  try {
    const stamps = new Set(timestamps);
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const updated = lines.map((l) => {
      try {
        const e = JSON.parse(l);
        if (stamps.has(e.timestamp)) e.read = true;
        return JSON.stringify(e);
      } catch { return l; }
    });
    writeFileSync(path, updated.join('\n') + '\n', 'utf8');
  } catch (err) {
    console.warn(`[agent-inbox] mark-read ${agentId} failed:`, err.message);
  }
}

/**
 * Mark all current entries as read. Used when agent-runner wants to clear
 * the inbox after surfacing it in the system prompt.
 */
export function markAllInboxAsRead(agentId) {
  const entries = readInbox(agentId, { limit: 10_000, unreadOnly: true });
  markInboxAsRead(agentId, entries.map((e) => e.timestamp));
}

function trimInbox(agentId) {
  const path = inboxPathFor(agentId);
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > MAX_INBOX_ENTRIES) {
      writeFileSync(path, lines.slice(-MAX_INBOX_ENTRIES).join('\n') + '\n', 'utf8');
    }
  } catch {}
}
