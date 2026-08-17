/**
 * Explanation dispatcher (issue #60).
 *
 * One entry point so a caller (the HTTP route, the panel, a future BAP
 * surface) asks for "the explanation of subject X" without knowing which
 * builder owns that subject kind. Adding a new explainable decision type
 * means adding a builder and one line here — nothing else changes, and the
 * panel renders it without modification because every builder returns the
 * same shape.
 */

import type { Explanation, ExplanationSubjectKind } from './explanation.js';
import { explainTask } from './explain-task.js';
import { explainDecision } from './explain-decision.js';
import { explainHiringAnalysis, explainHiringCandidate, explainLatestHiringAnalysis } from './explain-hiring.js';

export * from './explanation.js';
export { explainTask } from './explain-task.js';
export { explainDecision } from './explain-decision.js';
export { explainHiringAnalysis, explainHiringCandidate, explainLatestHiringAnalysis } from './explain-hiring.js';

const BUILDERS: Record<ExplanationSubjectKind, (businessId: string, id: string) => Explanation | null> = {
  task: explainTask,
  decision: explainDecision,
  hiring_analysis: (businessId, id) =>
    id === 'latest' ? explainLatestHiringAnalysis(businessId) : explainHiringAnalysis(businessId, id),
  hiring_candidate: explainHiringCandidate,
};

export function isExplainableKind(kind: string): kind is ExplanationSubjectKind {
  return Object.prototype.hasOwnProperty.call(BUILDERS, kind);
}

/**
 * Build the explanation for one subject, or null when the subject does not
 * exist for this business. Business scoping is enforced inside every
 * builder — an id from another tenant resolves to null, never to a
 * cross-tenant read.
 */
export function explainSubject(businessId: string, kind: ExplanationSubjectKind, id: string): Explanation | null {
  return BUILDERS[kind](businessId, id);
}
