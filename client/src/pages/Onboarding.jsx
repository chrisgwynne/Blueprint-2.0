/**
 * Onboarding wizard — shown when no businesses exist or onboarding not complete.
 *
 * 5 steps: Welcome → Create Business → Connect Data → Enable Agents → Notifications
 */
import React, { useState, useEffect } from 'react'
import {
  ArrowRight, ArrowLeft, Zap, Search, ShoppingBag, Check, Bot, Clock,
  RefreshCw, Send, X, ExternalLink,
} from 'lucide-react'
import clsx from 'clsx'
import useStore from '../lib/store.js'
import {
  createBusiness, getBusinesses, addConnector, testPageSpeed,
  syncConnector, getGoogleAuthUrl, getConnectors,
  getGoogleOAuthConfig, saveGoogleOAuthConfig,
  hireAgent, getHireRecommendations,
} from '../lib/api.js'

const STEPS = ['Welcome', 'Business', 'Data', 'Agents', 'Notifications']

const BIZ_TYPES = [
  { value: 'ecommerce',     label: 'Ecommerce' },
  { value: 'saas',          label: 'SaaS' },
  { value: 'local_service', label: 'Local Service' },
  { value: 'agency',        label: 'Agency' },
  { value: 'content',       label: 'Content / Media' },
  { value: 'other',         label: 'Other' },
]

function ProgressBar({ step, total }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 32 }}>
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: 3,
            borderRadius: 2,
            background: i <= step ? 'var(--bp-blue)' : 'var(--bp-surface-3)',
            transition: 'background 0.3s',
          }}
        />
      ))}
    </div>
  )
}

