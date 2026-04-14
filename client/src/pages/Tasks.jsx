import React, { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow, format } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import { LayoutGrid, List, Plus, X, Check, RefreshCw, Clock, ChevronRight, MessageSquare, Send, User, Cpu, GitBranch } from 'lucide-react'
import TaskKanban from '../components/TaskKanban.jsx'
import useStore from '../lib/store.js'
import { getTasks, createTask, approveTask, rejectTask, getTaskDetail, getTaskHistory, addTaskComment } from '../lib/api.js'

const STATUS_CONFIG = {
  proposed:  { label: 'Proposed',  pill: 'bp-pill-amber' },
  approved:  { label: 'Approved',  pill: 'bp-pill-blue' },
  executing: { label: 'Executing', pill: 'bp-pill-blue' },
  complete:  { label: 'Complete',  pill: 'bp-pill-green' },
  verified:  { label: 'Verified',  pill: 'bp-pill-grey' },
  rejected:  { label: 'Rejected',  pill: 'bp-pill-red' },
  deferred:  { label: 'Deferred',  pill: 'bp-pill-grey' },
}

const PRIORITY_PILL = { 1: 'bp-pill-red', 2: 'bp-pill-amber', 3: 'bp-pill-blue', 4: 'bp-pill-grey' }
const PRIORITY_LABEL = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4', p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4' }
const PRIORITY_NUM = { p1: 1, p2: 2, p3: 3, p4: 4 }

const STATUS_FILTERS = ['all', 'proposed', 'deferred', 'approved', 'executing', 'complete', 'verified', 'rejected']

// ─── New Task Modal ───────────────────────────────────────────────────────────

function NewTaskModal({ onClose, onCreated, businessId }) {
  const addNotification = useStore((s) => s.addNotification)
  const [form, setForm] = useState({ title: '', description: '', action_type: '', priority: 'p3', trust_tier: 'medium' })
  const [saving, setSaving] = useState(false)

  function setField(k, v) { setForm((p) => ({ ...p, [k]: v })) }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) return
    setSaving(true)
    try {
      const task = await createTask({ ...form, business_id: businessId })
      addNotification({ type: 'success', message: 'Task created' })
      onCreated(task)
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally { setSaving(false) }
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div style={{
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 50, pointerEvents: 'none',
      }}>
        <div className="bp-card" style={{
          width: '100%', maxWidth: 460, pointerEvents: 'auto',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)', overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '16px 20px', borderBottom: '1px solid var(--bp-border)',
          }}>
            <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 15, color: 'var(--bp-text)' }}>
              New Task
            </span>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bp-text-3)', padding: 4 }}>
              <X size={16} />
            </button>
          </div>

          <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Title *
              </label>
              <input
                value={form.title}
                onChange={(e) => setField('title', e.target.value)}
                className="bp-input"
                placeholder="Describe what needs to be done…"
                required
              />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Description
              </label>
              <textarea
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                className="bp-input"
                rows={3}
                style={{ resize: 'none' }}
                placeholder="Additional context…"
              />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Action Type
              </label>
              <input
                value={form.action_type}
                onChange={(e) => setField('action_type', e.target.value)}
                className="bp-input"
                placeholder="e.g. content_creation, shopify_update…"
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Priority
                </label>
                <select value={form.priority} onChange={(e) => setField('priority', e.target.value)} className="bp-select" style={{ width: '100%' }}>
                  <option value="p1">P1 — Critical</option>
                  <option value="p2">P2 — High</option>
                  <option value="p3">P3 — Normal</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Trust Tier
                </label>
                <select value={form.trust_tier} onChange={(e) => setField('trust_tier', e.target.value)} className="bp-select" style={{ width: '100%' }}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, paddingTop: 4, borderTop: '1px solid var(--bp-border)' }}>
              <button type="button" onClick={onClose} className="bp-btn bp-btn-secondary" style={{ flex: 1, justifyContent: 'center' }}>
                Cancel
              </button>
              <button type="submit" disabled={saving} className="bp-btn bp-btn-primary" style={{ flex: 1, justifyContent: 'center' }}>
                {saving ? <><RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> Creating…</> : <><Plus size={11} /> Create Task</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

// ─── List Row ─────────────────────────────────────────────────────────────────

function TaskListRow({ task, onApprove, onReject, onSelect }) {
  const [acting, setActing] = useState(false)
  const [hovered, setHovered] = useState(false)
  const addNotification = useStore((s) => s.addNotification)
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG.proposed
  const priorityNum = PRIORITY_NUM[task.priority?.toLowerCase?.()] || parseInt(task.priority) || 3
  const confidence = task.confidence != null ? Math.round(task.confidence * 100) + '%' : '—'
  const age = task.created_at ? formatDistanceToNow(parseTimestamp(task.created_at) || new Date(), { addSuffix: true }) : '—'

  async function doApprove() {
    setActing(true)
    try { await onApprove(task.id, {}) } finally { setActing(false) }
  }
  async function doReject() {
    setActing(true)
    try { await onReject(task.id, {}) } finally { setActing(false) }
  }

  return (
    <tr
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: hovered ? 'var(--bp-surface-2)' : 'transparent',
        transition: 'background 100ms ease',
      }}
    >
      <td style={{ padding: '10px 16px', maxWidth: 280 }}>
        <span
          onClick={() => onSelect?.(task.id)}
          style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-blue)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(77,166,255,0.3)' }}
        >
          {task.title}
        </span>
      </td>
      <td style={{ padding: '10px 16px' }}>
        <span className={`bp-pill ${sc.pill}`} style={{ padding: '1px 6px', fontSize: 9 }}>{sc.label}</span>
      </td>
      <td style={{ padding: '10px 16px' }}>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
          {task.agent_name || '—'}
        </span>
      </td>
      <td style={{ padding: '10px 16px' }}>
        <span className={`bp-pill ${PRIORITY_PILL[priorityNum] || 'bp-pill-grey'}`} style={{ padding: '1px 5px', fontSize: 9 }}>
          {PRIORITY_LABEL[task.priority?.toLowerCase?.()] || PRIORITY_LABEL[priorityNum] || 'P3'}
        </span>
      </td>
      <td style={{ padding: '10px 16px' }}>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{confidence}</span>
      </td>
      <td style={{ padding: '10px 16px' }}>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', whiteSpace: 'nowrap' }}>{age}</span>
      </td>
      <td style={{ padding: '10px 16px' }}>
        {task.status === 'proposed' && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={doApprove}
              disabled={acting}
              style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', color: 'var(--bp-green)', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <Check size={10} />
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9 }}>Approve</span>
            </button>
            <button
              onClick={doReject}
              disabled={acting}
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', color: 'var(--bp-red)', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <X size={10} />
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9 }}>Reject</span>
            </button>
          </div>
        )}
        {task.status === 'deferred' && <DeferredBadge task={task} />}
      </td>
    </tr>
  )
}

