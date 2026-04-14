import React, { useEffect, useState, useCallback } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { ChevronRight, ChevronLeft, Play, Settings } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import useStore from '../lib/store.js'
import { getAgentStatuses, runAgent } from '../lib/api.js'

function fmtRel(iso) {
  if (!iso) return ''
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) } catch { return '' }
}

// Status values emitted by /api/agents-status. Event-driven execution
// (Tranche 6B) introduced SLEEPING (work-check returned false) and STALE
// (hasn't run in 2× poll interval), plus PENDING_HIRE for templates that
// aren't installed yet.
const STATUS_COLORS = {
  running:      'var(--bp-green)',
  idle:         'var(--bp-green)',
  sleeping:     'var(--bp-cyan)',      // distinct from idle — deliberately quiet
  stale:        'var(--bp-amber)',
  error:        'var(--bp-red)',
  paused:       'var(--bp-text-3)',
  pending_hire: 'var(--bp-text-3)',
  scheduled:    'var(--bp-amber)',
}

const STATUS_LABELS = {
  running:      'RUNNING',
  idle:         'IDLE',
  sleeping:     'SLEEPING',
  stale:        'STALE',
  error:        'FAILED',
  paused:       'PAUSED',
  pending_hire: 'PENDING HIRE',
  scheduled:    'SCHEDULED',
}

function StatusDot({ status }) {
  const color = STATUS_COLORS[status] ?? 'var(--bp-text-3)'
  const isAnimated = status === 'running'
  // Sleeping gets a muted outline rather than a solid dot — visual
  // distinction between "actively idle" and "deliberately resting".
  const isSleeping = status === 'sleeping'
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%',
      background: isSleeping ? 'transparent' : color,
      border: isSleeping ? `1.5px solid ${color}` : 'none',
      animation: isAnimated ? 'bp-pulse 1.5s ease-in-out infinite' : 'none',
      boxShadow: isAnimated ? `0 0 6px ${color}` : 'none',
      display: 'inline-block', flexShrink: 0,
    }} />
  )
}

function AgentRow({ agent, onRun, running, collapsed }) {
  const navigate = useNavigate()

  if (collapsed) {
    return (
      <div
        title={`${agent.name} (${agent.status})`}
        onClick={() => navigate(`/agents/${agent.id}`)}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '8px 0', cursor: 'pointer', position: 'relative',
        }}>
        <span style={{ fontSize: 18 }}>{agent.avatar}</span>
        <span style={{ position: 'absolute', right: 8, top: 10 }}>
          <StatusDot status={agent.status} />
        </span>
      </div>
    )
  }

  const isRunning = agent.status === 'running'
  return (
    <div style={{
      padding: '10px 14px',
      borderBottom: '1px solid var(--bp-border)',
      animation: isRunning ? 'bp-pulse 2s ease-in-out infinite' : 'none',
      background: isRunning ? 'rgba(0,201,167,0.03)' : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 14 }}>{agent.avatar}</span>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', flex: 1 }}>
          {agent.name}
        </span>
        <StatusDot status={agent.status} />
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {STATUS_LABELS[agent.status] ?? String(agent.status).toUpperCase()}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginBottom: 6, paddingLeft: 20 }}>
        {agent.last_run ? `Last: ${fmtRel(agent.last_run)}` : 'never run'}
        {agent.last_run_trigger ? ` · ${agent.last_run_trigger}` : ''}
        {agent.cost_today_usd > 0 ? ` · $${agent.cost_today_usd.toFixed(3)} today` : ''}
        {agent.consecutive_failures > 0 ? ` · ⚠ ${agent.consecutive_failures} failures` : ''}
      </div>
      {agent.status === 'sleeping' && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', fontStyle: 'italic', paddingLeft: 20, marginBottom: 6 }}>
          {`Waiting for the next event or ${agent.poll_interval_minutes ?? 60}-min poll`}
        </div>
      )}
      {agent.status === 'stale' && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-amber)', paddingLeft: 20, marginBottom: 6 }}>
          {`Hasn't run in over ${Math.round((agent.poll_interval_minutes ?? 60) * 2 / 60)} h — investigate`}
        </div>
      )}
      {agent.status === 'pending_hire' && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', fontStyle: 'italic', paddingLeft: 20, marginBottom: 6 }}>
          Connect required data sources to activate
        </div>
      )}
      {isRunning && agent.current_task && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-2)', fontStyle: 'italic', paddingLeft: 20, marginBottom: 6 }}>
          {agent.current_task}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, paddingLeft: 20 }}>
        {!isRunning && (
          <button
            onClick={() => onRun(agent.id)}
            disabled={running === agent.id}
            style={{
              padding: '3px 8px', fontSize: 10, background: 'transparent',
              border: '1px solid var(--bp-border)', borderRadius: 3, cursor: 'pointer',
              color: 'var(--bp-text-2)', fontFamily: 'var(--bp-font-mono)',
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
            <Play size={9} /> {running === agent.id ? 'Starting' : 'Run'}
          </button>
        )}
        <button
          onClick={() => navigate(`/agents/${agent.id}`)}
          style={{
            padding: '3px 8px', fontSize: 10, background: 'transparent',
            border: '1px solid var(--bp-border)', borderRadius: 3, cursor: 'pointer',
            color: 'var(--bp-text-2)', fontFamily: 'var(--bp-font-mono)',
            display: 'inline-flex', alignItems: 'center', gap: 3,
          }}>
          <Settings size={9} />
        </button>
      </div>
    </div>
  )
}

