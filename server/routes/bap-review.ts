/**
 * Blueprint Agent Protocol (BAP) — Review surfaces (Phase 3): ranked
 * recommendations (with explainability), monthly retrospectives, agent
 * calibration, and cross-business patterns. Grouped in one file because
 * they answer the same class of question — "how are we doing, and what
 * should we do next" — not because they share an engine.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET    /businesses/:bid/recommendations   — ranked, explainable recommendations
 *   GET    /businesses/:bid/retrospectives    — list
 *   GET    /retrospectives/:id                — detail
 *   POST   /businesses/:bid/retrospectives/run — trigger one now
 *   GET    /businesses/:bid/calibration       — latest + history per agent
 *   GET    /businesses/:bid/patterns          — cross-business learning (abstract only)
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { parsePagination, paginationMeta, normalizeTimestamps, withRequiredIdempotency, sendError } from '../bap/route-helpers.js';
import { getRankedRecommendations, type RankedRecommendation } from '../brain/recommendation-engine.js';
import { listCrossBusinessPatterns } from '../brain/cross-business-patterns.js';

const router = Router();

// ─── Recommendations (with explainability) ─────────────────────────────────

/**
 * Explainability is genuinely expensive for the KB-search part (an async
 * call per item), so it's only computed for the top N — the rest still
 * carry every other explainability field (evidence/reasoning/risk/impact/
 * historical), just without a KB search. Documented in the response
 * itself via `explanation_depth`, not silently inconsistent.
 */
export const FULL_EXPLANATION_LIMIT = 5;

export async function explainRecommendation(businessId: string, rec: RankedRecommendation, allRecs: RankedRecommendation[], full: boolean): Promise<Record<string, unknown>> {
  const alternatives = allRecs
    .filter((r) => r.id !== rec.id && r.goal_id && r.goal_id === rec.goal_id)
    .slice(0, 3)
    .map((r) => ({ id: r.id, title: r.title, score: r.score }));

  let linkedSignals: Array<Record<string, unknown>> = [];
  let linkedMetrics: Record<string, unknown> | null = null;
  if (rec.source_type === 'task') {
    const task = db.prepare('SELECT signal_id FROM tasks WHERE id = ?').get(rec.id) as { signal_id: string | null } | undefined;
    if (task?.signal_id) {
      const signal = db.prepare('SELECT id, title, severity, confidence FROM signals WHERE id = ?').get(task.signal_id) as Record<string, unknown> | undefined;
      if (signal) linkedSignals = [signal];
    }
  }
  if (rec.goal_id) {
    const goal = db.prepare('SELECT metric_name, metric_baseline, metric_target, metric_current FROM goals WHERE id = ?').get(rec.goal_id) as Record<string, unknown> | undefined;
    if (goal?.metric_name) linkedMetrics = goal;
  }

  let linkedKb: Array<Record<string, unknown>> = [];
  if (full) {
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
        getKBForBusiness: (id: string) => Promise<{ engine: { search: (q: string, limit: number) => Promise<unknown[]> } } | null>;
      };
      const result = await getKBForBusiness(businessId);
      if (result?.engine) {
        const results = await result.engine.search(rec.title, 3);
        linkedKb = results as Array<Record<string, unknown>>;
      }
    } catch { /* best-effort — KB search failing never blocks a recommendation response */ }
  }

  return {
    ...rec,
    explanation: {
      evidence: rec.historical_sample_size > 0
        ? [`${Math.round((rec.historical_success_rate ?? 0) * 100)}% historical success rate over ${rec.historical_sample_size} prior instance(s).`]
        : ['No historical track record for this action type yet.'],
      reasoning: rec.rationale,
      alternatives_considered: alternatives,
      confidence: rec.confidence,
      risk: rec.has_open_conflict ? 'Has an open, unresolved conflict.' : 'No known conflicts.',
      expected_impact: rec.expected_impact,
      historical_evidence: { success_rate: rec.historical_success_rate, sample_size: rec.historical_sample_size },
      linked_kb: linkedKb,
      linked_signals: linkedSignals,
      linked_metrics: linkedMetrics,
    },
  };
}