function DeferredBadge({ task }) {
  const [overriding, setOverriding] = useState(false)
  const days = task.deferred_until
    ? Math.max(0, Math.ceil((new Date(task.deferred_until) - new Date()) / 86400000))
    : null

  async function handleOverride() {
    if (!confirm(`Override deferral and propose this task now?\n\nBlueprint deferred this task because a recent related change is still in its measurement window. Overriding means you take responsibility for the attribution risk.\n\nReason: ${task.deferred_reason ?? 'temporal restraint'}`)) return
    setOverriding(true)
    try {
      const { overrideDeferredTask } = await import('../lib/api.js')
      await overrideDeferredTask(task.business_id, task.id)
      window.location.reload()
    } catch (err) {
      alert(`Override failed: ${err.message}`)
    } finally { setOverriding(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 280 }}>
      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-amber)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        ⏳ Deferred{days != null ? ` — ${days} day${days === 1 ? '' : 's'}` : ''}
      </span>
      {task.deferred_reason && (
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', fontStyle: 'italic', lineHeight: 1.4 }}>
          {task.deferred_reason.slice(0, 180)}
        </span>
      )}
      <button
        onClick={handleOverride}
        disabled={overriding}
        style={{
          padding: '3px 8px', fontSize: 9, background: 'transparent',
          border: '1px solid var(--bp-border)', color: 'var(--bp-text-3)',
          borderRadius: 3, cursor: 'pointer', width: 'fit-content',
          fontFamily: 'var(--bp-font-mono)',
        }}
        title="Force this task through — you understand the risks">
        {overriding ? 'Overriding…' : 'Override'}
      </button>
    </div>
  )
}

// ─── Task Detail Drawer ───────────────────────────────────────────────────────

