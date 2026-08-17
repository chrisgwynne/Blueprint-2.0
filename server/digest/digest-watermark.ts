/**
 * Digest watermarks — "how far have I actually caught up?" (issue #62).
 *
 * The digest's defining promise is that acknowledging it is durable: the
 * next digest must not replay what you already read, but must not hide a
 * material change either. Those two requirements pull in opposite
 * directions, and a single timestamp cannot satisfy both.
 *
 * Consider a pending decision that has been sitting in the queue for a
 * week. Its `created_at` is old, so a pure time watermark hides it forever
 * after the first acknowledgement — even if its risk tier escalates from
 * green to red tomorrow. Conversely, keying only on item identity (and
 * never on time) means every long-lived open item reappears in every
 * digest for the rest of its life.
 *
 * So a watermark stores BOTH:
 *
 *   acknowledged_through — a time floor. Newly-created things after this
 *     instant are, by definition, new to this operator. This is what makes
 *     the default digest window "since I last caught up".
 *
 *   acknowledged_items   — a {dedup_key: change_fingerprint} map covering
 *     every item that appeared in the acknowledged digest. An item is
 *     suppressed on the next digest iff it is present in this map AND its
 *     fingerprint still matches. A changed fingerprint means something
 *     material moved, so it is replayed and flagged as changed rather than
 *     presented as brand new.
 *
 * The fingerprint is computed by the assembly layer (away-digest.ts), which
 * is the only place that knows which fields of a given item kind are
 * material (a connector's health state, a decision's risk tier) versus
 * incidental (an `updated_at` that ticks on every scan). This module is
 * deliberately ignorant of that: it stores and compares opaque strings.
 *
 * ─── Identity ───────────────────────────────────────────────────────────────
 *
 * Blueprint's auth is single-operator: ADMIN_PASSWORD plus a session whose
 * userId is the username (server/routes/auth.ts). There is no users table.
 * The watermark is therefore keyed on that session username as an opaque
 * `operator_key`, scoped per business. Introducing real multi-user auth
 * later requires no change here — only a different value in that column.
 */
import db, { generateId } from '../db/db.js';

/** Scope value used for the cross-business ("all businesses") digest. */
export const ALL_BUSINESSES = '*';

/** Fallback identity when a caller has no session username at all. */
export const DEFAULT_OPERATOR = 'owner';

export interface DigestWatermark {
  id: string;
  operator_key: string;
  business_id: string;
  /** Everything at or before this instant has been acknowledged. */
  acknowledged_through: string;
  acknowledged_at: string;
  acknowledged_by: string | null;
  acknowledged_digest_id: string | null;
  item_count: number;
  /** dedup_key → change_fingerprint for every item in the acknowledged digest. */
  acknowledged_items: Record<string, string>;
  created_at: string;
  updated_at: string;
}

function parseRow(row: Record<string, unknown>): DigestWatermark {
  let items: Record<string, string> = {};
  try {
    const raw = row['acknowledged_items'];
    if (typeof raw === 'string' && raw) {
      const parsed = JSON.parse(raw) as unknown;
      // A corrupted or hand-edited blob must degrade to "nothing is known to
      // be acknowledged" — which replays items — rather than to a crash or,
      // far worse, to silently suppressing everything.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        items = parsed as Record<string, string>;
      }
    }
  } catch {
    items = {};
  }
  return { ...(row as unknown as DigestWatermark), acknowledged_items: items };
}

/**
 * Normalise a scope argument. An empty/absent business id means the
 * cross-business digest, which has its own watermark row.
 */
export function normalizeScope(businessId: string | null | undefined): string {
  const v = (businessId ?? '').trim();
  return v === '' || v === ALL_BUSINESSES ? ALL_BUSINESSES : v;
}

export function normalizeOperator(operatorKey: string | null | undefined): string {
  const v = (operatorKey ?? '').trim();
  return v === '' ? DEFAULT_OPERATOR : v;
}

export function getWatermark(
  operatorKey: string | null | undefined,
  businessId: string | null | undefined,
): DigestWatermark | null {
  const row = db.prepare(
    'SELECT * FROM digest_watermarks WHERE operator_key = ? AND business_id = ?'
  ).get(normalizeOperator(operatorKey), normalizeScope(businessId)) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : null;
}

export interface AdvanceWatermarkParams {
  operator_key: string | null | undefined;
  business_id: string | null | undefined;
  /** The instant being acknowledged through — normally the digest window end. */
  acknowledged_through: string;
  acknowledged_by?: string | null;
  acknowledged_digest_id?: string | null;
  /** dedup_key → change_fingerprint for every item shown in the digest. */
  items: Record<string, string>;
}

/**
 * Record an acknowledgement.
 *
 * Monotonic in time: a stale or out-of-order acknowledgement (e.g. a second
 * browser tab acknowledging an older digest it had open) can never drag the
 * watermark backwards and cause already-read items to be replayed. The item
 * fingerprint map from the newer acknowledgement is still merged in, so a
 * late-arriving acknowledgement contributes what it knows without
 * rewinding.
 *
 * Merging (rather than replacing) the map also means an item that has
 * scrolled out of the current window keeps its acknowledged fingerprint, so
 * it stays suppressed if it later resurfaces unchanged.
 */
export function advanceWatermark(params: AdvanceWatermarkParams): DigestWatermark {
  const operator = normalizeOperator(params.operator_key);
  const scope = normalizeScope(params.business_id);
  const now = new Date().toISOString();
  const existing = getWatermark(operator, scope);

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
      UPDATE digest_watermarks
         SET acknowledged_through = ?, acknowledged_at = ?, acknowledged_by = ?,
             acknowledged_digest_id = ?, item_count = ?, acknowledged_items = ?, updated_at = ?
       WHERE id = ?
    `).run(
      through, now, params.acknowledged_by ?? null,
      params.acknowledged_digest_id ?? null,
      Object.keys(params.items).length,
      JSON.stringify(mergedItems), now, existing.id,
    );
    return getWatermark(operator, scope) as DigestWatermark;
  }

  db.prepare(`
    INSERT INTO digest_watermarks (
      id, operator_key, business_id, acknowledged_through, acknowledged_at,
      acknowledged_by, acknowledged_digest_id, item_count, acknowledged_items,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId(), operator, scope, through, now,
    params.acknowledged_by ?? null, params.acknowledged_digest_id ?? null,
    Object.keys(params.items).length, JSON.stringify(mergedItems), now, now,
  );
  return getWatermark(operator, scope) as DigestWatermark;
}

/**
 * Clear a watermark entirely — "treat me as having seen nothing".
 * Used by the explicit re-request path only when a caller asks to reset,
 * NOT by the ordinary `since=` override (which leaves the watermark intact
 * so a one-off look back at a period does not destroy catch-up state).
 */
export function resetWatermark(
  operatorKey: string | null | undefined,
  businessId: string | null | undefined,
): void {
  db.prepare('DELETE FROM digest_watermarks WHERE operator_key = ? AND business_id = ?')
    .run(normalizeOperator(operatorKey), normalizeScope(businessId));
}