export default function AgentPanel({ open, onToggle }) {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [data, setData] = useState(null)
  const [running, setRunning] = useState(null)

  const fetch = useCallback(async () => {
    try {
      const result = await getAgentStatuses()
      setData(result)
    } catch {}
  }, [])

  useEffect(() => {
    fetch()
    const interval = setInterval(fetch, 30000)
    return () => clearInterval(interval)
  }, [fetch])

  // Subscribe to SSE for real-time updates
  useEffect(() => {
    if (!currentBusiness) return
    let es
    try {
      es = new EventSource(`/api/dashboard/stream/${currentBusiness.id}`)
      es.onmessage = (evt) => {
        try {
          const { type } = JSON.parse(evt.data)
          if (['agent_run_started', 'agent_run_complete', 'agent_run_failed'].includes(type)) {
            fetch()
          }
        } catch {}
      }
      es.onerror = () => { try { es.close() } catch {} }
    } catch {}
    return () => { try { es?.close() } catch {} }
  }, [currentBusiness, fetch])

  async function handleRun(agentId) {
    if (!currentBusiness) return
    setRunning(agentId)
    try {
      await runAgent(agentId, { business_id: currentBusiness.id })
      setTimeout(fetch, 1000)
    } catch {}
    finally { setTimeout(() => setRunning(null), 1500) }
  }

  if (!data) return null

  const width = open ? 280 : 48
  return (
    <aside style={{
      width,
      borderLeft: '1px solid var(--bp-border)',
      background: 'var(--bp-surface)',
      display: 'flex', flexDirection: 'column',
      transition: 'width 180ms ease',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px', borderBottom: '1px solid var(--bp-border)',
      }}>
        {open && (
          <div style={{
            fontFamily: 'var(--bp-font-mono)', fontSize: 10,
            letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase',
          }}>Agents</div>
        )}
        <button onClick={onToggle} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--bp-text-3)', padding: 0,
        }}>
          {open ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {data.agents.map(a => (
          <AgentRow key={a.id} agent={a} onRun={handleRun} running={running} collapsed={!open} />
        ))}
      </div>

      {open && (
        <div style={{
          padding: '10px 14px', borderTop: '1px solid var(--bp-border)',
          fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)',
        }}>
          <div style={{ color: 'var(--bp-text-2)', marginBottom: 2 }}>
            Total today: <strong style={{ color: 'var(--bp-text)' }}>${data.total_cost_today.toFixed(3)}</strong>
          </div>
          Runs: {data.runs_today}
        </div>
      )}
    </aside>
  )
}