const EVENT_ICONS = {
  created:   { Icon: Plus,          color: 'var(--bp-blue)'   },
  approved:  { Icon: Check,         color: 'var(--bp-green)'  },
  rejected:  { Icon: X,             color: 'var(--bp-red)'    },
  executing: { Icon: Cpu,           color: 'var(--bp-blue)'   },
  complete:  { Icon: Check,         color: 'var(--bp-green)'  },
  verified:  { Icon: Check,         color: 'var(--bp-green)'  },
  commented: { Icon: MessageSquare, color: 'var(--bp-text-3)' },
  default:   { Icon: GitBranch,     color: 'var(--bp-text-3)' },
}

function TimelineEvent({ event }) {
  const cfg = EVENT_ICONS[event.event_type] || EVENT_ICONS.default
  const { Icon, color } = cfg
  const time = event.created_at ? format(new Date(event.created_at), 'MMM d, HH:mm') : '—'

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bp-surface-3)', border: `1px solid ${color}40`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={12} style={{ color }} />
        </div>
        <div style={{ width: 1, flex: 1, background: 'var(--bp-border)', marginTop: 4 }} />
      </div>
      <div style={{ flex: 1, paddingBottom: 16, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 12, color: 'var(--bp-text)', textTransform: 'capitalize' }}>
            {event.event_type}
          </span>
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
            by {event.actor}
          </span>
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', whiteSpace: 'nowrap' }}>
            {time}
          </span>
        </div>
        {event.content && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
            {event.content}
          </div>
        )}
      </div>
    </div>
  )
}

