import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { formatDistanceToNow, format, parseISO } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import {
  RefreshCw, ArrowLeft, ExternalLink,
  Search, BarChart2, Zap, ShoppingBag, MapPin, Database,
  TrendingUp, TrendingDown, Minus,
  AlertTriangle, CheckCircle, Globe, Phone, Navigation,
  Star, Eye, MessageSquare, FileText, Image,
  CreditCard, GitBranch, Plus, Target,
  Activity, CheckSquare, Mail, Send,
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { getConnectorData, syncConnector, createTask } from '../lib/api'
import useStore from '../lib/store'
import Gauge from '../components/Gauge'
import { chartDefaults, CHART_COLORS } from '../lib/chartTheme'

const CONNECTOR_META = {
  gsc:           { icon: Search,      label: 'Search Console',     color: 'var(--bp-blue)' },
  ga4:           { icon: BarChart2,   label: 'Google Analytics',   color: 'var(--bp-green)' },
  pagespeed:     { icon: Zap,         label: 'PageSpeed',          color: 'var(--bp-amber)' },
  shopify:       { icon: ShoppingBag, label: 'Shopify',            color: 'var(--bp-green)' },
  gbp:           { icon: MapPin,      label: 'Business Profile',   color: 'var(--bp-blue)' },
  stripe:        { icon: CreditCard,  label: 'Stripe',             color: 'var(--bp-purple)' },
  github:        { icon: GitBranch,   label: 'GitHub',             color: 'var(--bp-text-3)' },
  uptimerobot:   { icon: Activity,    label: 'UptimeRobot',        color: 'var(--bp-green)' },
  todoist:       { icon: CheckSquare, label: 'Todoist',            color: 'var(--bp-red)' },
  brevo:         { icon: Mail,        label: 'Brevo',              color: 'var(--bp-blue)' },
  stannp:        { icon: Send,        label: 'Stannp',             color: 'var(--bp-purple)' },
  wordpress:     { icon: Globe,       label: 'WordPress',          color: 'var(--bp-blue)' },
  kirby:         { icon: FileText,    label: 'Kirby',              color: 'var(--bp-amber)' },
  'google-ads':  { icon: TrendingUp,  label: 'Google Ads',         color: 'var(--bp-amber)' },
  'meta-ads':    { icon: Target,      label: 'Meta Ads',           color: '#1877F2' },
  klaviyo:       { icon: Mail,        label: 'Klaviyo',            color: '#FF6B35' },
  semrush:       { icon: TrendingUp,  label: 'SEMrush',            color: '#FF642D' },
  social:        { icon: MessageSquare, label: 'Facebook & Instagram', color: '#1877F2' },
  buffer:        { icon: Send,        label: 'Buffer',             color: '#168EEA' },
  wix:           { icon: Globe,       label: 'Wix',                color: '#0046FF' },
  'server-access': { icon: Database,  label: 'Server (SSH/FTP)',   color: 'var(--bp-red)' },
  default:       { icon: Database,    label: 'Data Source',        color: 'var(--bp-text-3)' },
}

const CONNECTOR_TABS = {
  gsc:           ['Overview', 'Keywords', 'Pages', 'Raw Data'],
  ga4:           ['Overview', 'Traffic', 'Pages', 'Acquisition', 'Raw Data'],
  pagespeed:     ['Overview', 'Mobile', 'Desktop', 'History', 'Opportunities'],
  shopify:       ['Overview', 'Orders', 'Products', 'Customers', 'Inventory', 'Raw Data'],
  gbp:           ['Overview', 'Reviews', 'Insights', 'Posts', 'Photos', 'Q&A', 'Raw Data'],
  stripe:        ['Overview', 'Revenue', 'Customers', 'Subscriptions', 'Payouts', 'Raw Data'],
  github:        ['Overview', 'Pull Requests', 'Issues', 'Deployments', 'Raw Data'],
  uptimerobot:   ['Overview', 'Monitors', 'Incidents', 'Response Times', 'Raw Data'],
  todoist:       ['Overview', 'Tasks', 'Projects', 'Productivity', 'Raw Data'],
  brevo:         ['Overview', 'Campaigns', 'Contacts', 'Transactional', 'Raw Data'],
  stannp:        ['Overview', 'Campaigns', 'Recipients', 'Costs', 'Raw Data'],
  wordpress:     ['Overview', 'Posts', 'Pages', 'Plugins', 'Comments', 'Media', 'Raw Data'],
  kirby:         ['Overview', 'Pages', 'Drafts', 'Content Health', 'Raw Data'],
  'google-ads':  ['Overview', 'Campaigns', 'Keywords', 'Performance', 'Budget', 'Raw Data'],
  'meta-ads':    ['Overview', 'Campaigns', 'Audiences', 'Creative', 'Raw Data'],
  klaviyo:       ['Overview', 'Campaigns', 'Flows', 'Lists', 'Raw Data'],
  semrush:       ['Overview', 'Keywords', 'Competitors', 'Opportunities', 'Raw Data'],
  social:        ['Overview', 'Facebook', 'Instagram', 'Posts', 'Raw Data'],
  buffer:        ['Overview', 'Queue', 'Recent Posts', 'Raw Data'],
  wix:           ['Overview', 'Pages', 'Blog', 'SEO Audit', 'Raw Data'],
  'server-access': ['Overview', 'File Explorer', 'Error Log', 'Changes', 'Backups', 'Raw Data'],
  default:       ['Overview', 'Raw Data'],
}

const RANGE_OPTIONS = ['today', 'yesterday', '7d', '14d', '30d']
const RANGE_LABELS  = { today: 'Today', yesterday: 'Yesterday', '7d': '7D', '14d': '14D', '30d': '30D' }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRangeBounds(range: any) {
  const now = new Date()
  if (range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return { start, end: now }
  }
  if (range === 'yesterday') {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return { start: new Date(end.getTime() - 86400000), end }
  }
  const days = range === '7d' ? 7 : range === '14d' ? 14 : 30
  return { start: new Date(now.getTime() - days * 86400000), end: now }
}

function getPrevBounds(range: any) {
  const { start, end } = getRangeBounds(range)
  const duration = end.getTime() - start.getTime()
  return { start: new Date(start.getTime() - duration), end: start }
}

function pctChange(current: any, previous: any) {
  if (!previous || previous === 0) return null
  return ((current - previous) / previous) * 100
}

function TrendBadge({ current, previous, invertPolarity = false, suffix = '' }: any) {
  const pct = pctChange(current, previous)
  if (pct === null) return null
  const good = invertPolarity ? pct < 0 : pct > 0
  const neutral = Math.abs(pct) < 0.5
  const color = neutral ? 'var(--bp-text-3)' : good ? 'var(--bp-green)' : 'var(--bp-red)'
  const Icon = neutral ? Minus : good ? TrendingUp : TrendingDown
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, color }}>
      <Icon size={10} />
      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9 }}>
        {neutral ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}{suffix}
      </span>
    </div>
  )
}

