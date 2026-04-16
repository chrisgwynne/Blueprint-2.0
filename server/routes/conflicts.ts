/**
 * Conflicts API (Feature 2).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  listConflicts, resolveConflict, dismissConflict,
  auditAllGoalConflicts, autoResolveStale,
} from '../brain/conflict-engine.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = req.params['businessId'] as string;
    const filters: Record<string, string> = {};
    if (req.query['status']) filters['status'] = String(req.query['status']);
    if (req.query['entity_id']) filters['entity_id'] = String(req.query['entity_id']);
    const rows = listConflicts(businessId, filters);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/:id/resolve', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const businessId = req.params['businessId'] as string;
    const exists = db.prepare('SELECT id FROM conflicts WHERE id=? AND business_id=?').get(id, businessId);
    if (!exists) return res.status(404).json({ error: 'Conflict not found' });
    resolveConflict(id, (req.body as any)?.note);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/:id/dismiss', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const businessId = req.params['businessId'] as string;
    const exists = db.prepare('SELECT id FROM conflicts WHERE id=? AND business_id=?').get(id, businessId);
    if (!exists) return res.status(404).json({ error: 'Conflict not found' });
    dismissConflict(id, (req.body as any)?.reason);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Run a full audit on demand
router.post('/:businessId/audit', async (req: Request, res: Response) => {
  try {
    autoResolveStale();
    const total = await auditAllGoalConflicts(req.params['businessId'] as string);
    res.json({ ok: true, conflicts_found: total });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
