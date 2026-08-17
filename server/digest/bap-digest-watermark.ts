/**
 * BAP digest watermarks — the per-agent catch-up dimension (issue #81).
 *
 * digest-watermark.ts's watermark is keyed on the dashboard SESSION
 * USERNAME, because Blueprint's dashboard auth is single-operator and the
 * username IS that operator's identity (see that file's own docstring). A
 * BAP agent has no username — it authenticates via a `BAP-Key` header and is
 * identified by its `bap_agents.id` (server/bap/auth.ts) — so reusing that
 * table/column would either collide two unrelated callers onto one
 * watermark, or require inventing a fake username for an agent. Neither is
 * honest, and the issue is explicit that this must be a genuinely separate
 * dimension: a human operator and their Hermes/BAP agent progress through
 * "what happened while I was away" independently. Acknowledging via one can
 * never advance, or be blocked by, the other's catch-up point.
 *
 * This module is therefore a parallel table (`bap_digest_watermarks`, keyed
 * on `agent_id` + `business_id`) with the same two-part design as #62's —
 * a time floor (`acknowledged_through`) plus a per-item fingerprint map
 * (`acknowledged_items`) — for the same reason: a pure time watermark cannot
 * express "this is still pending and unchanged, don't replay it, but DO
 * replay it the moment it escalates." See digest-watermark.ts for the full
 * reasoning; it is not repeated here.
 *
 * Deliberately duplicates only the STORAGE, not the assembly logic —
 * away-digest.ts's buildAwayDigest() takes a `getWatermark` override (see
 * its DigestRequest type) so the section-building, dedup and escalation
 * logic is never reimplemented here, only read from a different table.
 */
import db, { generateId } from '../db/db.js';
import { normalizeScope } from './digest-watermark.js';
import type { WatermarkLike } from './away-digest.js';

export interface BapDigestWatermark extends WatermarkLike {
  id: string;
  agent_id: string;
  business_id: string;
  acknowledged_at: string;
  acknowledged_digest_id: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
}

function parseRow(row: Record<string, unknown>): BapDigestWatermark {
  let items: Record<string, string> = {};
  try {
    const raw = row['acknowledged_items'];
    if (typeof raw === 'string' && raw) {
      const parsed = JSON.parse(raw) as unknown;
      // A corrupted/hand-edited blob degrades to "nothing acknowledged"
      // (replays items) rather than crashing or suppressing everything.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        items = parsed as Record<string, string>;
      }
    }
  } catch {
    items = {};
  }
  return { ...(row as unknown as BapDigestWatermark), acknowledged_items: items };
}

export function normalizeAgentId(agentId: string | null | undefined): string {
  const v = (agentId ?? '').trim();
  if (!v) throw new Error('BAP digest watermark requires a non-empty agent id.');
  return v;
}

export function getBapWatermark(
  agentId: string | null | undefined,
  businessId: string | null | undefined,
): BapDigestWatermark | null {
  const row = db.prepare(
    'SELECT * FROM bap_digest_watermarks WHERE agent_id = ? AND business_id = ?'
  ).get(normalizeAgentId(agentId), normalizeScope(businessId)) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : null;
}

export interface AdvanceBapWatermarkParams {
  agent_id: string;
  business_id: string | null | undefined;
  /** The instant being acknowledged through — normally the digest window end. */
  acknowledged_through: string;
  acknowledged_digest_id?: string | null;
  /** dedup_key → change_fingerprint for every item shown in the digest. */
  items: Record<string, string>;
}

/**
 * Record an acknowledgement. Monotonic in time and merges (rather than
 * replaces) the item map — same rationale as advanceWatermark() in
 * digest-watermark.ts, which this mirrors exactly except for the identity
 * column and the table it writes to.
 */
export function advanceBapWatermark(params: AdvanceBapWatermarkParams): BapDigestWatermark {
  const agentId = normalizeAgentId(params.agent_id);
  const scope = normalizeScope(params.business_id);
  const now = new Date().toISOString();
  const existing = getBapWatermark(agentId, scope);

  const through = (() => {
    if (!existing) return params.acknowledged_through;
    const prev = Date.parse(existing.acknowledged_through);
    const next = Date.parse(params.acknowledged_through);
    if (Number.isNaN(next)) return existing.acknowledged_through;
    if (Number.isNaN(prev)) return params.acknowledged_through;
    return next > prev ? params.acknowledged_through : existing.acknowledged_through;
  })();

  const mergedItems: Record<string, string> = { ...(existing?.acknowledged_items ?? {}), ...params.items };

  if (existing) {
    db.prepare(`
      UPDATE bap_digest_watermarks
         SET acknowledged_through = ?, acknowledged_at = ?, acknowledged_digest_id = ?,
             item_count = ?, acknowledged_items = ?, updated_at = ?
       WHERE id = ?
    `).run(
      through, now, params.acknowledged_digest_id ?? null,
      Object.keys(params.items).length, JSON.stringify(mergedItems), now, existing.id,
    );
    return getBapWatermark(agentId, scope) as BapDigestWatermark;
  }

  db.prepare(`
    INSERT INTO bap_digest_watermarks (
      id, agent_id, business_id, acknowledged_through, acknowledged_at,
      acknowledged_digest_id, item_count, acknowledged_items, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId(), agentId, scope, through, now,
    params.acknowledged_digest_id ?? null, Object.keys(params.items).length,
    JSON.stringify(mergedItems), now, now,
  );
  return getBapWatermark(agentId, scope) as BapDigestWatermark;
}

/** Clear an agent's watermark — used only by test teardown here; no BAP route exposes this. */
export function resetBapWatermark(
  agentId: string | null | undefined,
  businessId: string | null | undefined,
): void {
  db.prepare('DELETE FROM bap_digest_watermarks WHERE agent_id = ? AND business_id = ?')
    .run(normalizeAgentId(agentId), normalizeScope(businessId));
}
