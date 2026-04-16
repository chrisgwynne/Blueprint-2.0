import React, { useEffect, useState, useCallback } from 'react'
import { AlertTriangle, CheckCircle2, X, RefreshCw } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import useStore from '../lib/store'
import {
  getConflicts, resolveConflict, dismissConflict, auditConflicts,
} from '../lib/api'
import type { Conflict } from '../types'

const TYPE_LABELS: Record<string, string> = {
  goal_vs_goal:   'Goal vs Goal',
  task_vs_window: 'Task vs Measurement Window',
  task_vs_goal:   'Task vs Goal',
}

const ENTITY_LINKS: Record<string, (id: string) => string> = {
  goal: (id) => `/goals?id=${id}`,
  task: (id) => `/tasks?id=${id}`,
  action_memory: () => `/health`,
}

interface ConflictCardProps {
  conflict: Conflict
  businessId: string
  onRefresh: () => Promise<void>
}

function ConflictCard({ conflict, businessId, onRefresh }: ConflictCardProps) {
  const severityColor =
    conflict.severity === 'critical' ? 'var(--bp-red)' : 'var(--bp-amber)'

  async function handleResolve() {
    const note = prompt('Resolution note (optional):') ?? ''
    await resolveConflict(businessId, conflict.id, note)
    await onRefresh()
  }

  async function handleDismiss() {
    const reason = prompt('Dismiss reason:') ?? ''
    await dismissConflict(businessId, conflict.id, reason)
    await onRefresh()
  }

  const linkA = ENTITY_LINKS[conflict.entity_a_type]?.(conflict.entity_a_id)
  const linkB = ENTITY_LINKS[conflict.entity_b_type]?.(conflict.entity_b_id)

  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 10, borderLeft: `3px solid ${severityColor}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <AlertTriangle size={14} style={{ color: severityColor }} />
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', color: severityColor, textTransform: 'uppercase' }}>
          ⚡ {conflict.severity}
        </span>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
          {TYPE_LABELS[conflict.conflict_type] ?? conflict.conflict_type}
        </span>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginLeft: 'auto' }}>
          {formatDistanceToNow(parseTimestamp(conflict.detected_at) || new Date(), { addSuffix: true })}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text)', marginBottom: 10, lineHeight: 1.5 }}>
        {conflict.description}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <a href={linkA || '#'} style={{ padding: 8, background: 'var(--bp-surface-2)', borderRadius: 3, textDecoration: 'none', color: 'var(--bp-text)' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>{conflict.entity_a_type}</div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>{conflict.entity_a_title ?? conflict.entity_a_id}</div>
        </a>
        <a href={linkB || '#'} style={{ padding: 8, background: 'var(--bp-surface-2)', borderRadius: 3, textDecoration: 'none', color: 'var(--bp-text)' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>{conflict.entity_b_type}</div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>{conflict.entity_b_title ?? conflict.entity_b_id}</div>
        </a>
      </div>
      {conflict.recommendation && (
        <div style={{ padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3, marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>
            Recommendation
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>
            {conflict.recommendation}
          </div>
        </div>
      )}
      {conflict.status === 'open' && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleResolve} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
            <CheckCircle2 size={11} /> Resolve
          </button>
          <button onClick={handleDismiss} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
            <X size={11} /> Dismiss
          </button>
        </div>
      )}
      {conflict.status !== 'open' && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
          {conflict.status.toUpperCase()}{conflict.resolution_note ? ` — ${conflict.resolution_note}` : ''}
        </div>
      )}
    </div>
  )
}

export default function Conflicts() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [filter, setFilter] = useState('open')
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    if (!currentBusiness) return
    const rows = await getConflicts(currentBusiness.id, filter ? `status=${filter}` : '').catch(() => [])
    setConflicts(rows || [])
  }, [currentBusiness, filter])

  useEffect(() => { load() }, [load])

  async function handleAudit() {
    setRunning(true)
    try { await auditConflicts(currentBusiness!.id); await load() }
    finally { setRunning(false) }
  }

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0 }}>CONFLICTS</h1>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Strategic contradictions that could cause damage
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleAudit} disabled={running} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
            <RefreshCw size={11} /> {running ? 'Auditing…' : 'Run audit'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {['open', 'resolved', 'dismissed', ''].map((f) => (
          <button key={f || 'all'} onClick={() => setFilter(f)}
            className={`bp-pill ${filter === f ? 'bp-pill-blue' : 'bp-pill-grey'}`}
            style={{ cursor: 'pointer', background: 'none', border: filter === f ? undefined : '1px solid var(--bp-border)' }}>
            {f || 'all'}
          </button>
        ))}
      </div>

      {conflicts.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          No conflicts detected.
        </div>
      ) : (
        conflicts.map((c) => (
          <ConflictCard key={c.id} conflict={c} businessId={currentBusiness.id} onRefresh={load} />
        ))
      )}
    </div>
  )
}
