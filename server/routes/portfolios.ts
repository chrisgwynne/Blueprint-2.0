/**
 * Portfolio API (#71) — saved portfolios and the comparative view over them.
 *
 * Like routes/command-centre.ts (#59) this deliberately spans businesses,
 * and for the same reason it is safe to: the comparison is read-only, and
 * every selection is scoped by listAccessibleBusinessIds() rather than by
 * whatever ids the caller sent.
 *
 * The writes here are membership only. Creating a portfolio containing a
 * business does not grant any access to it, take any action on it, or change
 * anything the business itself owns — it records a grouping. Every operation
 * that acts on a business remains behind its own business-scoped route.
 *
 *   GET    /                       portfolios visible to this session
 *   POST   /                       create
 *   GET    /:id                    one portfolio
 *   PATCH  /:id                    rename / re-describe
 *   DELETE /:id                    delete (membership history is retained)
 *   POST   /:id/members            add businesses
 *   DELETE /:id/members            remove businesses
 *   GET    /:id/history            membership change history
 *   GET    /:id/comparison         the side-by-side comparison
 *   POST   /import-policy-portfolio  seed one from a #68 policy portfolio
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  addPortfolioMembers, createPortfolio, deletePortfolio, importPolicyPortfolio,
  listMembershipHistory, listPortfolios, PortfolioError, removePortfolioMembers,
  requirePortfolio, updatePortfolio,
} from '../portfolio/portfolio-registry.js';
import { comparePortfolio } from '../portfolio/portfolio-comparison.js';

const router = Router();
router.use(isAuthenticated);

function actorOf(req: Request): string {
  const userId = (req.session as unknown as { userId?: string } | undefined)?.userId;
  return `dashboard:${userId ?? 'unknown'}`;
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof PortfolioError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('[portfolios]', err);
  return res.status(500).json({ error: (err as Error)?.message ?? 'Portfolio request failed.' });
}

/** Accepts `["a","b"]` or `"a,b"` so the shape matches #59's selector params. */
function parseIds(raw: unknown): string[] {
  if (raw == null) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts.flatMap((p) => String(p).split(',')).map((s) => s.trim()).filter(Boolean);
}

router.get('/', (req: Request, res: Response) => {
  try {
    return res.json({ portfolios: listPortfolios(actorOf(req)) });
  } catch (err) {
    return handleError(res, err);
  }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const portfolio = createPortfolio({
      name: String(req.body?.name ?? ''),
      description: req.body?.description == null ? null : String(req.body.description),
      business_ids: parseIds(req.body?.business_ids),
      actor: actorOf(req),
    });
    return res.status(201).json({ portfolio });
  } catch (err) {
    return handleError(res, err);
  }
});

router.post('/import-policy-portfolio', (req: Request, res: Response) => {
  try {
    const sourceId = String(req.body?.policy_portfolio_id ?? '').trim();
    if (!sourceId) {
      return res.status(400).json({ error: 'policy_portfolio_id is required.', code: 'invalid_request' });
    }
    const portfolio = importPolicyPortfolio(
      sourceId, actorOf(req), req.body?.name == null ? undefined : String(req.body.name),
    );
    return res.status(201).json({ portfolio });
  } catch (err) {
    return handleError(res, err);
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    return res.json({ portfolio: requirePortfolio(String(req.params.id), actorOf(req)) });
  } catch (err) {
    return handleError(res, err);
  }
});

router.patch('/:id', (req: Request, res: Response) => {
  try {
    const portfolio = updatePortfolio(String(req.params.id), {
      name: req.body?.name == null ? undefined : String(req.body.name),
      description: req.body?.description === undefined ? undefined
        : req.body.description == null ? null : String(req.body.description),
    }, actorOf(req));
    return res.json({ portfolio });
  } catch (err) {
    return handleError(res, err);
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    deletePortfolio(String(req.params.id), actorOf(req));
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

router.post('/:id/members', (req: Request, res: Response) => {
  try {
    const result = addPortfolioMembers(
      String(req.params.id), parseIds(req.body?.business_ids), actorOf(req),
      req.body?.reason == null ? null : String(req.body.reason),
    );
    return res.json(result);
  } catch (err) {
    return handleError(res, err);
  }
});

// DELETE with a body is unusual, but the alternative — ids in the path or
// query — puts business identifiers in access logs for an operation that is
// otherwise indistinguishable from its POST counterpart. Kept symmetrical.
router.delete('/:id/members', (req: Request, res: Response) => {
  try {
    const ids = parseIds(req.body?.business_ids ?? req.query.business_ids);
    const result = removePortfolioMembers(
      String(req.params.id), ids, actorOf(req),
      req.body?.reason == null ? null : String(req.body.reason),
    );
    return res.json(result);
  } catch (err) {
    return handleError(res, err);
  }
});

router.get('/:id/history', (req: Request, res: Response) => {
  try {
    const limitRaw = req.query.limit;
    const limit = limitRaw == null ? undefined : Number.parseInt(String(limitRaw), 10);
    if (limit !== undefined && !Number.isFinite(limit)) {
      return res.status(400).json({ error: 'limit must be a number.' });
    }
    return res.json({
      events: listMembershipHistory(String(req.params.id), actorOf(req), { limit }),
    });
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * The comparison. Always 200 once the portfolio itself resolves: a business
 * that could not be loaded is an `unavailable` column inside the payload,
 * never an error status, because one broken business must not cost the
 * operator the comparison of the others.
 */
router.get('/:id/comparison', (req: Request, res: Response) => {
  try {
    const windowDaysRaw = req.query.window_days;
    const windowDays = windowDaysRaw == null ? undefined : Number.parseInt(String(windowDaysRaw), 10);
    if (windowDays !== undefined && !Number.isFinite(windowDays)) {
      return res.status(400).json({ error: 'window_days must be a number.' });
    }
    return res.json(comparePortfolio({
      portfolioId: String(req.params.id),
      actor: actorOf(req),
      windowDays,
    }));
  } catch (err) {
    return handleError(res, err);
  }
});

export default router;
