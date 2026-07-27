import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import db from '../db/db.js';
import {
  calculateScorecard, createCorrection, evaluateApplicability, evaluateDueOutcomeMeasurements, evaluateSignalLifecycle,
  getProviderPreflight, listCapabilities, listRevenuePaths, requestRunCancellation, upsertCapability, upsertRevenuePath,
} from '../trust/trust-engine.js';

const router = Router();
router.use(isAuthenticated);

router.get('/capabilities/:businessId', (req: Request, res: Response) => res.json({ capabilities: listCapabilities(String(req.params.businessId)) }));
router.post('/capabilities/:businessId', (req: Request, res: Response) => { try { res.status(201).json({ capability: upsertCapability(String(req.params.businessId), req.body as Record<string, unknown>) }); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
router.post('/applicability/:businessId/evaluate', (req: Request, res: Response) => { try { res.json({ applicability: evaluateApplicability({ ...(req.body as Record<string, unknown>), businessId: String(req.params.businessId), candidateType: String((req.body as Record<string, unknown>).candidateType ?? 'task') }) }); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
router.get('/suppressions/:businessId', (req: Request, res: Response) => res.json({ suppressions: db.prepare('SELECT * FROM applicability_suppressions WHERE business_id = ? ORDER BY created_at DESC').all(String(req.params.businessId)) }));
router.get('/corrections/:businessId', (req: Request, res: Response) => res.json({ corrections: db.prepare('SELECT * FROM human_corrections WHERE business_id = ? ORDER BY created_at DESC').all(String(req.params.businessId)) }));
router.post('/corrections/:businessId', (req: Request, res: Response) => { try { res.status(201).json({ correction: createCorrection({ ...(req.body as Record<string, unknown>), business_id: String(req.params.businessId) }) }); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
router.get('/corrections/:businessId/:correctionId/impacts', (req: Request, res: Response) => res.json({ impacts: db.prepare('SELECT * FROM correction_impacts WHERE business_id = ? AND correction_id = ? ORDER BY created_at DESC').all(String(req.params.businessId), String(req.params.correctionId)) }));
router.get('/revenue-paths/:businessId', (req: Request, res: Response) => res.json({ revenue_paths: listRevenuePaths(String(req.params.businessId)) }));
router.post('/revenue-paths/:businessId', (req: Request, res: Response) => { try { res.status(201).json({ revenue_path: upsertRevenuePath(String(req.params.businessId), req.body as Record<string, unknown>) }); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
router.get('/signals/:businessId/lifecycle', (req: Request, res: Response) => res.json({ events: db.prepare('SELECT * FROM signal_lifecycle_events WHERE business_id = ? ORDER BY created_at DESC LIMIT 200').all(String(req.params.businessId)) }));
router.post('/signals/:businessId/lifecycle/evaluate', (req: Request, res: Response) => res.json(evaluateSignalLifecycle(String(req.params.businessId))));
router.get('/measurement-policies/:businessId', (req: Request, res: Response) => res.json({ policies: db.prepare('SELECT * FROM measurement_policies WHERE business_id = ? OR business_id IS NULL ORDER BY business_id IS NULL, name').all(String(req.params.businessId)) }));
router.post('/measurements/evaluate-due', (_req: Request, res: Response) => res.json(evaluateDueOutcomeMeasurements()));
router.get('/provider-preflight', (req: Request, res: Response) => res.json({ preflights: getProviderPreflight(req.query.provider ? String(req.query.provider) : undefined, req.query.model ? String(req.query.model) : undefined) }));
router.post('/runs/:runId/cancel', (req: Request, res: Response) => { try { res.json(requestRunCancellation(String(req.params.runId))); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });
router.get('/runs/:runId/events', (req: Request, res: Response) => res.json({ events: db.prepare('SELECT * FROM agent_run_events WHERE run_id = ? ORDER BY created_at ASC').all(String(req.params.runId)) }));
router.get('/scorecards/:businessId', (req: Request, res: Response) => { const agentId = String(req.query.agent_id ?? 'conductor'); res.json({ scorecard: calculateScorecard(agentId, String(req.params.businessId), req.query.action_category ? String(req.query.action_category) : 'all') }); });

export default router;