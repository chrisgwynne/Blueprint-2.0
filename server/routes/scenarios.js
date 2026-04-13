/**
 * Scenarios API (Feature 1).
 */
import { Router } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { modelScenarios, listScenarios, getScenario } from '../brain/scenario-engine.js';

const router = Router();
router.use(isAuthenticated);

// List past scenarios for a business
router.get('/:businessId', (req, res) => {
  try {
    res.json(listScenarios(req.params.businessId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get one scenario
router.get('/:businessId/:id', (req, res) => {
  try {
    const s = getScenario(req.params.id, req.params.businessId);
    if (!s) return res.status(404).json({ error: 'Scenario not found' });
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Model a new scenario set
router.post('/:businessId/model', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { question, context = '' } = req.body ?? {};
    if (!question) return res.status(400).json({ error: 'question is required' });
    const result = await modelScenarios(businessId, question, context);
    if (!result) return res.status(422).json({ error: 'Unable to generate scenarios — LLM returned no result' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a scenario (rare)
router.delete('/:businessId/:id', (req, res) => {
  try {
    const { businessId, id } = req.params;
    db.prepare('DELETE FROM scenarios WHERE id = ? AND business_id = ?').run(id, businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
