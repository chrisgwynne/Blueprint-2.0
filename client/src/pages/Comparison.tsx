import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Columns3, AlertTriangle, HelpCircle, ShieldCheck, Lock } from 'lucide-react'
import useStore from '../lib/store.js'
import {
  getComparableCandidates, compareCandidates, recordComparisonDecision,
  type ComparisonCandidateRef,
} from '../lib/api.js'

/**
 * Recommendation comparison mode (issue #66).
 *
 * Reviewers evaluate recommendations one at a time, which hides the actual
 * trade-off. This page puts a small set of candidates side by side against
 * the SAME operating policy, the SAME evidence window and the SAME
 * dimensions, and is deliberately blunt about what it does not know.
 *
 * Two rules the UI enforces visually:
 *
 *  1. An unknown field is rendered as "unknown" with its reason on hover —
 *     never as 0, never as "—", never as a dash a reader could mistake for
 *     a real zero. The server sends an explicit state per field and this
 *     page renders that state, so there is no place for a default to creep
 *     in.
 *
 *  2. Entering comparison mode does nothing. Loading candidates and
 *     generating the comparison are reads. Only "Record decision" writes,
 *     and even that records a PREFERENCE — it does not approve or execute
 *     the winner, which stays the separate existing approval step.
 */

type FieldState = 'known' | 'unknown' | 'not_comparable'
type CandidateKind = 'task' | 'opportunity' | 'strategy'

interface ComparableSummary {
  id: string
  kind: CandidateKind
  title: string
  decision_class: string
  status: string
  created_at: string
  goal_title: string | null
  confidence: number | null
}

interface ComparableField<T> {
  state: FieldState
  value: T | null
  citation: string | null
  reason: string | null
}

interface DimensionValue {
  candidate_id: string
  state: FieldState
  value: unknown
  display: string
  reason: string | null
}

interface Dimension {
  key: string
  label: string
  group: 'scope' | 'evidence' | 'policy' | 'expected_outcome' | 'cost' | 'risk'
  status: 'shared' | 'differing' | 'unknown_for_all'
  shared_value: unknown
  values: DimensionValue[]
  unknown_candidate_ids: string[]
  note: string
}

interface Candidate {
  id: string
  kind: CandidateKind
  title: string
  decision_class: string
  action_type: string | null
  status: string
  goal_title: string | null
  created_at: string
  evidence: {
    window_start: string
    window_end: string
    window_age_days: number
    applicability_reason: string
    required_connector_types: string[]
  }
  policy: {
    approval_tier: ComparableField<string>
    requires_human_approval: ComparableField<boolean>
    constraint_notes: string[]
  }
  expected_outcome: {
    measured_state: string
    measured_reason: string
    historical_sample_size: number
  }
}

interface ComparisonWarning { code: string; message: string; candidate_ids: string[] }

interface Comparison {
  business_id: string
  generated_at: string
  read_only: true
  comparability: { status: 'comparable' | 'flagged'; decision_classes: string[]; warnings: ComparisonWarning[] }
  shared_policy: { policy_version: number; policy_scope: string; policy_citation: string }
  shared_evidence_window: { start: string; end: string; span_days: number; note: string }
  candidates: Candidate[]
  dimensions: Dimension[]
  shared_dimension_keys: string[]
  differing_dimension_keys: string[]
  unknown_dimension_keys: string[]
  missing_data: Array<{ candidate_id: string; field: string; state: string; reason: string }>
}

const GROUP_LABELS: Record<Dimension['group'], string> = {
  scope: 'Scope',
  evidence: 'Evidence',
  policy: 'Policy constraints',
  expected_outcome: 'Expected outcome',
  cost: 'Cost & effort',
  risk: 'Risk & confidence',
}
const GROUP_ORDER: Dimension['group'][] = ['scope', 'evidence', 'policy', 'expected_outcome', 'cost', 'risk']