function MetricCard({ label, value, previous, format: fmt = 'number', invertPolarity = false, accent }: any) {
  const display = fmt === 'currency' ? `£${Number(value || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : fmt === 'pct' ? `${(value || 0).toFixed(1)}%`
    : fmt === 'duration' ? `${Math.floor((value || 0) / 60)}m ${Math.round((value || 0) % 60)}s`
    : fmt === 'decimal' ? (value || 0).toFixed(2)
    : (value || 0).toLocaleString()

  return (
    <div className="bp-card" style={{
      padding: '16px 18px',
      borderLeft: accent ? `3px solid ${accent}` : undefined,
    }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 22, color: 'var(--bp-text)', marginBottom: 4 }}>
        {display}
      </div>
      <TrendBadge current={value} previous={previous} invertPolarity={invertPolarity} />
    </div>
  )
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ ...chartDefaults.tooltip.contentStyle, padding: '8px 12px' }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any, i: any) => (
        <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: p.color || 'var(--bp-text)' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
        </div>
      ))}
    </div>
  )
}

// ─── Raw Data Tab ─────────────────────────────────────────────────────────────

function RawDataTab({ data }: any) {
  const [copied, setCopied] = useState(false)
  const json = JSON.stringify(data, null, 2)
  function copy() {
    navigator.clipboard.writeText(json).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button onClick={copy} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
          {copied ? <><CheckCircle size={12} /> Copied!</> : 'Copy JSON'}
        </button>
      </div>
      <pre style={{
        fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)',
        background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border)',
        borderRadius: 6, padding: 16, overflow: 'auto', maxHeight: 600, lineHeight: 1.5,
      }}>
        {json}
      </pre>
    </div>
  )
}

// ─── GSC Tabs ────────────────────────────────────────────────────────────────

function GSCOverview({ metrics }: any) {
  const { latest, series, summary } = metrics
  const clicks = latest['clicks'] ?? 0
  const impressions = latest['impressions'] ?? 0
  const ctr = latest['ctr'] ?? 0
  const position = latest['position'] ?? 0

  const clicksSeries = (series['clicks'] || []).map((m: any) => ({
    date: format(parseISO(m.recorded_at), 'MMM d'),
    clicks: m.metric_value,
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Total Clicks" value={clicks} previous={summary?.clicks_prev} accent="var(--bp-blue)" />
        <MetricCard label="Impressions" value={impressions} accent="var(--bp-text-3)" />
        <MetricCard label="Avg CTR" value={ctr} format="pct" accent="var(--bp-green)" />
        <MetricCard label="Avg Position" value={position} format="decimal" invertPolarity accent="var(--bp-amber)" />
      </div>

      {clicksSeries.length > 1 && (
        <div className="bp-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Clicks Over Time</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={clicksSeries}>
              <defs>
                <linearGradient id="gscClicksGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.blue} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.blue} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="date" {...chartDefaults.xAxis} />
              <YAxis {...chartDefaults.yAxis} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="clicks" stroke={CHART_COLORS.blue} fill="url(#gscClicksGrad)" strokeWidth={2} name="Clicks" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function GSCKeywords({ metrics }: any) {
  // GSC connector writes 'gsc.keywords' with data = top 100 keyword objects.
  // Server alias exposes both 'keywords' (scalar count) and 'keywords_data'
  // (the array). Accept either for backwards compat.
  const raw = metrics.latest['keywords_data']
    ?? metrics.latest['top_queries_data']
    ?? (Array.isArray(metrics.latest['keywords']) ? metrics.latest['keywords'] : null)
  const keywords = raw
    ? (typeof raw === 'string' ? JSON.parse(raw) : raw)
    : []

  if (!keywords || keywords.length === 0) {
    return <EmptyState message="No keyword data available yet. Run a sync to pull keyword data." />
  }

  // Opportunity finder: high impressions (>100), low CTR (<3%), position 11-20
  const avgCTR = keywords.reduce((s: any, k: any) => s + (k.ctr || 0), 0) / (keywords.length || 1)
  const opportunities = keywords.filter((k: any) =>
    (k.impressions || 0) > 100 &&
    (k.ctr || 0) < Math.max(avgCTR, 0.03) &&
    (k.position || 99) >= 8 && (k.position || 99) <= 25
  ).sort((a: any, b: any) => (b.impressions || 0) - (a.impressions || 0)).slice(0, 8)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Opportunity Finder panel */}
      {opportunities.length > 0 && (
        <div style={{ background: 'rgba(0,201,167,0.05)', border: '1px solid rgba(0,201,167,0.18)', borderRadius: 6, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <TrendingUp size={13} style={{ color: 'var(--bp-green)' }} />
            <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 12, color: 'var(--bp-green)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Opportunity Finder
            </span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
              — high impressions, low CTR, positions 8–25
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {opportunities.map((kw: any, i: any) => {
              const kw_text = kw.keys?.[0] || kw.query || kw.keyword
              const ctrPct = ((kw.ctr || 0) * 100).toFixed(1)
              const pos = (kw.position || 0).toFixed(1)
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'rgba(0,201,167,0.04)', borderRadius: 4, border: '1px solid rgba(0,201,167,0.1)' }}>
                  <div style={{ flex: 1, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>{kw_text}</div>
                  <div style={{ display: 'flex', gap: 14 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Impressions</div>
                      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{(kw.impressions || 0).toLocaleString()}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>CTR</div>
                      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-red)' }}>{ctrPct}%</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pos</div>
                      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-amber)' }}>#{pos}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Full keyword table */}
      <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--bp-border)', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          All Keywords
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['Keyword', 'Clicks', 'Impressions', 'CTR', 'Position'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keywords.slice(0, 50).map((kw: any, i: any) => (
              <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>{kw.keys?.[0] || kw.query || kw.keyword}</td>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{(kw.clicks || 0).toLocaleString()}</td>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{(kw.impressions || 0).toLocaleString()}</td>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{((kw.ctr || 0) * 100).toFixed(1)}%</td>
                <td style={{ padding: '9px 16px' }}>
                  <span style={{
                    fontFamily: 'var(--bp-font-mono)', fontSize: 11,
                    color: (kw.position || 99) <= 3 ? 'var(--bp-green)' : (kw.position || 99) <= 10 ? 'var(--bp-amber)' : 'var(--bp-text-3)',
                  }}>
                    {(kw.position || 0).toFixed(1)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GSCPages({ metrics }: any) {
  // GSC doesn't emit a separate top_pages metric — derive from the same
  // keyword-level data, grouping by page URL.
  const rawKeywords = metrics.latest['keywords_data']
    ?? (Array.isArray(metrics.latest['keywords']) ? metrics.latest['keywords'] : null)
  const keywords = rawKeywords
    ? (typeof rawKeywords === 'string' ? JSON.parse(rawKeywords) : rawKeywords)
    : []

  // Group by page (each row's `page` field; some rows may not have one).
  const byPage = new Map()
  for (const k of keywords) {
    const url = k.page || k.url || k.keys?.[1]
    if (!url) continue
    const acc = byPage.get(url) || { page: url, clicks: 0, impressions: 0, positions: [], queries: 0 }
    acc.clicks += k.clicks || 0
    acc.impressions += k.impressions || 0
    if (k.position) acc.positions.push(k.position)
    acc.queries += 1
    byPage.set(url, acc)
  }
  const pages = [...byPage.values()].map((p) => ({
    page: p.page,
    clicks: p.clicks,
    impressions: p.impressions,
    ctr: p.impressions > 0 ? p.clicks / p.impressions : 0,
    position: p.positions.length > 0 ? p.positions.reduce((a: any, b: any) => a + b, 0) / p.positions.length : 0,
    queries: p.queries,
  })).sort((a, b) => b.clicks - a.clicks)

  if (pages.length === 0) {
    return <EmptyState message="No per-page data yet. The Keywords tab shows a richer breakdown." />
  }

  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
            {['Page', 'Clicks', 'Impressions', 'CTR', 'Position'].map(h => (
              <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pages.slice(0, 50).map((p: any, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.keys?.[0] || p.page || p.url}
              </td>
              <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{(p.clicks || 0).toLocaleString()}</td>
              <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{(p.impressions || 0).toLocaleString()}</td>
              <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{((p.ctr || 0) * 100).toFixed(1)}%</td>
              <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>{(p.position || 0).toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── GA4 Tabs ─────────────────────────────────────────────────────────────────

function GA4Overview({ metrics }: any) {
  const { latest, series, summary } = metrics
  const sessions = latest['sessions'] ?? 0
  const users = latest['users'] ?? 0
  const bounce = latest['bounce_rate'] ?? 0
  const duration = latest['avg_session_duration'] ?? 0
  const pageviews = latest['pageviews'] ?? 0
  const newUsers = latest['new_users'] ?? 0

  const sessionsSeries = (series['sessions'] || []).map((m: any) => ({
    date: format(parseISO(m.recorded_at), 'MMM d'),
    sessions: m.metric_value,
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <MetricCard label="Sessions" value={sessions} previous={summary?.sessions_prev} accent="var(--bp-blue)" />
        <MetricCard label="Users" value={users} accent="var(--bp-cyan)" />
        <MetricCard label="New Users" value={newUsers} accent="var(--bp-green)" />
        <MetricCard label="Bounce Rate" value={bounce} format="pct" invertPolarity accent="var(--bp-amber)" />
        <MetricCard label="Avg Session" value={duration} format="duration" accent="var(--bp-text-3)" />
        <MetricCard label="Pageviews" value={pageviews} accent="var(--bp-purple)" />
      </div>

      {sessionsSeries.length > 1 && (
        <div className="bp-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Sessions Over Time</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={sessionsSeries}>
              <defs>
                <linearGradient id="ga4SessionsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.blue} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.blue} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="date" {...chartDefaults.xAxis} />
              <YAxis {...chartDefaults.yAxis} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="sessions" stroke={CHART_COLORS.blue} fill="url(#ga4SessionsGrad)" strokeWidth={2} name="Sessions" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function GA4Traffic({ metrics }: any) {
  const { series } = metrics
  const sessionsSeries = (series['sessions'] || []).map((m: any) => ({
    date: format(parseISO(m.recorded_at), 'MMM d'),
    sessions: m.metric_value,
  }))

  const sources = metrics.latest['traffic_sources_data']
    ? (typeof metrics.latest['traffic_sources_data'] === 'string'
        ? JSON.parse(metrics.latest['traffic_sources_data'])
        : metrics.latest['traffic_sources_data'])
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {sessionsSeries.length > 1 && (
        <div className="bp-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Daily Sessions</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={sessionsSeries}>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="date" {...chartDefaults.xAxis} />
              <YAxis {...chartDefaults.yAxis} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="sessions" fill={CHART_COLORS.blue} radius={[2, 2, 0, 0]} name="Sessions" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {sources.length > 0 && (
        <div className="bp-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Traffic Sources</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bp-border)' }}>
                {['Source', 'Sessions', 'Users', 'Bounce Rate'].map(h => (
                  <th key={h} style={{ padding: '8px 0', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((s: any, i: any) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '8px 0', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>{s.source || s.channel || s.medium}</td>
                  <td style={{ padding: '8px 0', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{(s.sessions || 0).toLocaleString()}</td>
                  <td style={{ padding: '8px 0', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{(s.users || 0).toLocaleString()}</td>
                  <td style={{ padding: '8px 0', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{((s.bounceRate || 0) * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── PageSpeed Tabs ───────────────────────────────────────────────────────────

function PSOverview({ metrics }: any) {
  const { latest } = metrics
  // Defensive scalar coercion: an alias may resolve to an object (the
  // sibling metric_data) when something upstream is wrong. Strip to a
  // number so we never end up multiplying an object → NaN.
  const num = (v: any) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (v && typeof v === 'object') {
      // pagespeed connector stores the entire scores object as data
      // (e.g. { performance, accessibility, seo, bestPractices }).
      // Caller can't know which field they wanted, so return 0.
      return 0
    }
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const mobile = {
    performance:   num(latest['performance_mobile'] ?? latest['performance_score'] ?? 0),
    accessibility: num(latest['accessibility_mobile'] ?? latest['accessibility'] ?? 0),
    bestPractices: num(latest['best_practices_mobile'] ?? latest['best_practices'] ?? 0),
    seo:           num(latest['seo_mobile'] ?? latest['seo'] ?? 0),
    lcp:           num(latest['lcp_mobile'] ?? latest['lcp'] ?? 0),
    cls:           num(latest['cls_mobile'] ?? latest['cls'] ?? 0),
    fcp:           num(latest['fcp_mobile'] ?? latest['fcp'] ?? 0),
  }

  // Normalize 0-1 scores to 0-100 (the connector now writes 0-100 already
  // but this stays correct for either scale).
  const norm = (v: any) => v <= 1 ? Math.round(v * 100) : Math.round(v)

  const cwvItems = [
    { label: 'LCP', value: mobile.lcp, unit: 'ms', threshold: 2500, invert: true, format: (v: any) => `${v}ms`, good: (v: any) => v < 2500, warn: (v: any) => v < 4000 },
    { label: 'CLS', value: mobile.cls, unit: '', threshold: 0.1, invert: true, format: (v: any) => v?.toFixed(3), good: (v: any) => v < 0.1, warn: (v: any) => v < 0.25 },
    { label: 'FCP', value: mobile.fcp, unit: 'ms', invert: true, format: (v: any) => `${v}ms`, good: (v: any) => v < 1800, warn: (v: any) => v < 3000 },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Score gauges */}
      <div className="bp-card" style={{ padding: '20px' }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>Mobile Scores</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          <div style={{ textAlign: 'center' }}>
            <Gauge value={norm(mobile.performance)} max={100} label="Performance" goodThreshold={90} needsWorkThreshold={50} />
          </div>
          <div style={{ textAlign: 'center' }}>
            <Gauge value={norm(mobile.accessibility)} max={100} label="Accessibility" goodThreshold={90} needsWorkThreshold={50} />
          </div>
          <div style={{ textAlign: 'center' }}>
            <Gauge value={norm(mobile.bestPractices)} max={100} label="Best Practices" goodThreshold={90} needsWorkThreshold={50} />
          </div>
          <div style={{ textAlign: 'center' }}>
            <Gauge value={norm(mobile.seo)} max={100} label="SEO" goodThreshold={90} needsWorkThreshold={50} />
          </div>
        </div>
      </div>

      {/* Core Web Vitals */}
      <div className="bp-card" style={{ padding: '16px 18px' }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>Core Web Vitals</div>
        <div style={{ display: 'flex', gap: 12 }}>
          {cwvItems.filter(item => item.value).map((item) => {
            const statusColor = item.good(item.value) ? 'var(--bp-green)' : item.warn(item.value) ? 'var(--bp-amber)' : 'var(--bp-red)'
            return (
              <div key={item.label} style={{
                flex: 1, padding: '12px', background: 'var(--bp-surface-2)',
                borderRadius: 6, border: `1px solid ${statusColor}22`,
              }}>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                  {item.label}
                </div>
                <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 20, color: statusColor }}>
                  {item.format(item.value)}
                </div>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: statusColor, marginTop: 4 }}>
                  {item.good(item.value) ? '● Good' : item.warn(item.value) ? '● Needs Improvement' : '● Poor'}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── PageSpeed Desktop Tab ────────────────────────────────────────────────────

function PSDesktop({ metrics }: any) {
  const { latest } = metrics
  const norm = (v: any) => v <= 1 ? Math.round(v * 100) : Math.round(v)
  const desktop = {
    performance:   norm(latest['performance_desktop'] ?? 0),
    accessibility: norm(latest['accessibility_desktop'] ?? 0),
    bestPractices: norm(latest['best_practices_desktop'] ?? 0),
    seo:           norm(latest['seo_desktop'] ?? 0),
    lcp:           latest['lcp_desktop'] ?? 0,
    cls:           latest['cls_desktop'] ?? 0,
    fcp:           latest['fcp_desktop'] ?? 0,
  }
  const cwvItems = [
    { label: 'LCP', value: desktop.lcp, format: (v: any) => `${v}ms`, good: (v: any) => v < 2500, warn: (v: any) => v < 4000 },
    { label: 'CLS', value: desktop.cls, format: (v: any) => v?.toFixed(3), good: (v: any) => v < 0.1, warn: (v: any) => v < 0.25 },
    { label: 'FCP', value: desktop.fcp, format: (v: any) => `${v}ms`, good: (v: any) => v < 1800, warn: (v: any) => v < 3000 },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="bp-card" style={{ padding: '20px' }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>Desktop Scores</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          <div style={{ textAlign: 'center' }}><Gauge value={desktop.performance} max={100} label="Performance" goodThreshold={90} needsWorkThreshold={50} /></div>
          <div style={{ textAlign: 'center' }}><Gauge value={desktop.accessibility} max={100} label="Accessibility" goodThreshold={90} needsWorkThreshold={50} /></div>
          <div style={{ textAlign: 'center' }}><Gauge value={desktop.bestPractices} max={100} label="Best Practices" goodThreshold={90} needsWorkThreshold={50} /></div>
          <div style={{ textAlign: 'center' }}><Gauge value={desktop.seo} max={100} label="SEO" goodThreshold={90} needsWorkThreshold={50} /></div>
        </div>
      </div>
      <div className="bp-card" style={{ padding: '16px 18px' }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>Core Web Vitals (Desktop)</div>
        <div style={{ display: 'flex', gap: 12 }}>
          {cwvItems.filter(item => item.value).map((item) => {
            const statusColor = item.good(item.value) ? 'var(--bp-green)' : item.warn(item.value) ? 'var(--bp-amber)' : 'var(--bp-red)'
            return (
              <div key={item.label} style={{ flex: 1, padding: '12px', background: 'var(--bp-surface-2)', borderRadius: 6, border: `1px solid ${statusColor}22` }}>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{item.label}</div>
                <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 20, color: statusColor }}>{item.format(item.value)}</div>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: statusColor, marginTop: 4 }}>
                  {item.good(item.value) ? '● Good' : item.warn(item.value) ? '● Needs Improvement' : '● Poor'}
                </div>
              </div>
            )
          })}
          {!cwvItems.some(i => i.value) && <EmptyState message="Desktop CWV data available after sync." />}
        </div>
      </div>
    </div>
  )
}

// ─── PageSpeed History Tab ────────────────────────────────────────────────────

function PSHistory({ metrics }: any) {
  const { series } = metrics
  const mobileSeries = (series['performance_mobile'] || []).map((m: any) => ({
    date: format(parseISO(m.recorded_at), 'MMM d'),
    mobile: typeof m.metric_value === 'number' ? (m.metric_value <= 1 ? Math.round(m.metric_value * 100) : Math.round(m.metric_value)) : 0,
  }))
  const desktopSeries = (series['performance_desktop'] || []).map((m: any) => ({
    date: format(parseISO(m.recorded_at), 'MMM d'),
    desktop: typeof m.metric_value === 'number' ? (m.metric_value <= 1 ? Math.round(m.metric_value * 100) : Math.round(m.metric_value)) : 0,
  }))
  const merged = mobileSeries.map((m: any, i: any) => ({ ...m, desktop: desktopSeries[i]?.desktop }))
  if (merged.length < 2) return <EmptyState message="Score history builds up after multiple syncs." />
  return (
    <div className="bp-card" style={{ padding: '16px 18px' }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Performance Score History</div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={merged}>
          <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis dataKey="date" {...chartDefaults.xAxis} />
          <YAxis {...chartDefaults.yAxis} domain={[0, 100]} />
          <Tooltip content={<CustomTooltip />} />
          <Line type="monotone" dataKey="mobile" stroke={CHART_COLORS.amber} strokeWidth={2} dot={false} name="Mobile" />
          <Line type="monotone" dataKey="desktop" stroke={CHART_COLORS.blue} strokeWidth={2} dot={false} name="Desktop" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── PageSpeed Opportunities Tab ──────────────────────────────────────────────

function PSOpportunities({ metrics, connector }: any) {
  const addNotification = useStore((s) => s.addNotification)
  const opportunities = (() => {
    // Aliases now expose opportunities_mobile_data + opportunities_desktop_data;
    // the legacy 'opportunities_data' key remains as a fallback.
    const raw = metrics.latest['opportunities_mobile_data']
      ?? metrics.latest['opportunities_data']
      ?? metrics.latest['opportunities_desktop_data']
      ?? null
    if (!raw) return []
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
  })()
  const [creating, setCreating] = React.useState<Record<string, boolean>>({})

  async function handleCreateTask(opp: any) {
    setCreating(p => ({ ...p, [opp.id]: true }))
    try {
      await createTask({
        business_id: connector?.business_id,
        title: `Fix PageSpeed: ${opp.title}`,
        description: opp.description || opp.title,
        action_type: 'investigation',
        priority: (opp.score ?? 1) < 0.5 ? 'p1' : 'p2',
        trust_tier: 'yellow',
        proposed_by: 'dev',
      })
      addNotification({ type: 'success', title: 'Task created', message: `"Fix: ${opp.title}" added to Dev queue` })
    } catch (err) {
      addNotification({ type: 'error', message: (err as any).message })
    } finally {
      setCreating(p => ({ ...p, [opp.id]: false }))
    }
  }

  if (!opportunities.length) return <EmptyState message="Run a sync to pull PageSpeed opportunities. Ensure your PageSpeed connector is configured." />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {opportunities.map((opp: any, i: any) => {
        const score = opp.score ?? 1
        const scoreColor = score < 0.5 ? 'var(--bp-red)' : score < 0.9 ? 'var(--bp-amber)' : 'var(--bp-green)'
        return (
          <div key={opp.id || i} className="bp-card" style={{ padding: '14px 16px', borderLeft: `3px solid ${scoreColor}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>{opp.title}</span>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '1px 6px', borderRadius: 2, background: `${scoreColor}18`, color: scoreColor, border: `1px solid ${scoreColor}30` }}>
                    {Math.round(score * 100)}
                  </span>
                  {opp.displayValue && (
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{opp.displayValue}</span>
                  )}
                </div>
                {opp.description && (
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>{opp.description}</div>
                )}
              </div>
              <button
                onClick={() => handleCreateTask(opp)}
                disabled={creating[opp.id]}
                className="bp-btn bp-btn-secondary"
                style={{ fontSize: 10, flexShrink: 0 }}
              >
                {creating[opp.id] ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Plus size={11} />}
                Dev Task
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Stripe Overview ──────────────────────────────────────────────────────────

