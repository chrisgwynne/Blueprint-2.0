/**
 * Natural-language audit & history search (issue #72).
 *
 * One entry point so a caller (the HTTP route, a future BAP surface, the
 * chat agent) can search history without knowing which of the three layers
 * it is talking to:
 *
 *   query-interpretation.ts — sentence → structured filters (a model, and
 *                             nothing else, lives here)
 *   record-index.ts         — structured filters → real rows, cited
 *   grounding.ts            — a generated summary → verified or discarded
 *   audit-search.ts         — joins them, and owns the explicit states
 */
export * from './record-index.js';
export * from './grounding.js';
export * from './query-interpretation.js';
export * from './audit-search.js';
