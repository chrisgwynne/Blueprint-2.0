import React, { useEffect, useState } from 'react'
import useStore from '../lib/store.js'
import { getTrustCapabilities, getTrustCorrections, getTrustLifecycle, getTrustMeasurementPolicies, getTrustPreflight, getTrustRevenuePaths, getTrustScorecard, saveTrustCapability, saveTrustCorrection, saveTrustRevenuePath } from '../lib/api.js'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="bp-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}><h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h2>{children}</section>
}
function JsonBlock({ value }: { value: unknown }) { return <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', fontSize: 11 }}>{JSON.stringify(value, null, 2)}</pre> }

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
      setState({ loading: false, capabilities, corrections, revenue, lifecycle, policies, preflight, scorecard })
    } catch (err: any) { setState({ loading: false, error: err.message }) }
  }
  useEffect(() => { load() }, [business?.id])

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
        <JsonBlock value={state.corrections} />
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