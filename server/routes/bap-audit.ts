/**
 * Blueprint Agent Protocol (BAP) — Audit.
 *
 * Closes the audit-log gap from AUDIT-BAP-GAPS.md: `audit_log` was only
 * reachable via a session-authenticated dashboard route
 * (server/routes/audit.ts). Covers task actions (create/approve/reject/
 * cancel/status changes), connector actions (create/update/delete),
 * agent actions, and business changes — everything server/db/db.ts's
 * `audit()` helper writes.
 *
 * Two things this route does that the dashboard's own audit reader
 * (server/routes/audit.ts) does NOT do, both deliberate hardening for an
 * external-facing surface:
 *   1. `entity_type` is validated against a fixed whitelist of types a
 *      dedicated research pass confirmed never carry secret-shaped data at
 *      any current call site — not `SELECT *` trusting every future
 *      caller of `audit()` to stay careful forever.
 *   2. `before_state`/`after_state`/`metadata` are passed through a
 *      key-shaped redaction pass (any key matching
 *      credential|secret|token|password|api_key is replaced with
 *      `"[redacted]"`) before serialization — defense-in-depth on top of
 *      (1), not a replacement for it.
 *
 * Endpoints:
 *   GET    /businesses/:bid/audit             — filterable, paginated audit trail
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission } from '../bap/auth.js';
import { parsePagination, paginationMeta, normalizeTimestamps, sendError } from '../bap/route-helpers.js';

// No blanket auth/rate-limit middleware here — see bap-goals.ts's
// docstring on this file's mounting inside bap.ts's already-authenticated
// router chain.
const router = Router();

// Confirmed via research (see PHASE2.md) to never carry credential/secret
// data at any current audit()/raw-INSERT call site. A future entity_type
// must be explicitly added here to become BAP-visible — not exposed by
// default just because something wrote to audit_log.
const AUDIT_ENTITY_WHITELIST = new Set(['task', 'signal', 'business', 'connector', 'agent', 'agent_file', 'server_file']);

const REDACT_KEY_PATTERN = /credential|secret|token|password|api[_-]?key/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY_PATTERN.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

function safeJSON(val: unknown): unknown {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val as string); } catch { return null; }
}

router.get('/businesses/:businessId/audit', requirePermission('audit:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { entity_type, entity_id, action, actor, date_from, date_to } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (entity_type) {
      const requested = String(entity_type).split(',');
      const allowed = requested.filter((t) => AUDIT_ENTITY_WHITELIST.has(t));
      if (!allowed.length) {
        return sendError(req, res, 400, 'validation_error', `entity_type must be one of: ${Array.from(AUDIT_ENTITY_WHITELIST).join(', ')}.`);
      }
      conditions.push(`entity_type IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    } else {
      // No filter supplied — still scope to the whitelist, not "everything
      // in the table", so a new unreviewed entity_type added elsewhere in
      // the codebase doesn't silently become BAP-visible.
      conditions.push(`entity_type IN (${Array.from(AUDIT_ENTITY_WHITELIST).map(() => '?').join(',')})`);
      params.push(...Array.from(AUDIT_ENTITY_WHITELIST));
    }
    if (entity_id) { conditions.push('entity_id = ?'); params.push(String(entity_id)); }
    if (action) {
      const arr = String(action).split(',');
      conditions.push(`action IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (actor) {
      const arr = String(actor).split(',');
      conditions.push(`actor IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (date_from) { conditions.push('created_at >= ?'); params.push(String(date_from)); }
    if (date_to) { conditions.push('created_at <= ?'); params.push(String(date_to)); }

    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM audit_log WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = (db.prepare(
      `SELECT id, entity_type, entity_id, action, actor, before_state, after_state, metadata, created_at
       FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>).map((r) => normalizeTimestamps({
      ...r,
      before_state: redact(safeJSON(r.before_state)),
      after_state: redact(safeJSON(r.after_state)),
      metadata: redact(safeJSON(r.metadata)),
    }, ['created_at']));

    return res.json({ entries: rows, total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
