/**
 * Investigations API (Feature 9).
 */
import { Router } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  runInvestigation, listInvestigations, getInvestigation,
} from '../brain/investigation-engine.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req, res) => {
  try {
    res.json(listInvestigations(req.params.businessId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:businessId/:id', (req, res) => {
  try {
    const r = getInvestigation(req.params.id, req.params.businessId);
    if (!r) return res.status(404).json({ error: 'Investigation not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/run', async (req, res) => {
  try {
    const { metric_name, signal_id, question } = req.body ?? {};
    if (!metric_name && !signal_id && !question) {
      return res.status(400).json({ error: 'Provide one of: metric_name, signal_id, question' });
    }
    const result = await runInvestigation({
      businessId: req.params.businessId,
      metricName: metric_name ?? null,
      signalId: signal_id ?? null,
      question: question ?? null,
      triggeredBy: 'human',
    });
    if (!result) return res.status(422).json({ error: 'Unable to generate investigation' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
