/**
 * Presentation rules for a run's agent_run_events trace (agent run trace
 * visibility, 2026-08).
 *
 * Pure and React-free so the rule that decides what colour/tone an event
 * reads as can be tested without rendering anything. The one thing this
 * must get right: `error_category` on a row means something went wrong
 * regardless of what `status` says, so a row must never read as "ok" or
 * "in progress" while it's actually an error.
 */

export type EventTone = 'ok' | 'warn' | 'error' | 'neutral'

const WARN_STATUSES = new Set(['blocked', 'cancelled', 'cancellation_requested', 'cancelling'])
const OK_STATUSES = new Set(['verified', 'complete', 'completed', 'success'])

/**
 * `error_category` wins over `status` — a row can be marked with an
 * "attempted" or "observed" status and still be the one that recorded why
 * something failed. Checked first so an error is never masked by a status
 * word that happens to sound neutral.
 */
export function eventTone(status: string | null | undefined, errorCategory: string | null | undefined): EventTone {
  if (errorCategory) return 'error'
  const s = (status ?? '').toLowerCase()
  if (WARN_STATUSES.has(s)) return 'warn'
  if (OK_STATUSES.has(s)) return 'ok'
  return 'neutral'
}

const TONE_COLOR: Record<EventTone, string> = {
  ok: 'var(--bp-green)',
  warn: 'var(--bp-amber)',
  error: 'var(--bp-red)',
  neutral: 'var(--bp-text-3)',
}

export function eventToneColor(tone: EventTone): string {
  return TONE_COLOR[tone]
}

/** `null`/`undefined`/non-finite all render as "—", never as "0ms" or "NaNms". */
export function formatEventDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * "task#tsk_abc123" style label, or null when the event doesn't point at
 * another resource — callers should omit the line entirely rather than
 * render an empty/placeholder reference.
 */
export function relatedResourceLabel(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null
  return `${type}#${id}`
}
