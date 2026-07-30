import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, CheckCircle, XCircle, RefreshCw, ExternalLink,
  Upload, Send, Clock, X, Check, ChevronDown,
} from 'lucide-react'
import clsx from 'clsx'
import useStore from '../lib/store'
import {
  getSocialPreflight,
  getSocialCapabilities,
  getSocialAccounts,
  discoverSocialAccounts,
  bindSocialAccount,
  getSocialPolicy,
  updateSocialPolicy,
  getSocialPosts,
  createSocialDraft,
  approveSocialPost,
  cancelSocialPost,
  publishSocialPost,
  uploadSocialMedia,
} from '../lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PreflightItem {
  key: string
  label: string
  ok: boolean
  message?: string
}

interface Capability {
  platform: string
  contentType: string
  supported: boolean
  notes?: string
}

interface BoundAccount {
  connectorId: string
  facebookPageId?: string
  facebookPageName?: string
  instagramAccountId?: string
  instagramUsername?: string
}

interface DiscoveredPage {
  facebookPageId: string
  facebookPageName: string
  instagram?: { id: string; username: string }
}

interface SocialPost {
  id: string
  platform: string
  contentType: string
  targetId: string
  caption: string
  mediaUrls: string[]
  scheduledAt?: string
  status: string
  publishedAt?: string
  errorMessage?: string
  createdAt: string
}

interface SocialPolicy {
  connectorId: string
  mode: string
  maxDailyPosts: number
}

interface StagedMedia {
  token: string
  filename: string
  url?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { label: string; classes: string }> = {
  draft:      { label: 'Draft',      classes: 'bg-slate-700 text-slate-300' },
  approved:   { label: 'Approved',   classes: 'bg-blueprint-blue/20 text-blueprint-blue' },
  published:  { label: 'Published',  classes: 'bg-blueprint-green/20 text-blueprint-green' },
  failed:     { label: 'Failed',     classes: 'bg-blueprint-red/20 text-blueprint-red' },
  cancelled:  { label: 'Cancelled',  classes: 'bg-slate-700 text-slate-400' },
  publishing: { label: 'Publishing', classes: 'bg-yellow-500/20 text-yellow-400' },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_BADGE[status] ?? { label: status, classes: 'bg-slate-700 text-slate-300' }
  return (
    <span className={clsx('inline-block px-2 py-0.5 rounded text-[10px] font-medium', cfg.classes)}>
      {cfg.label}
    </span>
  )
}

function PreflightIcon({ ok, warn }: { ok: boolean; warn?: boolean }) {
  if (ok) return <CheckCircle size={14} className="text-blueprint-green flex-shrink-0" />
  if (warn) return <AlertTriangle size={14} className="text-yellow-400 flex-shrink-0" />
  return <XCircle size={14} className="text-blueprint-red flex-shrink-0" />
}

function fmt(iso?: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

// ─── Section shell ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bp-card p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-blueprint-muted mb-4">{title}</h2>
      {children}
    </div>
  )
}

// ─── Preflight Section ────────────────────────────────────────────────────────

interface PreflightSectionProps {
  bizId: string
}

