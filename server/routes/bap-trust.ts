import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission } from '../bap/auth.js';
import { withRequiredIdempotency } from '../bap/route-helpers.js';
import { calculateScorecard, createCorrection, evaluateApplicability, getProviderPreflight, listCapabilities, listRevenuePaths, upsertCapability, upsertRevenuePath } from '../trust/trust-engine.js';

const router = Router();

router.get('/businesses/:businessId/capabilities', requirePermission('capabilities:read'), (req: Request, res: Response) => res.json({ capabilities: listCapabilities(String(req.params.businessId)) }));
router.post('/businesses/:businessId/capabilities/propose', requirePermission('capabilities:propose'), async (req: Request, res: Response) => {
  await withRequiredIdempotency(req, res, 'capabilities:propose', async () => ({ status: 202, body: { proposal: createCorrection({ ...(req.body as Record<string, unknown>), business_id: String(req.params.businessId), correction_type: 'agent_capability_proposal', permanence: 'review-required', status: 'proposed' }, `bap:${((req as any).bapAgent?.id ?? 'agent')}`) } }));
});
router.post('/businesses/:businessId/capabilities', requirePermission('capabilities:update'), async (req: Request, res: Response) => {
  await withRequiredIdempotency(req, res, 'capabilities:update', async () => ({ status: 201, body: { capability: upsertCapability(String(req.params.businessId), req.body as Record<string, unknown>, `bap:${((req as any).bapAgent?.id ?? 'agent')}`) } }));
});
router.post('/businesses/:businessId/applicability/evaluate', requirePermission('capabilities:read'), (req: Request, res: Response) => res.json({ applicability: evaluateApplicability({ ...(req.body as Record<string, unknown>), businessId: String(req.params.businessId), candidateType: String((req.body as Record<string, unknown>).candidateType ?? 'task') }) }));
router.get('/businesses/:businessId/suppressions', requirePermission('capabilities:read'), (req: Request, res: Response) => res.json({ suppressions: db.prepare('SELECT * FROM applicability_suppressions WHERE business_id = ? ORDER BY created_at DESC').all(String(req.params.businessId)) }));
router.get('/businesses/:businessId/corrections', requirePermission('corrections:read'), (req: Request, res: Response) => res.json({ corrections: db.prepare('SELECT * FROM human_corrections WHERE business_id = ? ORDER BY created_at DESC').all(String(req.params.businessId)) }));
router.get('/businesses/:businessId/corrections/:correctionId/impacts', requirePermission('corrections:read'), (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  const correctionId = String(req.params.correctionId);
  const correction = db.prepare('SELECT id, business_id, status FROM human_corrections WHERE id = ? AND business_id = ?').get(correctionId, businessId) as Record<string, unknown> | undefined;
  if (!correction) return res.status(404).json({ error: `Correction '${correctionId}' not found for this business.` });
  const impacts = db.prepare('SELECT * FROM correction_impacts WHERE business_id = ? AND correction_id = ? ORDER BY created_at DESC, id DESC').all(businessId, correctionId);
  return res.json({ correction_id: correctionId, business_id: businessId, impacts });
});
router.post('/businesses/:businessId/corrections/propose', requirePermission('corrections:propose'), async (req: Request, res: Response) => {
  await withRequiredIdempotency(req, res, 'corrections:propose', async () => ({ status: 202, body: { correction: createCorrection({ ...(req.body as Record<string, unknown>), business_id: String(req.params.businessId), status: 'proposed' }, `bap:${((req as any).bapAgent?.id ?? 'agent')}`) } }));
});
router.get('/businesses/:businessId/revenue-paths', requirePermission('revenue_paths:read'), (req: Request, res: Response) => res.json({ revenue_paths: listRevenuePaths(String(req.params.businessId)) }));
router.post('/businesses/:businessId/revenue-paths', requirePermission('revenue_paths:update'), async (req: Request, res: Response) => {
  await withRequiredIdempotency(req, res, 'revenue_paths:update', async () => ({ status: 201, body: { revenue_path: upsertRevenuePath(String(req.params.businessId), req.body as Record<string, unknown>, `bap:${((req as any).bapAgent?.id ?? 'agent')}`) } }));
});
router.get('/businesses/:businessId/measurement-policies', requirePermission('measurement_policies:read'), (req: Request, res: Response) => res.json({ policies: db.prepare('SELECT * FROM measurement_policies WHERE business_id = ? OR business_id IS NULL ORDER BY business_id IS NULL, name').all(String(req.params.businessId)) }));
router.get('/businesses/:businessId/approval-policies', requirePermission('approval_policies:read'), (_req: Request, res: Response) => res.json({ tiers: ['green', 'yellow', 'orange', 'red'], policy: 'dynamic risk tiering is calculated at proposal and approval from action, scope, reversibility, exposure, confidence and applicability.' }));
router.get('/provider-preflight', requirePermission('provider_preflight:read'), (req: Request, res: Response) => res.json({ preflights: getProviderPreflight(req.query.provider ? String(req.query.provider) : undefined, req.query.model ? String(req.query.model) : undefined) }));
router.get('/businesses/:businessId/scorecards', requirePermission('scorecards:read'), (req: Request, res: Response) => res.json({ scorecard: calculateScorecard(String(req.query.agent_id ?? 'conductor'), String(req.params.businessId), req.query.action_category ? String(req.query.action_category) : 'all') }));

export default router;