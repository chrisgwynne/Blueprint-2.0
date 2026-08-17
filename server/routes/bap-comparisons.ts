/**
 * Blueprint Agent Protocol (BAP) — Recommendation comparison (issue #78).
 *
 * The agent-facing surface for #66's comparison engine, previously reachable
 * only through the session-authenticated dashboard route
 * (server/routes/comparisons.ts). An external agent proposing several
 * candidates for the same decision can now ask Blueprint for its OWN honest
 * side-by-side reading of them — shared vs. differing fields, explicit
 * unknown / not-comparable markers, and the one operating policy every
 * candidate is actually judged against — instead of reimplementing that
 * judgement itself, less well and with no access to the policy.
 *
 * NOT the same thing as `GET /businesses/:id/recommendations`
 * (bap-review.ts, `recommendations:read`). That endpoint returns the top-N
 * auto-generated recommendations Blueprint ranked for you. This one compares
 * the specific candidates YOU name, on a normalised axis, under one shared
 * policy. Different engine, different request shape, and deliberately a
 * different permission (`comparisons:read`) so it is never ambiguous which
 * of the two produced a given response.
 *
 * ─── Read-only, and structurally so ─────────────────────────────────────────
 *
 * `POST` here is a POST only because the candidate set travels in the body.
 * Building a comparison approves nothing, enqueues no execution_jobs row,
 * changes no task status and writes no decision. Like the engine itself,
 * this file deliberately imports nothing from tasks/executor.ts,
 * tasks/task-queue.ts or tasks/execution-worker.ts — an accidental side
 * effect cannot be introduced here without adding an import that stands out
 * in review, and bap-comparisons.test.ts asserts the import list to keep it
 * that way.
 *
 * ─── Why there is no BAP decision-recording endpoint ────────────────────────
 *
 * #78 floated an optional `POST /comparisons/:id/decision` going through
 * `recordComparisonDecision()`. It is deliberately NOT implemented, for the
 * same reason bap-decisions.ts is read-only and bap-operating-policies.ts
 * has no write path: the `decisions` table is Blueprint's memory of what IT
 * chose and why. Retrospectives, the decision centre and cross-business
 * pattern learning all read it as settled institutional record. An agent
 * writing "selected X over Y" into that table would be inserting a claim
 * into Blueprint's own recollection of its choices, through a gate no other
 * BAP route offers — today there is no BAP path that writes a `decisions`
 * row at all, and adding one behind a comparison endpoint would be a side
 * door into decision memory rather than a considered decision to open it.
 *
 * The honest flow stays: the agent requests the comparison, presents it with
 * its own recommendation, and a human records the selection through the
 * dashboard (`POST /api/comparisons/:businessId/decision`), where the actor
 * is a real person. If agent-authored decision memory is ever wanted, it
 * should be designed as such — with its own grant, its own audit story and
 * an actor field downstream readers can filter on — not smuggled in here.
 *
 * Endpoints:
 *   GET  /businesses/:bid/comparisons/candidates  — what may be compared
 *   POST /businesses/:bid/comparisons             — build one — READ ONLY
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import {
  buildComparison, listComparableCandidates, parseCandidateRefs,
  ComparisonRejectedError, MAX_COMPARISON_CANDIDATES, COMPARISON_CANDIDATE_KINDS,
} from '../brain/comparison-engine.js';

// No blanket auth/rate-limit middleware here — mounted as a sub-router inside
// bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
const router = Router();

// ─── What can be compared ───────────────────────────────────────────────────

/**
 * The candidate pool for one business — proposed tasks, pending
 * opportunities, candidate strategies. Business scoping is enforced twice
 * over: `requirePermission` resolves :businessId and checks it against the
 * agent's `business_access`, and the engine's own query is scoped to that
 * business.
 */
router.get('/businesses/:businessId/comparisons/candidates', requirePermission('comparisons:read'), (req: Request, res: Response) => {
  try {
    const candidates = listComparableCandidates(String(req.params.businessId));
    return res.json({
      candidates,
      total: candidates.length,
      candidate_kinds: COMPARISON_CANDIDATE_KINDS,
      max_candidates_per_comparison: MAX_COMPARISON_CANDIDATES,
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

// ─── Build a comparison (no side effects) ───────────────────────────────────

/**
 * Body: `{ "candidates": ["id1", "id2"] }` or
 *       `{ "candidates": [{ "id": "id1", "kind": "task" }, ...] }`.
 *
 * Returns the comparison model verbatim — the same object the dashboard
 * renders, `read_only: true` included — so an agent and a human are provably
 * looking at the same reading of the same candidates. Nothing is summarised
 * away for the agent, and in particular the `missing_data` markers and every
 * field's `state`/`reason` survive intact: where Blueprint does not know
 * something, the agent is told so rather than handed a substituted default.
 *
 * A candidate belonging to another business is a 422 naming the offending
 * id, exactly as on the dashboard route — two businesses have two operating
 * policies, two connector sets and two evidence windows, so one table over
 * both of them would be dishonest regardless of who is asking.
 */
router.post('/businesses/:businessId/comparisons', requirePermission('comparisons:read'), (req: Request, res: Response) => {
  let refs;
  try {
    refs = parseCandidateRefs((req.body ?? {}).candidates);
  } catch (err) {
    return sendError(req, res, 400, 'validation_error', (err as Error).message);
  }

  try {
    return res.json(buildComparison(String(req.params.businessId), refs));
  } catch (err) {
    if (err instanceof ComparisonRejectedError) {
      // 422: the request was well-formed but the set cannot honestly be
      // compared. `rejections` names every problem and the candidate it
      // belongs to, so the agent can fix the set rather than guess.
      return sendError(req, res, 422, 'validation_error', err.message, { rejections: err.rejections });
    }
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
