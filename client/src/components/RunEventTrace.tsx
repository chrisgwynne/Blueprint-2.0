import React, { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import { AlertCircle } from 'lucide-react'
import { getRunEvents } from '../lib/api'
import { eventTone, eventToneColor, formatEventDuration, relatedResourceLabel } from './run-event-trace-view.js'

interface RunEvent {
  id: string
  event_type: string
  status: string
  summary: string | null
  duration_ms: number | null
  related_resource_type: string | null
  related_resource_id: string | null
  error_category: string | null
  created_at: string
}

interface RunEventTraceProps {
  runId: string
}

/**
 * Chronological trace of a run's agent_run_events — the intermediate steps
 * behind the run's terminal status/reasoning (preflight checks, task
 * proposals, cancellation, etc). Fetched from the existing dashboard-session
 * route in server/routes/trust.ts; the caller is expected to only mount
 * this once the run row is already expanded (see AgentDetail.tsx's RunsTab).
 */
export default function RunEventTrace({ runId }: RunEventTraceProps) {
  const [events, setEvents] = useState<RunEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getRunEvents(runId)
      .then((d: any) => { if (!cancelled) setEvents(Array.isArray(d?.events) ? d.events : []) })
      .catch((err: any) => { if (!cancelled) { setError(err?.message ?? 'Failed to load event trace'); setEvents([]) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [runId])

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bp-border)' }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Event Trace
      </div>

      {loading && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Loading…</div>
      )}

      {error && !loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)' }}>
          <AlertCircle size={10} /> {error}
        </div>
      )}

      {events && events.length === 0 && !loading && !error && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
          No intermediate events recorded for this run.
        </div>
      )}

      {events && events.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {events.map((e) => {
            const tone = eventTone(e.status, e.error_category)
            const related = relatedResourceLabel(e.related_resource_type, e.related_resource_id)
            return (
              <div key={e.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: eventToneColor(tone), marginTop: 4, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--bp-text-2)' }}>
                      {e.event_type}
                    </span>
                    <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: eventToneColor(tone), textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {e.status}
                    </span>
                    {e.duration_ms != null && (
                      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
                        {formatEventDuration(e.duration_ms)}
                      </span>
                    )}
                  </div>
                  {e.summary && (
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginTop: 2, lineHeight: 1.5 }}>
                      {e.summary}
                    </div>
                  )}
                  {related && (
                    <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 2 }}>
                      → {related}
                    </div>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {(() => { try { return formatDistanceToNow(parseTimestamp(e.created_at) || new Date(), { addSuffix: true }) } catch { return '' } })()}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
