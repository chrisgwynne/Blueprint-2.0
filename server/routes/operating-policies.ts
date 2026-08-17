/**
 * Per-business Operating Policy API (#68) — session-authenticated dashboard
 * surface for server/policy/operating-policy.ts.
 *
 * Every route is scoped to exactly one business, or to one explicitly
 * selected portfolio; there is no "all policies" endpoint, because the
 * acceptance criterion for this feature is that an operator edits policy
 * for exactly one business or one portfolio they chose on purpose.
 *
 * Authorization follows the convention used by routes/trust.ts and
 * routes/agents.ts: router-level isAuthenticated, plus an explicit
 * existence check on the scope so a request for a business that does not
 * exist 404s instead of silently creating or reading an empty scope.
 *
 *   GET    /:businessId                    — effective + active + versions + events
 *   GET    /:businessId/versions/:version  — one historical version
 *   POST   /:businessId/preview            — validate + compute impact, no writes
 *   POST   /:businessId/backtest           — replay recent history against a candidate, no writes
 *   POST   /:businessId                    — save (immediate or scheduled)
 *   POST   /:businessId/rollback           — re-activate a prior version
 *   POST   /:businessId/versions/:version/cancel — cancel a scheduled version
 *   GET    /portfolios                     — list policy portfolios
 *   POST   /portfolios                     — create/update a portfolio
 *   GET    /portfolios/:portfolioId        — one portfolio's policy state
 *   POST   /portfolios/:portfolioId        — save a portfolio-scope policy
 *   POST   /portfolios/:portfolioId/backtest — replay recent history against a candidate, no writes
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  DEFAULT_OPERATING_POLICY, PolicyValidationError,
  activateDuePolicies, cancelScheduledPolicy, getActivePolicyVersion, getPolicyPortfolio,
  getPolicyVersion, listPolicyEvents, listPolicyPortfolios, listPolicyVersions,
  previewPolicyChange, resolveOperatingPolicy, rollbackPolicy, savePolicyVersion,
  upsertPolicyPortfolio, validatePolicyDocument, mergePolicyDocument,
  type OperatingPolicyPatch, type PolicyScopeRef,
} from '../policy/operating-policy.js';
import { backtestPolicyChange } from '../policy/policy-backtest.js';

const router = Router();
router.use(isAuthenticated);

function actorOf(req: Request): string {
  const userId = (req.session as unknown as { userId?: string } | undefined)?.userId;
  return `dashboard:${userId ?? 'unknown'}`;
}

function businessExists(businessId: string): boolean {
  return !!db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof PolicyValidationError) {
    return res.status(422).json({
      error: 'Policy rejected: it contains invalid, conflicting or unsafe settings.',
      violations: err.violations,
    });
  }
  const message = (err as Error).message ?? 'Unknown error';
  const status = /not found|does not exist|Unknown business/i.test(message) ? 404 : 400;
  return res.status(status).json({ error: message });
}

function policyStateFor(ref: PolicyScopeRef) {
  activateDuePolicies(ref);
  const versions = listPolicyVersions(ref);
  return {
    scope: ref.scope,
    scope_key: ref.key,
    active: getActivePolicyVersion(ref),
    scheduled: versions.filter((v) => v.state === 'scheduled'),
    versions,
    events: listPolicyEvents(ref),
    defaults: DEFAULT_OPERATING_POLICY,
  };
}

// ─── Portfolios (declared before /:businessId so they are not shadowed) ──────

router.get('/portfolios', (_req: Request, res: Response) => {
  res.json({ portfolios: listPolicyPortfolios() });
});

router.post('/portfolios', (req: Request, res: Response) => {
  try {
    const body = req.body as { id?: string; name?: string; business_ids?: string[] };
    const portfolio = upsertPolicyPortfolio({
      id: body.id,
      name: String(body.name ?? ''),
      business_ids: Array.isArray(body.business_ids) ? body.business_ids.map(String) : [],
      actor: actorOf(req),
    });
    res.status(201).json({ portfolio });
  } catch (err) { handleError(res, err); }
});

router.get('/portfolios/:portfolioId', (req: Request, res: Response) => {
  const portfolioId = String(req.params.portfolioId);
  const portfolio = getPolicyPortfolio(portfolioId);
  if (!portfolio) return res.status(404).json({ error: `Policy portfolio '${portfolioId}' not found.` });
  return res.json({ portfolio, ...policyStateFor({ scope: 'portfolio', key: portfolioId }) });
});

router.post('/portfolios/:portfolioId', (req: Request, res: Response) => {
  try {
    const portfolioId = String(req.params.portfolioId);
    if (!getPolicyPortfolio(portfolioId)) return res.status(404).json({ error: `Policy portfolio '${portfolioId}' not found.` });
    const body = req.body as { patch?: OperatingPolicyPatch; effective_at?: string | null; change_reason?: string | null; base_version?: number | null };
    const saved = savePolicyVersion({
      scope: 'portfolio', key: portfolioId,
      patch: body.patch ?? {},
      effective_at: body.effective_at ?? null,
      change_reason: body.change_reason ?? null,
      base_version: body.base_version ?? null,
      actor: actorOf(req),
    });
    return res.status(201).json({ policy: saved });
  } catch (err) { return handleError(res, err); }
});

router.post('/portfolios/:portfolioId/preview', (req: Request, res: Response) => {
  try {
    const portfolioId = String(req.params.portfolioId);
    if (!getPolicyPortfolio(portfolioId)) return res.status(404).json({ error: `Policy portfolio '${portfolioId}' not found.` });
    const body = req.body as { patch?: OperatingPolicyPatch; effective_at?: string | null };
    return res.json({
      preview: previewPolicyChange({ scope: 'portfolio', key: portfolioId, patch: body.patch ?? {}, effective_at: body.effective_at ?? null }),
    });
  } catch (err) { return handleError(res, err); }
});

router.post('/portfolios/:portfolioId/backtest', (req: Request, res: Response) => {
  try {
    const portfolioId = String(req.params.portfolioId);
    if (!getPolicyPortfolio(portfolioId)) return res.status(404).json({ error: `Policy portfolio '${portfolioId}' not found.` });
    const body = req.body as { patch?: OperatingPolicyPatch; days?: number };
    return res.json({
      backtest: backtestPolicyChange({ scope: 'portfolio', key: portfolioId, patch: body.patch ?? {}, days: body.days }),
    });
  } catch (err) { return handleError(res, err); }
});

// ─── Business scope ─────────────────────────────────────────────────────────

router.get('/:businessId', (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
  return res.json({
    business_id: businessId,
    effective: resolveOperatingPolicy(businessId),
    ...policyStateFor({ scope: 'business', key: businessId }),
  });
});

router.get('/:businessId/versions/:version', (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
  const version = Number(req.params.version);
  // Scoped lookup — a version id belonging to another business is simply
  // not found here, which is what keeps history reads business-isolated.
  const found = getPolicyVersion({ scope: 'business', key: businessId }, version);
  if (!found) return res.status(404).json({ error: `Policy version ${version} not found for business '${businessId}'.` });
  return res.json({ policy: found });
});

/** Validate only — no version is written, nothing is activated. */
router.post('/:businessId/validate', (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
  const patch = ((req.body as { patch?: OperatingPolicyPatch }).patch ?? {}) as OperatingPolicyPatch;
  const current = getActivePolicyVersion({ scope: 'business', key: businessId })?.document ?? DEFAULT_OPERATING_POLICY;
  const violations = validatePolicyDocument(mergePolicyDocument(current, patch), patch);
  return res.json({ valid: violations.length === 0, violations });
});

