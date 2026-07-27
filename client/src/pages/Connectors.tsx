import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import {
  X, Plus, RefreshCw, Trash2, AlertTriangle, CheckCircle,
  Zap, Search, BarChart2, ShoppingBag, ExternalLink, Unplug,
  Activity, CheckSquare, Mail, Send, Globe, FileText, TrendingUp,
  CreditCard, GitBranch, MapPin, Settings2, MessageSquare, Database, Store,
} from 'lucide-react'
import clsx from 'clsx'
import useStore from '../lib/store'
import {
  getConnectors, addConnector, syncConnector, healthCheckConnector,
  updateConnector, deleteConnector, testPageSpeed, getGoogleAuthUrl, revokeGoogleAuth,
  getTasks,
} from '../lib/api'
import type { Connector, Task } from '../types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  if (status === 'connected') return 'text-blueprint-green'
  if (status === 'error') return 'text-blueprint-red'
  if (status === 'stale') return 'text-yellow-400'
  return 'text-blueprint-muted'
}

function statusDot(status: string): string {
  if (status === 'connected') return 'bg-blueprint-green'
  if (status === 'error') return 'bg-blueprint-red'
  if (status === 'stale') return 'bg-yellow-400'
  return 'bg-blueprint-muted'
}

function isStale(connector: Connector): boolean {
  if (!connector.last_sync) return false
  return Date.now() - new Date(connector.last_sync).getTime() > 24 * 60 * 60 * 1000
}

function effectiveStatus(connector: Connector): string {
  if (connector.status === 'connected' && isStale(connector)) return 'stale'
  return connector.status
}

// ─── Score Badge ─────────────────────────────────────────────────────────────

interface ScoreBadgeProps {
  label: string
  value: number | null | undefined
}

function ScoreBadge({ label, value }: ScoreBadgeProps) {
  const color = value != null && value >= 90 ? 'text-blueprint-green' : value != null && value >= 50 ? 'text-yellow-400' : 'text-blueprint-red'
  return (
    <div className="text-center">
      <p className={clsx('text-lg font-bold mono', color)}>{value ?? '—'}</p>
      <p className="text-[10px] text-blueprint-muted">{label}</p>
    </div>
  )
}

// ─── PageSpeed Setup ─────────────────────────────────────────────────────────

interface PageSpeedSetupProps {
  businessId: string | undefined
  existing: Connector | undefined
  onSaved: (connector: Connector) => void
  onClose: () => void
}

