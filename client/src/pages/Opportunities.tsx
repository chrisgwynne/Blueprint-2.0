import React, { useEffect, useState, useCallback } from 'react'
import { Lightbulb, Check, X, RefreshCw } from 'lucide-react'
import useStore from '../lib/store.js'
import {
  getGoalSuggestions, runGoalSuggestionScan,
  acceptGoalSuggestion, dismissGoalSuggestion, snoozeGoalSuggestion,
} from '../lib/api.js'
import type { GoalSuggestion } from '../types/index.js'

const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'all', label: 'All' },
]

function OpportunityCard({ opp, businessId, onRefresh }: { opp: GoalSuggestion; businessId: string; onRefresh: () => Promise<void> }) {
  const [working, setWorking] = useState(false)
  async function handle(fn: () => Promise<unknown>) { setWorking(true); try { await fn(); await onRefresh() } finally { setWorking(false) } }

  const val = opp.opportunity_value
  const unit = opp.opportunity_unit?.startsWith('gbp') ? '£' : opp.opportunity_unit?.startsWith('usd') ? '$' : ''
  const isActive = opp.status === 'pending' || opp.status === 'snoozed'

  return (
    <div className="bp-card" style={{ padding: 18, marginBottom: 12, borderLeft: '3px solid var(--bp-purple)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <Lightbulb size={14} style={{ color: 'var(--bp-purple)', marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)' }}>{opp.title}</div>
          {opp.description && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginTop: 4 }}>{opp.description}</div>
          )}
        </div>
        {val != null && (
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Opportunity</div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 16, color: 'var(--bp-purple)' }}>
              {unit}{Math.round(val).toLocaleString()}<span style={{ fontSize: 10, color: 'var(--bp-text-3)', fontWeight: 400 }}>/mo</span>
            </div>
          </div>
        )}
      </div>

      {opp.why_it_matters && (
        <div style={{ padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3, marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>Why it matters</div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>{opp.why_it_matters}</div>
        </div>
      )}

      {opp.barrier && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 6 }}>
          <strong style={{ color: 'var(--bp-text-2)' }}>Barrier:</strong> {opp.barrier}
        </div>
      )}

      {Array.isArray(opp.related_risks) && opp.related_risks.length > 0 && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-amber)', marginBottom: 6 }}>
          <strong>Risks:</strong> {opp.related_risks.join('; ')}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 10 }}>
        {opp.metric_name && <span>{opp.metric_name} · {opp.current_value} → {opp.target_value}</span>}
        {opp.confidence != null && <span>{Math.round(opp.confidence * 100)}% confidence</span>}
        {opp.required_effort && <span>{opp.required_effort} effort</span>}
        {Array.isArray(opp.related_goal_ids) && opp.related_goal_ids.length > 0 && <span>{opp.related_goal_ids.length} related goal(s)</span>}
      </div>

      {isActive ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => handle(() => acceptGoalSuggestion(businessId, opp.id))} disabled={working} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
            <Check size={11} /> Set as goal
          </button>
          <button onClick={() => handle(() => dismissGoalSuggestion(businessId, opp.id, prompt('Reason?') ?? ''))} disabled={working} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
            <X size={11} /> Dismiss
          </button>
          <button onClick={() => handle(() => snoozeGoalSuggestion(businessId, opp.id, 30))} disabled={working} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
            Snooze 30d
          </button>
        </div>
      ) : (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>{opp.status}</div>
      )}
    </div>
  )
}

export default function Opportunities() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [tab, setTab] = useState('active')
  const [opportunities, setOpportunities] = useState<GoalSuggestion[]>([])
  const [scanning, setScanning] = useState(false)

  const load = useCallback(async () => {
    if (!currentBusiness) return
    try {
      const { suggestions } = await getGoalSuggestions(currentBusiness.id, tab) ?? {}
      setOpportunities(suggestions || [])
    } catch { setOpportunities([]) }
  }, [currentBusiness, tab])

  useEffect(() => { load() }, [load])

  async function handleScan() {
    setScanning(true)
    try { await runGoalSuggestionScan(currentBusiness!.id); await load() }
    finally { setScanning(false) }
  }

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>OPPORTUNITIES</h1>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Quantified opportunities the Opportunity Engine found in your connector and outcome data
          </p>
        </div>
        <button onClick={handleScan} disabled={scanning} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
          <RefreshCw size={11} /> {scanning ? 'Scanning…' : 'Scan for opportunities'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid var(--bp-border)', paddingBottom: 10 }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`bp-pill ${tab === t.id ? 'bp-pill-blue' : 'bp-pill-grey'}`}
            style={{ cursor: 'pointer', background: 'none', border: tab === t.id ? undefined : '1px solid var(--bp-border)' }}>
            {t.label}
          </button>
        ))}
      </div>

      {opportunities.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          No {tab === 'all' ? '' : tab} opportunities. Click "Scan for opportunities" to check your business data.
        </div>
      ) : (
        opportunities.map((o) => <OpportunityCard key={o.id} opp={o} businessId={currentBusiness.id} onRefresh={load} />)
      )}
    </div>
  )
}
