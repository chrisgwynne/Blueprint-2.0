/**
 * Retrospectives API (Feature 3).
 */
import { Router } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  listRetrospectives, getRetrospective, runRetrospective,
} from '../brain/retrospective-engine.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req, res) => {
  try {
    res.json(listRetrospectives(req.params.businessId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/:id', (req, res) => {
  try {
    const r = getRetrospective(req.params.id, req.params.businessId);
    if (!r) return res.status(404).json({ error: 'Retrospective not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/run', async (req, res) => {
  try {
    const result = await runRetrospective(req.params.businessId, { triggered_by: 'human' });
    if (!result) return res.status(422).json({ error: 'Unable to generate retrospective' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
