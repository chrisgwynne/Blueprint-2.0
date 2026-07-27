/**
 * Decision Memory API (Phase 3, session-authenticated).
 *
 * Read-only mirror of server/routes/bap-decisions.ts for the dashboard —
 * "why did we decide this six months ago?", answerable from
 * server/brain/decision-memory.ts's stored evidence. Decisions are written
 * by the engines that make them (task-queue.ts, goal-reasoner.ts,
 * conflict-engine.ts, goal-suggester.ts), never directly through this API.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import { recallDecisions, getDecision } from '../brain/decision-memory.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { q, decision_type, related_goal_id, related_task_id, date_from, date_to, page, limit } = req.query;
    const result = recallDecisions(businessId, {
      q: q ? String(q) : undefined,
      decision_type: decision_type ? String(decision_type) : undefined,
      related_goal_id: related_goal_id ? String(related_goal_id) : undefined,
      related_task_id: related_task_id ? String(related_task_id) : undefined,
      date_from: date_from ? String(date_from) : undefined,
      date_to: date_to ? String(date_to) : undefined,
      page: page ? parseInt(String(page), 10) : undefined,
      limit: limit ? parseInt(String(limit), 10) : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/:id', (req: Request, res: Response) => {
  try {
    const decision = getDecision(String(req.params.id), String(req.params.businessId));
    if (!decision) return res.status(404).json({ error: 'Decision not found' });
    res.json({ decision });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
