import React, { useEffect, useState, useCallback } from 'react'
import { Sparkles, TrendingUp, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react'
import useStore from '../lib/store'
import {
  getScenarios, getScenario, modelScenario, deleteScenario,
} from '../lib/api'

const EXAMPLES = [
  'What happens if we raise prices 20%?',
  'Should we pause paid ads and invest in content?',
  "What's the fastest path to £5k MRR?",
  'What if we focused on one customer segment only?',
]

interface ScenarioOption {
  name: string
  core_assumption?: string
  projected_impact?: { summary?: string }
  time_to_results_days?: number | null
  confidence?: number
  confidence_reasoning?: string
  key_risks?: string[]
  requires_to_succeed?: string[]
  verdict?: string
}

interface ScenarioResult {
  id: string
  question: string
  scenarios?: ScenarioOption[]
  recommended?: string
  recommendation_reasoning?: string
  decision_criteria?: string[]
  next_step?: string
}

interface ScenarioSummary {
  id: string
  question: string
  created_at: string
}

interface ConfidenceBarProps {
  value: number | undefined
}

function ConfidenceBar({ value }: ConfidenceBarProps) {
  const pct = Math.round((value ?? 0) * 100)
  const color = pct >= 70 ? 'var(--bp-green)' : pct >= 40 ? 'var(--bp-amber)' : 'var(--bp-red)'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 4 }}>
        <span>Confidence</span>
        <span style={{ color }}>{pct}%</span>
      </div>
      <div style={{ height: 4, background: 'var(--bp-surface-3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
    </div>
  )
}

interface ScenarioCardProps {
  scenario: ScenarioOption
  recommended: string | undefined
}

function ScenarioCard({ scenario, recommended }: ScenarioCardProps) {
  const isRec = scenario.name === recommended
  return (
    <div className="bp-card" style={{
      padding: 18,
      borderLeft: `3px solid ${isRec ? 'var(--bp-green)' : 'var(--bp-border)'}`,
      background: isRec ? 'var(--bp-surface-2)' : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14 }}>
          {scenario.name}
        </div>
        {isRec && (
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--bp-green)', textTransform: 'uppercase' }}>
            ⭐ Recommended
          </span>
        )}
      </div>
      {scenario.core_assumption && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 10 }}>
          <strong>Assumption:</strong> {scenario.core_assumption}
        </div>
      )}
      {scenario.projected_impact?.summary && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', marginBottom: 10 }}>
          <TrendingUp size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {scenario.projected_impact.summary}
        </div>
      )}
      {scenario.time_to_results_days != null && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 10 }}>
          Time to results: {scenario.time_to_results_days} days
        </div>
      )}
      <div style={{ marginBottom: 10 }}>
        <ConfidenceBar value={scenario.confidence} />
        {scenario.confidence_reasoning && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginTop: 6 }}>
            {scenario.confidence_reasoning}
          </div>
        )}
      </div>
      {Array.isArray(scenario.key_risks) && scenario.key_risks.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>
            <AlertTriangle size={9} style={{ verticalAlign: 'middle', marginRight: 3 }} />
            Risks
          </div>
          {scenario.key_risks.map((r, i) => (
            <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', padding: '2px 0' }}>
              • {r}
            </div>
          ))}
        </div>
      )}
      {Array.isArray(scenario.requires_to_succeed) && scenario.requires_to_succeed.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>
            Must be true
          </div>
          {scenario.requires_to_succeed.map((r, i) => (
            <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', padding: '2px 0' }}>
              • {r}
            </div>
          ))}
        </div>
      )}
      {scenario.verdict && (
        <div style={{
          marginTop: 8, padding: 10,
          background: 'var(--bp-surface-3)',
          borderRadius: 3,
          fontFamily: 'var(--bp-font-mono)', fontSize: 11,
          color: 'var(--bp-text)', fontStyle: 'italic',
        }}>
          "{scenario.verdict}"
        </div>
      )}
    </div>
  )
}

