/**
 * Blueprint Agent Protocol (BAP) — Executive command centre (issue #79).
 *
 * The agent-facing surface for #59's cross-business summary
 * (server/executive/command-centre.ts), previously reachable only through
 * the session-authenticated dashboard route (server/routes/command-centre.ts).
 *
 * An agent operating across several businesses had to make one BAP call per
 * business per surface — decision queue, receipts, connector health, ROI —
 * and assemble its own priority picture from the pieces. The command centre
 * already does exactly that join, with per-section failure isolation and an
 * evidence link on every line. Recomputing it agent-side would be wasteful
 * and, worse, would drift: the agent's ranking and the operator's dashboard
 * would come to disagree about which business needs attention first, with no
 * way to tell which one was right.
 *
 * So nothing is re-derived here. This file resolves WHO is asking and WHAT
 * they may read, then calls assembleCommandCentre() — the same entry point
 * the dashboard calls, which internally uses summariseBusiness() and
 * section(). The payload is returned verbatim, `status`/`failed_sections`/
 * `excluded` included, so an agent and a human are provably looking at the
 * same reading of the same businesses.
 *
 * ─── NOT the per-business surfaces it summarises ────────────────────────────
 *
 * Every section here has its own dedicated BAP endpoint, and this one does
 * not replace any of them:
 *
 *   decisions        GET /businesses/:id/decision-queue   `decision_queue:read`
 *   verified_changes GET /businesses/:id/receipts         `receipts:read`
 *   outcomes         GET /businesses/:id/outcomes         `outcomes:read`
 *   connectors       GET /businesses/:id/connectors/…     `connectors:read`
 *
 * Those return the full records; this returns a bounded, ranked SUMMARY over
 * many businesses — `sample_size` items per section, not the whole list. An
 * agent triages here and then drills into the owning surface via each item's
 * `evidence.id`. Holding `command_centre:read` therefore confers a genuinely
 * different view rather than a shortcut around the other four grants, which
 * is also why it is a separate grant: an operator can hand out the executive
 * overview without handing out every receipt body.
 *
 * ─── Scoping: the agent's grant IS the accessible set ───────────────────────
 *
 * This is the one route in BAP that deliberately spans businesses, so it
 * cannot lean on `requirePermission()`'s usual `:businessId` path check —
 * there is no business in the path. The grant is enforced explicitly instead:
 *
 *   1. `requirePermission('command_centre:read')` — the agent holds the
 *      grant at all (business scope is not resolvable from this path, so
 *      that middleware checks the permission only; see below).
 *   2. Every id the caller named is re-checked with `hasPermission()`
 *      against the agent's `business_access` — the same per-record re-check
 *      bap-receipts.ts and bap-decision-queue.ts do for their ID-addressed
 *      lookups.
 *   3. The engine's own scope is overridden with the agent's grant
 *      (`accessibleBusinessIds`), so even the no-selection default —
 *      "everything I can see" — means everything THIS AGENT can see, not
 *      every business in the database.
 *
 * Step 3 matters as much as step 2. listAccessibleBusinessIds() returns all
 * businesses, which is truthful for a single-tenant dashboard session and
 * would be a cross-tenant leak here.
 *
 * ─── Out-of-grant business ids are a hard 403, naming them ──────────────────
 *
 * If the caller names a business outside its grant, the whole request is
 * refused with 403 `permission_denied` and a `denied_business_ids` list. It
 * is NOT served as a partial summary of the ids that were allowed.
 *
 * This follows the established BAP convention for "some of what you asked
 * for isn't yours": bap-comparisons.ts refuses a candidate set spanning
 * another business with a 422 naming the offending id rather than comparing
 * the reachable subset, and bap-receipts.ts / bap-decision-queue.ts answer
 * 403 for a record whose business is outside the grant. The shared rule is
 * that BAP never quietly returns a narrower answer than the one requested —
 * an agent that cannot tell "these three are all there is" from "these three
 * are all you were allowed" will report the subset as the total. 403 rather
 * than 422 because the reason is authorization, not request shape.
 *
 * Note this diverges from the dashboard's behaviour, deliberately. There, an
 * inaccessible id becomes an `unavailable` row inside a 200, because on a
 * single-tenant session an id can only be unreachable if it does not exist
 * or could not be loaded — never because it belongs to someone else. Under
 * BAP a real per-agent ACL exists, so an `unavailable` row would conflate
 * "not yours" with "broken", and an agent would retry a permissions problem
 * as though it were an outage.
 *
 * The refusal reveals nothing beyond the request: it echoes which of the
 * ids YOU sent are outside YOUR grant, and never whether they exist — the
 * same posture the engine takes with one message for "does not exist" and
 * "not available in scope".
 *
 * `/command-centre/scope` exists so this strictness is fair: an agent can
 * ask what it may select before selecting, instead of learning its own grant
 * by being refused.
 *
 * ─── No `portfolio_id` here ─────────────────────────────────────────────────
 *
 * The dashboard route accepts `?portfolio_id=` as a shorthand for a
 * selection, expanding #68's policy portfolios. That is not offered over
 * BAP. A portfolio is an operator-authored grouping whose membership can
 * change without the agent's knowledge, so its expansion could silently add
 * or drop businesses between two otherwise identical calls, and a member
 * outside the grant would be a set the agent never named — recreating
 * exactly the "rejected or silently dropped?" ambiguity the rule above
 * exists to remove. An agent names the businesses it wants; `/scope` tells
 * it which those can be.
 *
 * ─── Read-only ──────────────────────────────────────────────────────────────
 *
 * Both endpoints are GETs and the module writes nothing. #59 has no write
 * path at all — approving a decision goes through the decision queue, which
 * re-derives the item's policy standing at the moment of the decision — and
 * a "quick approve" from a summary card would skip that, for a human or an
 * agent alike.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET /command-centre        — the cross-business summary
 *   GET /command-centre/scope  — which businesses this agent may select
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import {
  assembleCommandCentre, CommandCentreError, listAccessibleBusinessIds,
  MAX_SELECTION,
} from '../executive/command-centre.js';

const router = Router();

const PERMISSION = 'command_centre:read';

function agentOf(req: Request): Record<string, unknown> {
  return (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
}

/** Stable actor string for this agent — audit-friendly, mirrors `dashboard:{id}`. */
function actorOf(agent: Record<string, unknown>): string {
  return `bap:${String(agent.id ?? 'unknown')}`;
}

