export const CHART_COLORS = {
  blue:   '#3b82f6',
  cyan:   '#06b6d4',
  green:  '#10b981',
  amber:  '#f59e0b',
  red:    '#ef4444',
  orange: '#f97316',
  purple: '#9d7aff',
  muted:  'rgba(255,255,255,0.06)',
  text:   '#475569',
}

export const chartDefaults = {
  style: { fontFamily: "'DM Mono', monospace", fontSize: 11 },
  cartesianGrid: {
    strokeDasharray: '3 3',
    stroke: 'rgba(255,255,255,0.04)',
    vertical: false,
  },
  tooltip: {
    contentStyle: {
      background: '#111827',
      border: '1px solid rgba(255,255,255,0.10)',
      borderRadius: '4px',
      fontFamily: "'DM Mono', monospace",
      fontSize: 11,
      color: '#e2e8f0',
      boxShadow: 'none',
    },
    cursor: { stroke: 'rgba(59,130,246,0.2)', strokeWidth: 1 },
  },
  xAxis: {
    tick: { fill: '#475569', fontSize: 10, fontFamily: "'DM Mono', monospace" },
    axisLine: { stroke: 'rgba(255,255,255,0.06)' },
    tickLine: false,
  },
  yAxis: {
    tick: { fill: '#475569', fontSize: 10, fontFamily: "'DM Mono', monospace" },
    axisLine: false,
    tickLine: false,
    width: 40,
  },
}

// Sparkline preset — no axes, minimal
export const sparklineDefaults = {
  margin: { top: 2, right: 0, bottom: 2, left: 0 },
}

// Area gradient definitions (used in <defs>)
export function areaGradient(id, color, opacity = 0.15) {
  return { id, color, topOpacity: opacity, bottomOpacity: 0 }
}
