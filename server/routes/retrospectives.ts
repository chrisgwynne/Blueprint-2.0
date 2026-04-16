/**
 * Retrospectives API (Feature 3).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  listRetrospectives, getRetrospective, runRetrospective,
} from '../brain/retrospective-engine.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    res.json(listRetrospectives(String(req.params.businessId)));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const r = getRetrospective(String(req.params.id), String(req.params.businessId));
    if (!r) return res.status(404).json({ error: 'Retrospective not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/run', async (req: Request, res: Response) => {
  try {
    const result = await runRetrospective(String(req.params.businessId), { triggered_by: 'human' });
    if (!result) return res.status(422).json({ error: 'Unable to generate retrospective' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
