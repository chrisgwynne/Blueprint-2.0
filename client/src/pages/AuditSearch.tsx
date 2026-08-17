import React, { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Search, AlertTriangle, HelpCircle, Clock, FileSearch, ExternalLink,
  ShieldQuestion, Sparkles, X, Info,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import useStore from '../lib/store.js'
import ExplanationPanel from '../components/ExplanationPanel.js'
import { getAuditSearchVocabulary, runAuditSearch } from '../lib/api.js'
// The honesty rules live in a pure module so they can be tested directly —
// the page must APPLY them rather than re-implement them, or the tests
// would be verifying something the operator never sees.
import {
  stateHeadline, summaryPresentation, interpretationNotice,
  citationLabel, drilldownFor, freshnessWord, shouldWarnStale,
  type AuditSearchState as ViewState,
} from '../components/audit-search-view.js'

/**
 * Natural-language audit & history search (issue #72).
 *
 * The page is built around one rule: the RECORDS are the answer, and
 * anything generated is visibly secondary to them.
 *
 * That shows up in three places:
 *
 *   - The applied filters are always on screen and always editable. A user
 *     can see exactly what was searched and correct it, so a wrong
 *     interpretation is a visible, fixable mistake rather than a silently
 *     wrong answer.
 *
 *   - Every result renders its citation (`type#id` and the table it came
 *     from) and a drill-down into the surface that owns it. A result that
 *     could not be traced back would be a claim, not a record.
 *
 *   - A generated summary is boxed, labelled INFERRED, and shown BELOW the
 *     honest counts. When the server discarded a summary for failing its
 *     grounding checks, the page says so explicitly rather than quietly
 *     rendering nothing.
 */

// ─── Types (mirror the server payload) ───────────────────────────────────────

interface Citation {
  ref: string
  record_type: string
  record_id: string
  table: string
}

interface AuditRecord {
  citation: Citation
  business_id: string
  title: string
  snippet: string
  snippet_fields: string[]
  status: string | null
  occurred_at: string | null
  age_hours: number | null
  freshness: 'fresh' | 'recent' | 'ageing' | 'stale' | 'unknown'
  actor: string | null
  fields: Record<string, unknown>
  href: string
  explainable: { kind: string; id: string } | null
  matched_terms: string[]
  score: number
}

interface Interpretation {
  state: 'interpreted' | 'ambiguous' | 'interpreter_unavailable'
  method: 'llm' | 'deterministic_fallback' | 'none'
  confidence: number | null
  rationale: string
  clarification: { reason: string; questions: string[]; candidate_readings: string[] } | null
  rejected: Array<{ field: string; value: string; reason: string }>
  provider_error: string | null
}

interface AppliedFilters {
  business_ids: string[]
  record_types: string[]
  statuses: string[]
  from: string | null
  to: string | null
  terms: string[]
  description: string
}

interface SearchSummary {
  kind: 'grounded_narrative' | 'deterministic' | 'withheld'
  text: string
  inferred: boolean
  citations: string[]
  withheld_reason: string | null
  disclaimer: string
}

interface Freshness {
  newest_at: string | null
  oldest_at: string | null
  newest_age_hours: number | null
  stale: boolean
  historical_query: boolean
  summary: string
  stale_connectors: Array<{ id: string; name: string | null; last_sync: string | null }>
}

interface SearchResult {
  state: 'results' | 'results_stale' | 'no_results' | 'ambiguous_query'
  state_meaning: string
  query: string
  interpretation: Interpretation
  applied_filters: AppliedFilters
  results: AuditRecord[]
  total_matched: number
  counts_by_type: Record<string, number>
  truncated_types: string[]
  freshness: Freshness
  summary: SearchSummary
  notices: string[]
  limitations: string[]
}

interface VocabularyEntry { type: string; meaning: string; statuses: string[] }

// ─── Presentation constants ──────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4,
}
const MONO: React.CSSProperties = { fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }

const TYPE_COLOUR: Record<string, string> = {
  decision: 'var(--bp-blue)',
  task: 'var(--bp-text-2)',
  receipt: 'var(--bp-green)',
  outcome: 'var(--bp-green)',
  policy_event: 'var(--bp-amber)',
  connector_event: 'var(--bp-amber)',
  signal: 'var(--bp-blue)',
  agent_run: 'var(--bp-text-3)',
  audit_event: 'var(--bp-text-3)',
}

