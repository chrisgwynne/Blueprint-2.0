import React, { useState, useEffect, useRef } from 'react'
import { Save, Eye, EyeOff, Send, Download, Upload, Info, Plus, Trash2, Check, X, Building2, Image, BookOpen, FolderOpen, RefreshCw, Bot, ExternalLink, Shield } from 'lucide-react'
import clsx from 'clsx'
import useStore from '../lib/store.js'
import { updateBusiness, createBusiness, getBusinesses, getKbSettings, saveKbSettings, initKb, getBapAgents, revokeBapAgent, getBapAudit } from '../lib/api.js'
import { formatDistanceToNow } from 'date-fns'

const TABS = [
  { id: 'business',  label: 'Business Profile' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'llm',       label: 'LLM Providers' },
  { id: 'kb',        label: 'Knowledge Base' },
  { id: 'agents',    label: 'Agent Defaults' },
  { id: 'integrations', label: 'External Agents' },
  { id: 'data',      label: 'Data' },
  { id: 'system',    label: 'System' },
  { id: 'about',     label: 'About' },
]

function Section({ title, description, children }) {
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

function Field({ label, hint, children }) {
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
function BusinessTab() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)
  const businesses = useStore((s) => s.businesses)
  const setBusinesses = useStore((s) => s.setBusinesses)
  const [form, setForm] = useState({
    name: currentBusiness?.name || '',
    type: currentBusiness?.type || '',
    description: currentBusiness?.description || '',
    slug: currentBusiness?.slug || '',
    website: currentBusiness?.settings?.website || '',
  })
  const [logoPreview, setLogoPreview] = useState(currentBusiness?.settings?.logo || null)
  const [saving, setSaving] = useState(false)
  const [showNewBusiness, setShowNewBusiness] = useState(false)
  const [newBizForm, setNewBizForm] = useState({ name: '', type: '' })
  const [creating, setCreating] = useState(false)
  const logoInputRef = useRef(null)
  const addNotification = useStore((s) => s.addNotification)

  // Sync form when business changes
  useEffect(() => {
    if (!currentBusiness) return
    setForm({
      name: currentBusiness.name || '',
      type: currentBusiness.type || '',
      description: currentBusiness.description || '',
      slug: currentBusiness.slug || '',
      website: currentBusiness.settings?.website || '',
    })
    setLogoPreview(currentBusiness.settings?.logo || null)
  }, [currentBusiness?.id])

  function handleLogoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      setLogoPreview(ev.target.result)
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
      })
      setCurrentBusiness(updated)
      // Also update in businesses list
      setBusinesses(businesses.map(b => b.id === updated.id ? updated : b))
      addNotification({ type: 'success', message: 'Business profile saved' })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleCreateBusiness() {
    if (!newBizForm.name.trim()) return
    setCreating(true)
    try {
      const created = await createBusiness({ name: newBizForm.name.trim(), type: newBizForm.type || null })
      const updated = await getBusinesses()
      setBusinesses(updated)
      setCurrentBusiness(created)
      setShowNewBusiness(false)
      setNewBizForm({ name: '', type: '' })
      addNotification({ type: 'success', message: `Business "${created.name}" created` })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Business Switcher */}
      {businesses.length > 0 && (
        <Section title="Your Businesses" description="Switch between businesses or add a new one">
          <div className="space-y-2">
            {businesses.map((biz) => (
              <button
                key={biz.id}
                onClick={() => setCurrentBusiness(biz)}
                className={clsx(
                  'w-full flex items-center gap-3 p-3 rounded border text-left transition-colors',
                  currentBusiness?.id === biz.id
                    ? 'border-blueprint-blue/40 bg-blueprint-blue/5'
                    : 'border-blueprint-border hover:border-blueprint-blue/20'
                )}
              >
                {biz.settings?.logo ? (
                  <img src={biz.settings.logo} alt="" className="w-7 h-7 rounded object-cover flex-shrink-0" />
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
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateBusiness()}
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
                <button onClick={handleCreateBusiness} disabled={creating || !newBizForm.name.trim()} className="bp-btn bp-btn-primary text-xs">
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
        <button onClick={handleSave} disabled={saving} className="bp-btn bp-btn-primary text-xs">
          <Save size={13} />
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </Section>
    </div>
  )
}

// ============================================
// Tab: Notifications
// ============================================
function NotificationsTab() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)
  const addNotification = useStore((s) => s.addNotification)
  const [botToken, setBotToken] = useState(() => currentBusiness?.settings?.telegram?.botToken || '')
  const [chatId, setChatId] = useState(() => currentBusiness?.settings?.telegram?.chatId || '')
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
      const data = await res.json()
      if (data.ok) {
        addNotification({ type: 'success', title: 'Test sent!', message: 'Check your Telegram' })
      } else {
        addNotification({ type: 'error', message: data.description || 'Telegram error' })
      }
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
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
      })
      setCurrentBusiness(updated)
      addNotification({ type: 'success', message: 'Telegram settings saved — bot will start polling shortly' })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
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
          <button onClick={handleSave} disabled={saving} className="bp-btn bp-btn-primary text-xs">
            <Save size={12} />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={handleTest} disabled={testing || !botToken || !chatId} className="bp-btn bp-btn-secondary text-xs">
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

// ─── Email reports (Feature 5) ────────────────────────────────────────────────
function EmailReportsSection() {
  const addNotification = useStore((s) => s.addNotification)
  const [provider, setProvider] = useState('smtp')
  const [recipient, setRecipient] = useState('')
  const [config, setConfig] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sendingTest, setSendingTest] = useState(false)

  useEffect(() => {
    import('../lib/api.js').then(({ getEmailSettings }) =>
      getEmailSettings().then((data) => {
        if (data) {
          setProvider(data.provider ?? 'smtp')
          setRecipient(data.recipient ?? '')
          setConfig(data.config ?? {})
        }
      }).catch(() => {}).finally(() => setLoading(false))
    )
  }, [])

  function updateConfig(key, value) {
    setConfig((c) => ({ ...c, [key]: value }))
  }

  async function handleSave() {
    setSaving(true)
    try {
      const { saveEmailSettings } = await import('../lib/api.js')
      await saveEmailSettings({ provider, recipient, config })
      addNotification({ type: 'success', message: 'Email settings saved' })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally { setSaving(false) }
  }

  async function handleTest() {
    setSendingTest(true)
    try {
      const { sendTestEmail } = await import('../lib/api.js')
      await sendTestEmail({ to: recipient })
      addNotification({ type: 'success', message: `Test email sent to ${recipient}` })
    } catch (err) {
      addNotification({ type: 'error', message: `Test failed: ${err.message}` })
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
        <button onClick={handleSave} disabled={saving} className="bp-btn bp-btn-primary text-xs">
          <Save size={12} />
          {saving ? 'Saving…' : 'Save email settings'}
        </button>
        <button onClick={handleTest} disabled={sendingTest || !recipient} className="bp-btn bp-btn-secondary text-xs">
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

const PROVIDER_TEMPLATES = [
  { type: 'claude-cli',  label: 'Claude CLI',  placeholder: null,             hasKey: false, hasBase: false, models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { type: 'anthropic',   label: 'Anthropic',   placeholder: 'sk-ant-...',     hasKey: true,  hasBase: false, models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { type: 'openai',      label: 'OpenAI',      placeholder: 'sk-...',         hasKey: true,  hasBase: true,  models: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'] },
  { type: 'gemini',      label: 'Gemini',      placeholder: 'AIza...',        hasKey: true,  hasBase: false, models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'] },
  { type: 'ollama',      label: 'Ollama',      placeholder: null,             hasKey: false, hasBase: true,  models: [] },
  { type: 'kimi',        label: 'Kimi',        placeholder: 'sk-...',         hasKey: true,  hasBase: false, models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { type: 'minimax',     label: 'MiniMax',     placeholder: 'Bearer ...',     hasKey: true,  hasBase: false, models: ['abab6.5s-chat', 'abab6.5g-chat'] },
  { type: 'custom',      label: 'Custom',      placeholder: 'API key...',     hasKey: true,  hasBase: true,  models: [] },
]

function ProviderCard({ provider, isDefault, onUpdate, onDelete, onSetDefault }) {
  const tmpl = PROVIDER_TEMPLATES.find((t) => t.type === provider.type) || PROVIDER_TEMPLATES[7]
  const [showKey, setShowKey] = useState(false)

  return (
    <div className={clsx(
      'p-4 rounded border space-y-3',
      isDefault ? 'border-blueprint-blue/40 bg-blueprint-blue/5' : 'border-blueprint-border'
    )}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-200">{provider.label || tmpl.label}</span>
          {isDefault && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blueprint-blue/20 text-blueprint-blue font-medium">default</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isDefault && (
            <button
              onClick={onSetDefault}
              className="text-xs text-blueprint-muted hover:text-blueprint-blue px-2 py-1 rounded transition-colors"
            >
              Set default
            </button>
          )}
          <button onClick={onDelete} className="text-blueprint-muted hover:text-red-400 p-1 transition-colors">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {provider.type === 'claude-cli' && (
        <p className="text-xs text-blueprint-muted">
          Uses the local <code className="mono bg-blueprint-bg px-1 rounded">claude</code> CLI — no API key required.
          Make sure Claude Code is installed and authenticated.
        </p>
      )}

      {tmpl.hasKey && (
        <Field label="API Key">
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={provider.apiKey || ''}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
              className="bp-input pr-10"
              placeholder={tmpl.placeholder}
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-blueprint-muted hover:text-slate-200"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>
      )}

      {tmpl.hasBase && (
        <Field label={provider.type === 'ollama' ? 'Base URL' : 'Base URL (optional)'} hint={provider.type === 'ollama' ? 'e.g. http://localhost:11434' : 'Override default endpoint'}>
          <input
            value={provider.baseUrl || ''}
            onChange={(e) => onUpdate({ baseUrl: e.target.value })}
            className="bp-input"
            placeholder={provider.type === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com/v1'}
          />
        </Field>
      )}

      <Field label="Model">
        {tmpl.models.length > 0 ? (
          <select
            value={provider.model || tmpl.models[0]}
            onChange={(e) => onUpdate({ model: e.target.value })}
            className="bp-select w-full"
          >
            {tmpl.models.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value="__custom">Custom…</option>
          </select>
        ) : (
          <input
            value={provider.model || ''}
            onChange={(e) => onUpdate({ model: e.target.value })}
            className="bp-input"
            placeholder="e.g. llama3.2, mistral"
          />
        )}
        {provider.model === '__custom' && (
          <input
            value={provider.customModel || ''}
            onChange={(e) => onUpdate({ customModel: e.target.value, model: '__custom' })}
            className="bp-input mt-1"
            placeholder="Enter model ID"
          />
        )}
      </Field>
    </div>
  )
}

function LLMTab() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)
  const addNotification = useStore((s) => s.addNotification)
  const [saving, setSaving] = useState(false)

  const [providers, setProviders] = useState(() => {
    const saved = currentBusiness?.settings?.llm?.providers
    return saved || [{ id: 'default', type: 'claude-cli', label: 'Claude CLI' }]
  })
  const [defaultId, setDefaultId] = useState(() => {
    return currentBusiness?.settings?.llm?.defaultId || 'default'
  })
  const [showAddMenu, setShowAddMenu] = useState(false)

  function addProvider(type) {
    const tmpl = PROVIDER_TEMPLATES.find((t) => t.type === type)
    const id = `${type}_${Date.now()}`
    setProviders((prev) => [...prev, { id, type, label: tmpl.label, model: tmpl.models[0] || '' }])
    setShowAddMenu(false)
  }

  function updateProvider(id, patch) {
    setProviders((prev) => prev.map((p) => p.id === id ? { ...p, ...patch } : p))
  }

  function deleteProvider(id) {
    setProviders((prev) => {
      const next = prev.filter((p) => p.id !== id)
      if (defaultId === id && next.length > 0) setDefaultId(next[0].id)
      return next
    })
  }

  async function handleSave() {
    if (!currentBusiness?.id) return
    setSaving(true)
    try {
      const updated = await updateBusiness(currentBusiness.id, {
        settings: { ...currentBusiness.settings, llm: { providers, defaultId } },
      })
      setCurrentBusiness(updated)
      addNotification({ type: 'success', message: 'LLM settings saved' })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Section title="LLM Providers" description="Configure AI providers used by Blueprint agents">
        <div className="space-y-3">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              isDefault={p.id === defaultId}
              onUpdate={(patch) => updateProvider(p.id, patch)}
              onDelete={() => deleteProvider(p.id)}
              onSetDefault={() => setDefaultId(p.id)}
            />
          ))}
        </div>

        <div className="relative">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="bp-btn bp-btn-secondary text-xs w-full"
          >
            <Plus size={13} />
            Add Provider
          </button>
          {showAddMenu && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-blueprint-card border border-blueprint-border rounded shadow-lg z-10 py-1">
              {PROVIDER_TEMPLATES.map((t) => (
                <button
                  key={t.type}
                  onClick={() => addProvider(t.type)}
                  className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-blueprint-border transition-colors"
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button onClick={handleSave} disabled={saving} className="bp-btn bp-btn-primary text-xs">
          <Save size={12} />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </Section>
    </div>
  )
}

// ============================================
// Tab: Agent Defaults
// ============================================
function AgentDefaultsTab() {
  const addNotification = useStore((s) => s.addNotification)
  const [form, setForm] = useState({
    global_cost_cap: '5.00',
    default_trust_tier: 'medium',
    auto_approve_high_trust: false,
    notify_on_propose: true,
    notify_on_complete: true,
  })

  return (
    <div className="space-y-4">
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
          {[
            { key: 'notify_on_propose', label: 'Notify when task is proposed' },
            { key: 'notify_on_complete', label: 'Notify when task completes' },
          ].map((item) => (
            <label key={item.key} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form[item.key]}
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
  const addNotification = useStore((s) => s.addNotification)
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [retentionDays, setRetentionDays] = useState(90)

  function handleExport() {
    addNotification({ type: 'info', message: 'Preparing data export...' })
    // Would trigger /api/export endpoint
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
  const addNotification = useStore((s) => s.addNotification)
  const [reiniting, setReiniting] = useState(false)
  const [health, setHealth] = useState(null)

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => {})
  }, [])

  async function handleReinit() {
    if (!confirm('Re-run database init? This is safe to run multiple times — it will not delete existing data.')) return
    setReiniting(true)
    try {
      const res = await fetch('/api/system/db-init', { method: 'POST', credentials: 'include' })
      if (res.ok) {
        addNotification({ type: 'success', message: 'Database init complete' })
      } else {
        const d = await res.json()
        addNotification({ type: 'error', message: d.error || 'Init failed' })
      }
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setReiniting(false)
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
            onClick={handleReinit}
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
            { label: 'Build', value: import.meta.env.VITE_BUILD_ID || 'development' },
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
  const currentBusiness = useStore((s) => s.currentBusiness)
  const addNotification = useStore((s) => s.addNotification)
  const businessId = currentBusiness?.id

  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState('native')
  const [vaultPath, setVaultPath] = useState('')

  useEffect(() => {
    if (!businessId) { setLoading(false); return }
    getKbSettings(businessId)
      .then((data) => {
        setSettings(data)
        setMode(data.config?.mode ?? 'native')
        setVaultPath(data.config?.obsidian_vault_path ?? '')
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [businessId])

  async function handleSave() {
    if (!businessId) return
    setSaving(true)
    try {
      const payload = { mode }
      if (mode === 'obsidian') {
        if (!vaultPath) {
          addNotification({ type: 'error', message: 'Obsidian vault path is required.' })
          setSaving(false)
          return
        }
        payload.obsidian_vault_path = vaultPath
      }
      const result = await saveKbSettings(businessId, payload)
      setSettings({ ...settings, config: result.config })
      addNotification({ type: 'success', message: 'KB settings saved' })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
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
      const data = await getKbSettings(businessId)
      setSettings(data)
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
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
          <button onClick={handleReinit} className="bp-btn bp-btn-secondary text-xs">
            <RefreshCw size={11} /> Re-initialize
          </button>
          <button onClick={handleSave} disabled={saving} className="bp-btn bp-btn-primary text-xs ml-auto">
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
// Settings Page
// ============================================
// Tab: External Agents (BAP)
// ============================================
function IntegrationsTab() {
  const addNotification = useStore((s) => s.addNotification)
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [auditLog, setAuditLog] = useState([])

  useEffect(() => {
    getBapAgents()
      .then((data) => setAgents(data?.agents ?? []))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  }, [])

  async function handleRevoke(agentId) {
    if (!confirm('Revoke this agent? Its API key will immediately stop working.')) return
    try {
      await revokeBapAgent(agentId)
      setAgents((prev) => prev.map((a) => a.id === agentId ? { ...a, status: 'revoked' } : a))
      addNotification({ type: 'success', message: 'Agent revoked' })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    }
  }

  async function viewLog(agentId) {
    setSelectedAgent(agentId)
    try {
      const data = await getBapAudit(agentId, { limit: 50 })
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
                      onClick={() => handleRevoke(agent.id)}
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
                  <div>Last seen: <span className="text-slate-300">{agent.last_seen ? formatDistanceToNow(new Date(agent.last_seen), { addSuffix: true }) : 'never'}</span></div>
                  <div>Webhook: <span className="text-slate-300">{agent.webhook_url ? '✅ configured' : '—'}</span></div>
                  <div className="col-span-2">
                    Permissions: <span className="text-slate-300">
                      {(agent.permissions ?? []).join(', ') || '(none)'}
                    </span>
                  </div>
                </div>

                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => viewLog(agent.id)}
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
                            {formatDistanceToNow(new Date(call.created_at), { addSuffix: true })}
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
function Settings() {
  const [activeTab, setActiveTab] = useState('business')

  const TAB_CONTENT = {
    business:      <BusinessTab />,
    notifications: <NotificationsTab />,
    llm:           <LLMTab />,
    kb:            <KBTab />,
    agents:        <AgentDefaultsTab />,
    integrations:  <IntegrationsTab />,
    data:          <DataTab />,
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
