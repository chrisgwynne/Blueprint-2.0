import React, { useEffect, useState, useCallback, useRef } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  RefreshCw, Check, Clock, Plus, X,
  Brain, Zap, TrendingUp, AlertTriangle,
  Lightbulb, Activity, BarChart2, Cpu, ChevronRight, ChevronUp, ChevronDown, Sparkles,
} from 'lucide-react'
import clsx from 'clsx'
import useStore from '../lib/store.js'
import {
  getSignals, updateSignal, createTask,
  triggerAnalysis, getAnalysisStatus,
  getSignalSummary, createTaskFromSignal,
} from '../lib/api.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_CONFIG = {
  info:        { label: 'INFO',   dot: 'pulse-dot-blue',  pill: 'bp-pill-blue',   border: 'var(--bp-blue)',   bg: 'rgba(77,166,255,0.06)'  },
  warning:     { label: 'WARN',   dot: 'pulse-dot-amber', pill: 'bp-pill-amber',  border: 'var(--bp-amber)',  bg: 'rgba(245,158,11,0.06)'  },
  alert:       { label: 'ALERT',  dot: 'pulse-dot-amber', pill: 'bp-pill-amber',  border: 'var(--bp-orange)', bg: 'rgba(255,140,66,0.06)'  },
  critical:    { label: 'CRIT',   dot: 'pulse-dot-red',   pill: 'bp-pill-red',    border: 'var(--bp-red)',    bg: 'rgba(255,82,82,0.06)'   },
  opportunity: { label: 'OPP',    dot: 'pulse-dot-green', pill: 'bp-pill-green',  border: 'var(--bp-green)',  bg: 'rgba(0,201,167,0.06)'   },
}

const TYPE_CONFIG = {
  anomaly:     { Icon: Activity,      label: 'Anomaly',     color: 'var(--bp-orange)' },
  risk:        { Icon: AlertTriangle, label: 'Risk',        color: 'var(--bp-red)'    },
  opportunity: { Icon: TrendingUp,    label: 'Opportunity', color: 'var(--bp-green)'  },
  quick_win:   { Icon: Zap,           label: 'Quick Win',   color: 'var(--bp-blue)'   },
  correlation: { Icon: BarChart2,     label: 'Correlation', color: 'var(--bp-purple)' },
}

const SNOOZE_OPTIONS = [
  { label: '1 hour',  hours: 1   },
  { label: '4 hours', hours: 4   },
  { label: '24 hours',hours: 24  },
  { label: '7 days',  hours: 168 },
]

const TABS = [
  { key: 'all',         label: 'All',          Icon: Activity   },
  { key: 'ai',          label: 'AI Insights',  Icon: Brain      },
  { key: 'anomaly',     label: 'Anomalies',    Icon: AlertTriangle },
  { key: 'opportunity', label: 'Opportunities',Icon: Lightbulb  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseData(signal) {
  if (!signal.data) return {}
  if (typeof signal.data === 'object') return signal.data
  try { return JSON.parse(signal.data) } catch { return {} }
}

function healthColor(score) {
  if (score == null) return 'var(--bp-text-3)'
  if (score >= 70) return 'var(--bp-green)'
  if (score >= 40) return 'var(--bp-amber)'
  return 'var(--bp-red)'
}

function fmt(dt) {
  if (!dt) return '—'
  return formatDistanceToNow(new Date(dt), { addSuffix: true })
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ConfidenceBar({ value }) {
  if (value == null) return null
  const pct = Math.round(value * 100)
  const color = pct >= 85 ? 'var(--bp-green)' : pct >= 70 ? 'var(--bp-amber)' : 'var(--bp-red)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 56, height: 3, borderRadius: 2, background: 'var(--bp-surface-3)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color, minWidth: 28 }}>{pct}%</span>
    </div>
  )
}