const FRESHNESS_COLOUR: Record<string, string> = {
  fresh: 'var(--bp-green)',
  recent: 'var(--bp-green)',
  ageing: 'var(--bp-amber)',
  stale: 'var(--bp-red)',
  unknown: 'var(--bp-text-3)',
}

const STATE_COLOUR: Record<string, string> = {
  results: 'var(--bp-green)',
  results_stale: 'var(--bp-amber)',
  no_results: 'var(--bp-text-3)',
  ambiguous_query: 'var(--bp-amber)',
}

const EXAMPLES = [
  'why was the pricing task rejected last month?',
  'which policy changed after the connector failure?',
  'what did we actually execute in the last 7 days?',
  'show me every outcome that was measured this quarter',
]

function rel(iso?: string | null) {
  if (!iso) return null
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) }
  catch { return null }
}

// ─── Filter chips ────────────────────────────────────────────────────────────

/**
 * The applied filters, always visible and always editable. This is what
 * makes a misinterpretation a correctable mistake rather than a silently
 * wrong answer, so it is never collapsed behind a disclosure.
 */
function AppliedFilterBar({
  filters, vocabulary, onChange, onClear,
}: {
  filters: AppliedFilters
  vocabulary: VocabularyEntry[]
  onChange: (patch: Partial<AppliedFilters>) => void
  onClear: () => void
}) {
  const [showTypes, setShowTypes] = useState(false)
  const allStatuses = useMemo(() => {
    const set = new Set<string>()
    for (const entry of vocabulary) {
      if (!filters.record_types.length || filters.record_types.includes(entry.type)) {
        for (const s of entry.statuses) set.add(s)
      }
    }
    return [...set].sort()
  }, [vocabulary, filters.record_types])

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  return (
    <div className="bp-card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ ...LABEL, marginBottom: 0 }}>Filters actually applied</div>
        <button onClick={onClear} style={{
          marginLeft: 'auto', background: 'none', border: '1px solid var(--bp-border)',
          borderRadius: 3, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)',
          fontSize: 10, padding: '2px 8px', cursor: 'pointer',
        }}>Clear all</button>
      </div>

      <div style={{ ...MONO, color: 'var(--bp-text-3)', marginBottom: 10 }}>{filters.description}</div>

      {/* Terms */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ ...LABEL, marginBottom: 0, minWidth: 64 }}>Keywords</span>
        {filters.terms.length === 0 && <span style={{ ...MONO, color: 'var(--bp-text-3)' }}>none</span>}
        {filters.terms.map((t) => (
          <span key={t} className="bp-pill" style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {t}
            <X size={10} style={{ cursor: 'pointer' }}
              onClick={() => onChange({ terms: filters.terms.filter((v) => v !== t) })} />
          </span>
        ))}
      </div>

      {/* Record types */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ ...LABEL, marginBottom: 0, minWidth: 64 }}>Types</span>
        {filters.record_types.length === 0 && (
          <span style={{ ...MONO, color: 'var(--bp-text-3)' }}>all types</span>
        )}
        {filters.record_types.map((t) => (
          <span key={t} className="bp-pill" style={{
            fontSize: 10, color: TYPE_COLOUR[t] ?? 'var(--bp-text-2)', borderColor: TYPE_COLOUR[t] ?? 'var(--bp-border)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            {t}
            <X size={10} style={{ cursor: 'pointer' }}
              onClick={() => onChange({ record_types: filters.record_types.filter((v) => v !== t) })} />
          </span>
        ))}
        <button onClick={() => setShowTypes((s) => !s)} style={{
          background: 'none', border: '1px dashed var(--bp-border)', borderRadius: 3,
          color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 10,
          padding: '2px 8px', cursor: 'pointer',
        }}>{showTypes ? 'done' : '+ type'}</button>
      </div>

      {showTypes && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, paddingLeft: 70 }}>
          {vocabulary.map((entry) => (
            <button key={entry.type} title={entry.meaning}
              onClick={() => onChange({ record_types: toggle(filters.record_types, entry.type) })}
              style={{
                background: filters.record_types.includes(entry.type) ? 'var(--bp-surface-2)' : 'none',
                border: '1px solid var(--bp-border)', borderRadius: 3,
                color: TYPE_COLOUR[entry.type] ?? 'var(--bp-text-2)',
                fontFamily: 'var(--bp-font-mono)', fontSize: 10, padding: '3px 8px', cursor: 'pointer',
              }}>{entry.type}</button>
          ))}
        </div>
      )}

      {/* Statuses — only ones that actually occur in this business's rows */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ ...LABEL, marginBottom: 0, minWidth: 64 }}>Status</span>
        {filters.statuses.length === 0 && <span style={{ ...MONO, color: 'var(--bp-text-3)' }}>any status</span>}
        {filters.statuses.map((s) => (
          <span key={s} className="bp-pill" style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {s}
            <X size={10} style={{ cursor: 'pointer' }}
              onClick={() => onChange({ statuses: filters.statuses.filter((v) => v !== s) })} />
          </span>
        ))}
        {allStatuses.length > 0 && (
          <select value="" onChange={(e) => { if (e.target.value) onChange({ statuses: toggle(filters.statuses, e.target.value) }) }}
            style={{
              background: 'var(--bp-surface)', border: '1px solid var(--bp-border)', borderRadius: 3,
              color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 10, padding: '2px 6px',
            }}>
            <option value="">+ status</option>
            {allStatuses.filter((s) => !filters.statuses.includes(s)).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
      </div>

      {/* Time range */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span style={{ ...LABEL, marginBottom: 0, minWidth: 64 }}>Time</span>
        <input type="date"
          value={filters.from ? filters.from.slice(0, 10) : ''}
          onChange={(e) => onChange({ from: e.target.value ? new Date(`${e.target.value}T00:00:00Z`).toISOString() : null })}
          style={{
            background: 'var(--bp-surface)', border: '1px solid var(--bp-border)', borderRadius: 3,
            color: 'var(--bp-text-2)', fontFamily: 'var(--bp-font-mono)', fontSize: 10, padding: '3px 6px',
          }} />
        <span style={{ ...MONO, color: 'var(--bp-text-3)' }}>to</span>
        <input type="date"
          value={filters.to ? filters.to.slice(0, 10) : ''}
          onChange={(e) => onChange({ to: e.target.value ? new Date(`${e.target.value}T23:59:59Z`).toISOString() : null })}
          style={{
            background: 'var(--bp-surface)', border: '1px solid var(--bp-border)', borderRadius: 3,
            color: 'var(--bp-text-2)', fontFamily: 'var(--bp-font-mono)', fontSize: 10, padding: '3px 6px',
          }} />
        {!filters.from && !filters.to && (
          <span style={{ ...MONO, color: 'var(--bp-text-3)' }}>all time</span>
        )}
      </div>
    </div>
  )
}

// ─── Interpretation banner ───────────────────────────────────────────────────

function InterpretationBanner({ interpretation }: { interpretation: Interpretation }) {
  if (interpretation.method === 'none') return null

  const notice = interpretationNotice(interpretation.state, interpretation.method, interpretation.rationale)
  if (!notice) return null

  const degraded = interpretation.state === 'interpreter_unavailable'
    || interpretation.method === 'deterministic_fallback'
  const colour = degraded ? 'var(--bp-amber)' : 'var(--bp-text-3)'

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px',
      border: `1px solid ${degraded ? 'var(--bp-amber)' : 'var(--bp-border)'}`,
      borderRadius: 3, marginBottom: 12,
    }}>
      {degraded ? <AlertTriangle size={13} style={{ color: colour, marginTop: 2, flexShrink: 0 }} />
        : <Info size={13} style={{ color: colour, marginTop: 2, flexShrink: 0 }} />}
      <div>
        <div style={{ ...MONO, color: degraded ? 'var(--bp-amber)' : 'var(--bp-text-2)' }}>
          {notice}
        </div>
        {interpretation.confidence !== null && !degraded && (
          <div style={{ ...MONO, color: 'var(--bp-text-3)', marginTop: 3 }}>
            Interpretation confidence: {(interpretation.confidence * 100).toFixed(0)}%. This is confidence in the
            FILTERS, not in any answer — the records themselves are exact.
          </div>
        )}
        {interpretation.rejected.map((r, i) => (
          <div key={i} style={{ ...MONO, color: 'var(--bp-amber)', marginTop: 3 }}>
            Not applied — {r.field} “{r.value}”: {r.reason}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Summary block ───────────────────────────────────────────────────────────

function SummaryBlock({ summary }: { summary: SearchSummary }) {
  const presentation = summaryPresentation(summary.kind)

  if (presentation.showWithheldExplanation) {
    return (
      <div className="bp-card" style={{ padding: 14, marginBottom: 14, borderLeft: '3px solid var(--bp-amber)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <ShieldQuestion size={13} style={{ color: 'var(--bp-amber)' }} />
          <span style={{ ...LABEL, marginBottom: 0, color: 'var(--bp-amber)' }}>{presentation.heading}</span>
        </div>
        <div style={{ ...MONO, lineHeight: 1.6 }}>{summary.text}</div>
        <div style={{ ...MONO, color: 'var(--bp-amber)', marginTop: 6, lineHeight: 1.5 }}>
          {summary.withheld_reason}
        </div>
      </div>
    )
  }

  if (presentation.markAsInferred) {
    return (
      <div className="bp-card" style={{ padding: 14, marginBottom: 14, borderLeft: '3px solid var(--bp-blue)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Sparkles size={13} style={{ color: 'var(--bp-blue)' }} />
          <span style={{ ...LABEL, marginBottom: 0, color: 'var(--bp-blue)' }}>{presentation.heading}</span>
        </div>
        <div style={{ ...MONO, lineHeight: 1.6, color: 'var(--bp-text)' }}>{summary.text}</div>
        <div style={{ ...MONO, color: 'var(--bp-text-3)', marginTop: 8, lineHeight: 1.5 }}>
          {summary.disclaimer}
        </div>
        {summary.citations.length > 0 && (
          <div style={{ ...MONO, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Cites {summary.citations.length} record(s), each verified against the results below.
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ ...MONO, color: 'var(--bp-text-2)', marginBottom: 12 }}>
      {summary.text}
    </div>
  )
}

// ─── Result card ─────────────────────────────────────────────────────────────

function ResultCard({ record, businessId }: { record: AuditRecord; businessId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [showWhy, setShowWhy] = useState(false)
  const colour = TYPE_COLOUR[record.citation.record_type] ?? 'var(--bp-text-3)'
  const drilldown = drilldownFor(record.citation.record_type, record.href)

  return (
    <div className="bp-card" style={{ padding: 14, marginBottom: 10, borderLeft: `3px solid ${colour}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span className="bp-pill" style={{ fontSize: 9, color: colour, borderColor: colour }}>
          {record.citation.record_type}
        </span>
        {record.status && (
          <span style={{ ...MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>{record.status}</span>
        )}
        {record.actor && (
          <span style={{ ...MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>by {record.actor}</span>
        )}
        <span style={{
          ...MONO, fontSize: 10, marginLeft: 'auto',
          color: FRESHNESS_COLOUR[record.freshness] ?? 'var(--bp-text-3)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <Clock size={10} />
          {rel(record.occurred_at) ?? freshnessWord('unknown')}
          {record.freshness === 'stale' && ` · ${freshnessWord('stale')}`}
        </span>
      </div>

      <div style={{
        fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13,
        color: 'var(--bp-text)', marginBottom: 4,
      }}>{record.title}</div>

      {record.snippet && (
        <div style={{ ...MONO, lineHeight: 1.5, marginBottom: 6 }}>{record.snippet}</div>
      )}

      {/* The citation — the load-bearing part. Table + primary key is what
          makes the result checkable rather than merely plausible. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        paddingTop: 8, borderTop: '1px solid var(--bp-border)',
      }}>
        <span style={{ ...MONO, fontSize: 10, color: 'var(--bp-text-3)', wordBreak: 'break-all' }}>
          {citationLabel(record.citation)}
        </span>

        {drilldown && (
          <Link to={drilldown} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)',
          }}>
            <ExternalLink size={10} /> open in {drilldown.replace('/', '') || 'dashboard'}
          </Link>
        )}

        {/* "Why did this happen?" is answered by #60's panel, not by
            anything this page derives. Rendered inline because the
            explanation is a modal component rather than a route — a link to
            a query string would have been a dead end. */}
        {record.explainable && (
          <button onClick={() => setShowWhy(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none',
            border: 'none', padding: 0, cursor: 'pointer',
            fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)',
          }}>
            <HelpCircle size={10} /> why did this happen?
          </button>
        )}

        {record.matched_terms.length > 0 && (
          <span style={{ ...MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>
            matched: {record.matched_terms.join(', ')}
          </span>
        )}

        <button onClick={() => setExpanded((e) => !e)} style={{
          marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--bp-text-3)',
          fontFamily: 'var(--bp-font-mono)', fontSize: 10, cursor: 'pointer', padding: 0,
        }}>{expanded ? 'hide fields' : 'show fields'}</button>
      </div>

      {expanded && (
        <div style={{ marginTop: 10 }}>
          <div style={LABEL}>Fields copied from the row (redacted)</div>
          <pre style={{
            fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)',
            background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: 0,
          }}>{JSON.stringify(record.fields, null, 2)}</pre>
          {record.snippet_fields.length > 0 && (
            <div style={{ ...MONO, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 6 }}>
              Snippet text was copied verbatim from: {record.snippet_fields.join(', ')}
            </div>
          )}
        </div>
      )}

      {showWhy && record.explainable && (
        <ExplanationPanel
          businessId={businessId}
          kind={record.explainable.kind as 'task' | 'decision'}
          subjectId={record.explainable.id}
          onClose={() => setShowWhy(false)}
        />
      )}
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AuditSearch() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [query, setQuery] = useState('')
  const [summarise, setSummarise] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [vocabulary, setVocabulary] = useState<VocabularyEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Filters the user edited by hand. Null until they touch something — an
  // untouched filter set means "let the interpreter decide", which is a
  // different instruction from "search with no filters".
  const [overrides, setOverrides] = useState<Partial<AppliedFilters> | null>(null)

  useEffect(() => {
    if (!currentBusiness) return
    getAuditSearchVocabulary(currentBusiness.id)
      .then((v) => setVocabulary(v?.record_types ?? []))
      .catch(() => setVocabulary([]))
  }, [currentBusiness])

  const run = useCallback(async (searchQuery: string, filterOverrides: Partial<AppliedFilters> | null) => {
    if (!currentBusiness) return
    setLoading(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { query: searchQuery, summarise }
      if (filterOverrides) {
        body.filters = {
          record_types: filterOverrides.record_types,
          statuses: filterOverrides.statuses,
          terms: filterOverrides.terms,
          from: filterOverrides.from,
          to: filterOverrides.to,
        }
      }
      const res = await runAuditSearch(currentBusiness.id, body as never)
      setResult(res)
    } catch (err) {
      setResult(null)
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [currentBusiness, summarise])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setOverrides(null)
    run(query, null)
  }

  /** Editing a filter re-runs the search with that filter pinned. */
  const patchFilters = (patch: Partial<AppliedFilters>) => {
    if (!result) return
    const next: Partial<AppliedFilters> = {
      record_types: result.applied_filters.record_types,
      statuses: result.applied_filters.statuses,
      terms: result.applied_filters.terms,
      from: result.applied_filters.from,
      to: result.applied_filters.to,
      ...overrides,
      ...patch,
    }
    setOverrides(next)
    run(query, next)
  }

  const clearFilters = () => {
    const cleared: Partial<AppliedFilters> = { record_types: [], statuses: [], terms: [], from: null, to: null }
    setOverrides(cleared)
    run(query, cleared)
  }

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{
          fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24,
          margin: 0, color: 'var(--bp-text)',
        }}>AUDIT SEARCH</h1>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6, lineHeight: 1.6 }}>
          Ask what happened in plain language. Your question is turned into database filters, and every result
          is a real row — cited by table and id, and openable in the surface that owns it. Blueprint never
          answers from memory: if a claim cannot be traced to a retrieved record, it is not shown.
        </p>
      </div>

      <form onSubmit={onSubmit} style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={14} style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--bp-text-3)',
            }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="why was the pricing change rejected last month?"
              style={{
                width: '100%', background: 'var(--bp-surface)', border: '1px solid var(--bp-border)',
                borderRadius: 3, color: 'var(--bp-text)', fontFamily: 'var(--bp-font-mono)',
                fontSize: 12, padding: '9px 10px 9px 30px',
              }} />
          </div>
          <button type="submit" disabled={loading} style={{
            background: 'var(--bp-blue)', border: 'none', borderRadius: 3, color: '#fff',
            fontFamily: 'var(--bp-font-mono)', fontSize: 11, padding: '0 18px',
            cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
          }}>{loading ? 'searching…' : 'Search'}</button>
        </div>

        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8,
          fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', cursor: 'pointer',
        }}>
          <input type="checkbox" checked={summarise} onChange={(e) => setSummarise(e.target.checked)} />
          Also write a short summary (inferred, and discarded automatically if it cannot cite the records)
        </label>
      </form>

      {!result && !loading && (
        <div className="bp-card" style={{ padding: 16 }}>
          <div style={LABEL}>Try asking</div>
          {EXAMPLES.map((example) => (
            <div key={example} onClick={() => { setQuery(example); setOverrides(null); run(example, null) }}
              style={{ ...MONO, color: 'var(--bp-blue)', cursor: 'pointer', padding: '4px 0' }}>
              {example}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="bp-card" style={{ padding: 14, borderLeft: '3px solid var(--bp-red)' }}>
          <div style={{ ...MONO, color: 'var(--bp-red)' }}>{error}</div>
        </div>
      )}

      {result && (
        <>
          {/* State line — the four explicit states, never collapsed into "0 results". */}
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
            border: `1px solid ${STATE_COLOUR[result.state]}`, borderRadius: 3, marginBottom: 12,
          }}>
            <FileSearch size={14} style={{ color: STATE_COLOUR[result.state], marginTop: 2, flexShrink: 0 }} />
            <div>
              <div style={{
                fontFamily: 'var(--bp-font-mono)', fontSize: 11,
                color: STATE_COLOUR[result.state], letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>{stateHeadline(result.state as ViewState)}</div>
              <div style={{ ...MONO, marginTop: 3, lineHeight: 1.5 }}>{result.state_meaning}</div>
            </div>
          </div>

          <InterpretationBanner interpretation={result.interpretation} />

          {/* Ambiguous: Blueprint asks rather than guessing. */}
          {result.state === 'ambiguous_query' && result.interpretation.clarification && (
            <div className="bp-card" style={{ padding: 16, marginBottom: 14, borderLeft: '3px solid var(--bp-amber)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <HelpCircle size={13} style={{ color: 'var(--bp-amber)' }} />
                <span style={{ ...LABEL, marginBottom: 0, color: 'var(--bp-amber)' }}>Needs clarification</span>
              </div>
              <div style={{ ...MONO, lineHeight: 1.6, marginBottom: 10 }}>
                {result.interpretation.clarification.reason}
              </div>
              {result.interpretation.clarification.candidate_readings.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={LABEL}>This could mean</div>
                  {result.interpretation.clarification.candidate_readings.map((r, i) => (
                    <div key={i} style={{ ...MONO, color: 'var(--bp-text-2)' }}>· {r}</div>
                  ))}
                </div>
              )}
              <div style={LABEL}>Answering any of these would resolve it</div>
              {result.interpretation.clarification.questions.map((q, i) => (
                <div key={i} style={{ ...MONO, color: 'var(--bp-text-2)', padding: '2px 0' }}>· {q}</div>
              ))}
              <div style={{ ...MONO, color: 'var(--bp-text-3)', marginTop: 10, lineHeight: 1.5 }}>
                Nothing was searched. You can also set the filters below by hand — a filter you choose is not a
                guess, so the search will run immediately.
              </div>
            </div>
          )}

          <AppliedFilterBar
            filters={result.applied_filters}
            vocabulary={vocabulary}
            onChange={patchFilters}
            onClear={clearFilters}
          />

          {/* Freshness — surfaced, never hidden. */}
          {shouldWarnStale(
            result.freshness.stale,
            result.freshness.historical_query,
            result.freshness.stale_connectors.length,
          ) && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px',
              border: '1px solid var(--bp-amber)', borderRadius: 3, marginBottom: 12,
            }}>
              <Clock size={13} style={{ color: 'var(--bp-amber)', marginTop: 2, flexShrink: 0 }} />
              <div style={{ ...MONO, color: 'var(--bp-amber)', lineHeight: 1.5 }}>
                {result.freshness.summary}
                {result.freshness.stale_connectors.length > 0 && (
                  <div style={{ color: 'var(--bp-text-3)', marginTop: 4 }}>
                    Not synced recently: {result.freshness.stale_connectors.map((c) => c.name ?? c.id).join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}

          <SummaryBlock summary={result.summary} />

          {result.notices.map((notice, i) => (
            <div key={i} style={{
              ...MONO, color: 'var(--bp-text-3)', marginBottom: 6,
              display: 'flex', gap: 6, alignItems: 'flex-start', lineHeight: 1.5,
            }}>
              <Info size={11} style={{ marginTop: 3, flexShrink: 0 }} /> {notice}
            </div>
          ))}

          {result.results.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ ...LABEL, marginBottom: 8 }}>
                {result.results.length} of {result.total_matched} record(s) — each one a real row
              </div>
              {result.results.map((record) => (
                <ResultCard key={record.citation.ref} record={record} businessId={currentBusiness.id} />
              ))}
            </div>
          )}

          {result.limitations.length > 0 && (
            <div className="bp-card" style={{ padding: 14, marginTop: 16 }}>
              <div style={LABEL}>What this search cannot tell you</div>
              {result.limitations.map((l, i) => (
                <div key={i} style={{ ...MONO, color: 'var(--bp-text-3)', padding: '3px 0', lineHeight: 1.5 }}>· {l}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