const TIER_COLOURS: Record<string, string> = {
  green: 'var(--bp-green)', yellow: 'var(--bp-amber)',
  orange: 'var(--bp-amber)', red: 'var(--bp-red)',
}
const KIND_LABELS: Record<CandidateKind, string> = {
  task: 'Task', opportunity: 'Opportunity', strategy: 'Strategy',
}
const TAXONOMY_LABELS: Record<string, string> = {
  activity: 'No outcome measured yet',
  verified_action: 'Action verified, no metric linked',
  outcome_measured: 'Outcome measured',
  roi_not_measurable: 'Measurement window still open',
}

const mono = (size: number, colour = 'var(--bp-text-2)') => ({
  fontFamily: 'var(--bp-font-mono)', fontSize: size, color: colour,
})
const sectionLabel: React.CSSProperties = {
  fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: 'var(--bp-text-3)',
}

function refKey(ref: ComparisonCandidateRef): string { return `${ref.kind ?? 'task'}:${ref.id}` }
function parseRefs(raw: string | null): ComparisonCandidateRef[] {
  if (!raw) return []
  return raw.split(',').map((chunk) => {
    const [kind, ...rest] = chunk.split(':')
    if (rest.length > 0 && ['task', 'opportunity', 'strategy'].includes(kind!)) {
      return { id: rest.join(':'), kind: kind as CandidateKind }
    }
    return { id: chunk }
  }).filter((r) => r.id)
}

/** Renders a dimension cell. An unknown is stated, never softened into a dash. */
function ValueCell({ value }: { value: DimensionValue }) {
  if (value.state === 'known') {
    return <span style={mono(11, 'var(--bp-text)')}>{value.display}</span>
  }
  return (
    <span
      title={value.reason ?? undefined}
      style={{
        ...mono(10, 'var(--bp-text-3)'),
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontStyle: 'italic', cursor: 'help',
      }}
    >
      <HelpCircle size={10} />
      {value.state === 'unknown' ? 'unknown' : 'not comparable'}
    </span>
  )
}