function HealthGauge({ score }) {
  if (score == null) return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>No score yet</div>
    </div>
  )
  const color = healthColor(score)
  const R = 36
  const C = 2 * Math.PI * R
  const arcLen = C * 0.75
  const filled = (score / 100) * arcLen
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={88} height={52} viewBox="0 0 88 52" style={{ overflow: 'visible' }}>
        <circle cx={44} cy={44} r={R} fill="none" stroke="rgba(255,255,255,0.06)"
          strokeWidth={6} strokeDasharray={`${arcLen} ${C}`} strokeLinecap="round"
          transform="rotate(-225 44 44)" />
        <circle cx={44} cy={44} r={R} fill="none" stroke={color}
          strokeWidth={6} strokeDasharray={`${filled} ${C}`} strokeLinecap="round"
          transform="rotate(-225 44 44)" style={{ transition: 'stroke-dasharray 0.6s ease' }} />
        <text x={44} y={44} textAnchor="middle" dominantBaseline="middle"
          fill={color} fontSize={17} fontFamily="Syne, sans-serif" fontWeight={800}>{score}</text>
      </svg>
      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Health Score</span>
    </div>
  )
}

// ─── Analysis Status Bar ──────────────────────────────────────────────────────

function AnalysisBar({ run, onDismiss }) {
  if (!run) return null
  const isRunning = run.status === 'running'
  const isFailed  = run.status === 'failed'

  return (
    <div style={{
      background: isRunning ? 'rgba(77,166,255,0.07)' : isFailed ? 'rgba(255,82,82,0.07)' : 'rgba(0,201,167,0.07)',
      border: `1px solid ${isRunning ? 'rgba(77,166,255,0.2)' : isFailed ? 'rgba(255,82,82,0.2)' : 'rgba(0,201,167,0.2)'}`,
      borderRadius: 6,
      padding: '10px 14px',
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    }}>
      {isRunning ? (
        <Cpu size={14} style={{ color: 'var(--bp-blue)', animation: 'bp-spin-slow 2s linear infinite', flexShrink: 0 }} />
      ) : isFailed ? (
        <AlertTriangle size={14} style={{ color: 'var(--bp-red)', flexShrink: 0 }} />
      ) : (
        <Check size={14} style={{ color: 'var(--bp-green)', flexShrink: 0 }} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        {isRunning ? (
          <>
            <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 12, color: 'var(--bp-blue)' }}>
              AI Analysis running…
            </span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginLeft: 10 }}>
              Analysing connected data sources
            </span>
          </>
        ) : isFailed ? (
          <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 12, color: 'var(--bp-red)' }}>
            Analysis failed — check server logs
          </span>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 12, color: 'var(--bp-green)' }}>
              Analysis complete
            </span>
            {run.insights_count > 0 && (
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
                {run.insights_count} insight{run.insights_count !== 1 ? 's' : ''} surfaced
                {run.tasks_created > 0 && `, ${run.tasks_created} task${run.tasks_created !== 1 ? 's' : ''} created`}
              </span>
            )}
            {run.summary && (
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {run.summary}
              </span>
            )}
          </div>
        )}
      </div>

      {!isRunning && (
        <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bp-text-3)', padding: 0, lineHeight: 1, flexShrink: 0 }}>
          <X size={13} />
        </button>
      )}

      {isRunning && (
        <div style={{ width: 120, height: 2, background: 'rgba(77,166,255,0.15)', borderRadius: 1, overflow: 'hidden', flexShrink: 0 }}>
          <div style={{ width: '60%', height: '100%', background: 'var(--bp-blue)', borderRadius: 1, animation: 'bp-progress-indeterminate 1.6s ease-in-out infinite' }} />
        </div>
      )}
    </div>
  )
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ summary, onRunAnalysis, analysing }) {
  if (!summary) return null
  const la = summary.lastAnalysis

  return (
    <div className="bp-card" style={{ padding: '16px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
      {/* Health gauge */}
      <HealthGauge score={la?.health_score ?? null} />

      {/* Stats */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, minWidth: 240 }}>
        {[
          { label: 'Total',    value: summary.total,    color: 'var(--bp-text)'   },
          { label: 'Critical', value: summary.critical, color: 'var(--bp-red)'    },
          { label: 'Alerts',   value: summary.alert,    color: 'var(--bp-amber)'  },
          { label: 'AI',       value: summary.ai,       color: 'var(--bp-purple)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 22, color, lineHeight: 1 }}>{value ?? 0}</div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 3, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Last analysis info + run button */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
        {la?.completed_at && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textAlign: 'right' }}>
            Last analysis {fmt(la.completed_at)}
          </div>
        )}
        {la?.summary && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', maxWidth: 220, textAlign: 'right', lineHeight: 1.4 }}>
            {la.summary}
          </div>
        )}
        <button
          onClick={onRunAnalysis}
          disabled={analysing}
          className="bp-btn bp-btn-primary"
          style={{ fontSize: 11, gap: 6 }}
        >
          {analysing
            ? <RefreshCw size={12} style={{ animation: 'bp-spin-slow 1s linear infinite' }} />
            : <Sparkles size={12} />
          }
          {analysing ? 'Analysing…' : 'Run AI Analysis'}
        </button>
      </div>
    </div>
  )
}

