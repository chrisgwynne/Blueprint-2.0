import React, { useEffect, useState, useCallback, useRef } from 'react'
import { formatDistanceToNow, format, startOfDay, isToday, isYesterday } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import {
  Bot, CheckSquare, Radio, GitBranch, Target, Zap,
  Clock, AlertCircle, CheckCircle2, XCircle,
} from 'lucide-react'
import useStore from '../lib/store.js'
import { getTimeline } from '../lib/api.js'
import ProducedByEvent from '../components/ProducedByEvent.jsx'

const TYPE_CONFIG = {
  agent_run:      { icon: Bot,         color: 'var(--bp-blue)',   label: 'AGENTS' },
  task:           { icon: CheckSquare, color: 'var(--bp-amber)',  label: 'TASKS' },
  signal:         { icon: Radio,       color: 'var(--bp-red)',    label: 'SIGNALS' },
  workflow_run:   { icon: GitBranch,   color: 'var(--bp-cyan)',   label: 'WORKFLOWS' },
  goal_check:     { icon: Target,      color: 'var(--bp-green)',  label: 'GOALS' },
  connector_sync: { icon: Zap,         color: 'var(--bp-text-3)', label: 'CONNECTORS' },
}

const FILTERS = [
  { key: null, label: 'All' },
  { key: 'agent_run', label: 'Agents' },
  { key: 'task', label: 'Tasks' },
  { key: 'signal', label: 'Signals' },
  { key: 'workflow_run', label: 'Workflows' },
  { key: 'goal_check', label: 'Goals' },
  { key: 'connector_sync', label: 'Connectors' },
]

function fmtRel(iso) {
  if (!iso) return '—'
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) } catch { return '—' }
}

function dayLabel(iso) {
  const d = new Date(iso)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'EEEE d MMM')
}

function TimelineEvent({ event, businessId }) {
  const type = event.type === 'workflow_run' ? 'workflow_run' :
               event.type === 'goal_check'   ? 'goal_check'   :
               event.type === 'connector_sync' ? 'connector_sync' :
               event.type
  const cfg = TYPE_CONFIG[type] ?? TYPE_CONFIG.agent_run
  const Icon = cfg.icon
  const bg = event.severity === 'error' ? 'rgba(255,82,82,0.06)'
           : event.severity === 'warning' ? 'rgba(245,158,11,0.06)'
           : event.severity === 'success' ? 'rgba(0,201,167,0.06)'
           : 'transparent'

  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
      <div style={{ minWidth: 90, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', paddingTop: 8 }}>
        {fmtRel(event.created_at)}
      </div>
      <div style={{ width: 2, background: cfg.color, opacity: 0.5, borderRadius: 1, flexShrink: 0 }} />
      <div style={{ flex: 1, padding: '8px 12px', background: bg, borderRadius: 4, border: '1px solid var(--bp-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <Icon size={12} style={{ color: cfg.color }} />
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text)', fontWeight: 500 }}>
            {event.title}
          </div>
        </div>
        {event.subtitle && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.4 }}>
            {event.subtitle}
          </div>
        )}
        {/* Event types that log intelligence events get a "produced" drilldown.
            The server's timeline route attaches a `produces` hint for
            agent_run, signal, and task events. Others (workflow, goal, sync)
            don't currently emit intel events so we hide the toggle. */}
        {event.produces?.source_type && event.produces?.source_id && businessId && (
          <ProducedByEvent
            businessId={businessId}
            sourceType={event.produces.source_type}
            sourceId={event.produces.source_id}
          />
        )}
      </div>
    </div>
  )
}

export default function Timeline() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [events, setEvents] = useState([])
  const [filter, setFilter] = useState(null)
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(true)

  const fetchEvents = useCallback(async (append = false, before = null) => {
    if (!currentBusiness) return
    setLoading(true)
    try {
      const params = { limit: 50 }
      if (filter) params.types = filter
      if (before) params.before = before
      const result = await getTimeline(currentBusiness.id, params) ?? []
      setEvents(prev => append ? [...prev, ...result] : result)
      if (result.length < 50) setHasMore(false)
    } finally { setLoading(false) }
  }, [currentBusiness, filter])

  useEffect(() => {
    setHasMore(true)
    fetchEvents(false, null)
  }, [fetchEvents])

  function handleLoadMore() {
    const last = events[events.length - 1]
    if (last?.created_at) fetchEvents(true, last.created_at)
  }

  // Group events by day
  const groups = []
  let currentDay = null
  let currentGroup = null
  for (const e of events) {
    const day = startOfDay(new Date(e.created_at)).toISOString()
    if (day !== currentDay) {
      currentGroup = { day: e.created_at, events: [] }
      groups.push(currentGroup)
      currentDay = day
    }
    currentGroup.events.push(e)
  }

  if (!currentBusiness) return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>TIMELINE</h1>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
          Everything that happened
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f.label} onClick={() => setFilter(f.key)}
            style={{
              padding: '5px 12px',
              background: filter === f.key ? 'rgba(77,166,255,0.12)' : 'transparent',
              border: `1px solid ${filter === f.key ? 'var(--bp-blue)' : 'var(--bp-border)'}`,
              borderRadius: 3,
              color: filter === f.key ? 'var(--bp-blue)' : 'var(--bp-text-3)',
              fontFamily: 'var(--bp-font-mono)', fontSize: 10,
              cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.08em',
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {groups.length === 0 && !loading && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
          No events yet for this filter.
        </div>
      )}

      {groups.map((g) => (
        <div key={g.day} style={{ marginBottom: 20 }}>
          <div style={{
            fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em',
            color: 'var(--bp-text-3)', textTransform: 'uppercase',
            padding: '4px 0', marginBottom: 8,
            borderBottom: '1px solid var(--bp-border)',
          }}>
            {dayLabel(g.day)}
          </div>
          {g.events.map((e) => <TimelineEvent key={e.id} event={e} businessId={currentBusiness?.id} />)}
        </div>
      ))}

      {hasMore && events.length > 0 && (
        <div style={{ textAlign: 'center', padding: 20 }}>
          <button onClick={handleLoadMore} disabled={loading} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}
