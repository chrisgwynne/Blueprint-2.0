import { useState, useEffect, useRef } from 'react'
import { Save, Eye, EyeOff, Send, Download, Upload, Info, Plus, Trash2, Check, X, Building2, Image, BookOpen, FolderOpen, RefreshCw, Bot, Shield, GitBranch } from 'lucide-react'
import clsx from 'clsx'
import useStore from '../lib/store.js'
import { updateBusiness, createBusiness, getBusinesses, deleteBusiness, getKbSettings, saveKbSettings, initKb, getBapAgents, revokeBapAgent, getBapAudit, getGoogleOAuthConfig, saveGoogleOAuthConfig, getLLMProviders, saveLLMCredentials, testLLMCredentials, getLLMDefault, setLLMDefault, getLLMTiers, setLLMTier, clearLLMTier, getApprovalPolicies, saveApprovalPolicies, getBlueprintGitHubStatus, saveBlueprintGitHubSettings, testBlueprintGitHubConnection, getSecurityStatus, getSecurityAllowlist, addSecurityAllowlist, removeSecurityAllowlist, setSecurityEnforcement, toggleSecurityLayer, getSecurityEvents, getAgentPollIntervals, setAgentPollInterval, resetAgentPollInterval, getBusinessProfile as fetchBusinessProfile, updateBusinessProfile as saveBusinessProfile } from '../lib/api.js'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import type { Business } from '../types/index.js'

// ── Local interfaces ───────────────────────────────────────────────────────────

interface LLMProviderInfo {
  id: string
  name: string
  description?: string
  configured?: boolean
  default_models?: Array<string | { id: string; name?: string }>
  models?: Array<string | { id: string; name?: string }>
  model?: string
  base_url?: string
  [key: string]: unknown
}

interface TierConfig {
  provider?: string | null
  model?: string | null
}

interface PollAgentRow {
  agent_id: string
  name: string
  current_minutes: number
  default_minutes: number
  is_overridden: boolean
}

interface BapAgent {
  id: string
  name: string
  status: string
  description?: string
  api_key_prefix?: string
  total_calls?: number
  last_seen?: string | null
  webhook_url?: string | null
  permissions?: string[]
}

interface BapCall {
  id: string
  method: string
  endpoint: string
  status_code: number
  duration_ms: number
  created_at: string
}

interface GoogleOAuthConfig {
  client_id?: string
  redirect_uri?: string
  default_redirect_uri?: string
  has_secret?: boolean
  configured?: boolean
  source?: { client_id: string; client_secret: string; redirect_uri: string }
}

interface GitHubStatus {
  configured?: boolean
  enabled?: boolean
  repo?: string
  rate_limit_remaining?: number | null
  error?: string
}

interface SecurityStatus {
  layers?: {
    outbound_allowlist?: { active: boolean; allowed_count?: number }
    content_sanitisation?: { active: boolean }
    kb_access_scoping?: { active: boolean }
    output_monitoring?: { active: boolean }
  }
  stats?: {
    outbound_blocked_30d?: number
    injections_detected_30d?: number
    anomalous_outputs_blocked_30d?: number
  }
}

interface AllowlistData {
  enforcement?: boolean
  allowed?: Array<{ host: string; source: string }>
}

interface SecurityEvent {
  id: string
  rule_id?: string
  title: string
  status: string
  created_at: string
}

interface KBSettingsData {
  config?: {
    mode?: string
    obsidian_vault_path?: string
    root?: string
    initialized?: boolean
    last_ingest?: string
    last_lint?: string
  }
}

interface EmailConfig {
  host?: string
  port?: string
  user?: string
  pass?: string
  from?: string
  api_key?: string
  [key: string]: string | undefined
}

interface HealthData {
  status?: string
  uptime?: number
  db?: string
}

// ── Tab definitions ────────────────────────────────────────────────────────────

const TABS = [
  { id: 'business',  label: 'Business Profile' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'llm',       label: 'LLM Providers' },
  { id: 'oauth',     label: 'Google OAuth' },
  { id: 'kb',        label: 'Knowledge Base' },
  { id: 'agents',    label: 'Agent Defaults' },
  { id: 'approvals', label: 'Approval Policies' },
  { id: 'integrations', label: 'External Agents' },
  { id: 'data',      label: 'Data' },
  { id: 'security',  label: 'Security' },
  { id: 'system',    label: 'System' },
  { id: 'about',     label: 'About' },
]

// ── Shared layout components ───────────────────────────────────────────────────

interface SectionProps {
  title: string
  description?: string
  children: React.ReactNode
}

function Section({ title, description, children }: SectionProps) {
  return (
    <div className="bp-card p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        {description && <p className="text-xs text-blueprint-muted mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  )
}

interface FieldProps {
  label: string
  hint?: string
  children: React.ReactNode
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-300 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-blueprint-muted mt-1">{hint}</p>}
    </div>
  )
}

// ============================================
// Tab: Business Profile
// ============================================
const BUSINESS_TYPES = ['service', 'agency', 'ecommerce', 'saas', 'content', 'other'] as const

interface BusinessProfile {
  business_type: string
  operating_model: string | null
  primary_domain: string | null
  primary_brand: string | null
  allowed_agent_types: string[]
  allowed_action_types: string[]
  inferred_fields: string[]
  confirmed_by_human: boolean
}