// ─── Inline Create Task Panel ─────────────────────────────────────────────────

function CreateTaskPanel({ signal, onClose, onCreated }) {
  const addNotification = useStore((s) => s.addNotification)
  const d = parseData(signal)
  const pt = d.proposed_task || {}
  const [title, setTitle] = useState(pt.title || `Investigate: ${signal.title}`)
  const [description, setDescription] = useState(pt.description || signal.description || '')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      if (signal.rule_id === 'ai_analysis') {
        await createTaskFromSignal(signal.id, {
          title: title.trim(),
          description: description.trim(),
          agentId: pt.agent || 'conductor',
          priority: d.priority || 'p2',
          actionType: pt.action_type || null,
        })
      } else {
        await createTask({
          title: title.trim(),
          description: description.trim(),
          signal_id: signal.id,
          priority: signal.severity === 'critical' ? 'p1' : signal.severity === 'alert' ? 'p2' : 'p3',
        })
      }
      addNotification({ type: 'success', message: 'Task created' })
      onCreated?.()
      onClose()
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{
      marginTop: 12,
      padding: 14,
      background: 'var(--bp-base)',
      borderRadius: 4,
      border: '1px solid var(--bp-border-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontFamily: 'var(--bp-font-display)', fontSize: 11, fontWeight: 700, color: 'var(--bp-text)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Create Task</span>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bp-text-3)', padding: 0 }}>
          <X size={12} />
        </button>
      </div>

      {pt.estimated_impact && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-green)', marginBottom: 10, padding: '5px 8px', background: 'rgba(0,201,167,0.07)', borderRadius: 3, border: '1px solid rgba(0,201,167,0.15)' }}>
          Expected impact: {pt.estimated_impact}
        </div>
      )}

      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        className="bp-input"
        style={{ width: '100%', marginBottom: 8, fontSize: 12 }}
        placeholder="Task title…"
      />
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        className="bp-input"
        rows={3}
        style={{ width: '100%', resize: 'vertical', fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}
        placeholder="Description…"
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}>Cancel</button>
        <button type="submit" disabled={submitting || !title.trim()} className="bp-btn bp-btn-primary" style={{ fontSize: 10 }}>
          {submitting ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Plus size={11} />}
          Create Task
        </button>
      </div>
    </form>
  )
}

// ─── Signal Card ──────────────────────────────────────────────────────────────

