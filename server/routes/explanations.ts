/**
 * "Why did Blueprint do this?" — explanation readback (issue #60).
 *
 * Read-only by design and by necessity: an explanation is a rendering of
 * records other modules authored, so there is nothing here to write. If
 * this endpoint could edit an explanation, the explanation would stop being
 * evidence.
 *
 * Business scoping is enforced inside each builder, not by trusting the
 * path: an id belonging to another tenant resolves to null and returns 404,
 * never a cross-tenant read.
 *
 * Every response has already been through lib/redaction.ts inside
 * finaliseExplanation(), so no credential, provider body or raw payload can
 * reach a client even if the underlying record contains one.
 *
 * Endpoints:
 *   GET /api/explanations/kinds                    — what can be explained
 *   GET /api/explanations/:businessId/:kind/:id    — one explanation
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  explainSubject, isExplainableKind,
  EXPLANATION_SCHEMA_VERSION, EXPLANATION_SUBJECT_KINDS,
  EVIDENCE_QUALITY_MEANING, CAUSAL_CLAIM_MEANING, DISPOSITION_MEANING,
} from '../explain/index.js';

const router = Router();
router.use(isAuthenticated);

/**
 * The vocabulary, so a client can render an explanation without hardcoding
 * the meaning of a quality or a causal claim — and so the meanings can
 * never drift between server and panel.
 */
router.get('/kinds', (_req: Request, res: Response) => {
  return res.json({
    schema_version: EXPLANATION_SCHEMA_VERSION,
    kinds: EXPLANATION_SUBJECT_KINDS,
    evidence_quality: EVIDENCE_QUALITY_MEANING,
    causal_claim: CAUSAL_CLAIM_MEANING,
    disposition: DISPOSITION_MEANING,
  });
});

router.get('/:businessId/:kind/:id', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const kind = String(req.params.kind);
    const id = String(req.params.id);

    if (!isExplainableKind(kind)) {
      return res.status(400).json({
        error: `'${kind}' is not an explainable subject.`,
        explainable_kinds: EXPLANATION_SUBJECT_KINDS,
      });
    }

    const explanation = explainSubject(businessId, kind, id);
    if (!explanation) {
      return res.status(404).json({
        error: `No ${kind} '${id}' exists for this business, so there is nothing to explain.`,
      });
    }

    return res.json({ schema_version: EXPLANATION_SCHEMA_VERSION, explanation });
  } catch (err) {
    console.error('[explanations] Build error:', err);
    return res.status(500).json({ error: 'Failed to build the explanation.' });
  }
});

export default router;