export default function Scenarios() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [history, setHistory] = useState<ScenarioSummary[]>([])
  const [question, setQuestion] = useState('')
  const [context, setContext] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ScenarioResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!currentBusiness) return
    const rows = await getScenarios(currentBusiness.id).catch(() => [])
    setHistory(rows || [])
    const params = new URLSearchParams(window.location.search)
    const id = params.get('id')
    if (id) {
      try {
        const s = await getScenario(currentBusiness.id, id)
        if (s) setResult(s as ScenarioResult)
      } catch {}
    }
  }, [currentBusiness])

  useEffect(() => { load() }, [load])

  async function handleAsk(q = question) {
    if (!q?.trim() || !currentBusiness) return
    setLoading(true); setError(null); setResult(null)
    try {
      const r = await modelScenario(currentBusiness.id, q, context)
      setResult(r as ScenarioResult)
      await load()
    } catch (err) {
      const e = err as Error
      setError(e.message || 'Failed to model scenarios')
    } finally {
      setLoading(false)
    }
  }

  async function handleOpen(id: string) {
    try {
      const s = await getScenario(currentBusiness!.id, id)
      if (s) {
        const sr = s as ScenarioResult
        setResult(sr)
        setQuestion(sr.question || '')
      }
    } catch {}
  }

  async function handleDelete(id: string) {
    await deleteScenario(currentBusiness!.id, id)
    if (result?.id === id) setResult(null)
    await load()
  }

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto', display: 'grid', gridTemplateColumns: '240px 1fr', gap: 20 }}>
      {/* Sidebar history */}
      <div>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 10 }}>
          History
        </div>
        {history.length === 0 ? (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
            No scenarios yet.
          </div>
        ) : history.map((h) => (
          <div key={h.id}
            className="bp-card"
            onClick={() => handleOpen(h.id)}
            style={{ padding: 10, marginBottom: 6, cursor: 'pointer', background: result?.id === h.id ? 'var(--bp-surface-2)' : undefined }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', lineHeight: 1.3 }}>
              {h.question.length > 60 ? h.question.slice(0, 60) + '…' : h.question}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
                {new Date(h.created_at).toLocaleDateString()}
              </div>
              <button onClick={(e) => { e.stopPropagation(); handleDelete(h.id) }}
                style={{ background: 'none', border: 'none', color: 'var(--bp-text-3)', cursor: 'pointer', padding: 0 }}>
                <Trash2 size={10} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Main panel */}
      <div>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0 }}>SCENARIOS</h1>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Ask a strategic "what if" — Blueprint models 3-4 distinct options side-by-side
          </p>
        </div>

        <div className="bp-card" style={{ padding: 18, marginBottom: 20 }}>
          <textarea className="bp-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a strategic question about your business..."
            rows={3}
            style={{ width: '100%', fontSize: 13, marginBottom: 8 }} />
          <input className="bp-input"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Optional: additional context..."
            style={{ width: '100%', fontSize: 11, marginBottom: 10 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {EXAMPLES.map((ex, i) => (
                <button key={i} onClick={() => setQuestion(ex)}
                  className="bp-pill bp-pill-grey"
                  style={{ fontSize: 10, cursor: 'pointer', background: 'none', border: '1px solid var(--bp-border)' }}>
                  {ex}
                </button>
              ))}
            </div>
            <button onClick={() => handleAsk()} disabled={loading || !question.trim()} className="bp-btn bp-btn-primary" style={{ fontSize: 12 }}>
              <Sparkles size={12} /> {loading ? 'Modelling…' : 'Model scenarios'}
            </button>
          </div>
        </div>

        {error && (
          <div className="bp-card" style={{ padding: 14, marginBottom: 20, borderLeft: '3px solid var(--bp-red)', color: 'var(--bp-red)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
            {error}
          </div>
        )}

        {result && (
          <div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 4 }}>
                Question
              </div>
              <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 16 }}>
                {result.question}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 20 }}>
              {(result.scenarios || []).map((s, i) => (
                <ScenarioCard key={i} scenario={s} recommended={result.recommended} />
              ))}
            </div>
            {result.recommendation_reasoning && (
              <div className="bp-card" style={{ padding: 16, marginBottom: 14, borderLeft: '3px solid var(--bp-green)' }}>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-green)', textTransform: 'uppercase', marginBottom: 6 }}>
                  <CheckCircle2 size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  Recommendation
                </div>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text)', lineHeight: 1.5 }}>
                  {result.recommendation_reasoning}
                </div>
              </div>
            )}
            {Array.isArray(result.decision_criteria) && result.decision_criteria.length > 0 && (
              <div className="bp-card" style={{ padding: 16, marginBottom: 14 }}>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 8 }}>
                  Decision criteria
                </div>
                {result.decision_criteria.map((c, i) => (
                  <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', padding: '2px 0' }}>
                    • {c}
                  </div>
                ))}
              </div>
            )}
            {result.next_step && (
              <div className="bp-card" style={{ padding: 16, borderLeft: '3px solid var(--bp-blue)' }}>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-blue)', textTransform: 'uppercase', marginBottom: 6 }}>
                  Next step
                </div>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text)' }}>
                  {result.next_step}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