function PreflightSection({ bizId }: PreflightSectionProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [items, setItems] = useState<PreflightItem[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getSocialPreflight(bizId)
      setItems(data?.checks ?? [])
    } catch (e) {
      addNotification({ type: 'error', message: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }, [bizId, addNotification])

  useEffect(() => { load() }, [load])

  return (
    <Section title="Configuration Health">
      <div className="flex justify-end mb-3">
        <button
          onClick={load}
          disabled={loading}
          className="bp-btn bp-btn-secondary text-xs"
          aria-label="Refresh preflight"
        >
          <RefreshCw size={12} className={clsx(loading && 'animate-spin')} />
          Refresh
        </button>
      </div>
      {loading && items.length === 0 && (
        <p className="text-xs text-blueprint-muted">Checking…</p>
      )}
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-2">
              <PreflightIcon ok={item.ok} />
              <div>
                <p className="text-xs text-slate-200">{item.label}</p>
                {item.message && (
                  <p className="text-[10px] text-blueprint-muted">{item.message}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!loading && items.length === 0 && (
        <p className="text-xs text-blueprint-muted">No preflight data returned.</p>
      )}
    </Section>
  )
}

// ─── Connection + Bound Accounts Section ─────────────────────────────────────

interface AccountsSectionProps {
  bizId: string
  bound: BoundAccount | null
  onBound: (account: BoundAccount) => void
}

function AccountsSection({ bizId, bound, onBound }: AccountsSectionProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [discovering, setDiscovering] = useState(false)
  const [pages, setPages] = useState<DiscoveredPage[]>([])
  const [binding, setBinding] = useState(false)
  const [selectedPageIdx, setSelectedPageIdx] = useState<number | null>(null)

  async function handleDiscover() {
    if (!bound?.connectorId) return
    setDiscovering(true)
    setPages([])
    setSelectedPageIdx(null)
    try {
      const data = await discoverSocialAccounts(bizId, bound.connectorId)
      setPages(data?.accounts ?? [])
    } catch (e) {
      addNotification({ type: 'error', message: (e as Error).message })
    } finally {
      setDiscovering(false)
    }
  }

  async function handleBind() {
    if (!bound?.connectorId || selectedPageIdx === null) return
    const page = pages[selectedPageIdx]
    if (!page) return
    setBinding(true)
    try {
      const result = await bindSocialAccount(bizId, {
        connectorId: bound.connectorId,
        facebookPageId: page.facebookPageId,
        instagramAccountId: page.instagram?.id,
      })
      onBound(result)
      setPages([])
      setSelectedPageIdx(null)
      addNotification({ type: 'success', message: 'Account bound successfully' })
    } catch (e) {
      addNotification({ type: 'error', message: (e as Error).message })
    } finally {
      setBinding(false)
    }
  }

  if (!bound) {
    return (
      <Section title="Meta Connection">
        <p className="text-xs text-blueprint-muted mb-3">
          No Meta (Facebook / Instagram) connector found. Connect one first.
        </p>
        <Link
          to="/connectors"
          className="bp-btn bp-btn-primary text-xs inline-flex"
        >
          <ExternalLink size={12} />
          Go to Connectors
        </Link>
      </Section>
    )
  }

  return (
    <Section title="Bound Accounts">
      <div className="space-y-3">
        {/* Current binding */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded border border-blueprint-border p-3">
            <p className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-1">Facebook Page</p>
            {bound.facebookPageName ? (
              <p className="text-xs text-slate-200 font-medium">{bound.facebookPageName}</p>
            ) : (
              <p className="text-xs text-blueprint-muted italic">Not bound</p>
            )}
            {bound.facebookPageId && (
              <p className="text-[10px] text-blueprint-muted mt-0.5">{bound.facebookPageId}</p>
            )}
          </div>
          <div className="rounded border border-blueprint-border p-3">
            <p className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-1">Instagram</p>
            {bound.instagramUsername ? (
              <p className="text-xs text-slate-200 font-medium">@{bound.instagramUsername}</p>
            ) : (
              <p className="text-xs text-blueprint-muted italic">Not bound</p>
            )}
            {bound.instagramAccountId && (
              <p className="text-[10px] text-blueprint-muted mt-0.5">{bound.instagramAccountId}</p>
            )}
          </div>
        </div>

        {/* Discover & bind */}
        <button
          onClick={handleDiscover}
          disabled={discovering}
          className="bp-btn bp-btn-secondary text-xs"
          aria-label="Discover pages"
        >
          <RefreshCw size={12} className={clsx(discovering && 'animate-spin')} />
          {discovering ? 'Discovering…' : 'Discover & Bind Page'}
        </button>

        {pages.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] text-blueprint-muted uppercase tracking-wider">Select a page to bind:</p>
            {pages.map((page, idx) => (
              <button
                key={page.facebookPageId}
                onClick={() => setSelectedPageIdx(idx)}
                className={clsx(
                  'w-full text-left rounded border p-3 transition-colors',
                  selectedPageIdx === idx
                    ? 'border-blueprint-blue bg-blueprint-blue/5'
                    : 'border-blueprint-border hover:border-blueprint-blue/40'
                )}
              >
                <p className="text-xs font-medium text-slate-200">{page.facebookPageName}</p>
                <p className="text-[10px] text-blueprint-muted">ID: {page.facebookPageId}</p>
                {page.instagram && (
                  <p className="text-[10px] text-blueprint-muted">
                    Instagram: @{page.instagram.username}
                  </p>
                )}
              </button>
            ))}
            <button
              onClick={handleBind}
              disabled={binding || selectedPageIdx === null}
              className="bp-btn bp-btn-primary text-xs"
            >
              {binding ? 'Binding…' : 'Confirm Bind'}
            </button>
          </div>
        )}
      </div>
    </Section>
  )
}

// ─── Capabilities Section ─────────────────────────────────────────────────────

function CapabilitiesSection({ bizId }: { bizId: string }) {
  const addNotification = useStore((s) => s.addNotification)
  const [caps, setCaps] = useState<Capability[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getSocialCapabilities(bizId)
      .then((data) => setCaps(data?.capabilities ?? []))
      .catch((e) => addNotification({ type: 'error', message: (e as Error).message }))
      .finally(() => setLoading(false))
  }, [bizId, addNotification])

  if (loading) return null

  const supported = caps.filter((c) => c.supported)
  const unsupported = caps.filter((c) => !c.supported)

  return (
    <Section title="Supported Content Types">
      {caps.length === 0 && (
        <p className="text-xs text-blueprint-muted">No capability data available.</p>
      )}
      {supported.length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-2">Supported</p>
          <ul className="space-y-1">
            {supported.map((c) => (
              <li key={`${c.platform}-${c.contentType}`} className="flex items-center gap-2">
                <CheckCircle size={12} className="text-blueprint-green" />
                <span className="text-xs text-slate-200 capitalize">{c.platform} — {c.contentType}</span>
                {c.notes && <span className="text-[10px] text-blueprint-muted">({c.notes})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {unsupported.length > 0 && (
        <div>
          <p className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-2">Not Supported</p>
          <ul className="space-y-1">
            {unsupported.map((c) => (
              <li key={`${c.platform}-${c.contentType}`} className="flex items-center gap-2">
                <XCircle size={12} className="text-blueprint-muted" />
                <span className="text-xs text-blueprint-muted capitalize">{c.platform} — {c.contentType}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

// ─── Policy Editor ────────────────────────────────────────────────────────────

interface PolicySectionProps {
  bizId: string
  connectorId: string | null
}

function PolicySection({ bizId, connectorId }: PolicySectionProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [policy, setPolicy] = useState<SocialPolicy | null>(null)
  const [mode, setMode] = useState('drafts_only')
  const [maxDailyPosts, setMaxDailyPosts] = useState(10)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!connectorId) return
    setLoading(true)
    getSocialPolicy(bizId, connectorId)
      .then((data) => {
        const p: SocialPolicy | null = (data as any)?.policy ?? data ?? null
        if (p) {
          setPolicy(p)
          setMode(p.mode ?? 'drafts_only')
          setMaxDailyPosts(p.maxDailyPosts ?? 10)
        }
      })
      .catch((e) => addNotification({ type: 'error', message: (e as Error).message }))
      .finally(() => setLoading(false))
  }, [bizId, connectorId, addNotification])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!connectorId) return
    setSaving(true)
    try {
      const res = await updateSocialPolicy(bizId, { connectorId, mode, maxDailyPosts })
      const updated: SocialPolicy = (res as any)?.policy ?? res
      setPolicy(updated)
      addNotification({ type: 'success', message: 'Policy updated' })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (!connectorId) {
    return (
      <Section title="Publishing Policy">
        <p className="text-xs text-blueprint-muted">Connect a Meta account to manage policy.</p>
      </Section>
    )
  }

  return (
    <Section title="Publishing Policy">
      {loading ? (
        <p className="text-xs text-blueprint-muted">Loading policy…</p>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-xs text-blueprint-muted mb-1">Publishing Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="bp-select w-full"
            >
              <option value="drafts_only">Drafts Only — never publish automatically</option>
              <option value="approval_required">Approval Required — publish after approval</option>
              <option value="immediate">Immediate — publish approved posts right away</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-blueprint-muted mb-1">Max Daily Posts</label>
            <input
              type="number"
              min={1}
              max={100}
              value={maxDailyPosts}
              onChange={(e) => setMaxDailyPosts(Number(e.target.value))}
              className="bp-input"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="bp-btn bp-btn-primary text-xs"
          >
            {saving ? 'Saving…' : 'Save Policy'}
          </button>
          {policy && (
            <p className="text-[10px] text-blueprint-muted">
              Connector: {policy.connectorId}
            </p>
          )}
        </form>
      )}
    </Section>
  )
}

// ─── Create Draft Form ────────────────────────────────────────────────────────

interface CreateDraftFormProps {
  bizId: string
  bound: BoundAccount | null
  onCreated: () => void
}

function CreateDraftForm({ bizId, bound, onCreated }: CreateDraftFormProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [platform, setPlatform] = useState('facebook')
  const [contentType, setContentType] = useState('image')
  const [targetId, setTargetId] = useState('')
  const [caption, setCaption] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [stagedMedia, setStagedMedia] = useState<StagedMedia[]>([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Auto-fill targetId when platform or bound account changes
  useEffect(() => {
    if (!bound) { setTargetId(''); return }
    if (platform === 'facebook') setTargetId(bound.facebookPageId ?? '')
    else if (platform === 'instagram') setTargetId(bound.instagramAccountId ?? '')
  }, [platform, bound])

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !bound?.connectorId) return
    setUploading(true)
    try {
      const reader = new FileReader()
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1]
        const result = await uploadSocialMedia(bizId, {
          connectorId: bound.connectorId,
          filename: file.name,
          mimeType: file.type,
          data: base64,
        })
        setStagedMedia((prev) => [...prev, { token: result.token, filename: file.name, url: result.url }])
        addNotification({ type: 'success', message: `Uploaded ${file.name}` })
      }
      reader.onerror = () => addNotification({ type: 'error', message: 'Failed to read file' })
      reader.readAsDataURL(file)
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function removeMedia(token: string) {
    setStagedMedia((prev) => prev.filter((m) => m.token !== token))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!caption.trim() || !platform || !contentType || !targetId || !bound?.connectorId) {
      addNotification({ type: 'warning', message: 'Please fill in all required fields.' })
      return
    }
    setSubmitting(true)
    try {
      await createSocialDraft(bizId, {
        connectorId: bound.connectorId,
        platform,
        targetId,
        contentType,
        caption,
        mediaUrls: stagedMedia.map((m) => m.url).filter(Boolean),
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      })
      addNotification({ type: 'success', message: 'Draft created' })
      setCaption('')
      setScheduledAt('')
      setStagedMedia([])
      onCreated()
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  if (!bound) {
    return (
      <Section title="Create Draft">
        <p className="text-xs text-blueprint-muted">Connect a Meta account to create posts.</p>
      </Section>
    )
  }

  return (
    <Section title="Create Draft">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-blueprint-muted mb-1">Platform</label>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="bp-select w-full">
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-blueprint-muted mb-1">Content Type</label>
            <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="bp-select w-full">
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="text">Text</option>
              <option value="reel">Reel</option>
              <option value="story">Story</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-blueprint-muted mb-1">Target ID</label>
          <input
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="bp-input"
            placeholder="Auto-filled from bound account"
          />
          <p className="text-[10px] text-blueprint-muted mt-0.5">
            Page or account ID to publish to
          </p>
        </div>

        <div>
          <label className="block text-xs text-blueprint-muted mb-1">Caption <span className="text-blueprint-red">*</span></label>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            className="bp-input min-h-[80px] resize-y"
            placeholder="Write your caption…"
            required
          />
        </div>

        {/* Media upload */}
        <div>
          <label className="block text-xs text-blueprint-muted mb-1">Media</label>
          {stagedMedia.length > 0 && (
            <ul className="space-y-1 mb-2">
              {stagedMedia.map((m) => (
                <li key={m.token} className="flex items-center justify-between rounded bg-blueprint-bg border border-blueprint-border px-3 py-1.5">
                  <span className="text-xs text-slate-300">{m.filename}</span>
                  <button
                    type="button"
                    onClick={() => removeMedia(m.token)}
                    className="text-blueprint-muted hover:text-blueprint-red"
                    aria-label={`Remove ${m.filename}`}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className={clsx(
            'bp-btn bp-btn-secondary text-xs cursor-pointer',
            uploading && 'opacity-50 cursor-not-allowed'
          )}>
            <Upload size={12} />
            {uploading ? 'Uploading…' : 'Add Media'}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4"
              className="sr-only"
              disabled={uploading}
              onChange={handleFileSelect}
            />
          </label>
        </div>

        {/* Schedule */}
        <div>
          <label className="block text-xs text-blueprint-muted mb-1">Schedule (optional)</label>
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="bp-input"
          />
        </div>

        <button
          type="submit"
          disabled={submitting || !caption.trim()}
          className="bp-btn bp-btn-primary text-xs"
        >
          <Send size={12} />
          {submitting ? 'Creating…' : 'Create Draft'}
        </button>
      </form>
    </Section>
  )
}

// ─── Posts List ───────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'draft' | 'approved' | 'published' | 'failed' | 'cancelled'

interface PostsListProps {
  bizId: string
  refreshKey: number
}

function PostsList({ bizId, refreshKey }: PostsListProps) {
  const addNotification = useStore((s) => s.addNotification)
  const [posts, setPosts] = useState<SocialPost[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = filter !== 'all' ? { status: filter } : {}
      const data = await getSocialPosts(bizId, params)
      setPosts(data?.posts ?? data ?? [])
    } catch (e) {
      addNotification({ type: 'error', message: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }, [bizId, filter, addNotification])

  useEffect(() => { load() }, [load, refreshKey])

  async function handleAction(postId: string, action: 'approve' | 'cancel' | 'publish') {
    setActionLoading((prev) => ({ ...prev, [postId]: action }))
    try {
      if (action === 'approve') await approveSocialPost(bizId, postId)
      else if (action === 'cancel') await cancelSocialPost(bizId, postId)
      else if (action === 'publish') await publishSocialPost(bizId, postId)
      addNotification({ type: 'success', message: `Post ${action}d` })
      load()
    } catch (e) {
      addNotification({ type: 'error', message: (e as Error).message })
    } finally {
      setActionLoading((prev) => { const n = { ...prev }; delete n[postId]; return n })
    }
  }

  const STATUS_TABS: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'draft', label: 'Draft' },
    { value: 'approved', label: 'Approved' },
    { value: 'published', label: 'Published' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' },
  ]

  return (
    <Section title="Posts">
      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 flex-wrap">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={clsx(
              'px-3 py-1 rounded text-xs font-medium transition-colors',
              filter === tab.value
                ? 'bg-blueprint-blue text-white'
                : 'text-blueprint-muted hover:text-slate-300 hover:bg-blueprint-border/40'
            )}
          >
            {tab.label}
          </button>
        ))}
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto bp-btn bp-btn-secondary text-xs"
          aria-label="Refresh posts"
        >
          <RefreshCw size={12} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {loading && posts.length === 0 && (
        <p className="text-xs text-blueprint-muted">Loading posts…</p>
      )}

      {!loading && posts.length === 0 && (
        <p className="text-xs text-blueprint-muted">No posts found{filter !== 'all' ? ` with status "${filter}"` : ''}.</p>
      )}

      <ul className="space-y-3">
        {posts.map((post) => {
          const busy = actionLoading[post.id]
          return (
            <li key={post.id} className="rounded border border-blueprint-border p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusBadge status={post.status} />
                    <span className="text-[10px] text-blueprint-muted capitalize">{post.platform} · {post.contentType}</span>
                  </div>
                  <p className="text-xs text-slate-200 break-words">{post.caption}</p>
                  {post.errorMessage && (
                    <p className="text-[10px] text-blueprint-red flex items-center gap-1">
                      <AlertTriangle size={10} /> {post.errorMessage}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 text-[10px] text-blueprint-muted flex-wrap">
                {post.scheduledAt && (
                  <span className="flex items-center gap-1">
                    <Clock size={10} /> {fmt(post.scheduledAt)}
                  </span>
                )}
                {post.publishedAt && (
                  <span className="flex items-center gap-1">
                    <Check size={10} /> Published {fmt(post.publishedAt)}
                  </span>
                )}
                <span>Created {fmt(post.createdAt)}</span>
              </div>

              {/* Actions */}
              <div className="flex gap-2 flex-wrap">
                {post.status === 'draft' && (
                  <>
                    <button
                      onClick={() => handleAction(post.id, 'approve')}
                      disabled={!!busy}
                      className="bp-btn bp-btn-primary text-xs"
                      aria-label="Approve post"
                    >
                      <Check size={11} />
                      {busy === 'approve' ? 'Approving…' : 'Approve'}
                    </button>
                    <button
                      onClick={() => handleAction(post.id, 'cancel')}
                      disabled={!!busy}
                      className="bp-btn bp-btn-secondary text-xs"
                      aria-label="Cancel post"
                    >
                      <X size={11} />
                      {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
                    </button>
                  </>
                )}
                {post.status === 'approved' && (
                  <>
                    <button
                      onClick={() => handleAction(post.id, 'publish')}
                      disabled={!!busy}
                      className="bp-btn bp-btn-primary text-xs"
                      aria-label="Publish post now"
                    >
                      <Send size={11} />
                      {busy === 'publish' ? 'Publishing…' : 'Publish Now'}
                    </button>
                    <button
                      onClick={() => handleAction(post.id, 'cancel')}
                      disabled={!!busy}
                      className="bp-btn bp-btn-secondary text-xs"
                      aria-label="Cancel post"
                    >
                      <X size={11} />
                      {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
                    </button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SocialPublishing() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const addNotification = useStore((s) => s.addNotification)
  const [bound, setBound] = useState<BoundAccount | null>(null)
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [postsRefreshKey, setPostsRefreshKey] = useState(0)

  const bizId = currentBusiness?.id ?? ''

  useEffect(() => {
    if (!bizId) return
    setLoadingAccounts(true)
    getSocialAccounts(bizId)
      .then((data) => setBound(data ?? null))
      .catch((e) => addNotification({ type: 'error', message: (e as Error).message }))
      .finally(() => setLoadingAccounts(false))
  }, [bizId, addNotification])

  if (!currentBusiness) {
    return (
      <div className="p-6">
        <p className="text-xs text-blueprint-muted">No business selected.</p>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Social Publishing</h1>
        <p className="text-xs text-blueprint-muted mt-1">
          Manage your Facebook &amp; Instagram publishing for {currentBusiness.name}.
        </p>
      </div>

      <PreflightSection bizId={bizId} />

      {loadingAccounts ? (
        <div className="bp-card p-5">
          <p className="text-xs text-blueprint-muted">Loading account info…</p>
        </div>
      ) : (
        <AccountsSection
          bizId={bizId}
          bound={bound}
          onBound={(account) => setBound(account)}
        />
      )}

      <CapabilitiesSection bizId={bizId} />

      <PolicySection bizId={bizId} connectorId={bound?.connectorId ?? null} />

      <CreateDraftForm
        bizId={bizId}
        bound={bound}
        onCreated={() => setPostsRefreshKey((k) => k + 1)}
      />

      <PostsList bizId={bizId} refreshKey={postsRefreshKey} />
    </div>
  )
}
