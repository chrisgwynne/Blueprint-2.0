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

export interface InboxEntry {
  from: string;
  to: string;
  business_id: string | null;
  timestamp: string;
  priority: 'immediate' | 'next_run' | 'fyi';
  brief: string;
  metadata: Record<string, unknown> | null;
  read: boolean;
}

function inboxPathFor(agentId: string): string {
  return join(AGENTS_DIR, agentId, 'inbox.jsonl');
}

function ensureInboxDir(agentId: string): void {
  mkdirSync(join(AGENTS_DIR, agentId), { recursive: true });
}

/**
 * Deliver a brief from one agent (or any mesh source) to another agent.
 *
 * @param opts.from           source label for inbox display:
 *                            'agent:<id>' | 'chat' | 'kb-analyser' | etc.
 * @param opts.to             target agent id (e.g. 'seo-sentinel')
 * @param opts.businessId
 * @param opts.brief          what the source wants the target to know/do
 * @param opts.priority       default 'next_run'
 * @param opts.metadata       optional structured payload
 * @param opts.source_label   label used for the intelligence_event row.
 *                            Defaults to `from`. Pass a run-scoped label
 *                            like 'agent_run:<runId>' so the Timeline
 *                            can attribute the brief to a specific run.
 */
export async function deliverAgentBrief({
  from,
  to,
  businessId,
  brief,
  priority = 'next_run',
  metadata = null,
  source_label = null,
}: {
  from: string;
  to: string;
  businessId?: string | null;
  brief: string;
  priority?: 'immediate' | 'next_run' | 'fyi';
  metadata?: Record<string, unknown> | null;
  source_label?: string | null;
}): Promise<{ delivered: boolean; triggered: boolean }> {
  if (!from || !to || !brief) return { delivered: false, triggered: false };
  if (from === `agent:${to}`) {
    // An agent shouldn't brief itself — no-op rather than loop
    return { delivered: false, triggered: false };
  }

  try {
    ensureInboxDir(to);
    const entry: InboxEntry = {
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
    console.warn(`[agent-inbox] deliver to ${to} failed:`, (err as Error).message);
    return { delivered: false, triggered: false };
  }

  // Intelligence event so the Timeline can show "agent A briefed agent B".
  // If the caller provided a source_label (e.g. 'agent_run:<runId>'), attribute
  // the event to that source instead of the inbox `from` label.
  if (businessId) {
    const { type, id } = parseSourceLabel(source_label || from);
    logIntelligenceEvent({
      business_id: businessId,
      source_type: type,
      source_id: id,
      target_type: 'agent',
      target_id: to,
      event_type: 'briefed_agent',
      description: `${priority}: ${String(brief).slice(0, 140)}`,
      metadata: { priority, display_from: from, ...(metadata ?? {}) },
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
      `).get(to, businessId, TRIGGER_COOLDOWN_MINUTES) as { id: string } | null;
      if (!recent) {
        triggered = true;
        (async () => {
          try {
            const { runAgent } = await import('./agent-runner.js') as unknown as { runAgent: (agentId: string, businessId: string, trigger: string, triggerId: string | null) => Promise<void> };
            await runAgent(to, businessId, 'brief', null);
          } catch (err) {
            console.warn(`[agent-inbox] runAgent ${to} from brief failed:`, (err as Error).message);
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
export function readInbox(
  agentId: string,
  { limit = 20, unreadOnly = false }: { limit?: number; unreadOnly?: boolean } = {},
): InboxEntry[] {
  const path = inboxPathFor(agentId);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines
      .map((l) => { try { return JSON.parse(l) as InboxEntry; } catch { return null; } })
      .filter((e): e is InboxEntry => e !== null);
    const filtered = unreadOnly ? entries.filter((e) => !e.read) : entries;
    return filtered.slice(-limit);
  } catch (err) {
    console.warn(`[agent-inbox] read ${agentId} failed:`, (err as Error).message);
    return [];
  }
}

/**
 * Mark entries as read by their timestamps. Used by agent-runner after it
 * has included inbox contents in the system prompt — so the same brief
 * isn't re-shown on every run.
 */
export function markInboxAsRead(agentId: string, timestamps: string[] = []): void {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return;
  const path = inboxPathFor(agentId);
  if (!existsSync(path)) return;
  try {
    const stamps = new Set(timestamps);
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const updated = lines.map((l) => {
      try {
        const e = JSON.parse(l) as InboxEntry;
        if (stamps.has(e.timestamp)) e.read = true;
        return JSON.stringify(e);
      } catch { return l; }
    });
    writeFileSync(path, updated.join('\n') + '\n', 'utf8');
  } catch (err) {
    console.warn(`[agent-inbox] mark-read ${agentId} failed:`, (err as Error).message);
  }
}

/**
 * Mark all current entries as read. Used when agent-runner wants to clear
 * the inbox after surfacing it in the system prompt.
 */
export function markAllInboxAsRead(agentId: string): void {
  const entries = readInbox(agentId, { limit: 10_000, unreadOnly: true });
  markInboxAsRead(agentId, entries.map((e) => e.timestamp));
}

function trimInbox(agentId: string): void {
  const path = inboxPathFor(agentId);
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > MAX_INBOX_ENTRIES) {
      writeFileSync(path, lines.slice(-MAX_INBOX_ENTRIES).join('\n') + '\n', 'utf8');
    }
  } catch {}
}
