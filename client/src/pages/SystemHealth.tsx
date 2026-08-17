import React, { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import {
  Activity, RefreshCw, Play, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle2, XCircle, Pause, Database,
  BookOpen, Clock, Zap, Wrench, ExternalLink,
} from 'lucide-react'
import { getSystemHealth, syncConnector, runAgent, getBrainStatus, getTasks, getAgentEfficiency, getConnectorConfidence, getWorldModel } from '../lib/api.js'
import useStore from '../lib/store.js'

const STATUS_COLORS: Record<string, { label: string; color: string; bg: string }> & { healthy: { label: string; color: string; bg: string } } = {
  healthy:  { label: 'ALL SYSTEMS OPERATIONAL', color: 'var(--bp-green)', bg: 'rgba(0,201,167,0.10)' },
  degraded: { label: 'DEGRADED',                color: 'var(--bp-amber)', bg: 'rgba(245,158,11,0.10)' },
  critical: { label: 'CRITICAL',                color: 'var(--bp-red)',   bg: 'rgba(255,82,82,0.10)'  },
}

const CONN_STATUS: Record<string, { dot: string; label: string; color: string }> & { disconnected: { dot: string; label: string; color: string } } = {
  live:           { dot: '🟢', label: 'Live',           color: 'var(--bp-green)' },
  stale:          { dot: '🟡', label: 'Stale',          color: 'var(--bp-amber)' },
  error:          { dot: '🔴', label: 'Error',          color: 'var(--bp-red)'   },
  disconnected:   { dot: '⚪', label: 'Disconnected',   color: 'var(--bp-text-3)' },
  syncing:        { dot: '🔵', label: 'Syncing',        color: 'var(--bp-blue)'  },
  not_applicable: { dot: '⚪', label: 'Not applicable', color: 'var(--bp-text-3)' },
}

// Issue #65: the connector's understandable health state — a superset of
// the raw connectivity status above that also distinguishes a
// permission/scope problem (fix: reconnect with the right scope) and a
// partial sync (fix: nothing broken, just incomplete — re-sync) from a
// generic failure, per server/connectors/health.ts.
const HEALTH_STATE: Record<string, { dot: string; label: string; color: string }> = {
  healthy:             { dot: '🟢', label: 'Healthy',             color: 'var(--bp-green)' },
  stale:               { dot: '🟡', label: 'Stale',               color: 'var(--bp-amber)' },
  partial:             { dot: '🟠', label: 'Partial coverage',    color: 'var(--bp-amber)' },
  failing:             { dot: '🔴', label: 'Failing',             color: 'var(--bp-red)'   },
  permission_required: { dot: '🟣', label: 'Permission required', color: '#818cf8'         },
  not_applicable:      { dot: '⚪', label: 'Not applicable',      color: 'var(--bp-text-3)' },
}

const AGENT_STATUS: Record<string, { color: string; label: string }> & { idle: { color: string; label: string } } = {
  ok:       { color: 'var(--bp-green)', label: 'Ok' },
  failing:  { color: 'var(--bp-red)',   label: 'Failing' },
  disabled: { color: 'var(--bp-text-3)', label: 'Disabled' },
  idle:     { color: 'var(--bp-text-3)', label: 'Idle' },
}

const READINESS_STATUS: Record<string, { color: string; dot: string; label: string }> = {
  active:        { color: 'var(--bp-green)',  dot: '🟢', label: 'Active' },
  pending:       { color: 'var(--bp-amber)',  dot: '🟡', label: 'Pending' },
  paused:        { color: 'var(--bp-text-3)', dot: '⏸',  label: 'Paused' },
  retired:       { color: 'var(--bp-text-3)', dot: '⚪', label: 'Retired' },
  not_installed: { color: 'var(--bp-text-3)', dot: '⚪', label: 'Not hired' },
}

function fmtRel(iso: string | null | undefined) {
  if (!iso) return '—'
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) }
  catch { return '—' }
}

