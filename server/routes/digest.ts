/**
 * "What happened while I was away?" digest API (issue #62).
 *
 *   GET  /api/digest                  — cross-business digest
 *   GET  /api/digest/:businessId      — one business
 *   POST /api/digest/acknowledge      — advance the watermark
 *   GET  /api/digest/:businessId/watermark — current catch-up point
 *
 * Query parameters on the GET:
 *   since=<ISO>  explicit override. Ignores the watermark entirely (both the
 *                window floor and the already-seen suppression) so a user can
 *                deliberately re-read a period. Does NOT destroy the
 *                watermark — a one-off look back must not cost you your
 *                catch-up position.
 *   until=<ISO>  window end (defaults to now).
 *   limit=<n>    items per section per business.
 *
 * The operator identity is taken from the session, never from the request
 * body: a client that could name its own operator_key could advance someone
 * else's watermark and make their unread items disappear.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import { buildAwayDigest, DIGEST_SCHEMA_VERSION } from '../digest/away-digest.js';
import {
  advanceWatermark, getWatermark, resetWatermark, normalizeScope, DEFAULT_OPERATOR,
} from '../digest/digest-watermark.js';

const router = Router();
router.use(isAuthenticated);

function operatorOf(req: Request): string {
  const id = (req.session as unknown as Record<string, unknown> | undefined)?.['userId'];
  return typeof id === 'string' && id.trim() ? id.trim() : DEFAULT_OPERATOR;
}

/** Reject a malformed date rather than silently falling back to a default. */
function parseIsoParam(raw: unknown, name: string): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null };
  const t = Date.parse(String(raw));
  if (Number.isNaN(t)) return { error: `Invalid ${name} — expected an ISO-8601 timestamp.` };
  return { value: new Date(t).toISOString() };
}

function handleDigest(req: Request, res: Response, businessId: string | null): Response {
  const since = parseIsoParam(req.query.since, 'since');
  if ('error' in since) return res.status(400).json({ error: since.error });
  const until = parseIsoParam(req.query.until, 'until');
  if ('error' in until) return res.status(400).json({ error: until.error });

  if (since.value && until.value && Date.parse(since.value) > Date.parse(until.value)) {
    return res.status(400).json({ error: '`since` must be earlier than `until`.' });
  }

  const digest = buildAwayDigest({
    operator_key: operatorOf(req),
    business_id: businessId,
    since: since.value,
    until: until.value,
    limit: parseInt(String(req.query.limit ?? ''), 10) || undefined,
  });

  return res.json(digest);
}

router.get('/', (req: Request, res: Response) => {
  try {
    return handleDigest(req, res, null);
  } catch (err) {
    console.error('[digest] Build error:', err);
    return res.status(500).json({ error: 'Failed to build digest.' });
  }
});

/**
 * POST /api/digest/acknowledge
 * Body: { business_id?, acknowledged_through?, digest_id?, items? }
 *
 * `items` is the digest's `acknowledgeable` map. When omitted, the server
 * rebuilds the current digest and acknowledges exactly what it would have
 * shown — so a client that acknowledges without echoing state cannot
 * accidentally mark items read that it never displayed.
 */
router.post('/acknowledge', (req: Request, res: Response) => {
  try {
    const operator = operatorOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = normalizeScope(body['business_id'] as string | null | undefined);

    const through = parseIsoParam(body['acknowledged_through'], 'acknowledged_through');
    if ('error' in through) return res.status(400).json({ error: through.error });

    let items = body['items'] as Record<string, string> | undefined;
    let acknowledgedThrough = through.value;
    let digestId = (body['digest_id'] as string | null | undefined) ?? null;

    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      const digest = buildAwayDigest({ operator_key: operator, business_id: scope });
      items = digest.acknowledgeable;
      acknowledgedThrough = acknowledgedThrough ?? digest.window.end;
      digestId = digestId ?? digest.digest_id;
    }

    const watermark = advanceWatermark({
      operator_key: operator,
      business_id: scope,
      acknowledged_through: acknowledgedThrough ?? new Date().toISOString(),
      acknowledged_by: operator,
      acknowledged_digest_id: digestId,
      items,
    });

    return res.json({ ok: true, watermark });
  } catch (err) {
    console.error('[digest] Acknowledge error:', err);
    return res.status(500).json({ error: 'Failed to acknowledge digest.' });
  }
});

/**
 * POST /api/digest/reset
 * Clears the watermark for a scope — "treat me as having seen nothing".
 * Distinct from the `since=` override, which is a one-off read.
 */
router.post('/reset', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    resetWatermark(operatorOf(req), body['business_id'] as string | null | undefined);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[digest] Reset error:', err);
    return res.status(500).json({ error: 'Failed to reset digest watermark.' });
  }
});

router.get('/:businessId/watermark', (req: Request, res: Response) => {
  try {
    const watermark = getWatermark(operatorOf(req), String(req.params.businessId));
    return res.json({ digest_schema_version: DIGEST_SCHEMA_VERSION, watermark });
  } catch (err) {
    console.error('[digest] Watermark read error:', err);
    return res.status(500).json({ error: 'Failed to read digest watermark.' });
  }
});

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    return handleDigest(req, res, String(req.params.businessId));
  } catch (err) {
    console.error('[digest] Build error:', err);
    return res.status(500).json({ error: 'Failed to build digest.' });
  }
});

export default router;
