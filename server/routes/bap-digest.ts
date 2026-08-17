/**
 * Blueprint Agent Protocol (BAP) — "While you were away" digest (issue #81).
 *
 * The agent-facing surface for #62's catch-up digest
 * (server/digest/away-digest.ts), previously reachable only through the
 * session-authenticated dashboard route (server/routes/digest.ts). An agent
 * resuming after a gap — a restart, a scheduled off period — gets the same
 * bounded, deduplicated, evidence-cited four-section catch-up a human
 * operator gets, instead of re-polling every surface from scratch.
 *
 * Nothing about the digest's assembly is reimplemented here: this file
 * resolves WHO is asking, then calls the same buildAwayDigest() the
 * dashboard calls, so an agent and a human reading the same business see the
 * same escalation-aware dedup, the same four epistemic sections and the same
 * "never a claim without a citation" guarantee (see away-digest.ts's
 * docstring — not repeated here).
 *
 * ─── The watermark is a genuinely separate dimension from the dashboard's ───
 *
 * #62's watermark is keyed on the dashboard SESSION USERNAME — correct for a
 * single-operator dashboard, meaningless for a BAP agent, which has no
 * username and authenticates via `BAP-Key` instead. Reusing that table would
 * either collide an agent's catch-up point with its operator's, or require
 * fabricating a fake username for the agent. Neither is honest, so this
 * route reads/writes a PHYSICALLY SEPARATE table
 * (`bap_digest_watermarks`, server/digest/bap-digest-watermark.ts) keyed on
 * `bapAgent.id` — the same identity `requirePermission()`/`hasPermission()`
 * already use to decide what this caller may see. A human operator and their
 * Hermes/BAP agent therefore each have their own independently-progressing
 * "since I last checked" cursor for the exact same business: acknowledging
 * one can never advance, or be blocked by, the other.
 *
 * away-digest.ts's buildAwayDigest() takes a `getWatermark` override for
 * exactly this reason (see its DigestRequest type) — the dedup/escalation
 * logic is identical for both callers, only the watermark STORE differs.
 *
 * ─── Read-only, with an explicit acknowledgement step ───────────────────────
 *
 * Mirrors the dashboard's own behaviour exactly: GET never advances the
 * watermark as a side effect, no matter how many times it is called — a
 * polling agent can safely re-GET without losing track of what it has
 * genuinely acknowledged. Advancing requires a separate
 * `POST .../digest/acknowledge` call, same as the dashboard's
 * `POST /api/digest/acknowledge`. This is a deliberate choice, not an
 * oversight — see AGENT-GUIDE.md's Digest section for why a Hermes-style
 * caller that polls repeatedly needs to know this up front.
 *
 * `?since=` explicitly overrides the stored watermark for one read (both the
 * window floor and the seen-item suppression) WITHOUT mutating it — a
 * one-off look back at a period must not cost the agent its catch-up
 * position, exactly as the dashboard's own `since=` behaves.
 *
 * ─── Authorization ───────────────────────────────────────────────────────────
 *
 * Business-scoped like bap-receipts.ts / bap-decision-queue.ts:
 * `requirePermission('digest:read')` resolves `:businessId` from the path
 * and checks it against the agent's `business_access` grant — an agent
 * naming a business outside its grant is refused with 403 before the
 * business-existence check ever runs, so the response never leaks which
 * business IDs are real.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET  /businesses/:businessId/digest             — the catch-up digest
 *   GET  /businesses/:businessId/digest/watermark    — current catch-up point
 *   POST /businesses/:businessId/digest/acknowledge  — advance this agent's watermark
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import { buildAwayDigest, DIGEST_SCHEMA_VERSION } from '../digest/away-digest.js';
import { getBapWatermark, advanceBapWatermark } from '../digest/bap-digest-watermark.js';

const router = Router();

const PERMISSION = 'digest:read';

function agentOf(req: Request): Record<string, unknown> {
  return (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
}

function agentIdOf(req: Request): string {
  return String(agentOf(req).id ?? 'unknown');
}

function businessExists(businessId: string): boolean {
  return !!db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
}

/** Reject a malformed date rather than silently falling back to a default. */
function parseIsoParam(raw: unknown, name: string): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null };
  const t = Date.parse(String(raw));
  if (Number.isNaN(t)) return { error: `Invalid ${name} — expected an ISO-8601 timestamp.` };
  return { value: new Date(t).toISOString() };
}

