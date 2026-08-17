/**
 * Recommendation Comparison API (issue #66, session-authenticated).
 *
 * Two endpoints and one guarantee:
 *
 *   GET  /:businessId/candidates   what may be compared, in this scope
 *   POST /:businessId/compare      build the comparison — READ ONLY
 *   POST /:businessId/decision     record selected / deferred + rationale
 *
 * `/compare` is a POST only because the candidate set travels in the body;
 * it writes nothing, approves nothing and enqueues no execution job. The
 * ONLY endpoint here that writes is `/decision`, and it writes exactly one
 * `decisions` row — it never approves or executes the selected candidate.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  buildComparison, listComparableCandidates, recordComparisonDecision,
  parseCandidateRefs, ComparisonRejectedError,
} from '../brain/comparison-engine.js';

const router = Router();
router.use(isAuthenticated);

// `parseCandidateRefs` lives on the engine (#78) so this router and the BAP
// one accept byte-for-byte the same candidate shapes.

function actorFrom(req: Request): string {
  const userId = (req.session as unknown as { userId?: string } | undefined)?.userId;
  return `dashboard:${userId ?? 'human'}`;
}

// ─── What can be compared ───────────────────────────────────────────────────

router.get('/:businessId/candidates', (req: Request, res: Response) => {
  try {
    res.json({ candidates: listComparableCandidates(String(req.params.businessId)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Build a comparison (no side effects) ───────────────────────────────────

router.post('/:businessId/compare', (req: Request, res: Response) => {
  try {
    const refs = parseCandidateRefs((req.body ?? {}).candidates);
    res.json(buildComparison(String(req.params.businessId), refs));
  } catch (err) {
    if (err instanceof ComparisonRejectedError) {
      return res.status(422).json({ error: err.message, rejections: err.rejections });
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Record the outcome (writes one decision, approves nothing) ─────────────

router.post('/:businessId/decision', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const refs = parseCandidateRefs(body.candidates);
    const outcome = String(body.outcome ?? '');
    if (outcome !== 'selected' && outcome !== 'deferred') {
      return res.status(400).json({ error: "`outcome` must be 'selected' or 'deferred'." });
    }
    const rationale = typeof body.rationale === 'string' ? body.rationale : '';
    if (!rationale.trim()) {
      return res.status(400).json({ error: '`rationale` is required — a recorded decision must say why.' });
    }
    const record = recordComparisonDecision({
      business_id: String(req.params.businessId),
      candidates: refs,
      outcome,
      selected_candidate_id: typeof body.selected_candidate_id === 'string' ? body.selected_candidate_id : null,
      rationale,
      actor: actorFrom(req),
    });
    res.status(201).json(record);
  } catch (err) {
    if (err instanceof ComparisonRejectedError) {
      return res.status(422).json({ error: err.message, rejections: err.rejections });
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