function BrevoOverview({ metrics, summary }: any) {
  const { latest } = metrics
  const totalContacts = latest['total_contacts'] ?? 0
  const campaigns30d = latest['campaigns_sent_30d'] ?? 0
  const openRate = latest['avg_open_rate'] ?? 0
  const clickRate = latest['avg_click_rate'] ?? 0
  const unsubRate = latest['avg_unsubscribe_rate'] ?? 0
  const bounceRate = latest['avg_bounce_rate'] ?? 0
  const txDelivered = latest['transactional_delivered_7d'] ?? null
  const txBounceRate = latest['transactional_bounce_rate_7d'] ?? null
  const campaigns = Array.isArray(latest['campaigns_data']) ? latest['campaigns_data'] : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Total Contacts" value={totalContacts} accent="var(--bp-blue)" />
        <MetricCard label="Campaigns (30d)" value={campaigns30d} accent="var(--bp-text-3)" />
        <MetricCard label="Avg Open Rate" value={openRate} format="pct" previous={summary?.avg_open_rate_prev} accent="var(--bp-green)" />
        <MetricCard label="Avg Click Rate" value={clickRate} format="pct" accent="var(--bp-blue)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Unsubscribe Rate" value={unsubRate} format="pct" invertPolarity accent="var(--bp-amber)" />
        <MetricCard label="Bounce Rate" value={bounceRate} format="pct" invertPolarity accent="var(--bp-amber)" />
        {txDelivered != null && <MetricCard label="Transactional 7d" value={txDelivered} accent="var(--bp-text-3)" />}
        {txBounceRate != null && <MetricCard label="TX Bounce 7d" value={txBounceRate} format="pct" invertPolarity accent="var(--bp-red)" />}
      </div>

      {campaigns.length > 0 && (
        <div className="bp-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
            Recent Campaigns ({campaigns.length})
          </div>
          <div style={{ overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bp-border)', color: 'var(--bp-text-3)', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <th style={{ padding: '8px 6px' }}>Name</th>
                  <th style={{ padding: '8px 6px' }}>Sent</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Open %</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Click %</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Bounce %</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.slice(0, 25).map((c, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
                    <td style={{ padding: '8px 6px', color: 'var(--bp-text-2)' }}>{c.name ?? c.subject ?? '—'}</td>
                    <td style={{ padding: '8px 6px', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
                      {c.sentDate ? format(parseISO(c.sentDate), 'MMM d') : '—'}
                    </td>
                    <td style={{ padding: '8px 6px', textAlign: 'right', color: 'var(--bp-green)' }}>{c.openRate != null ? `${(c.openRate * 100).toFixed(1)}%` : '—'}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'right', color: 'var(--bp-blue)' }}>{c.clickRate != null ? `${(c.clickRate * 100).toFixed(1)}%` : '—'}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'right', color: 'var(--bp-amber)' }}>{c.bounceRate != null ? `${(c.bounceRate * 100).toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function BrevoContacts({ metrics }: any) {
  const { latest } = metrics
  const totalContacts = latest['total_contacts'] ?? 0
  const lists = Array.isArray(latest['lists_data']) ? latest['lists_data'] : []
  const noisyKeys = new Set(['totalSubscribers', 'totalBlacklisted'])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <MetricCard label="Total Contacts" value={totalContacts} accent="var(--bp-blue)" />
        <MetricCard label="Lists" value={lists.length} accent="var(--bp-text-3)" />
        <MetricCard label="Avg per List" value={lists.length > 0 ? Math.round(totalContacts / lists.length) : 0} accent="var(--bp-text-3)" />
      </div>

      {lists.length === 0 ? (
        <EmptyState message="No lists found in this Brevo account yet." />
      ) : (
        <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bp-border)', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Contact Lists ({lists.length})
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bp-border)', color: 'var(--bp-text-3)', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th style={{ padding: '8px 16px' }}>List name</th>
                <th style={{ padding: '8px 16px', textAlign: 'right' }}>Total subscribers</th>
                <th style={{ padding: '8px 16px', textAlign: 'right' }}>Blacklisted</th>
                <th style={{ padding: '8px 16px', textAlign: 'right' }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {lists.slice(0, 100).map((l, i) => (
                <tr key={l.id ?? i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '9px 16px', color: 'var(--bp-text)' }}>{l.name ?? `List ${l.id ?? i}`}</td>
                  <td style={{ padding: '9px 16px', textAlign: 'right', color: 'var(--bp-text-2)', fontFamily: 'var(--bp-font-mono)' }}>{(l.totalSubscribers ?? l.uniqueSubscribers ?? 0).toLocaleString()}</td>
                  <td style={{ padding: '9px 16px', textAlign: 'right', color: 'var(--bp-amber)', fontFamily: 'var(--bp-font-mono)' }}>{(l.totalBlacklisted ?? 0).toLocaleString()}</td>
                  <td style={{ padding: '9px 16px', textAlign: 'right', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>{l.createdAt ? format(parseISO(l.createdAt), 'MMM d, yy') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function BrevoTransactional({ metrics, summary }: any) {
  const { latest } = metrics
  const delivered = latest['transactional_delivered_7d'] ?? null
  const bounceRate = latest['transactional_bounce_rate_7d'] ?? null

  if (delivered == null && bounceRate == null) {
    return <EmptyState message="Transactional email data isn't being returned by Brevo for this account. Check that SMTP/transactional is enabled in your Brevo account and re-sync." />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <MetricCard label="Delivered (7d)" value={delivered ?? 0} accent="var(--bp-green)" />
        <MetricCard label="Bounce Rate (7d)" value={bounceRate ?? 0} format="pct" invertPolarity accent="var(--bp-red)" />
        <MetricCard label="Estimated daily" value={delivered != null ? Math.round(delivered / 7) : 0} accent="var(--bp-text-3)" />
      </div>
      <div className="bp-card" style={{ padding: '14px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.6 }}>
        These are aggregated 7-day Brevo SMTP statistics. Full transactional logs (per-message
        delivery status, opens, clicks) require Brevo's Marketing API tier — not surfaced here yet.
        High bounce rate (&gt;5%) usually means stale recipient lists or DKIM/SPF issues with your
        sending domain.
      </div>
    </div>
  )
}

function StripeOverview({ metrics }: any) {
  const { latest, series } = metrics
  const mrr = latest['mrr'] ?? 0
  const arr = latest['arr'] ?? mrr * 12
  const activeCustomers = latest['active_customers'] ?? latest['active_subscriptions'] ?? 0
  const churnRate = latest['churn_rate'] ?? 0
  const revSeries = (series['revenue'] || []).map((m: any) => ({
    date: format(parseISO(m.recorded_at), 'MMM d'),
    revenue: m.metric_value,
  }))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="MRR" value={mrr} format="currency" accent="var(--bp-purple)" />
        <MetricCard label="ARR" value={arr} format="currency" accent="var(--bp-blue)" />
        <MetricCard label="Active Subscriptions" value={activeCustomers} accent="var(--bp-green)" />
        <MetricCard label="Churn Rate" value={churnRate} format="pct" invertPolarity accent="var(--bp-red)" />
      </div>
      {revSeries.length > 1 && (
        <div className="bp-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Revenue Over Time</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={revSeries}>
              <defs>
                <linearGradient id="stripeRevGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.purple || '#9d7aff'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.purple || '#9d7aff'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="date" {...chartDefaults.xAxis} />
              <YAxis {...chartDefaults.yAxis} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="revenue" stroke={CHART_COLORS.purple || '#9d7aff'} fill="url(#stripeRevGrad)" strokeWidth={2} name="Revenue" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// ─── GitHub Overview ──────────────────────────────────────────────────────────

function GitHubOverview({ metrics }: any) {
  const { latest, series } = metrics
  const openPRs = latest['open_prs'] ?? latest['pull_requests_open'] ?? 0
  const mergedPRs = latest['merged_prs_7d'] ?? latest['merged_prs'] ?? 0
  const openIssues = latest['open_issues'] ?? 0
  const commits = latest['commits_7d'] ?? latest['commits'] ?? 0
  const commitSeries = (series['commits_7d'] || series['commits'] || []).map((m: any) => ({
    date: format(parseISO(m.recorded_at), 'MMM d'),
    commits: m.metric_value,
  }))
  const prs = (() => {
    const raw = latest['pull_requests_data']
    if (!raw) return []
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
  })()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Open PRs" value={openPRs} accent="var(--bp-blue)" />
        <MetricCard label="Merged (7d)" value={mergedPRs} accent="var(--bp-green)" />
        <MetricCard label="Open Issues" value={openIssues} accent="var(--bp-amber)" />
        <MetricCard label="Commits (7d)" value={commits} accent="var(--bp-text-3)" />
      </div>
      {commitSeries.length > 1 && (
        <div className="bp-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Commit Activity</div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={commitSeries}>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="date" {...chartDefaults.xAxis} />
              <YAxis {...chartDefaults.yAxis} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="commits" fill={CHART_COLORS.blue} radius={[2, 2, 0, 0]} name="Commits" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {prs.length > 0 && (
        <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bp-border)', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recent Pull Requests</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
                {['Title', 'State', 'Author', 'Created'].map(h => (
                  <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prs.slice(0, 10).map((pr: any, i: any) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pr.title}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '1px 6px', borderRadius: 2, background: pr.state === 'open' ? 'rgba(0,201,167,0.12)' : 'rgba(77,166,255,0.12)', color: pr.state === 'open' ? 'var(--bp-green)' : 'var(--bp-blue)', textTransform: 'uppercase' }}>{pr.state || 'open'}</span>
                  </td>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{pr.user?.login || pr.author || '—'}</td>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{pr.created_at ? format(parseISO(pr.created_at), 'MMM d') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Shopify Overview ─────────────────────────────────────────────────────────

function ShopifyOverview({ metrics, range }: any) {
  const { latest } = metrics
  const { start, end } = getRangeBounds(range || '30d')
  const prev = getPrevBounds(range || '30d')
  // Use local date strings to avoid UTC shift (e.g. BST midnight → previous UTC day)
  const toLocalStr = (d: any) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  const startStr    = toLocalStr(start)
  const endStr      = toLocalStr(end)
  const prevStartStr = toLocalStr(prev.start)
  const prevEndStr   = toLocalStr(prev.end)

  // Daily revenue series → filter to selected range
  const allDaily = Array.isArray(latest['daily_revenue']) ? latest['daily_revenue'] : []
  const filteredDaily = allDaily.filter(d => d.date >= startStr && d.date <= endStr)
  const prevDaily     = allDaily.filter(d => d.date >= prevStartStr && d.date <= prevEndStr)
  const revenue     = filteredDaily.reduce((s, d) => s + (d.amount || 0), 0)
  const prevRevenue = prevDaily.reduce((s, d) => s + (d.amount || 0), 0)

  // Daily orders series → filter to range
  const allDailyOrders = Array.isArray(latest['orders_daily']) ? latest['orders_daily'] : []
  const filteredDailyOrders = allDailyOrders.filter(d => d.date >= startStr && d.date <= endStr)
  const prevDailyOrders     = allDailyOrders.filter(d => d.date >= prevStartStr && d.date <= prevEndStr)
  const orderCount     = filteredDailyOrders.reduce((s, d) => s + (d.count || 0), 0)
  const prevOrderCount = prevDailyOrders.reduce((s, d) => s + (d.count || 0), 0)
  const aov = orderCount > 0 ? revenue / orderCount : 0

  // Unique buyers in range (from order emails)
  const allOrdersForBuyers = Array.isArray(latest['recent_orders_data']) ? latest['recent_orders_data'] : []
  const rangeOrdersForBuyers = allOrdersForBuyers.filter(o => {
    if (!o.created_at) return false
    const d = new Date(o.created_at)
    return d >= start && d <= end
  })
  const prevRangeOrdersForBuyers = allOrdersForBuyers.filter(o => {
    if (!o.created_at) return false
    const d = new Date(o.created_at)
    return d >= prev.start && d <= prev.end
  })
  const uniqueBuyers = new Set(rangeOrdersForBuyers.map(o => o.customer_id || o.email || o.customer).filter(Boolean)).size
  const prevUniqueBuyers = new Set(prevRangeOrdersForBuyers.map(o => o.customer_id || o.email || o.customer).filter(Boolean)).size

  // Chart series
  const revSeries = filteredDaily.map(d => ({
    date: (() => { try { return format(parseISO(d.date), 'MMM d') } catch { return d.date } })(),
    revenue: d.amount,
  }))

  // Top products: compute from range-filtered orders with line items
  const allOrders = Array.isArray(latest['recent_orders_data']) ? latest['recent_orders_data'] : []
  const rangeOrders = allOrders.filter(o => {
    if (!o.created_at) return false
    const d = new Date(o.created_at)
    return d >= start && d <= end
  })
  const productMap: Record<string, { title: string; quantity: number; revenue: number }> = {}
  for (const o of rangeOrders) {
    for (const item of (o.items || [])) {
      if (!item.title) continue
      if (!productMap[item.title]) productMap[item.title] = { title: item.title, quantity: 0, revenue: 0 }
      const pm = productMap[item.title]!
      pm.quantity += item.quantity || 0
      pm.revenue += (item.price || 0) * (item.quantity || 0)
    }
  }
  const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Revenue" value={revenue} previous={prevRevenue} format="currency" accent="var(--bp-green)" />
        <MetricCard label="Orders" value={orderCount} previous={prevOrderCount} accent="var(--bp-blue)" />
        <MetricCard label="Avg Order Value" value={aov} format="currency" accent="var(--bp-cyan)" />
        <MetricCard label="Buyers" value={uniqueBuyers} previous={prevUniqueBuyers} accent="var(--bp-purple)" />
      </div>

      {revSeries.length > 0 ? (
        <div className="bp-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Daily Revenue</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={revSeries}>
              <defs>
                <linearGradient id="shopifyRevGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.green} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.green} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="date" {...chartDefaults.xAxis} />
              <YAxis {...chartDefaults.yAxis} tickFormatter={(v) => `£${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
              <Tooltip content={<CustomTooltip />} formatter={(v) => [`£${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`, 'Revenue']} />
              <Area type="monotone" dataKey="revenue" stroke={CHART_COLORS.green} fill="url(#shopifyRevGrad)" strokeWidth={2} name="Revenue" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="bp-card" style={{ padding: '24px 18px', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>No revenue data for this period.</div>
        </div>
      )}

      {topProducts.length > 0 && (
        <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bp-border)', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Top Products — {(RANGE_LABELS as any)[range] || range}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
                {['Product', 'Units Sold', 'Revenue'].map(h => (
                  <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topProducts.slice(0, 10).map((p: any, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title || p.name}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{(p.units || p.quantity || 0).toLocaleString()}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-green)' }}>£{Number(p.revenue || 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Shopify Orders Tab ───────────────────────────────────────────────────────

function ShopifyOrders({ metrics, range }: any) {
  const { start, end } = getRangeBounds(range || '30d')
  const allOrders = Array.isArray(metrics.latest['recent_orders_data'])
    ? metrics.latest['recent_orders_data']
    : metrics.latest['recent_orders_data']
      ? (typeof metrics.latest['recent_orders_data'] === 'string' ? JSON.parse(metrics.latest['recent_orders_data']) : metrics.latest['recent_orders_data'])
      : []

  const orders = allOrders.filter((o: any) => {
    if (!o.created_at) return true
    const d = new Date(o.created_at)
    return d >= start && d <= end
  })

  if (!allOrders.length) {
    return <EmptyState message="Order data will appear here after sync." />
  }
  if (!orders.length) {
    return <EmptyState message={`No orders found in this period. Try a wider range.`} />
  }

  const statusColors = {
    fulfilled:   { bg: 'var(--bp-green)', text: '#fff' },
    unfulfilled: { bg: 'var(--bp-amber)', text: '#000' },
    partial:     { bg: 'var(--bp-amber)', text: '#000' },
    refunded:    { bg: 'var(--bp-red)',   text: '#fff' },
    cancelled:   { bg: 'var(--bp-red)',   text: '#fff' },
    pending:     { bg: 'var(--bp-text-3)', text: '#fff' },
  }

  const counts = orders.reduce((acc: any, o: any) => {
    const s = (o.fulfillment_status || o.status || 'pending').toLowerCase()
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {Object.entries(counts).map(([status, count]) => {
          const c = (statusColors as any)[status] || { bg: 'var(--bp-text-3)', text: '#fff' }
          return (
            <span key={status} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 20,
              background: `${c.bg}22`, border: `1px solid ${c.bg}55`,
              fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: c.bg,
              textTransform: 'capitalize',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.bg, display: 'inline-block' }} />
              {status}: {count as any}
            </span>
          )
        })}
      </div>

      {/* Orders table */}
      <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['Order #', 'Date', 'Status', 'Customer', 'Items', 'Total'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((o: any, i: any) => {
              const rawStatus = (o.fulfillment_status || o.status || 'pending').toLowerCase()
              const c = (statusColors as any)[rawStatus] || { bg: 'var(--bp-text-3)', text: '#fff' }
              const dateStr = o.created_at ? (() => { try { return format(parseISO(o.created_at), 'MMM d, yyyy') } catch { return o.created_at } })() : '—'
              const customerName = typeof o.customer === 'string' ? (o.customer || '—') : (o.customer_name || o.email || '—')
              const itemCount = o.item_count || o.items_count || (o.line_items ? o.line_items.length : 0)
              const total = o.total_price || o.total || 0
              return (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-blue)' }}>#{o.order_number || o.name || o.id}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', whiteSpace: 'nowrap' }}>{dateStr}</td>
                  <td style={{ padding: '9px 16px' }}>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                      background: `${c.bg}22`, border: `1px solid ${c.bg}55`,
                      fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: c.bg,
                      textTransform: 'capitalize',
                    }}>
                      {rawStatus}
                    </span>
                  </td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{customerName}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', textAlign: 'center' }}>{itemCount}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-green)' }}>£{Number(total).toLocaleString('en-GB', { minimumFractionDigits: 2 })}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Shopify Products Tab ─────────────────────────────────────────────────────

function ShopifyProducts({ metrics }: any) {
  const [view, setView] = useState('table')
  const products = metrics.latest['products_data']
    ? (typeof metrics.latest['products_data'] === 'string'
        ? JSON.parse(metrics.latest['products_data'])
        : metrics.latest['products_data'])
    : []

  if (!products || products.length === 0) {
    return <EmptyState message="Product data will appear here after sync." />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* View toggle */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ display: 'flex', background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border)', borderRadius: 5, overflow: 'hidden' }}>
          {['table', 'grid'].map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '5px 12px', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                background: view === v ? 'var(--bp-border)' : 'transparent',
                color: view === v ? 'var(--bp-text)' : 'var(--bp-text-3)',
                transition: 'all 120ms ease',
                textTransform: 'capitalize',
              }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === 'table' ? (
        <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
                {['Title', 'Status', 'Price Range', 'Inventory'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 200).map((p: any, i: any) => {
                const isActive = (p.status || 'active').toLowerCase() === 'active'
                const priceDisplay = p.price ? `£${Number(p.price).toFixed(2)}` : '—'
                const invDisplay = p.inventory === null || p.inventory === undefined
                  ? <span style={{ color: 'var(--bp-text-3)' }}>untracked</span>
                  : <span style={{ color: p.inventory < 10 ? 'var(--bp-amber)' : 'var(--bp-text-2)' }}>{Number(p.inventory).toLocaleString()}</span>
                return (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</td>
                    <td style={{ padding: '9px 16px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: isActive ? 'var(--bp-green)' : 'var(--bp-amber)', textTransform: 'capitalize' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: isActive ? 'var(--bp-green)' : 'var(--bp-amber)', display: 'inline-block' }} />
                        {p.status || 'active'}
                      </span>
                    </td>
                    <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{priceDisplay}</td>
                    <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>{invDisplay}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {products.slice(0, 100).map((p: any, i: any) => {
            const isActive = (p.status || 'active').toLowerCase() === 'active'
            const priceDisplay = p.price ? `£${Number(p.price).toFixed(2)}` : '—'
            const inv = p.inventory
            return (
              <div key={i} className="bp-card" style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: isActive ? 'var(--bp-green)' : 'var(--bp-amber)', textTransform: 'capitalize' }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: isActive ? 'var(--bp-green)' : 'var(--bp-amber)', display: 'inline-block' }} />
                    {p.status || 'active'}
                  </span>
                  {inv !== null && inv !== undefined
                    ? <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: inv < 10 ? 'var(--bp-amber)' : 'var(--bp-text-3)' }}>{inv} in stock</span>
                    : <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>untracked</span>
                  }
                </div>
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', marginBottom: 6, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {p.title}
                </div>
                <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-green)' }}>{priceDisplay}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Shopify Customers Tab ────────────────────────────────────────────────────

function ShopifyCustomers({ metrics, range }: any) {
  const { start } = getRangeBounds(range || '30d')

  const allRows = Array.isArray(metrics.latest['customers_data'])
    ? metrics.latest['customers_data']
    : metrics.latest['customers_data']
      ? (typeof metrics.latest['customers_data'] === 'string' ? JSON.parse(metrics.latest['customers_data']) : metrics.latest['customers_data'])
      : []

  const totalCustomers = metrics.latest['customers'] ?? 0
  // New customers = joined within the selected range
  const newInPeriod = allRows.filter((c: any) => c.created_at && new Date(c.created_at) >= start).length

  const rows = allRows

  if (!rows || rows.length === 0) {
    return <EmptyState message="Customer data will appear here after sync." />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <MetricCard label="Total Customers" value={totalCustomers} accent="var(--bp-purple)" />
        <MetricCard label={`New in ${(RANGE_LABELS as any)[range] || range}`} value={newInPeriod} accent="var(--bp-green)" />
        <MetricCard label="Avg Spend" value={rows.length ? rows.reduce((s: any, c: any) => s + (c.total_spent || 0), 0) / rows.length : 0} format="currency" accent="var(--bp-cyan)" />
      </div>

      {/* Customers table */}
      <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['Email', 'Name', 'Orders', 'Total Spent', 'Last Order'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((c: any, i: any) => {
              const name = c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—'
              const isNew = c.created_at && new Date(c.created_at) >= start
              const lastOrder = c.last_order_date || c.updated_at
              const lastOrderStr = lastOrder ? (() => { try { return format(parseISO(lastOrder), 'MMM d, yyyy') } catch { return lastOrder } })() : '—'
              return (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email || '—'}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
                    {name}
                    {isNew && <span style={{ marginLeft: 6, fontSize: 8, color: 'var(--bp-green)', background: 'var(--bp-green)18', border: '1px solid var(--bp-green)40', padding: '1px 5px', borderRadius: 8 }}>NEW</span>}
                  </td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', textAlign: 'center' }}>{(c.orders_count ?? c.total_orders ?? 0).toLocaleString()}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-green)' }}>£{Number(c.total_spent || 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', whiteSpace: 'nowrap' }}>{lastOrderStr}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Shopify Inventory Tab ────────────────────────────────────────────────────

function ShopifyInventory({ metrics }: any) {
  const inventoryData = metrics.latest['inventory_data']
    ? (typeof metrics.latest['inventory_data'] === 'string'
        ? JSON.parse(metrics.latest['inventory_data'])
        : metrics.latest['inventory_data'])
    : null

  const rows = Array.isArray(inventoryData) ? inventoryData : (inventoryData?.inventory_levels || inventoryData?.items || [])

  if (!rows || rows.length === 0) {
    return <EmptyState message="Inventory data will appear here after sync." />
  }

  const getQty = (r: any) => parseInt(r.inventory ?? r.available ?? r.quantity ?? r.inventory_quantity ?? 0)

  const lowStock = rows.filter((r: any) => getQty(r) < 10)
    .sort((a: any, b: any) => getQty(a) - getQty(b))

  const getStatus = (qty: any) => {
    if (qty <= 0)  return { label: 'Out of Stock', color: 'var(--bp-red)' }
    if (qty < 5)   return { label: 'Critical',     color: 'var(--bp-red)' }
    if (qty < 10)  return { label: 'Low Stock',    color: 'var(--bp-amber)' }
    return             { label: 'OK',             color: 'var(--bp-green)' }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Low stock alerts */}
      {lowStock.length > 0 && (
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Low Stock Alerts ({lowStock.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {lowStock.slice(0, 12).map((item: any, i: any) => {
              const qty = getQty(item)
              const status = getStatus(qty)
              return (
                <div key={i} className="bp-card" style={{ padding: '12px 14px', borderLeft: `3px solid ${status.color}` }}>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.product_title || item.title || item.name || '—'}
                  </div>
                  {(item.variant_title || item.sku) && (
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginBottom: 6 }}>
                      {item.variant_title || item.sku}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 18, color: status.color }}>{qty}</span>
                    <span style={{
                      fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: status.color,
                      background: `${status.color}22`, border: `1px solid ${status.color}44`,
                      padding: '2px 7px', borderRadius: 10,
                    }}>{status.label}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Full inventory table */}
      <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--bp-border)', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          All Inventory ({rows.length} variants)
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['Product', 'Variant', 'SKU', 'Available', 'Status'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((item: any, i: any) => {
              const qty = getQty(item)
              const status = getStatus(qty)
              return (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.product_title || item.title || item.name || '—'}
                  </td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.variant_title || item.option1 || '—'}
                  </td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
                    {item.sku || '—'}
                  </td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: status.color, fontWeight: qty < 10 ? 600 : 400 }}>
                    {qty}
                  </td>
                  <td style={{ padding: '9px 16px' }}>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                      background: `${status.color}22`, border: `1px solid ${status.color}44`,
                      fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: status.color,
                    }}>
                      {status.label}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── GA4 Pages Tab ────────────────────────────────────────────────────────────

function GA4Pages({ metrics }: any) {
  const raw = metrics.latest['top_pages_data']
    ?? metrics.latest['pages_data']
    ?? (Array.isArray(metrics.latest['top_pages']) ? metrics.latest['top_pages'] : null)
  const pages = raw
    ? (typeof raw === 'string' ? JSON.parse(raw) : raw)
    : []

  if (!pages || pages.length === 0) {
    return <EmptyState message="Page analytics data will appear here after sync." />
  }

  const sorted = [...pages].sort((a, b) => (b.pageviews || b.screenPageViews || 0) - (a.pageviews || a.screenPageViews || 0))

  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
            {['Page URL', 'Pageviews', 'Users', 'Bounce Rate', 'Avg Time'].map(h => (
              <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 50).map((p, i) => {
            const url = p.page || p.pagePath || p.url || p.dimensionValues?.[0]?.value || '—'
            const pageviews = p.pageviews || p.screenPageViews || 0
            const users = p.users || p.activeUsers || 0
            const bounceRate = p.bounceRate || p.bounce_rate || 0
            const avgTime = p.avgSessionDuration || p.avg_time || p.engagementRate || 0
            const avgTimeStr = typeof avgTime === 'number' && avgTime > 1
              ? `${Math.floor(avgTime / 60)}m ${Math.round(avgTime % 60)}s`
              : avgTime > 0 ? `${(avgTime * 100).toFixed(0)}%` : '—'
            return (
              <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={url}>
                  {url}
                </td>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{Number(pageviews).toLocaleString()}</td>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{Number(users).toLocaleString()}</td>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: bounceRate > 0.7 ? 'var(--bp-red)' : bounceRate > 0.5 ? 'var(--bp-amber)' : 'var(--bp-text-2)' }}>
                  {typeof bounceRate === 'number' && bounceRate <= 1 ? `${(bounceRate * 100).toFixed(1)}%` : bounceRate > 1 ? `${bounceRate.toFixed(1)}%` : '—'}
                </td>
                <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>{avgTimeStr}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── GA4 Acquisition Tab ──────────────────────────────────────────────────────

const CHANNEL_COLORS = {
  'Organic Search': CHART_COLORS.blue,
  'Direct':         CHART_COLORS.green,
  'Social':         CHART_COLORS.purple,
  'Referral':       CHART_COLORS.cyan,
  'Email':          CHART_COLORS.amber,
  'Paid Search':    CHART_COLORS.red,
  'Organic Social': CHART_COLORS.purple,
  'Unassigned':     '#666',
}

function GA4Acquisition({ metrics }: any) {
  const raw = metrics.latest['traffic_sources_data']
    ?? metrics.latest['acquisition_data']
    ?? (Array.isArray(metrics.latest['traffic_sources']) ? metrics.latest['traffic_sources'] : null)
  const channels = raw
    ? (typeof raw === 'string' ? JSON.parse(raw) : raw)
    : []

  if (!channels || channels.length === 0) {
    return <EmptyState message="Acquisition data will appear here after sync." />
  }

  const channelOrder = ['Organic Search', 'Direct', 'Social', 'Referral', 'Email', 'Paid Search', 'Organic Social']
  const sorted = [...channels].sort((a, b) => {
    const ia = channelOrder.indexOf(a.channel || a.source || a.medium || '')
    const ib = channelOrder.indexOf(b.channel || b.source || b.medium || '')
    const sessA = a.sessions || a.users || 0
    const sessB = b.sessions || b.users || 0
    if (ia === -1 && ib === -1) return sessB - sessA
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })

  const chartData = sorted.slice(0, 8).map(c => ({
    name: c.channel || c.source || c.medium || 'Unknown',
    sessions: c.sessions || c.users || 0,
    users: c.users || 0,
  }))

  const totalSessions = sorted.reduce((s, c) => s + (c.sessions || c.users || 0), 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Bar chart */}
      <div className="bp-card" style={{ padding: '16px 18px' }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Sessions by Channel</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 4, bottom: 4 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" horizontal={false} />
            <XAxis type="number" {...chartDefaults.xAxis} />
            <YAxis type="category" dataKey="name" {...chartDefaults.yAxis} width={120} tick={{ ...chartDefaults.yAxis.tick, fontSize: 10 }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="sessions" name="Sessions" radius={[0, 2, 2, 0]}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={(CHANNEL_COLORS as any)[entry.name] || CHART_COLORS.blue} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Breakdown table */}
      <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['Channel', 'Sessions', 'Users', 'Share', 'Bounce Rate'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((c, i) => {
              const channelName = c.channel || c.source || c.medium || 'Unknown'
              const sessions = c.sessions || c.users || 0
              const users = c.users || 0
              const share = totalSessions > 0 ? (sessions / totalSessions) * 100 : 0
              const bounceRate = c.bounceRate || c.bounce_rate || 0
              const dotColor = (CHANNEL_COLORS as any)[channelName] || CHART_COLORS.blue
              return (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '9px 16px' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
                      {channelName}
                    </span>
                  </td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{sessions.toLocaleString()}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{users > 0 ? users.toLocaleString() : '—'}</td>
                  <td style={{ padding: '9px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 4, background: 'var(--bp-surface-2)', borderRadius: 2, minWidth: 60 }}>
                        <div style={{ width: `${share}%`, height: '100%', background: dotColor, borderRadius: 2 }} />
                      </div>
                      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', minWidth: 36 }}>{share.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
                    {bounceRate > 0 ? (bounceRate <= 1 ? `${(bounceRate * 100).toFixed(1)}%` : `${bounceRate.toFixed(1)}%`) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ message = 'No data available yet. Run a sync to pull data.' }: any) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '60px 20px', textAlign: 'center',
      background: 'var(--bp-surface-2)', border: '1px dashed var(--bp-border)', borderRadius: 8,
    }}>
      <Database size={28} style={{ color: 'var(--bp-text-3)', marginBottom: 12 }} />
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', maxWidth: 320 }}>{message}</div>
    </div>
  )
}

// ─── Meta Ads tabs ────────────────────────────────────────────────────────────

function metaNum(metrics: any, name: any) {
  const row = metrics?.find((m: any) => m.metric_name === name)
  return row?.metric_value != null ? Number(row.metric_value) : 0
}
function metaData(metrics: any, name: any) {
  const row = metrics?.find((m: any) => m.metric_name === name)
  if (!row?.metric_data) return null
  try { return typeof row.metric_data === 'string' ? JSON.parse(row.metric_data) : row.metric_data }
  catch { return null }
}
function fmtCurrency(n: any, ccy: any = '£') {
  const num = Number(n) || 0
  return `${ccy}${num.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtInt(n: any) {
  return Math.round(Number(n) || 0).toLocaleString('en-GB')
}

function MetaAdsOverview({ metrics }: any) {
  const spend      = metaNum(metrics, 'meta-ads.spend_30d')
  const revenue    = metaNum(metrics, 'meta-ads.revenue_30d')
  const roas       = metaNum(metrics, 'meta-ads.roas')
  const purchases  = metaNum(metrics, 'meta-ads.purchases_30d')
  const reach      = metaNum(metrics, 'meta-ads.reach_30d')
  const frequency  = metaNum(metrics, 'meta-ads.frequency')
  const prevSpend  = metaNum(metrics, 'meta-ads.prev_spend_30d')
  const prevRev    = metaNum(metrics, 'meta-ads.prev_revenue_30d')

  const roasColor = roas >= 3 ? 'var(--bp-green)' : roas >= 1 ? 'var(--bp-amber)' : 'var(--bp-red)'

  const cards = [
    { label: 'Spend (30d)',  value: fmtCurrency(spend) },
    { label: 'Revenue',      value: fmtCurrency(revenue) },
    { label: 'ROAS',         value: `${roas.toFixed(2)}x`, color: roasColor },
    { label: 'Purchases',    value: fmtInt(purchases) },
    { label: 'Reach',        value: fmtInt(reach) },
    { label: 'Frequency',    value: frequency.toFixed(2) },
  ]

  const comparison = [
    { period: 'Previous', spend: prevSpend, revenue: prevRev },
    { period: 'Current',  spend,            revenue },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
        {cards.map((c) => (
          <div key={c.label} className="bp-card" style={{ padding: 14 }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 20, fontWeight: 700, color: c.color ?? 'var(--bp-text)' }}>{c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16 }}>
        <div className="bp-card">
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 12 }}>ROAS Gauge</div>
          <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
            <Gauge value={roas} max={5} goodThreshold={3} needsWorkThreshold={1} label="ROAS" unit="x" />
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textAlign: 'center', marginTop: 8 }}>
            {roas >= 3 ? 'Strong return' : roas >= 1 ? 'Break-even zone' : 'Below break-even'}
          </div>
        </div>
        <div className="bp-card">
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 12 }}>Spend vs Revenue</div>
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={comparison}>
                <CartesianGrid stroke="rgba(77,166,255,0.06)" strokeDasharray="3 3" />
                <XAxis dataKey="period" tick={{ fill: '#4d7a96', fontSize: 10 }} />
                <YAxis tick={{ fill: '#4d7a96', fontSize: 10 }} />
                <Tooltip contentStyle={{ background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border)', fontSize: 11 }} />
                <Bar dataKey="spend"   fill="#ff5252" name="Spend"   />
                <Bar dataKey="revenue" fill="#00c9a7" name="Revenue" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}

function MetaAdsCampaigns({ metrics }: any) {
  const campaigns = metaData(metrics, 'meta-ads.campaigns_data') ?? []
  if (campaigns.length === 0) return <EmptyState message="No campaign data available yet. Sync the connector to pull the last 30 days of performance." />
  const sorted = [...campaigns].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0))

  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'var(--bp-surface-2)' }}>
            {['Campaign', 'Objective', 'Spend', 'Revenue', 'ROAS', 'CTR', 'CPM', 'Reach'].map((h, i) => (
              <th key={h} style={{ padding: '10px 12px', textAlign: i < 2 ? 'left' : 'right', fontSize: 9, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--bp-text-3)', fontWeight: 500 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c, i) => {
            const roasCol = c.roas >= 3 ? 'var(--bp-green)' : c.roas >= 1 ? 'var(--bp-amber)' : 'var(--bp-red)'
            return (
              <tr key={c.id ?? i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
                <td style={{ padding: '10px 12px', color: 'var(--bp-text)', fontWeight: 500 }}>{c.name}</td>
                <td style={{ padding: '10px 12px', color: 'var(--bp-text-2)' }}>{c.objective ?? '—'}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--bp-text-2)' }}>{fmtCurrency(c.spend)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--bp-text-2)' }}>{fmtCurrency(c.revenue)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: roasCol, fontWeight: 600 }}>{(c.roas ?? 0).toFixed(2)}x</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--bp-text-2)' }}>{((c.ctr ?? 0) * 100).toFixed(2)}%</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--bp-text-2)' }}>{fmtCurrency(c.cpm)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--bp-text-2)' }}>{fmtInt(c.reach)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Tab content router ───────────────────────────────────────────────────────

function renderTab(connector: any, tab: any, data: any, range: any) {
  const { type } = connector
  const { metrics, summary } = data

  if (tab === 'Raw Data') return <RawDataTab data={data} />

  if (type === 'gsc') {
    if (tab === 'Overview') return <GSCOverview metrics={metrics} />
    if (tab === 'Keywords') return <GSCKeywords metrics={metrics} />
    if (tab === 'Pages') return <GSCPages metrics={metrics} />
  }
  if (type === 'ga4') {
    if (tab === 'Overview') return <GA4Overview metrics={metrics} />
    if (tab === 'Traffic') return <GA4Traffic metrics={metrics} />
    if (tab === 'Pages') return <GA4Pages metrics={metrics} />
    if (tab === 'Acquisition') return <GA4Acquisition metrics={metrics} />
  }
  if (type === 'pagespeed') {
    if (tab === 'Overview') return <PSOverview metrics={metrics} />
    if (tab === 'Mobile') return <PSOverview metrics={metrics} />
    if (tab === 'Desktop') return <PSDesktop metrics={metrics} />
    if (tab === 'History') return <PSHistory metrics={metrics} />
    if (tab === 'Opportunities') return <PSOpportunities metrics={metrics} connector={connector} />
  }
  if (type === 'stripe') {
    if (tab === 'Overview') return <StripeOverview metrics={metrics} />
    if (tab === 'Revenue') return <EmptyState message="Detailed revenue breakdown coming soon." />
    if (tab === 'Customers') return <EmptyState message="Stripe customer list coming soon." />
    if (tab === 'Subscriptions') return <EmptyState message="Subscription management coming soon." />
    if (tab === 'Payouts') return <EmptyState message="Payout history coming soon." />
  }
  if (type === 'github') {
    if (tab === 'Overview') return <GitHubOverview metrics={metrics} />
    if (tab === 'Pull Requests') return <EmptyState message="Detailed PR list coming soon." />
    if (tab === 'Issues') return <EmptyState message="Issue tracker coming soon." />
    if (tab === 'Deployments') return <EmptyState message="Deployment history coming soon." />
  }
  if (type === 'shopify') {
    if (tab === 'Overview') return <ShopifyOverview metrics={metrics} range={range} />
    if (tab === 'Orders') return <ShopifyOrders metrics={metrics} range={range} />
    if (tab === 'Products') return <ShopifyProducts metrics={metrics} />
    if (tab === 'Customers') return <ShopifyCustomers metrics={metrics} range={range} />
    if (tab === 'Inventory') return <ShopifyInventory metrics={metrics} />
  }
  if (type === 'meta-ads') {
    if (tab === 'Overview')  return <MetaAdsOverview  metrics={metrics} />
    if (tab === 'Campaigns') return <MetaAdsCampaigns metrics={metrics} />
    if (tab === 'Audiences') return <EmptyState message="Ad set and audience breakdown coming soon." />
    if (tab === 'Creative')  return <EmptyState message="Creative performance breakdown coming soon." />
  }
  if (type === 'brevo') {
    if (tab === 'Overview') return <BrevoOverview metrics={metrics} summary={summary} />
    if (tab === 'Campaigns') return <BrevoOverview metrics={metrics} summary={summary} />
    if (tab === 'Contacts') return <BrevoContacts metrics={metrics} />
    if (tab === 'Transactional') return <BrevoTransactional metrics={metrics} summary={summary} />
  }
  if (type === 'klaviyo') {
    if (tab === 'Overview')  return <KlaviyoOverview  metrics={metrics} />
    if (tab === 'Campaigns') return <KlaviyoCampaigns metrics={metrics} />
    if (tab === 'Flows')     return <KlaviyoFlows     metrics={metrics} />
    if (tab === 'Lists')     return <KlaviyoLists     metrics={metrics} />
  }
  if (type === 'semrush') {
    if (tab === 'Overview')      return <SemrushOverview      metrics={metrics} />
    if (tab === 'Keywords')      return <SemrushKeywords      metrics={metrics} />
    if (tab === 'Competitors')   return <SemrushCompetitors   metrics={metrics} />
    if (tab === 'Opportunities') return <SemrushOpportunities metrics={metrics} />
  }
  if (type === 'social') {
    if (tab === 'Overview')  return <SocialOverview metrics={metrics} />
    if (tab === 'Facebook')  return <SocialOverview metrics={metrics} />
    if (tab === 'Instagram') return <SocialOverview metrics={metrics} />
    if (tab === 'Posts')     return <SocialPosts    metrics={metrics} />
  }
  if (type === 'buffer') {
    if (tab === 'Overview')     return <BufferOverview     metrics={metrics} />
    if (tab === 'Queue')        return <BufferQueue        metrics={metrics} />
    if (tab === 'Recent Posts') return <BufferRecentPosts  metrics={metrics} />
  }
  if (type === 'wix') {
    if (tab === 'Overview')   return <WixOverview   metrics={metrics} />
    if (tab === 'Pages')      return <WixPages      metrics={metrics} />
    if (tab === 'Blog')       return <WixBlog       metrics={metrics} />
    if (tab === 'SEO Audit')  return <WixSeoAudit   metrics={metrics} />
  }
  if (type === 'server-access') {
    if (tab === 'Overview')       return <ServerAccessOverview      connector={connector} metrics={metrics} />
    if (tab === 'File Explorer')  return <ServerAccessFileExplorer  metrics={metrics} />
    if (tab === 'Error Log')      return <ServerAccessErrorLog      metrics={metrics} />
    if (tab === 'Changes')        return <ServerAccessChanges       connector={connector} />
    if (tab === 'Backups')        return <ServerAccessBackups       connector={connector} />
  }

  return <EmptyState message="This view is coming soon." />
}

// ─── Klaviyo / SEMrush / Social / Buffer Tabs ───────────────────────────────

// Small table cell helpers used across the new connector tabs. Kept local
// to this file; consistent with existing inline-styled tables elsewhere.
function Th({ children, align = 'left' }: any) {
  return (
    <th style={{
      textAlign: align, padding: '10px 12px', fontWeight: 600,
      color: 'var(--bp-text-3)', fontSize: 10, letterSpacing: '0.08em',
      textTransform: 'uppercase', borderBottom: '1px solid var(--bp-border)',
    }}>
      {children}
    </th>
  )
}
function Td({ children, align = 'left', style }: any) {
  return (
    <td style={{
      textAlign: align, padding: '9px 12px', color: 'var(--bp-text-2)',
      ...(style ?? {}),
    }}>
      {children}
    </td>
  )
}

function num(v: any, fallback: any = 0) {
  if (v === null || v === undefined) return fallback
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

function latestValue(metrics: any, key: any) {
  return num(metrics?.latest?.[key] ?? null)
}

function latestData(metrics: any, key: any) {
  const m = metrics?.series?.[key] ?? []
  const withData = m.find((r: any) => r.metric_data)
  if (!withData) return null
  try {
    return typeof withData.metric_data === 'string'
      ? JSON.parse(withData.metric_data)
      : withData.metric_data
  } catch { return null }
}

function KlaviyoOverview({ metrics }: any) {
  const attributed = latestValue(metrics, 'klaviyo.total_attributed_revenue_30d')
  const perEmail = latestValue(metrics, 'klaviyo.revenue_per_email_sent')
  const subs = latestValue(metrics, 'klaviyo.total_subscribers')
  const unsub = latestValue(metrics, 'klaviyo.unsubscribe_rate_30d') * 100
  const openRate = latestValue(metrics, 'klaviyo.campaign_open_rate') * 100
  const clickRate = latestValue(metrics, 'klaviyo.campaign_click_rate') * 100
  const campaignRev = latestValue(metrics, 'klaviyo.campaign_revenue_30d')
  const flowRev = latestValue(metrics, 'klaviyo.flow_revenue_30d')
  const acRev = latestValue(metrics, 'klaviyo.flow_abandoned_cart_revenue')
  const healthColor = openRate >= 20 ? 'var(--bp-green)'
                   : openRate >= 15 ? 'var(--bp-amber)'
                   : 'var(--bp-red)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <MetricCard label="Attributed Revenue (30d)" value={attributed} format="currency" accent="var(--bp-green)" />
        <MetricCard label="Revenue / Email Sent" value={perEmail} format="currency" />
        <MetricCard label="Active Subscribers" value={subs} />
        <MetricCard label="Unsubscribe Rate" value={unsub} format="pct" invertPolarity accent={unsub > 0.5 ? 'var(--bp-red)' : undefined} />
        <MetricCard label="Campaign Open Rate" value={openRate} format="pct" accent={healthColor} />
        <MetricCard label="Campaign Click Rate" value={clickRate} format="pct" />
      </div>
      <div className="bp-card" style={{ padding: 16 }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
          Revenue breakdown (last 30 days)
        </div>
        <div style={{ display: 'flex', gap: 2, height: 28, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
          {(() => {
            const total = campaignRev + flowRev
            if (total === 0) return <div style={{ flex: 1, background: 'var(--bp-surface-2)' }} />
            return [
              <div key="c" style={{ flex: campaignRev, background: 'var(--bp-blue)' }} title={`Campaigns £${campaignRev.toFixed(0)}`} />,
              <div key="f" style={{ flex: flowRev, background: 'var(--bp-green)' }} title={`Flows £${flowRev.toFixed(0)}`} />,
            ]
          })()}
        </div>
        <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
          <div><span style={{ color: 'var(--bp-blue)' }}>●</span> Campaigns: £{campaignRev.toFixed(0)}</div>
          <div><span style={{ color: 'var(--bp-green)' }}>●</span> Flows: £{flowRev.toFixed(0)} (abandoned cart £{acRev.toFixed(0)})</div>
        </div>
      </div>
    </div>
  )
}

function KlaviyoCampaigns({ metrics }: any) {
  const rows = latestData(metrics, 'klaviyo.campaigns_data') ?? []
  if (!rows.length) return <EmptyState message="No campaigns in the last 30 days." />
  const sorted = [...rows].sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
          <Th>Campaign</Th><Th>Sent</Th><Th align="right">Recipients</Th><Th align="right">Open %</Th><Th align="right">Click %</Th><Th align="right">Revenue</Th>
        </tr></thead>
        <tbody>{sorted.map((c, i) => (
          <tr key={c.id || i} style={{ borderBottom: '1px solid var(--bp-border)', background: i === 0 ? 'rgba(0,201,167,0.05)' : 'transparent' }}>
            <Td><strong>{c.name}</strong></Td>
            <Td>{c.send_time ? format(parseISO(c.send_time), 'MMM d') : '—'}</Td>
            <Td align="right">{(c.recipients || 0).toLocaleString()}</Td>
            <Td align="right">{((c.open_rate || 0) * 100).toFixed(1)}%</Td>
            <Td align="right">{((c.click_rate || 0) * 100).toFixed(1)}%</Td>
            <Td align="right">£{(c.revenue || 0).toFixed(0)}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function KlaviyoFlows({ metrics }: any) {
  const rows = latestData(metrics, 'klaviyo.flows_data') ?? []
  if (!rows.length) return <EmptyState message="No live flows detected." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
          <Th>Flow</Th><Th>Class</Th><Th>Status</Th><Th align="right">Recipients</Th><Th align="right">Revenue (30d)</Th><Th align="right">£ / Recipient</Th>
        </tr></thead>
        <tbody>{rows.map((f: any, i: any) => (
          <tr key={f.id || i} style={{ borderBottom: '1px solid var(--bp-border)', background: f.class === 'abandoned_cart' && (f.revenue || 0) > 0 ? 'rgba(0,201,167,0.05)' : 'transparent' }}>
            <Td><strong>{f.name}</strong></Td>
            <Td>{f.class || '—'}</Td>
            <Td>{f.status}</Td>
            <Td align="right">{(f.recipients || 0).toLocaleString()}</Td>
            <Td align="right">£{(f.revenue || 0).toFixed(0)}</Td>
            <Td align="right">£{(f.revenue_per_recipient || 0).toFixed(2)}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function KlaviyoLists({ metrics }: any) {
  const rows = latestData(metrics, 'klaviyo.lists_data') ?? []
  if (!rows.length) return <EmptyState message="No lists found." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}><Th>List</Th><Th align="right">Subscribers</Th><Th>Opt-in</Th><Th>Created</Th></tr></thead>
        <tbody>{rows.map((l: any, i: any) => (
          <tr key={l.id || i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
            <Td><strong>{l.name}</strong></Td>
            <Td align="right">{(l.profile_count || 0).toLocaleString()}</Td>
            <Td>{l.opt_in_process || '—'}</Td>
            <Td>{l.created ? format(parseISO(l.created), 'MMM yyyy') : '—'}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function SemrushOverview({ metrics }: any) {
  const rank = latestValue(metrics, 'semrush.domain_rank')
  const keywords = latestValue(metrics, 'semrush.organic_keywords_total')
  const traffic = latestValue(metrics, 'semrush.organic_traffic_estimate')
  const value = latestValue(metrics, 'semrush.organic_cost_estimate')
  const top3 = latestValue(metrics, 'semrush.keywords_top3')
  const top10 = latestValue(metrics, 'semrush.keywords_top10')
  const top20 = latestValue(metrics, 'semrush.keywords_top20')
  const gained = latestValue(metrics, 'semrush.keywords_positions_gained_7d')
  const lost = latestValue(metrics, 'semrush.keywords_positions_lost_7d')

  const bars = [
    { label: 'Top 3', count: top3, color: 'var(--bp-green)' },
    { label: 'Top 10', count: top10 - top3, color: 'var(--bp-blue)' },
    { label: 'Top 20', count: top20, color: 'var(--bp-amber)' },
  ]
  const maxBar = Math.max(1, ...bars.map(b => b.count))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Domain Rank" value={rank} />
        <MetricCard label="Organic Keywords" value={keywords} />
        <MetricCard label="Est. Monthly Traffic" value={traffic} accent="var(--bp-blue)" />
        <MetricCard label="Traffic Value" value={value} format="currency" accent="var(--bp-green)" />
      </div>
      <div className="bp-card" style={{ padding: 16 }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
          Position distribution
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', height: 120, marginBottom: 8 }}>
          {bars.map(b => (
            <div key={b.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div style={{ width: '100%', height: Math.round((b.count / maxBar) * 90) || 2, background: b.color, borderRadius: '2px 2px 0 0' }} />
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, fontWeight: 700 }}>{b.count}</div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>{b.label}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
          <div><span style={{ color: 'var(--bp-green)' }}>▲</span> {gained} gained (7d)</div>
          <div><span style={{ color: 'var(--bp-red)' }}>▼</span> {lost} lost (7d)</div>
        </div>
      </div>
    </div>
  )
}

function SemrushKeywords({ metrics }: any) {
  const rows = latestData(metrics, 'semrush.top_keywords_data') ?? []
  if (!rows.length) return <EmptyState message="No keyword data yet. Sync the connector." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden', maxHeight: 600, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)', position: 'sticky', top: 0 }}>
          <Th>Keyword</Th><Th align="right">Pos</Th><Th align="right">Δ</Th><Th align="right">Volume</Th><Th align="right">Traffic</Th><Th>URL</Th>
        </tr></thead>
        <tbody>{rows.map((k: any, i: any) => {
          const diff = Number(k.position_difference) || 0
          const diffColor = diff < 0 ? 'var(--bp-green)' : diff > 0 ? 'var(--bp-red)' : 'var(--bp-text-3)'
          return (
            <tr key={i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
              <Td><strong>{k.keyword}</strong></Td>
              <Td align="right">{Math.round(Number(k.position) || 0)}</Td>
              <Td align="right"><span style={{ color: diffColor }}>{diff > 0 ? `+${diff}` : diff}</span></Td>
              <Td align="right">{(Number(k.search_volume) || 0).toLocaleString()}</Td>
              <Td align="right">{(Number(k.traffic) || 0).toLocaleString()}</Td>
              <Td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.url}</Td>
            </tr>
          )
        })}</tbody>
      </table>
    </div>
  )
}

function SemrushCompetitors({ metrics }: any) {
  const rows = latestData(metrics, 'semrush.competitors_data') ?? []
  if (!rows.length) return <EmptyState message="No competitor data yet." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
          <Th>Domain</Th><Th align="right">Shared Keywords</Th><Th align="right">Their Keywords</Th><Th align="right">Their Traffic</Th>
        </tr></thead>
        <tbody>{rows.map((c: any, i: any) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
            <Td><strong>{c.domain}</strong></Td>
            <Td align="right">{(Number(c.shared_keywords) || 0).toLocaleString()}</Td>
            <Td align="right">{(Number(c.organic_keywords) || 0).toLocaleString()}</Td>
            <Td align="right">{(Number(c.organic_traffic) || 0).toLocaleString()}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function SemrushOpportunities({ metrics }: any) {
  const rows = latestData(metrics, 'semrush.opportunities_data') ?? []
  if (!rows.length) return <EmptyState message="No page-2 opportunities — either no data yet or all keywords already on page 1." />
  return (
    <>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 12 }}>
        Keywords in positions 11–20. Content improvements could push them onto page 1.
      </div>
      <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
          <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
            <Th>Keyword</Th><Th align="right">Position</Th><Th align="right">Search Volume</Th><Th>Current URL</Th>
          </tr></thead>
          <tbody>{rows.map((k: any, i: any) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
              <Td><strong>{k.keyword}</strong></Td>
              <Td align="right">{Math.round(Number(k.position) || 0)}</Td>
              <Td align="right">{(Number(k.search_volume) || 0).toLocaleString()}</Td>
              <Td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.url}</Td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  )
}

function SocialOverview({ metrics }: any) {
  const fbFollowers = latestValue(metrics, 'fb.page_followers')
  const fbReach = latestValue(metrics, 'fb.page_reach_30d')
  const fbEngRate = latestValue(metrics, 'fb.page_engagement_rate') * 100
  const fbPosts = latestValue(metrics, 'fb.posts_published_30d')
  const igFollowers = latestValue(metrics, 'ig.followers')
  const igReach = latestValue(metrics, 'ig.reach_30d')
  const igProfileViews = latestValue(metrics, 'ig.profile_views_30d')
  const igWebClicks = latestValue(metrics, 'ig.website_clicks_30d')

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div className="bp-card" style={{ padding: 16 }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Facebook</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <MetricCard label="Followers" value={fbFollowers} />
          <MetricCard label="Reach (30d)" value={fbReach} />
          <MetricCard label="Engagement Rate" value={fbEngRate} format="pct" />
          <MetricCard label="Posts (30d)" value={fbPosts} />
        </div>
      </div>
      <div className="bp-card" style={{ padding: 16 }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Instagram</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <MetricCard label="Followers" value={igFollowers} />
          <MetricCard label="Reach (30d)" value={igReach} />
          <MetricCard label="Profile Views" value={igProfileViews} />
          <MetricCard label="Website Clicks" value={igWebClicks} accent="var(--bp-blue)" />
        </div>
      </div>
    </div>
  )
}

function SocialPosts({ metrics }: any) {
  const fb = latestData(metrics, 'fb.recent_posts_data') ?? []
  const ig = latestData(metrics, 'ig.recent_posts_data') ?? []
  const combined = [
    ...fb.map((p: any) => ({ platform: 'facebook', text: p.message, reach: p.reach, engagement: p.engaged_users, date: p.created_time, url: p.permalink_url })),
    ...ig.map((p: any) => ({ platform: 'instagram', text: p.caption, reach: p.reach, engagement: (p.likes || 0) + (p.comments || 0) + (p.saved || 0), date: p.timestamp, url: p.permalink })),
  ].sort((a, b) => (b.reach || 0) - (a.reach || 0))
  if (!combined.length) return <EmptyState message="No posts synced yet." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
          <Th>Platform</Th><Th>Post</Th><Th>Date</Th><Th align="right">Reach</Th><Th align="right">Engagement</Th>
        </tr></thead>
        <tbody>{combined.slice(0, 50).map((p, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
            <Td>{p.platform}</Td>
            <Td style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.url
                ? <a href={p.url} target="_blank" rel="noreferrer" style={{ color: 'var(--bp-text)' }}>{p.text || '(no caption)'}</a>
                : (p.text || '(no caption)')}
            </Td>
            <Td>{p.date ? format(parseISO(p.date), 'MMM d') : '—'}</Td>
            <Td align="right">{(p.reach || 0).toLocaleString()}</Td>
            <Td align="right">{(p.engagement || 0).toLocaleString()}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function BufferOverview({ metrics }: any) {
  const profiles = latestValue(metrics, 'buffer.profiles_connected')
  const published = latestValue(metrics, 'buffer.posts_published_30d')
  const pending = latestValue(metrics, 'buffer.posts_scheduled_pending')
  const avgEng = latestValue(metrics, 'buffer.avg_post_engagement_30d')
  const topMeta = latestData(metrics, 'buffer.top_performing_platform')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Profiles Connected" value={profiles} />
        <MetricCard label="Published (30d)" value={published} />
        <MetricCard label="In Queue" value={pending} accent={pending === 0 ? 'var(--bp-red)' : pending < 5 ? 'var(--bp-amber)' : 'var(--bp-green)'} />
        <MetricCard label="Avg Engagement" value={avgEng} />
      </div>
      {topMeta?.platform && (
        <div className="bp-card" style={{ padding: 14, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
          Top performing platform: <strong style={{ color: 'var(--bp-text)' }}>{topMeta.platform}</strong> (avg engagement {topMeta.avg_engagement})
        </div>
      )}
    </div>
  )
}

function BufferQueue({ metrics }: any) {
  const rows = latestData(metrics, 'buffer.scheduled_queue') ?? []
  if (!rows.length) return <EmptyState message="No posts scheduled." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}><Th>Platform</Th><Th>Scheduled</Th><Th>Post</Th></tr></thead>
        <tbody>{rows.map((u: any, i: any) => (
          <tr key={u.id || i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
            <Td>{u.service}</Td>
            <Td>{u.scheduled_at_iso ? format(parseISO(u.scheduled_at_iso), 'MMM d HH:mm') : '—'}</Td>
            <Td style={{ maxWidth: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.text || '(no text)'}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function BufferRecentPosts({ metrics }: any) {
  const rows = latestData(metrics, 'buffer.recent_posts_data') ?? []
  if (!rows.length) return <EmptyState message="No recent posts." />
  const sorted = [...rows].sort((a, b) => (b.engagement || 0) - (a.engagement || 0))
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
          <Th>Platform</Th><Th>Post</Th><Th>Sent</Th><Th align="right">Reach</Th><Th align="right">Clicks</Th><Th align="right">Engagement</Th>
        </tr></thead>
        <tbody>{sorted.map((u, i) => (
          <tr key={u.id || i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
            <Td>{u.service}</Td>
            <Td style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.text || '(no text)'}</Td>
            <Td>{u.sent_at_iso ? format(parseISO(u.sent_at_iso), 'MMM d') : '—'}</Td>
            <Td align="right">{(u.reach || 0).toLocaleString()}</Td>
            <Td align="right">{(u.clicks || 0).toLocaleString()}</Td>
            <Td align="right">{(u.engagement || 0).toLocaleString()}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

// ─── Wix tabs ───────────────────────────────────────────────────────────────

function WixOverview({ metrics }: any) {
  const totalPages = latestValue(metrics, 'wix.total_pages')
  const posts = latestValue(metrics, 'wix.blog_posts_total')
  const score = latestValue(metrics, 'wix.seo_score')
  const sessions = latestValue(metrics, 'wix.sessions_30d')
  const noSeoTitle = latestValue(metrics, 'wix.pages_no_seo_title')
  const noMetaDesc = latestValue(metrics, 'wix.pages_no_meta_description')
  const noindex = latestValue(metrics, 'wix.pages_noindexed')

  const scoreColor = score >= 80 ? 'var(--bp-green)'
                   : score >= 60 ? 'var(--bp-amber)'
                   : 'var(--bp-red)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Total Pages" value={totalPages} />
        <MetricCard label="Blog Posts" value={posts} />
        <MetricCard label="SEO Score" value={score} accent={scoreColor} />
        <MetricCard label="Sessions (30d)" value={sessions} />
      </div>
      <div className="bp-card" style={{ padding: 16 }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
          SEO health
        </div>
        <div style={{ height: 8, background: 'var(--bp-surface-2)', borderRadius: 4, overflow: 'hidden', marginBottom: 12 }}>
          <div style={{ width: `${Math.max(0, Math.min(100, score))}%`, height: '100%', background: scoreColor, transition: 'width 0.3s' }} />
        </div>
        <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
          <div>Missing title: <strong style={{ color: noSeoTitle > 0 ? 'var(--bp-amber)' : 'var(--bp-text)' }}>{noSeoTitle}</strong></div>
          <div>Missing description: <strong style={{ color: noMetaDesc > 0 ? 'var(--bp-amber)' : 'var(--bp-text)' }}>{noMetaDesc}</strong></div>
          <div>Noindexed: <strong style={{ color: noindex > 0 ? 'var(--bp-red)' : 'var(--bp-text)' }}>{noindex}</strong></div>
        </div>
      </div>
    </div>
  )
}

function WixPages({ metrics }: any) {
  const audit = latestData(metrics, 'wix.seo_audit_data') ?? []
  if (!audit.length) return <EmptyState message="No pages synced yet." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
          <Th>Page</Th><Th>URL</Th><Th>SEO Title</Th><Th>Meta Desc</Th><Th>Indexed</Th><Th align="right">Score</Th>
        </tr></thead>
        <tbody>{audit.map((p: any, i: any) => (
          <tr key={p.pageId || i} style={{ borderBottom: '1px solid var(--bp-border)',
            background: p.score < 60 ? 'rgba(255,82,82,0.05)' : 'transparent' }}>
            <Td><strong>{p.pageTitle}</strong></Td>
            <Td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.pageUrl}</Td>
            <Td>{p.has_seo_title ? (p.seo_title_ok ? '✓' : '! length') : '✗ missing'}</Td>
            <Td>{p.has_meta_description ? (p.meta_desc_ok ? '✓' : '! length') : '✗ missing'}</Td>
            <Td>{p.is_indexed ? '✓' : '✗ noindex'}</Td>
            <Td align="right"><strong style={{ color: p.score >= 80 ? 'var(--bp-green)' : p.score >= 60 ? 'var(--bp-amber)' : 'var(--bp-red)' }}>{p.score}</strong></Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function WixBlog({ metrics }: any) {
  const posts = latestData(metrics, 'wix.posts_data') ?? []
  if (!posts.length) return <EmptyState message="No blog posts found." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
          <Th>Title</Th><Th>Published</Th><Th>Status</Th><Th>SEO</Th>
        </tr></thead>
        <tbody>{posts.map((p: any, i: any) => {
          const seo = p.seo ?? {}
          const hasSeo = !!(seo.title && seo.description)
          return (
            <tr key={p.id || i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
              <Td><strong>{p.title}</strong></Td>
              <Td>{p.publishedDate ? format(parseISO(p.publishedDate), 'MMM d yyyy') : '—'}</Td>
              <Td>{p.status || '—'}</Td>
              <Td>{hasSeo ? '✓' : <span style={{ color: 'var(--bp-amber)' }}>needs SEO</span>}</Td>
            </tr>
          )
        })}</tbody>
      </table>
    </div>
  )
}

function WixSeoAudit({ metrics }: any) {
  const audit = latestData(metrics, 'wix.seo_audit_data') ?? []
  if (!audit.length) return <EmptyState message="No SEO audit data yet." />
  const worst = [...audit].sort((a, b) => a.score - b.score)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {worst.map((p, i) => (
        <div key={p.pageId || i} className="bp-card" style={{ padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ flex: 1, fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>{p.pageTitle}</div>
            <div style={{
              fontFamily: 'var(--bp-font-mono)', fontSize: 14, fontWeight: 700,
              color: p.score >= 80 ? 'var(--bp-green)' : p.score >= 60 ? 'var(--bp-amber)' : 'var(--bp-red)',
            }}>{p.score}</div>
          </div>
          <div style={{ height: 4, background: 'var(--bp-surface-2)', borderRadius: 2, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{
              width: `${p.score}%`, height: '100%',
              background: p.score >= 80 ? 'var(--bp-green)' : p.score >= 60 ? 'var(--bp-amber)' : 'var(--bp-red)',
            }} />
          </div>
          {p.issues.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontFamily: 'var(--bp-font-mono)', fontSize: 9 }}>
              {p.issues.map((issue: any, j: any) => (
                <span key={j} style={{
                  padding: '2px 6px', borderRadius: 3,
                  background: 'rgba(245,158,11,0.15)', color: 'var(--bp-amber)',
                }}>
                  {issue.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          ) : (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-green)' }}>No issues</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Server-access tabs ─────────────────────────────────────────────────────

function ServerAccessOverview({ connector, metrics }: any) {
  const phpErrors = latestValue(metrics, 'server.php_errors_24h')
  const fatalErrors = latestValue(metrics, 'server.php_fatal_errors_24h')
  const disk = latestValue(metrics, 'server.disk_usage_pct')
  const totalFiles = latestValue(metrics, 'server.files_total')
  const siteType = connector?.config?.siteType || 'custom'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="bp-card" style={{ padding: 16, background: 'rgba(255,82,82,0.05)', border: '1px solid rgba(255,82,82,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <AlertTriangle size={18} style={{ color: 'var(--bp-red)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)', marginBottom: 4 }}>
              Write access is gated
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
              Agents can read files freely but every write creates a task with the exact diff. Writes only execute after you approve the task. Every write takes a backup first — rollback is one click away from the Changes tab.
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Site Type" value={siteType} />
        <MetricCard label="Files Tracked" value={totalFiles} />
        <MetricCard label="PHP Errors (24h)" value={phpErrors} accent={phpErrors > 0 ? 'var(--bp-amber)' : undefined} />
        <MetricCard label="Disk Usage" value={disk} format="pct" accent={disk > 80 ? 'var(--bp-red)' : disk > 60 ? 'var(--bp-amber)' : 'var(--bp-green)'} />
      </div>
      {fatalErrors > 0 && (
        <div className="bp-card" style={{ padding: 14, background: 'rgba(255,82,82,0.08)', border: '1px solid var(--bp-red)' }}>
          <div style={{ color: 'var(--bp-red)', fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13 }}>
            {fatalErrors} PHP fatal error(s) in the last 24 hours — check the Error Log tab.
          </div>
        </div>
      )}
    </div>
  )
}

function ServerAccessFileExplorer({ metrics }: any) {
  const files = latestData(metrics, 'server.site_structure') ?? []
  if (!files.length) return <EmptyState message="No files indexed yet. Trigger a sync." />
  const grouped: Record<string, any[]> = {}
  for (const f of files) {
    const parts = f.path.split('/')
    const dir = parts.slice(0, -1).join('/')
    if (!grouped[dir]) grouped[dir] = []
    grouped[dir].push(f)
  }
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden', maxHeight: 600, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 10 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)', position: 'sticky', top: 0 }}>
          <Th>Path</Th><Th align="right">Size</Th><Th>Modified</Th>
        </tr></thead>
        <tbody>{Object.entries(grouped).map(([dir, groupFiles]) => (
          <React.Fragment key={dir}>
            <tr><td colSpan={3} style={{ background: 'var(--bp-surface-2)', fontWeight: 700, color: 'var(--bp-text-3)', padding: '9px 12px' }}>{dir || '/'}</td></tr>
            {groupFiles.map((f: any, i: any) => (
              <tr key={f.path} style={{ borderBottom: '1px solid var(--bp-border)' }}>
                <Td style={{ paddingLeft: 28 }}>{f.name}</Td>
                <Td align="right">{(f.size / 1024).toFixed(1)} KB</Td>
                <Td>{f.modified ? format(parseISO(f.modified), 'MMM d HH:mm') : '—'}</Td>
              </tr>
            ))}
          </React.Fragment>
        ))}</tbody>
      </table>
    </div>
  )
}

function ServerAccessErrorLog({ metrics }: any) {
  const entries = latestData(metrics, 'server.recent_errors') ?? []
  if (!entries.length) return <EmptyState message="No server errors found (or error log not accessible)." />
  const TYPE_COLORS = {
    fatal: 'var(--bp-red)', error: 'var(--bp-red)',
    '5xx': 'var(--bp-red)', warning: 'var(--bp-amber)',
    notice: 'var(--bp-text-3)', '404': 'var(--bp-amber)',
    info: 'var(--bp-text-3)',
  }
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden', maxHeight: 600, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 10 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)', position: 'sticky', top: 0 }}>
          <Th>Type</Th><Th>Timestamp</Th><Th>Message</Th>
        </tr></thead>
        <tbody>{entries.map((e: any, i: any) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
            <Td><span style={{ color: (TYPE_COLORS as any)[e.type] || 'var(--bp-text-3)', fontWeight: 600, textTransform: 'uppercase' }}>{e.type}</span></Td>
            <Td>{e.timestamp || '—'}</Td>
            <Td style={{ maxWidth: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.line}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function ServerAccessChanges({ connector }: any) {
  // Lists every file_write Blueprint has performed via this connector.
  // Each row shows the resulting backup id so the user can trigger a
  // rollback task.
  const [changes, setChanges] = useState<any[]>([])
  useEffect(() => {
    if (!connector?.id) return
    fetch(`/api/connectors/${connector.id}/file-changes`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(setChanges)
      .catch(() => setChanges([]))
  }, [connector?.id])
  if (!changes.length) return <EmptyState message="No file writes yet. Blueprint will record every approved write here, with a one-click rollback." />
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead><tr style={{ background: 'var(--bp-surface-2)' }}>
          <Th>File</Th><Th>Task</Th><Th>Written</Th><Th>Backup</Th>
        </tr></thead>
        <tbody>{changes.map((c) => (
          <tr key={c.id} style={{ borderBottom: '1px solid var(--bp-border)' }}>
            <Td><strong style={{ fontFamily: 'var(--bp-font-mono)' }}>{c.remote_path}</strong></Td>
            <Td>{c.task_title ?? c.task_id?.slice(0, 8)}</Td>
            <Td>{c.backed_up_at ? format(parseISO(c.backed_up_at), 'MMM d HH:mm') : '—'}</Td>
            <Td>{c.id.slice(0, 8)}</Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function ServerAccessBackups({ connector }: any) {
  return <ServerAccessChanges connector={connector} />
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function ConnectorDataPage() {
  const { connectorId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const addNotification = useStore((s) => s.addNotification)

  const range = searchParams.get('range') || 'today'
  const [activeTab, setActiveTab] = useState(null)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getConnectorData(connectorId!, { range })
      setData(result)
      if (!activeTab) {
        const tabs = (CONNECTOR_TABS as any)[result?.connector?.type] || CONNECTOR_TABS.default
        setActiveTab(tabs[0])
      }
    } catch (err) {
      addNotification({ type: 'error', message: 'Failed to load connector data: ' + (err as any).message })
    } finally { setLoading(false) }
  }, [connectorId, range])

  useEffect(() => { fetchData() }, [fetchData])

  async function handleSync() {
    setSyncing(true)
    try {
      await syncConnector(connectorId!)
      addNotification({ type: 'success', message: 'Sync started' })
      setTimeout(fetchData, 3000)
    } catch (err) {
      addNotification({ type: 'error', message: (err as any).message })
    } finally { setSyncing(false) }
  }

  function setRange(r: any) {
    setSearchParams({ range: r }, { replace: true })
  }

  if (loading) {
    return (
      <div style={{ padding: '24px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <div className="bp-skeleton" style={{ width: 32, height: 32, borderRadius: '50%' }} />
          <div>
            <div className="bp-skeleton" style={{ width: 160, height: 18, borderRadius: 3, marginBottom: 6 }} />
            <div className="bp-skeleton" style={{ width: 100, height: 12, borderRadius: 3 }} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="bp-card" style={{ padding: '16px 18px' }}>
              <div className="bp-skeleton" style={{ height: 10, width: '60%', borderRadius: 3, marginBottom: 10 }} />
              <div className="bp-skeleton" style={{ height: 24, width: '80%', borderRadius: 3 }} />
            </div>
          ))}
        </div>
        <div className="bp-skeleton" style={{ height: 200, borderRadius: 8 }} />
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ padding: '24px 28px' }}>
        <EmptyState message="Connector not found or no data available." />
      </div>
    )
  }

  const { connector } = data
  const meta = (CONNECTOR_META as any)[connector.type] || CONNECTOR_META.default
  const Icon = meta.icon
  const tabs = (CONNECTOR_TABS as any)[connector.type] || CONNECTOR_TABS.default
  const currentTab = activeTab || tabs[0]

  const statusDotClass = connector.status === 'connected' ? 'pulse-dot-green'
    : connector.status === 'error' ? 'pulse-dot-red'
    : connector.status === 'syncing' ? 'pulse-dot-blue'
    : 'pulse-dot-amber'

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            onClick={() => navigate('/connectors')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bp-text-3)', padding: '4px', borderRadius: 4 }}
          >
            <ArrowLeft size={16} />
          </button>
          <div style={{
            width: 40, height: 40, borderRadius: 8,
            background: `${meta.color}18`,
            border: `1px solid ${meta.color}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={18} style={{ color: meta.color }} />
          </div>
          <div>
            <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 20, color: 'var(--bp-text)', marginBottom: 4 }}>
              {connector.name}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`pulse-dot ${statusDotClass}`} />
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {connector.status}
              </span>
              {connector.last_sync && (
                <>
                  <span style={{ color: 'var(--bp-border)' }}>·</span>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
                    synced {formatDistanceToNow(parseTimestamp(connector.last_sync) || new Date(), { addSuffix: true })}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Date range */}
          <div style={{ display: 'flex', background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border)', borderRadius: 5, overflow: 'hidden' }}>
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  padding: '5px 12px', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                  background: range === r ? 'var(--bp-border)' : 'transparent',
                  color: range === r ? 'var(--bp-text)' : 'var(--bp-text-3)',
                  transition: 'all 120ms ease',
                }}
              >
                {(RANGE_LABELS as any)[r] || r}
              </button>
            ))}
          </div>

          <button
            onClick={handleSync}
            disabled={syncing}
            className="bp-btn bp-btn-secondary"
            style={{ fontSize: 11 }}
          >
            <RefreshCw size={12} style={{ animation: syncing ? 'bp-spin-slow 1s linear infinite' : 'none' }} />
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 0, marginBottom: 20,
        borderBottom: '1px solid var(--bp-border)',
      }}>
        {tabs.map((tab: any) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '9px 16px', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--bp-font-mono)', fontSize: 11, letterSpacing: '0.04em',
              background: 'transparent',
              color: currentTab === tab ? 'var(--bp-text)' : 'var(--bp-text-3)',
              borderBottom: currentTab === tab ? `2px solid ${meta.color}` : '2px solid transparent',
              marginBottom: -1,
              transition: 'color 120ms ease',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      {renderTab(connector, currentTab, data, range)}
    </div>
  )
}

export default ConnectorDataPage
