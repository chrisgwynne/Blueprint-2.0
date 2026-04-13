/**
 * Conflicts API (Feature 2).
 */
import { Router } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  listConflicts, resolveConflict, dismissConflict,
  auditAllGoalConflicts, autoResolveStale,
} from '../brain/conflict-engine.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const { status, entity_id } = req.query ?? {};
    const rows = listConflicts(businessId, { status, entity_id });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/:id/resolve', (req, res) => {
  try {
    const { id, businessId } = req.params;
    const exists = db.prepare('SELECT id FROM conflicts WHERE id=? AND business_id=?').get(id, businessId);
    if (!exists) return res.status(404).json({ error: 'Conflict not found' });
    resolveConflict(id, req.body?.note);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:businessId/:id/dismiss', (req, res) => {
  try {
    const { id, businessId } = req.params;
    const exists = db.prepare('SELECT id FROM conflicts WHERE id=? AND business_id=?').get(id, businessId);
    if (!exists) return res.status(404).json({ error: 'Conflict not found' });
    dismissConflict(id, req.body?.reason);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run a full audit on demand
router.post('/:businessId/audit', async (req, res) => {
  try {
    autoResolveStale();
    const total = await auditAllGoalConflicts(req.params.businessId);
    res.json({ ok: true, conflicts_found: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
