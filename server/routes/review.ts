/**
 * Review surfaces API (Phase 3, session-authenticated): ranked
 * recommendations (with explainability), agent calibration, and
 * cross-business patterns. Session mirror of server/routes/bap-review.ts —
 * see that file for the shared explainRecommendation() logic reused here.
 * Retrospectives themselves stay in server/routes/retrospectives.ts.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { getRankedRecommendations } from '../brain/recommendation-engine.js';
import { listCrossBusinessPatterns } from '../brain/cross-business-patterns.js';
import { explainRecommendation, FULL_EXPLANATION_LIMIT } from './bap-review.js';

const router = Router();
router.use(isAuthenticated);

router.get('/:businessId/recommendations', async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const limit = req.query.limit ? Math.min(50, Math.max(1, parseInt(String(req.query.limit), 10) || 20)) : 20;
    const { recommendations, excluded } = getRankedRecommendations(businessId, { limit });
    const explained = await Promise.all(
      recommendations.map((r, i) => explainRecommendation(businessId, r, recommendations, i < FULL_EXPLANATION_LIMIT))
    );
    res.json({
      recommendations: explained,
      excluded,
      explanation_depth: `full for the top ${Math.min(FULL_EXPLANATION_LIMIT, recommendations.length)}, partial (no KB search) for the rest`,
      total: explained.length,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/calibration', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { agent_id, history } = req.query;
    const agentFilter = agent_id ? 'AND agent_id = ?' : '';
    const agentParams = agent_id ? [String(agent_id)] : [];

    if (history) {
      const rows = db.prepare(
        `SELECT * FROM agent_calibration WHERE business_id = ? ${agentFilter} ORDER BY calculated_at DESC LIMIT 50`
      ).all(businessId, ...agentParams) as Array<Record<string, unknown>>;
      return res.json({ calibration_history: rows.map((r) => ({ ...r, bins: r.bins ? JSON.parse(r.bins as string) : [] })) });
    }

    const agents = db.prepare(
      `SELECT DISTINCT agent_id FROM agent_calibration WHERE business_id = ? ${agentFilter}`
    ).all(businessId, ...agentParams) as Array<{ agent_id: string }>;
    const latest = agents.map((a) => {
      const row = db.prepare(
        'SELECT * FROM agent_calibration WHERE business_id = ? AND agent_id = ? ORDER BY calculated_at DESC LIMIT 1'
      ).get(businessId, a.agent_id) as Record<string, unknown>;
      return { ...row, bins: row.bins ? JSON.parse(row.bins as string) : [] };
    });
    res.json({ calibration: latest, total: latest.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/patterns', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id, type FROM businesses WHERE id = ?').get(businessId) as { id: string; type: string | null } | undefined;
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    const patterns = listCrossBusinessPatterns(biz.type);
    res.json({ patterns, total: patterns.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
