/**
 * Intelligence events — cross-component event log.
 *
 * Every time one part of the mesh produces output that another part consumes,
 * call logIntelligenceEvent(). The Timeline UI reads this back, and Conductor
 * uses it to answer "what's flowing through the system right now".
 *
 * Source/target types (convention):
 *   source_type: kb | signal | task | chat | agent | connector | goal | workflow | system
 *   target_type: signal | task | kb_entry | agent_brief | connector_gap | goal | workflow
 *   event_type:  created_signal | created_task | filed_kb | briefed_agent |
 *                surfaced_connector_gap | updated_goal | triggered_agent |
 *                escalated | dismissed
 *
 * These are conventions, not enforced — keep them loose so new event types
 * can be added without a schema change.
 */

import db, { generateId } from '../db/db.js';

export function logIntelligenceEvent({
  business_id,
  source_type,
  source_id,
  target_type = null,
  target_id = null,
  event_type,
  description = null,
  metadata = null,
}) {
  if (!business_id || !source_type || !source_id || !event_type) return null;
  try {
    const id = generateId();
    db.prepare(`
      INSERT INTO intelligence_events (
        id, business_id, source_type, source_id,
        target_type, target_id, event_type, description, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      String(business_id),
      String(source_type),
      String(source_id),
      target_type != null ? String(target_type) : null,
      target_id != null ? String(target_id) : null,
      String(event_type),
      description != null ? String(description).slice(0, 1000) : null,
      metadata != null ? JSON.stringify(metadata) : null,
    );
    return id;
  } catch (err) {
    console.warn('[intel-events] log failed:', err.message);
    return null;
  }
}

/**
 * Fetch recent intelligence events, optionally filtered.
 * Used by the Timeline view to show what each event produced.
 */
export function getIntelligenceEvents(businessId, {
  limit = 100,
  sourceType = null,
  targetType = null,
  sourceId = null,
  targetId = null,
  since = null,   // ISO timestamp; events after this point
} = {}) {
  if (!businessId) return [];

  const clauses = ['business_id = ?'];
  const args = [businessId];
  if (sourceType) { clauses.push('source_type = ?'); args.push(sourceType); }
  if (targetType) { clauses.push('target_type = ?'); args.push(targetType); }
  if (sourceId)   { clauses.push('source_id = ?');   args.push(sourceId); }
  if (targetId)   { clauses.push('target_id = ?');   args.push(targetId); }
  if (since)      { clauses.push('created_at > ?');  args.push(since); }

  const sql = `
    SELECT * FROM intelligence_events
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  args.push(limit);
  try {
    return db.prepare(sql).all(...args).map(row => ({
      ...row,
      metadata: row.metadata ? safeJSON(row.metadata) : null,
    }));
  } catch (err) {
    console.warn('[intel-events] fetch failed:', err.message);
    return [];
  }
}

/**
 * Parse a source label like 'agent:seo-sentinel' into { type, id }.
 * Helpers for callers that don't want to split the string themselves.
 */
export function parseSourceLabel(label) {
  const s = String(label ?? '');
  const colon = s.indexOf(':');
  if (colon < 0) {
    // Bare labels map to well-known types
    if (s === 'kb-analyser')         return { type: 'kb',     id: 'analyser' };
    if (s === 'signal-intelligence') return { type: 'signal', id: 'intelligence' };
    if (s === 'task-intelligence')   return { type: 'task',   id: 'intelligence' };
    if (s === 'chat-intelligence')   return { type: 'chat',   id: 'intelligence' };
    if (s === 'chat')                return { type: 'chat',   id: 'engine' };
    return { type: 'system', id: s || 'unknown' };
  }
  return { type: s.slice(0, colon), id: s.slice(colon + 1) };
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}
