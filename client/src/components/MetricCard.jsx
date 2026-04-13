import React from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import clsx from 'clsx'
import { SparkLine } from './Charts.jsx'

// Unwrap { value, prev, trend } wrappers returned by the backend
// (dashboard.js metricSummary shape) so callers can still pass the whole
// object as `value` without getting "[object Object]" on screen.
function unwrapMetric(v) {
  if (v == null) return v
  if (typeof v !== 'object') return v
  if ('value' in v) return v.value
  if ('current' in v) return v.current
  if ('count' in v) return v.count
  if ('n' in v) return v.n
  return null
}

function MetricCard({
  label,
  value: rawValue,
  prev: rawPrev,
  trend: rawTrend,
  sparklineData,
  unit = '',
  icon: Icon,
  iconColor,
  loading = false,
  invertPolarity = false,  // true = lower is better (avg position)
  accentColor,             // override sparkline/trend colour
}) {
  // If the caller passed a { value, prev, trend } wrapper, pull fields from
  // it so the rest of the component sees plain scalars.
  const wrapped = (typeof rawValue === 'object' && rawValue !== null)
    ? rawValue
    : null
  const value = unwrapMetric(rawValue)
  const prev = rawPrev !== undefined ? unwrapMetric(rawPrev) : (wrapped?.prev ?? null)
  const trend = rawTrend !== undefined ? rawTrend : (wrapped?.trend ?? undefined)

  // Trend calculation
  const trendValue = trend ?? (
    prev !== undefined && prev !== null && prev !== 0 && value !== undefined && value !== null
      ? Math.round(((value - prev) / Math.abs(prev)) * 100)
      : null
  )

  // Polarity-aware direction
  const rawPositive = trendValue !== null && trendValue > 0
  const rawNegative = trendValue !== null && trendValue < 0
  const isGood     = invertPolarity ? rawNegative : rawPositive
  const isBad      = invertPolarity ? rawPositive : rawNegative
  const isNeutral  = trendValue === null || trendValue === 0

  const trendColor  = isGood ? 'var(--bp-green)' : isBad ? 'var(--bp-red)' : 'var(--bp-text-3)'
  const sparkColor  = accentColor || (isGood ? 'var(--bp-green)' : isBad ? 'var(--bp-red)' : 'var(--bp-blue)')
  const borderColor = isGood ? 'var(--bp-green)' : isBad ? 'var(--bp-red)' : 'rgba(255,255,255,0.1)'

  function formatValue(v) {
    if (v === undefined || v === null) return '—'
    if (typeof v === 'object') {
      // Defensive — should already be unwrapped at the top, but never let
      // an object coerce to "[object Object]" on screen.
      const u = unwrapMetric(v)
      if (u === null || typeof u === 'object') return '—'
      return formatValue(u)
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '—'
      if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
      if (v >= 1_000) return (v / 1_000).toFixed(1) + 'k'
      return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1)
    }
    return String(v)
  }

  if (loading) {
    return (
      <div className="bp-card" style={{ borderLeft: `3px solid rgba(255,255,255,0.08)`, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="skeleton" style={{ height: 10, width: 80 }} />
          <div className="skeleton" style={{ height: 14, width: 14, borderRadius: '50%' }} />
        </div>
        <div className="skeleton" style={{ height: 28, width: 80, marginBottom: 8 }} />
        <div className="skeleton" style={{ height: 10, width: 60, marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 36, width: '100%' }} />
      </div>
    )
  }

  return (
    <div
      className="bp-card"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        cursor: 'default',
        transition: 'border-color 150ms ease, transform 150ms ease',
      }}
      onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-1px)'}
      onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {Icon && (
            <Icon size={12} style={{ color: iconColor || 'var(--bp-text-3)', flexShrink: 0 }} />
          )}
          <span style={{
            fontFamily: 'var(--bp-font-display)',
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--bp-text-3)',
          }}>
            {label}
          </span>
        </div>

        {/* Trend indicator */}
        {trendValue !== null && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            fontFamily: 'var(--bp-font-mono)',
            fontSize: 10,
            fontWeight: 600,
            color: trendColor,
          }}>
            {isGood && <TrendingUp size={10} />}
            {isBad  && <TrendingDown size={10} />}
            {isNeutral && <Minus size={10} />}
            {isGood ? '+' : ''}{trendValue}%
          </div>
        )}
      </div>

      {/* Value */}
      <div style={{
        fontFamily: 'var(--bp-font-display)',
        fontWeight: 700,
        fontSize: 26,
        color: 'var(--bp-text)',
        lineHeight: 1,
        marginBottom: 6,
      }}>
        {formatValue(value)}
        {unit && (
          <span style={{ fontSize: 12, fontFamily: 'var(--bp-font-mono)', fontWeight: 400, color: 'var(--bp-text-3)', marginLeft: 3 }}>
            {unit}
          </span>
        )}
      </div>

      {/* Previous comparison */}
      {prev !== undefined && prev !== null && (
        <div style={{
          fontFamily: 'var(--bp-font-mono)',
          fontSize: 10,
          color: 'var(--bp-text-3)',
          marginBottom: 10,
        }}>
          vs {formatValue(prev)}{unit} prev
        </div>
      )}

      {/* Sparkline */}
      {sparklineData && sparklineData.length > 1 && (
        <div style={{ marginTop: 'auto', marginLeft: -4, marginRight: -4 }}>
          <SparkLine data={sparklineData} color={sparkColor} height={30} />
        </div>
      )}
    </div>
  )
}

export default MetricCard
