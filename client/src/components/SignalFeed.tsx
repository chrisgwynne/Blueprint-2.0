import React, { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import { Check, Clock, ArrowRight, Plus } from 'lucide-react'
import clsx from 'clsx'

interface Signal {
  id: string
  severity: string
  connector_type?: string
  metric?: string
  detected_at?: string | null
  created_at?: string | null
  title?: string
  name?: string
  description?: string
  confidence?: number | null
  linked_tasks_count?: number
  [key: string]: unknown
}

const SEVERITY: Record<string, { label: string; dot: string; border: string; pill: string }> = {
  info:        { label: 'INFO',  dot: 'pulse-dot-blue',  border: 'var(--bp-blue)',   pill: 'bp-pill-blue' },
  warning:     { label: 'WARN',  dot: 'pulse-dot-amber', border: 'var(--bp-amber)',  pill: 'bp-pill-amber' },
  alert:       { label: 'ALERT', dot: 'pulse-dot-amber', border: 'var(--bp-orange)', pill: 'bp-pill-amber' },
  critical:    { label: 'CRIT',  dot: 'pulse-dot-red',   border: 'var(--bp-red)',    pill: 'bp-pill-red' },
  opportunity: { label: 'OPP',   dot: 'pulse-dot-green', border: 'var(--bp-green)',  pill: 'bp-pill-green' },
}

function ConfidenceBar({ value }: { value?: number | null }) {
  if (value == null) return null
  const pct = Math.round(value * 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div className="confidence-bar" style={{ width: 60 }}>
        <div className="confidence-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>{pct}%</span>
    </div>
  )
}

function SignalRow({ signal, onSignalClick, onAcknowledge, onSnooze, onCreateTask }: {
  signal: Signal
  onSignalClick?: (signal: Signal) => void
  onAcknowledge?: (signal: Signal) => void
  onSnooze?: (signal: Signal) => void
  onCreateTask?: (signal: Signal) => void
}) {
  const [hovered, setHovered] = useState(false)
  const sev = SEVERITY[signal.severity] || SEVERITY.info
  const age = signal.detected_at || signal.created_at
    ? formatDistanceToNow(parseTimestamp(signal.detected_at || signal.created_at) || new Date(), { addSuffix: true })
    : '—'

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSignalClick?.(signal)}
      style={{
        display: 'flex',
        gap: 12,
        padding: '12px 18px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        borderLeft: `3px solid ${hovered ? sev.border : 'transparent'}`,
        background: hovered ? 'var(--bp-surface-2)' : 'transparent',
        cursor: 'pointer',
        transition: 'all 100ms ease',
      }}
    >
      {/* Left: severity dot */}
      <div style={{ paddingTop: 2 }}>
        <span className={clsx('pulse-dot', sev.dot)} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Top row: severity + connector + type + age */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
          <span className={clsx('bp-pill', sev.pill)} style={{ padding: '1px 5px', fontSize: 9 }}>
            {sev.label}
          </span>
          {signal.connector_type && (
            <span style={{
              fontFamily: 'var(--bp-font-mono)', fontSize: 9,
              padding: '1px 6px', borderRadius: 2,
              background: 'var(--bp-surface-3)',
              color: 'var(--bp-text-3)',
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>
              {signal.connector_type}
            </span>
          )}
          {signal.metric && (
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', letterSpacing: '0.04em' }}>
              {signal.metric}
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', flexShrink: 0 }}>
            {age}
          </span>
        </div>

        {/* Title */}
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text)', marginBottom: 4, lineHeight: 1.4 }}>
          {signal.title || signal.name || 'Untitled signal'}
        </div>

        {/* Description */}
        {signal.description && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 6, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {signal.description}
          </div>
        )}

        {/* Confidence + linked tasks */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ConfidenceBar value={signal.confidence} />
          {signal.linked_tasks_count != null && signal.linked_tasks_count > 0 && (
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-blue)' }}>
              {signal.linked_tasks_count} task{signal.linked_tasks_count !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Actions — show on hover */}
        {hovered && (
          <div
            style={{ display: 'flex', gap: 6, marginTop: 8 }}
            onClick={e => e.stopPropagation()}
          >
            {onAcknowledge && (
              <button
                onClick={() => onAcknowledge(signal)}
                className="bp-btn bp-btn-ghost"
                style={{ fontSize: 10, padding: '2px 8px', color: 'var(--bp-green)', borderColor: 'rgba(16,185,129,0.25)' }}
              >
                <Check size={10} /> Resolve
              </button>
            )}
            {onCreateTask && (
              <button
                onClick={() => onCreateTask(signal)}
                className="bp-btn bp-btn-ghost"
                style={{ fontSize: 10, padding: '2px 8px' }}
              >
                <Plus size={10} /> Task
              </button>
            )}
            {onSnooze && (
              <button
                onClick={() => onSnooze(signal)}
                className="bp-btn bp-btn-ghost"
                style={{ fontSize: 10, padding: '2px 8px', color: 'var(--bp-amber)', borderColor: 'rgba(245,158,11,0.25)' }}
              >
                <Clock size={10} /> Snooze
              </button>
            )}
            <button
              onClick={() => onSignalClick?.(signal)}
              className="bp-btn bp-btn-ghost"
              style={{ fontSize: 10, padding: '2px 8px' }}
            >
              <ArrowRight size={10} /> View
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SignalFeed({ signals = [], onSignalClick, onAcknowledge, onSnooze, onCreateTask, maxHeight }: {
  signals?: Signal[]
  onSignalClick?: (signal: Signal) => void
  onAcknowledge?: (signal: Signal) => void
  onSnooze?: (signal: Signal) => void
  onCreateTask?: (signal: Signal) => void
  maxHeight?: number | string
}) {
  if (signals.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 20px', textAlign: 'center' }}>
        <div style={{
          width: 40, height: 40,
          borderRadius: '50%',
          background: 'rgba(16,185,129,0.1)',
          border: '1px solid rgba(16,185,129,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 12,
        }}>
          <Check size={18} style={{ color: 'var(--bp-green)' }} />
        </div>
        <p style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text-2)', marginBottom: 4 }}>All clear</p>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>Agents are monitoring — no signals detected</p>
      </div>
    )
  }

  return (
    <div style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      {signals.map(signal => (
        <SignalRow
          key={signal.id}
          signal={signal}
          onSignalClick={onSignalClick}
          onAcknowledge={onAcknowledge}
          onSnooze={onSnooze}
          onCreateTask={onCreateTask}
        />
      ))}
    </div>
  )
}

export default SignalFeed
