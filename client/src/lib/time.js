/**
 * Timestamp helpers.
 *
 * SQLite's CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" in UTC but with no
 * timezone suffix. Passing that string straight to `new Date(...)` is
 * undefined behaviour — some browsers interpret it as local time, which makes
 * every timestamp look ~1 hour off on UK DST. Always coerce to a real ISO
 * string with an explicit `Z` before constructing a Date.
 *
 * Acceptable inputs: ISO strings (already have Z or ±HH:MM offset), SQLite
 * naive UTC strings, null/undefined.
 */
export function parseTimestamp(value) {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value !== 'string') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  // Already has timezone info?
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  // SQLite naive format: "YYYY-MM-DD HH:MM:SS[.sss]"
  // Convert to ISO and append Z so browsers parse as UTC.
  const iso = value.includes('T') ? value : value.replace(' ', 'T')
  const d = new Date(iso + 'Z')
  return isNaN(d.getTime()) ? null : d
}

import { formatDistanceToNow as _formatDistanceToNow, format as _format } from 'date-fns'

export function formatRelative(value, options = { addSuffix: true }) {
  const d = parseTimestamp(value)
  if (!d) return '—'
  return _formatDistanceToNow(d, options)
}

export function formatDate(value, pattern = 'PP') {
  const d = parseTimestamp(value)
  if (!d) return '—'
  return _format(d, pattern)
}

export function formatDateTime(value, pattern = 'PP p') {
  const d = parseTimestamp(value)
  if (!d) return '—'
  return _format(d, pattern)
}