export default function Onboarding({ onComplete }) {
  const setBusinesses = useStore((s) => s.setBusinesses)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)

  const [step, setStep] = useState(0)
  const [bizName, setBizName] = useState('')
  const [bizType, setBizType] = useState('ecommerce')
  const [bizWebsite, setBizWebsite] = useState('')
  const [createdBiz, setCreatedBiz] = useState(null)
  const [saving, setSaving] = useState(false)
  const [connectorAdded, setConnectorAdded] = useState(false)
  const [psUrl, setPsUrl] = useState('')
  const [psTesting, setPsTesting] = useState(false)
  const [psResult, setPsResult] = useState(null)
  // Conductor hiring recommendations shown inline on Step 3.
  // analysing → loading spinner, recs → list of candidates, hired → Set of template ids
  const [hireAnalysing, setHireAnalysing] = useState(false)
  const [hireRecs, setHireRecs] = useState(null)   // null = not yet analysed
  const [hiring, setHiring] = useState({})         // { [templateId]: 'pending' | 'done' | 'error' }
  const [hireError, setHireError] = useState(null)
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')

  // ── Google OAuth app credentials (one-time per install) ─────────────────
  const [googleCfg, setGoogleCfg] = useState(null)
  const [googleClientId, setGoogleClientId] = useState('')
  const [googleClientSecret, setGoogleClientSecret] = useState('')
  const [savingGoogleCfg, setSavingGoogleCfg] = useState(false)
  const [showGoogleSetup, setShowGoogleSetup] = useState(false)

  // ── Shopify inline setup ────────────────────────────────────────────────
  const [shopDomain, setShopDomain] = useState('')
  const [shopToken, setShopToken] = useState('')
  const [shopSaving, setShopSaving] = useState(false)
  const [shopResult, setShopResult] = useState(null)

  // Preload Google OAuth config on mount so we know whether to show setup.
  useEffect(() => {
    getGoogleOAuthConfig()
      .then((c) => setGoogleCfg(c))
      .catch(() => {})
  }, [])

  async function handleSaveGoogleCfg() {
    if (!googleClientId.trim() || !googleClientSecret.trim()) return
    setSavingGoogleCfg(true)
    try {
      const updated = await saveGoogleOAuthConfig({
        client_id: googleClientId.trim(),
        client_secret: googleClientSecret.trim(),
        // Let the server default the redirect URI.
      })
      setGoogleCfg(updated)
      setGoogleClientSecret('')
      setShowGoogleSetup(false)
    } catch (err) {
      alert('Failed to save Google OAuth: ' + err.message)
    } finally {
      setSavingGoogleCfg(false)
    }
  }

  async function handleShopifyConnect() {
    if (!shopDomain.trim() || !shopToken.trim() || !createdBiz) return
    setShopSaving(true)
    setShopResult(null)
    try {
      await addConnector({
        type: 'shopify',
        business_id: createdBiz.id,
        name: 'Shopify',
        config: { shopDomain: shopDomain.trim(), days: 120, defaultDataType: 'analytics' },
        credentials: { shopDomain: shopDomain.trim(), accessToken: shopToken.trim() },
      })
      setShopResult({ ok: true })
      setConnectorAdded(true)
    } catch (err) {
      setShopResult({ ok: false, error: err.message })
    } finally {
      setShopSaving(false)
    }
  }

  // ── Step 2: Create business ─────────────────────────────────────────────
  async function handleCreateBusiness() {
    if (!bizName.trim()) return
    setSaving(true)
    try {
      const biz = await createBusiness({
        name: bizName.trim(),
        type: bizType,
        settings: { website: bizWebsite.trim() || undefined },
      })
      setCreatedBiz(biz)
      setCurrentBusiness(biz)
      const all = await getBusinesses()
      setBusinesses(all ?? [])
      setPsUrl(bizWebsite.trim())
      setStep(2)
    } catch (err) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Step 3: PageSpeed quick connect ─────────────────────────────────────
  async function handlePageSpeedConnect() {
    if (!psUrl.trim() || !createdBiz) return
    setPsTesting(true)
    setPsResult(null)
    try {
      const result = await testPageSpeed(psUrl)
      setPsResult({ ok: true, data: result.data })
      // Create the connector
      await addConnector({
        type: 'pagespeed',
        business_id: createdBiz.id,
        name: 'Google PageSpeed',
        config: { url: psUrl.trim(), defaultDataType: 'performance' },
        credentials: {},
      })
      setConnectorAdded(true)
    } catch (err) {
      setPsResult({ ok: false, error: err.message })
    } finally {
      setPsTesting(false)
    }
  }

  // ── Step 4: Ask Conductor which agents to hire, based on what was connected.
  // Runs a dry-run hiring analysis and renders the recommendations inline so
  // the user can hire with one click (no task-queue round-trip).
  useEffect(() => {
    if (step !== 3 || !createdBiz?.id) return
    let cancelled = false
    setHireAnalysing(true)
    setHireError(null)
    ;(async () => {
      try {
        // Trigger a best-effort sync for all connected connectors so Conductor
        // reasons about real data, not just "connector exists, empty".
        try {
          const conns = await getConnectors(createdBiz.id)
          const syncable = (Array.isArray(conns) ? conns : [])
            .filter((c) => c.status === 'connected' || c.status === 'disconnected')
          await Promise.allSettled(syncable.map((c) => syncConnector(c.id)))
        } catch {}

        const result = await getHireRecommendations(createdBiz.id)
        if (cancelled) return
        setHireRecs(result?.recommendations ?? [])
      } catch (err) {
        if (cancelled) return
        setHireError(err.message || 'Analysis failed')
        setHireRecs([])
      } finally {
        if (!cancelled) setHireAnalysing(false)
      }
    })()
    return () => { cancelled = true }
  }, [step, createdBiz?.id])

  async function handleHireOne(templateId) {
    if (!createdBiz?.id) return
    setHiring((p) => ({ ...p, [templateId]: 'pending' }))
    try {
      await hireAgent(templateId, createdBiz.id)
      setHiring((p) => ({ ...p, [templateId]: 'done' }))
    } catch (err) {
      setHiring((p) => ({ ...p, [templateId]: 'error' }))
      console.warn('[onboarding] hire failed:', err.message)
    }
  }

  // ── Step 5: Finish ──────────────────────────────────────────────────────
  async function handleFinish() {
    // Trigger first sync if connector added
    if (connectorAdded && createdBiz) {
      try {
        // Find the pagespeed connector
        const connectors = await getConnectors(createdBiz.id)
        const ps = (Array.isArray(connectors) ? connectors : []).find((c) => c.type === 'pagespeed')
        if (ps) syncConnector(ps.id).catch(() => {})
      } catch {}
    }
    onComplete()
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: 'var(--bp-base)',
    }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <ProgressBar step={step} total={STEPS.length} />

        {/* ── STEP 0: Welcome ──────────────────────────────────────────── */}
        {step === 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📐</div>
            <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: 28, color: 'var(--bp-text)', margin: '0 0 8px' }}>
              Welcome to Blueprint
            </h1>
            <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 13, color: 'var(--bp-text-2)', marginBottom: 32 }}>
              Your personal business operating system.
              <br />Let's get you set up in about 5 minutes.
            </p>
            <button onClick={() => setStep(1)} className="bp-btn bp-btn-primary" style={{ fontSize: 14, padding: '12px 32px' }}>
              Get started <ArrowRight size={14} />
            </button>
          </div>
        )}

        {/* ── STEP 1: Create business ──────────────────────────────────── */}
        {step === 1 && (
          <div>
            <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 20, color: 'var(--bp-text)', margin: '0 0 4px' }}>
              Create your business
            </h2>
            <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 24 }}>
              What business are you setting up Blueprint for?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label className="block text-xs text-blueprint-muted mb-1">Business name</label>
                <input value={bizName} onChange={(e) => setBizName(e.target.value)} className="bp-input" autoFocus placeholder="Acme Co." />
              </div>
              <div>
                <label className="block text-xs text-blueprint-muted mb-1">Type</label>
                <select value={bizType} onChange={(e) => setBizType(e.target.value)} className="bp-select w-full">
                  {BIZ_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-blueprint-muted mb-1">Website (optional)</label>
                <input value={bizWebsite} onChange={(e) => setBizWebsite(e.target.value)} className="bp-input" placeholder="https://acme.com" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
              <button onClick={() => setStep(0)} className="bp-btn bp-btn-ghost text-xs"><ArrowLeft size={12} /> Back</button>
              <button onClick={handleCreateBusiness} disabled={!bizName.trim() || saving} className="bp-btn bp-btn-primary text-xs ml-auto" style={{ padding: '10px 24px' }}>
                {saving ? <RefreshCw size={12} className="animate-spin" /> : null}
                Create business <ArrowRight size={12} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Connect data ─────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 20, color: 'var(--bp-text)', margin: '0 0 4px' }}>
              Connect your first data source
            </h2>
            <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 20 }}>
              Connect at least one source to start seeing signals.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* PageSpeed */}
              <div className="bp-card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <Zap size={16} style={{ color: 'var(--bp-amber)' }} />
                  <div>
                    <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>PageSpeed</div>
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>No login needed — enter your URL</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={psUrl} onChange={(e) => setPsUrl(e.target.value)} className="bp-input" style={{ flex: 1, fontSize: 12 }} placeholder="https://yoursite.com" />
                  <button onClick={handlePageSpeedConnect} disabled={psTesting || !psUrl.trim()} className="bp-btn bp-btn-primary text-xs">
                    {psTesting ? <RefreshCw size={11} className="animate-spin" /> : <Zap size={11} />} Test
                  </button>
                </div>
                {psResult?.ok && <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-green)', marginTop: 6 }}>✅ Connected! PageSpeed is syncing.</div>}
                {psResult && !psResult.ok && <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)', marginTop: 6 }}>{psResult.error}</div>}
              </div>

              {/* Google OAuth */}
              <div className="bp-card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <Search size={16} style={{ color: 'var(--bp-blue)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>Google (GSC + GA4)</div>
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>One OAuth flow covers both</div>
                  </div>
                  {googleCfg?.configured && (
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-green)', padding: '2px 6px', borderRadius: 3, background: 'rgba(34,197,94,0.12)' }}>
                      ✓ App configured
                    </span>
                  )}
                </div>

                {googleCfg && !googleCfg.configured && !showGoogleSetup && (
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 8, lineHeight: 1.5 }}>
                    To connect Google, Blueprint needs OAuth credentials from Google Cloud Console (a one-time setup).
                  </div>
                )}

                {showGoogleSetup && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10, padding: 10, background: 'rgba(77,166,255,0.06)', borderRadius: 4 }}>
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.6 }}>
                      1. Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--bp-blue)' }}>Google Cloud Console → Credentials</a><br/>
                      2. Create an OAuth client ID, type <strong>Web application</strong><br/>
                      3. Add this redirect URI:
                      <div style={{ margin: '4px 0', padding: '4px 6px', background: 'var(--bp-surface-2)', borderRadius: 3, fontSize: 9, userSelect: 'all' }}>
                        {googleCfg?.default_redirect_uri || 'http://localhost:4000/api/oauth/google/callback'}
                      </div>
                      4. Paste the Client ID + Secret below
                    </div>
                    <input
                      value={googleClientId}
                      onChange={(e) => setGoogleClientId(e.target.value)}
                      placeholder="Client ID (xxxxx.apps.googleusercontent.com)"
                      className="bp-input"
                      style={{ fontSize: 11 }}
                    />
                    <input
                      type="password"
                      value={googleClientSecret}
                      onChange={(e) => setGoogleClientSecret(e.target.value)}
                      placeholder="Client Secret (GOCSPX-...)"
                      className="bp-input"
                      style={{ fontSize: 11 }}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={handleSaveGoogleCfg}
                        disabled={savingGoogleCfg || !googleClientId.trim() || !googleClientSecret.trim()}
                        className="bp-btn bp-btn-primary text-xs"
                      >
                        {savingGoogleCfg ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />} Save credentials
                      </button>
                      <button onClick={() => setShowGoogleSetup(false)} className="bp-btn bp-btn-ghost text-xs">Cancel</button>
                    </div>
                  </div>
                )}

                {!showGoogleSetup && !googleCfg?.configured && (
                  <button onClick={() => setShowGoogleSetup(true)} className="bp-btn bp-btn-secondary text-xs">
                    <Search size={11} /> Configure Google OAuth
                  </button>
                )}

                {!showGoogleSetup && googleCfg?.configured && (
                  <a href={createdBiz ? getGoogleAuthUrl(createdBiz.id) : '#'} className="bp-btn bp-btn-secondary text-xs" style={{ textDecoration: 'none' }}>
                    <ExternalLink size={11} /> Connect with Google
                  </a>
                )}
              </div>

              {/* Shopify */}
              <div className="bp-card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <ShoppingBag size={16} style={{ color: 'var(--bp-green)' }} />
                  <div>
                    <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>Shopify</div>
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Store domain + Admin API access token</div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    value={shopDomain}
                    onChange={(e) => setShopDomain(e.target.value)}
                    placeholder="yourstore.myshopify.com"
                    className="bp-input"
                    style={{ fontSize: 11 }}
                  />
                  <input
                    type="password"
                    value={shopToken}
                    onChange={(e) => setShopToken(e.target.value)}
                    placeholder="shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    className="bp-input"
                    style={{ fontSize: 11 }}
                  />
                  <button
                    onClick={handleShopifyConnect}
                    disabled={shopSaving || !shopDomain.trim() || !shopToken.trim()}
                    className="bp-btn bp-btn-primary text-xs"
                  >
                    {shopSaving ? <RefreshCw size={11} className="animate-spin" /> : <ShoppingBag size={11} />} Connect Shopify
                  </button>
                  {shopResult?.ok && <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-green)' }}>✅ Connected! Shopify is syncing.</div>}
                  {shopResult && !shopResult.ok && <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)' }}>{shopResult.error}</div>}
                </div>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 6, lineHeight: 1.5 }}>
                  Get a token from Shopify Admin → Apps → Develop apps → Create a custom app → API access scopes: read_products, read_orders, read_inventory.
                </div>
              </div>
            </div>

            {/* More connectors note */}
            <div className="bp-card" style={{ padding: 12, marginTop: 10, background: 'rgba(77,166,255,0.06)', border: '1px solid rgba(77,166,255,0.15)' }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--bp-blue)' }}>More connectors available in the dashboard</strong> — Stripe, Brevo, Google Ads, Meta Ads, Klaviyo, Semrush, UptimeRobot, GitHub, and more can all be added from <strong>Settings → Connectors</strong> after setup.
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button onClick={() => setStep(1)} className="bp-btn bp-btn-ghost text-xs"><ArrowLeft size={12} /> Back</button>
              <div style={{ flex: 1 }} />
              <button onClick={() => setStep(3)} className="bp-btn bp-btn-ghost text-xs" style={{ color: 'var(--bp-text-3)' }}>Skip for now</button>
              <button onClick={() => setStep(3)} disabled={!connectorAdded} className={clsx('bp-btn text-xs', connectorAdded ? 'bp-btn-primary' : 'bp-btn-secondary')} style={{ padding: '10px 24px' }}>
                Continue <ArrowRight size={12} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Conductor recommends agents to hire ───────────────── */}
        {step === 3 && (
          <div>
            <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 20, color: 'var(--bp-text)', margin: '0 0 4px' }}>
              Your AI team
            </h2>
            <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 16 }}>
              Conductor has reviewed what you've connected and picked the agents
              worth hiring now. No speculation — only agents whose data is live.
            </p>

            {/* Analysing state */}
            {hireAnalysing && (
              <div className="bp-card" style={{ padding: 16, marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
                <RefreshCw size={16} className="animate-spin" style={{ color: 'var(--bp-blue)' }} />
                <div>
                  <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>
                    Conductor is analysing your data…
                  </div>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
                    Syncing connected sources and deciding which specialist agents to recommend.
                  </div>
                </div>
              </div>
            )}

            {/* Recommendations */}
            {!hireAnalysing && hireRecs && hireRecs.length > 0 && (
              <>
                {hireRecs.map((r) => {
                  const state = hiring[r.agent_id]
                  return (
                    <div key={r.agent_id} className="bp-card" style={{ padding: 14, marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <Bot size={18} style={{ color: 'var(--bp-blue)', flexShrink: 0, marginTop: 1 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>
                              {r.name || r.agent_id}
                            </div>
                            {typeof r.confidence === 'number' && (
                              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
                                confidence {Math.round(r.confidence * 100)}%
                              </span>
                            )}
                          </div>
                          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5, marginBottom: 6 }}>
                            {r.reason}
                          </div>
                          {r.expected_value && (
                            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 8 }}>
                              → {r.expected_value}
                            </div>
                          )}
                          {Array.isArray(r.required_connectors) && r.required_connectors.length > 0 && (
                            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginBottom: 8 }}>
                              Uses: {r.required_connectors.join(', ')}
                            </div>
                          )}
                          <button
                            onClick={() => handleHireOne(r.agent_id)}
                            disabled={state === 'pending' || state === 'done'}
                            className={clsx('bp-btn text-xs', state === 'done' ? 'bp-btn-ghost' : 'bp-btn-primary')}
                            style={{ padding: '6px 14px' }}
                          >
                            {state === 'done'
                              ? (<><Check size={11} /> Hired</>)
                              : state === 'pending'
                                ? (<><RefreshCw size={11} className="animate-spin" /> Hiring…</>)
                                : state === 'error'
                                  ? (<><X size={11} /> Retry hire</>)
                                  : (<><Zap size={11} /> Hire {r.name || r.agent_id}</>)}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {/* Empty state — no recommendations (connectors not synced yet,
                or Conductor genuinely has nothing to suggest). Show the
                explainer so the user understands what will happen next. */}
            {!hireAnalysing && hireRecs && hireRecs.length === 0 && (
              <div className="bp-card" style={{ padding: 14, marginBottom: 16, display: 'flex', gap: 10 }}>
                <Clock size={18} style={{ color: 'var(--bp-amber)', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)', marginBottom: 4 }}>
                    Nothing to hire yet
                  </div>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
                    {hireError
                      ? `We couldn't analyse right now (${hireError}). You can finish setup and Conductor will recommend agents after your connectors sync.`
                      : "Your connectors are still syncing. As soon as data arrives, Conductor will recommend specialist agents in your Tasks inbox."}
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={() => setStep(2)} className="bp-btn bp-btn-ghost text-xs"><ArrowLeft size={12} /> Back</button>
              <button onClick={() => setStep(4)} className="bp-btn bp-btn-primary text-xs ml-auto" style={{ padding: '10px 24px' }}>
                Continue <ArrowRight size={12} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 4: Notifications ────────────────────────────────────── */}
        {step === 4 && (
          <div>
            <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 20, color: 'var(--bp-text)', margin: '0 0 4px' }}>
              Notifications (optional)
            </h2>
            <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 16 }}>
              Get alerts and approve tasks on Telegram. You can set this up later in Settings.
            </p>
            <div className="bp-card" style={{ padding: 16 }}>
              <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 12, color: 'var(--bp-text)', marginBottom: 8 }}>Telegram</div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 12, lineHeight: 1.6 }}>
                1. Message <b>@BotFather</b> on Telegram → /newbot<br />
                2. Copy the token below<br />
                3. Start a chat with your bot, send any message<br />
                4. We'll find your chat ID
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input value={botToken} onChange={(e) => setBotToken(e.target.value)} className="bp-input" style={{ fontSize: 12 }} placeholder="Bot token from BotFather" />
                <input value={chatId} onChange={(e) => setChatId(e.target.value)} className="bp-input" style={{ fontSize: 12 }} placeholder="Chat ID (e.g. 123456789)" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button onClick={() => setStep(3)} className="bp-btn bp-btn-ghost text-xs"><ArrowLeft size={12} /> Back</button>
              <div style={{ flex: 1 }} />
              <button onClick={handleFinish} className="bp-btn bp-btn-ghost text-xs" style={{ color: 'var(--bp-text-3)' }}>Skip</button>
              <button onClick={handleFinish} className="bp-btn bp-btn-primary text-xs" style={{ padding: '10px 24px' }}>
                <Check size={12} /> Finish setup
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
