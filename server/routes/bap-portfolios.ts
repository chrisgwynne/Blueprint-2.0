/**
 * Blueprint Agent Protocol (BAP) — Multi-business portfolios (issue #80).
 *
 * The agent-facing surface for #71's saved portfolios and their comparative,
 * honesty-marked cross-business view, previously reachable only through the
 * session-authenticated dashboard route (server/routes/portfolios.ts). An
 * agent running several businesses under one grouping — "UK shops", "Q3
 * turnaround" — can now read that grouping's membership, how it changed, and
 * the per-metric comparison over it, instead of fetching each business
 * separately and inventing its own cross-business arithmetic.
 *
 * ─── NOT the same "portfolio" as #68's operating-policy portfolios ──────────
 *
 * Two stored things in this codebase are called a portfolio, in two different
 * tables, with two incompatible rules. Read this before adding anything here:
 *
 *   #68  `operating_policy_portfolios` (server/policy/operating-policy.ts)
 *        → a POLICY grouping, used only to apply one operating policy across
 *          several businesses. It must PARTITION: upsertPolicyPortfolio()
 *          rejects a business that is already in another one, because policy
 *          inheritance has no defined answer to "which of my two portfolios'
 *          thresholds wins". Exposed over BAP indirectly, as the resolved
 *          policy on `GET /businesses/:id/operating-policy`
 *          (`operating_policies:read`, bap-operating-policies.ts).
 *
 *   #71  `portfolios` (server/portfolio/portfolio-registry.ts)
 *        → THIS FILE. A general-purpose reporting grouping, with real
 *          OVERLAPPING membership: the same shop is legitimately in "UK
 *          shops" and in "Q3 turnaround" at the same time, and an operator
 *          comparing both groupings is doing the normal thing. Membership is
 *          rows, not a JSON column, because the past is load-bearing — a
 *          comparison window spanning a membership change is not like-for-
 *          like, and the view is required to say so.
 *
 * They are separate tables on purpose (see portfolio-registry.ts's own
 * docstring): widening #68's to allow overlap would break policy inheritance
 * for every business in two portfolios. Everything below reads the #71
 * registry and nothing here consults the policy table — `resolveOperatingPolicy()`
 * remains the only reader of that one. A #68 portfolio can SEED a #71
 * portfolio (importPolicyPortfolio) but the copy is independent from that
 * moment on, and that import is a dashboard write with no BAP path.
 *
 * ─── Read-only, deliberately ────────────────────────────────────────────────
 *
 * No create/rename/delete and no membership writes, matching
 * bap-operating-policies.ts and bap-decision-queue.ts. Curating which
 * businesses are compared together is an operator's editorial act about how
 * they want to see their own business, not a thing an agent should reshape
 * while being measured by it. The dashboard route keeps the full CRUD.
 *
 * ─── Authorization, and what happens to a portfolio that is only partly yours ─
 *
 * Unlike almost every other BAP route, these paths carry no `:businessId` —
 * a portfolio spans businesses by definition. So `requirePermission()` here
 * checks the GRANT only, and business scoping is applied explicitly from the
 * agent's own `business_access` list, passed into #71's registry as a scope
 * narrowing that is INTERSECTED with the ambient resolver and can therefore
 * only ever remove businesses, never add one.
 *
 * A portfolio containing a business outside the agent's access returns the
 * ACCESSIBLE SLICE, with the remainder counted and explicitly marked — it is
 * not denied outright, and it is not silently shrunk. That is #71's existing
 * rule ("silently shrinking the list would make a partial portfolio look
 * complete"), it is what the dashboard already does, and it is what #59's
 * command centre does with a selection that reaches past what the actor can
 * see. Inventing a third behaviour for agents would mean the same portfolio
 * reads differently depending on who asked.
 *
 * What is withheld is absolute: the inaccessible members' ids, names, and
 * every figure derived from them. The comparison is COMPUTED over the
 * accessible slice only, so no inaccessible business contributes to a rank,
 * a total or a caveat. What travels instead is a count and an `access` block
 * saying the read is partial, so an agent can never mistake part of a
 * portfolio for all of it.
 *
 * A portfolio with NO accessible member is a 403, not a 200-with-nothing and
 * not a 404 — the same `empty_scope` refusal comparePortfolio() already
 * raises, so all three endpoints here behave alike.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside bap.ts's
 * already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET /portfolios                  — portfolios containing ≥1 accessible business
 *   GET /portfolios/:id              — membership + membership-change history
 *   GET /portfolios/:id/comparison   — the per-metric comparative view
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import {
  listMembershipHistory, listPortfolios, PortfolioError, requirePortfolio,
  type Portfolio,
} from '../portfolio/portfolio-registry.js';
import { comparePortfolio } from '../portfolio/portfolio-comparison.js';

const router = Router();

const DEFAULT_HISTORY_LIMIT = 50;

function agentOf(req: Request): Record<string, unknown> {
  return (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
}

function safeJSON<T>(val: unknown, fallback: T): T {
  if (Array.isArray(val)) return val as unknown as T;
  if (!val) return fallback;
  try { return JSON.parse(val as string) as T; } catch { return fallback; }
}

/**
 * The agent's business scope, or undefined for a wildcard grant.
 *
 * `undefined` means "do not narrow", which leaves the registry's ambient
 * resolver in sole charge — correct for `business_access: ["*"]`, and the
 * reason this returns undefined rather than an empty array for that case.
 * An agent with an empty grant gets `[]`, which intersects to nothing and so
 * can read no portfolio at all.
 */