function TaskDetailDrawer({ taskId, onClose, onUpdate }) {
  const addNotification = useStore((s) => s.addNotification)
  const [detail,   setDetail]   = useState(null)
  const [history,  setHistory]  = useState([])
  const [loading,  setLoading]  = useState(true)
  const [comment,  setComment]  = useState('')
  const [sending,  setSending]  = useState(false)
  const [acting,   setActing]   = useState(false)

  useEffect(() => {
    if (!taskId) return
    setLoading(true)
    Promise.all([getTaskDetail(taskId), getTaskHistory(taskId)])
      .then(([d, h]) => { setDetail(d); setHistory(Array.isArray(h) ? h : []) })
      .catch(err => addNotification({ type: 'error', message: err.message }))
      .finally(() => setLoading(false))
  }, [taskId])

  async function handleApprove() {
    setActing(true)
    try {
      await approveTask(taskId, {})
      addNotification({ type: 'success', message: 'Task approved' })
      const [d, h] = await Promise.all([getTaskDetail(taskId), getTaskHistory(taskId)])
      setDetail(d); setHistory(h || [])
      onUpdate?.()
    } catch (err) { addNotification({ type: 'error', message: err.message }) }
    finally { setActing(false) }
  }

  async function handleReject() {
    setActing(true)
    try {
      await rejectTask(taskId, {})
      addNotification({ type: 'success', message: 'Task rejected' })
      const [d, h] = await Promise.all([getTaskDetail(taskId), getTaskHistory(taskId)])
      setDetail(d); setHistory(h || [])
      onUpdate?.()
    } catch (err) { addNotification({ type: 'error', message: err.message }) }
    finally { setActing(false) }
  }

  async function handleComment(e) {
    e.preventDefault()
    if (!comment.trim()) return
    setSending(true)
    try {
      await addTaskComment(taskId, comment.trim())
      setComment('')
      const h = await getTaskHistory(taskId)
      setHistory(h || [])
    } catch (err) { addNotification({ type: 'error', message: err.message }) }
    finally { setSending(false) }
  }

  const task   = detail?.id ? detail : null  // API returns task fields at root
  const signal = detail?.signal || null
  const sc     = task ? (STATUS_CONFIG[task.status] || STATUS_CONFIG.proposed) : null
  const priorityNum = task ? (PRIORITY_NUM[task.priority?.toLowerCase?.()] || parseInt(task.priority) || 3) : 3

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 40 }}
      />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 480,
        background: 'var(--bp-surface)', borderLeft: '1px solid var(--bp-border)',
        zIndex: 50, display: 'flex', flexDirection: 'column',
        boxShadow: '-16px 0 48px rgba(0,0,0,0.4)',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bp-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)' }}>
            Task Detail
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bp-text-3)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[80, 40, 160, 120].map((h, i) => (
                <div key={i} className="bp-skeleton" style={{ height: h, borderRadius: 6 }} />
              ))}
            </div>
          ) : !task ? (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', textAlign: 'center', padding: '60px 0' }}>
              Task not found
            </div>
          ) : (
            <>
              {/* Title + badges */}
              <div style={{ marginBottom: 18 }}>
                <h2 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 16, color: 'var(--bp-text)', margin: '0 0 10px', lineHeight: 1.3 }}>
                  {task.title}
                </h2>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {sc && <span className={`bp-pill ${sc.pill}`} style={{ padding: '1px 7px', fontSize: 9 }}>{sc.label}</span>}
                  <span className={`bp-pill ${PRIORITY_PILL[priorityNum] || 'bp-pill-grey'}`} style={{ padding: '1px 7px', fontSize: 9 }}>
                    {PRIORITY_LABEL[task.priority?.toLowerCase?.()] || PRIORITY_LABEL[priorityNum] || 'P3'}
                  </span>
                  {task.proposed_by && (
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Cpu size={9} /> {task.proposed_by}
                    </span>
                  )}
                  {task.confidence != null && (
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
                      {Math.round(task.confidence * 100)}% confidence
                    </span>
                  )}
                </div>
              </div>

              {/* Description */}
              {task.description && (
                <div style={{ marginBottom: 18, padding: '12px 14px', background: 'var(--bp-base)', borderRadius: 4, border: '1px solid var(--bp-border)' }}>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.6 }}>
                    {task.description}
                  </div>
                </div>
              )}

              {/* Meta grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
                {[
                  { label: 'Action Type', value: task.action_type || '—' },
                  { label: 'Trust Tier',  value: task.trust_tier  || '—' },
                  { label: 'Created',     value: task.created_at ? format(new Date(task.created_at), 'MMM d, yyyy HH:mm') : '—' },
                  { label: 'Updated',     value: task.updated_at ? formatDistanceToNow(parseTimestamp(task.updated_at) || new Date(), { addSuffix: true }) : '—' },
                ].map(({ label, value }) => (
                  <div key={label} style={{ padding: '10px 12px', background: 'var(--bp-base)', borderRadius: 4, border: '1px solid var(--bp-border)' }}>
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Outcome — shows what actually happened. For 'failed' tasks
                  this includes the error so the user doesn't wonder why the
                  task vanished. For 'complete' it shows the executor's
                  outcome string and any structured outcome_data. */}
              {(task.outcome || task.outcome_data) && (
                <div style={{
                  marginBottom: 18,
                  padding: '12px 14px',
                  background: task.status === 'failed' ? 'rgba(255,82,82,0.05)' : 'rgba(34,197,94,0.05)',
                  borderRadius: 4,
                  border: task.status === 'failed' ? '1px solid rgba(255,82,82,0.2)' : '1px solid rgba(34,197,94,0.2)',
                }}>
                  <div style={{
                    fontFamily: 'var(--bp-font-mono)', fontSize: 9,
                    color: task.status === 'failed' ? 'var(--bp-red)' : 'var(--bp-green)',
                    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6,
                  }}>
                    {task.status === 'failed' ? 'Error' : 'Outcome'}
                  </div>
                  {task.outcome && (
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5, marginBottom: task.outcome_data ? 8 : 0, whiteSpace: 'pre-wrap' }}>
                      {task.outcome}
                    </div>
                  )}
                  {task.outcome_data?.error && (
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)', lineHeight: 1.5, padding: 8, background: 'rgba(0,0,0,0.2)', borderRadius: 3 }}>
                      {task.outcome_data.error}
                    </div>
                  )}
                  {task.outcome_data && !task.outcome_data.error && task.outcome_data.type === 'investigation' && (
                    <div style={{ marginTop: 8 }}>
                      {/* Primary cause */}
                      {task.outcome_data.primary_cause && (
                        <div style={{ marginBottom: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 3 }}>
                          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
                            Primary Cause
                            {task.outcome_data.primary_confidence != null && (
                              <span style={{ marginLeft: 6, color: task.outcome_data.primary_confidence >= 0.7 ? 'var(--bp-green)' : task.outcome_data.primary_confidence >= 0.4 ? 'var(--bp-amber)' : 'var(--bp-text-3)' }}>
                                {Math.round(task.outcome_data.primary_confidence * 100)}% conf
                              </span>
                            )}
                          </div>
                          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)', lineHeight: 1.4 }}>
                            {task.outcome_data.primary_cause}
                          </div>
                        </div>
                      )}
                      {/* Plain English explanation */}
                      {task.outcome_data.plain_english && (
                        <div style={{ marginBottom: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 3 }}>
                          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>Analysis</div>
                          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.6 }}>
                            {task.outcome_data.plain_english}
                          </div>
                        </div>
                      )}
                      {/* Supporting evidence */}
                      {Array.isArray(task.outcome_data.supporting_evidence) && task.outcome_data.supporting_evidence.length > 0 && (
                        <div style={{ marginBottom: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 3 }}>
                          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Evidence</div>
                          {task.outcome_data.supporting_evidence.map((e, i) => (
                            <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.5, display: 'flex', gap: 6, marginBottom: 2 }}>
                              <span style={{ color: 'var(--bp-green)', flexShrink: 0 }}>›</span>
                              <span>{e}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Recommendation badge */}
                      {task.outcome_data.recommendation && (
                        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{
                            fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '3px 8px', borderRadius: 3, letterSpacing: '0.06em', fontWeight: 700, textTransform: 'uppercase',
                            background: task.outcome_data.recommendation === 'act_now' ? 'rgba(239,68,68,0.15)' : task.outcome_data.recommendation === 'monitor' ? 'rgba(245,158,11,0.15)' : 'rgba(100,116,139,0.15)',
                            color: task.outcome_data.recommendation === 'act_now' ? 'var(--bp-red)' : task.outcome_data.recommendation === 'monitor' ? 'var(--bp-amber)' : 'var(--bp-text-3)',
                            border: `1px solid ${task.outcome_data.recommendation === 'act_now' ? 'rgba(239,68,68,0.3)' : task.outcome_data.recommendation === 'monitor' ? 'rgba(245,158,11,0.3)' : 'rgba(100,116,139,0.2)'}`,
                          }}>
                            {task.outcome_data.recommendation.replace('_', ' ')}
                          </span>
                          {task.outcome_data.recommended_action && (
                            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)' }}>{task.outcome_data.recommended_action}</span>
                          )}
                        </div>
                      )}
                      {/* Spawned follow-on tasks count */}
                      {task.outcome_data.spawned_tasks > 0 && (
                        <div style={{ padding: '6px 10px', background: 'rgba(34,197,94,0.08)', borderRadius: 3, border: '1px solid rgba(34,197,94,0.2)' }}>
                          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-green)' }}>
                            ✓ {task.outcome_data.spawned_tasks} follow-on action task{task.outcome_data.spawned_tasks > 1 ? 's' : ''} queued for approval
                          </span>
                        </div>
                      )}
                      {/* Confidence note */}
                      {task.outcome_data.confidence_note && (
                        <div style={{ marginTop: 6, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', fontStyle: 'italic' }}>
                          {task.outcome_data.confidence_note}
                        </div>
                      )}
                    </div>
                  )}
                  {task.outcome_data && !task.outcome_data.error && task.outcome_data.type !== 'investigation' && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', cursor: 'pointer' }}>
                        Outcome data
                      </summary>
                      <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', marginTop: 6, padding: 8, background: 'rgba(0,0,0,0.2)', borderRadius: 3, overflow: 'auto', maxHeight: 200 }}>
                        {JSON.stringify(task.outcome_data, null, 2)}
                      </pre>
                    </details>
                  )}
                  {task.status === 'failed' && (
                    <button
                      onClick={async () => {
                        setActing(true)
                        try {
                          await fetch(`/api/tasks/${taskId}/retry`, { method: 'POST', credentials: 'include' })
                          const [d, h] = await Promise.all([getTaskDetail(taskId), getTaskHistory(taskId)])
                          setDetail(d); setHistory(h || [])
                          onUpdate?.()
                          addNotification({ type: 'success', message: 'Retry queued' })
                        } catch (err) { addNotification({ type: 'error', message: err.message }) }
                        finally { setActing(false) }
                      }}
                      disabled={acting}
                      className="bp-btn bp-btn-secondary"
                      style={{ marginTop: 10, fontSize: 11 }}
                    >
                      <RefreshCw size={11} /> Retry
                    </button>
                  )}
                </div>
              )}

              {/* Who's working on it — surface proposed_by + assigned_to so
                  the user knows which agent/human owns the task right now. */}
              <div style={{ marginBottom: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ padding: '10px 12px', background: 'var(--bp-base)', borderRadius: 4, border: '1px solid var(--bp-border)' }}>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Proposed by</div>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>{task.proposed_by || '—'}</div>
                </div>
                <div style={{ padding: '10px 12px', background: 'var(--bp-base)', borderRadius: 4, border: '1px solid var(--bp-border)' }}>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
                    {task.status === 'executing' ? 'Executing now' : task.status === 'complete' || task.status === 'verified' ? 'Completed by' : 'Assigned to'}
                  </div>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>
                    {task.assigned_to || (task.status === 'executing' ? 'system:executor' : task.status === 'complete' ? task.proposed_by : 'unassigned')}
                  </div>
                </div>
              </div>

              {/* Linked signal */}
              {signal && (
                <div style={{ marginBottom: 18, padding: '10px 14px', background: 'rgba(77,166,255,0.05)', borderRadius: 4, border: '1px solid rgba(77,166,255,0.15)' }}>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-blue)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <ChevronRight size={9} /> Linked Signal
                  </div>
                  <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 12, color: 'var(--bp-text)', marginBottom: 3 }}>
                    {signal.title}
                  </div>
                  {signal.description && (
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.4 }}>
                      {signal.description}
                    </div>
                  )}
                </div>
              )}

              {/* Approve / Reject actions */}
              {task.status === 'proposed' && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
                  <button
                    onClick={handleApprove}
                    disabled={acting}
                    className="bp-btn bp-btn-primary"
                    style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}
                  >
                    <Check size={13} /> Approve
                  </button>
                  <button
                    onClick={handleReject}
                    disabled={acting}
                    className="bp-btn bp-btn-ghost"
                    style={{ flex: 1, justifyContent: 'center', fontSize: 12, color: 'var(--bp-red)', borderColor: 'rgba(255,82,82,0.25)' }}
                  >
                    <X size={13} /> Reject
                  </button>
                </div>
              )}

              {/* History timeline */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 11, color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 16 }}>
                  Timeline
                </div>
                {history.length === 0 ? (
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', fontStyle: 'italic' }}>No history yet</div>
                ) : (
                  <div>
                    {history.map((event, i) => (
                      <TimelineEvent key={event.id || i} event={event} />
                    ))}
                  </div>
                )}
              </div>

              {/* Comment input */}
              <div style={{ borderTop: '1px solid var(--bp-border)', paddingTop: 16 }}>
                <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 11, color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>
                  Add Comment
                </div>
                <form onSubmit={handleComment} style={{ display: 'flex', gap: 8 }}>
                  <textarea
                    value={comment}
                    onChange={e => setComment(e.target.value)}
                    className="bp-input"
                    rows={2}
                    style={{ flex: 1, resize: 'none', fontSize: 12, lineHeight: 1.5 }}
                    placeholder="Add a note or comment…"
                  />
                  <button
                    type="submit"
                    disabled={sending || !comment.trim()}
                    className="bp-btn bp-btn-primary"
                    style={{ alignSelf: 'flex-end', fontSize: 11, flexShrink: 0 }}
                  >
                    {sending ? <RefreshCw size={12} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Send size={12} />}
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Tasks Page ───────────────────────────────────────────────────────────────