router.get('/businesses/:businessId/recommendations', requirePermission('recommendations:read'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!biz) return sendError(req, res, 404, 'not_found', 'Business not found.');

    const limit = req.query.limit ? Math.min(50, Math.max(1, parseInt(String(req.query.limit), 10) || 20)) : 20;
    const { recommendations, excluded } = getRankedRecommendations(businessId, { limit });

    const explained = await Promise.all(
      recommendations.map((r, i) => explainRecommendation(businessId, r, recommendations, i < FULL_EXPLANATION_LIMIT))
    );

    return res.json({
      recommendations: explained,
      excluded,
      explanation_depth: `full for the top ${Math.min(FULL_EXPLANATION_LIMIT, recommendations.length)}, partial (no KB search) for the rest`,
      total: explained.length,
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

// ─── Retrospectives ─────────────────────────────────────────────────────────

router.get('/businesses/:businessId/retrospectives', requirePermission('retrospectives:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM retrospectives WHERE business_id = ?').get(businessId) as { n: number }).n;
    const rows = (db.prepare(
      'SELECT id, business_id, period_start, period_end, executive_summary, kb_path, triggered_by, created_at FROM retrospectives WHERE business_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(businessId, limit, offset) as Array<Record<string, unknown>>).map((r) => normalizeTimestamps(r, ['period_start', 'period_end', 'created_at']));

    return res.json({ retrospectives: rows, total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/retrospectives/:retrospectiveId', requirePermission('retrospectives:read'), (req: Request, res: Response) => {
  try {
    const id = String(req.params.retrospectiveId);
    const row = db.prepare('SELECT * FROM retrospectives WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return sendError(req, res, 404, 'not_found', `Retrospective '${id}' not found.`);
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'retrospectives:read', row.business_id as string)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: retrospective does not belong to an authorized business.');
    }
    const parsed: Record<string, unknown> = {};
    for (const k of ['what_worked', 'what_didnt', 'learnings', 'agent_assessments', 'open_windows', 'recommendations', 'operating_changes', 'calibration_notes']) {
      try { parsed[k] = JSON.parse((row[k] as string) || '[]'); } catch { parsed[k] = []; }
    }
    return res.json({ retrospective: normalizeTimestamps({ ...row, ...parsed }, ['period_start', 'period_end', 'created_at']) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/businesses/:businessId/retrospectives/run', requirePermission('retrospectives:trigger'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!biz) return sendError(req, res, 404, 'not_found', 'Business not found.');

    await withRequiredIdempotency(req, res, 'retrospectives:run', async () => {
      // Fire-and-forget — a full retrospective is an LLM call over a
      // month of data plus KB writes; same async-trigger shape used
      // throughout Phase 2/3 for expensive operations.
      import('../brain/retrospective-engine.js')
        .then((m) => (m as unknown as { runRetrospective: (bid: string, opts: Record<string, unknown>) => Promise<unknown> }).runRetrospective(businessId, { triggered_by: 'bap' }))
        .catch((err) => console.warn(`[bap-review] retrospective trigger failed for ${businessId}:`, (err as Error).message));
      return { status: 202, body: { business_id: businessId, status: 'running', message: 'Retrospective triggered. Poll GET /businesses/:id/retrospectives for the result.' } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

// ─── Calibration ────────────────────────────────────────────────────────────

router.get('/businesses/:businessId/calibration', requirePermission('calibration:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { agent_id, history } = req.query;

    const agentFilter = agent_id ? 'AND agent_id = ?' : '';
    const agentParams = agent_id ? [String(agent_id)] : [];

    if (history) {
      const rows = db.prepare(
        `SELECT * FROM agent_calibration WHERE business_id = ? ${agentFilter} ORDER BY calculated_at DESC LIMIT 50`
      ).all(businessId, ...agentParams) as Array<Record<string, unknown>>;
      return res.json({ calibration_history: rows.map((r) => normalizeTimestamps({ ...r, bins: r.bins ? JSON.parse(r.bins as string) : [] }, ['period_start', 'period_end', 'calculated_at'])) });
    }

    // Latest per agent for this business.
    const agents = db.prepare(
      `SELECT DISTINCT agent_id FROM agent_calibration WHERE business_id = ? ${agentFilter}`
    ).all(businessId, ...agentParams) as Array<{ agent_id: string }>;
    const latest = agents.map((a) => {
      const row = db.prepare(
        'SELECT * FROM agent_calibration WHERE business_id = ? AND agent_id = ? ORDER BY calculated_at DESC LIMIT 1'
      ).get(businessId, a.agent_id) as Record<string, unknown>;
      return normalizeTimestamps({ ...row, bins: row.bins ? JSON.parse(row.bins as string) : [] }, ['period_start', 'period_end', 'calculated_at']);
    });

    return res.json({ calibration: latest, total: latest.length });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

// ─── Cross-business patterns ────────────────────────────────────────────────

router.get('/businesses/:businessId/patterns', requirePermission('recommendations:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id, type FROM businesses WHERE id = ?').get(businessId) as { id: string; type: string | null } | undefined;
    if (!biz) return sendError(req, res, 404, 'not_found', 'Business not found.');

    const patterns = listCrossBusinessPatterns(biz.type);
    return res.json({ patterns, total: patterns.length });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
