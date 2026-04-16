/**
 * Goal suggestions API (Feature 6).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  scanForGoalSuggestions, listGoalSuggestions,
  snoozeSuggestion, dismissSuggestion, acceptSuggestion,
} from '../brain/goal-suggester.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const status = String(req.query?.status ?? 'active');
    res.json({ suggestions: listGoalSuggestions(String(req.params.businessId), status) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/scan', async (req: Request, res: Response) => {
  try {
    const suggestions = await scanForGoalSuggestions(String(req.params.businessId));
    res.json({ suggestions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/:id/accept', async (req: Request, res: Response) => {
  try {
    const result = await acceptSuggestion(String(req.params.id), String(req.params.businessId));
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/:id/dismiss', (req: Request, res: Response) => {
  try {
    dismissSuggestion(String(req.params.id), req.body?.reason);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/:id/snooze', (req: Request, res: Response) => {
  try {
    const days = Number(req.body?.days) || 30;
    snoozeSuggestion(String(req.params.id), days);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
