import React, { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import {
  ChevronRight, ChevronDown, Radio, CheckSquare, FileText,
  Mail, Database, Target, AlertCircle, Link2,
} from 'lucide-react'
import { getProducedByEvent } from '../lib/api'
import type { LucideIcon } from 'lucide-react'

interface TargetConfig {
  icon: LucideIcon
  label: string
  color: string
}

// Maps an intelligence_event target_type to an icon + human label.
const TARGET_CONFIG: Record<string, TargetConfig> = {
  signal:          { icon: Radio,       label: 'Signal',        color: 'var(--bp-red)' },
  task:            { icon: CheckSquare, label: 'Task',          color: 'var(--bp-amber)' },
  kb_entry:        { icon: FileText,    label: 'KB entry',      color: 'var(--bp-cyan)' },
  agent:           { icon: Mail,        label: 'Agent brief',   color: 'var(--bp-blue)' },
  agent_brief:     { icon: Mail,        label: 'Agent brief',   color: 'var(--bp-blue)' },
  connector_gap:   { icon: Database,    label: 'Connector gap', color: 'var(--bp-text-3)' },
  goal:            { icon: Target,      label: 'Goal impact',   color: 'var(--bp-green)' },
  outcome:         { icon: CheckSquare, label: 'Outcome',       color: 'var(--bp-green)' },
}

interface IntelligenceEvent {
  id: string
  target_type: string
  description?: string
  event_type?: string
  created_at?: string
}

interface DescribedEvent {
  Icon: LucideIcon
  label: string
  color: string
  description: string
  timestamp: string | undefined
}

// Events for each source_type are described with a one-line gloss derived
// from event_type + target_type. Keep this short — it shows inline.
function describeEvent(e: IntelligenceEvent): DescribedEvent {
  const t = TARGET_CONFIG[e.target_type] ?? { icon: Link2, label: e.target_type ?? 'event', color: 'var(--bp-text-3)' }
  return {
    Icon: t.icon,
    label: t.label,
    color: t.color,
    description: e.description ?? e.event_type ?? '(no description)',
    timestamp: e.created_at,
  }
}

function fmtRel(iso: string | undefined): string {
  if (!iso) return ''
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) } catch { return '' }
}

interface ProducedByEventProps {
  businessId: string
  sourceType: string
  sourceId: string
  variant?: 'inline' | 'button'
  label?: string
  defaultOpen?: boolean
  limit?: number
}

/**
 * Renders an expandable "Produced" list fetched from
 * GET /api/timeline/:businessId/produced/:sourceType/:sourceId
 *
 * Props:
 *   businessId   — required
 *   sourceType   — one of: agent_run, signal, task, kb, chat, agent
 *   sourceId     — the source id (run id, signal id, task id, etc.)
 *   variant      — 'inline' (default) for use inside cards, or 'button' for the
 *                  Timeline-style compact toggle
 *   label        — optional override for the toggle label
 *   defaultOpen  — optional boolean to start expanded
 *   limit        — how many events to fetch (default 25)
 */
export default function ProducedByEvent({
  businessId,
  sourceType,
  sourceId,
  variant = 'inline',
  label,
  defaultOpen = false,
  limit = 25,
}: ProducedByEventProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [events, setEvents] = useState<IntelligenceEvent[] | null>(null)   // null = not fetched yet
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchEvents = useCallback(async () => {
    if (!businessId || !sourceType || !sourceId) return
    setLoading(true)
    setError(null)
    try {
      const data = await getProducedByEvent(businessId, sourceType, sourceId, { limit })
      setEvents(Array.isArray(data) ? data : [])
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to load')
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [businessId, sourceType, sourceId, limit])

  useEffect(() => {
    if (open && events === null) fetchEvents()
  }, [open, events, fetchEvents])

  if (!businessId || !sourceType || !sourceId) return null

  const count = events?.length ?? null
  const toggleLabel = label ?? (count == null ? 'What this produced' : count === 0 ? 'Produced nothing downstream' : `Produced ${count} event${count === 1 ? '' : 's'}`)

  // Empty-state short-circuit: if we've fetched and found 0, render a muted line
  // instead of a clickable toggle so the user doesn't have to open it to learn nothing.
  if (events !== null && events.length === 0 && !loading && variant === 'inline') {
    return (
      <div style={{
        fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)',
        padding: '6px 0',
      }}>
        Produced nothing downstream
      </div>
    )
  }

  return (
    <div style={{ marginTop: variant === 'inline' ? 8 : 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="bp-btn bp-btn-ghost"
        style={{
          fontSize: 10,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: variant === 'button' ? '3px 8px' : '4px 0',
          background: 'transparent',
          border: variant === 'button' ? '1px solid var(--bp-border)' : 'none',
          borderRadius: variant === 'button' ? 3 : 0,
          color: 'var(--bp-text-3)',
          fontFamily: 'var(--bp-font-mono)',
        }}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {toggleLabel}
      </button>

      {open && (
        <div style={{
          marginTop: 6,
          paddingLeft: 12,
          borderLeft: '1px solid var(--bp-border)',
        }}>
          {loading && (
            <div style={{ padding: '6px 0', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
              Loading…
            </div>
          )}
          {error && !loading && (
            <div style={{ padding: '6px 0', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertCircle size={10} /> {error}
            </div>
          )}
          {events && events.length === 0 && !loading && !error && (
            <div style={{ padding: '6px 0', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
              Nothing produced downstream yet.
            </div>
          )}
          {events && events.length > 0 && events.map((e) => {
            const { Icon, label: targetLabel, color, description, timestamp } = describeEvent(e)
            return (
              <div key={e.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '4px 0',
                fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                color: 'var(--bp-text-2)',
              }}>
                <Icon size={10} style={{ color, marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color, marginRight: 6 }}>{targetLabel}</span>
                  <span style={{ color: 'var(--bp-text-2)' }}>{description}</span>
                </div>
                <span style={{ color: 'var(--bp-text-3)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {fmtRel(timestamp)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
