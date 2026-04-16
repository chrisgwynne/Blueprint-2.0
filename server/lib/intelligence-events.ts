/**
 * Intelligence events — cross-component event log.
 */

import db, { generateId } from '../db/db.js';

export interface IntelligenceEventParams {
  business_id: string;
  source_type: string;
  source_id: string;
  target_type?: string | null;
  target_id?: string | null;
  event_type: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function logIntelligenceEvent(params: IntelligenceEventParams): string | null {
  const {
    business_id,
    source_type,
    source_id,
    target_type = null,
    target_id = null,
    event_type,
    description = null,
    metadata = null,
  } = params;

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
    console.warn('[intel-events] log failed:', (err as Error).message);
    return null;
  }
}

export interface GetEventsOptions {
  limit?: number;
  sourceType?: string | null;
  targetType?: string | null;
  sourceId?: string | null;
  targetId?: string | null;
  since?: string | null;
}

export interface IntelligenceEvent {
  id: string;
  business_id: string;
  source_type: string;
  source_id: string;
  target_type: string | null;
  target_id: string | null;
  event_type: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export function getIntelligenceEvents(
  businessId: string,
  options: GetEventsOptions = {},
): IntelligenceEvent[] {
  const { limit = 100, sourceType = null, targetType = null, sourceId = null, targetId = null, since = null } = options;
  if (!businessId) return [];

  const clauses: string[] = ['business_id = ?'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any[] = [businessId];
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
    const rows = db.prepare(sql).all(...args) as Array<IntelligenceEvent & { metadata: string | null }>;
    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? safeJSON(row.metadata) : null,
    }));
  } catch (err) {
    console.warn('[intel-events] fetch failed:', (err as Error).message);
    return [];
  }
}

export interface ParsedSourceLabel {
  type: string;
  id: string;
}

export function parseSourceLabel(label: unknown): ParsedSourceLabel {
  const s = String(label ?? '');
  const colon = s.indexOf(':');
  if (colon < 0) {
    if (s === 'kb-analyser')         return { type: 'kb',     id: 'analyser' };
    if (s === 'signal-intelligence') return { type: 'signal', id: 'intelligence' };
    if (s === 'task-intelligence')   return { type: 'task',   id: 'intelligence' };
    if (s === 'chat-intelligence')   return { type: 'chat',   id: 'intelligence' };
    if (s === 'chat')                return { type: 'chat',   id: 'engine' };
    return { type: 'system', id: s || 'unknown' };
  }
  return { type: s.slice(0, colon), id: s.slice(colon + 1) };
}

function safeJSON(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}
