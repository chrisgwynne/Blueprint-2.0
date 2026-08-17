/**
 * Blueprint Agent Protocol (BAP) — Explanation readback (issue #82).
 *
 * "Why did Blueprint do this?" (#60) was previously reachable only via the
 * session-authenticated dashboard route (server/routes/explanations.ts).
 * An external agent that gets a task rejected, a hiring candidate
 * suppressed, or a comparison deferred had no way to ask why via API — this
 * closes that gap by reusing #60's engine directly rather than re-deriving
 * anything: explainSubject() dispatches to the same per-type builders the
 * dashboard panel calls, and every builder's last step is
 * finaliseExplanation(), which runs the WHOLE structure through
 * lib/redaction.ts (#70). There is no second code path here that could
 * leak something the dashboard's redaction pass would have caught.
 *
 * Read-only by design and by necessity: an explanation is a rendering of
 * records other modules authored, so there is nothing here to write.
 *
 * Business scoping is enforced inside explainSubject()'s builders, not by
 * trusting the path — an id belonging to another tenant resolves to null
 * and returns 404, never a cross-tenant read. `requirePermission` also
 * checks the path's :businessId against the agent's business_access before
 * the builder ever runs.
 *
 * No-op/suppressed/deferred/degraded outcomes are not errors — they are the
 * builder's honest disposition for "nothing happened," so they come back as
 * a normal 200 with that disposition, exactly as the dashboard panel does
 * (see explanation.ts's ExplanationDisposition and DISPOSITION_MEANING).
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET /explanations/kinds                             — the vocabulary (subject kinds, evidence quality, causal claim, disposition meanings)
 *   GET /businesses/:bid/explanations/:kind/:id          — one explanation
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import {
  explainSubject, isExplainableKind,
  EXPLANATION_SCHEMA_VERSION, EXPLANATION_SUBJECT_KINDS,
  EVIDENCE_QUALITY_MEANING, CAUSAL_CLAIM_MEANING, DISPOSITION_MEANING,
} from '../explain/index.js';

const router = Router();

/**
 * The vocabulary, so an agent can render/reason about an explanation
 * without hardcoding the meaning of a quality or a causal claim — and so
 * the meanings can never drift between this surface and the dashboard's.
 */
router.get('/explanations/kinds', requirePermission('explanations:read'), (_req: Request, res: Response) => {
  return res.json({
    schema_version: EXPLANATION_SCHEMA_VERSION,
    kinds: EXPLANATION_SUBJECT_KINDS,
    evidence_quality: EVIDENCE_QUALITY_MEANING,
    causal_claim: CAUSAL_CLAIM_MEANING,
    disposition: DISPOSITION_MEANING,
  });
});

router.get('/businesses/:businessId/explanations/:kind/:id', requirePermission('explanations:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const kind = String(req.params.kind);
    const id = String(req.params.id);

    if (!isExplainableKind(kind)) {
      return sendError(req, res, 400, 'validation_error', `'${kind}' is not an explainable subject.`, {
        explainable_kinds: EXPLANATION_SUBJECT_KINDS,
      });
    }

    const explanation = explainSubject(businessId, kind, id);
    if (!explanation) {
      return sendError(req, res, 404, 'not_found', `No ${kind} '${id}' exists for this business, so there is nothing to explain.`);
    }

    return res.json({ schema_version: EXPLANATION_SCHEMA_VERSION, explanation });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