/**
 * The businesses this agent's `business_access` grant covers.
 *
 * A wildcard grant (`['*']`) is expanded through listAccessibleBusinessIds()
 * — wildcard means "every business", and only that function is allowed to
 * say which those are. Ids are NOT filtered against the `businesses` table:
 * a grant naming a business that no longer exists should surface as an
 * `unavailable` row saying so, not vanish from the response as though the
 * grant had never mentioned it.
 */
function grantedBusinessIds(agent: Record<string, unknown>): string[] {
  const raw = agent.business_access;
  let access: unknown[] = [];
  if (Array.isArray(raw)) access = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) access = parsed; } catch { /* malformed grant → no access */ }
  }
  const ids = access.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  if (ids.includes('*')) return listAccessibleBusinessIds(actorOf(agent));
  return Array.from(new Set(ids));
}

/** Accepts `?business_ids=a,b,c` and/or repeated `?business_ids=a&business_ids=b`. */
function parseBusinessIds(raw: unknown): string[] {
  if (raw == null) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((p) => String(p).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * GET /command-centre/scope
 *
 * What this agent may select, and the limits a selection is subject to.
 * Deliberately reports the agent's grant rather than the business list, so
 * an agent building a selection cannot construct one that will be refused.
 */
router.get('/command-centre/scope', requirePermission(PERMISSION), (req: Request, res: Response) => {
  try {
    const ids = grantedBusinessIds(agentOf(req));
    const businesses = ids.length === 0 ? [] : db.prepare(
      `SELECT id, name, slug, type FROM businesses WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`
    ).all(...ids) as Array<Record<string, unknown>>;

    // Ids in the grant with no matching row are reported rather than
    // dropped: an agent whose grant points at a deleted business should be
    // told, not left wondering why its selection came back short.
    const present = new Set(businesses.map((b) => String(b.id)));
    return res.json({
      businesses,
      granted_business_ids: ids,
      unknown_business_ids: ids.filter((id) => !present.has(id)),
      max_selection: MAX_SELECTION,
      default_window_days: 30,
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

/**
 * GET /command-centre
 * Query: business_ids, window_days, sample_size
 *
 * Omitting `business_ids` means "every business I can see", bounded by the
 * grant. Returns 200 whenever the selection itself is valid: a business that
 * exists and is granted but could not be loaded comes back as an
 * `unavailable` row, and a single failed SECTION comes back as a `failed`
 * envelope beside its healthy siblings — one broken business or one broken
 * ROI report must not cost the caller everything else it asked for.
 */
router.get('/command-centre', requirePermission(PERMISSION), (req: Request, res: Response) => {
  try {
    const agent = agentOf(req);
    const granted = grantedBusinessIds(agent);

    if (granted.length === 0) {
      return sendError(req, res, 403, 'permission_denied',
        'Permission denied: this agent holds command_centre:read but has no businesses in its '
        + 'business_access grant, so there is nothing it may summarise.');
    }

    const requested = parseBusinessIds(req.query.business_ids);

    // Every named id is re-checked against the grant before anything is
    // assembled. hasPermission() is the same check every other business-
    // scoped BAP route uses, and it handles a wildcard grant correctly.
    const denied = Array.from(new Set(requested)).filter((id) => !hasPermission(agent, PERMISSION, id));
    if (denied.length > 0) {
      return sendError(req, res, 403, 'permission_denied',
        `Permission denied: ${denied.length === 1 ? 'business' : 'businesses'} ${denied.map((d) => `'${d}'`).join(', ')} `
        + `${denied.length === 1 ? 'is' : 'are'} not in this agent's business_access grant. `
        + 'The request was refused rather than answered for the remaining businesses, so a partial '
        + 'summary is never mistaken for a complete one. GET /command-centre/scope lists what you may select.',
        { denied_business_ids: denied });
    }

    const windowDaysRaw = req.query.window_days;
    const windowDays = windowDaysRaw == null ? undefined : Number.parseInt(String(windowDaysRaw), 10);
    if (windowDays !== undefined && !Number.isFinite(windowDays)) {
      return sendError(req, res, 400, 'validation_error', 'window_days must be a number.');
    }

    const sampleSizeRaw = req.query.sample_size;
    const sampleSize = sampleSizeRaw == null ? undefined : Number.parseInt(String(sampleSizeRaw), 10);
    if (sampleSize !== undefined && !Number.isFinite(sampleSize)) {
      return sendError(req, res, 400, 'validation_error', 'sample_size must be a number.');
    }

    const summary = assembleCommandCentre({
      actor: actorOf(agent),
      accessibleBusinessIds: granted,
      businessIds: requested,
      windowDays,
      sampleSize,
    });

    // `granted_business_ids` alongside the engine's own `requested_business_ids`:
    // the caller can see both what it asked for and the full set it was
    // entitled to ask for, which is how it tells a deliberate narrow
    // selection from an unexpectedly narrow grant.
    return res.json({ ...summary, granted_business_ids: granted });
  } catch (err) {
    if (err instanceof CommandCentreError) {
      // The engine's own refusals: an over-large explicit selection (422)
      // and an empty one (404). Mapped onto BAP's error codes rather than
      // re-messaged, so the reason reaching the agent is the engine's.
      const code = err.status === 404 ? 'not_found'
        : err.status === 422 ? 'validation_error'
          : 'validation_error';
      return sendError(req, res, err.status, code, err.message, { reason: err.code });
    }
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
