import React, { useEffect, useMemo, useState } from 'react'
import useStore from '../lib/store.js'
import {
  getTrustCapabilities,
  getTrustCorrectionImpacts,
  getTrustCorrections,
  getTrustLifecycle,
  getTrustMeasurementPolicies,
  getTrustPreflight,
  getTrustRevenuePaths,
  getTrustScorecard,
  saveTrustCapability,
  saveTrustCorrection,
  saveTrustRevenuePath,
} from '../lib/api.js'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="bp-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}><h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h2>{children}</section>
}
function JsonBlock({ value }: { value: unknown }) { return <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', fontSize: 11 }}>{JSON.stringify(value, null, 2)}</pre> }
function Empty({ children }: { children: React.ReactNode }) { return <div style={{ color: 'var(--bp-text-3)', fontSize: 12, padding: '10px 0' }}>{children}</div> }

function Pill({ children, tone = 'grey' }: { children: React.ReactNode; tone?: 'green' | 'amber' | 'red' | 'blue' | 'grey' }) {
  return <span className={`bp-pill bp-pill-${tone}`} style={{ fontSize: 10, padding: '2px 6px' }}>{children}</span>
}

function toneForStatus(status: string) {
  if (['confirmed', 'available', 'open', 'successful'].includes(status)) return 'green'
  if (['proposed', 'review-required', 'stale', 'manual_review'].includes(status)) return 'amber'
  if (['invalidated', 'cancelled', 'unavailable', 'failed', 'blocked'].includes(status)) return 'red'
  return 'grey'
}

function CorrectionHistory({ corrections, impacts }: { corrections: any[]; impacts: Record<string, any[]> }) {
  if (!corrections.length) return <Empty>No corrections recorded for this business.</Empty>
  return <div style={{ display: 'grid', gap: 10 }}>
    {corrections.map((c) => {
      const rows = impacts[c.id] ?? []
      return <div key={c.id} style={{ border: '1px solid var(--bp-border)', borderRadius: 6, padding: 12, background: 'rgba(0,0,0,0.10)' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <Pill tone={toneForStatus(String(c.status)) as any}>{c.status}</Pill>
          <Pill tone="blue">{c.correction_type}</Pill>
          <span style={{ color: 'var(--bp-text-3)', fontSize: 11 }}>{c.created_at}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--bp-text)', lineHeight: 1.4 }}>{c.assertion_key}: {c.corrected_value}</div>
        {c.explanation ? <div style={{ color: 'var(--bp-text-2)', fontSize: 12, lineHeight: 1.45, marginTop: 4 }}>{c.explanation}</div> : null}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <Pill tone="grey">confidence {Number(c.confidence ?? 0).toFixed(2)}</Pill>
          <Pill tone="grey">{c.permanence}</Pill>
          {c.evidence_source ? <Pill tone="grey">evidence {c.evidence_source}</Pill> : null}
        </div>
        <div style={{ marginTop: 10, borderTop: '1px solid var(--bp-border)', paddingTop: 10 }}>
          <div style={{ color: 'var(--bp-text-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0, marginBottom: 6 }}>Affected records</div>
          {rows.length === 0 ? <Empty>No impacted records recorded.</Empty> : <div style={{ display: 'grid', gap: 6 }}>
            {rows.map((i) => <div key={i.id} style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 8, alignItems: 'center', fontSize: 11 }}>
              <Pill tone={toneForStatus(String(i.new_status)) as any}>{i.entity_type}</Pill>
              <span style={{ color: 'var(--bp-text-2)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.entity_id}</span>
              <span style={{ color: 'var(--bp-text-3)' }}>{i.previous_status ?? 'unknown'} -&gt; {i.new_status}</span>
            </div>)}
          </div>}
        </div>
      </div>
    })}
  </div>
}

export default function TrustOps() {
  const business = useStore((s) => s.currentBusiness)
  const [state, setState] = useState<any>({ loading: true })
  const [capabilityKey, setCapabilityKey] = useState('google_merchant_center')
  const [capabilityStatus, setCapabilityStatus] = useState('unavailable')
  const [correction, setCorrection] = useState('This business does not use Google Merchant Center')
  const [revenueName, setRevenueName] = useState('Primary revenue path')

  async function load() {
    if (!business) return
    setState((s: any) => ({ ...s, loading: true, error: null }))
    try {
      const [capabilities, corrections, revenue, lifecycle, policies, preflight, scorecard] = await Promise.all([
        getTrustCapabilities(business.id), getTrustCorrections(business.id), getTrustRevenuePaths(business.id), getTrustLifecycle(business.id), getTrustMeasurementPolicies(business.id), getTrustPreflight(), getTrustScorecard(business.id),
      ])
      const correctionRows = Array.isArray((corrections as any).corrections) ? (corrections as any).corrections : []
      const impactPairs = await Promise.all(correctionRows.map(async (c: any) => {
        try {
          const result = await getTrustCorrectionImpacts(business.id, c.id)
          return [c.id, Array.isArray((result as any).impacts) ? (result as any).impacts : []] as const
        } catch {
          return [c.id, []] as const
        }
      }))
      setState({ loading: false, capabilities, corrections, correctionImpacts: Object.fromEntries(impactPairs), revenue, lifecycle, policies, preflight, scorecard })
    } catch (err: any) { setState({ loading: false, error: err.message }) }
  }
  useEffect(() => { load() }, [business?.id])

  const correctionRows = useMemo(() => Array.isArray(state.corrections?.corrections) ? state.corrections.corrections : [], [state.corrections])

  if (!business) return <div className="p-6">No business selected.</div>
  if (state.loading) return <div className="p-6">Loading trust operations...</div>
  if (state.error) return <div className="p-6 text-red-400">{state.error}</div>

  return <div className="page" style={{ padding: 24, display: 'grid', gap: 16 }}>
    <div><h1 style={{ fontSize: 24, margin: 0 }}>Trust Operations</h1><p style={{ color: 'var(--bp-text-3)', marginTop: 4 }}>Capabilities, corrections, revenue paths, lifecycle, preflight, measurement and scorecards for {business.name}.</p></div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
      <Section title="Business Capabilities">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><input className="bp-input" value={capabilityKey} onChange={e => setCapabilityKey(e.target.value)} /><select className="bp-input" value={capabilityStatus} onChange={e => setCapabilityStatus(e.target.value)}><option>available</option><option>unavailable</option><option>unknown</option><option>planned</option><option>disconnected</option><option>restricted</option></select><button className="bp-btn bp-btn-primary" onClick={async () => { await saveTrustCapability(business.id, { capability_key: capabilityKey, status: capabilityStatus, evidence_source: 'dashboard' }); load() }}>Save</button></div>
        <JsonBlock value={state.capabilities} />
      </Section>
      <Section title="Human Corrections">
        <textarea className="bp-input" value={correction} onChange={e => setCorrection(e.target.value)} rows={3} />
        <button className="bp-btn bp-btn-primary" onClick={async () => { await saveTrustCorrection(business.id, { assertion_key: capabilityKey, corrected_value: correction, explanation: correction, affected_capability: capabilityKey }); load() }}>Record correction</button>
        <CorrectionHistory corrections={correctionRows} impacts={state.correctionImpacts ?? {}} />
      </Section>
      <Section title="Revenue Paths">
        <div style={{ display: 'flex', gap: 8 }}><input className="bp-input" value={revenueName} onChange={e => setRevenueName(e.target.value)} /><button className="bp-btn bp-btn-primary" onClick={async () => { await saveTrustRevenuePath(business.id, { name: revenueName, role: 'primary', business_model_type: 'operational_enablement', evidence_status: 'observed', priority: 10 }); load() }}>Save primary</button></div>
        <JsonBlock value={state.revenue} />
      </Section>
      <Section title="Signal Lifecycle"><JsonBlock value={state.lifecycle} /></Section>
      <Section title="Measurement Policies"><JsonBlock value={state.policies} /></Section>
      <Section title="Provider Preflight"><JsonBlock value={state.preflight} /></Section>
      <Section title="Agent Scorecard"><JsonBlock value={state.scorecard} /></Section>
    </div>
  </div>
}
