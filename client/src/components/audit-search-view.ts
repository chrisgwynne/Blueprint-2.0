/**
 * Presentation rules for the audit search page (issue #72).
 *
 * Pure and React-free, so the rules that decide what the operator actually
 * SEES can be tested directly. Each one exists to stop a specific way this
 * particular UI could quietly over-claim:
 *
 *   summaryPresentation  an INFERRED narrative must never be rendered the
 *                        same way as the records. A withheld summary must
 *                        say it was withheld — rendering nothing would make
 *                        a rejected fabrication indistinguishable from a
 *                        search that simply had no narrative.
 *
 *   stateHeadline        `no_results`, `results_stale` and `ambiguous_query`
 *                        get different words. Collapsing them into "0
 *                        results" is how a user concludes an event never
 *                        happened when in fact the question was never
 *                        understood, or the data stopped arriving.
 *
 *   citationLabel        every result shows the table and primary key it
 *                        came from. If this ever returned a bare title, the
 *                        result would become a claim rather than a record.
 *
 *   interpretationNotice a degraded (literal-matching) interpretation must
 *                        be announced. Silently presenting keyword matching
 *                        as language understanding is a lie about
 *                        capability, not a graceful degradation.
 *
 *   drilldownFor         the link must point at the surface that owns the
 *                        record, so "supports drill-down" is a property of
 *                        the data rather than of the page's good intentions.
 */

// ─── Types (mirror server/audit-search) ─────────────────────────────────────

export type AuditSearchState = 'results' | 'results_stale' | 'no_results' | 'ambiguous_query'
export type SummaryKind = 'grounded_narrative' | 'deterministic' | 'withheld'
export type InterpretationState = 'interpreted' | 'ambiguous' | 'interpreter_unavailable'

export interface CitationView {
  ref: string
  record_type: string
  record_id: string
  table: string
}

// ─── State headlines ────────────────────────────────────────────────────────

const STATE_HEADLINE: Record<AuditSearchState, string> = {
  results: 'Records found',
  results_stale: 'Records found, but the newest is old',
  no_results: 'The search ran and matched nothing',
  ambiguous_query: 'Not searched — the question needs clarifying',
}

const STATE_TONE: Record<AuditSearchState, 'ok' | 'warn' | 'neutral'> = {
  results: 'ok',
  results_stale: 'warn',
  no_results: 'neutral',
  ambiguous_query: 'warn',
}

export function stateHeadline(state: AuditSearchState): string {
  return STATE_HEADLINE[state] ?? 'Unknown search state'
}

export function stateTone(state: AuditSearchState): 'ok' | 'warn' | 'neutral' {
  return STATE_TONE[state] ?? 'neutral'
}

/**
 * "Nothing matched" and "nothing happened" are different answers, and the
 * page must never let one read as the other.
 */
export function noResultGuidance(filterDescription: string): string {
  return (
    `Nothing matched ${filterDescription}. `
    + 'This means Blueprint holds no matching record — it is not evidence that the event did not occur. '
    + 'Widen the time range, remove a keyword, or clear the record-type filter.'
  )
}

// ─── Summary presentation ───────────────────────────────────────────────────

export interface SummaryPresentation {
  /** Shown as the block's label. */
  heading: string
  /** True when the text is model-written and must be visually marked as such. */
  markAsInferred: boolean
  /** True when the page must explain that a summary was produced and rejected. */
  showWithheldExplanation: boolean
  tone: 'ok' | 'warn' | 'neutral'
}

export function summaryPresentation(kind: SummaryKind): SummaryPresentation {
  if (kind === 'grounded_narrative') {
    return { heading: 'Inferred summary', markAsInferred: true, showWithheldExplanation: false, tone: 'ok' }
  }
  if (kind === 'withheld') {
    // Deliberately loud. A discarded fabrication is a thing the operator
    // should know happened, not an absence to be tidied away.
    return { heading: 'Summary withheld', markAsInferred: false, showWithheldExplanation: true, tone: 'warn' }
  }
  return { heading: 'Records found', markAsInferred: false, showWithheldExplanation: false, tone: 'neutral' }
}

// ─── Interpretation notice ──────────────────────────────────────────────────

/**
 * Returns the sentence the page must show about HOW the question was
 * turned into filters, or null when there is nothing the user needs to
 * know. Never returns null for a degraded interpretation.
 */
export function interpretationNotice(
  state: InterpretationState,
  method: 'llm' | 'deterministic_fallback' | 'none',
  rationale: string,
): string | null {
  if (state === 'interpreter_unavailable' || method === 'deterministic_fallback') {
    return 'The natural-language interpreter was unavailable, so your question was matched literally, word by word. Check the filters below — they may be narrower or broader than you meant.'
  }
  if (method === 'none') return null
  return rationale || null
}

// ─── Citations and drill-down ───────────────────────────────────────────────

/**
 * The visible provenance of a result. Always names the table and the row,
 * because that pair is what makes the result checkable.
 */
export function citationLabel(citation: CitationView): string {
  return `${citation.ref} · table ${citation.table}`
}

const DRILLDOWN: Record<string, string> = {
  decision: '/decisions',
  task: '/tasks',
  receipt: '/receipts',
  outcome: '/outcomes',
  policy_event: '/policy',
  connector_event: '/connectors',
  signal: '/signals',
  agent_run: '/agents',
  audit_event: '/health',
}

/**
 * Where a result opens. Prefers the href the server computed (it knows the
 * record), and falls back to the type map — never to the dashboard root,
 * which would be a dead end dressed up as a link.
 */
export function drilldownFor(recordType: string, serverHref?: string | null): string | null {
  if (serverHref) return serverHref
  return DRILLDOWN[recordType] ?? null
}

// ─── Freshness ──────────────────────────────────────────────────────────────

const FRESHNESS_WORD: Record<string, string> = {
  fresh: 'current',
  recent: 'recent',
  ageing: 'ageing',
  stale: 'stale',
  unknown: 'no timestamp',
}

export function freshnessWord(freshness: string): string {
  return FRESHNESS_WORD[freshness] ?? 'no timestamp'
}

/**
 * Whether the page must show the staleness warning banner. Deliberately
 * false when the user explicitly asked about a past period: old records are
 * then the correct answer, and crying stale would train the user to ignore
 * the warning that matters.
 */
export function shouldWarnStale(stale: boolean, historicalQuery: boolean, staleConnectorCount: number): boolean {
  if (staleConnectorCount > 0) return true
  return stale && !historicalQuery
}