function PageSpeedSetup({ businessId, existing, onSaved, onClose }: PageSpeedSetupProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [url, setUrl] = useState<string>((existing?.config?.url as string) || '')
  const [apiKey, setApiKey] = useState<string>('')
  const [testing, setTesting] = useState<boolean>(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; data?: any; error?: string } | null>(null)
  const [saving, setSaving] = useState<boolean>(false)

  async function handleTest() {
    if (!url) { addNotification({ type: 'warning', message: 'Enter a URL to test' }); return }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await testPageSpeed(url, apiKey)
      setTestResult({ ok: true, data: res.data })
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!url) return
    setSaving(true)
    try {
      if (existing) {
        const updated = await updateConnector(existing.id, {
          config: { url, defaultDataType: 'performance' },
          credentials: apiKey ? { apiKey } : undefined,
        })
        onSaved(updated as Connector)
        addNotification({ type: 'success', message: 'PageSpeed connector updated' })
      } else {
        const created = await addConnector({
          type: 'pagespeed',
          business_id: businessId,
          name: 'Google PageSpeed',
          config: { url, defaultDataType: 'performance' },
          credentials: { apiKey: apiKey || '' },
        })
        onSaved(created as Connector)
        addNotification({ type: 'success', message: 'PageSpeed connector added' })
      }
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const mobile = testResult?.data?.mobile
  const desktop = testResult?.data?.desktop

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">URL to test</label>
        <input
          value={url}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
          className="bp-input"
          placeholder="https://example.com"
          type="url"
        />
      </div>
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">API Key <span className="text-blueprint-muted/60">(optional — only needed if you haven't connected Google)</span></label>
        <input
          value={apiKey}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)}
          className="bp-input"
          type="password"
          placeholder="Leave blank to use Google OAuth token"
        />
        <p className="text-[10px] text-blueprint-muted mt-1">
          If you've connected Search Console or Analytics, PageSpeed will reuse the same OAuth token automatically — no API key required.
        </p>
      </div>

      {/* Direct OAuth path — for users who didn't connect GSC/GA4 but want
          to give PageSpeed its own Google login (uses your project's quota
          instead of the shared anonymous one). Save URL first so the OAuth
          callback doesn't land on a config-less connector that can't sync. */}
      {businessId && (
        <button
          type="button"
          disabled={!url || saving}
          onClick={async () => {
            if (!url) {
              addNotification({ type: 'warning', message: 'Enter a URL above first.' })
              return
            }
            setSaving(true)
            try {
              if (existing) {
                await updateConnector(existing.id, {
                  config: { url, defaultDataType: 'performance' },
                })
              } else {
                await addConnector({
                  type: 'pagespeed',
                  business_id: businessId,
                  name: 'Google PageSpeed',
                  config: { url, defaultDataType: 'performance' },
                  credentials: {},
                })
              }
              window.location.href = `/api/oauth/google?businessId=${encodeURIComponent(businessId)}&types=pagespeed`
            } catch (err) {
              addNotification({ type: 'error', message: (err as Error).message })
              setSaving(false)
            }
          }}
          className="bp-btn bp-btn-secondary text-xs w-full justify-center"
        >
          <ExternalLink size={12} /> Connect with Google (recommended)
        </button>
      )}

      <button
        onClick={handleTest}
        disabled={testing || !url}
        className="bp-btn bp-btn-secondary text-xs w-full justify-center"
      >
        <RefreshCw size={12} className={clsx(testing && 'animate-spin')} />
        {testing ? 'Running test…' : 'Test Connection'}
      </button>

      {testResult && (
        <div className={clsx(
          'rounded border p-4',
          testResult.ok ? 'border-blueprint-green/20 bg-blueprint-green/5' : 'border-blueprint-red/20 bg-blueprint-red/5'
        )}>
          {testResult.ok ? (
            <>
              <p className="text-xs font-medium text-blueprint-green mb-3 flex items-center gap-1.5">
                <CheckCircle size={13} /> Test passed — scores returned
              </p>
              <div className="grid grid-cols-2 gap-4">
                {mobile && (
                  <div>
                    <p className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-2">Mobile</p>
                    <div className="grid grid-cols-2 gap-2">
                      <ScoreBadge label="Perf" value={mobile.scores?.performance} />
                      <ScoreBadge label="SEO" value={mobile.scores?.seo} />
                    </div>
                    {mobile.cwv?.lcp && (
                      <p className="text-[10px] text-blueprint-muted mt-2">LCP {mobile.cwv.lcp}ms · CLS {mobile.cwv.cls}</p>
                    )}
                  </div>
                )}
                {desktop && (
                  <div>
                    <p className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-2">Desktop</p>
                    <div className="grid grid-cols-2 gap-2">
                      <ScoreBadge label="Perf" value={desktop.scores?.performance} />
                      <ScoreBadge label="SEO" value={desktop.scores?.seo} />
                    </div>
                    {desktop.cwv?.lcp && (
                      <p className="text-[10px] text-blueprint-muted mt-2">LCP {desktop.cwv.lcp}ms · CLS {desktop.cwv.cls}</p>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-start gap-2">
              <AlertTriangle size={13} className="text-blueprint-red flex-shrink-0 mt-0.5" />
              <p className="text-xs text-blueprint-red">{testResult.error}</p>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !url}
          className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
        >
          {saving ? 'Saving…' : existing ? 'Update' : 'Save Connector'}
        </button>
      </div>
    </div>
  )
}

// ─── Google OAuth Setup (GSC + GA4) ──────────────────────────────────────────

interface GoogleOAuthSetupProps {
  businessId: string | undefined
  types: string
  label: string
  onClose: () => void
}

function GoogleOAuthSetup({ businessId, types, label, onClose }: GoogleOAuthSetupProps) {
  const googleAuthUrl = getGoogleAuthUrl(businessId ?? '', types)

  return (
    <div className="space-y-4">
      <div className="p-4 rounded bg-blueprint-bg border border-blueprint-border text-xs text-blueprint-muted space-y-1">
        <p>Blueprint will request read-only access to:</p>
        <ul className="list-disc list-inside space-y-0.5 mt-1">
          {types.includes('gsc') && <li>Google Search Console — search analytics, keywords, pages</li>}
          {types.includes('ga4') && <li>Google Analytics 4 — sessions, traffic sources, conversions</li>}
        </ul>
      </div>
      <a
        href={googleAuthUrl}
        className="bp-btn bp-btn-primary text-xs w-full justify-center"
      >
        <ExternalLink size={12} />
        Connect with Google
      </a>
      <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs w-full justify-center">
        Cancel
      </button>
    </div>
  )
}

// ─── GA4 Property Setup ───────────────────────────────────────────────────────

interface GA4SetupProps {
  businessId: string | undefined
  existing: Connector | undefined
  googleConnected: boolean
  onSaved: (connector: Connector) => void
  onClose: () => void
}

function GA4Setup({ businessId, existing, googleConnected, onSaved, onClose }: GA4SetupProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [propertyId, setPropertyId] = useState<string>((existing?.config?.propertyId as string) || '')
  const [saving, setSaving] = useState<boolean>(false)

  async function handleSave() {
    if (!propertyId) return
    setSaving(true)
    try {
      if (existing) {
        const updated = await updateConnector(existing.id, {
          config: { propertyId, defaultDataType: 'report' },
        })
        onSaved(updated as Connector)
        addNotification({ type: 'success', message: 'GA4 connector updated' })
      } else {
        const created = await addConnector({
          type: 'ga4',
          business_id: businessId,
          name: 'Google Analytics 4',
          config: { propertyId, defaultDataType: 'report' },
          credentials: {},
        })
        onSaved(created as Connector)
        addNotification({ type: 'success', message: 'GA4 connector added — tokens will be shared from GSC' })
      }
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (!googleConnected) {
    return <GoogleOAuthSetup businessId={businessId} types="gsc,ga4" label="GA4" onClose={onClose} />
  }

  return (
    <div className="space-y-4">
      <div className="p-3 rounded bg-blueprint-green/5 border border-blueprint-green/20 text-xs text-blueprint-green flex items-center gap-2">
        <CheckCircle size={13} />
        Google account connected — tokens shared from GSC
      </div>
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">Property ID</label>
        <input
          value={propertyId}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPropertyId(e.target.value)}
          className="bp-input"
          placeholder="123456789"
        />
        <p className="text-[10px] text-blueprint-muted mt-1">Found in GA4 Admin → Property Settings → Property ID</p>
      </div>
      <div className="flex gap-2">
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">Cancel</button>
        <button
          onClick={handleSave}
          disabled={saving || !propertyId}
          className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
        >
          {saving ? 'Saving…' : existing ? 'Update' : 'Save Connector'}
        </button>
      </div>
    </div>
  )
}

// ─── Google Merchant Center Account Setup ────────────────────────────────────
// Merchant Center needs its own OAuth consent (content scope isn't bundled
// into the shared GSC/GA4 flow — see server/routes/oauth.ts), so unlike
// GA4Setup this doesn't check a shared googleConnected flag: `existing` only
// becomes defined once the dedicated /api/oauth/google-merchant round trip
// has already created the connector row.

interface MerchantSetupProps {
  businessId: string | undefined
  existing: Connector | undefined
  onSaved: (connector: Connector) => void
  onClose: () => void
}

function MerchantSetup({ businessId, existing, onSaved, onClose }: MerchantSetupProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [accountId, setAccountId] = useState<string>((existing?.config?.accountId as string) || '')
  const [saving, setSaving] = useState<boolean>(false)

  if (!existing) {
    const authUrl = `/api/oauth/google-merchant?businessId=${encodeURIComponent(businessId ?? '')}`
    return (
      <div className="space-y-4">
        <p className="text-xs text-blueprint-muted">
          Click below to connect your Google Merchant Center account. You will be redirected to Google
          to grant Blueprint read access to your product feed. Once authorised you will be brought back here
          to enter your Merchant Center Account ID.
        </p>
        <a href={authUrl} className="bp-btn bp-btn-primary text-xs w-full justify-center" style={{ textDecoration: 'none' }}>
          <ExternalLink size={12} /> Connect with Google
        </a>
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs w-full justify-center">Cancel</button>
      </div>
    )
  }

  async function handleSave() {
    if (!accountId) return
    setSaving(true)
    try {
      const updated = await updateConnector(existing!.id, { config: { accountId } })
      onSaved(updated as Connector)
      addNotification({ type: 'success', message: 'Merchant Center connector updated' })
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="p-3 rounded bg-blueprint-green/5 border border-blueprint-green/20 text-xs text-blueprint-green flex items-center gap-2">
        <CheckCircle size={13} />
        Google account connected
      </div>
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">Merchant Center Account ID</label>
        <input
          value={accountId}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAccountId(e.target.value)}
          className="bp-input"
          placeholder="123456789"
        />
        <p className="text-[10px] text-blueprint-muted mt-1">Merchant Center → Settings → Account information (top-right corner shows it too).</p>
      </div>
      <div className="flex gap-2">
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">Cancel</button>
        <button
          onClick={handleSave}
          disabled={saving || !accountId}
          className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
        >
          {saving ? 'Saving…' : 'Save Account ID'}
        </button>
      </div>
    </div>
  )
}

// ─── GBP Account + Location Setup ────────────────────────────────────────────

interface GBPSetupProps {
  businessId: string | undefined
  existing: Connector | undefined
  onSaved: (connector: Connector) => void
  onClose: () => void
}

interface GBPAccount { name: string; accountName?: string; type?: string }
interface GBPLocation { name: string; title?: string; businessStatus?: string }

function GBPSetup({ businessId, existing, onSaved, onClose }: GBPSetupProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [accountId, setAccountId]   = useState<string>((existing?.config?.accountId as string) || '')
  const [locationId, setLocationId] = useState<string>((existing?.config?.locationId as string) || '')
  const [accounts, setAccounts]     = useState<GBPAccount[] | null>(null)
  const [locations, setLocations]   = useState<GBPLocation[] | null>(null)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [loadingLocations, setLoadingLocations] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!existing || !businessId) return
    setLoadingAccounts(true)
    fetch(`/api/connectors/gbp/accounts?businessId=${encodeURIComponent(businessId)}`)
      .then((r) => r.json())
      .then((d) => setAccounts(d.accounts ?? []))
      .catch(() => setAccounts([]))
      .finally(() => setLoadingAccounts(false))
  }, [existing, businessId])

  useEffect(() => {
    if (!existing || !businessId || !accountId) { setLocations(null); return }
    setLoadingLocations(true)
    fetch(`/api/connectors/gbp/locations?businessId=${encodeURIComponent(businessId)}&accountId=${encodeURIComponent(accountId)}`)
      .then((r) => r.json())
      .then((d) => setLocations(d.locations ?? []))
      .catch(() => setLocations([]))
      .finally(() => setLoadingLocations(false))
  }, [existing, businessId, accountId])

  if (!existing) {
    const authUrl = `/api/oauth/gbp?businessId=${encodeURIComponent(businessId ?? '')}`
    return (
      <div className="space-y-4">
        <p className="text-xs text-blueprint-muted">
          Click below to connect your Google Business Profile account. You will be redirected to
          Google to grant access. Once authorised you will be brought back here to select your
          business location.
        </p>
        <a href={authUrl} className="bp-btn bp-btn-primary text-xs w-full justify-center" style={{ textDecoration: 'none' }}>
          <ExternalLink size={12} /> Connect with Google
        </a>
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs w-full justify-center">Cancel</button>
      </div>
    )
  }

  async function handleSave() {
    if (!accountId || !locationId) return
    setSaving(true)
    try {
      const updated = await updateConnector(existing!.id, { config: { accountId, locationId } })
      onSaved(updated as Connector)
      addNotification({ type: 'success', message: 'Google Business Profile connector updated' })
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const accountLabel = (a: GBPAccount) => a.accountName || a.name
  const locationLabel = (l: GBPLocation) => l.title || l.name

  return (
    <div className="space-y-4">
      <div className="p-3 rounded bg-blueprint-green/5 border border-blueprint-green/20 text-xs text-blueprint-green flex items-center gap-2">
        <CheckCircle size={13} />
        Google account connected
      </div>

      {/* Account picker */}
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">GBP Account</label>
        {loadingAccounts ? (
          <p className="text-[10px] text-blueprint-muted">Loading accounts…</p>
        ) : accounts && accounts.length > 0 ? (
          <select
            value={accountId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setAccountId(e.target.value); setLocationId('') }}
            className="bp-input"
          >
            <option value="">— select an account —</option>
            {accounts.map((a) => (
              <option key={a.name} value={a.name}>{accountLabel(a)}</option>
            ))}
          </select>
        ) : (
          <input
            value={accountId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setAccountId(e.target.value); setLocationId('') }}
            className="bp-input"
            placeholder="accounts/123456789"
          />
        )}
        <p className="text-[10px] text-blueprint-muted mt-1">Format: accounts/&#123;number&#125;</p>
      </div>

      {/* Location picker */}
      {accountId && (
        <div>
          <label className="block text-xs text-blueprint-muted mb-1">Business Location</label>
          {loadingLocations ? (
            <p className="text-[10px] text-blueprint-muted">Loading locations…</p>
          ) : locations && locations.length > 0 ? (
            <select
              value={locationId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLocationId(e.target.value)}
              className="bp-input"
            >
              <option value="">— select a location —</option>
              {locations.map((l) => (
                <option key={l.name} value={l.name}>{locationLabel(l)}</option>
              ))}
            </select>
          ) : (
            <input
              value={locationId}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocationId(e.target.value)}
              className="bp-input"
              placeholder="locations/123456789"
            />
          )}
          <p className="text-[10px] text-blueprint-muted mt-1">Format: locations/&#123;number&#125;</p>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">Cancel</button>
        <button
          onClick={handleSave}
          disabled={saving || !accountId || !locationId}
          className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
        >
          {saving ? 'Saving…' : 'Save Location'}
        </button>
      </div>
    </div>
  )
}

// ─── GSC Site URL Setup ───────────────────────────────────────────────────────

interface GSCSetupProps {
  businessId: string | undefined
  existing: Connector | undefined
  googleConnected: boolean
  onSaved: (connector: Connector) => void
  onClose: () => void
}

interface VerifiedSite {
  siteUrl: string
  permissionLevel?: string
}

function GSCSetup({ businessId, existing, googleConnected, onSaved, onClose }: GSCSetupProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [siteUrl, setSiteUrl] = useState<string>((existing?.config?.siteUrl as string) || '')
  const [saving, setSaving] = useState<boolean>(false)
  const [verifiedSites, setVerifiedSites] = useState<VerifiedSite[] | null>(null)
  const [loadingSites, setLoadingSites] = useState<boolean>(false)

  // When Google is already connected, fetch the user's verified GSC
  // properties so they can pick from a dropdown — sidesteps the common
  // www-vs-apex / http-vs-https mistake that triggers a 403.
  useEffect(() => {
    if (!googleConnected || !businessId) return
    setLoadingSites(true)
    fetch(`/api/connectors/gsc/sites?businessId=${encodeURIComponent(businessId)}`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: { sites?: VerifiedSite[] }) => setVerifiedSites(Array.isArray(data?.sites) ? data.sites : []))
      .catch(() => setVerifiedSites([]))
      .finally(() => setLoadingSites(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleConnected, businessId])

  async function handleSave() {
    if (!siteUrl) return
    setSaving(true)
    try {
      if (existing) {
        const updated = await updateConnector(existing.id, {
          config: { siteUrl, defaultDataType: 'search_analytics' },
        })
        onSaved(updated as Connector)
        addNotification({ type: 'success', message: 'GSC connector updated' })
      } else {
        await addConnector({
          type: 'gsc',
          business_id: businessId,
          name: 'Google Search Console',
          config: { siteUrl, defaultDataType: 'search_analytics' },
          credentials: {},
        })
        addNotification({ type: 'info', message: 'GSC record created — connect Google to authorise' })
      }
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (!googleConnected) {
    return (
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-blueprint-muted mb-1">Site URL</label>
          <input
            value={siteUrl}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSiteUrl(e.target.value)}
            className="bp-input"
            placeholder="https://example.com/ or sc-domain:example.com"
          />
          <p className="text-[10px] text-blueprint-muted mt-1">Must match exactly what's listed in Search Console</p>
        </div>
        <GoogleOAuthSetup businessId={businessId} types="gsc,ga4" label="GSC" onClose={onClose} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="p-3 rounded bg-blueprint-green/5 border border-blueprint-green/20 text-xs text-blueprint-green flex items-center gap-2">
        <CheckCircle size={13} />
        Google account connected
      </div>
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">Verified property</label>
        {loadingSites ? (
          <div className="text-xs text-blueprint-muted py-2">Loading verified sites from Google…</div>
        ) : verifiedSites && verifiedSites.length > 0 ? (
          <select
            value={siteUrl}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSiteUrl(e.target.value)}
            className="bp-input bp-select w-full"
          >
            <option value="">— Pick a verified property —</option>
            {verifiedSites.map((s) => (
              <option key={s.siteUrl} value={s.siteUrl}>
                {s.siteUrl}{s.permissionLevel && s.permissionLevel !== 'siteOwner' ? `  (${s.permissionLevel})` : ''}
              </option>
            ))}
          </select>
        ) : verifiedSites && verifiedSites.length === 0 ? (
          <div className="p-2 rounded bg-blueprint-amber/5 border border-blueprint-amber/20 text-[11px] text-blueprint-amber leading-relaxed">
            No verified properties found for this Google account. Verify your site at{' '}
            <a href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer" className="underline">Search Console</a>{' '}
            (use a Domain property to cover all variants), then re-open this dialog.
          </div>
        ) : (
          <input
            value={siteUrl}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSiteUrl(e.target.value)}
            className="bp-input"
            placeholder="https://example.com/ or sc-domain:example.com"
          />
        )}
        <p className="text-[10px] text-blueprint-muted mt-1">
          Search Console treats https/http and www/apex as separate properties. Pick the one you verified.
        </p>
      </div>
      <div className="flex gap-2">
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">Cancel</button>
        <button
          onClick={handleSave}
          disabled={saving || !siteUrl}
          className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
        >
          {saving ? 'Saving…' : existing ? 'Update' : 'Save Connector'}
        </button>
      </div>
    </div>
  )
}

// ─── Shopify Setup ───────────────────────────────────────────────────────────

interface ShopifySetupProps {
  businessId: string | undefined
  existing: Connector | undefined
  onSaved: (connector: Connector) => void
  onClose: () => void
}

function ShopifySetup({ businessId, existing, onSaved, onClose }: ShopifySetupProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [shopDomain, setShopDomain] = useState<string>((existing?.config?.shopDomain as string) || '')
  const [accessToken, setAccessToken] = useState<string>('')
  const [days, setDays] = useState<number | string>((existing?.config?.days as number) ?? 120)
  const [saving, setSaving] = useState<boolean>(false)

  async function handleSave() {
    if (!shopDomain) return
    setSaving(true)
    try {
      const config = { shopDomain, days: Number(days), defaultDataType: 'analytics' }
      if (existing) {
        const creds = accessToken ? { shopDomain, accessToken } : undefined
        const updated = await updateConnector(existing.id, { config, ...(creds ? { credentials: creds } : {}) })
        onSaved(updated as Connector)
        addNotification({ type: 'success', message: 'Shopify connector updated' })
      } else {
        const created = await addConnector({
          type: 'shopify',
          business_id: businessId,
          name: 'Shopify',
          config,
          credentials: { shopDomain, accessToken },
        })
        onSaved(created as Connector)
        addNotification({ type: 'success', message: 'Shopify connector added' })
      }
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">Shop Domain</label>
        <input
          value={shopDomain}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setShopDomain(e.target.value)}
          className="bp-input"
          placeholder="your-store.myshopify.com"
        />
      </div>
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">
          Admin API Access Token {existing && <span className="text-blueprint-muted/60">(leave blank to keep existing)</span>}
        </label>
        <input
          value={accessToken}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAccessToken(e.target.value)}
          className="bp-input"
          type="password"
          placeholder="shpat_..."
        />
        <p className="text-[10px] text-blueprint-muted mt-1">Shopify Admin → Apps → Develop apps → your app → API credentials</p>
      </div>
      <div>
        <label className="block text-xs text-blueprint-muted mb-1">History window</label>
        <select value={days} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setDays(e.target.value)} className="bp-select w-full">
          <option value={90}>90 days</option>
          <option value={120}>120 days</option>
          <option value={180}>180 days</option>
          <option value={365}>365 days</option>
        </select>
      </div>
      <div className="flex gap-2">
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">Cancel</button>
        <button
          onClick={handleSave}
          disabled={saving || !shopDomain || (!existing && !accessToken)}
          className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
        >
          {saving ? 'Saving…' : existing ? 'Update' : 'Save Connector'}
        </button>
      </div>
    </div>
  )
}

// ─── Add Connector Modal ──────────────────────────────────────────────────────

interface ConfigFieldOption {
  value: string
  label: string
}

interface ConfigField {
  id: string
  label: string
  type: string
  required: boolean
  hint?: string
  placeholder?: string
  options?: ConfigFieldOption[]
  default?: string | number
}

interface ConnectorTypeMeta {
  id: string
  label: string
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; className?: string }>
  available: boolean
  custom?: boolean
  name?: string
  oauth?: string
  configFields?: ConfigField[]
}

const CONNECTOR_TYPES: ConnectorTypeMeta[] = [
  // Bespoke setup flows
  { id: 'pagespeed',   label: 'PageSpeed',          icon: Zap,         available: true, custom: true },
  { id: 'gsc',         label: 'Search Console',     icon: Search,      available: true, custom: true },
  { id: 'ga4',         label: 'Analytics 4',        icon: BarChart2,   available: true, custom: true },
  { id: 'shopify',     label: 'Shopify',            icon: ShoppingBag, available: true, custom: true },
  { id: 'google-merchant', label: 'Merchant Center', icon: Store,      available: true, custom: true },

  // Generic apikey / basic-auth setup (driven by configFields)
  { id: 'uptimerobot', label: 'UptimeRobot',        icon: Activity,    available: true,
    name: 'UptimeRobot',
    configFields: [
      { id: 'apiKey', label: 'API Key', type: 'password', required: true,
        hint: 'UptimeRobot Dashboard → My Settings → API Settings (use a Read-Only key).' },
    ],
  },
  { id: 'brevo',       label: 'Brevo',              icon: Mail,        available: true,
    name: 'Brevo',
    configFields: [
      { id: 'apiKey', label: 'API Key', type: 'password', required: true,
        hint: 'Brevo Dashboard → Settings → SMTP & API → API Keys.' },
    ],
  },
  { id: 'stannp',      label: 'Stannp',             icon: Send,        available: true,
    name: 'Stannp',
    configFields: [
      { id: 'apiKey', label: 'API Key', type: 'password', required: true,
        hint: 'Stannp Dashboard → Settings → API.' },
      { id: 'region', label: 'Region',  type: 'select',   required: true,
        options: [{ value: 'gb', label: 'GB' }, { value: 'us', label: 'US' }],
        default: 'gb' },
    ],
  },
  { id: 'wordpress',   label: 'WordPress',          icon: Globe,       available: true,
    name: 'WordPress',
    configFields: [
      { id: 'siteUrl',     label: 'Site URL',             type: 'url',      required: true,
        hint: 'e.g. https://yoursite.com (no trailing slash).' },
      { id: 'username',    label: 'WordPress Username',   type: 'text',     required: true },
      { id: 'appPassword', label: 'Application Password', type: 'password', required: true,
        hint: 'WP Admin → Users → Profile → Application Passwords.' },
    ],
  },
  { id: 'kirby',       label: 'Kirby CMS',          icon: FileText,    available: true,
    name: 'Kirby CMS',
    configFields: [
      { id: 'siteUrl',     label: 'Kirby Site URL',          type: 'url',      required: true },
      { id: 'username',    label: 'Panel Username',          type: 'text',     required: true },
      { id: 'password',    label: 'Panel Password',          type: 'password', required: true },
      { id: 'contentPath', label: 'Content Path (optional)', type: 'text',     required: false,
        hint: 'Absolute path to /content if Blueprint shares a filesystem with Kirby.' },
    ],
  },
  { id: 'stripe',      label: 'Stripe',             icon: CreditCard,  available: true,
    name: 'Stripe',
    configFields: [
      { id: 'apiKey',   label: 'Stripe Secret Key', type: 'password', required: true,
        hint: 'Use a Restricted Key with read-only access. Dashboard → Developers → API Keys.' },
      { id: 'currency', label: 'Currency',          type: 'select',   required: true,
        options: [
          { value: 'gbp', label: 'GBP' },
          { value: 'usd', label: 'USD' },
          { value: 'eur', label: 'EUR' },
        ],
        default: 'gbp' },
    ],
  },
  { id: 'github',      label: 'GitHub',             icon: GitBranch,   available: true,
    name: 'GitHub',
    configFields: [
      { id: 'token', label: 'Personal Access Token', type: 'password', required: true,
        hint: 'GitHub → Settings → Developer settings → Personal access tokens (classic). Scope: repo.' },
      { id: 'owner', label: 'Username or Org',       type: 'text',     required: true },
      { id: 'repos', label: 'Repositories (optional)', type: 'text',   required: false,
        hint: 'Comma-separated repo names. Empty = top 10 most recently updated.' },
    ],
  },

  // OAuth-based connectors — full-page redirect to /api/oauth/{type}
  { id: 'todoist',    label: 'Todoist',     icon: CheckSquare, available: true, oauth: '/api/oauth/todoist',    name: 'Todoist' },
  { id: 'gbp',        label: 'Google Business Profile', icon: MapPin, available: true, oauth: '/api/oauth/gbp', name: 'Google Business Profile' },
  { id: 'google-ads', label: 'Google Ads',  icon: TrendingUp, available: true, oauth: '/api/oauth/google-ads',  name: 'Google Ads' },
  { id: 'social',     label: 'Facebook & Instagram', icon: MessageSquare, available: true, oauth: '/api/oauth/social', name: 'Facebook & Instagram' },
  { id: 'buffer',     label: 'Buffer',      icon: Send,        available: true, oauth: '/api/oauth/buffer',     name: 'Buffer' },

  // Klaviyo and SEMrush — generic apikey setup
  { id: 'klaviyo',    label: 'Klaviyo',     icon: Mail,        available: true,
    name: 'Klaviyo',
    configFields: [
      { id: 'apiKey', label: 'Private API Key', type: 'password', required: true,
        hint: 'Klaviyo → Account → Settings → API Keys. Use a Private API Key.' },
    ],
  },
  { id: 'semrush',    label: 'SEMrush',     icon: TrendingUp,  available: true,
    name: 'SEMrush',
    configFields: [
      { id: 'apiKey', label: 'API Key', type: 'password', required: true,
        hint: 'SEMrush → Profile → Subscription info → API.' },
      { id: 'domain', label: 'Target Domain', type: 'text', required: true,
        hint: 'Enter domain without protocol, e.g. example.com' },
      { id: 'database', label: 'Regional Database', type: 'select', required: true,
        options: [
          { value: 'uk', label: 'United Kingdom' },
          { value: 'us', label: 'United States' },
          { value: 'ie', label: 'Ireland' },
          { value: 'au', label: 'Australia' },
          { value: 'ca', label: 'Canada' },
        ],
        default: 'uk' },
    ],
  },
  { id: 'wix',        label: 'Wix',         icon: Globe,       available: true,
    name: 'Wix',
    configFields: [
      { id: 'apiKey',    label: 'API Key', type: 'password', required: true,
        hint: 'Wix Dashboard → Settings → Advanced → API Keys. Permissions: Sites, Pages, Blog, SEO.' },
      { id: 'siteId',    label: 'Site ID',    type: 'text', required: true,
        hint: 'Found in Wix Dashboard URL: manage.wix.com/dashboard/{SITE-ID}/home' },
      { id: 'accountId', label: 'Account ID', type: 'text', required: true,
        hint: 'Wix Dashboard → Account Settings.' },
    ],
  },
  { id: 'server-access', label: 'Server Access (SSH/FTP)', icon: Database, available: true,
    name: 'Server Access',
    configFields: [
      { id: 'connectionMethod', label: 'Connection method', type: 'select', required: true,
        default: 'ssh-key',
        options: [
          { value: 'ssh-key',      label: 'SSH with private key (recommended)' },
          { value: 'ssh-password', label: 'SSH with password' },
          { value: 'sftp',         label: 'SFTP (password)' },
          { value: 'ftps',         label: 'FTPS (explicit TLS)' },
          { value: 'ftp',          label: 'FTP (unencrypted — not recommended)' },
        ],
      },
      { id: 'host',       label: 'Hostname or IP', type: 'text',     required: true,
        placeholder: 'server.example.com' },
      { id: 'port',       label: 'Port',           type: 'number',   required: true,  default: 22 },
      { id: 'username',   label: 'Username',       type: 'text',     required: true },
      { id: 'password',   label: 'Password',       type: 'password', required: false,
        hint: 'Required for password-based methods (ssh-password, sftp, ftp, ftps).' },
      { id: 'privateKey', label: 'Private key (SSH)', type: 'textarea', required: false,
        hint: 'Paste the contents of your id_rsa/id_ed25519 file. Required for ssh-key.' },
      { id: 'passphrase', label: 'Key passphrase',  type: 'password', required: false,
        hint: 'Only if your private key is passphrase-protected.' },
      { id: 'rootPath',   label: 'Site root path',  type: 'text',     required: true,
        placeholder: '/var/www/html',
        hint: 'Absolute path to the website root on the server. Writes are restricted to this subtree.' },
      { id: 'siteType',   label: 'Site type',       type: 'select',   required: true,
        default: 'custom',
        options: [
          { value: 'kirby',     label: 'Kirby' },
          { value: 'wordpress', label: 'WordPress' },
          { value: 'static',    label: 'Static HTML' },
          { value: 'laravel',   label: 'Laravel' },
          { value: 'custom',    label: 'Custom' },
        ],
      },
    ],
  },
]

// ─── Generic config-fields setup (apikey / basic-auth connectors) ──────────────

interface GenericConnectorSetupProps {
  businessId: string | undefined
  type: ConnectorTypeMeta
  existing: Connector | undefined
  onSaved: (connector: Connector) => void
  onClose: () => void
}

function GenericConnectorSetup({ businessId, type, existing, onSaved, onClose }: GenericConnectorSetupProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const f of type.configFields ?? []) {
      initial[f.id] = String(
        (existing?.config?.[f.id] ?? (existing?.config as any)?.[f.id] ?? f.default ?? '')
      )
    }
    return initial
  })
  const [saving, setSaving] = useState<boolean>(false)

  const allRequiredPresent = (type.configFields ?? [])
    .filter((f) => f.required)
    .every((f) => {
      // For password fields, allow empty when editing (means "keep existing")
      if (existing && f.type === 'password') return true
      return values[f.id] && String(values[f.id]).trim().length > 0
    })

  // Determine which fields belong in credentials vs config
  // Convention: passwords + tokens + apiKey go in credentials; everything else in config.
  const credentialFieldIds = (type.configFields ?? [])
    .filter((f) => f.type === 'password' || /^(apiKey|token|appPassword|password)$/i.test(f.id))
    .map((f) => f.id)

  function partition(vals: Record<string, string>) {
    const credentials: Record<string, string> = {}
    const config: Record<string, string> = {}
    for (const f of type.configFields ?? []) {
      const v = vals[f.id]
      if (v == null || v === '') continue
      if (credentialFieldIds.includes(f.id)) {
        credentials[f.id] = v
      } else {
        // Some non-secret fields (siteUrl, username, owner, region, currency) live in BOTH
        // credentials and config so the connector code can read them from credentials
        // (for basic-auth pairs) AND the UI can show them as config.
        if (['siteUrl', 'username', 'owner', 'region', 'currency', 'accountId', 'locationId', 'customerId', 'managerAccountId'].includes(f.id)) {
          credentials[f.id] = v
        }
        config[f.id] = v
      }
    }
    return { credentials, config }
  }

  async function handleSave() {
    if (!allRequiredPresent) return
    setSaving(true)
    try {
      const { credentials, config } = partition(values)
      if (existing) {
        // Drop empty password fields so we don't overwrite existing creds
        const cleanCreds: Record<string, string> = { ...credentials }
        for (const f of type.configFields ?? []) {
          if (f.type === 'password' && !values[f.id]) delete cleanCreds[f.id]
        }
        const updated = await updateConnector(existing.id, {
          config,
          ...(Object.keys(cleanCreds).length > 0 ? { credentials: cleanCreds } : {}),
        })
        onSaved(updated as Connector)
        addNotification({ type: 'success', message: `${type.label} connector updated` })
      } else {
        const created = await addConnector({
          type: type.id,
          business_id: businessId,
          name: type.name ?? type.label,
          config,
          credentials,
        })
        onSaved(created as Connector)
        addNotification({ type: 'success', message: `${type.label} connector added` })
      }
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {(type.configFields ?? []).map((f) => (
        <div key={f.id}>
          <label className="block text-xs text-blueprint-muted mb-1">
            {f.label}
            {!f.required && <span className="text-blueprint-muted/60"> (optional)</span>}
            {existing && f.type === 'password' && <span className="text-blueprint-muted/60"> (leave blank to keep existing)</span>}
          </label>
          {f.type === 'select' ? (
            <select
              value={values[f.id] || ''}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setValues((prev) => ({ ...prev, [f.id]: e.target.value }))}
              className="bp-select w-full"
            >
              {f.options?.map((opt) => {
                const optValue = typeof opt === 'object' ? opt.value : opt
                const optLabel = typeof opt === 'object' ? opt.label : opt
                return <option key={optValue} value={optValue}>{optLabel}</option>
              })}
            </select>
          ) : (
            <input
              value={values[f.id] || ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValues((prev) => ({ ...prev, [f.id]: e.target.value }))}
              className="bp-input"
              type={f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : 'text'}
              placeholder={f.hint?.split('.')[0] ?? ''}
            />
          )}
          {f.hint && <p className="text-[10px] text-blueprint-muted mt-1">{f.hint}</p>}
        </div>
      ))}

      <div className="flex gap-2">
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">Cancel</button>
        <button
          onClick={handleSave}
          disabled={saving || !allRequiredPresent}
          className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
        >
          {saving ? 'Saving…' : existing ? 'Update' : 'Save Connector'}
        </button>
      </div>
    </div>
  )
}

