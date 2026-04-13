import React, { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import {
  Activity, RefreshCw, Play, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle2, XCircle, Pause, Database,
  BookOpen, Clock, Zap,
} from 'lucide-react'
import { getSystemHealth, syncConnector, runAgent, getBrainStatus } from '../lib/api.js'
import useStore from '../lib/store.js'

const STATUS_COLORS = {
  healthy:  { label: 'ALL SYSTEMS OPERATIONAL', color: 'var(--bp-green)', bg: 'rgba(0,201,167,0.10)' },
  degraded: { label: 'DEGRADED',                color: 'var(--bp-amber)', bg: 'rgba(245,158,11,0.10)' },
  critical: { label: 'CRITICAL',                color: 'var(--bp-red)',   bg: 'rgba(255,82,82,0.10)'  },
}

const CONN_STATUS = {
  live:         { dot: '🟢', label: 'Live',         color: 'var(--bp-green)' },
  stale:        { dot: '🟡', label: 'Stale',        color: 'var(--bp-amber)' },
  error:        { dot: '🔴', label: 'Error',        color: 'var(--bp-red)'   },
  disconnected: { dot: '⚪', label: 'Disconnected', color: 'var(--bp-text-3)' },
  syncing:      { dot: '🔵', label: 'Syncing',      color: 'var(--bp-blue)'  },
}

const AGENT_STATUS = {
  ok:       { color: 'var(--bp-green)', label: 'Ok' },
  failing:  { color: 'var(--bp-red)',   label: 'Failing' },
  disabled: { color: 'var(--bp-text-3)', label: 'Disabled' },
  idle:     { color: 'var(--bp-text-3)', label: 'Idle' },
}

function fmtRel(iso) {
  if (!iso) return '—'
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) }
  catch { return '—' }
}

function fmtMinutes(mins) {
  if (mins == null) return '—'
  if (mins < 0) return `${Math.abs(Math.round(mins))}m overdue`
  if (mins < 60) return `${Math.round(mins)}m`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

// ─── Section header ───────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontFamily: 'var(--bp-font-mono)',
        fontSize: 10,
        letterSpacing: '0.12em',
        color: 'var(--bp-text-3)',
        textTransform: 'uppercase',
        marginBottom: 10,
        paddingBottom: 6,
        borderBottom: '1px solid var(--bp-border)',
      }}>{title}</div>
      {children}
    </div>
  )
}