// ============================================
// Business Truth Layer (Phase 2-INT)
// ============================================
function BusinessTruthLayerSection({ businessId }: { businessId: string }) {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; title?: string; message: string }) => void
  const [profile, setProfile] = useState<BusinessProfile | null>(null)
  const [form, setForm] = useState({
    business_type: 'other',
    operating_model: '',
    primary_domain: '',
    primary_brand: '',
    allowed_agent_types: '',
    allowed_action_types: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchBusinessProfile(businessId).then((res: { profile: BusinessProfile }) => {
      if (cancelled) return
      setProfile(res.profile)
      setForm({
        business_type: res.profile.business_type,
        operating_model: res.profile.operating_model || '',
        primary_domain: res.profile.primary_domain || '',
        primary_brand: res.profile.primary_brand || '',
        allowed_agent_types: res.profile.allowed_agent_types.join(', '),
        allowed_action_types: res.profile.allowed_action_types.join(', '),
      })
    }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [businessId])

  async function handleSave() {
    setSaving(true)
    try {
      const res = await saveBusinessProfile(businessId, {
        business_type: form.business_type,
        operating_model: form.operating_model || null,
        primary_domain: form.primary_domain || null,
        primary_brand: form.primary_brand || null,
        allowed_agent_types: form.allowed_agent_types.split(',').map((s) => s.trim()).filter(Boolean),
        allowed_action_types: form.allowed_action_types.split(',').map((s) => s.trim()).filter(Boolean),
      }) as { profile: BusinessProfile }
      setProfile(res.profile)
      addNotification({ type: 'success', message: 'Business profile saved' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Section title="Business Truth Layer" description="Canonical identity and capability profile — every recommendation and task consults this before acting.">
        <p className="text-xs text-blueprint-muted">Loading…</p>
      </Section>
    )
  }

  return (
    <Section title="Business Truth Layer" description="Canonical identity and capability profile — every recommendation and task consults this before acting.">
      {profile && !profile.confirmed_by_human && (
        <div className="flex items-center gap-2 px-3 py-2 rounded border border-amber-500/30 bg-amber-500/5 text-xs text-amber-300">
          <Info size={13} className="flex-shrink-0" />
          <span>Some fields below (business type) were auto-inferred, not yet confirmed. Save to confirm.</span>
        </div>
      )}
      <Field label="Business Type" hint="Determines which action types and agent types are valid for this business (e.g. Shopify actions require 'ecommerce').">
        <select value={form.business_type} onChange={(e) => setForm({ ...form, business_type: e.target.value })} className="bp-select w-full">
          {BUSINESS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Operating Model" hint="Free-text: how this business actually operates day-to-day">
        <input value={form.operating_model} onChange={(e) => setForm({ ...form, operating_model: e.target.value })} className="bp-input" placeholder="e.g. Local service business, appointment-based" />
      </Field>
      <Field label="Primary Domain" hint="Used to verify connectors (GA4, GSC, GBP, Shopify, ...) genuinely belong to this business">
        <input value={form.primary_domain} onChange={(e) => setForm({ ...form, primary_domain: e.target.value })} className="bp-input" placeholder="example.com" />
      </Field>
      <Field label="Primary Brand">
        <input value={form.primary_brand} onChange={(e) => setForm({ ...form, primary_brand: e.target.value })} className="bp-input" />
      </Field>
      <Field label="Allowed Agent Types" hint="Comma-separated agent roles allowed to work on this business. Empty = no restriction.">
        <input value={form.allowed_agent_types} onChange={(e) => setForm({ ...form, allowed_agent_types: e.target.value })} className="bp-input" placeholder="e.g. seo-sentinel, merchant" />
      </Field>
      <Field label="Allowed Action Types" hint="Comma-separated action_types allowed for this business. Empty = no restriction (subject to the registry's own business-type rules).">
        <input value={form.allowed_action_types} onChange={(e) => setForm({ ...form, allowed_action_types: e.target.value })} className="bp-input" placeholder="e.g. meta_update, content_draft" />
      </Field>
      <button onClick={() => void handleSave()} disabled={saving} className="bp-btn bp-btn-primary text-xs">
        <Save size={13} />
        {saving ? 'Saving…' : 'Save Business Profile'}
      </button>
    </Section>
  )
}

function BusinessTab() {
  const currentBusiness = useStore((s) => s.currentBusiness) as Business | null
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness) as unknown as (b: Business) => void
  const businesses = useStore((s) => s.businesses) as unknown as Business[]
  const setBusinesses = useStore((s) => s.setBusinesses) as unknown as (b: Business[]) => void
  const [form, setForm] = useState({
    name: currentBusiness?.name || '',
    type: currentBusiness?.type || '',
    description: currentBusiness?.description || '',
    slug: currentBusiness?.slug || '',
    website: (currentBusiness?.settings?.website as string) || '',
  })
  const [logoPreview, setLogoPreview] = useState<string | null>((currentBusiness?.settings?.logo as string) || null)
  const [saving, setSaving] = useState(false)
  const [showNewBusiness, setShowNewBusiness] = useState(false)
  const [newBizForm, setNewBizForm] = useState({ name: '', type: '' })
  const [creating, setCreating] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; title?: string; message: string }) => void

  // Sync form when business changes
  useEffect(() => {
    if (!currentBusiness) return
    setForm({
      name: currentBusiness.name || '',
      type: currentBusiness.type || '',
      description: currentBusiness.description || '',
      slug: currentBusiness.slug || '',
      website: (currentBusiness.settings?.website as string) || '',
    })
    setLogoPreview((currentBusiness.settings?.logo as string) || null)
  }, [currentBusiness?.id])

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      setLogoPreview(ev.target?.result as string)
    }
    reader.readAsDataURL(file)
  }

  function handleRemoveLogo() {
    setLogoPreview(null)
    if (logoInputRef.current) logoInputRef.current.value = ''
  }

  async function handleSave() {
    if (!currentBusiness?.id) return
    setSaving(true)
    try {
      const updated = await updateBusiness(currentBusiness.id, {
        name: form.name,
        type: form.type,
        description: form.description,
        settings: { ...currentBusiness.settings, website: form.website, logo: logoPreview || undefined },
      }) as Business
      setCurrentBusiness(updated)
      setBusinesses(businesses.map((b) => b.id === updated.id ? updated : b))
      addNotification({ type: 'success', message: 'Business profile saved' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  async function handleCreateBusiness() {
    if (!newBizForm.name.trim()) return
    setCreating(true)
    try {
      const created = await createBusiness({ name: newBizForm.name.trim(), type: newBizForm.type || null }) as Business
      const updated = await getBusinesses() as Business[]
      setBusinesses(updated)
      setCurrentBusiness(created)
      setShowNewBusiness(false)
      setNewBizForm({ name: '', type: '' })
      addNotification({ type: 'success', message: `Business "${created.name}" created` })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setCreating(false)
    }
  }

  async function handleDeleteBusiness(id: string) {
    setDeleting(true)
    try {
      await deleteBusiness(id)
      const remaining = businesses.filter((b) => b.id !== id)
      setBusinesses(remaining)
      if (currentBusiness?.id === id) {
        setCurrentBusiness(remaining[0] ?? null as unknown as Business)
      }
      setConfirmDeleteId(null)
      addNotification({ type: 'success', message: 'Business deleted' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Business Switcher */}
      {businesses.length > 0 && (
        <Section title="Your Businesses" description="Switch between businesses or add a new one">
          <div className="space-y-2">
            {businesses.map((biz) => (
              <div key={biz.id} className="space-y-1">
                <div className={clsx(
                  'w-full flex items-center gap-3 p-3 rounded border transition-colors',
                  currentBusiness?.id === biz.id
                    ? 'border-blueprint-blue/40 bg-blueprint-blue/5'
                    : 'border-blueprint-border'
                )}>
                  <button
                    onClick={() => setCurrentBusiness(biz)}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  >
                    {(biz.settings?.logo as string) ? (
                      <img src={biz.settings.logo as string} alt="" className="w-7 h-7 rounded object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-7 h-7 rounded bg-blueprint-blue/20 flex items-center justify-center flex-shrink-0">
                        <Building2 size={13} className="text-blueprint-blue" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-200 truncate">{biz.name}</p>
                      {biz.type && <p className="text-xs text-blueprint-muted capitalize">{biz.type}</p>}
                    </div>
                    {currentBusiness?.id === biz.id && (
                      <Check size={14} className="text-blueprint-blue flex-shrink-0" />
                    )}
                  </button>
                  {businesses.length > 1 && (
                    <button
                      onClick={() => setConfirmDeleteId(confirmDeleteId === biz.id ? null : biz.id)}
                      className="p-1.5 rounded text-blueprint-muted hover:text-blueprint-red hover:bg-blueprint-red/10 transition-colors flex-shrink-0"
                      title="Remove business"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
                {confirmDeleteId === biz.id && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded border border-blueprint-red/30 bg-blueprint-red/5 text-xs">
                    <span className="text-slate-300 flex-1">Delete <strong>{biz.name}</strong> and all its data? This cannot be undone.</span>
                    <button
                      onClick={() => void handleDeleteBusiness(biz.id)}
                      disabled={deleting}
                      className="bp-btn bp-btn-danger text-xs py-0.5 px-2"
                    >
                      {deleting ? 'Deleting…' : 'Delete'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="bp-btn bp-btn-secondary text-xs py-0.5 px-2"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {!showNewBusiness ? (
            <button onClick={() => setShowNewBusiness(true)} className="bp-btn bp-btn-secondary text-xs w-full">
              <Plus size={13} />
              Add New Business
            </button>
          ) : (
            <div className="space-y-3 p-3 border border-blueprint-border rounded bg-blueprint-bg">
              <p className="text-xs font-semibold text-slate-200">New Business</p>
              <Field label="Business Name">
                <input
                  value={newBizForm.name}
                  onChange={(e) => setNewBizForm({ ...newBizForm, name: e.target.value })}
                  className="bp-input"
                  placeholder="My Business"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateBusiness() }}
                />
              </Field>
              <Field label="Type">
                <select value={newBizForm.type} onChange={(e) => setNewBizForm({ ...newBizForm, type: e.target.value })} className="bp-select w-full">
                  <option value="">Select type...</option>
                  <option value="ecommerce">E-commerce</option>
                  <option value="saas">SaaS</option>
                  <option value="agency">Agency</option>
                  <option value="local">Local Business</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <div className="flex gap-2">
                <button onClick={() => void handleCreateBusiness()} disabled={creating || !newBizForm.name.trim()} className="bp-btn bp-btn-primary text-xs">
                  <Plus size={12} />
                  {creating ? 'Creating…' : 'Create'}
                </button>
                <button onClick={() => { setShowNewBusiness(false); setNewBizForm({ name: '', type: '' }) }} className="bp-btn bp-btn-secondary text-xs">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Section>
      )}

      <Section title="Business Details" description="Basic information about the current business">
        {/* Logo */}
        <Field label="Business Logo">
          <div className="flex items-center gap-3">
            {logoPreview ? (
              <div className="relative">
                <img src={logoPreview} alt="Logo" className="w-16 h-16 rounded object-cover border border-blueprint-border" />
                <button
                  onClick={handleRemoveLogo}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-blueprint-red flex items-center justify-center text-white"
                >
                  <X size={10} />
                </button>
              </div>
            ) : (
              <div className="w-16 h-16 rounded border-2 border-dashed border-blueprint-border flex items-center justify-center">
                <Image size={20} className="text-blueprint-muted" />
              </div>
            )}
            <div>
              <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoChange} className="hidden" id="logo-upload" />
              <label htmlFor="logo-upload" className="bp-btn bp-btn-secondary text-xs cursor-pointer">
                <Upload size={12} />
                {logoPreview ? 'Change Logo' : 'Upload Logo'}
              </label>
              <p className="text-xs text-blueprint-muted mt-1">PNG, JPG, GIF up to 2MB</p>
            </div>
          </div>
        </Field>

        <Field label="Business Name">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bp-input" />
        </Field>
        <Field label="Business Type">
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="bp-select w-full">
            <option value="">Select type...</option>
            <option value="ecommerce">E-commerce</option>
            <option value="saas">SaaS</option>
            <option value="agency">Agency</option>
            <option value="local">Local Business</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Description">
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="bp-input resize-none"
            rows={3}
            placeholder="Brief description of your business..."
          />
        </Field>
        <Field label="Website URL" hint="Used by PageSpeed connector if no URL is set on the connector">
          <input
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
            className="bp-input"
            placeholder="https://example.com"
            type="url"
          />
        </Field>
        <Field label="Slug" hint="Used in URLs — read only">
          <input value={form.slug} readOnly className="bp-input opacity-60 cursor-not-allowed" />
        </Field>
        <button onClick={() => void handleSave()} disabled={saving} className="bp-btn bp-btn-primary text-xs">
          <Save size={13} />
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </Section>

      {currentBusiness?.id && <BusinessTruthLayerSection businessId={currentBusiness.id} />}
    </div>
  )
}

// ============================================
// Tab: Notifications
// ============================================
function NotificationsTab() {
  const currentBusiness = useStore((s) => s.currentBusiness) as Business | null
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness) as unknown as (b: Business) => void
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; title?: string; message: string }) => void
  const [botToken, setBotToken] = useState(() => (currentBusiness?.settings?.telegram as Record<string, string> | undefined)?.botToken || '')
  const [chatId, setChatId] = useState(() => (currentBusiness?.settings?.telegram as Record<string, string> | undefined)?.chatId || '')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  async function handleTest() {
    if (!botToken || !chatId) {
      addNotification({ type: 'warning', message: 'Enter bot token and chat ID first' })
      return
    }
    setTesting(true)
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: '✅ Blueprint test notification — bot is connected!' }),
        }
      )
      const data = await res.json() as { ok: boolean; description?: string }
      if (data.ok) {
        addNotification({ type: 'success', title: 'Test sent!', message: 'Check your Telegram' })
      } else {
        addNotification({ type: 'error', message: data.description || 'Telegram error' })
      }
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!currentBusiness?.id) return
    setSaving(true)
    try {
      const updated = await updateBusiness(currentBusiness.id, {
        settings: {
          ...currentBusiness.settings,
          telegram: { botToken: botToken.trim(), chatId: chatId.trim() },
        },
      }) as Business
      setCurrentBusiness(updated)
      addNotification({ type: 'success', message: 'Telegram settings saved — bot will start polling shortly' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Section title="Telegram Bot" description="Receive alerts and approve tasks directly from Telegram">
        <div className="p-3 rounded bg-blueprint-blue/5 border border-blueprint-blue/20 space-y-1">
          <p className="text-xs font-medium text-blueprint-blue">Setup instructions</p>
          <ol className="text-xs text-blueprint-muted space-y-0.5 list-decimal list-inside">
            <li>Message <span className="mono text-slate-300">@BotFather</span> on Telegram → create a bot → copy the token</li>
            <li>Start your bot by sending it a message, then get your chat ID from <span className="mono text-slate-300">@userinfobot</span></li>
            <li>Paste both below, Save, then Test Connection</li>
          </ol>
        </div>

        <Field label="Bot Token" hint="From @BotFather — format: 123456789:ABCdef...">
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            className="bp-input"
            placeholder="123456789:ABCdef..."
          />
        </Field>
        <Field label="Chat ID" hint="Your personal chat ID or a group/channel ID">
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            className="bp-input"
            placeholder="-100123456789"
          />
        </Field>

        <div className="flex gap-2">
          <button onClick={() => void handleSave()} disabled={saving} className="bp-btn bp-btn-primary text-xs">
            <Save size={12} />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => void handleTest()} disabled={testing || !botToken || !chatId} className="bp-btn bp-btn-secondary text-xs">
            <Send size={12} />
            {testing ? 'Sending...' : 'Test Connection'}
          </button>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium text-slate-300">Available bot commands</p>
          {[
            { cmd: '/status', desc: 'Show open signals and pending tasks' },
            { cmd: '/tasks', desc: 'List pending tasks awaiting approval' },
            { cmd: '/approve <id>', desc: 'Approve a task by its short ID' },
            { cmd: '/reject <id>', desc: 'Reject a task by its short ID' },
          ].map((item) => (
            <div key={item.cmd} className="flex gap-2 text-xs">
              <span className="mono text-blueprint-blue w-28 flex-shrink-0">{item.cmd}</span>
              <span className="text-blueprint-muted">{item.desc}</span>
            </div>
          ))}
        </div>
      </Section>

      <EmailReportsSection />
    </div>
  )
}

// ─── Email reports ────────────────────────────────────────────────────────────
function EmailReportsSection() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [provider, setProvider] = useState('smtp')
  const [recipient, setRecipient] = useState('')
  const [config, setConfig] = useState<EmailConfig>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sendingTest, setSendingTest] = useState(false)

  useEffect(() => {
    import('../lib/api.js').then(({ getEmailSettings }) =>
      (getEmailSettings() as Promise<{ provider?: string; recipient?: string; config?: EmailConfig } | null>)
        .then((data) => {
          if (data) {
            setProvider(data.provider ?? 'smtp')
            setRecipient(data.recipient ?? '')
            setConfig(data.config ?? {})
          }
        }).catch(() => {}).finally(() => setLoading(false))
    )
  }, [])

  function updateConfig(key: string, value: string) {
    setConfig((c) => ({ ...c, [key]: value }))
  }

  async function handleSave() {
    setSaving(true)
    try {
      const { saveEmailSettings } = await import('../lib/api.js')
      await (saveEmailSettings as (data: unknown) => Promise<void>)({ provider, recipient, config })
      addNotification({ type: 'success', message: 'Email settings saved' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally { setSaving(false) }
  }

  async function handleTest() {
    setSendingTest(true)
    try {
      const { sendTestEmail } = await import('../lib/api.js')
      await (sendTestEmail as (data: unknown) => Promise<void>)({ to: recipient })
      addNotification({ type: 'success', message: `Test email sent to ${recipient}` })
    } catch (err) {
      addNotification({ type: 'error', message: `Test failed: ${(err as Error).message}` })
    } finally { setSendingTest(false) }
  }

  if (loading) return null

  return (
    <Section title="Email Reports" description="Receive weekly briefings by email. Runs automatically each Monday.">
      <Field label="Send to" hint="Recipient email address">
        <input
          type="email"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          className="bp-input"
          placeholder="you@example.com"
        />
      </Field>
      <Field label="Email provider">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="bp-input"
        >
          <option value="smtp">SMTP</option>
          <option value="resend">Resend</option>
          <option value="postmark">Postmark</option>
          <option value="brevo">Brevo</option>
        </select>
      </Field>

      {provider === 'smtp' && (
        <>
          <Field label="Host"><input value={config.host ?? ''} onChange={(e) => updateConfig('host', e.target.value)} className="bp-input" placeholder="smtp.gmail.com" /></Field>
          <Field label="Port"><input value={config.port ?? ''} onChange={(e) => updateConfig('port', e.target.value)} className="bp-input" placeholder="587" /></Field>
          <Field label="User"><input value={config.user ?? ''} onChange={(e) => updateConfig('user', e.target.value)} className="bp-input" placeholder="your@gmail.com" /></Field>
          <Field label="Pass"><input type="password" value={config.pass ?? ''} onChange={(e) => updateConfig('pass', e.target.value)} className="bp-input" placeholder="App password" /></Field>
          <Field label="From"><input value={config.from ?? ''} onChange={(e) => updateConfig('from', e.target.value)} className="bp-input" placeholder="Blueprint <noreply@yourdomain.com>" /></Field>
        </>
      )}
      {provider === 'resend' && (
        <>
          <Field label="API Key"><input type="password" value={config.api_key ?? ''} onChange={(e) => updateConfig('api_key', e.target.value)} className="bp-input" placeholder="re_..." /></Field>
          <Field label="From"><input value={config.from ?? ''} onChange={(e) => updateConfig('from', e.target.value)} className="bp-input" placeholder="Blueprint <noreply@yourdomain.com>" /></Field>
        </>
      )}
      {provider === 'postmark' && (
        <>
          <Field label="Server Token"><input type="password" value={config.api_key ?? ''} onChange={(e) => updateConfig('api_key', e.target.value)} className="bp-input" /></Field>
          <Field label="From"><input value={config.from ?? ''} onChange={(e) => updateConfig('from', e.target.value)} className="bp-input" /></Field>
        </>
      )}
      {provider === 'brevo' && (
        <>
          <Field label="API Key"><input type="password" value={config.api_key ?? ''} onChange={(e) => updateConfig('api_key', e.target.value)} className="bp-input" placeholder="xkeysib-..." /></Field>
          <Field label="From"><input value={config.from ?? ''} onChange={(e) => updateConfig('from', e.target.value)} className="bp-input" /></Field>
        </>
      )}

      <div className="flex gap-2">
        <button onClick={() => void handleSave()} disabled={saving} className="bp-btn bp-btn-primary text-xs">
          <Save size={12} />
          {saving ? 'Saving…' : 'Save email settings'}
        </button>
        <button onClick={() => void handleTest()} disabled={sendingTest || !recipient} className="bp-btn bp-btn-secondary text-xs">
          <Send size={12} />
          {sendingTest ? 'Sending…' : 'Send test email'}
        </button>
      </div>
    </Section>
  )
}

// ============================================
// Tab: LLM Providers
// ============================================

function LLMProviderRow({ provider, isDefault, onSetDefault, onSaved }: {
  provider: LLMProviderInfo
  isDefault: boolean
  onSetDefault: (id: string) => void
  onSaved?: () => void
}) {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState(provider.model || (Array.isArray(provider.default_models) && provider.default_models.length > 0 ? String(provider.default_models[0]) : '') || '')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const needsKey = provider.id !== 'ollama' && provider.id !== 'lmstudio' && provider.id !== 'claude-cli'
  const needsBaseUrl = provider.id === 'ollama' || provider.id === 'lmstudio' || provider.id === 'custom'
  const showBaseUrlOptional = !needsBaseUrl && provider.id !== 'claude-cli'
  const models = Array.isArray(provider.default_models) ? provider.default_models : []

  async function handleSave() {
    setSaving(true)
    try {
      const body: Record<string, string> = {}
      if (apiKey.trim()) body.apiKey = apiKey.trim()
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim()
      if (model && model.trim()) body.model = model.trim()
      if (Object.keys(body).length === 0) {
        addNotification({ type: 'warning', message: 'Enter an API key, base URL, or pick a model first.' })
        return
      }
      await saveLLMCredentials(provider.id, body)
      setApiKey('')
      addNotification({ type: 'success', message: `${provider.name} saved.` })
      onSaved?.()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const body: Record<string, string> = {}
      if (apiKey.trim()) body.apiKey = apiKey.trim()
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim()
      const r = await testLLMCredentials(provider.id, body) as { ok?: boolean; message?: string } | undefined
      setTestResult({ ok: !!r?.ok, message: r?.message || (r?.ok ? 'OK' : 'Failed') })
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const getBaseUrlPlaceholder = () => {
    if (provider.id === 'ollama') return 'http://localhost:11434'
    if (provider.id === 'lmstudio') return 'http://localhost:1234/v1'
    if (provider.id === 'minimax') return (provider.base_url as string) || 'https://api.minimax.io/v1'
    if (provider.id === 'anthropic') return (provider.base_url as string) || 'https://api.anthropic.com'
    if (provider.id === 'openai') return (provider.base_url as string) || 'https://api.openai.com/v1'
    if (provider.id === 'google') return (provider.base_url as string) || 'https://generativelanguage.googleapis.com/v1beta'
    return 'https://...'
  }

  return (
    <div className="bp-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-100">{provider.name}</span>
            {provider.configured && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blueprint-green/15 text-blueprint-green font-mono">configured</span>
            )}
            {isDefault && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blueprint-blue/15 text-blueprint-blue font-mono">DEFAULT</span>
            )}
          </div>
          <p className="text-xs text-blueprint-muted mt-0.5">{provider.description}</p>
        </div>
        {provider.configured && !isDefault && (
          <button onClick={() => onSetDefault(provider.id)} className="bp-btn bp-btn-secondary text-xs">
            Make default
          </button>
        )}
      </div>

      {needsKey && (
        <div>
          <label className="block text-xs text-blueprint-muted mb-1">
            API Key {provider.configured && <span className="text-blueprint-muted/60">(leave blank to keep existing)</span>}
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="bp-input pr-10"
              placeholder={provider.configured ? '••••••••••••' : 'Paste your API key'}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-blueprint-muted hover:text-slate-200"
              tabIndex={-1}
            >
              {showKey ? <EyeOff size={14}/> : <Eye size={14}/>}
            </button>
          </div>
        </div>
      )}

      {(needsBaseUrl || showBaseUrlOptional) && (
        <div>
          <label className="block text-xs text-blueprint-muted mb-1">
            Base URL {!needsBaseUrl && <span className="text-blueprint-muted/60">(optional — override only if you're on a different endpoint)</span>}
          </label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="bp-input"
            placeholder={getBaseUrlPlaceholder()}
          />
          {provider.id === 'minimax' && (
            <p className="text-[10px] text-blueprint-muted mt-1">
              MiniMax has two platforms: <code>api.minimax.io</code> (international, token plan) and{' '}
              <code>api.minimaxi.chat</code> (mainland China, CNY). A key from one is rejected by the other.
            </p>
          )}
        </div>
      )}

      {/* Model picker */}
      {(models.length > 0 || provider.id === 'custom' || provider.id === 'ollama' || provider.id === 'lmstudio') && (
        <div>
          <label className="block text-xs text-blueprint-muted mb-1">
            Default model
          </label>
          {models.length > 0 ? (
            <div className="flex gap-2">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="bp-input bp-select flex-1"
              >
                <option value="">— Use provider default —</option>
                {models.map((m) => {
                  const id = typeof m === 'string' ? m : m.id
                  return <option key={id} value={id}>{id}</option>
                })}
                <option value="__custom">Custom (type below)</option>
              </select>
            </div>
          ) : null}
          {(model === '__custom' || models.length === 0) && (
            <input
              type="text"
              value={model === '__custom' ? '' : model}
              onChange={(e) => setModel(e.target.value)}
              className="bp-input mt-1"
              placeholder={provider.id === 'ollama' ? 'llama3' : provider.id === 'custom' ? 'model-id' : 'Custom model id'}
            />
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={() => void handleSave()} disabled={saving} className="bp-btn bp-btn-primary text-xs">
          <Save size={12} />
          {saving ? 'Saving…' : 'Save'}
        </button>
        {needsKey && (
          <button onClick={() => void handleTest()} disabled={testing} className="bp-btn bp-btn-secondary text-xs">
            {testing ? 'Testing…' : 'Test'}
          </button>
        )}
        {testResult && (
          <span className={clsx('text-xs ml-2', testResult.ok ? 'text-blueprint-green' : 'text-blueprint-red')}>
            {testResult.ok ? '✓' : '✗'} {testResult.message}
          </span>
        )}
      </div>
    </div>
  )
}

function LLMTab() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [providers, setProviders] = useState<LLMProviderInfo[] | null>(null)
  const [defaultProvider, setDefaultProvider] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      const [list, def] = await Promise.all([
        getLLMProviders() as Promise<LLMProviderInfo[]>,
        (getLLMDefault() as Promise<{ provider?: string | null }>).catch(() => ({ provider: null })),
      ])
      setProviders(Array.isArray(list) ? list : [])
      setDefaultProvider(def?.provider ?? null)
    } catch (err) {
      addNotification({ type: 'error', message: 'Failed to load providers: ' + (err as Error).message })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  async function handleSetDefault(providerId: string) {
    try {
      await setLLMDefault(providerId)
      setDefaultProvider(providerId)
      addNotification({ type: 'success', message: `${providerId} is now the default LLM provider.` })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    }
  }

  if (loading) return <div className="text-sm text-blueprint-muted">Loading providers…</div>

  return (
    <div className="space-y-4">
      <Section
        title="LLM Providers"
        description="Configure the AI providers Blueprint can use. Set one as the default — it'll be used whenever an agent doesn't pin a specific provider, or when the pinned one has no credentials."
      >
        <div className="space-y-3">
          {(providers ?? []).map((p) => (
            <LLMProviderRow
              key={p.id}
              provider={p}
              isDefault={defaultProvider === p.id}
              onSetDefault={handleSetDefault}
              onSaved={refresh}
            />
          ))}
        </div>
      </Section>

      <TierConfigSection providers={providers ?? []} />
    </div>
  )
}

// Tier configuration
function TierConfigSection({ providers }: { providers: LLMProviderInfo[] }) {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [tiers, setTiers] = useState<Record<string, TierConfig>>({ default: {}, triage: {}, fallback: {} })
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Record<string, Partial<TierConfig>>>({})

  const load = async () => {
    setLoading(true)
    try {
      const res = await getLLMTiers() as { tiers?: Record<string, TierConfig> }
      setTiers(res?.tiers ?? { default: {}, triage: {}, fallback: {} })
    } catch (err) {
      addNotification({ type: 'error', message: 'Failed to load tiers: ' + (err as Error).message })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const save = async (tier: string) => {
    const draft = pending[tier] ?? {}
    const provider = draft.provider ?? tiers[tier]?.provider
    const model = draft.model ?? tiers[tier]?.model
    try {
      await setLLMTier(tier, { provider, model })
      addNotification({ type: 'success', message: `${tier} tier updated.` })
      setPending((p) => ({ ...p, [tier]: {} }))
      await load()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    }
  }
  const clear = async (tier: string) => {
    try {
      await clearLLMTier(tier)
      addNotification({ type: 'success', message: `${tier} tier cleared — falls back to default.` })
      await load()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    }
  }

  const modelsFor = (providerId: string) => {
    const p = providers.find((x) => x.id === providerId)
    return p?.models ?? []
  }

  const TierRow = ({ tier, description }: { tier: string; description: string }) => {
    const cur = tiers[tier] ?? {}
    const draft = pending[tier] ?? {}
    const provider = draft.provider ?? cur.provider ?? ''
    const model = draft.model ?? cur.model ?? ''
    const dirty = (draft.provider !== undefined && draft.provider !== cur.provider) ||
                  (draft.model !== undefined && draft.model !== cur.model)
    const isDefault = tier === 'default'
    const configured = !!(cur.provider && cur.model)
    const tierModels = modelsFor(provider ?? '')
    return (
      <div className="p-3 rounded border border-blueprint-border bg-blueprint-bg">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-xs font-medium text-slate-300 capitalize">{tier} tier</div>
            <div className="text-[10px] text-blueprint-muted">{description}</div>
          </div>
          <div className="text-[10px] text-blueprint-muted">
            {configured ? '✓ configured' : isDefault ? '⚠ not set' : 'falls back to default'}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
          <select
            value={provider ?? ''}
            onChange={(e) => setPending((p) => ({
              ...p,
              [tier]: { ...(p[tier] ?? {}), provider: e.target.value || null, model: null },
            }))}
            className="bp-select text-xs"
          >
            <option value="">— not set —</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            value={model ?? ''}
            onChange={(e) => setPending((p) => ({
              ...p,
              [tier]: { ...(p[tier] ?? {}), model: e.target.value || null },
            }))}
            disabled={!provider}
            className="bp-select text-xs"
          >
            <option value="">— pick a model —</option>
            {tierModels.map((m) => {
              const id = typeof m === 'string' ? m : m.id
              const name = typeof m === 'string' ? m : (m.name ?? m.id)
              return <option key={id} value={id}>{name}</option>
            })}
          </select>
          <div className="flex gap-1">
            <button
              onClick={() => void save(tier)}
              disabled={!dirty}
              className="bp-btn bp-btn-secondary text-[10px]"
            >
              Save
            </button>
            {!isDefault && configured && (
              <button
                onClick={() => void clear(tier)}
                className="bp-btn bp-btn-ghost text-[10px]"
                title="Clear — falls back to default"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <Section
      title="LLM Tiers"
      description="Pick which provider + model drives each tier. Blueprint never hardcodes a model — every LLM call resolves through these settings."
    >
      {loading ? (
        <div className="text-xs text-blueprint-muted">Loading…</div>
      ) : (
        <div className="space-y-2">
          <TierRow
            tier="default"
            description="Used for every run unless the call explicitly asks for another tier. Required."
          />
          <TierRow
            tier="triage"
            description="Fast/cheap model for routing, intent extraction, attribution, summaries. Optional — falls back to default."
          />
          <TierRow
            tier="fallback"
            description="Retry model when the primary provider fails mid-run. Optional — if unset, primary failure propagates."
          />
        </div>
      )}
    </Section>
  )
}

// ============================================
// Poll-interval section
// ============================================
function PollIntervalsSection() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [rows, setRows] = useState<PollAgentRow[]>([])
  const [bounds, setBounds] = useState({ min: 1, max: 20160 })
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Record<string, string>>({})

  const load = async () => {
    setLoading(true)
    try {
      const res = await getAgentPollIntervals() as { agents?: PollAgentRow[]; bounds?: { min: number; max: number } }
      setRows(res?.agents ?? [])
      if (res?.bounds) setBounds(res.bounds)
      setPending({})
    } catch (err) {
      addNotification({ type: 'error', message: `Failed to load poll intervals: ${(err as Error).message}` })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const save = async (agentId: string) => {
    const minutes = Number(pending[agentId])
    if (!Number.isFinite(minutes) || minutes < bounds.min || minutes > bounds.max) {
      addNotification({ type: 'error', message: `Interval must be between ${bounds.min} and ${bounds.max} minutes` })
      return
    }
    try {
      await setAgentPollInterval(agentId, minutes)
      addNotification({ type: 'success', message: `${agentId} poll interval set to ${minutes} min` })
      await load()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    }
  }
  const reset = async (agentId: string) => {
    try {
      await resetAgentPollInterval(agentId)
      addNotification({ type: 'success', message: `${agentId} reverted to default` })
      await load()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    }
  }

  return (
    <Section
      title="Poll Intervals"
      description="How often each agent's safety-net poll fires. Primary triggers are events (connector syncs, signals, chat mentions). This controls the fallback when events are missed."
    >
      {loading && (
        <div className="text-xs text-blueprint-muted">Loading…</div>
      )}
      {!loading && rows.length === 0 && (
        <div className="text-xs text-blueprint-muted">No agents installed.</div>
      )}
      {!loading && rows.length > 0 && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_110px_90px_110px] gap-2 text-[10px] uppercase tracking-wider text-blueprint-muted font-mono pb-1 border-b border-blueprint-border">
            <div>Agent</div>
            <div>Current</div>
            <div>Default</div>
            <div>Actions</div>
          </div>
          {rows.map((r) => {
            const isOverridden = r.is_overridden
            const effective = pending[r.agent_id] ?? String(r.current_minutes)
            const warnLowInterval = Number(effective) < 15 && r.agent_id !== 'sentinel'
            return (
              <div key={r.agent_id} className="grid grid-cols-[1fr_110px_90px_110px] gap-2 items-center text-xs font-mono">
                <div className="flex flex-col">
                  <span className="text-slate-300">{r.name}</span>
                  <span className="text-blueprint-muted text-[10px]">{r.agent_id}</span>
                </div>
                <div>
                  <input
                    type="number"
                    min={bounds.min}
                    max={bounds.max}
                    value={effective}
                    onChange={(e) => setPending({ ...pending, [r.agent_id]: e.target.value })}
                    className="bp-input text-xs w-24 font-mono"
                  />
                  <span className="text-[10px] text-blueprint-muted ml-1">min</span>
                </div>
                <div className="text-[10px] text-blueprint-muted">
                  {r.default_minutes} min
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => void save(r.agent_id)}
                    disabled={Number(effective) === r.current_minutes}
                    className="bp-btn bp-btn-secondary text-[10px] px-2 py-0.5"
                  >
                    Save
                  </button>
                  {isOverridden && (
                    <button
                      onClick={() => void reset(r.agent_id)}
                      className="bp-btn bp-btn-ghost text-[10px] px-2 py-0.5"
                      title="Revert to default"
                    >
                      Reset
                    </button>
                  )}
                  {warnLowInterval && (
                    <span title="Frequent runs can be costly" className="text-[10px] text-amber-400">⚠</span>
                  )}
                </div>
              </div>
            )
          })}
          <p className="text-[10px] text-blueprint-muted mt-2">
            Intervals below 15 min for non-uptime agents can produce real LLM
            cost — the work-check gate limits wasted runs but tight loops on
            genuinely new data will still fire. Conductor is polled every 15
            min on its own schedule.
          </p>
        </div>
      )}
    </Section>
  )
}

// Tab: Agent Defaults
// ============================================
function AgentDefaultsTab() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [form, setForm] = useState({
    global_cost_cap: '5.00',
    default_trust_tier: 'medium',
    auto_approve_high_trust: false,
    notify_on_propose: true,
    notify_on_complete: true,
  })

  const notifyItems: Array<{ key: keyof typeof form; label: string }> = [
    { key: 'notify_on_propose', label: 'Notify when task is proposed' },
    { key: 'notify_on_complete', label: 'Notify when task completes' },
  ]

  return (
    <div className="space-y-4">
      <PollIntervalsSection />
      <Section title="Cost Controls" description="Prevent runaway agent spend">
        <Field label="Global Daily Cost Cap (USD)" hint="Agents will stop running when this limit is hit">
          <div className="relative w-36">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-blueprint-muted text-sm">$</span>
            <input
              type="number"
              value={form.global_cost_cap}
              onChange={(e) => setForm({ ...form, global_cost_cap: e.target.value })}
              className="bp-input pl-6"
              min="0"
              step="0.50"
            />
          </div>
        </Field>
      </Section>

      <Section title="Approval Defaults">
        <Field label="Default Trust Tier">
          <select
            value={form.default_trust_tier}
            onChange={(e) => setForm({ ...form, default_trust_tier: e.target.value })}
            className="bp-select"
          >
            <option value="high">🟢 High — auto-approve where possible</option>
            <option value="medium">🟡 Medium — require manual approval</option>
            <option value="low">🔴 Low — always require approval + note</option>
          </select>
        </Field>
        <Field label="Auto-approve High Trust tasks">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.auto_approve_high_trust}
              onChange={(e) => setForm({ ...form, auto_approve_high_trust: e.target.checked })}
              className="w-4 h-4"
            />
            <span className="text-xs text-slate-300">Enable auto-approval for high trust agents</span>
          </label>
        </Field>
      </Section>

      <Section title="Notification Channels">
        <div className="space-y-2">
          {notifyItems.map((item) => (
            <label key={item.key} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form[item.key] as boolean}
                onChange={(e) => setForm({ ...form, [item.key]: e.target.checked })}
                className="w-4 h-4"
              />
              <span className="text-xs text-slate-300">{item.label}</span>
            </label>
          ))}
        </div>
      </Section>

      <button
        onClick={() => addNotification({ type: 'success', message: 'Agent defaults saved' })}
        className="bp-btn bp-btn-primary text-xs"
      >
        <Save size={12} />
        Save Defaults
      </button>
    </div>
  )
}

// ============================================
// Tab: Data
// ============================================
function DataTab() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const currentBusiness = useStore((s) => s.currentBusiness) as Business | null
  const [retentionDays, setRetentionDays] = useState(90)

  function handleExport() {
    addNotification({ type: 'info', message: 'Preparing data export...' })
  }

  return (
    <div className="space-y-4">
      <Section title="Export Data" description="Download all your Blueprint data as JSON">
        <p className="text-xs text-blueprint-muted">
          Export includes: all signals, tasks, agent runs, connectors, and KB documents for{' '}
          <span className="text-slate-300">{currentBusiness?.name || 'your business'}</span>.
        </p>
        <button onClick={handleExport} className="bp-btn bp-btn-secondary text-xs">
          <Download size={12} />
          Export JSON
        </button>
      </Section>

      <Section title="Import Data" description="Restore from a Blueprint JSON export">
        <div className="border-2 border-dashed border-blueprint-border rounded p-6 text-center">
          <Upload size={20} className="text-blueprint-muted mx-auto mb-2" />
          <p className="text-xs text-blueprint-muted">Drop JSON file here or click to browse</p>
          <input type="file" accept=".json" className="hidden" />
        </div>
      </Section>

      <Section title="Data Retention" description="How long to keep historical data">
        <Field label="Retention Period" hint="Older signals and audit logs will be deleted">
          <select
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
            className="bp-select"
          >
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
            <option value={-1}>Forever</option>
          </select>
        </Field>
        <button
          onClick={() => addNotification({ type: 'success', message: 'Retention settings saved' })}
          className="bp-btn bp-btn-primary text-xs"
        >
          <Save size={12} />
          Save
        </button>
      </Section>
    </div>
  )
}

// ============================================
// Tab: System
// ============================================
function SystemTab() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [reiniting, setReiniting] = useState(false)
  const [health, setHealth] = useState<HealthData | null>(null)

  const BLUEPRINT_REPO_LABEL = 'chrisgwynne/Blueprint'
  const [ghToken, setGhToken]       = useState('')
  const [ghEnabled, setGhEnabled]   = useState(true)
  const [ghShowToken, setGhShowToken] = useState(false)
  const [ghStatus, setGhStatus]     = useState<GitHubStatus | null>(null)
  const [ghTesting, setGhTesting]   = useState(false)
  const [ghSaving, setGhSaving]     = useState(false)

  useEffect(() => {
    fetch('/api/health').then((r) => r.json() as Promise<HealthData>).then(setHealth).catch(() => {})
    getBlueprintGitHubStatus()
      .then((s) => {
        const status = s as GitHubStatus
        setGhStatus(status)
        if (typeof status.enabled === 'boolean') setGhEnabled(status.enabled)
      })
      .catch(() => {})
  }, [])

  async function handleReinit() {
    if (!confirm('Re-run database init? This is safe to run multiple times — it will not delete existing data.')) return
    setReiniting(true)
    try {
      const res = await fetch('/api/system/db-init', { method: 'POST', credentials: 'include' })
      if (res.ok) {
        addNotification({ type: 'success', message: 'Database init complete' })
      } else {
        const d = await res.json() as { error?: string }
        addNotification({ type: 'error', message: d.error || 'Init failed' })
      }
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setReiniting(false)
    }
  }

  async function handleGhSave() {
    setGhSaving(true)
    try {
      await saveBlueprintGitHubSettings({
        token: ghToken || undefined,
        enabled: ghEnabled,
      })
      addNotification({ type: 'success', message: 'Blueprint GitHub settings saved' })
      const s = await getBlueprintGitHubStatus() as GitHubStatus
      setGhStatus(s)
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setGhSaving(false)
    }
  }

  async function handleGhTest() {
    setGhTesting(true)
    try {
      const s = await testBlueprintGitHubConnection() as GitHubStatus
      setGhStatus(s)
      if (s.configured) {
        addNotification({ type: 'success', message: `Connected — ${s.repo} (${s.rate_limit_remaining ?? '?'} req remaining)` })
      } else {
        addNotification({ type: 'error', message: s.error || 'Connection failed' })
      }
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setGhTesting(false)
    }
  }

  const rows = [
    { label: 'Version', value: '0.1.0' },
    { label: 'Environment', value: import.meta.env.MODE },
    { label: 'Server status', value: health ? `${health.status} (uptime: ${health.uptime}s)` : 'checking…' },
    { label: 'Database', value: health?.db === 'ok' ? '✓ connected' : health ? '✗ error' : '…' },
  ]

  return (
    <div className="space-y-4">
      <Section title="System Info" description="Runtime and configuration details">
        <div className="space-y-0">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between py-2 border-b border-blueprint-border/50 last:border-0">
              <span className="text-xs text-blueprint-muted">{r.label}</span>
              <span className="text-xs mono text-slate-300">{r.value}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Blueprint GitHub Integration */}
      <Section
        title="Blueprint GitHub Integration"
        description="Used for self-healing bug reports, connector discovery issues, and draft fix PRs. Separate from business GitHub connectors."
      >
        <div className="p-3 rounded bg-blueprint-blue/5 border border-blueprint-blue/20 space-y-1 mb-3">
          <div className="flex items-center gap-2">
            <GitBranch size={12} className="text-blueprint-blue flex-shrink-0" />
            <p className="text-xs font-medium text-blueprint-blue">This is Blueprint's own repository</p>
          </div>
          <p className="text-xs text-blueprint-muted">
            Self-healing creates issues and draft PRs here — never on your clients' repos.
            PRs always target <span className="mono">develop</span>, always draft, never auto-merged.
          </p>
        </div>

        {ghStatus && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded border mb-3 text-xs ${
            ghStatus.configured
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
          }`}>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ghStatus.configured ? 'bg-green-400' : 'bg-amber-400'}`} />
            {ghStatus.configured
              ? `Connected — ${ghStatus.repo}${ghStatus.rate_limit_remaining != null ? ` (${ghStatus.rate_limit_remaining} req remaining)` : ''}`
              : `Not connected — ${ghStatus.error ?? 'token not configured'}`}
          </div>
        )}

        <div className="space-y-3">
          <Field label="Target repository" hint="Hardcoded — Blueprint never files issues or PRs on any other repo.">
            <div className="bp-input text-xs w-full opacity-70 flex items-center justify-between">
              <span className="mono">{BLUEPRINT_REPO_LABEL}</span>
              <span className="text-[10px] uppercase tracking-wider text-blueprint-muted">read-only</span>
            </div>
          </Field>

          <Field
            label="Enable self-healing on GitHub"
            hint="When off, Blueprint still diagnoses errors locally but does not create issues or draft PRs on GitHub."
          >
            <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={ghEnabled}
                onChange={(e) => setGhEnabled(e.target.checked)}
              />
              <span>{ghEnabled ? 'Enabled' : 'Disabled — no GitHub issues or PRs will be created'}</span>
            </label>
          </Field>

          <Field label="Personal Access Token" hint="Fine-grained token: Issues + Pull requests + Contents (read/write). Repo: chrisgwynne/Blueprint only.">
            <div className="relative">
              <input
                className="bp-input text-xs w-full pr-8"
                type={ghShowToken ? 'text' : 'password'}
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
                placeholder={ghStatus?.configured ? '••••••••••••••••••••••••••••••••' : 'ghp_...'}
                disabled={!ghEnabled}
              />
              <button
                type="button"
                onClick={() => setGhShowToken(!ghShowToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-blueprint-muted hover:text-slate-300"
              >
                {ghShowToken ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
          </Field>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleGhTest()}
              disabled={ghTesting}
              className="bp-btn bp-btn-ghost text-xs"
            >
              {ghTesting ? 'Testing…' : 'Test connection'}
            </button>
            <button
              onClick={() => void handleGhSave()}
              disabled={ghSaving}
              className="bp-btn bp-btn-secondary text-xs"
            >
              <Save size={11} /> {ghSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        <p className="text-xs text-blueprint-muted mt-2">
          Leave token blank to keep the existing saved token. Set via <span className="mono">BLUEPRINT_GITHUB_TOKEN</span> env var alternatively.
        </p>
      </Section>

      <Section title="Paths" description="Where Blueprint stores its data">
        <div className="space-y-2">
          {[
            { label: 'Database', hint: 'Set via DATABASE_PATH env var' },
            { label: 'Knowledge Base', hint: 'Set via KB_PATH env var' },
            { label: 'Agent Profiles', hint: 'Set via AGENTS_PATH env var' },
          ].map((p) => (
            <div key={p.label} className="p-3 rounded bg-blueprint-bg border border-blueprint-border">
              <p className="text-xs font-medium text-slate-300">{p.label}</p>
              <p className="text-xs text-blueprint-muted mt-0.5">{p.hint}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Maintenance">
        <div className="space-y-3">
          <p className="text-xs text-blueprint-muted">
            Re-running database init applies any missing schema migrations and re-seeds default data.
            Safe to run at any time — will not delete existing records.
          </p>
          <button
            onClick={() => void handleReinit()}
            disabled={reiniting}
            className="bp-btn bp-btn-secondary text-xs"
          >
            {reiniting ? 'Running…' : 'Re-run Database Init'}
          </button>
        </div>
      </Section>
    </div>
  )
}

// ============================================
// Tab: About
// ============================================
function AboutTab() {
  return (
    <div className="space-y-4">
      <Section title="Blueprint" description="Personal Business Operating System">
        <div className="space-y-2">
          {[
            { label: 'Version', value: '0.1.0' },
            { label: 'Build', value: import.meta.env.VITE_BUILD_ID as string || 'development' },
            { label: 'Environment', value: import.meta.env.MODE || 'development' },
            { label: 'Node API', value: 'v1' },
            { label: 'Shopify API', value: '2024-10' },
          ].map((item) => (
            <div key={item.label} className="flex items-center justify-between py-2 border-b border-blueprint-border/50 last:border-0">
              <span className="text-xs text-blueprint-muted">{item.label}</span>
              <span className="text-xs mono text-slate-300">{item.value}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Resources">
        <div className="space-y-2">
          <p className="text-xs text-blueprint-muted">
            Blueprint is a personal AI-powered business intelligence platform. It connects to your
            business data sources and uses AI agents to surface insights and propose improvements.
          </p>
          <div className="flex items-start gap-2 p-3 rounded bg-blueprint-blue/5 border border-blueprint-blue/20">
            <Info size={13} className="text-blueprint-blue flex-shrink-0 mt-0.5" />
            <p className="text-xs text-slate-300">
              Agent actions are always proposed first and require your approval (depending on trust tier settings).
              Blueprint never takes actions autonomously without your oversight.
            </p>
          </div>
        </div>
      </Section>
    </div>
  )
}

// ============================================
// Tab: Knowledge Base
// ============================================
function KBTab() {
  const currentBusiness = useStore((s) => s.currentBusiness) as Business | null
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const businessId = currentBusiness?.id

  const [settings, setSettings] = useState<KBSettingsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState('native')
  const [vaultPath, setVaultPath] = useState('')

  useEffect(() => {
    if (!businessId) { setLoading(false); return }
    getKbSettings(businessId)
      .then((data) => {
        const d = data as KBSettingsData
        setSettings(d)
        setMode(d.config?.mode ?? 'native')
        setVaultPath(d.config?.obsidian_vault_path ?? '')
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [businessId])

  async function handleSave() {
    if (!businessId) return
    setSaving(true)
    try {
      const payload: Record<string, string> = { mode }
      if (mode === 'obsidian') {
        if (!vaultPath) {
          addNotification({ type: 'error', message: 'Obsidian vault path is required.' })
          setSaving(false)
          return
        }
        payload.obsidian_vault_path = vaultPath
      }
      const result = await saveKbSettings(businessId, payload) as KBSettingsData
      setSettings({ ...settings, config: result.config })
      addNotification({ type: 'success', message: 'KB settings saved' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  async function handleReinit() {
    if (!businessId) return
    if (!confirm('Re-initialize the KB? Existing files are preserved; this just ensures the structure is in place.')) return
    try {
      await initKb(businessId)
      addNotification({ type: 'success', message: 'KB initialized' })
      const data = await getKbSettings(businessId) as KBSettingsData
      setSettings(data)
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    }
  }

  if (!businessId) {
    return <div className="text-xs text-blueprint-muted">Select a business to configure its KB.</div>
  }
  if (loading) {
    return <div className="text-xs text-blueprint-muted">Loading KB settings…</div>
  }

  return (
    <div className="space-y-4">
      <Section
        title="Knowledge Base Mode"
        description="Choose where this business's wiki lives. Both modes use the same Karpathy LLM Wiki engine."
      >
        <div className="space-y-3">
          {/* Native */}
          <label className={clsx(
            'block bp-card p-3 cursor-pointer transition-colors',
            mode === 'native' ? 'border-blueprint-blue/50' : 'hover:border-blueprint-border'
          )}>
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="kb-mode"
                value="native"
                checked={mode === 'native'}
                onChange={() => setMode('native')}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <BookOpen size={12} className="text-blueprint-blue" />
                  <span className="text-sm font-semibold text-slate-100">Blueprint Native</span>
                  {settings?.config?.mode === 'native' && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 uppercase tracking-wider">Active</span>
                  )}
                </div>
                <p className="text-xs text-blueprint-muted mt-1">
                  Fresh KB managed entirely by Blueprint. Stored at <code className="text-blueprint-muted/80">/kb/{currentBusiness?.slug}/</code>.
                  Git-backed, auto-committed on every save.
                </p>
              </div>
            </div>
          </label>

          {/* Obsidian */}
          <label className={clsx(
            'block bp-card p-3 cursor-pointer transition-colors',
            mode === 'obsidian' ? 'border-blueprint-purple/50' : 'hover:border-blueprint-border'
          )}>
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="kb-mode"
                value="obsidian"
                checked={mode === 'obsidian'}
                onChange={() => setMode('obsidian')}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <FolderOpen size={12} className="text-purple-400" />
                  <span className="text-sm font-semibold text-slate-100">Obsidian Vault</span>
                  {settings?.config?.mode === 'obsidian' && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 uppercase tracking-wider">Active</span>
                  )}
                </div>
                <p className="text-xs text-blueprint-muted mt-1">
                  Point Blueprint at an existing Obsidian vault. Blueprint creates a <code className="text-blueprint-muted/80">blueprint/</code> subfolder
                  inside the vault and operates within it. Your existing notes are not touched.
                </p>

                {mode === 'obsidian' && (
                  <div className="mt-3">
                    <label className="block text-xs text-blueprint-muted mb-1">Vault path</label>
                    <input
                      value={vaultPath}
                      onChange={(e) => setVaultPath(e.target.value)}
                      className="bp-input"
                      placeholder="/Users/you/Documents/ObsidianVault"
                    />
                    <p className="text-[10px] text-blueprint-muted mt-1">
                      Must contain a <code className="text-blueprint-muted/80">.obsidian/</code> directory.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </label>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={() => void handleReinit()} className="bp-btn bp-btn-secondary text-xs">
            <RefreshCw size={11} /> Re-initialize
          </button>
          <button onClick={() => void handleSave()} disabled={saving} className="bp-btn bp-btn-primary text-xs ml-auto">
            <Save size={11} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </Section>

      {settings?.config && (
        <Section title="Current Status">
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-blueprint-muted">Root path</span>
              <span className="text-slate-200 font-mono text-[10px]">{settings.config.root}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-blueprint-muted">Initialized</span>
              <span className="text-slate-200">{settings.config.initialized ? '✅' : '❌'}</span>
            </div>
            {settings.config.last_ingest && (
              <div className="flex justify-between">
                <span className="text-blueprint-muted">Last ingest</span>
                <span className="text-slate-200">{new Date(settings.config.last_ingest).toLocaleString()}</span>
              </div>
            )}
            {settings.config.last_lint && (
              <div className="flex justify-between">
                <span className="text-blueprint-muted">Last lint</span>
                <span className="text-slate-200">{new Date(settings.config.last_lint).toLocaleString()}</span>
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  )
}

// ============================================
// Tab: External Agents (BAP)
// ============================================
function IntegrationsTab() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [agents, setAgents] = useState<BapAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [auditLog, setAuditLog] = useState<BapCall[]>([])

  useEffect(() => {
    getBapAgents()
      .then((data) => setAgents((data as { agents?: BapAgent[] })?.agents ?? []))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  }, [])

  async function handleRevoke(agentId: string) {
    if (!confirm('Revoke this agent? Its API key will immediately stop working.')) return
    try {
      await revokeBapAgent(agentId)
      setAgents((prev) => prev.map((a) => a.id === agentId ? { ...a, status: 'revoked' } : a))
      addNotification({ type: 'success', message: 'Agent revoked' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    }
  }

  async function viewLog(agentId: string) {
    setSelectedAgent(agentId)
    try {
      const data = await getBapAudit(agentId, { limit: 50 }) as { calls?: BapCall[] }
      setAuditLog(data?.calls ?? [])
    } catch {
      setAuditLog([])
    }
  }

  if (loading) {
    return <div className="text-xs text-blueprint-muted">Loading external agents…</div>
  }

  return (
    <div className="space-y-4">
      <Section
        title="External Agents (BAP)"
        description="Agents connected via the Blueprint Agent Protocol. Any agent that speaks HTTP can register and participate."
      >
        <p className="text-xs text-blueprint-muted mb-3">
          To register a new agent, POST to <code className="text-blueprint-muted/80">/api/bap/v1/register</code>. See the AGENT-GUIDE.md in server/bap/ for details.
        </p>

        {agents.length === 0 ? (
          <div className="text-center py-8 text-blueprint-muted text-xs">
            No external agents registered yet.
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <div key={agent.id} className="bp-card p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Bot size={14} className="text-blueprint-blue flex-shrink-0" />
                    <span className="text-sm font-semibold text-slate-100">{agent.name}</span>
                    <span className={clsx(
                      'text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider',
                      agent.status === 'active' ? 'bg-green-500/20 text-green-400' :
                      agent.status === 'revoked' ? 'bg-red-500/20 text-red-400' :
                      'bg-yellow-500/20 text-yellow-400'
                    )}>
                      {agent.status}
                    </span>
                  </div>
                  {agent.status === 'active' && (
                    <button
                      onClick={() => void handleRevoke(agent.id)}
                      className="text-[10px] text-red-400 hover:text-red-300"
                    >
                      Revoke
                    </button>
                  )}
                </div>

                {agent.description && (
                  <p className="text-xs text-blueprint-muted mb-2">{agent.description}</p>
                )}

                <div className="grid grid-cols-2 gap-2 text-[10px] text-blueprint-muted">
                  <div>API Key: <span className="text-slate-300 font-mono">{agent.api_key_prefix}••••</span></div>
                  <div>Total calls: <span className="text-slate-300">{agent.total_calls?.toLocaleString()}</span></div>
                  <div>Last seen: <span className="text-slate-300">{agent.last_seen ? formatDistanceToNow(parseTimestamp(agent.last_seen) || new Date(), { addSuffix: true }) : 'never'}</span></div>
                  <div>Webhook: <span className="text-slate-300">{agent.webhook_url ? '✅ configured' : '—'}</span></div>
                  <div className="col-span-2">
                    Permissions: <span className="text-slate-300">
                      {(agent.permissions ?? []).join(', ') || '(none)'}
                    </span>
                  </div>
                </div>

                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => void viewLog(agent.id)}
                    className="text-[10px] text-blueprint-blue hover:text-blue-300"
                  >
                    View call log
                  </button>
                </div>

                {/* Inline call log */}
                {selectedAgent === agent.id && auditLog.length > 0 && (
                  <div className="mt-3 border-t border-blueprint-border pt-3">
                    <div className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-2">Recent API Calls</div>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {auditLog.map((call) => (
                        <div key={call.id} className="flex items-center gap-2 text-[10px] font-mono">
                          <span className={clsx(
                            'w-8',
                            call.status_code < 300 ? 'text-green-400' :
                            call.status_code < 400 ? 'text-yellow-400' : 'text-red-400'
                          )}>
                            {call.status_code}
                          </span>
                          <span className="text-blueprint-muted w-8">{call.method}</span>
                          <span className="text-slate-300 flex-1 truncate">{call.endpoint}</span>
                          <span className="text-blueprint-muted">{call.duration_ms}ms</span>
                          <span className="text-blueprint-muted">
                            {formatDistanceToNow(parseTimestamp(call.created_at) || new Date(), { addSuffix: true })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

// ============================================
function GoogleOAuthTab() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [config, setConfig] = useState<GoogleOAuthConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [secretChanged, setSecretChanged] = useState(false)

  useEffect(() => {
    getGoogleOAuthConfig()
      .then((c) => {
        const cfg = c as GoogleOAuthConfig
        setConfig(cfg)
        setClientId(cfg.client_id ?? '')
        setRedirectUri(cfg.redirect_uri ?? cfg.default_redirect_uri ?? '')
        setClientSecret('')
      })
      .catch((err) => addNotification({ type: 'error', message: 'Failed to load OAuth config: ' + (err as Error).message }))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      const body: Record<string, string> = {
        client_id: clientId.trim(),
        redirect_uri: redirectUri.trim(),
      }
      if (secretChanged) body.client_secret = clientSecret
      const updated = await saveGoogleOAuthConfig(body) as GoogleOAuthConfig
      setConfig(updated)
      setSecretChanged(false)
      setClientSecret('')
      addNotification({
        type: 'success',
        message: updated.configured
          ? 'Google OAuth configured. You can now connect Google connectors.'
          : 'Saved, but configuration is still incomplete.',
      })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="text-sm text-blueprint-muted">Loading…</div>
  }

  const configured = config?.configured
  const hasSecret = config?.has_secret

  return (
    <div className="space-y-6">
      <Section
        title="Google OAuth app credentials"
        description="Used to connect Google Search Console, Analytics 4, Business Profile, and Google Ads. You only set this up once — all Google connectors share these credentials."
      >
        {/* Status banner */}
        <div className={clsx(
          'p-3 rounded text-sm mb-4 border',
          configured
            ? 'bg-blueprint-green/10 border-blueprint-green/30 text-blueprint-green'
            : 'bg-blueprint-amber/10 border-blueprint-amber/30 text-blueprint-amber',
        )}>
          {configured ? (
            <span className="flex items-center gap-2"><Check size={14}/> Configured — Google connectors will work.</span>
          ) : (
            <span className="flex items-center gap-2"><Info size={14}/> Not yet configured. Follow the steps below.</span>
          )}
        </div>

        {/* Setup instructions */}
        <div className="p-3 rounded bg-blueprint-card border border-blueprint-border text-xs text-blueprint-muted leading-relaxed mb-4">
          <div className="text-slate-200 font-medium text-sm mb-2">How to create your OAuth client</div>
          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              Go to{' '}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blueprint-blue hover:underline"
              >Google Cloud Console → APIs &amp; Services → Credentials</a>
              {' '}(create a free project if you don't have one).
            </li>
            <li>Click <b>Create credentials → OAuth client ID</b>. Pick application type <b>Web application</b>.</li>
            <li>
              Under <b>Authorised redirect URIs</b>, add exactly:
              <div className="mt-1 p-2 rounded bg-blueprint-bg border border-blueprint-border font-mono text-xs text-slate-200 break-all select-all">
                {config?.default_redirect_uri || 'http://localhost:4000/api/oauth/google/callback'}
              </div>
            </li>
            <li>
              Enable the APIs you need:{' '}
              <a href="https://console.cloud.google.com/apis/library/searchconsole.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-blueprint-blue hover:underline">Search Console</a>,{' '}
              <a href="https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-blueprint-blue hover:underline">Analytics Data</a>,{' '}
              <a href="https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-blueprint-blue hover:underline">Business Profile</a>.
            </li>
            <li>Copy the <b>Client ID</b> and <b>Client Secret</b> Google gives you and paste them below.</li>
          </ol>
        </div>

        <Field label="Client ID" hint="Looks like 1234567890-abcdef.apps.googleusercontent.com">
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="123456789012-xxxxxxxxxxxxxxxxx.apps.googleusercontent.com"
            className="w-full px-3 py-2 bg-blueprint-card border border-blueprint-border rounded text-sm text-slate-200 font-mono placeholder-blueprint-muted focus:outline-none focus:border-blueprint-blue"
          />
        </Field>

        <Field
          label="Client Secret"
          hint={hasSecret && !secretChanged ? 'A secret is already saved. Leave blank to keep it.' : 'Starts with GOCSPX-'}
        >
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              value={clientSecret}
              onChange={(e) => { setClientSecret(e.target.value); setSecretChanged(true) }}
              placeholder={hasSecret && !secretChanged ? '••••••••••••••••' : 'GOCSPX-xxxxxxxxxxxxxxxxxx'}
              className="w-full px-3 py-2 pr-10 bg-blueprint-card border border-blueprint-border rounded text-sm text-slate-200 font-mono placeholder-blueprint-muted focus:outline-none focus:border-blueprint-blue"
            />
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-blueprint-muted hover:text-slate-200"
              tabIndex={-1}
            >
              {showSecret ? <EyeOff size={14}/> : <Eye size={14}/>}
            </button>
          </div>
        </Field>

        <Field
          label="Redirect URI"
          hint="Must match exactly what you entered in Google Cloud Console."
        >
          <input
            type="text"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder={config?.default_redirect_uri || 'http://localhost:4000/api/oauth/google/callback'}
            className="w-full px-3 py-2 bg-blueprint-card border border-blueprint-border rounded text-sm text-slate-200 font-mono placeholder-blueprint-muted focus:outline-none focus:border-blueprint-blue"
          />
        </Field>

        <div className="flex items-center gap-2 mt-4">
          <button
            onClick={() => void handleSave()}
            disabled={saving || !clientId.trim() || (!hasSecret && !clientSecret.trim())}
            className="px-4 py-2 bg-blueprint-blue text-white text-sm rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? <RefreshCw size={14} className="animate-spin"/> : <Save size={14}/>}
            Save
          </button>
          {config?.source && (
            <span className="text-xs text-blueprint-muted">
              Loading from: {config.source.client_id}/{config.source.client_secret}/{config.source.redirect_uri}
            </span>
          )}
        </div>
      </Section>
    </div>
  )
}

// ============================================
// Tab: Approval Policies
// ============================================
const APPROVAL_ACTION_TYPES = [
  { id: 'hire_agent',                  label: 'Hire agent',          desc: 'Conductor proposes installing a specialist agent' },
  { id: 'investigation',               label: 'Investigation',       desc: 'Run a deep diagnostic on a metric or signal' },
  { id: 'content_draft',               label: 'Content draft',       desc: 'Quill produces a draft article or page' },
  { id: 'github_issue',                label: 'GitHub issue',        desc: 'Dev opens a new issue in your repo' },
  { id: 'github_pr',                   label: 'GitHub PR',           desc: 'Dev opens a draft pull request' },
  { id: 'shopify_product_create',      label: 'Shopify product create', desc: 'Merchant creates a new draft product' },
  { id: 'shopify_product_update',      label: 'Shopify product update', desc: 'Merchant edits an existing product' },
  { id: 'shopify_description_update',  label: 'Shopify description', desc: 'Update product/page description' },
  { id: 'shopify_meta_update',         label: 'Shopify meta tags',   desc: 'Update SEO meta on a page or product' },
  { id: 'shopify_collection_update',   label: 'Shopify collection',  desc: 'Edit a collection (rename, products, image)' },
  { id: 'shopify_tag_update',          label: 'Shopify tags',        desc: 'Add or remove product tags' },
  { id: 'shopify_page_create',         label: 'Shopify page create', desc: 'Create a new shop page' },
  { id: 'shopify_page_update',         label: 'Shopify page update', desc: 'Edit an existing shop page' },
  { id: 'shopify_blog_post_create',    label: 'Shopify blog post',   desc: 'Publish a new blog article' },
]

function ApprovalsTab() {
  const addNotification = useStore((s) => s.addNotification) as (n: { type: string; message: string }) => void
  const [policies, setPolicies] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getApprovalPolicies()
      .then((data) => setPolicies((data as { policies?: Record<string, string> })?.policies || {}))
      .catch((err) => addNotification({ type: 'error', message: (err as Error).message }))
      .finally(() => setLoading(false))
  }, [])

  function setPolicy(actionType: string, value: string) {
    setPolicies((prev) => {
      const next = { ...prev }
      if (value === 'inherit') {
        delete next[actionType]
      } else {
        next[actionType] = value
      }
      return next
    })
  }

  async function handleSave() {
    setSaving(true)
    try {
      await saveApprovalPolicies(policies)
      addNotification({ type: 'success', message: 'Approval policies saved' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-sm text-blueprint-muted">Loading…</div>

  return (
    <div className="space-y-4">
      <Section
        title="Default policy"
        description="Used for any action type that doesn't have its own policy below."
      >
        <Field label="When an agent proposes a task">
          <select
            value={policies['default'] || 'manual'}
            onChange={(e) => setPolicy('default', e.target.value)}
            className="bp-input bp-select w-full"
          >
            <option value="manual">Always require my approval (recommended)</option>
            <option value="auto">Auto-approve everything</option>
          </select>
        </Field>
      </Section>

      <Section
        title="Per-action overrides"
        description="Override the default for specific action types. Leave on 'Use default' to keep things simple."
      >
        <div className="space-y-2">
          {APPROVAL_ACTION_TYPES.map((a) => (
            <div key={a.id} className="bp-card p-3 flex items-center gap-3">
              <div className="flex-1">
                <div className="text-sm text-slate-200">{a.label}</div>
                <div className="text-[11px] text-blueprint-muted">{a.desc}</div>
              </div>
              <select
                value={policies[a.id] || 'inherit'}
                onChange={(e) => setPolicy(a.id, e.target.value)}
                className="bp-input bp-select"
                style={{ width: 180 }}
              >
                <option value="inherit">Use default ({(policies['default'] || 'manual') === 'auto' ? 'auto' : 'approve'})</option>
                <option value="auto">Auto-approve</option>
                <option value="manual">Require approval</option>
              </select>
            </div>
          ))}
        </div>

        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="bp-btn bp-btn-primary text-xs mt-4"
        >
          <Save size={12} />
          {saving ? 'Saving…' : 'Save policies'}
        </button>
      </Section>
    </div>
  )
}

// ============================================
// Tab: Security (prompt injection defence)
// ============================================
function SecurityTab() {
  const [status, setStatus] = useState<SecurityStatus | null>(null)
  const [allowlist, setAllowlist] = useState<AllowlistData | null>(null)
  const [events, setEvents] = useState<SecurityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [newHost, setNewHost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [s, a, e] = await Promise.all([
        getSecurityStatus() as Promise<SecurityStatus>,
        getSecurityAllowlist() as Promise<AllowlistData>,
        (getSecurityEvents({ limit: 25 }) as Promise<{ events?: SecurityEvent[] }>).catch(() => ({ events: [] as SecurityEvent[] })),
      ])
      setStatus(s)
      setAllowlist(a)
      setEvents(e.events || [])
    } catch (err) {
      setError((err as Error).message || 'Failed to load security status')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function handleAddHost() {
    const host = newHost.trim().toLowerCase()
    if (!host) return
    setBusy(true)
    try {
      await addSecurityAllowlist(host)
      setNewHost('')
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally { setBusy(false) }
  }

  async function handleRemoveHost(host: string) {
    if (!window.confirm(`Remove ${host} from the allowlist? Outbound calls to this host will be blocked.`)) return
    setBusy(true)
    try {
      await removeSecurityAllowlist(host)
      await load()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  async function handleEnforcementToggle(enabled: boolean) {
    if (!enabled && !window.confirm('Disabling outbound enforcement removes a critical safety layer. Continue?')) return
    setBusy(true)
    try {
      await setSecurityEnforcement(enabled)
      await load()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  async function handleLayerToggle(key: string, enabled: boolean) {
    if (!enabled && !window.confirm('Disabling a security layer is not recommended. Continue?')) return
    setBusy(true)
    try {
      await toggleSecurityLayer(key, enabled)
      await load()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  if (loading) return <div className="text-xs text-blueprint-muted">Loading security status…</div>
  if (error) return <div className="text-xs text-red-400">{error}</div>
  if (!status) return null

  const layer = (key: keyof NonNullable<SecurityStatus['layers']>, label: string) => {
    const cfg = status.layers?.[key]
    const active = !!cfg?.active
    return (
      <div className="flex items-center justify-between py-2 border-b border-blueprint-border last:border-0">
        <div className="flex items-center gap-2">
          <span className={clsx('inline-block w-2 h-2 rounded-full', active ? 'bg-green-500' : 'bg-red-500')} />
          <span className="text-xs text-slate-200">{label}</span>
        </div>
        <span className="text-xs text-blueprint-muted">{active ? 'Active' : 'Disabled'}</span>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Section
        title="Prompt injection defence"
        description="Layered protection against malicious content injected via search results, connector data, or user-generated text."
      >
        <div className="space-y-0">
          {layer('outbound_allowlist', `Outbound allowlist (${status.layers?.outbound_allowlist?.allowed_count ?? 0} hosts)`)}
          {layer('content_sanitisation', 'Content sanitisation')}
          {layer('kb_access_scoping', 'KB sensitive-data scanning')}
          {layer('output_monitoring', 'Anomalous output monitoring')}
        </div>

        <div className="grid grid-cols-3 gap-3 mt-4">
          <Stat label="Outbound blocked (30d)" value={status.stats?.outbound_blocked_30d ?? 0} />
          <Stat label="Injections detected (30d)" value={status.stats?.injections_detected_30d ?? 0} />
          <Stat label="Outputs blocked (30d)" value={status.stats?.anomalous_outputs_blocked_30d ?? 0} />
        </div>
      </Section>

      <Section
        title="Outbound allowlist"
        description="Agents can only make outbound HTTP calls to these hostnames. Prevents exfiltration even if an LLM is tricked into attempting one."
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-slate-300">
            Enforcement: <strong className={allowlist?.enforcement ? 'text-green-400' : 'text-red-400'}>
              {allowlist?.enforcement ? 'ON' : 'OFF'}
            </strong>
          </div>
          <button
            onClick={() => void handleEnforcementToggle(!allowlist?.enforcement)}
            disabled={busy}
            className="bp-btn text-xs"
          >
            {allowlist?.enforcement ? 'Disable enforcement' : 'Enable enforcement'}
          </button>
        </div>

        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={newHost}
            onChange={(e) => setNewHost(e.target.value)}
            placeholder="api.example.com"
            className="bp-input flex-1 text-xs"
          />
          <button onClick={() => void handleAddHost()} disabled={busy || !newHost} className="bp-btn bp-btn-primary text-xs">
            <Plus size={12} /> Add
          </button>
        </div>
        <p className="text-xs text-blueprint-muted mb-3">
          Only add domains for APIs you explicitly trust.
        </p>

        <div className="max-h-64 overflow-y-auto border border-blueprint-border rounded">
          {(allowlist?.allowed ?? []).map(({ host, source }) => (
            <div key={host} className="flex items-center justify-between px-3 py-1.5 border-b border-blueprint-border last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-slate-200">{host}</span>
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded',
                  source === 'default' ? 'bg-blueprint-border text-blueprint-muted' : 'bg-green-900/30 text-green-400')}>
                  {source}
                </span>
              </div>
              {source === 'custom' && (
                <button
                  onClick={() => void handleRemoveHost(host)}
                  disabled={busy}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Security layers"
        description="Individual layers can be toggled if you need to investigate a false positive. All should be on in production."
      >
        <div className="space-y-2">
          <LayerToggle
            label="Content sanitisation"
            description="Strips injection patterns from search results and connector data before they reach the LLM."
            enabled={!!status.layers?.content_sanitisation?.active}
            onChange={(e) => void handleLayerToggle('security_sanitisation_enabled', e)}
            disabled={busy}
          />
          <LayerToggle
            label="KB sensitive-data scanning"
            description="Blocks API keys, passwords, and tokens from being written to the knowledge base."
            enabled={!!status.layers?.kb_access_scoping?.active}
            onChange={(e) => void handleLayerToggle('security_kb_scan_enabled', e)}
            disabled={busy}
          />
          <LayerToggle
            label="Anomalous output monitoring"
            description="Blocks agent runs whose output contains unexpected URLs, credentials, or exfiltration verbiage."
            enabled={!!status.layers?.output_monitoring?.active}
            onChange={(e) => void handleLayerToggle('security_output_monitor_enabled', e)}
            disabled={busy}
          />
        </div>
      </Section>

      <Section
        title="Recent security events"
        description="Last 25 security signals. Dismiss from the Signals page."
      >
        {events.length === 0 ? (
          <div className="text-xs text-blueprint-muted">None ✅ No security events detected.</div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-blueprint-muted">
                <tr>
                  <th className="text-left py-1 px-1">When</th>
                  <th className="text-left py-1 px-1">Rule</th>
                  <th className="text-left py-1 px-1">Title</th>
                  <th className="text-left py-1 px-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} className="border-t border-blueprint-border">
                    <td className="py-1 px-1 text-blueprint-muted whitespace-nowrap">
                      {formatDistanceToNow(parseTimestamp(ev.created_at) ?? new Date(), { addSuffix: true })}
                    </td>
                    <td className="py-1 px-1 font-mono text-slate-300">{(ev.rule_id || '').replace('security:', '')}</td>
                    <td className="py-1 px-1 text-slate-200">{ev.title}</td>
                    <td className="py-1 px-1">
                      <span className={clsx('px-1.5 py-0.5 rounded text-[10px]',
                        ev.status === 'open' ? 'bg-red-900/30 text-red-400' : 'bg-blueprint-border text-blueprint-muted')}>
                        {ev.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bp-card p-3">
      <div className="text-[10px] text-blueprint-muted uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold text-slate-100 mt-0.5">{value}</div>
    </div>
  )
}

interface LayerToggleProps {
  label: string
  description: string
  enabled: boolean
  onChange: (value: boolean) => void
  disabled: boolean
}

function LayerToggle({ label, description, enabled, onChange, disabled }: LayerToggleProps) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div>
        <div className="text-xs font-medium text-slate-200">{label}</div>
        <div className="text-xs text-blueprint-muted">{description}</div>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        disabled={disabled}
        className={clsx('bp-btn text-xs whitespace-nowrap',
          enabled ? 'bp-btn-primary' : '')}
      >
        {enabled ? 'On' : 'Off'}
      </button>
    </div>
  )
}

// ============================================
// Settings Page
// ============================================
function Settings() {
  const [activeTab, setActiveTab] = useState('business')

  const TAB_CONTENT: Record<string, React.ReactNode> = {
    business:      <BusinessTab />,
    notifications: <NotificationsTab />,
    llm:           <LLMTab />,
    oauth:         <GoogleOAuthTab />,
    kb:            <KBTab />,
    agents:        <AgentDefaultsTab />,
    approvals:     <ApprovalsTab />,
    integrations:  <IntegrationsTab />,
    data:          <DataTab />,
    security:      <SecurityTab />,
    system:        <SystemTab />,
    about:         <AboutTab />,
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
        <p className="text-sm text-blueprint-muted">Configure Blueprint for your workspace</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 mb-6 bg-blueprint-card border border-blueprint-border rounded p-1 flex-wrap">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              'px-3 py-1.5 rounded text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'bg-blueprint-border text-slate-100'
                : 'text-blueprint-muted hover:text-slate-200'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="animate-fade-in">
        {TAB_CONTENT[activeTab]}
      </div>
    </div>
  )
}

export default Settings