// ─── OAuth-redirect setup (Todoist, GBP, Google Ads) ─────────────────────────

interface OAuthConnectorSetupProps {
  businessId: string | undefined
  type: ConnectorTypeMeta
  existing: Connector | undefined
  onClose: () => void
}

function OAuthConnectorSetup({ businessId, type, existing, onClose }: OAuthConnectorSetupProps) {
  const url = `${type.oauth}?businessId=${encodeURIComponent(businessId ?? '')}`
  return (
    <div className="space-y-4">
      <p className="text-xs text-blueprint-muted">
        Click below to connect your {type.label} account. You will be redirected to {type.label}
        to grant Blueprint read access. Once authorised you will be brought back here.
      </p>
      {existing && (
        <div className="text-[10px] text-blueprint-muted bg-blueprint-base/50 border border-blueprint-border rounded p-2">
          Already connected. Re-running this flow will refresh the credentials.
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">Cancel</button>
        <a
          href={url}
          className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
          style={{ textDecoration: 'none' }}
        >
          <ExternalLink size={11} /> Connect {type.label}
        </a>
      </div>
    </div>
  )
}

interface AddConnectorModalProps {
  onClose: () => void
  onSaved: (connector: Connector) => void
  businessId: string | undefined
  connectors: Connector[]
}

function AddConnectorModal({ onClose, onSaved, businessId, connectors }: AddConnectorModalProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null)

  const googleConnected = connectors.some(
    (c) => ['gsc', 'ga4'].includes(c.type) && c.status === 'connected'
  )

  const existingByType = Object.fromEntries(connectors.map((c) => [c.type, c]))

  const renderSetup = () => {
    if (selectedType === 'pagespeed') {
      return <PageSpeedSetup businessId={businessId} existing={existingByType['pagespeed']} onSaved={onSaved} onClose={onClose} />
    }
    if (selectedType === 'gsc') {
      return <GSCSetup businessId={businessId} existing={existingByType['gsc']} googleConnected={googleConnected} onSaved={onSaved} onClose={onClose} />
    }
    if (selectedType === 'ga4') {
      return <GA4Setup businessId={businessId} existing={existingByType['ga4']} googleConnected={googleConnected} onSaved={onSaved} onClose={onClose} />
    }
    if (selectedType === 'shopify') {
      return <ShopifySetup businessId={businessId} existing={existingByType['shopify']} onSaved={onSaved} onClose={onClose} />
    }
    if (selectedType === 'google-merchant') {
      return <MerchantSetup businessId={businessId} existing={existingByType['google-merchant']} onSaved={onSaved} onClose={onClose} />
    }
    if (selectedType === 'gbp') {
      return <GBPSetup businessId={businessId} existing={existingByType['gbp']} onSaved={onSaved} onClose={onClose} />
    }

    // Generic / OAuth-driven setups for the rest of the catalog
    const typeMeta = CONNECTOR_TYPES.find((t) => t.id === selectedType)
    if (!typeMeta) return null

    if (typeMeta.oauth) {
      return (
        <OAuthConnectorSetup
          type={typeMeta}
          businessId={businessId}
          existing={existingByType[typeMeta.id]}
          onClose={onClose}
        />
      )
    }

    if (Array.isArray(typeMeta.configFields) && typeMeta.configFields.length > 0) {
      return (
        <GenericConnectorSetup
          type={typeMeta}
          businessId={businessId}
          existing={existingByType[typeMeta.id]}
          onSaved={onSaved}
          onClose={onClose}
        />
      )
    }

    return null
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="bp-card w-full max-w-md pointer-events-auto shadow-2xl animate-fade-in max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b border-blueprint-border sticky top-0 bg-blueprint-card">
            <h2 className="text-base font-semibold text-slate-100">
              {selectedType ? CONNECTOR_TYPES.find(t => t.id === selectedType)?.label : 'Add Connector'}
            </h2>
            <button onClick={onClose} className="text-blueprint-muted hover:text-slate-200">
              <X size={18} />
            </button>
          </div>
          <div className="p-5">
            {!selectedType ? (
              <>
                <p className="text-xs text-blueprint-muted mb-3 uppercase tracking-wider">Select Type</p>
                <div className="grid grid-cols-2 gap-2">
                  {CONNECTOR_TYPES.map((ct) => {
                    const Icon = ct.icon
                    return (
                      <button
                        key={ct.id}
                        onClick={() => ct.available && setSelectedType(ct.id)}
                        disabled={!ct.available}
                        className={clsx(
                          'flex items-center gap-2 px-3 py-3 rounded border transition-colors text-left',
                          !ct.available && 'opacity-40 cursor-not-allowed border-blueprint-border',
                          ct.available && 'border-blueprint-border hover:border-blueprint-blue/40 hover:bg-blueprint-blue/5 text-slate-300'
                        )}
                      >
                        <Icon size={16} className="text-blueprint-blue flex-shrink-0" />
                        <div>
                          <p className="text-xs font-medium text-slate-200">{ct.label}</p>
                          {!ct.available && <p className="text-[10px] text-blueprint-muted">Coming soon</p>}
                          {ct.available && existingByType[ct.id] && (
                            <p className="text-[10px] text-blueprint-muted">Already added</p>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </>
            ) : (
              <>
                <button
                  onClick={() => setSelectedType(null)}
                  className="text-xs text-blueprint-muted hover:text-slate-300 mb-4 flex items-center gap-1"
                >
                  ← Back
                </button>
                {renderSetup()}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Connector Detail Drawer ──────────────────────────────────────────────────

const POLL_INTERVALS = [
  { label: '6 hours', value: 360 },
  { label: '12 hours', value: 720 },
  { label: '18 hours', value: 1080 },
  { label: '24 hours', value: 1440 },
]

interface SyncFrequencySelectorProps {
  connector: Connector
  onUpdate?: (connector: Connector) => void
}

function SyncFrequencySelector({ connector, onUpdate }: SyncFrequencySelectorProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [saving, setSaving] = useState<boolean>(false)

  const currentInterval = connector.config?.pollingIntervalMinutes
    ? Number(connector.config.pollingIntervalMinutes)
    : null

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = Number(e.target.value)
    setSaving(true)
    try {
      const updated = await updateConnector(connector.id, {
        config: { ...(connector.config || {}), pollingIntervalMinutes: val },
      })
      onUpdate?.(updated as Connector)
      addNotification({ type: 'success', message: `Sync frequency updated to ${POLL_INTERVALS.find(i => i.value === val)?.label}` })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p className="text-xs text-blueprint-muted mb-3 uppercase tracking-wider font-semibold">Sync Frequency</p>
      <div className="flex items-center gap-3">
        <select
          value={currentInterval || ''}
          onChange={handleChange}
          disabled={saving}
          className="bp-select"
        >
          <option value="">Default for connector type</option>
          {POLL_INTERVALS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {saving && <span className="text-xs text-blueprint-muted">Saving…</span>}
      </div>
      <p className="text-xs text-blueprint-muted mt-1">
        Automatic sync runs in the background — manual sync available anytime above.
      </p>
    </div>
  )
}

interface ConnectorDrawerProps {
  connector: Connector
  onClose: () => void
  onSync: () => void
  onDelete: (id: string) => void
  onUpdate: (connector: Connector) => void
}

function ConnectorDrawer({ connector: initialConnector, onClose, onSync, onDelete, onUpdate }: ConnectorDrawerProps) {
  const addNotification = useStore((s) => s.addNotification)
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [connector, setConnector] = useState<Connector>(initialConnector)
  const [health, setHealth] = useState<{ ok: boolean; details?: Record<string, unknown>; error?: string } | null>(null)
  const [checkingHealth, setCheckingHealth] = useState<boolean>(false)
  const [syncing, setSyncing] = useState<boolean>(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false)
  const [deleting, setDeleting] = useState<boolean>(false)
  const [revoking, setRevoking] = useState<boolean>(false)
  const [showConfig, setShowConfig] = useState<boolean>(false)
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  // If the connector has an error suggesting missing config, open the
  // editor automatically so the user lands on the fix.
  useEffect(() => {
    const err = ((connector?.last_error) || '').toLowerCase()
    const missingConfig = err.includes('siteurl is required') ||
      err.includes('propertyid is required') ||
      err.includes('shopdomain') ||
      err.includes('url is required')
    if (missingConfig && !showConfig) setShowConfig(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector?.last_error])

  // Keep local connector in sync with parent updates
  useEffect(() => { setConnector(initialConnector) }, [initialConnector])

  // Poll connector status while a sync is in-flight
  function startSyncPolling() {
    let attempts = 0
    pollRef.current = setInterval(async () => {
      attempts++
      try {
        const connectors = await getConnectors(currentBusiness?.id ?? '')
        const updated = (Array.isArray(connectors) ? connectors : []).find((c: Connector) => c.id === connector.id)
        if (updated) {
          setConnector(updated as Connector)
          onUpdate?.(updated as Connector)
          if (updated.last_sync !== connector.last_sync || updated.status === 'error' || attempts >= 36) {
            clearInterval(pollRef.current!)
            setSyncing(false)
            if (updated.status === 'error') {
              addNotification({ type: 'error', message: `Sync failed: ${updated.last_error}` })
            } else {
              addNotification({ type: 'success', message: 'Sync complete' })
            }
          }
        }
      } catch { /* ignore */ }
    }, 5000)
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const status = effectiveStatus(connector)

  async function handleHealthCheck() {
    setCheckingHealth(true)
    setHealth(null)
    try {
      const result = await healthCheckConnector(connector.id)
      setHealth({ ok: true, ...result })
    } catch (err) {
      setHealth({ ok: false, error: (err as Error).message })
    } finally {
      setCheckingHealth(false)
    }
  }

  async function handleSync() {
    setSyncing(true)
    try {
      await syncConnector(connector.id)
      addNotification({ type: 'info', message: 'Sync started — polling for completion…' })
      startSyncPolling()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
      setSyncing(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteConnector(connector.id)
      addNotification({ type: 'success', message: 'Connector deleted' })
      onDelete(connector.id)
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
      setDeleting(false)
    }
  }

  async function handleRevokeGoogle() {
    if (!currentBusiness?.id) return
    setRevoking(true)
    try {
      await revokeGoogleAuth(currentBusiness.id)
      addNotification({ type: 'success', message: 'Google access revoked — GSC and GA4 disconnected' })
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setRevoking(false)
    }
  }

  const isGoogle = ['gsc', 'ga4'].includes(connector.type)

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer w-[480px] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-blueprint-border flex-shrink-0">
          <h2 className="text-base font-semibold text-slate-100">{connector.name}</h2>
          <button onClick={onClose} className="text-blueprint-muted hover:text-slate-200">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Status */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bp-card p-3">
              <p className="text-xs text-blueprint-muted mb-1">Status</p>
              <div className="flex items-center gap-1.5">
                <span className={clsx('w-2 h-2 rounded-full', statusDot(status))} />
                <p className={clsx('text-sm font-medium capitalize', statusColor(status))}>{status}</p>
              </div>
            </div>
            <div className="bp-card p-3">
              <p className="text-xs text-blueprint-muted mb-1">Last Sync</p>
              <p className="text-sm mono text-slate-200">
                {connector.last_sync
                  ? formatDistanceToNow(parseTimestamp(connector.last_sync) || new Date(), { addSuffix: true })
                  : 'Never'}
              </p>
            </div>
          </div>

          {/* Last error */}
          {connector.last_error && (
            <div className="flex items-start gap-2 p-3 rounded bg-blueprint-red/5 border border-blueprint-red/20">
              <AlertTriangle size={14} className="text-blueprint-red flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-blueprint-red mb-0.5">Last Error</p>
                <p className="text-xs text-blueprint-red/80">{connector.last_error}</p>
              </div>
            </div>
          )}

          {/* Inline configuration — lets the user supply missing siteUrl,
              propertyId, etc. without leaving the drawer. */}
          {showConfig ? (
            <div className="bp-card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs uppercase tracking-wider font-semibold text-blueprint-muted">Configure</p>
                <button onClick={() => setShowConfig(false)} className="text-blueprint-muted hover:text-slate-200">
                  <X size={14} />
                </button>
              </div>
              {connector.type === 'gsc' && (
                <GSCSetup
                  businessId={connector.business_id}
                  existing={connector}
                  googleConnected
                  onSaved={(updated) => { setConnector(updated); onUpdate?.(updated); setShowConfig(false) }}
                  onClose={() => setShowConfig(false)}
                />
              )}
              {connector.type === 'ga4' && (
                <GA4Setup
                  businessId={connector.business_id}
                  existing={connector}
                  googleConnected
                  onSaved={(updated) => { setConnector(updated); onUpdate?.(updated); setShowConfig(false) }}
                  onClose={() => setShowConfig(false)}
                />
              )}
              {connector.type === 'pagespeed' && (
                <PageSpeedSetup
                  businessId={connector.business_id}
                  existing={connector}
                  onSaved={(updated) => { setConnector(updated); onUpdate?.(updated); setShowConfig(false) }}
                  onClose={() => setShowConfig(false)}
                />
              )}
              {connector.type === 'shopify' && (
                <ShopifySetup
                  businessId={connector.business_id}
                  existing={connector}
                  onSaved={(updated) => { setConnector(updated); onUpdate?.(updated); setShowConfig(false) }}
                  onClose={() => setShowConfig(false)}
                />
              )}
              {connector.type === 'google-merchant' && (
                <MerchantSetup
                  businessId={connector.business_id}
                  existing={connector}
                  onSaved={(updated) => { setConnector(updated); onUpdate?.(updated); setShowConfig(false) }}
                  onClose={() => setShowConfig(false)}
                />
              )}
              {connector.type === 'gbp' && (
                <GBPSetup
                  businessId={connector.business_id}
                  existing={connector}
                  onSaved={(updated) => { setConnector(updated); onUpdate?.(updated); setShowConfig(false) }}
                  onClose={() => setShowConfig(false)}
                />
              )}
              {!['gsc', 'ga4', 'pagespeed', 'shopify', 'google-merchant', 'gbp'].includes(connector.type) && (
                <p className="text-xs text-blueprint-muted">
                  This connector type doesn't have an inline editor yet. Delete and re-add it to change credentials.
                </p>
              )}
            </div>
          ) : (
            // Show a one-click "Configure" button so users can fix missing
            // siteUrl / propertyId / etc. without re-creating the connector.
            (['gsc', 'ga4', 'pagespeed', 'shopify', 'google-merchant', 'gbp'].includes(connector.type)) && (
              <button
                onClick={() => setShowConfig(true)}
                className="bp-btn bp-btn-secondary text-xs"
              >
                <Settings2 size={12} /> Configure
              </button>
            )
          )}

          {/* Health check */}
          <div>
            <p className="text-xs text-blueprint-muted mb-3 uppercase tracking-wider font-semibold">Health Check</p>
            <div className="flex flex-col gap-3">
              <button
                onClick={handleHealthCheck}
                disabled={checkingHealth}
                className="bp-btn bp-btn-secondary text-xs"
              >
                <RefreshCw size={12} className={clsx(checkingHealth && 'animate-spin')} />
                {checkingHealth ? 'Checking…' : 'Run Health Check'}
              </button>
              {health && (
                <div className={clsx(
                  'p-3 rounded border text-xs',
                  health.ok
                    ? 'border-blueprint-green/20 bg-blueprint-green/5 text-blueprint-green'
                    : 'border-blueprint-red/20 bg-blueprint-red/5 text-blueprint-red'
                )}>
                  <div className="flex items-center gap-1.5 mb-1">
                    {health.ok ? <CheckCircle size={13} /> : <AlertTriangle size={13} />}
                    <span className="font-medium">{health.ok ? 'Healthy' : 'Unhealthy'}</span>
                  </div>
                  {health.ok && health.details && (
                    <div className="mt-2 space-y-0.5 text-blueprint-muted">
                      {Object.entries(health.details).map(([k, v]) => (
                        <p key={k}>{k}: <span className="text-slate-300">{String(v)}</span></p>
                      ))}
                    </div>
                  )}
                  {!health.ok && <p className="text-blueprint-red/80 mt-1">{health.error}</p>}
                </div>
              )}
            </div>
          </div>

          {/* Sync Frequency */}
          <SyncFrequencySelector connector={connector} onUpdate={(updated) => { setConnector(updated); onUpdate?.(updated) }} />

          {/* Actions */}
          <div>
            <p className="text-xs text-blueprint-muted mb-3 uppercase tracking-wider font-semibold">Actions</p>
            <div className="flex gap-2 flex-wrap">
              <button onClick={handleSync} disabled={syncing} className="bp-btn bp-btn-secondary text-xs">
                <RefreshCw size={12} className={clsx(syncing && 'animate-spin')} />
                {syncing ? 'Syncing…' : 'Sync Now'}
              </button>
              {isGoogle && (
                <button onClick={handleRevokeGoogle} disabled={revoking} className="bp-btn bp-btn-secondary text-xs text-yellow-400 hover:text-yellow-300">
                  <Unplug size={12} />
                  {revoking ? 'Revoking…' : 'Revoke Google Access'}
                </button>
              )}
            </div>
          </div>

          {/* Danger zone */}
          <div className="border border-blueprint-red/20 rounded p-4">
            <p className="text-xs font-semibold text-blueprint-red mb-2">Danger Zone</p>
            {!showDeleteConfirm ? (
              <button onClick={() => setShowDeleteConfirm(true)} className="bp-btn bp-btn-danger text-xs">
                <Trash2 size={12} />
                Delete Connector
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-300">Are you sure? This cannot be undone.</p>
                <div className="flex gap-2">
                  <button onClick={() => setShowDeleteConfirm(false)} className="bp-btn bp-btn-secondary text-xs">Cancel</button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="bp-btn text-xs bg-blueprint-red/20 text-blueprint-red hover:bg-blueprint-red/30 border border-blueprint-red/30"
                  >
                    {deleting ? 'Deleting…' : 'Yes, Delete'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Connector Grid Card ──────────────────────────────────────────────────────

interface ConnectorCardProps {
  connector: Connector
  onClick: () => void
}

function ConnectorCard({ connector, onClick }: ConnectorCardProps) {
  const [hovered, setHovered] = React.useState<boolean>(false)
  const ICONS: Record<string, React.ComponentType<{ size?: number; style?: React.CSSProperties }>> = {
    pagespeed: Zap, gsc: Search, ga4: BarChart2, shopify: ShoppingBag,
  }
  const Icon = ICONS[connector.type] || Zap
  const status = effectiveStatus(connector)

  const borderColor = status === 'connected' ? 'var(--bp-green)'
    : status === 'error' ? 'var(--bp-red)'
    : status === 'stale' ? 'var(--bp-amber)'
    : 'rgba(255,255,255,0.08)'

  const dotColor = status === 'connected' ? 'var(--bp-green)'
    : status === 'error' ? 'var(--bp-red)'
    : status === 'stale' ? 'var(--bp-amber)'
    : 'var(--bp-text-3)'

  const dotClass = status === 'connected' ? 'pulse-dot-green'
    : status === 'error' ? 'pulse-dot-red'
    : status === 'stale' ? 'pulse-dot-amber'
    : 'pulse-dot-gray'

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="bp-card"
      style={{
        padding: 0, overflow: 'hidden', cursor: 'pointer',
        borderTop: `3px solid ${borderColor}`,
        transform: hovered ? 'translateY(-1px)' : 'none',
        transition: 'transform 150ms ease, box-shadow 150ms ease',
        boxShadow: hovered ? '0 6px 20px rgba(0,0,0,0.3)' : 'none',
      }}
    >
      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={14} style={{ color: 'var(--bp-blue)' }} />
            <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>
              {connector.name}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className={`pulse-dot ${dotClass}`} />
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: dotColor, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {status}
            </span>
          </div>
        </div>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
          {connector.last_sync
            ? `Synced ${formatDistanceToNow(parseTimestamp(connector.last_sync) || new Date(), { addSuffix: true })}`
            : 'Never synced'}
        </div>
        {connector.last_error && (
          <div style={{
            marginTop: 8, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {connector.last_error}
          </div>
        )}
      </div>
      <div style={{
        padding: '8px 16px', borderTop: '1px solid var(--bp-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {connector.type}
        </span>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
          Click to configure →
        </span>
      </div>
    </div>
  )
}

// ─── Connectors Page ─────────────────────────────────────────────────────────

function Connectors() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const addNotification = useStore((s) => s.addNotification)
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [showAdd, setShowAdd] = useState<boolean>(false)
  const [selectedConnector, setSelectedConnector] = useState<Connector | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  // Handle OAuth callback redirect params
  useEffect(() => {
    const connected = searchParams.get('connected')
    const error = searchParams.get('error')
    const email = searchParams.get('email')

    if (connected === 'google') {
      const msg = email ? `Google connected (${email})` : 'Google connected'
      addNotification({ type: 'success', message: msg })
      setSearchParams({}, { replace: true })
      // Reload connectors after OAuth
      if (currentBusiness) {
        getConnectors(currentBusiness.id)
          .then((data) => setConnectors(Array.isArray(data) ? data as Connector[] : []))
          .catch(() => {})
      }
    } else if (error) {
      const detail = searchParams.get('detail')
      let message: string
      if (error === 'google_oauth_not_configured') {
        message = detail
          ? decodeURIComponent(detail)
          : 'Google OAuth is not configured. Open Settings → Google OAuth and paste your Client ID and Client Secret from Google Cloud Console.'
      } else if (detail) {
        message = `${decodeURIComponent(error)} — ${decodeURIComponent(detail)}`
      } else {
        message = `OAuth error: ${decodeURIComponent(error)}`
      }
      addNotification({ type: 'error', message })
      setSearchParams({}, { replace: true })
    }
  }, [searchParams])

  useEffect(() => {
    if (!currentBusiness) { setLoading(false); return }
    getConnectors(currentBusiness.id)
      .then((data) => setConnectors(Array.isArray(data) ? data as Connector[] : []))
      .catch((err: Error) => addNotification({ type: 'error', message: 'Failed to load connectors: ' + err.message }))
      .finally(() => setLoading(false))
  }, [currentBusiness])

  function handleDelete(id: string) {
    setConnectors((prev) => prev.filter((c) => c.id !== id))
  }

  function handleSaved(updated: Connector) {
    setConnectors((prev) => {
      const exists = prev.find((c) => c.id === updated.id)
      return exists ? prev.map((c) => c.id === updated.id ? updated : c) : [...prev, updated]
    })
  }

  const connectedCount = connectors.filter((c) => c.status === 'connected').length

  // Wishlist — connector requests surfaced by agents
  const [wishlistTasks, setWishlistTasks] = useState<Task[]>([])
  useEffect(() => {
    if (!currentBusiness) return
    getTasks(currentBusiness.id, { limit: 50 })
      .then((data: any) => {
        const rows: Task[] = Array.isArray(data?.tasks) ? data.tasks : (Array.isArray(data) ? data : [])
        setWishlistTasks(rows.filter((t: Task) =>
          t.action_type === 'connect_connector' || t.action_type === 'research_connector'
        ))
      })
      .catch(() => {})
  }, [currentBusiness])

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 22, color: 'var(--bp-text)', marginBottom: 4 }}>
            Connectors
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
              {connectors.length} total
            </span>
            {connectedCount > 0 && (
              <>
                <span style={{ color: 'var(--bp-border)' }}>·</span>
                <span className="pulse-dot pulse-dot-green" />
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
                  {connectedCount} connected
                </span>
              </>
            )}
          </div>
        </div>
        <button onClick={() => setShowAdd(true)} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
          <Plus size={12} /> Add Connector
        </button>
      </div>

      {/* Skeleton */}
      {loading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 16px' }}>
                <div className="bp-skeleton" style={{ height: 14, width: '55%', borderRadius: 3, marginBottom: 10 }} />
                <div className="bp-skeleton" style={{ height: 10, borderRadius: 3, marginBottom: 6 }} />
                <div className="bp-skeleton" style={{ height: 10, width: '70%', borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && connectors.length === 0 && (
        <div className="bp-card" style={{ textAlign: 'center', padding: '64px 20px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔌</div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 14, color: 'var(--bp-text-2)', marginBottom: 6 }}>
            No connectors yet
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 16 }}>
            Connect data sources to start monitoring your business
          </div>
          <button onClick={() => setShowAdd(true)} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
            <Plus size={12} /> Add First Connector
          </button>
        </div>
      )}

      {/* Grid */}
      {!loading && connectors.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {connectors.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              onClick={() => setSelectedConnector(connector)}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <AddConnectorModal
          onClose={() => setShowAdd(false)}
          businessId={currentBusiness?.id}
          connectors={connectors}
          onSaved={(c) => {
            handleSaved(c)
            setShowAdd(false)
          }}
        />
      )}

      {selectedConnector && (
        <ConnectorDrawer
          connector={selectedConnector}
          onClose={() => setSelectedConnector(null)}
          onDelete={handleDelete}
          onSync={() => {
            getConnectors(currentBusiness?.id ?? '')
              .then((data) => setConnectors(Array.isArray(data) ? data as Connector[] : []))
              .catch(() => {})
          }}
          onUpdate={handleSaved}
        />
      )}

      {/* Connector Wishlist — requests surfaced by agents */}
      {wishlistTasks.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <h2 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 16, color: 'var(--bp-text)', margin: 0 }}>
              Connector Wishlist
            </h2>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-base-2)', border: '1px solid var(--bp-border)', borderRadius: 4, padding: '1px 6px' }}>
              {wishlistTasks.length} item{wishlistTasks.length !== 1 ? 's' : ''} from agents
            </span>
          </div>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 16 }}>
            Your agents identified these data sources during their analysis. Connect built-in connectors directly, or review research tasks to explore new APIs.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {wishlistTasks.map((t) => {
              const payload = t.action_payload || {}
              const isConnect = t.action_type === 'connect_connector'
              const isResearch = t.action_type === 'research_connector'
              const taskStatusColor = t.status === 'completed' ? 'var(--bp-green)' : t.status === 'failed' ? 'var(--bp-red)' : 'var(--bp-text-3)'
              return (
                <div key={t.id} className="bp-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ marginTop: 2, flexShrink: 0, width: 28, height: 28, borderRadius: 6, background: isConnect ? 'rgba(var(--bp-green-rgb,74,222,128),0.12)' : 'rgba(99,102,241,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {isConnect
                      ? <Plus size={13} style={{ color: 'var(--bp-green)' }} />
                      : <Search size={13} style={{ color: '#818cf8' }} />
                    }
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>
                        {isConnect ? (String(payload['connector_name'] || payload['connector_type'] || '')) : (String(payload['description'] || t.title || ''))}
                      </span>
                      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-base-2)', border: '1px solid var(--bp-border)', borderRadius: 3, padding: '1px 5px' }}>
                        {isConnect ? 'built-in' : 'needs research'}
                      </span>
                      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: taskStatusColor }}>
                        {t.status}
                      </span>
                    </div>
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 4 }}>
                      Requested by <strong style={{ color: 'var(--bp-text-2)' }}>{t.proposed_by}</strong>
                      {payload['reason'] != null && <span> · {String(payload['reason']).slice(0, 120)}</span>}
                      {payload['use_case'] != null && <span> · {String(payload['use_case']).slice(0, 120)}</span>}
                    </div>
                    {t.status === 'completed' && t.outcome_data?.['issue_url'] != null && (
                      <a href={String(t.outcome_data['issue_url'])} target="_blank" rel="noreferrer"
                        style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: '#818cf8', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <ExternalLink size={10} /> View GitHub issue
                      </a>
                    )}
                  </div>
                  {isConnect && t.status === 'proposed' && (
                    <button
                      className="bp-btn bp-btn-primary"
                      style={{ fontSize: 10, flexShrink: 0, whiteSpace: 'nowrap' }}
                      onClick={() => setShowAdd(true)}
                    >
                      <Plus size={11} /> Connect
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default Connectors