// ─── Connectors table ─────────────────────────────────────────────────────────
function ConnectorsTable({ connectors, onSync }) {
  const [expandedErr, setExpandedErr] = useState(null)
  const [syncing, setSyncing] = useState({})

  if (!connectors?.length) {
    return <div style={{ padding: 16, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
      No connectors configured.
    </div>
  }

  async function handleSync(id) {
    setSyncing(prev => ({ ...prev, [id]: true }))
    try { await onSync(id) } catch {}
    finally { setSyncing(prev => ({ ...prev, [id]: false })) }
  }

  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'var(--bp-surface-2)' }}>
            <Th>Connector</Th>
            <Th>Business</Th>
            <Th>Status</Th>
            <Th>Last sync</Th>
            <Th>Next sync</Th>
            <Th align="right">Metrics</Th>
            <Th align="right">Signals</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody>
          {connectors.map((c) => {
            const cfg = CONN_STATUS[c.status] ?? CONN_STATUS.disconnected
            const rowBg = c.status === 'stale' ? 'rgba(245,158,11,0.05)'
                       : c.status === 'error' ? 'rgba(255,82,82,0.05)'
                       : 'transparent'
            const overdue = c.status === 'stale' && c.next_sync_in_minutes != null && c.next_sync_in_minutes < 0
            const actionable = c.status === 'stale' || c.status === 'error' || c.status === 'disconnected'
            return (
              <React.Fragment key={c.id}>
                <tr style={{ borderBottom: '1px solid var(--bp-border)', background: rowBg }}>
                  <Td><strong style={{ color: 'var(--bp-text)' }}>{c.name}</strong></Td>
                  <Td>{c.business_name}</Td>
                  <Td>
                    <span style={{ color: cfg.color }}>
                      {cfg.dot} {cfg.label}
                    </span>
                  </Td>
                  <Td>{fmtRel(c.last_sync)}</Td>
                  <Td>
                    {overdue ? (
                      <span style={{ color: 'var(--bp-amber)' }}>⚠ overdue</span>
                    ) : c.next_sync_in_minutes != null ? fmtMinutes(c.next_sync_in_minutes) : '—'}
                  </Td>
                  <Td align="right">{c.metrics_stored?.toLocaleString() ?? 0}</Td>
                  <Td align="right">{c.signals_enabled ?? 0}</Td>
                  <Td>
                    {actionable && (
                      <button
                        onClick={() => handleSync(c.id)}
                        disabled={syncing[c.id]}
                        className="bp-btn bp-btn-ghost"
                        style={{ fontSize: 10, padding: '3px 8px' }}
                      >
                        <RefreshCw size={10} style={{
                          animation: syncing[c.id] ? 'bp-spin-slow 1s linear infinite' : 'none',
                        }} /> Sync
                      </button>
                    )}
                    {c.last_error && (
                      <button
                        onClick={() => setExpandedErr(expandedErr === c.id ? null : c.id)}
                        className="bp-btn bp-btn-ghost"
                        style={{ fontSize: 10, padding: '3px 8px', marginLeft: 4 }}
                      >
                        {expandedErr === c.id ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                        error
                      </button>
                    )}
                  </Td>
                </tr>
                {expandedErr === c.id && c.last_error && (
                  <tr style={{ background: 'rgba(255,82,82,0.05)' }}>
                    <td colSpan={8} style={{ padding: 12, fontSize: 10, color: 'var(--bp-red)', borderBottom: '1px solid var(--bp-border)' }}>
                      <strong>Last error:</strong> {c.last_error}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, align = 'left' }) {
  return (
    <th style={{
      padding: '10px 14px',
      textAlign: align,
      fontFamily: 'var(--bp-font-mono)',
      fontSize: 9,
      letterSpacing: '0.10em',
      textTransform: 'uppercase',
      color: 'var(--bp-text-3)',
      fontWeight: 500,
    }}>{children}</th>
  )
}

function Td({ children, align = 'left' }) {
  return (
    <td style={{
      padding: '10px 14px',
      textAlign: align,
      color: 'var(--bp-text-2)',
    }}>{children}</td>
  )
}

// ─── Agents table ─────────────────────────────────────────────────────────────
function AgentsTable({ agents, onRun }) {
  const [running, setRunning] = useState({})

  async function handleRun(id) {
    setRunning(prev => ({ ...prev, [id]: true }))
    try { await onRun(id) } catch {}
    finally { setTimeout(() => setRunning(prev => ({ ...prev, [id]: false })), 1500) }
  }

  if (!agents?.length) return null
  return (
    <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'var(--bp-surface-2)' }}>
            <Th>Agent</Th>
            <Th>Status</Th>
            <Th>Last run</Th>
            <Th align="right">Runs (7d)</Th>
            <Th align="right">Success</Th>
            <Th align="right">Tasks</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const cfg = AGENT_STATUS[a.status] ?? AGENT_STATUS.idle
            const isFailing = a.status === 'failing'
            const rowBg = isFailing ? 'rgba(255,82,82,0.05)' : 'transparent'
            const dot = a.status === 'ok' && a.runs_7d === 0 ? '⚪'
                      : a.status === 'ok' ? '🟢'
                      : a.status === 'failing' ? '🔴'
                      : '⚪'
            const statusLabel = a.status === 'ok' && a.runs_7d === 0 ? 'Idle' : cfg.label
            return (
              <tr key={a.id} style={{ borderBottom: '1px solid var(--bp-border)', background: rowBg }}>
                <Td><strong style={{ color: 'var(--bp-text)' }}>{a.name}</strong></Td>
                <Td><span style={{ color: cfg.color }}>{dot} {statusLabel}</span></Td>
                <Td>{fmtRel(a.last_run)}</Td>
                <Td align="right">{a.runs_7d}</Td>
                <Td align="right">
                  <span style={{ color: a.success_rate_7d >= 0.9 ? 'var(--bp-green)' : a.success_rate_7d >= 0.7 ? 'var(--bp-amber)' : 'var(--bp-red)' }}>
                    {Math.round((a.success_rate_7d ?? 1) * 100)}%
                  </span>
                </Td>
                <Td align="right">{a.tasks_proposed_7d}</Td>
                <Td>
                  {isFailing && (
                    <button
                      onClick={() => handleRun(a.id)}
                      disabled={running[a.id]}
                      className="bp-btn bp-btn-ghost"
                      style={{ fontSize: 10, padding: '3px 8px' }}
                    >
                      <Play size={9} /> Run
                    </button>
                  )}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Three column stats row ───────────────────────────────────────────────────
function StatsRow({ llm, database, kb }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 24 }}>
      <div className="bp-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <Zap size={14} style={{ color: 'var(--bp-blue)' }} />
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>LLM Spend</span>
        </div>
        <StatRow label="Today" value={`$${llm.today_usd.toFixed(2)}`} />
        <StatRow label="Month" value={`$${llm.month_usd.toFixed(2)} / $${llm.budget_usd.toFixed(2)}`} />
        <StatRow label="Forecast" value={`$${llm.forecast_month_end_usd.toFixed(2)}`} />
        <div style={{ marginTop: 12, width: '100%', height: 6, background: 'var(--bp-surface-3)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, llm.budget_pct)}%`, height: '100%',
            background: llm.budget_pct >= 100 ? 'var(--bp-red)' : llm.budget_pct >= 80 ? 'var(--bp-amber)' : 'var(--bp-green)',
            transition: 'width 300ms ease',
          }} />
        </div>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4, textAlign: 'right' }}>
          {llm.budget_pct}%
        </div>
      </div>

      <div className="bp-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <Database size={14} style={{ color: 'var(--bp-blue)' }} />
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>Database</span>
        </div>
        <StatRow label="Status" value={
          <span style={{ color: database.status === 'ok' ? 'var(--bp-green)' : 'var(--bp-red)' }}>
            ● {database.status === 'ok' ? 'Ok' : 'Error'}
          </span>
        } />
        <StatRow label="Size" value={`${database.size_mb}MB`} />
        <StatRow label="Tables" value={database.tables} />
        <StatRow label="WAL" value={`${database.wal_size_mb}MB`} />
      </div>

      <div className="bp-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <BookOpen size={14} style={{ color: 'var(--bp-blue)' }} />
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>KB Health</span>
        </div>
        <StatRow label="Pages" value={kb.total_pages} />
        <StatRow label="Pending review" value={kb.pending_review} />
        <StatRow label="Contradictions" value={kb.open_contradictions} />
        <StatRow label="Last ingest" value={kb.last_ingest ? fmtRel(kb.last_ingest) : '—'} />
      </div>
    </div>
  )
}

function StatRow({ label, value }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '5px 0',
      fontFamily: 'var(--bp-font-mono)', fontSize: 12,
    }}>
      <span style={{ color: 'var(--bp-text-3)' }}>{label}</span>
      <span style={{ color: 'var(--bp-text)', fontWeight: 500 }}>{value}</span>
    </div>
  )
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
function SchedulerSection({ scheduler }) {
  return (
    <div className="bp-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 20, fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
          <span style={{ color: 'var(--bp-text-3)' }}>Jobs registered: <strong style={{ color: 'var(--bp-text)' }}>{scheduler.jobs_registered}</strong></span>
          <span style={{ color: 'var(--bp-text-3)' }}>Failed (24h): <strong style={{ color: scheduler.jobs_failed_24h > 0 ? 'var(--bp-red)' : 'var(--bp-text)' }}>{scheduler.jobs_failed_24h}</strong></span>
          <span style={{ color: 'var(--bp-text-3)' }}>
            Status: <strong style={{ color: scheduler.status === 'running' ? 'var(--bp-green)' : 'var(--bp-amber)' }}>
              ● {scheduler.status === 'running' ? 'Running' : 'Paused'}
            </strong>
          </span>
        </div>
      </div>
      {scheduler.next_runs?.length > 0 && (
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
            Next 5 scheduled runs
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {scheduler.next_runs.map((j) => (
              <div key={j.job_id + j.next_run} style={{
                display: 'flex', justifyContent: 'space-between',
                padding: '6px 10px',
                background: 'var(--bp-surface-2)',
                borderRadius: 4,
                fontFamily: 'var(--bp-font-mono)', fontSize: 11,
              }}>
                <span style={{ color: 'var(--bp-text-2)' }}>{j.label}</span>
                <span style={{ color: 'var(--bp-text-3)' }}>in {fmtMinutes(j.minutes_until)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SystemHealth() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchHealth = useCallback(async () => {
    try {
      const result = await getSystemHealth()
      setData(result)
    } catch (err) {
      console.error('Health fetch failed:', err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const poll = setInterval(fetchHealth, 30000)
    return () => clearInterval(poll)
  }, [fetchHealth])

  async function handleSync(id) {
    await syncConnector(id)
    setTimeout(fetchHealth, 1000)
  }

  async function handleRunAgent(id) {
    // Use first connector's business as default if needed — agent run needs business_id
    const firstBiz = data?.connectors?.[0]?.business_id
    if (!firstBiz) return
    await runAgent(id, { business_id: firstBiz })
    setTimeout(fetchHealth, 1500)
  }

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--bp-font-mono)', color: 'var(--bp-text-3)' }}>
        Loading system health...
      </div>
    )
  }

  if (!data) return null

  const status = STATUS_COLORS[data.overall] ?? STATUS_COLORS.healthy

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{
            fontFamily: 'var(--bp-font-display)',
            fontWeight: 800,
            fontSize: 24,
            color: 'var(--bp-text)',
            letterSpacing: '0.02em',
            marginBottom: 8,
          }}>SYSTEM HEALTH</h1>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            background: status.bg,
            border: `1px solid ${status.color}40`,
            borderRadius: 4,
            fontFamily: 'var(--bp-font-mono)',
            fontSize: 11,
            color: status.color,
            letterSpacing: '0.05em',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: status.color,
              animation: data.overall !== 'healthy' ? 'bp-pulse 2s infinite' : 'none',
            }} />
            {status.label}
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Last checked: {fmtRel(data.checked_at)}
          </div>
        </div>
        <button
          onClick={() => { setRefreshing(true); fetchHealth() }}
          className="bp-btn bp-btn-ghost"
          style={{ fontSize: 11 }}
        >
          <RefreshCw size={12} style={{
            animation: refreshing ? 'bp-spin-slow 1s linear infinite' : 'none',
          }} /> Refresh
        </button>
      </div>

      <Section title="Connectors">
        <ConnectorsTable connectors={data.connectors} onSync={handleSync} />
      </Section>

      <Section title="Agents">
        <AgentsTable agents={data.agents} onRun={handleRunAgent} />
      </Section>

      <StatsRow llm={data.llm} database={data.database} kb={data.kb} />

      <Section title="Scheduler">
        <SchedulerSection scheduler={data.scheduler} />
      </Section>

      <Section title="Brain">
        <BrainSection />
      </Section>
    </div>
  )
}

function BrainSection() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [brain, setBrain] = useState(null)

  useEffect(() => {
    if (!currentBusiness) return
    getBrainStatus(currentBusiness.id).then(setBrain).catch(() => setBrain(null))
  }, [currentBusiness])

  if (!brain) return null

  return (
    <div className="bp-card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>🧠</span>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>
          Temporal awareness: <span style={{ color: 'var(--bp-green)' }}>● Active</span>
        </div>
      </div>

      {brain.summary && (
        <div style={{
          padding: 12, marginBottom: 14,
          background: 'rgba(77,166,255,0.06)',
          border: '1px solid rgba(77,166,255,0.15)',
          borderRadius: 4,
          fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-2)',
          lineHeight: 1.6, fontStyle: 'italic',
        }}>
          {brain.summary}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        {[
          { label: 'Actions in flight', value: brain.in_flight_count ?? 0, color: 'var(--bp-blue)' },
          { label: 'Ready to measure', value: brain.ready_for_measurement ?? 0, color: 'var(--bp-green)' },
          { label: 'Deferred tasks', value: brain.deferred_tasks ?? 0, color: 'var(--bp-amber)' },
          { label: 'Seasonal patterns', value: brain.seasonal_patterns ?? 0, color: 'var(--bp-purple)' },
        ].map(c => (
          <div key={c.label} style={{ padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3 }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 18, fontWeight: 700, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {Array.isArray(brain.still_waiting) && brain.still_waiting.length > 0 && (
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 6 }}>
            Actions in measurement windows
          </div>
          {brain.still_waiting.slice(0, 5).map((w) => (
            <div key={w.id} style={{ padding: '6px 0', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', borderTop: '1px solid var(--bp-border)' }}>
              • <strong>{w.title}</strong>
              <span style={{ color: 'var(--bp-text-3)' }}> — ready in {w.days_until_measurable} day{w.days_until_measurable === 1 ? '' : 's'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
