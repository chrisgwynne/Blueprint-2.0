/**
 * Investigations API (Feature 9).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  runInvestigation, listInvestigations, getInvestigation,
} from '../brain/investigation-engine.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    res.json(listInvestigations(String(req.params.businessId)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const r = getInvestigation(String(req.params.id), String(req.params.businessId));
    if (!r) return res.status(404).json({ error: 'Investigation not found' });
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/run', async (req: Request, res: Response) => {
  try {
    const { metric_name, signal_id, question } = req.body ?? {};
    if (!metric_name && !signal_id && !question) {
      return res.status(400).json({ error: 'Provide one of: metric_name, signal_id, question' });
    }
    const result = await runInvestigation({
      businessId: String(req.params.businessId),
      metricName: metric_name ?? null,
      signalId: signal_id ?? null,
      question: question ?? null,
      triggeredBy: 'human',
    });
    if (!result) return res.status(422).json({ error: 'Unable to generate investigation' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