function businessScopeOf(req: Request): readonly string[] | undefined {
  const access = safeJSON<string[]>(agentOf(req).business_access, []);
  return access.includes('*') ? undefined : access;
}

/**
 * The honesty block that rides alongside every portfolio in this file.
 *
 * `complete: false` is the one thing an agent must not miss, so it is stated
 * as a boolean, a count and a sentence rather than left to be inferred from
 * `hidden_member_count > 0`.
 */
function accessBlock(portfolio: Portfolio): Record<string, unknown> {
  const hidden = portfolio.hidden_member_count;
  return {
    complete: hidden === 0,
    visible_member_count: portfolio.business_ids.length,
    excluded_member_count: hidden,
    note: hidden === 0
      ? 'Every business in this portfolio is within your business_access grant.'
      : `${hidden} business(es) in this portfolio are outside your business_access grant and are `
        + 'excluded from the membership, the history and every figure in the comparison. Their ids '
        + 'and names are withheld. This is part of the portfolio, not all of it — do not report it '
        + 'as the whole.',
  };
}

function handleError(req: Request, res: Response, err: unknown): void {
  if (err instanceof PortfolioError) {
    // PortfolioError statuses map onto BAP codes directly; 403 here is
    // `empty_scope` (nothing in the portfolio is readable), never a missing
    // grant — that is caught earlier by requirePermission.
    const code = err.status === 404 ? 'not_found'
      : err.status === 403 ? 'permission_denied'
      : err.status >= 500 ? 'internal_error'
      : 'validation_error';
    return sendError(req, res, err.status, code, err.message);
  }
  return sendError(req, res, 500, 'internal_error', (err as Error)?.message ?? 'Portfolio request failed.');
}

/**
 * The actor recorded against these reads.
 *
 * Prefixed `bap:` and never `dashboard:` — #68's autonomy gate reads exactly
 * that prefix to tell a human act from an unattended one. Nothing here
 * writes, but the attribution stays truthful regardless.
 */