function SignalCard({ signal, onUpdate }) {
  const addNotification = useStore((s) => s.addNotification)
  const [expanded, setExpanded]       = useState(false)
  const [snoozeOpen, setSnoozeOpen]   = useState(false)
  const [taskOpen, setTaskOpen]       = useState(false)
  const [acting, setActing]           = useState(false)

  const sev  = SEVERITY_CONFIG[signal.severity] || SEVERITY_CONFIG.info
  const data = parseData(signal)
  const isAI = signal.rule_id === 'ai_analysis'
  const typeInfo = TYPE_CONFIG[signal.type] || null

  const age = fmt(signal.detected_at || signal.created_at)

  async function handleResolve() {
    setActing(true)
    try {
      await updateSignal(signal.id, { status: 'acknowledged' })
      addNotification({ type: 'success', message: 'Signal resolved' })
      onUpdate?.()
    } catch (err) { addNotification({ type: 'error', message: err.message }) }
    finally { setActing(false) }
  }

  async function handleSnooze(hours) {
    setActing(true)
    setSnoozeOpen(false)
    try {
      const snoozedUntil = new Date(Date.now() + hours * 3600_000).toISOString()
      await updateSignal(signal.id, { status: 'snoozed', snoozed_until: snoozedUntil })
      addNotification({ type: 'success', message: `Signal snoozed for ${hours}h` })
      onUpdate?.()
    } catch (err) { addNotification({ type: 'error', message: err.message }) }
    finally { setActing(false) }
  }

  return (
    <div style={{
      background: 'var(--bp-surface)',
      border: `1px solid var(--bp-border)`,
      borderLeft: `3px solid ${sev.border}`,
      borderRadius: 6,
      marginBottom: 8,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '14px 18px' }}>

        {/* Top meta row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className={clsx('pulse-dot', sev.dot)} />
            <span className={clsx('bp-pill', sev.pill)} style={{ padding: '1px 6px', fontSize: 9 }}>{sev.label}</span>
          </div>

          {isAI && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '1px 7px',
              borderRadius: 2, background: 'rgba(157,122,255,0.12)',
              color: 'var(--bp-purple)', border: '1px solid rgba(157,122,255,0.2)',
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              <Brain size={9} /> AI
            </span>
          )}

          {typeInfo && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '1px 7px',
              borderRadius: 2, background: 'var(--bp-surface-3)',
              color: typeInfo.color, textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              <typeInfo.Icon size={9} /> {typeInfo.label}
            </span>
          )}

          {signal.connector_type && (
            <span style={{
              fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '1px 6px',
              borderRadius: 2, background: 'var(--bp-surface-3)',
              color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              {signal.connector_type}
            </span>
          )}

          {data.connectors_involved?.length > 0 && data.connectors_involved.map(c => (
            <span key={c} style={{
              fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '1px 6px',
              borderRadius: 2, background: 'var(--bp-surface-3)',
              color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>{c}</span>
          ))}

          <span style={{ marginLeft: 'auto', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
            {age}
          </span>
        </div>

        {/* Title */}
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 15, color: 'var(--bp-text)', marginBottom: 6, lineHeight: 1.3 }}>
          {signal.title || 'Untitled signal'}
        </div>

        {/* Description */}
        {signal.description && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.6, marginBottom: 10 }}>
            {signal.description}
          </div>
        )}

        {/* Evidence (AI signals) */}
        {isAI && data.evidence?.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 6 }}>Evidence</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {data.evidence.map((e, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.4 }}>
                  <ChevronRight size={10} style={{ color: sev.border, flexShrink: 0, marginTop: 2 }} />
                  <span>{e}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Proposed task preview (AI signals) */}
        {isAI && data.proposed_task?.title && !taskOpen && (
          <div style={{
            marginBottom: 12,
            padding: '8px 10px',
            background: 'rgba(77,166,255,0.05)',
            border: '1px solid rgba(77,166,255,0.12)',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <Zap size={11} style={{ color: 'var(--bp-blue)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 11, fontWeight: 600, color: 'var(--bp-blue)', marginBottom: 1 }}>
                Proposed: {data.proposed_task.title}
              </div>
              {data.proposed_task.estimated_impact && (
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
                  {data.proposed_task.estimated_impact}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Confidence + task count */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          {signal.confidence != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'var(--bp-font-display)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--bp-text-3)' }}>Confidence</span>
              <ConfidenceBar value={signal.confidence} />
            </div>
          )}
          {signal.linked_tasks_count > 0 && (
            <span className="bp-pill bp-pill-blue" style={{ padding: '1px 6px', fontSize: 9 }}>
              {signal.linked_tasks_count} task{signal.linked_tasks_count !== 1 ? 's' : ''}
            </span>
          )}
          {data.priority && (
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>
              {data.priority}
            </span>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', position: 'relative', alignItems: 'center' }}>
          <button
            onClick={() => setTaskOpen(!taskOpen)}
            disabled={acting}
            className="bp-btn bp-btn-secondary"
            style={{ fontSize: 10 }}
          >
            <Plus size={11} /> Create Task
          </button>
          <button
            onClick={handleResolve}
            disabled={acting}
            className="bp-btn bp-btn-ghost"
            style={{ fontSize: 10, color: 'var(--bp-green)', borderColor: 'rgba(0,201,167,0.25)' }}
          >
            <Check size={11} /> Resolve
          </button>

          {/* Snooze */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setSnoozeOpen(!snoozeOpen)}
              disabled={acting}
              className="bp-btn bp-btn-ghost"
              style={{ fontSize: 10, color: 'var(--bp-amber)', borderColor: 'rgba(245,158,11,0.25)' }}
            >
              <Clock size={11} /> Snooze
            </button>
            {snoozeOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setSnoozeOpen(false)} />
                <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border-2)', borderRadius: 4, padding: '4px 0', zIndex: 20, minWidth: 120, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                  {SNOOZE_OPTIONS.map(o => (
                    <button
                      key={o.hours}
                      onClick={() => handleSnooze(o.hours)}
                      style={{ display: 'block', width: '100%', padding: '7px 12px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', textAlign: 'left' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bp-surface-3)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Expand raw data (non-AI) */}
          {!isAI && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="bp-btn bp-btn-ghost"
              style={{ fontSize: 10, marginLeft: 'auto' }}
            >
              {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {expanded ? 'Less' : 'Raw data'}
            </button>
          )}
        </div>

        {/* Inline Create Task Panel */}
        {taskOpen && (
          <CreateTaskPanel
            signal={signal}
            onClose={() => setTaskOpen(false)}
            onCreated={onUpdate}
          />
        )}

        {/* Raw data for non-AI signals */}
        {!isAI && expanded && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--bp-base)', borderRadius: 4, border: '1px solid var(--bp-border)' }}>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 8 }}>Raw Data</div>
            <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.5 }}>
              {JSON.stringify(data, null, 2) || '—'}
            </pre>
          </div>
        )}

      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function Signals() {
  const currentBusiness  = useStore((s) => s.currentBusiness)
  const addNotification  = useStore((s) => s.addNotification)

  const [signals,    setSignals]    = useState([])
  const [summary,    setSummary]    = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [activeTab,  setActiveTab]  = useState('all')
  const [filter,     setFilter]     = useState({ severity: 'all', status: 'open', connector: 'all' })

  // Analysis state
  const [analysing,    setAnalysing]    = useState(false)
  const [currentRun,   setCurrentRun]   = useState(null)
  const pollRef = useRef(null)

  // ── Data fetching ───────────────────────────────────────────────────────────

  const fetchSignals = useCallback(async () => {
    if (!currentBusiness) { setLoading(false); return }
    try {
      const res = await getSignals(currentBusiness.id, {
        status: filter.status === 'all' ? undefined : filter.status,
        severity: filter.severity === 'all' ? undefined : filter.severity,
        limit: 200,
      })
      const list = Array.isArray(res) ? res : (res?.data || res?.signals || [])
      setSignals(list)
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }, [currentBusiness, filter])

  const fetchSummary = useCallback(async () => {
    if (!currentBusiness) return
    try {
      const s = await getSignalSummary(currentBusiness.id)
      setSummary(s)
    } catch { /* ignore */ }
  }, [currentBusiness])

  useEffect(() => {
    setLoading(true)
    fetchSignals()
    fetchSummary()
  }, [fetchSignals, fetchSummary])

  // ── AI Analysis polling ─────────────────────────────────────────────────────

  function startPolling(runId) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const run = await getAnalysisStatus(currentBusiness.id, runId)
        setCurrentRun(run)
        if (run.status !== 'running') {
          clearInterval(pollRef.current)
          pollRef.current = null
          setAnalysing(false)
          // Refresh signals and summary after completion
          fetchSignals()
          fetchSummary()
        }
      } catch {
        clearInterval(pollRef.current)
        pollRef.current = null
        setAnalysing(false)
      }
    }, 3000)
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  async function handleRunAnalysis() {
    if (!currentBusiness || analysing) return
    setAnalysing(true)
    try {
      const { runId } = await triggerAnalysis(currentBusiness.id)
      setCurrentRun({ id: runId, status: 'running' })
      startPolling(runId)
    } catch (err) {
      setAnalysing(false)
      addNotification({ type: 'error', message: err.message })
    }
  }

  // ── Tab filtering ───────────────────────────────────────────────────────────

  function tabFilter(signal) {
    switch (activeTab) {
      case 'ai':          return signal.rule_id === 'ai_analysis'
      case 'anomaly':     return signal.type === 'anomaly' || signal.type === 'risk'
      case 'opportunity': return signal.type === 'opportunity' || signal.type === 'quick_win'
      default:            return true
    }
  }

  const allFiltered = signals.filter(s =>
    (filter.connector === 'all' || s.connector_type === filter.connector) && tabFilter(s)
  )

  const tabCounts = {
    all:         signals.length,
    ai:          signals.filter(s => s.rule_id === 'ai_analysis').length,
    anomaly:     signals.filter(s => s.type === 'anomaly' || s.type === 'risk').length,
    opportunity: signals.filter(s => s.type === 'opportunity' || s.type === 'quick_win').length,
  }

  const connectorTypes = [...new Set(signals.map(s => s.connector_type).filter(Boolean))]
  const sevCounts = { all: signals.length, critical: 0, alert: 0, warning: 0, info: 0 }
  signals.forEach(s => { if (sevCounts[s.severity] !== undefined) sevCounts[s.severity]++ })

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 22, color: 'var(--bp-text)', margin: 0 }}>
            Signals
          </h1>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginTop: 4 }}>
            {loading ? '—' : `${signals.length} signal${signals.length !== 1 ? 's' : ''} detected`}
          </p>
        </div>
        <button
          onClick={async () => { setRefreshing(true); await fetchSignals(); await fetchSummary(); setRefreshing(false) }}
          disabled={refreshing}
          className="bp-btn bp-btn-secondary"
          style={{ fontSize: 11 }}
        >
          <RefreshCw size={12} style={{ animation: refreshing ? 'bp-spin-slow 1s linear infinite' : 'none' }} />
          Refresh
        </button>
      </div>

      {/* Analysis status bar */}
      <AnalysisBar
        run={currentRun}
        onDismiss={() => setCurrentRun(null)}
      />

      {/* Summary card */}
      <SummaryCard
        summary={summary}
        onRunAnalysis={handleRunAnalysis}
        analysing={analysing}
      />

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid var(--bp-border)' }}>
        {TABS.map(({ key, label, Icon }) => {
          const active = activeTab === key
          const count  = tabCounts[key]
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${active ? 'var(--bp-blue)' : 'transparent'}`,
                padding: '8px 14px',
                cursor: 'pointer',
                fontFamily: active ? 'var(--bp-font-display)' : 'var(--bp-font-mono)',
                fontWeight: active ? 700 : 400,
                fontSize: 12,
                color: active ? 'var(--bp-text)' : 'var(--bp-text-3)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: -1,
                transition: 'color 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              <Icon size={12} />
              {label}
              {count > 0 && (
                <span style={{
                  fontFamily: 'var(--bp-font-mono)', fontSize: 9,
                  padding: '1px 5px', borderRadius: 8,
                  background: active ? 'rgba(77,166,255,0.15)' : 'var(--bp-surface-3)',
                  color: active ? 'var(--bp-blue)' : 'var(--bp-text-3)',
                }}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Severity */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { key: 'all',      label: `All (${sevCounts.all})`,           cls: 'bp-pill-grey' },
            { key: 'critical', label: `Critical (${sevCounts.critical})`, cls: 'bp-pill-red'  },
            { key: 'alert',    label: `Alert (${sevCounts.alert})`,       cls: 'bp-pill-amber'},
            { key: 'warning',  label: `Warning (${sevCounts.warning})`,   cls: 'bp-pill-amber'},
            { key: 'info',     label: `Info (${sevCounts.info})`,         cls: 'bp-pill-blue' },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(prev => ({ ...prev, severity: f.key }))}
              className={clsx('bp-pill', filter.severity === f.key ? f.cls : 'bp-pill-grey')}
              style={{ cursor: 'pointer', background: 'none', fontWeight: filter.severity === f.key ? 600 : 400, border: filter.severity === f.key ? undefined : '1px solid rgba(255,255,255,0.06)' }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 18, background: 'var(--bp-border)' }} />

        {/* Status */}
        <div style={{ display: 'flex', gap: 4 }}>
          {['open', 'acknowledged', 'snoozed', 'all'].map(s => (
            <button
              key={s}
              onClick={() => setFilter(prev => ({ ...prev, status: s }))}
              className={clsx('bp-pill', filter.status === s ? 'bp-pill-blue' : 'bp-pill-grey')}
              style={{ cursor: 'pointer', background: 'none', border: filter.status === s ? undefined : '1px solid rgba(255,255,255,0.06)', fontWeight: filter.status === s ? 600 : 400, textTransform: 'capitalize' }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Connector */}
        {connectorTypes.length > 0 && (
          <>
            <div style={{ width: 1, height: 18, background: 'var(--bp-border)' }} />
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <button onClick={() => setFilter(prev => ({ ...prev, connector: 'all' }))} className={clsx('bp-pill', filter.connector === 'all' ? 'bp-pill-blue' : 'bp-pill-grey')} style={{ cursor: 'pointer', background: 'none', border: filter.connector === 'all' ? undefined : '1px solid rgba(255,255,255,0.06)' }}>
                All sources
              </button>
              {connectorTypes.map(ct => (
                <button key={ct} onClick={() => setFilter(prev => ({ ...prev, connector: ct }))} className={clsx('bp-pill', filter.connector === ct ? 'bp-pill-cyan' : 'bp-pill-grey')} style={{ cursor: 'pointer', background: 'none', border: filter.connector === ct ? undefined : '1px solid rgba(255,255,255,0.06)', textTransform: 'uppercase', fontSize: 9 }}>
                  {ct}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Signal list */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bp-skeleton" style={{ height: 120, borderRadius: 6 }} />
          ))}
        </div>
      ) : allFiltered.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '80px 20px', textAlign: 'center' }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(0,201,167,0.08)', border: '1px solid rgba(0,201,167,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
            {activeTab === 'ai' ? <Brain size={20} style={{ color: 'var(--bp-purple)' }} /> : <Check size={20} style={{ color: 'var(--bp-green)' }} />}
          </div>
          <h3 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 15, color: 'var(--bp-text)', margin: '0 0 6px' }}>
            {activeTab === 'ai' ? 'No AI insights yet' : 'All clear'}
          </h3>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', maxWidth: 280 }}>
            {activeTab === 'ai'
              ? 'Run an AI analysis to surface insights from your connected data.'
              : filter.severity !== 'all' || filter.connector !== 'all'
                ? 'Try adjusting your filters.'
                : 'No open signals detected for this view.'}
          </p>
          {activeTab === 'ai' && !analysing && (
            <button onClick={handleRunAnalysis} className="bp-btn bp-btn-primary" style={{ marginTop: 16, fontSize: 11 }}>
              <Sparkles size={12} /> Run AI Analysis
            </button>
          )}
        </div>
      ) : (
        <div>
          {allFiltered.map(signal => (
            <SignalCard key={signal.id} signal={signal} onUpdate={() => { fetchSignals(); fetchSummary() }} />
          ))}
        </div>
      )}
    </div>
  )
}

export default Signals
