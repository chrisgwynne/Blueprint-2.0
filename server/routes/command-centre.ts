/**
 * Executive command centre API (#59) — session-authenticated cross-business
 * summary over server/executive/command-centre.ts.
 *
 * This is the one route in the dashboard API that deliberately spans
 * businesses. Everywhere else the convention (routes/decision-queue.ts,
 * routes/operating-policies.ts, routes/receipts.ts) is one business per
 * path, because acting on the wrong business is the failure mode those
 * surfaces must prevent. This route is read-only and takes no action, so a
 * multi-business read is safe here — and it is still scoped by
 * listAccessibleBusinessIds() rather than by whatever ids the caller sent.
 *
 * There is no write path here at all: approving a decision goes through
 * routes/decision-queue.ts, which re-derives the item's policy standing at
 * the moment of the decision. A "quick approve" on a summary card would
 * skip that, so it does not exist.
 *
 *   GET  /                — the summary; ?business_ids=a,b  ?portfolio_id=  ?window_days=
 *   GET  /scope           — which businesses this session may select
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  assembleCommandCentre, CommandCentreError, listAccessibleBusinessIds,
} from '../executive/command-centre.js';
import { listPolicyPortfolios } from '../policy/operating-policy.js';

const router = Router();
router.use(isAuthenticated);

function actorOf(req: Request): string {
  const userId = (req.session as unknown as { userId?: string } | undefined)?.userId;
  return `dashboard:${userId ?? 'unknown'}`;
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof CommandCentreError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('[command-centre]', err);
  return res.status(500).json({ error: (err as Error)?.message ?? 'Failed to load the command centre.' });
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
 * GET /api/command-centre/scope
 *
 * What the selector can offer: the businesses this session may read, plus
 * #68's saved policy portfolios as ready-made selections. The client must
 * build its selector from this rather than from /api/businesses, so the
 * options it shows are exactly the ones the summary will honour.
 */
router.get('/scope', (req: Request, res: Response) => {
  try {
    const ids = listAccessibleBusinessIds(actorOf(req));
    const businesses = ids.length === 0 ? [] : db.prepare(
      `SELECT id, name, slug, type FROM businesses WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`
    ).all(...ids) as Array<Record<string, unknown>>;

    // Portfolios are #68's, not ours — offered as a shorthand for a
    // selection and filtered to the accessible set so a portfolio can never
    // widen what this session can see.
    const accessible = new Set(ids);
    const portfolios = listPolicyPortfolios()
      .map((p) => ({
        id: p.id,
        name: p.name,
        business_ids: p.business_ids.filter((b) => accessible.has(b)),
      }))
      .filter((p) => p.business_ids.length > 0);

    return res.json({ businesses, portfolios });
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * GET /api/command-centre
 * Query: business_ids, portfolio_id, window_days, sample_size
 *
 * Always 200 when the selection itself is valid. A business that could not
 * be loaded comes back as an `unavailable` row inside the payload rather
 * than as an error status — the whole point of the view is that one broken
 * business does not cost the executive the others.
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const windowDaysRaw = req.query.window_days;
    const sampleSizeRaw = req.query.sample_size;

    const windowDays = windowDaysRaw == null ? undefined : Number.parseInt(String(windowDaysRaw), 10);
    if (windowDays !== undefined && !Number.isFinite(windowDays)) {
      return res.status(400).json({ error: 'window_days must be a number.' });
    }
    const sampleSize = sampleSizeRaw == null ? undefined : Number.parseInt(String(sampleSizeRaw), 10);
    if (sampleSize !== undefined && !Number.isFinite(sampleSize)) {
      return res.status(400).json({ error: 'sample_size must be a number.' });
    }

    return res.json(assembleCommandCentre({
      actor: actorOf(req),
      businessIds: parseBusinessIds(req.query.business_ids),
      portfolioId: req.query.portfolio_id ? String(req.query.portfolio_id) : undefined,
      windowDays,
      sampleSize,
    }));
  } catch (err) {
    return handleError(res, err);
  }
});

export default router;