function Tasks() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const addNotification = useStore((s) => s.addNotification)
  const setPendingTaskCount = useStore((s) => s.setPendingTaskCount)

  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('kanban')
  const [showNewTask, setShowNewTask] = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState(null)

  const fetchTasks = useCallback(async () => {
    if (!currentBusiness) { setLoading(false); return }
    try {
      const data = await getTasks(currentBusiness.id, {
        status: statusFilter !== 'all' ? statusFilter : undefined,
      })
      // Server response shape is { view, data, pagination } for list view,
      // { view, columns, data } for kanban, or a bare array from older code.
      // Resolve whichever we got.
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.tasks)
            ? data.tasks
            : []
      setTasks(list)
      setPendingTaskCount(list.filter((t) => t.status === 'proposed').length)
    } catch (err) {
      addNotification({ type: 'error', message: 'Failed to load tasks: ' + err.message })
    } finally { setLoading(false) }
  }, [currentBusiness, statusFilter, refreshKey])

  useEffect(() => { setLoading(true); fetchTasks() }, [fetchTasks])

  async function handleApprove(id, data) {
    try {
      await approveTask(id, data)
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, status: 'approved' } : t))
      addNotification({ type: 'success', message: 'Task approved' })
    } catch (err) { addNotification({ type: 'error', message: err.message }) }
  }

  async function handleReject(id, data) {
    try {
      await rejectTask(id, data)
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, status: 'rejected' } : t))
      addNotification({ type: 'success', message: 'Task rejected' })
    } catch (err) { addNotification({ type: 'error', message: err.message }) }
  }

  // Counts for filter pills
  const counts = STATUS_FILTERS.reduce((acc, s) => {
    acc[s] = s === 'all' ? tasks.length : tasks.filter((t) => t.status === s).length
    return acc
  }, {})

  const proposedCount = tasks.filter((t) => t.status === 'proposed').length

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1600, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 22, color: 'var(--bp-text)', marginBottom: 4 }}>
            Tasks
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
              {tasks.length} total
            </span>
            {proposedCount > 0 && (
              <span className="bp-pill bp-pill-amber" style={{ padding: '1px 7px', fontSize: 9 }}>
                {proposedCount} pending approval
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* View toggle */}
          <div style={{
            display: 'flex', background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border)',
            borderRadius: 6, overflow: 'hidden',
          }}>
            {[
              { id: 'kanban', icon: LayoutGrid, label: 'Kanban' },
              { id: 'list',   icon: List,       label: 'List' },
            ].map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setView(id)}
                style={{
                  padding: '6px 12px', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: view === id ? 'var(--bp-border)' : 'transparent',
                  color: view === id ? 'var(--bp-text)' : 'var(--bp-text-3)',
                  transition: 'all 120ms ease',
                }}
              >
                <Icon size={12} /> {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowNewTask(true)}
            className="bp-btn bp-btn-primary"
            style={{ fontSize: 11 }}
          >
            <Plus size={12} /> New Task
          </button>
        </div>
      </div>

      {/* Status filter pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        {STATUS_FILTERS.map((s) => {
          const active = statusFilter === s
          const cfg = STATUS_CONFIG[s]
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                border: `1px solid ${active ? 'rgba(59,130,246,0.4)' : 'var(--bp-border)'}`,
                background: active ? 'rgba(59,130,246,0.1)' : 'var(--bp-surface-2)',
                color: active ? 'var(--bp-blue)' : 'var(--bp-text-3)',
                transition: 'all 120ms ease',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <span style={{ textTransform: 'capitalize' }}>{s === 'all' ? 'All' : (cfg?.label || s)}</span>
              {counts[s] > 0 && (
                <span style={{
                  fontFamily: 'var(--bp-font-mono)', fontSize: 9,
                  padding: '0 4px', borderRadius: 2,
                  background: active ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.08)',
                  color: active ? 'var(--bp-blue)' : 'var(--bp-text-3)',
                }}>
                  {counts[s]}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {[0, 0.25, 0.5].map((d, i) => (
              <span key={i} className="pulse-dot pulse-dot-blue" style={{ animationDelay: `${d}s` }} />
            ))}
          </div>
        </div>
      )}

      {/* Kanban */}
      {!loading && view === 'kanban' && (
        <TaskKanban
          tasks={statusFilter === 'all' ? tasks : tasks.filter((t) => t.status === statusFilter)}
          onUpdate={() => setRefreshKey((k) => k + 1)}
          onSelect={setSelectedTaskId}
        />
      )}

      {/* List */}
      {!loading && view === 'list' && (
        <div className="bp-card" style={{ overflow: 'hidden', padding: 0 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bp-border)', background: 'rgba(255,255,255,0.02)' }}>
                  {['Title', 'Status', 'Agent', 'Priority', 'Confidence', 'Created', 'Actions'].map((h) => (
                    <th key={h} style={{
                      padding: '10px 16px', textAlign: 'left',
                      fontFamily: 'var(--bp-font-mono)', fontSize: 9,
                      color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em',
                      fontWeight: 600, whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: '48px 16px', textAlign: 'center', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
                      No tasks found
                    </td>
                  </tr>
                )}
                {tasks.map((task) => (
                  <TaskListRow key={task.id} task={task} onApprove={handleApprove} onReject={handleReject} onSelect={setSelectedTaskId} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* New Task Modal */}
      {showNewTask && (
        <NewTaskModal
          onClose={() => setShowNewTask(false)}
          businessId={currentBusiness?.id}
          onCreated={(task) => {
            setTasks((prev) => [task, ...prev])
            setShowNewTask(false)
          }}
        />
      )}

      {/* Task Detail Drawer */}
      {selectedTaskId && (
        <TaskDetailDrawer
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  )
}

export default Tasks
