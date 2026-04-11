import React, { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Globe,
  Search,
  Zap,
  Radio,
  CheckSquare,
  Bot,
  ArrowRight,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Plug,
} from 'lucide-react'
import { formatDistanceToNow, format, subDays } from 'date-fns'
import clsx from 'clsx'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import MetricCard from '../components/MetricCard.jsx'
import SignalFeed from '../components/SignalFeed.jsx'
import Gauge from '../components/Gauge.jsx'
import { chartDefaults } from '../lib/chartTheme.js'
import useStore from '../lib/store.js'
import { getDashboard, getSignals, approveTask, rejectTask, updateSignal } from '../lib/api.js'

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function CardHeader({ title, children, link, linkLabel = 'View all' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
      <div style={{
        fontFamily: 'var(--bp-font-display)',
        fontSize: 11, fontWeight: 600,
        letterSpacing: '0.12em', textTransform: 'uppercase',
        color: 'var(--bp-text-3)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {title}
        {children}
      </div>
      {link && (
        <Link to={link} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
          {linkLabel} <ArrowRight size={11} />
        </Link>
      )}
    </div>
  )
}

function SectionSkeleton({ rows = 4 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="skeleton" style={{ width: 32, height: 32, borderRadius: 6, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 11, width: '60%', marginBottom: 6 }} />
            <div className="skeleton" style={{ height: 9, width: '40%' }} />
          </div>
          <div className="skeleton" style={{ height: 9, width: 48 }} />
        </div>
      ))}
    </div>
  )
}

function TrafficTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ ...chartDefaults.tooltip.contentStyle, padding: '8px 12px' }}>
      <div style={{ fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 11, color: p.color, fontFamily: "'DM Mono', monospace" }}>
          {p.name}: {(p.value || 0).toLocaleString()}
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Keyword row
// ─────────────────────────────────────────────────────────
function KeywordRow({ kw, maxImpressions }) {
  const pct = maxImpressions > 0 ? (kw.impressions / maxImpressions) * 100 : 0
  const pos = kw.position != null ? Math.round(kw.position) : null
  const posColor = pos == null ? 'var(--bp-text-3)' : pos <= 3 ? 'var(--bp-green)' : pos <= 10 ? 'var(--bp-amber)' : 'var(--bp-red)'
  const change = kw.positionChange
  const ChangeIcon = change < 0 ? TrendingUp : change > 0 ? TrendingDown : null
  const changeColor = change < 0 ? 'var(--bp-green)' : change > 0 ? 'var(--bp-red)' : 'var(--bp-text-3)'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ flex: 1, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
        {kw.query}
      </div>
      <div style={{ flex: 1, maxWidth: 80, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--bp-blue)', borderRadius: 2, transition: 'width 600ms ease-out' }} />
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: posColor, width: 36, textAlign: 'right', flexShrink: 0 }}>
        {pos != null ? `#${pos}` : '—'}
      </div>
      {ChangeIcon ? <ChangeIcon size={11} style={{ color: changeColor, flexShrink: 0 }} /> : <div style={{ width: 11 }} />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Agent row
// ─────────────────────────────────────────────────────────
function AgentRow({ agent }) {
  const isRunning = agent.status === 'running'
  const dotClass = isRunning ? 'pulse-dot-blue' : agent.status === 'active' ? 'pulse-dot-green' : agent.status === 'error' ? 'pulse-dot-red' : 'pulse-dot-gray'
  const statusLabel = isRunning ? 'RUNNING' : agent.status === 'active' ? 'ACTIVE' : agent.status === 'error' ? 'ERROR' : agent.status === 'paused' ? 'PAUSED' : 'IDLE'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{agent.avatar || '🤖'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, fontWeight: 500, color: 'var(--bp-text)', marginBottom: 2 }}>{agent.name}</div>
        {agent.last_action && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.last_action}</div>
        )}
        {isRunning && (
          <div style={{ marginTop: 6, height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: '60%', background: 'var(--bp-blue)', borderRadius: 2, animation: 'bp-shimmer 2s infinite' }} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span className={clsx('pulse-dot', dotClass)} />
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.08em', color: 'var(--bp-text-3)' }}>{statusLabel}</span>
        </div>
        {agent.last_run && (
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
            {formatDistanceToNow(new Date(agent.last_run), { addSuffix: true })}
          </span>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Task status config
// ─────────────────────────────────────────────────────────
const TASK_PILL = { proposed: 'bp-pill-amber', approved: 'bp-pill-blue', executing: 'bp-pill-blue', complete: 'bp-pill-green', verified: 'bp-pill-grey', rejected: 'bp-pill-red' }
const TASK_BORDER = { proposed: 'var(--bp-amber)', approved: 'var(--bp-blue)', executing: 'var(--bp-blue)', complete: 'var(--bp-green)', verified: 'rgba(255,255,255,0.15)', rejected: 'var(--bp-red)' }

function TaskMiniCard({ task, onApprove, onReject }) {
  const [acting, setActing] = useState(false)
  const borderColor = TASK_BORDER[task.status] || 'rgba(255,255,255,0.1)'

  return (
    <div style={{
      width: 200, flexShrink: 0,
      background: 'var(--bp-surface-2)',
      border: '1px solid var(--bp-border)',
      borderLeft: `3px solid ${borderColor}`,
      borderRadius: 6, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 8,
      scrollSnapAlign: 'start',
    }}>
      <span className={clsx('bp-pill', TASK_PILL[task.status] || 'bp-pill-grey')} style={{ alignSelf: 'flex-start' }}>
        {task.status?.toUpperCase()}
      </span>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {task.title}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>{task.agent_name || '—'}</span>
        {task.confidence != null && (
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>{Math.round(task.confidence * 100)}%</span>
        )}
      </div>
      {task.status === 'proposed' && (
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={async () => { setActing(true); try { await onApprove(task.id) } finally { setActing(false) } }} disabled={acting} className="bp-btn bp-btn-primary" style={{ flex: 1, justifyContent: 'center', fontSize: 10, padding: '3px 6px' }}>Approve</button>
          <button onClick={async () => { setActing(true); try { await onReject(task.id) } finally { setActing(false) } }} disabled={acting} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '3px 6px' }}>Reject</button>
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>🏗</div>
      <h2 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 18, color: 'var(--bp-text)', marginBottom: 8, margin: '0 0 8px' }}>No data yet</h2>
      <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', maxWidth: 300, marginBottom: 20, lineHeight: 1.6 }}>
        Connect a data source to start seeing your business intelligence.
      </p>
      <div style={{ display: 'flex', gap: 10 }}>
        <Link to="/connectors" className="bp-btn bp-btn-primary"><Plug size={13} />Add Connector</Link>
        <Link to="/settings" className="bp-btn bp-btn-secondary">Settings</Link>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Main Dashboard
// ─────────────────────────────────────────────────────────
function Dashboard() {
  const currentBusiness    = useStore((s) => s.currentBusiness)
  const dashboard          = useStore((s) => s.dashboard)
  const setDashboard       = useStore((s) => s.setDashboard)
  const setOpenSignalCount = useStore((s) => s.setOpenSignalCount)
  const setPendingTaskCount = useStore((s) => s.setPendingTaskCount)
  const addNotification    = useStore((s) => s.addNotification)
  const [loading, setLoading]     = useState(true)
  const [signals, setSignals]     = useState([])
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async () => {
    if (!currentBusiness) { setLoading(false); return }
    try {
      const [dash, sigs] = await Promise.all([
        getDashboard(currentBusiness.id),
        getSignals(currentBusiness.id, { status: 'open', limit: 20 }),
      ])
      setDashboard(dash)
      const sigList = Array.isArray(sigs) ? sigs : (sigs?.data || sigs?.signals || [])
      setSignals(sigList)
      setOpenSignalCount(sigList.filter(s => s.status === 'open' || !s.status).length)
      setPendingTaskCount((dash?.recent_tasks || []).filter(t => t.status === 'proposed').length)
    } catch (err) { console.error('Dashboard fetch error:', err) }
    finally { setLoading(false) }
  }, [currentBusiness])

  useEffect(() => {
    setLoading(true)
    fetchData()
    const iv = setInterval(fetchData, 60_000)
    return () => clearInterval(iv)
  }, [fetchData])

  async function handleAcknowledge(signal) {
    try {
      await updateSignal(signal.id, { status: 'acknowledged' })
      setSignals(prev => prev.filter(s => s.id !== signal.id))
      addNotification({ type: 'success', message: 'Signal acknowledged' })
    } catch (err) { addNotification({ type: 'error', message: err.message }) }
  }

  async function handleApproveTask(id) {
    try { await approveTask(id, {}); addNotification({ type: 'success', message: 'Task approved' }); fetchData() }
    catch (err) { addNotification({ type: 'error', message: err.message }) }
  }
  async function handleRejectTask(id) {
    try { await rejectTask(id, {}); addNotification({ type: 'success', message: 'Task rejected' }); fetchData() }
    catch (err) { addNotification({ type: 'error', message: err.message }) }
  }

  if (!currentBusiness && !loading) return <div style={{ padding: 24 }}><EmptyState /></div>

  const metrics     = dashboard?.metrics || {}
  const agents      = dashboard?.agents || []
  const recentTasks = dashboard?.recent_tasks || []

  function spark(key) {
    const h = dashboard?.history?.[key] || []
    return h.map((v, i) => ({ value: v, i }))
  }

  const trafficData = (() => {
    const sessions = dashboard?.history?.sessions || []
    if (sessions.length > 0) {
      return sessions.map((v, i) => ({ date: format(subDays(new Date(), sessions.length - 1 - i), 'MMM d'), sessions: v }))
    }
    return Array.from({ length: 14 }, (_, i) => ({ date: format(subDays(new Date(), 13 - i), 'MMM d'), sessions: null }))
  })()

  const keywords = (dashboard?.top_keywords || []).slice(0, 8)
  const maxImpressions = keywords.reduce((m, k) => Math.max(m, k.impressions || 0), 1)
  const ps = metrics.pagespeed || {}
  const lcp = ps.lcp || metrics.lcp
  const cls = ps.cls || metrics.cls
  const score = metrics.pagespeed_score ?? ps.score
  const topPages = (dashboard?.top_pages || []).slice(0, 8)

  return (
    <div style={{ padding: 24, maxWidth: 1600, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 18, color: 'var(--bp-text)', margin: 0 }}>
            {currentBusiness?.name || 'Dashboard'}
          </h1>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginTop: 3 }}>Business intelligence overview</p>
        </div>
        <button onClick={async () => { setRefreshing(true); await fetchData(); setRefreshing(false) }} disabled={refreshing} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
          <RefreshCw size={12} style={{ animation: refreshing ? 'bp-spin-slow 1s linear infinite' : 'none' }} />
          Refresh
        </button>
      </div>

      {/* Row 1: 6 Metric Cards */}
      <div className="bp-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 16 }}>
        <MetricCard label="Sessions (7d)" value={metrics.sessions_7d} prev={metrics.sessions_prev_7d} sparklineData={spark('sessions')} icon={Globe} iconColor="var(--bp-blue)" accentColor="var(--bp-blue)" loading={loading} />
        <MetricCard label="Organic Sessions" value={metrics.organic_sessions} prev={metrics.organic_sessions_prev} sparklineData={spark('organic_sessions')} icon={Search} iconColor="var(--bp-cyan)" accentColor="var(--bp-cyan)" loading={loading} />
        <MetricCard label="Keywords" value={metrics.organic_keywords} prev={metrics.organic_keywords_prev} sparklineData={spark('keywords')} icon={Search} iconColor="var(--bp-blue)" loading={loading} />
        <MetricCard label="Avg Position" value={metrics.avg_position != null ? Number(metrics.avg_position).toFixed(1) : undefined} prev={metrics.avg_position_prev != null ? Number(metrics.avg_position_prev).toFixed(1) : undefined} sparklineData={spark('position')} icon={TrendingUp} iconColor="var(--bp-amber)" accentColor="var(--bp-amber)" invertPolarity loading={loading} />
        <MetricCard label="PageSpeed" value={score} prev={metrics.pagespeed_prev} unit="/100" sparklineData={spark('pagespeed')} icon={Zap} iconColor={score >= 90 ? 'var(--bp-green)' : score >= 50 ? 'var(--bp-amber)' : 'var(--bp-red)'} accentColor={score >= 90 ? 'var(--bp-green)' : score >= 50 ? 'var(--bp-amber)' : 'var(--bp-red)'} loading={loading} />
        <MetricCard label="Open Signals" value={signals.length} prev={metrics.signals_prev} sparklineData={spark('signals')} icon={Radio} iconColor="var(--bp-red)" accentColor="var(--bp-red)" invertPolarity loading={loading} />
      </div>

      {/* Row 2: Signal Feed + Agent Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '58fr 42fr', gap: 16, marginBottom: 16 }}>
        <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bp-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className={clsx('pulse-dot', signals.length > 0 ? 'pulse-dot-red' : 'pulse-dot-green')} />
              <span style={{ fontFamily: 'var(--bp-font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--bp-text-3)' }}>Live Signals</span>
              <span className="bp-pill bp-pill-grey" style={{ padding: '1px 6px', fontSize: 9 }}>{loading ? '—' : signals.length}</span>
            </div>
            <Link to="/signals" style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>All <ArrowRight size={11} /></Link>
          </div>
          {loading ? <div style={{ padding: 16 }}><SectionSkeleton rows={4} /></div> : (
            <SignalFeed signals={signals.slice(0, 15)} onSignalClick={() => {}} onAcknowledge={handleAcknowledge} maxHeight={360} />
          )}
        </div>
        <div className="bp-card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bp-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--bp-font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--bp-text-3)' }}>Agent Status</span>
            <Link to="/agents" style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>Agents <ArrowRight size={11} /></Link>
          </div>
          <div style={{ padding: '8px 18px', flex: 1, overflowY: 'auto', maxHeight: 360 }}>
            {loading ? <SectionSkeleton rows={4} /> : agents.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 0', textAlign: 'center' }}>
                <Bot size={28} style={{ color: 'var(--bp-text-3)', marginBottom: 8 }} />
                <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>No agents configured</p>
                <Link to="/agents" style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)', textDecoration: 'none', marginTop: 6 }}>Set up agents →</Link>
              </div>
            ) : agents.map(a => <AgentRow key={a.id} agent={a} />)}
          </div>
        </div>
      </div>

      {/* Row 3: Traffic + Keywords */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="bp-card">
          <CardHeader title="Organic Traffic" />
          {loading ? <div className="skeleton" style={{ height: 180, borderRadius: 4 }} /> :
           trafficData.some(d => d.sessions) ? (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={trafficData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="trafficGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="date" tick={chartDefaults.xAxis.tick} axisLine={false} tickLine={false} />
                <YAxis tick={chartDefaults.yAxis.tick} axisLine={false} tickLine={false} width={36} />
                <Tooltip content={<TrafficTooltip />} cursor={chartDefaults.tooltip.cursor} />
                <Area type="monotone" dataKey="sessions" name="Sessions" stroke="#3b82f6" fill="url(#trafficGrad)" strokeWidth={1.5} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
              <Globe size={24} style={{ color: 'var(--bp-text-3)' }} />
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>Connect GA4 to see traffic</span>
            </div>
          )}
        </div>
        <div className="bp-card">
          <CardHeader title="Keyword Positions" />
          {loading ? <SectionSkeleton rows={6} /> : keywords.length === 0 ? (
            <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
              <Search size={24} style={{ color: 'var(--bp-text-3)' }} />
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>Connect GSC to see keywords</span>
            </div>
          ) : keywords.map((kw, i) => <KeywordRow key={i} kw={kw} maxImpressions={maxImpressions} />)}
        </div>
      </div>

      {/* Row 4: PageSpeed Gauges + Top Pages */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 7fr', gap: 16, marginBottom: 16 }}>
        <div className="bp-card">
          <CardHeader title="Core Web Vitals" />
          {loading ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {[0,1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 100, borderRadius: 4 }} />)}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Gauge value={score} max={100} goodThreshold={90} needsWorkThreshold={50} label="Score" />
              <Gauge value={lcp} max={6000} goodThreshold={2500} needsWorkThreshold={4000} label="LCP" unit="ms" invert />
              <Gauge value={cls != null ? cls * 100 : null} max={40} goodThreshold={10} needsWorkThreshold={25} label="CLS" unit="×100" invert />
              <Gauge value={ps.fid || ps.inp} max={500} goodThreshold={100} needsWorkThreshold={300} label="FID" unit="ms" invert />
            </div>
          )}
        </div>
        <div className="bp-card">
          <CardHeader title="Top Pages">
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>by sessions</span>
          </CardHeader>
          {loading ? <SectionSkeleton rows={6} /> : topPages.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, height: 120 }}>
              <Globe size={24} style={{ color: 'var(--bp-text-3)' }} />
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>Connect GA4 to see top pages</span>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '3fr 80px 80px 60px', gap: 8, padding: '0 0 8px', borderBottom: '1px solid var(--bp-border)', marginBottom: 4 }}>
                {['Page', 'Sessions', 'Bounce', 'Conv'].map(h => (
                  <span key={h} style={{ fontFamily: 'var(--bp-font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--bp-text-3)', textAlign: h !== 'Page' ? 'right' : 'left' }}>{h}</span>
                ))}
              </div>
              {topPages.map((page, i) => {
                const bounce = page.bounceRate || page.bounce_rate || 0
                const bounceColor = bounce < 0.4 ? 'var(--bp-green)' : bounce < 0.65 ? 'var(--bp-amber)' : 'var(--bp-red)'
                return (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '3fr 80px 80px 60px', gap: 8, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.path || page.pagePath || '/'}</span>
                    <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 500, fontSize: 12, color: 'var(--bp-text)', textAlign: 'right' }}>{(page.sessions || 0).toLocaleString()}</span>
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: bounceColor, textAlign: 'right' }}>{((bounce * 100)).toFixed(0)}%</span>
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-green)', textAlign: 'right' }}>{(page.conversions || 0).toLocaleString()}</span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>

      {/* Row 5: Recent Tasks */}
      {(loading || recentTasks.length > 0) && (
        <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bp-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--bp-text-3)' }}>Recent Tasks</span>
            <Link to="/tasks" style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>View all <ArrowRight size={11} /></Link>
          </div>
          <div className="no-scrollbar" style={{ padding: 16, display: 'flex', gap: 12, overflowX: 'auto', scrollSnapType: 'x mandatory' }}>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} style={{ width: 200, flexShrink: 0 }}>
                  <div className="skeleton" style={{ height: 100, borderRadius: 6 }} />
                </div>
              ))
            ) : recentTasks.length === 0 ? (
              <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', padding: '20px 0' }}>No tasks yet</p>
            ) : (
              recentTasks.slice(0, 10).map(task => (
                <TaskMiniCard key={task.id} task={task} onApprove={handleApproveTask} onReject={handleRejectTask} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default Dashboard