export default function Comparison() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [searchParams, setSearchParams] = useSearchParams()

  const [pool, setPool] = useState<ComparableSummary[]>([])
  const [selected, setSelected] = useState<ComparisonCandidateRef[]>(() => parseRefs(searchParams.get('ids')))
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [rationale, setRationale] = useState('')
  const [winner, setWinner] = useState<string | null>(null)
  const [decisionResult, setDecisionResult] = useState<string | null>(null)

  const selectedKeys = useMemo(() => new Set(selected.map(refKey)), [selected])

  const loadPool = useCallback(async () => {
    if (!currentBusiness) return
    try {
      const result = await getComparableCandidates(currentBusiness.id)
      setPool(result?.candidates ?? [])
    } catch (err) {
      setPool([])
      setError((err as Error).message)
    }
  }, [currentBusiness])

  useEffect(() => { loadPool() }, [loadPool])

  // Switching business invalidates a comparison built in another scope —
  // candidates are never comparable across businesses.
  useEffect(() => {
    setSelected([]); setComparison(null); setWinner(null); setDecisionResult(null)
  }, [currentBusiness?.id])

  const toggle = (summary: ComparableSummary) => {
    const ref: ComparisonCandidateRef = { id: summary.id, kind: summary.kind }
    setComparison(null)
    setDecisionResult(null)
    setSelected((prev) => {
      const next = prev.some((r) => refKey(r) === refKey(ref))
        ? prev.filter((r) => refKey(r) !== refKey(ref))
        : [...prev, ref]
      setSearchParams(next.length ? { ids: next.map(refKey).join(',') } : {}, { replace: true })
      return next
    })
  }

  const runComparison = useCallback(async (refs: ComparisonCandidateRef[]) => {
    if (!currentBusiness || refs.length < 2) return
    setBusy(true); setError(null); setDecisionResult(null)
    try {
      setComparison(await compareCandidates(currentBusiness.id, refs))
    } catch (err) {
      setComparison(null)
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [currentBusiness])

  // Arriving from Recommendations with ?ids=… already names the set, so
  // render it straight away. Still a read — this triggers no action.
  const [autoRan, setAutoRan] = useState(false)
  useEffect(() => {
    if (autoRan || !currentBusiness) return
    const initial = parseRefs(searchParams.get('ids'))
    if (initial.length >= 2) { setAutoRan(true); runComparison(initial) }
  }, [autoRan, currentBusiness, searchParams, runComparison])

  const submitDecision = async (outcome: 'selected' | 'deferred') => {
    if (!currentBusiness || !comparison) return
    if (!rationale.trim()) { setError('A rationale is required — a recorded decision must say why.'); return }
    if (outcome === 'selected' && !winner) { setError('Pick the candidate you are selecting, or record a deferral instead.'); return }
    setBusy(true); setError(null)
    try {
      const record = await recordComparisonDecision(currentBusiness.id, {
        candidates: selected,
        outcome,
        selected_candidate_id: outcome === 'selected' ? winner : null,
        rationale: rationale.trim(),
      })
      setDecisionResult(
        outcome === 'selected'
          ? `Recorded decision ${record.decision_id}, citing ${record.policy_citation}. Nothing was approved or executed — the selected candidate still needs the normal approval step.`
          : `Recorded deferral ${record.decision_id}, citing ${record.policy_citation}. No candidate was selected, approved or executed.`,
      )
      setRationale('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  const byGroup = GROUP_ORDER
    .map((group) => ({ group, dims: (comparison?.dimensions ?? []).filter((d) => d.group === group) }))
    .filter((g) => g.dims.length > 0)

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Columns3 size={20} style={{ color: 'var(--bp-blue)' }} />
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>
            COMPARE RECOMMENDATIONS
          </h1>
        </div>
        <p style={{ ...mono(12, 'var(--bp-text-3)'), marginTop: 6 }}>
          Put candidates from <strong>{currentBusiness.name}</strong> side by side against the same operating policy,
          the same evidence window and the same fields. Estimates are shown as estimates; anything unknown is marked
          as unknown rather than filled in.
        </p>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8,
          padding: '4px 10px', borderRadius: 3, background: 'var(--bp-surface-2)',
        }}>
          <Lock size={11} style={{ color: 'var(--bp-green)' }} />
          <span style={mono(10, 'var(--bp-text-2)')}>
            Comparison mode takes no action. Nothing here approves, schedules or executes anything.
          </span>
        </div>
      </div>

      {error && (
        <div className="bp-card" style={{ padding: 12, marginBottom: 14, borderLeft: '3px solid var(--bp-red)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={12} style={{ color: 'var(--bp-red)' }} />
            <span style={mono(11, 'var(--bp-red)')}>{error}</span>
          </div>
        </div>
      )}

      {/* ─── Pick candidates ────────────────────────────────────────── */}
      <div className="bp-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ ...sectionLabel, marginBottom: 10 }}>
          Select 2–6 candidates in this business
        </div>
        {pool.length === 0 ? (
          <div style={mono(11, 'var(--bp-text-3)')}>
            Nothing awaiting a decision right now — no proposed tasks, pending opportunities or candidate strategies.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
            {pool.map((c) => {
              const checked = selectedKeys.has(refKey({ id: c.id, kind: c.kind }))
              return (
                <label
                  key={`${c.kind}:${c.id}`}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
                    borderRadius: 3, cursor: 'pointer',
                    background: checked ? 'var(--bp-surface-2)' : 'transparent',
                    border: `1px solid ${checked ? 'var(--bp-blue)' : 'var(--bp-border)'}`,
                  }}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(c)} style={{ marginTop: 3 }} />
                  <span>
                    <span style={{ ...mono(11, 'var(--bp-text)'), display: 'block' }}>{c.title}</span>
                    <span style={mono(9, 'var(--bp-text-3)')}>
                      {KIND_LABELS[c.kind]} · {c.decision_class}
                      {c.goal_title ? ` · serves "${c.goal_title}"` : ''}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <button
            className="bp-btn bp-btn-primary"
            disabled={selected.length < 2 || busy}
            onClick={() => runComparison(selected)}
            style={{ fontSize: 11 }}
          >
            {busy ? 'Working…' : `Compare ${selected.length} selected`}
          </button>
          <span style={mono(10, 'var(--bp-text-3)')}>
            {selected.length < 2 ? 'Pick at least two.' : 'Generating a comparison reads only — it changes nothing.'}
          </span>
        </div>
      </div>

      {comparison && (
        <>
          {/* ─── What is shared across every candidate ──────────────── */}
          <div className="bp-card" style={{ padding: 16, marginBottom: 16, borderLeft: '3px solid var(--bp-green)' }}>
            <div style={{ ...sectionLabel, marginBottom: 8 }}>Shared by every candidate</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <ShieldCheck size={12} style={{ color: 'var(--bp-green)' }} />
              <span style={mono(11)}>
                Policy in force: <strong style={{ color: 'var(--bp-text)' }}>{comparison.shared_policy.policy_citation}</strong>
                {' '}(v{comparison.shared_policy.policy_version}, {comparison.shared_policy.policy_scope})
              </span>
            </div>
            <div style={{ ...mono(11), marginBottom: 6 }}>{comparison.shared_evidence_window.note}</div>
            {comparison.shared_dimension_keys.length > 0 && (
              <div style={mono(11)}>
                Identical across all candidates:{' '}
                {comparison.dimensions
                  .filter((d) => d.status === 'shared')
                  .map((d) => `${d.label} (${d.values[0]?.display})`)
                  .join(' · ')}
              </div>
            )}
          </div>

          {/* ─── Comparability warnings ─────────────────────────────── */}
          {comparison.comparability.warnings.length > 0 && (
            <div className="bp-card" style={{ padding: 16, marginBottom: 16, borderLeft: '3px solid var(--bp-amber)' }}>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>Read this before trusting the table</div>
              {comparison.comparability.warnings.map((w) => (
                <div key={w.code} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <AlertTriangle size={12} style={{ color: 'var(--bp-amber)', flexShrink: 0, marginTop: 2 }} />
                  <span style={mono(11)}>{w.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* ─── Candidate headers ──────────────────────────────────── */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `220px repeat(${comparison.candidates.length}, minmax(200px, 1fr))`,
            gap: 8, marginBottom: 8,
          }}>
            <div />
            {comparison.candidates.map((c) => {
              const tier = c.policy.approval_tier.value
              return (
                <div key={c.id} className="bp-card" style={{
                  padding: 12,
                  borderTop: `3px solid ${TIER_COLOURS[String(tier)] ?? 'var(--bp-text-3)'}`,
                }}>
                  <div style={{ ...mono(9, 'var(--bp-text-3)'), marginBottom: 4 }}>
                    {KIND_LABELS[c.kind]} · {c.decision_class}
                  </div>
                  <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13, color: 'var(--bp-text)', marginBottom: 6 }}>
                    {c.title}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    <span className="bp-pill" style={{
                      fontSize: 9,
                      background: `${TIER_COLOURS[String(tier)] ?? 'var(--bp-text-3)'}20`,
                      color: TIER_COLOURS[String(tier)] ?? 'var(--bp-text-3)',
                    }}>
                      {tier ? `${tier} tier` : 'tier unknown'}
                    </span>
                    <span className="bp-pill" style={{ fontSize: 9, background: 'var(--bp-surface-2)', color: 'var(--bp-text-3)' }}>
                      {TAXONOMY_LABELS[c.expected_outcome.measured_state] ?? c.expected_outcome.measured_state}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* ─── The comparison table ───────────────────────────────── */}
          {byGroup.map(({ group, dims }) => (
            <div key={group} style={{ marginBottom: 14 }}>
              <div style={{ ...sectionLabel, marginBottom: 6 }}>{GROUP_LABELS[group]}</div>
              <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
                {dims.map((d, i) => (
                  <div
                    key={d.key}
                    title={d.note}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `220px repeat(${comparison.candidates.length}, minmax(200px, 1fr))`,
                      gap: 8, padding: '8px 12px', alignItems: 'center',
                      borderTop: i === 0 ? 'none' : '1px solid var(--bp-border)',
                      background: d.status === 'differing' ? 'var(--bp-surface-2)' : 'transparent',
                    }}
                  >
                    <div>
                      <div style={mono(11, 'var(--bp-text-2)')}>{d.label}</div>
                      <div style={mono(9, d.status === 'differing' ? 'var(--bp-amber)' : 'var(--bp-text-3)')}>
                        {d.status === 'shared' ? 'shared' : d.status === 'differing' ? 'differs' : 'unknown for all'}
                      </div>
                    </div>
                    {comparison.candidates.map((c) => (
                      <div key={c.id}>
                        <ValueCell value={d.values.find((v) => v.candidate_id === c.id)!} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* ─── Policy constraints in words ────────────────────────── */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ ...sectionLabel, marginBottom: 6 }}>
              What the policy says about each candidate
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${comparison.candidates.length}, minmax(220px, 1fr))`,
              gap: 8,
            }}>
              {comparison.candidates.map((c) => (
                <div key={c.id} className="bp-card" style={{ padding: 12 }}>
                  <div style={{ ...mono(10, 'var(--bp-text-3)'), marginBottom: 6 }}>{c.title}</div>
                  {c.policy.constraint_notes.map((note, i) => (
                    <div key={i} style={{ ...mono(10), marginBottom: 4 }}>· {note}</div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* ─── Explicit holes ─────────────────────────────────────── */}
          {comparison.missing_data.length > 0 && (
            <div className="bp-card" style={{ padding: 16, marginBottom: 16, borderLeft: '3px solid var(--bp-text-3)' }}>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>
                What we do not know ({comparison.missing_data.length} field{comparison.missing_data.length === 1 ? '' : 's'})
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                {comparison.missing_data.map((m, i) => {
                  const c = comparison.candidates.find((x) => x.id === m.candidate_id)
                  return (
                    <div key={i} style={{ ...mono(10), padding: '3px 0' }}>
                      <strong style={{ color: 'var(--bp-text-2)' }}>{c?.title ?? m.candidate_id}</strong>
                      {' — '}
                      <span style={{ color: 'var(--bp-text-3)' }}>{m.field}:</span> {m.reason}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ─── Record the decision ────────────────────────────────── */}
          <div className="bp-card" style={{ padding: 16, marginBottom: 24, borderLeft: '3px solid var(--bp-blue)' }}>
            <div style={{ ...sectionLabel, marginBottom: 8 }}>Record a decision</div>
            <p style={{ ...mono(10, 'var(--bp-text-3)'), marginTop: 0, marginBottom: 10 }}>
              This records a preference in decision memory, citing{' '}
              {comparison.shared_policy.policy_citation}. It does <strong>not</strong> approve or execute the
              selected candidate — that stays a separate approval step.
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {comparison.candidates.map((c) => (
                <label key={c.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                  border: `1px solid ${winner === c.id ? 'var(--bp-blue)' : 'var(--bp-border)'}`,
                  borderRadius: 3, cursor: 'pointer',
                }}>
                  <input
                    type="radio" name="comparison-winner" checked={winner === c.id}
                    onChange={() => setWinner(c.id)}
                  />
                  <span style={mono(11)}>{c.title}</span>
                </label>
              ))}
            </div>

            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why this one, or why none of them yet? Required — a decision without a stated reason is not decision memory."
              rows={3}
              style={{
                width: '100%', ...mono(11, 'var(--bp-text)'),
                background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border)',
                borderRadius: 3, padding: 8, marginBottom: 10, resize: 'vertical',
              }}
            />

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="bp-btn bp-btn-primary"
                disabled={busy || !rationale.trim() || !winner}
                onClick={() => submitDecision('selected')}
                style={{ fontSize: 11 }}
              >
                Record selection
              </button>
              <button
                className="bp-btn bp-btn-ghost"
                disabled={busy || !rationale.trim()}
                onClick={() => submitDecision('deferred')}
                style={{ fontSize: 11 }}
              >
                Defer all — record no winner
              </button>
            </div>

            {decisionResult && (
              <div style={{ ...mono(11, 'var(--bp-green)'), marginTop: 10 }}>{decisionResult}</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