/**
 * GET /businesses/:businessId/digest
 * Query: since=<ISO>, until=<ISO>, limit=<n>
 *
 * `since` overrides this agent's stored watermark for this one read (window
 * floor AND seen-item suppression) without mutating it. Omit it to read
 * "everything since I last acknowledged".
 */
router.get('/businesses/:businessId/digest', requirePermission(PERMISSION), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);
    }

    const since = parseIsoParam(req.query.since, 'since');
    if ('error' in since) return sendError(req, res, 400, 'validation_error', since.error);
    const until = parseIsoParam(req.query.until, 'until');
    if ('error' in until) return sendError(req, res, 400, 'validation_error', until.error);
    if (since.value && until.value && Date.parse(since.value) > Date.parse(until.value)) {
      return sendError(req, res, 400, 'validation_error', '`since` must be earlier than `until`.');
    }

    const agentId = agentIdOf(req);
    const digest = buildAwayDigest({
      operator_key: agentId,
      business_id: businessId,
      since: since.value,
      until: until.value,
      limit: parseInt(String(req.query.limit ?? ''), 10) || undefined,
      getWatermark: (op, scope) => getBapWatermark(op, scope),
    });

    return res.json(digest);
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error)?.message ?? 'Failed to build digest.');
  }
});

/**
 * GET /businesses/:businessId/digest/watermark
 *
 * This agent's own catch-up point for this business — read-only, no side
 * effect. Useful for a polling caller to check whether it has anything
 * unacknowledged before deciding whether to acknowledge.
 */
router.get('/businesses/:businessId/digest/watermark', requirePermission(PERMISSION), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);
    }
    const watermark = getBapWatermark(agentIdOf(req), businessId);
    return res.json({ digest_schema_version: DIGEST_SCHEMA_VERSION, watermark });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error)?.message ?? 'Failed to read digest watermark.');
  }
});

/**
 * POST /businesses/:businessId/digest/acknowledge
 * Body: { acknowledged_through?, digest_id?, items? }
 *
 * Advances THIS AGENT'S OWN watermark — never the dashboard operator's, and
 * never another agent's; the identity is taken from the validated BAP key,
 * never from the request body, for the same reason the dashboard route
 * takes it from the session rather than trusting a client-supplied
 * operator_key.
 *
 * `items` is the digest's `acknowledgeable` map. When omitted, the server
 * rebuilds the current digest (using this agent's own watermark) and
 * acknowledges exactly what it would have shown — so acknowledging without
 * echoing state back can never mark items read that this agent never saw.
 */
router.post('/businesses/:businessId/digest/acknowledge', requirePermission(PERMISSION), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) {
      return sendError(req, res, 404, 'not_found', `Business '${businessId}' not found.`);
    }

    const agentId = agentIdOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const through = parseIsoParam(body['acknowledged_through'], 'acknowledged_through');
    if ('error' in through) return sendError(req, res, 400, 'validation_error', through.error);

    let items = body['items'] as Record<string, string> | undefined;
    let acknowledgedThrough = through.value;
    let digestId = (body['digest_id'] as string | null | undefined) ?? null;

    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      const digest = buildAwayDigest({
        operator_key: agentId,
        business_id: businessId,
        getWatermark: (op, scope) => getBapWatermark(op, scope),
      });
      items = digest.acknowledgeable;
      acknowledgedThrough = acknowledgedThrough ?? digest.window.end;
      digestId = digestId ?? digest.digest_id;
    }

    const watermark = advanceBapWatermark({
      agent_id: agentId,
      business_id: businessId,
      acknowledged_through: acknowledgedThrough ?? new Date().toISOString(),
      acknowledged_digest_id: digestId,
      items,
    });

    return res.json({ ok: true, watermark });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error)?.message ?? 'Failed to acknowledge digest.');
  }
});

export default router;