router.post('/:businessId/preview', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
    const body = req.body as { patch?: OperatingPolicyPatch; effective_at?: string | null };
    return res.json({
      preview: previewPolicyChange({ scope: 'business', key: businessId, patch: body.patch ?? {}, effective_at: body.effective_at ?? null }),
    });
  } catch (err) { return handleError(res, err); }
});

router.post('/:businessId/backtest', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
    const body = req.body as { patch?: OperatingPolicyPatch; days?: number };
    return res.json({
      backtest: backtestPolicyChange({ scope: 'business', key: businessId, patch: body.patch ?? {}, days: body.days }),
    });
  } catch (err) { return handleError(res, err); }
});

router.post('/:businessId/rollback', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
    const body = req.body as { to_version?: number; change_reason?: string | null };
    if (body.to_version == null || !Number.isFinite(Number(body.to_version))) {
      return res.status(400).json({ error: 'to_version is required and must be a version number.' });
    }
    const saved = rollbackPolicy({
      scope: 'business', key: businessId, to_version: Number(body.to_version),
      change_reason: body.change_reason ?? null, actor: actorOf(req),
    });
    return res.status(201).json({ policy: saved });
  } catch (err) { return handleError(res, err); }
});

router.post('/:businessId/versions/:version/cancel', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
    const cancelled = cancelScheduledPolicy({
      scope: 'business', key: businessId, version: Number(req.params.version),
      reason: (req.body as { reason?: string })?.reason ?? null, actor: actorOf(req),
    });
    return res.json({ policy: cancelled });
  } catch (err) { return handleError(res, err); }
});

router.post('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    if (!businessExists(businessId)) return res.status(404).json({ error: `Business '${businessId}' not found.` });
    const body = req.body as {
      patch?: OperatingPolicyPatch; effective_at?: string | null;
      change_reason?: string | null; base_version?: number | null;
    };
    const saved = savePolicyVersion({
      scope: 'business', key: businessId,
      patch: body.patch ?? {},
      effective_at: body.effective_at ?? null,
      change_reason: body.change_reason ?? null,
      base_version: body.base_version ?? null,
      actor: actorOf(req),
    });
    return res.status(201).json({ policy: saved });
  } catch (err) { return handleError(res, err); }
});

export default router;
