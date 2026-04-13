/**
 * Goal suggestions API (Feature 6).
 */
import { Router } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  scanForGoalSuggestions, listGoalSuggestions,
  snoozeSuggestion, dismissSuggestion, acceptSuggestion,
} from '../brain/goal-suggester.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req, res) => {
  try {
    const status = req.query?.status ?? 'active';
    res.json({ suggestions: listGoalSuggestions(req.params.businessId, status) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/scan', async (req, res) => {
  try {
    const suggestions = await scanForGoalSuggestions(req.params.businessId);
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/:id/accept', async (req, res) => {
  try {
    const result = await acceptSuggestion(req.params.id, req.params.businessId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/:id/dismiss', (req, res) => {
  try {
    dismissSuggestion(req.params.id, req.body?.reason);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/:id/snooze', (req, res) => {
  try {
    const days = Number(req.body?.days) || 30;
    snoozeSuggestion(req.params.id, days);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
