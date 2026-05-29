import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { getAgentTimeline } from '../../lib/api.js'
import type { AgentTimelineResponse } from '../../types/index.js'
import { coerceUtc, channelLabel } from './agentPresentation.js'

interface TimelineItem {
  ts: string
  dot: string
  title: string
  detail?: string | null
}

function rel(iso: string): string {
  try { return formatDistanceToNow(new Date(coerceUtc(iso)), { addSuffix: true }) } catch { return '' }
}

// Friendly verbs for lifecycle transitions → the "what changed" narrative.
const TRANSITION_NARRATION: Record<string, string> = {
  triggered: 'Trigger received',
  assigned: 'Task assigned',
  working: 'Started working',
  awaiting_approval: 'Approval requested',
  blocked: 'Blocked',
  completed: 'Action completed',
  verified: 'Verification complete',
  standby: 'Returned to standby',
  hired: 'Hired',
  archived: 'Archived',
}

function buildItems(data: AgentTimelineResponse): TimelineItem[] {
  const items: TimelineItem[] = []

  for (const a of data.activations) {
    items.push({
      ts: a.created_at,
      dot: 'var(--bp-cyan)',
      title: `Activated by ${channelLabel(a.trigger_source).toLowerCase()}`,
      detail: a.selection_reason,
    })
  }
  for (const e of data.lifecycle_events) {
    const title = TRANSITION_NARRATION[e.to_state] ?? `→ ${e.to_state}`
    items.push({
      ts: e.created_at,
      dot: e.to_state === 'blocked' ? 'var(--bp-red)' : e.to_state === 'verified' ? 'var(--bp-green)' : 'var(--bp-text-3)',
      title,
      detail: e.reason,
    })
  }
  for (const r of data.runs) {
    const ok = r.status === 'complete'
    items.push({
      ts: r.started_at,
      dot: r.status === 'failed' ? 'var(--bp-red)' : ok ? 'var(--bp-green)' : 'var(--bp-text-3)',
      title: `Run ${r.status}${(r.tasks_proposed ?? 0) > 0 ? ` · ${r.tasks_proposed} task(s) proposed` : ''}`,
      detail: r.error ? r.error.slice(0, 140) : (r.signals_detected ? `${r.signals_detected} signal(s) reviewed` : null),
    })
  }

  return items
    .filter((i) => i.ts)
    .sort((a, b) => new Date(coerceUtc(b.ts)).getTime() - new Date(coerceUtc(a.ts)).getTime())
    .slice(0, 40)
}

export interface AgentTimelineProps {
  agentId: string
  /** Bump this to force a refetch (e.g. on SSE activity). */
  refreshKey?: number
}

/** Compact, chronological activity feed for one agent. */
export default function AgentTimeline({ agentId, refreshKey = 0 }: AgentTimelineProps) {
  const [items, setItems] = useState<TimelineItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    getAgentTimeline(agentId, 40)
      .then((data) => { if (!cancelled) setItems(buildItems(data)) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [agentId, refreshKey])

  if (error) return <div style={{ fontSize: 11, color: 'var(--bp-red)' }}>Couldn’t load activity: {error}</div>
  if (!items) return <div style={{ fontSize: 11, color: 'var(--bp-text-3)' }}>Loading activity…</div>
  if (items.length === 0) return <div style={{ fontSize: 11, color: 'var(--bp-text-3)' }}>No activity yet.</div>

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
      {/* vertical rail */}
      <div style={{ position: 'absolute', left: 4, top: 4, bottom: 4, width: 1, background: 'var(--bp-border)' }} />
      {items.map((it, i) => (
        <li key={i} style={{ position: 'relative', paddingLeft: 18, marginBottom: 11 }}>
          <span style={{
            position: 'absolute', left: 1, top: 3, width: 7, height: 7, borderRadius: '50%',
            background: it.dot, border: '2px solid var(--bp-surface)',
          }} />
          <div style={{ fontSize: 11.5, color: 'var(--bp-text)', lineHeight: 1.4 }}>{it.title}</div>
          {it.detail && <div style={{ fontSize: 10.5, color: 'var(--bp-text-3)', lineHeight: 1.45, marginTop: 1 }}>{it.detail}</div>}
          <div style={{ fontSize: 9.5, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', marginTop: 2 }}>{rel(it.ts)}</div>
        </li>
      ))}
    </ol>
  )
}
