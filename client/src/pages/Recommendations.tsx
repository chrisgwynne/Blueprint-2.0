import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ListChecks, AlertTriangle, Columns3 } from 'lucide-react'
import useStore from '../lib/store.js'
import { getRecommendations } from '../lib/api.js'

interface Explanation {
  evidence: string[]
  reasoning: string[]
  alternatives_considered: Array<{ id: string; title: string; score: number }>
  confidence: number | null
  risk: string
  expected_impact: string | null
  historical_evidence: { success_rate: number | null; sample_size: number }
  linked_kb: unknown[]
  linked_signals: unknown[]
  linked_metrics: Record<string, unknown> | null
}

interface Recommendation {
  id: string
  source_type: 'task' | 'opportunity' | 'strategy'
  title: string
  score: number
  rationale: string[]
  goal_title?: string | null
  has_open_conflict: boolean
  explanation: Explanation
  [key: string]: unknown
}

interface Excluded {
  id: string
  source_type: string
  title: string
  reason: string
}

const SOURCE_LABELS: Record<string, string> = { task: 'Task', opportunity: 'Opportunity', strategy: 'Strategy' }
const SOURCE_COLORS: Record<string, string> = { task: 'var(--bp-blue)', opportunity: 'var(--bp-purple)', strategy: 'var(--bp-green)' }

function RecommendationCard({ rec, selected, onToggleSelect }: {
  rec: Recommendation
  selected: boolean
  onToggleSelect: (rec: Recommendation) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const color = SOURCE_COLORS[rec.source_type] ?? 'var(--bp-blue)'
  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 10, borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {/* Selecting for comparison takes no action — it only builds a set. */}
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(rec)}
          title="Select for side-by-side comparison. Selecting takes no action."
        />
        <span className="bp-pill" style={{ background: `${color}20`, color, fontSize: 9 }}>{SOURCE_LABELS[rec.source_type] ?? rec.source_type}</span>
        {rec.has_open_conflict && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-amber)' }}>
            <AlertTriangle size={10} /> open conflict
          </span>
        )}
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginLeft: 'auto' }}>score {rec.score.toFixed(3)}</span>
      </div>
      <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)', marginBottom: 4 }}>{rec.title}</div>
      {rec.goal_title && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 8 }}>Serves: {rec.goal_title}</div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {rec.rationale.map((r, i) => (
          <span key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', background: 'var(--bp-surface-2)', padding: '3px 8px', borderRadius: 3 }}>{r}</span>
        ))}
      </div>
      <button onClick={() => setExpanded((e) => !e)} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}>
        {expanded ? 'Hide explanation' : 'Why this recommendation?'}
      </button>
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bp-border)' }}>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>Evidence</div>
            {rec.explanation.evidence.map((e, i) => (
              <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{e}</div>
            ))}
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 8 }}>
            <strong style={{ color: 'var(--bp-text-3)' }}>Risk:</strong> {rec.explanation.risk}
          </div>
          {rec.explanation.expected_impact && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 8 }}>
              <strong style={{ color: 'var(--bp-text-3)' }}>Expected impact:</strong> {rec.explanation.expected_impact}
            </div>
          )}
          {rec.explanation.alternatives_considered.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>Alternatives considered</div>
              {rec.explanation.alternatives_considered.map((a) => (
                <div key={a.id} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{a.title} (score {a.score.toFixed(3)})</div>
              ))}
            </div>
          )}
          {rec.explanation.linked_kb.length > 0 && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
              {rec.explanation.linked_kb.length} related knowledge base entr{rec.explanation.linked_kb.length === 1 ? 'y' : 'ies'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Recommendations() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const navigate = useNavigate()
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [excluded, setExcluded] = useState<Excluded[]>([])
  const [depth, setDepth] = useState('')
  // Comparison selection (issue #66). Held as `kind:id` refs so the
  // comparison page can resolve each candidate against the right table.
  const [compareRefs, setCompareRefs] = useState<string[]>([])

  const load = useCallback(async () => {
    if (!currentBusiness) return
    try {
      const result = await getRecommendations(currentBusiness.id)
      setRecommendations(result?.recommendations || [])
      setExcluded(result?.excluded || [])
      setDepth(result?.explanation_depth || '')
    } catch { setRecommendations([]); setExcluded([]) }
  }, [currentBusiness])

  useEffect(() => { load() }, [load])

  // A comparison is only valid within one business scope, so switching
  // business clears the selection rather than carrying it across.
  useEffect(() => { setCompareRefs([]) }, [currentBusiness?.id])

  const selectedSet = useMemo(() => new Set(compareRefs), [compareRefs])
  const toggleCompare = useCallback((rec: Recommendation) => {
    const ref = `${rec.source_type}:${rec.id}`
    setCompareRefs((prev) => (prev.includes(ref) ? prev.filter((r) => r !== ref) : [...prev, ref]))
  }, [])

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ListChecks size={20} style={{ color: 'var(--bp-blue)' }} />
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>RECOMMENDATIONS</h1>
        </div>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
          What should we do next? Ranked by impact, goal importance, urgency, confidence, effort, historical success, and risk.
        </p>
        {depth && <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>{depth}</p>}
      </div>

      {/* ─── Comparison mode entry point (issue #66) ─────────────────────
          Tick two or more and open them side by side. Nothing is
          approved or executed by comparing. */}
      <div className="bp-card" style={{ padding: 12, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Columns3 size={14} style={{ color: 'var(--bp-blue)' }} />
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
          Tick two or more recommendations to compare them side by side against the same policy and evidence.
          Comparing takes no action.
        </span>
        <button
          className="bp-btn bp-btn-primary"
          style={{ fontSize: 10, marginLeft: 'auto' }}
          disabled={compareRefs.length < 2}
          onClick={() => navigate(`/comparison?ids=${encodeURIComponent(compareRefs.join(','))}`)}
        >
          Compare {compareRefs.length} selected
        </button>
      </div>

      {recommendations.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          Nothing actionable right now — no proposed tasks, pending opportunities, or candidate strategies.
        </div>
      ) : (
        recommendations.map((r) => (
          <RecommendationCard
            key={r.id}
            rec={r}
            selected={selectedSet.has(`${r.source_type}:${r.id}`)}
            onToggleSelect={toggleCompare}
          />
        ))
      )}

      {excluded.length > 0 && (
        <div className="bp-card" style={{ padding: 16, marginTop: 20, borderLeft: '3px solid var(--bp-text-3)' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 10 }}>
            What we deliberately did not recommend
          </div>
          {excluded.map((e) => (
            <div key={e.id} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', padding: '4px 0' }}>
              <strong>{e.title}</strong> — {e.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
