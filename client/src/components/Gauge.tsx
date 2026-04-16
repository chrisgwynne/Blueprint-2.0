import React, { useEffect, useRef, useState } from 'react'

const ARC_LENGTH = Math.PI * 45 // r=45, semicircle

function getColor(value: number, goodThreshold: number, needsWorkThreshold: number, invert: boolean): string {
  if (invert) {
    // Lower is better (e.g. LCP ms, CLS score)
    if (value <= goodThreshold) return '#10b981'
    if (value <= needsWorkThreshold) return '#f59e0b'
    return '#ef4444'
  } else {
    // Higher is better (e.g. performance score 0-100)
    if (value >= goodThreshold) return '#10b981'
    if (value >= needsWorkThreshold) return '#f59e0b'
    return '#ef4444'
  }
}

function getStatus(value: number, goodThreshold: number, needsWorkThreshold: number, invert: boolean): string {
  if (invert) {
    if (value <= goodThreshold) return 'GOOD'
    if (value <= needsWorkThreshold) return 'NEEDS WORK'
    return 'POOR'
  } else {
    if (value >= goodThreshold) return 'GOOD'
    if (value >= needsWorkThreshold) return 'NEEDS WORK'
    return 'POOR'
  }
}

interface GaugeProps {
  value: number | null | undefined
  max?: number
  goodThreshold: number
  needsWorkThreshold: number
  label: string
  unit?: string
  invert?: boolean
}

/**
 * Semicircle SVG gauge.
 *
 * Props:
 *   value            — current value (raw, e.g. 2400 for ms, or 87 for score)
 *   max              — maximum value for scale (e.g. 5000 for ms, 100 for score)
 *   goodThreshold    — threshold for green
 *   needsWorkThreshold — threshold for amber
 *   label            — metric name (e.g. "LCP")
 *   unit             — display unit (e.g. "ms", "", "/100")
 *   invert           — true if lower is better
 */
function Gauge({ value, max = 100, goodThreshold, needsWorkThreshold, label, unit = '', invert = false }: GaugeProps) {
  const [animPct, setAnimPct] = useState(0)
  const rafRef = useRef<number | null>(null)

  const targetPct = value != null ? Math.min(1, Math.max(0, value / max)) : 0
  const color = value != null
    ? getColor(value, goodThreshold, needsWorkThreshold, invert)
    : 'rgba(255,255,255,0.08)'
  const status = value != null
    ? getStatus(value, goodThreshold, needsWorkThreshold, invert)
    : '—'

  useEffect(() => {
    if (value == null) return
    const start = performance.now()
    const duration = 800

    function step(now: number) {
      const elapsed = now - start
      const progress = Math.min(1, elapsed / duration)
      // ease-out
      const eased = 1 - Math.pow(1 - progress, 3)
      setAnimPct(eased * targetPct)
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step)
      }
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [value, max])

  // Arc: cx=60, cy=65, r=45
  // Start: left (180°), end: right (0°)
  // strokeDasharray = PI * r = 141.37
  const dashArray = ARC_LENGTH
  const dashOffset = dashArray * (1 - animPct)

  function formatValue(v: number | null | undefined): string {
    if (v == null) return '—'
    if (unit === 'ms' && v >= 1000) return (v / 1000).toFixed(1) + 's'
    if (typeof v === 'number' && !unit) return Math.round(v).toString()
    return v.toString()
  }

  const statusColor =
    status === 'GOOD' ? 'var(--bp-green)' :
    status === 'NEEDS WORK' ? 'var(--bp-amber)' :
    status === 'POOR' ? 'var(--bp-red)' :
    'var(--bp-text-3)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width="120" height="72" viewBox="0 0 120 72">
        {/* Track */}
        <path
          d="M 15 65 A 45 45 0 0 1 105 65"
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="6"
          strokeLinecap="round"
        />
        {/* Fill */}
        <path
          d="M 15 65 A 45 45 0 0 1 105 65"
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={dashArray}
          strokeDashoffset={dashOffset}
          style={{ filter: `drop-shadow(0 0 4px ${color}80)`, transition: 'stroke 300ms ease' }}
        />
        {/* Value text */}
        <text
          x="60"
          y="56"
          textAnchor="middle"
          fill="var(--bp-text)"
          fontFamily="Syne, sans-serif"
          fontWeight="700"
          fontSize="18"
        >
          {formatValue(value)}
        </text>
        {unit && unit !== 'ms' && (
          <text
            x="60"
            y="68"
            textAnchor="middle"
            fill="var(--bp-text-3)"
            fontFamily="DM Mono, monospace"
            fontSize="8"
          >
            {unit}
          </text>
        )}
      </svg>

      {/* Label */}
      <div style={{
        fontFamily: 'var(--bp-font-display)',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--bp-text-3)',
        textAlign: 'center',
      }}>
        {label}
      </div>

      {/* Status */}
      <div style={{
        fontFamily: 'var(--bp-font-mono)',
        fontSize: 9,
        letterSpacing: '0.08em',
        color: statusColor,
        textAlign: 'center',
      }}>
        {status}
      </div>
    </div>
  )
}

export default Gauge
