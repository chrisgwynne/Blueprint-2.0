import React from 'react'
import {
  LineChart as ReLineChart,
  Line,
  AreaChart as ReAreaChart,
  Area,
  BarChart as ReBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { chartDefaults, CHART_COLORS } from '../lib/chartTheme.js'

// Custom tooltip
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div style={chartDefaults.tooltip.contentStyle}>
      <p style={{ color: 'var(--bp-text-3)', fontSize: 10, marginBottom: 4, fontFamily: "'DM Mono', monospace" }}>{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color, fontSize: 11, fontFamily: "'DM Mono', monospace", margin: '2px 0' }}>
          {entry.name}: {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}
        </p>
      ))}
    </div>
  )
}

// ============================================
// SparkLine — minimal, no axes, no grid
// ============================================
export function SparkLine({ data = [], color = CHART_COLORS.blue, height = 40, dataKey = 'value' }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center">
        <span style={{ color: 'var(--bp-text-3)', fontSize: 10 }}>—</span>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReLineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </ReLineChart>
    </ResponsiveContainer>
  )
}

// ============================================
// AreaChart — for traffic trends
// ============================================
export function AreaChart({ data = [], metrics = [], height = 200 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReAreaChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <defs>
          {metrics.map((m, i) => (
            <linearGradient key={m.key} id={`grad-${m.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={m.color || CHART_COLORS.blue} stopOpacity={0.15} />
              <stop offset="95%" stopColor={m.color || CHART_COLORS.blue} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="rgba(255,255,255,0.04)"
          vertical={false}
        />
        <XAxis
          dataKey="date"
          tick={chartDefaults.xAxis.tick}
          axisLine={chartDefaults.xAxis.axisLine}
          tickLine={false}
        />
        <YAxis
          tick={chartDefaults.yAxis.tick}
          axisLine={false}
          tickLine={false}
          width={chartDefaults.yAxis.width}
        />
        <Tooltip content={<CustomTooltip />} cursor={chartDefaults.tooltip.cursor} />
        {metrics.length > 1 && (
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: 'var(--bp-text-3)' }} />
        )}
        {metrics.map((m, i) => (
          <Area
            key={m.key}
            type="monotone"
            dataKey={m.key}
            name={m.label || m.key}
            stroke={m.color || CHART_COLORS.blue}
            fill={`url(#grad-${m.key})`}
            strokeWidth={1.5}
            dot={false}
          />
        ))}
      </ReAreaChart>
    </ResponsiveContainer>
  )
}

// ============================================
// BarChart
// ============================================
export function BarChart({ data = [], metric = 'value', height = 200, color = CHART_COLORS.blue, label }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReBarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="rgba(255,255,255,0.04)"
          vertical={false}
        />
        <XAxis
          dataKey="date"
          tick={chartDefaults.xAxis.tick}
          axisLine={chartDefaults.xAxis.axisLine}
          tickLine={false}
        />
        <YAxis
          tick={chartDefaults.yAxis.tick}
          axisLine={false}
          tickLine={false}
          width={chartDefaults.yAxis.width}
        />
        <Tooltip content={<CustomTooltip />} cursor={chartDefaults.tooltip.cursor} />
        <Bar dataKey={metric} name={label || metric} fill={color} radius={[2, 2, 0, 0]} />
      </ReBarChart>
    </ResponsiveContainer>
  )
}

// ============================================
// LineChart — multi-series
// ============================================
export function LineChart({ data = [], metrics = [], height = 200 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReLineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="rgba(255,255,255,0.04)"
          vertical={false}
        />
        <XAxis
          dataKey="date"
          tick={chartDefaults.xAxis.tick}
          axisLine={chartDefaults.xAxis.axisLine}
          tickLine={false}
        />
        <YAxis
          tick={chartDefaults.yAxis.tick}
          axisLine={false}
          tickLine={false}
          width={chartDefaults.yAxis.width}
        />
        <Tooltip content={<CustomTooltip />} cursor={chartDefaults.tooltip.cursor} />
        {metrics.length > 1 && (
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: 'var(--bp-text-3)' }} />
        )}
        {metrics.map((m) => (
          <Line
            key={m.key}
            type="monotone"
            dataKey={m.key}
            name={m.label || m.key}
            stroke={m.color || CHART_COLORS.blue}
            strokeWidth={1.5}
            dot={false}
          />
        ))}
      </ReLineChart>
    </ResponsiveContainer>
  )
}
