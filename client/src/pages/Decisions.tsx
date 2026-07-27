import React, { useEffect, useState, useCallback } from 'react'
import { History, Search } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import useStore from '../lib/store.js'
import { getDecisions } from '../lib/api.js'

interface Decision {
  id: string
  business_id: string
  decision_type: string
  title: string
  decision: string
  reasoning?: string | null
  evidence?: unknown[]
  alternatives_rejected?: unknown[]
  confidence?: number | null
  author: string
  related_goal_id?: string | null
  related_task_id?: string | null
  created_at: string
  [key: string]: unknown
}

const DECISION_TYPES = [
  '', 'task_approval', 'task_rejection', 'strategy_selection', 'conflict_resolution',
  'conflict_dismissal', 'opportunity_accepted', 'opportunity_dismissed',
];

function DecisionCard({ decision }: { decision: Decision }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 10, borderLeft: '3px solid var(--bp-blue)', cursor: 'pointer' }}
      onClick={() => setExpanded((e) => !e)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <History size={13} style={{ color: 'var(--bp-blue)' }} />
        <span className="bp-pill bp-pill-blue" style={{ fontSize: 9 }}>{decision.decision_type}</span>
        {decision.confidence != null && (
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{Math.round(decision.confidence * 100)}% confidence</span>
        )}
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginLeft: 'auto' }}>
          {formatDistanceToNow(parseTimestamp(decision.created_at) || new Date(), { addSuffix: true })} · {decision.author}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13, color: 'var(--bp-text)', marginBottom: 4 }}>
        {decision.title}
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
        {decision.decision}
      </div>
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bp-border)' }}>
          {decision.reasoning && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>Reasoning</div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{decision.reasoning}</div>
            </div>
          )}
          {Array.isArray(decision.evidence) && decision.evidence.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>Evidence</div>
              <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(decision.evidence, null, 2)}
              </pre>
            </div>
          )}
          {Array.isArray(decision.alternatives_rejected) && decision.alternatives_rejected.length > 0 && (
            <div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>Alternatives rejected</div>
              <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(decision.alternatives_rejected, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Decisions() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [decisionType, setDecisionType] = useState('')

  const load = useCallback(async () => {
    if (!currentBusiness) return
    try {
      const result = await getDecisions(currentBusiness.id, { q: q || undefined, decision_type: decisionType || undefined })
      setDecisions(result?.decisions || [])
      setTotal(result?.total ?? 0)
    } catch { setDecisions([]); setTotal(0) }
  }, [currentBusiness, q, decisionType])

  useEffect(() => { load() }, [load])

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>DECISION HISTORY</h1>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
          Why did we decide this? — every decision, with the evidence and alternatives behind it. {total} recorded.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--bp-text-3)' }} />
          <input className="bp-input" placeholder="Search decisions…" style={{ width: '100%', paddingLeft: 28, fontSize: 12 }}
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="bp-input" style={{ fontSize: 12 }} value={decisionType} onChange={(e) => setDecisionType(e.target.value)}>
          {DECISION_TYPES.map((t) => <option key={t} value={t}>{t || 'All types'}</option>)}
        </select>
      </div>

      {decisions.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          No decisions recorded yet. Decisions are recorded automatically as agents approve tasks, resolve conflicts, choose strategies, and accept or dismiss opportunities.
        </div>
      ) : (
        decisions.map((d) => <DecisionCard key={d.id} decision={d} />)
      )}
    </div>
  )
}
