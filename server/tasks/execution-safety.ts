/**
 * External write safety — idempotency markers and provider-side
 * verification for the small set of action types that create a new
 * object in an external system (GitHub issues/PRs, Shopify products/
 * pages/blog posts). These are the highest-risk action types for
 * duplication: retrying a create call after an ambiguous failure (a
 * timeout, a crash between the API call succeeding and Blueprint
 * recording the result) can silently create a second real-world object.
 *
 * Strategy, in order of preference:
 *   1. Check Blueprint's OWN record first (execution_jobs.external_reference,
 *      set immediately after a successful create — see executor.ts). This
 *      is the fast, common-case path and covers "retry after an unrelated
 *      downstream failure" perfectly, as long as the reference was
 *      persisted before the retry was triggered.
 *   2. If Blueprint's own record is empty (e.g. a crash between the
 *      provider call succeeding and Blueprint persisting the reference),
 *      ask the provider directly: does an object already exist bearing
 *      the idempotency marker embedded in every create call this module
 *      makes? This is what catches the crash-in-the-gap case that #1
 *      can't.
 *   3. Only if both come back empty does the create call actually happen.
 */

export type ActionSafetyCategory = 'internal_idempotent' | 'external_verifiable';

// Action types that create a new external object and CAN be verified
// against the provider (GitHub Search API, Shopify recent-items lookup).
// Anything not listed here — including actions the executor doesn't even
// recognise — is treated as 'internal_idempotent': either it's a pure
// Blueprint-side write (KB drafts, investigations) which naturally
// overwrites/upserts, or an update-type action against an existing
// external object (which doesn't create anything new to duplicate).
const EXTERNAL_VERIFIABLE_ACTIONS = new Set<string>([
  'github_issue',
  'github_pr',
  'shopify_product_create',
  'shopify_page_create',
  'shopify_blog_post_create',
]);

export function classifyAction(actionType: string | null | undefined): ActionSafetyCategory {
  if (actionType && EXTERNAL_VERIFIABLE_ACTIONS.has(actionType)) return 'external_verifiable';
  return 'internal_idempotent';
}

/**
 * Stable, greppable marker embedded in every object this module's
 * create calls produce. Bound to both the task ID and its approved
 * version, so a task that's rejected, re-proposed, and re-approved gets
 * a distinct marker each time rather than colliding with a stale one.
 */
export function buildIdempotencyMarker(taskId: string, taskVersion: number): string {
  return `blueprint:task=${taskId}:v${taskVersion}`;
}

export function extractTaskIdFromMarker(marker: string): string | null {
  const m = /^blueprint:task=([^:]+):v\d+$/.exec(marker);
  return m?.[1] ?? null;
}