function fmtMinutes(mins: number | null | undefined) {
  if (mins == null) return '—'
  if (mins < 0) return `${Math.abs(Math.round(mins))}m overdue`
  if (mins < 60) return `${Math.round(mins)}m`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

// ─── Section header ───────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
// Grouped by business (server already sorts connectors by business, type —
// see system-health.ts's `ORDER BY b.name, c.type`), with an optional
// business filter so a large multi-business install isn't one giant list.
function ConnectorsTable({ connectors, onSync }: { connectors: any[]; onSync: (id: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const [businessFilter, setBusinessFilter] = useState<string>('all')

  if (!connectors?.length) {
    return <div style={{ padding: 16, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
      No connectors configured.
    </div>
  }

  const businesses = Array.from(new Set(connectors.map((c) => c.business_name))).sort()
  const visible = businessFilter === 'all' ? connectors : connectors.filter((c) => c.business_name === businessFilter)

  async function handleSync(id: string) {
    setSyncing(prev => ({ ...prev, [id]: true }))
    try { await onSync(id) } catch {}
    finally { setSyncing(prev => ({ ...prev, [id]: false })) }
  }

  return (
    <div>
      {businesses.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Business</span>
          <select
            value={businessFilter}
            onChange={(e) => setBusinessFilter(e.target.value)}
            className="bp-select"
            style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}
          >
            <option value="all">All businesses</option>
            {businesses.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      )}
      <div className="bp-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'var(--bp-surface-2)' }}>
              <Th>Connector</Th>
              <Th>Business</Th>
              <Th>Health</Th>
              <Th>Last success</Th>
              <Th>Next sync</Th>
              <Th align="right">Metrics</Th>
              <Th align="right">Signals</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const healthCfg = HEALTH_STATE[c.health_state] ?? HEALTH_STATE[c.status] ?? CONN_STATUS[c.status] ?? CONN_STATUS.disconnected
              const degraded = c.health_state && c.health_state !== 'healthy' && c.health_state !== 'not_applicable'
              const rowBg = c.health_state === 'failing' ? 'rgba(255,82,82,0.05)'
                         : c.health_state === 'permission_required' ? 'rgba(129,140,248,0.06)'
                         : (c.health_state === 'stale' || c.health_state === 'partial') ? 'rgba(245,158,11,0.05)'
                         : 'transparent'
              const overdue = c.health_state === 'stale' && c.next_sync_in_minutes != null && c.next_sync_in_minutes < 0
              const actionable = c.health_state === 'stale' || c.health_state === 'failing' || c.health_state === 'partial' || c.health_state === 'permission_required'
              const hasDetail = !!(c.health_impact || c.health_next_step || c.last_error)
              return (
                <React.Fragment key={c.id}>
                  <tr style={{ borderBottom: '1px solid var(--bp-border)', background: rowBg }}>
                    <Td><strong style={{ color: 'var(--bp-text)' }}>{c.name}</strong></Td>
                    <Td>{c.business_name}</Td>
                    <Td>
                      <span style={{ color: healthCfg.color }} title={c.health_summary}>
                        {healthCfg.dot} {healthCfg.label}
                      </span>
                      {c.health_coverage_complete === false && (
                        <span style={{ marginLeft: 6, color: 'var(--bp-amber)' }} title="Latest sync did not capture the full dataset">partial</span>
                      )}
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
                      {hasDetail && (
                        <button
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                          className="bp-btn bp-btn-ghost"
                          style={{ fontSize: 10, padding: '3px 8px', marginLeft: 4 }}
                        >
                          {expanded === c.id ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                          details
                        </button>
                      )}
                    </Td>
                  </tr>
                  {expanded === c.id && hasDetail && (
                    <tr style={{ background: degraded ? 'rgba(245,158,11,0.05)' : 'transparent' }}>
                      <td colSpan={8} style={{ padding: 12, fontSize: 10, borderBottom: '1px solid var(--bp-border)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {c.health_impact && (
                            <div style={{ color: 'var(--bp-text-2)' }}>
                              <strong style={{ color: 'var(--bp-text)' }}>Impact:</strong> {c.health_impact}
                            </div>
                          )}
                          {c.health_next_step && (
                            <div style={{ color: 'var(--bp-text-2)' }}>
                              <strong style={{ color: 'var(--bp-text)' }}>Next step:</strong> {c.health_next_step}
                            </div>
                          )}
                          {c.last_error && (
                            <div style={{ color: 'var(--bp-red)' }}>
                              <strong>Last error:</strong> {c.last_error}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: string }) {
  return (
    <th style={{
      padding: '10px 14px',
      textAlign: align as any,
      fontFamily: 'var(--bp-font-mono)',
      fontSize: 9,
      letterSpacing: '0.10em',
      textTransform: 'uppercase',
      color: 'var(--bp-text-3)',
      fontWeight: 500,
    }}>{children}</th>
  )
}

function Td({ children, align = 'left' }: { children?: React.ReactNode; align?: string }) {
  return (
    <td style={{
      padding: '10px 14px',
      textAlign: align as any,
      color: 'var(--bp-text-2)',
    }}>{children}</td>
  )
}

// ─── Agents table ─────────────────────────────────────────────────────────────
function AgentsTable({ agents, onRun }: { agents: any[]; onRun: (id: string) => Promise<void> }) {
  const [running, setRunning] = useState<Record<string, boolean>>({})

  async function handleRun(id: string) {
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
            const readinessCfg = READINESS_STATUS[a.readiness_status] ?? null
            const isActive = !a.readiness_status || a.readiness_status === 'active'
            const cfg = AGENT_STATUS[a.status] ?? AGENT_STATUS.idle
            const isFailing = isActive && a.status === 'failing'
            const rowBg = isFailing
              ? 'rgba(255,82,82,0.05)'
              : (!isActive ? 'rgba(245,158,11,0.04)' : 'transparent')

            let dot: string, statusLabel: string, statusColor: string, statusTitle: string | undefined
            if (readinessCfg && !isActive) {
              dot = readinessCfg.dot
              statusLabel = readinessCfg.label
              statusColor = readinessCfg.color
              statusTitle = a.readiness_reason || undefined
              if (a.readiness_status === 'pending' && a.missing_required?.length) {
                statusLabel = `Pending — waiting for ${a.missing_required.join(', ')}`
              }
            } else {
              dot = a.status === 'ok' && a.runs_7d === 0 ? '⚪'
                  : a.status === 'ok' ? '🟢'
                  : a.status === 'failing' ? '🔴'
                  : '⚪'
              statusLabel = a.status === 'ok' && a.runs_7d === 0 ? 'Idle' : cfg.label
              statusColor = cfg.color
            }
            return (
              <tr key={a.id} style={{ borderBottom: '1px solid var(--bp-border)', background: rowBg }}>
                <Td><strong style={{ color: 'var(--bp-text)' }}>{a.name}</strong></Td>
                <Td><span style={{ color: statusColor }} title={statusTitle}>{dot} {statusLabel}</span></Td>
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
function StatsRow({ llm, database, kb }: { llm: any; database: any; kb: any }) {
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

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
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
function SchedulerSection({ scheduler }: { scheduler: any }) {
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
            {scheduler.next_runs.map((j: any) => (
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

function TokenEfficiencySection() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getAgentEfficiency({ days: 7 })
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>Loading…</div>
  }
  if (!data) {
    return <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>No data yet — run some agents to see efficiency stats.</div>
  }

  const byType = Object.fromEntries((data.by_trigger_type ?? []).map((r: any) => [r.trigger_type, r]))
  const eventCount = byType.event?.count ?? 0
  const pollCount = byType.poll?.count ?? 0
  const scheduleCount = byType.schedule?.count ?? 0
  const manualCount = byType.manual?.count ?? 0
  const sleepers = [...(data.per_agent ?? [])]
    .filter((a: any) => a.runs > 0)
    .sort((a: any, b: any) => (b.skipped / Math.max(1, b.runs)) - (a.skipped / Math.max(1, a.runs)))
    .slice(0, 3)

  const Stat = ({ label, value, color, hint }: { label: string; value: React.ReactNode; color?: string; hint?: string }) => (
    <div style={{ padding: '10px 12px', background: 'var(--bp-bg)', border: '1px solid var(--bp-border)', borderRadius: 4 }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 18, fontWeight: 600, color: color ?? 'var(--bp-text)' }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 2 }}>
          {hint}
        </div>
      )}
    </div>
  )

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 12 }}>
        <Stat
          label="Event-triggered"
          value={eventCount}
          color="var(--bp-green)"
          hint="Ideal — woken by what actually happened"
        />
        <Stat
          label="Poll-triggered"
          value={pollCount}
          color="var(--bp-cyan)"
          hint="Safety-net fallback runs"
        />
        <Stat
          label="Skipped (work-check)"
          value={data.total_skipped}
          color="var(--bp-text-2)"
          hint={`${Math.round((data.skip_rate ?? 0) * 100)}% of all runs cost zero tokens`}
        />
        <Stat
          label="Est. token savings"
          value={data.estimated_savings?.tokens != null ? data.estimated_savings.tokens.toLocaleString() : '—'}
          color="var(--bp-amber)"
          hint={data.estimated_savings?.cost_usd != null ? `≈ $${data.estimated_savings.cost_usd.toFixed(4)}` : ''}
        />
      </div>

      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 10, paddingLeft: 2 }}>
        <strong style={{ color: 'var(--bp-text)' }}>{data.total_complete}</strong> completed,{' '}
        <strong style={{ color: 'var(--bp-text)' }}>{manualCount}</strong> manual,{' '}
        <strong style={{ color: 'var(--bp-text)' }}>{scheduleCount}</strong> scheduled,{' '}
        <strong style={{ color: 'var(--bp-text)' }}>{data.total_runs}</strong> total runs{' '}
        over the last {data.window_days} days — ${data.total_cost_usd?.toFixed(4) ?? '0.0000'} spent.
      </div>

      {data.top_event_triggers?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            Most active event triggers
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.top_event_triggers.slice(0, 5).map((t: any) => (
              <span key={t.trigger} style={{
                fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                padding: '2px 8px', background: 'var(--bp-bg)',
                border: '1px solid var(--bp-border)', borderRadius: 3,
                color: 'var(--bp-text-2)',
              }}>
                {t.trigger} · {t.count}
              </span>
            ))}
          </div>
        </div>
      )}

      {sleepers.length > 0 && (
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            Most frequently sleeping
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {sleepers.map((a: any) => (
              <span key={a.agent_id} style={{
                fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                padding: '2px 8px', background: 'var(--bp-bg)',
                border: '1px solid var(--bp-border)', borderRadius: 3,
                color: 'var(--bp-text-2)',
              }}>
                {a.agent_id} · {a.skipped}/{a.runs} skipped
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SelfHealingSection() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [healingTasks, setHealingTasks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!currentBusiness) { setLoading(false); return }
    getTasks(currentBusiness.id, { limit: 100 })
      .then((data) => {
        const rows = Array.isArray(data?.tasks) ? data.tasks : (Array.isArray(data) ? data : [])
        setHealingTasks(rows.filter((t: any) => t.proposed_by === 'self-healer'))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [currentBusiness])

  const total = healingTasks.length
  const withPR = healingTasks.filter(t => t.outcome_data?.issue_url).length
  const resolved = healingTasks.filter(t => t.status === 'complete').length
  const needsReview = healingTasks.filter(t => t.status === 'proposed').length

  return (
    <div>
      <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 14 }}>
        Blueprint automatically diagnoses failures, proposes fixes, and creates draft PRs for human review.
        PRs always target <code>develop</code>, always draft — never auto-merged.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
        {[
          { label: 'Errors diagnosed', value: total, color: 'var(--bp-text)' },
          { label: 'Draft PRs created', value: withPR, color: '#818cf8' },
          { label: 'Fixed & resolved', value: resolved, color: 'var(--bp-green)' },
          { label: 'Awaiting review', value: needsReview, color: 'var(--bp-amber)' },
        ].map(c => (
          <div key={c.label} style={{ padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3 }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 18, fontWeight: 700, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>
      {loading && <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>Loading…</div>}
      {!loading && healingTasks.length === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: 'var(--bp-surface-2)', borderRadius: 4 }}>
          <CheckCircle2 size={14} style={{ color: 'var(--bp-green)', flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
            No self-healing events yet. Errors will appear here when they occur.
          </span>
        </div>
      )}
      {healingTasks.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bp-border)' }}>
              {['Date', 'Component', 'Diagnosis', 'PR', 'Status'].map(h => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, fontSize: 9, letterSpacing: '0.08em', color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {healingTasks.slice(0, 20).map((t) => {
              const issueUrl = t.outcome_data?.issue_url
              const statusColor = t.status === 'complete' ? 'var(--bp-green)' : t.status === 'failed' ? 'var(--bp-red)' : 'var(--bp-amber)'
              return (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--bp-border)' }}>
                  <td style={{ padding: '8px 8px', color: 'var(--bp-text-3)', whiteSpace: 'nowrap' }}>
                    {t.created_at ? formatDistanceToNow(parseTimestamp(t.created_at) ?? new Date(), { addSuffix: true }) : '—'}
                  </td>
                  <td style={{ padding: '8px 8px', color: 'var(--bp-text-2)' }}>
                    {t.action_payload?.component || t.proposed_by || '—'}
                  </td>
                  <td style={{ padding: '8px 8px', color: 'var(--bp-text)', maxWidth: 260 }}>
                    <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {t.description?.split('\n')[0]?.slice(0, 140) || t.title || '—'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 8px' }}>
                    {issueUrl
                      ? <a href={issueUrl} target="_blank" rel="noreferrer" style={{ color: '#818cf8', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <ExternalLink size={10} /> Issue
                        </a>
                      : <span style={{ color: 'var(--bp-text-3)' }}>—</span>}
                  </td>
                  <td style={{ padding: '8px 8px', color: statusColor, whiteSpace: 'nowrap' }}>{t.status}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

const CONFIDENCE_STATUS: Record<string, { dot: string; color: string }> & { unknown: { dot: string; color: string } } = {
  healthy:  { dot: '🟢', color: 'var(--bp-green)' },
  warning:  { dot: '🟡', color: 'var(--bp-amber)' },
  degraded: { dot: '🟠', color: 'var(--bp-amber)' },
  broken:   { dot: '🔴', color: 'var(--bp-red)' },
  unknown:  { dot: '⚪', color: 'var(--bp-text-3)' },
}

// ─── Connector Confidence & Identity Verification (Phase 2-INT) ─────────────
function ConnectorConfidenceSection() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [confidence, setConfidence] = useState<any[] | null>(null)

  useEffect(() => {
    if (!currentBusiness) return
    getConnectorConfidence(currentBusiness.id)
      .then((res: any) => setConfidence(res.connector_confidence))
      .catch(() => setConfidence(null))
  }, [currentBusiness])

  if (!confidence || confidence.length === 0) return null

  return (
    <div className="bp-card" style={{ padding: 18 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--bp-text-3)', textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.08em' }}>
            <th style={{ padding: '4px 8px' }}>Connector</th>
            <th style={{ padding: '4px 8px' }}>Overall</th>
            <th style={{ padding: '4px 8px' }}>Business Identity</th>
            <th style={{ padding: '4px 8px' }}>Website Verification</th>
            <th style={{ padding: '4px 8px' }}>Freshness</th>
            <th style={{ padding: '4px 8px' }}>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {confidence.map((c: any) => {
            const overall = CONFIDENCE_STATUS[c.overall_status] ?? CONFIDENCE_STATUS.unknown
            return (
              <tr key={c.id} style={{ borderTop: '1px solid var(--bp-border)' }}>
                <td style={{ padding: '6px 8px', color: 'var(--bp-text-2)' }}>{c.connector_id.slice(0, 8)}</td>
                <td style={{ padding: '6px 8px', color: overall.color }}>{overall.dot} {c.overall_status}</td>
                <td style={{ padding: '6px 8px', color: (CONFIDENCE_STATUS[c.business_identity_status] ?? CONFIDENCE_STATUS.unknown).color }}>{c.business_identity_status}</td>
                <td style={{ padding: '6px 8px', color: (CONFIDENCE_STATUS[c.website_verification_status] ?? CONFIDENCE_STATUS.unknown).color }}>{c.website_verification_status}</td>
                <td style={{ padding: '6px 8px', color: (CONFIDENCE_STATUS[c.freshness_status] ?? CONFIDENCE_STATUS.unknown).color }}>{c.freshness_status}</td>
                <td style={{ padding: '6px 8px', color: 'var(--bp-text-2)' }}>{Math.round((c.overall_confidence ?? 0) * 100)}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── World Model (Phase 2-INT) ──────────────────────────────────────────────
function WorldModelSection() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [snapshot, setSnapshot] = useState<any>(null)

  useEffect(() => {
    if (!currentBusiness) return
    getWorldModel(currentBusiness.id)
      .then((res: any) => setSnapshot(res.world_model))
      .catch(() => setSnapshot(null))
  }, [currentBusiness])

  if (!snapshot) return null
  const s = snapshot.snapshot

  const trendColor = (dir: string) => dir === 'improving' ? 'var(--bp-green)' : dir === 'declining' ? 'var(--bp-red)' : dir === 'stable' ? 'var(--bp-blue)' : 'var(--bp-text-3)'

  return (
    <div className="bp-card" style={{ padding: 18 }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 12 }}>
        Snapshot taken {fmtRel(snapshot.created_at)} · triggered by <span style={{ color: 'var(--bp-text-2)' }}>{snapshot.trigger_source}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 14 }}>
        {[
          { label: 'Business Health', value: s.business_health.status },
          { label: 'Revenue Trend', value: s.revenue_trend.direction },
          { label: 'Traffic Trend', value: s.traffic_trend.direction },
          { label: 'SEO Trend', value: s.seo_trend.direction },
          { label: 'Marketing Trend', value: s.marketing_trend.direction },
        ].map((c) => (
          <div key={c.label} style={{ padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3 }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 14, fontWeight: 700, color: trendColor(c.value) }}>{c.value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {[
          { label: 'Open Risks', value: s.open_risks.length },
          { label: 'Open Opportunities', value: s.open_opportunities.length },
          { label: 'Outstanding Investigations', value: s.outstanding_investigations },
          { label: 'Low-Confidence Connectors', value: s.connector_confidence.low_confidence_count },
        ].map((c) => (
          <div key={c.label} style={{ padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3 }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 18, fontWeight: 700, color: 'var(--bp-blue)' }}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SystemHealth() {
  const [data, setData] = useState<any>(null)
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

  async function handleSync(id: string) {
    await syncConnector(id)
    setTimeout(fetchHealth, 1000)
  }

  async function handleRunAgent(id: string) {
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

      <Section title="Connector Confidence & Identity Verification">
        <ConnectorConfidenceSection />
      </Section>

      <Section title="World Model">
        <WorldModelSection />
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

      <Section title="Token Efficiency (last 7 days)">
        <TokenEfficiencySection />
      </Section>

      <Section title="Self-Healing">
        <SelfHealingSection />
      </Section>
    </div>
  )
}

function BrainSection() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [brain, setBrain] = useState<any>(null)

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
            Still in measurement window
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {brain.still_waiting.slice(0, 5).map((w: any, i: number) => (
              <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', padding: '4px 0', borderBottom: '1px solid var(--bp-border)' }}>
                {w.title} <span style={{ color: 'var(--bp-text-3)' }}>— {fmtRel(w.executed_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