function actorOf(req: Request): string {
  return `bap:${String(agentOf(req).id ?? 'unknown')}`;
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * GET /portfolios
 *
 * Portfolios containing at least one business the agent may read.
 *
 * A portfolio with no accessible member is omitted entirely rather than
 * listed as empty: an agent has no use for the existence of a grouping whose
 * every member is invisible to it, and listing it would turn this endpoint
 * into an enumeration of other operators' groupings. `total` counts what is
 * returned, so it can never imply there is more.
 */
router.get('/portfolios', requirePermission('portfolios:read'), (req: Request, res: Response) => {
  try {
    const scope = businessScopeOf(req);
    const visible = listPortfolios(actorOf(req), { scope })
      .filter((p) => p.business_ids.length > 0);
    return res.json({
      portfolios: visible.map((portfolio) => ({ ...portfolio, access: accessBlock(portfolio) })),
      total: visible.length,
      partial_portfolios: visible.filter((p) => p.hidden_member_count > 0).length,
    });
  } catch (err) {
    return handleError(req, res, err);
  }
});

// ─── One portfolio ───────────────────────────────────────────────────────────

/**
 * GET /portfolios/:portfolioId
 *
 * Membership plus the membership-change history the registry keeps.
 *
 * History is included inline rather than behind a second call because it is
 * the thing that makes membership interpretable: a portfolio that gained a
 * business last week is not the same comparison subject it was a month ago,
 * and an agent reading membership without that is reading a snapshot as if
 * it were a constant. Events about businesses outside the grant are dropped
 * by the registry — the history is exactly as scoped as the membership it
 * describes. `?history_limit=0` skips it.
 */
router.get('/portfolios/:portfolioId', requirePermission('portfolios:read'), (req: Request, res: Response) => {
  try {
    const scope = businessScopeOf(req);
    const actor = actorOf(req);
    const portfolioId = String(req.params.portfolioId);

    const rawLimit = req.query.history_limit;
    let historyLimit = DEFAULT_HISTORY_LIMIT;
    if (rawLimit != null) {
      const parsed = Number.parseInt(String(rawLimit), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return sendError(req, res, 400, 'validation_error',
          'history_limit must be a non-negative number (0 omits the history).');
      }
      historyLimit = parsed;
    }

    // requirePortfolio 404s an unknown id and scopes membership; the
    // accessible-slice check below is what turns "exists but none of it is
    // yours" into a refusal rather than an empty-looking success.
    const portfolio = requirePortfolio(portfolioId, actor, { scope });
    if (portfolio.business_ids.length === 0) {
      return sendError(req, res, 403, 'permission_denied',
        `No business in portfolio '${portfolio.name}' is within your business_access grant.`);
    }

    const history = historyLimit === 0
      ? []
      : listMembershipHistory(portfolioId, actor, { scope, limit: historyLimit });

    return res.json({
      portfolio,
      access: accessBlock(portfolio),
      membership_history: history,
      membership_history_limit: historyLimit,
    });
  } catch (err) {
    return handleError(req, res, err);
  }
});

// ─── The comparison ──────────────────────────────────────────────────────────

/**
 * GET /portfolios/:portfolioId/comparison
 *
 * #71's per-metric comparative view, returned VERBATIM.
 *
 * Nothing is flattened, rounded, re-keyed or summarised for the agent. That
 * matters most for the honesty markings, which are the whole reason this view
 * exists and the easiest thing for a convenience layer to destroy:
 *
 *   • Every cell is a ComparableField with a `state` of `known` / `unknown` /
 *     `not_comparable` and a citation or reason. An `unknown` is never a
 *     zero — "we could not measure this" and "this is zero" are different
 *     claims — and a `not_comparable` is never coerced to null or dropped.
 *   • A `not_comparable` metric row carries `ranking: null` and an aggregate
 *     whose own field is `not_comparable`, so there is no ranked number for
 *     an agent to read off. The reason states why: currency figures derived
 *     from directly observed revenue and figures derived by applying
 *     benchmark coefficients to a proxy metric are both "$/month" and are not
 *     the same kind of number. `coverage.not_comparable_metrics` lists every
 *     such row up front.
 *   • `caveats` are plain sentences meant to be read before acting, including
 *     membership changes inside the window and any partial access.
 *
 * Always 200 once the portfolio resolves and something in it is readable: a
 * business that could not be loaded is an `unavailable` column inside the
 * payload, never an error status, because one broken business must not cost
 * the agent the comparison of the others.
 */
router.get('/portfolios/:portfolioId/comparison', requirePermission('portfolios:read'), (req: Request, res: Response) => {
  try {
    const rawWindow = req.query.window_days;
    let windowDays: number | undefined;
    if (rawWindow != null) {
      const parsed = Number.parseInt(String(rawWindow), 10);
      if (!Number.isFinite(parsed)) {
        return sendError(req, res, 400, 'validation_error', 'window_days must be a number.');
      }
      windowDays = parsed;
    }

    const comparison = comparePortfolio({
      portfolioId: String(req.params.portfolioId),
      actor: actorOf(req),
      windowDays,
      businessScope: businessScopeOf(req),
    });

    return res.json({
      ...comparison,
      access: {
        complete: comparison.portfolio.hidden_member_count === 0,
        visible_member_count: comparison.portfolio.business_ids.length,
        excluded_member_count: comparison.portfolio.hidden_member_count,
        note: comparison.portfolio.hidden_member_count === 0
          ? 'Every business in this portfolio is within your business_access grant.'
          : `${comparison.portfolio.hidden_member_count} business(es) in this portfolio are outside `
            + 'your business_access grant. They contributed to no cell, no rank, no total and no '
            + 'caveat below — this comparison covers part of the portfolio, not all of it.',
      },
    });
  } catch (err) {
    return handleError(req, res, err);
  }
});

export default router;
