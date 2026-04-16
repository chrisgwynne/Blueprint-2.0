import React, { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import { Play, Pause, Settings, RefreshCw, AlertCircle } from 'lucide-react'
import clsx from 'clsx'
import { runAgent, updateAgent } from '../lib/api.js'
import useStore from '../lib/store.js'

interface AgentCardAgent {
  id: string
  name: string
  status: string
  avatar?: string
  title?: string
  model?: string
  last_run?: string | null
  next_run?: string | null
  tasks_proposed?: number | null
  tasks_accepted?: number | null
  cost_today?: number | null
  last_error?: string | null
  [key: string]: unknown
}

function AgentCard({ agent, onUpdate }: { agent: AgentCardAgent; onUpdate?: () => void }) {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const addNotification = useStore((s) => s.addNotification)
  const [running, setRunning] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [showConfig, setShowConfig] = useState(false)

  const isActive  = agent.status === 'active'
  const isRunning = agent.status === 'running'
  const isPaused  = agent.status === 'paused' || agent.status === 'disabled'

  const dotClass = isRunning ? 'pulse-dot-blue' :
                   isActive  ? 'pulse-dot-green' :
                   agent.status === 'error' ? 'pulse-dot-red' : 'pulse-dot-gray'

  const statusLabel = isRunning ? 'RUNNING' :
                      isActive  ? 'ACTIVE'  :
                      agent.status === 'error' ? 'ERROR' :
                      isPaused  ? 'PAUSED'  : 'IDLE'

  const acceptanceRate = agent.tasks_accepted && agent.tasks_proposed
    ? Math.round((agent.tasks_accepted / agent.tasks_proposed) * 100)
    : null

  const rateColor = acceptanceRate == null ? 'var(--bp-text-3)'
    : acceptanceRate >= 70 ? 'var(--bp-green)'
    : acceptanceRate >= 40 ? 'var(--bp-amber)'
    : 'var(--bp-red)'

  async function handleRun() {
    if (!currentBusiness) return
    setRunning(true)
    try {
      await runAgent(agent.id, { business_id: currentBusiness.id })
      addNotification({ type: 'success', title: agent.name, message: 'Agent run started' })
      onUpdate?.()
    } catch (err: any) {
      addNotification({ type: 'error', title: 'Run failed', message: err.message })
    } finally {
      setRunning(false)
    }
  }

  async function handleToggle() {
    setToggling(true)
    try {
      const newStatus = isActive || isRunning ? 'paused' : 'active'
      await updateAgent(agent.id, { status: newStatus })
      addNotification({ type: 'success', message: `Agent ${newStatus}` })
      onUpdate?.()
    } catch (err: any) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setToggling(false)
    }
  }

  const lastRun = agent.last_run
    ? formatDistanceToNow(parseTimestamp(agent.last_run) || new Date(), { addSuffix: true })
    : 'Never'

  return (
    <div className="bp-card" style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: 0, overflow: 'hidden' }}>
      {/* Top section */}
      <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--bp-border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {/* Avatar */}
          <div style={{ fontSize: 28, lineHeight: 1, flexShrink: 0, marginTop: 2 }}>
            {agent.avatar || '🤖'}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 15, color: 'var(--bp-text)' }}>
                {agent.name}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto' }}>
                <span className={clsx('pulse-dot', dotClass)} />
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.08em', color: 'var(--bp-text-3)' }}>
                  {statusLabel}
                </span>
              </div>
            </div>
            {agent.title && (
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
                {agent.title}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Metrics */}
      <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        {/* Model */}
        {agent.model && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Model</span>
            <span className="bp-pill bp-pill-blue" style={{ padding: '1px 6px', fontSize: 9 }}>{agent.model}</span>
          </div>
        )}

        {/* Last run */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Last run</span>
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)' }}>{lastRun}</span>
        </div>

        {/* Tasks proposed (7d) */}
        {agent.tasks_proposed != null && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Tasks proposed (7d)</span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)' }}>{agent.tasks_proposed}</span>
          </div>
        )}

        {/* Acceptance rate */}
        {acceptanceRate != null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Acceptance rate</span>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: rateColor, fontWeight: 600 }}>{acceptanceRate}%</span>
            </div>
            <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${acceptanceRate}%`, background: rateColor, borderRadius: 2, transition: 'width 600ms ease-out' }} />
            </div>
          </div>
        )}

        {/* Cost */}
        {agent.cost_today != null && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Cost today</span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)' }}>
              £{(agent.cost_today || 0).toFixed(3)}
            </span>
          </div>
        )}

        {/* Next run */}
        {agent.next_run && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Next run</span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)' }}>
              {formatDistanceToNow(parseTimestamp(agent.next_run) || new Date(), { addSuffix: true })}
            </span>
          </div>
        )}

        {/* Error */}
        {agent.last_error && (
          <div style={{ display: 'flex', gap: 6, padding: '8px', background: 'rgba(239,68,68,0.08)', borderRadius: 4, border: '1px solid rgba(239,68,68,0.15)' }}>
            <AlertCircle size={12} style={{ color: 'var(--bp-red)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)', lineHeight: 1.4 }}>
              {agent.last_error}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bp-border)', display: 'flex', gap: 8 }}>
        <button
          onClick={handleRun}
          disabled={running || isRunning}
          className="bp-btn bp-btn-primary"
          style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
        >
          {running ? (
            <RefreshCw size={12} style={{ animation: 'bp-spin-slow 1s linear infinite' }} />
          ) : (
            <Play size={12} />
          )}
          {running ? 'Running…' : 'Run Now'}
        </button>
        <button
          onClick={handleToggle}
          disabled={toggling}
          className="bp-btn bp-btn-secondary"
          style={{ fontSize: 11 }}
          title={isActive ? 'Pause agent' : 'Enable agent'}
        >
          {toggling ? <RefreshCw size={12} /> : isPaused ? <Play size={12} /> : <Pause size={12} />}
        </button>
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="bp-btn bp-btn-ghost"
          style={{ fontSize: 11 }}
          title="Configure"
        >
          <Settings size={12} />
        </button>
      </div>
    </div>
  )
}

export default AgentCard
