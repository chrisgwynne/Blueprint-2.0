import React, { useEffect, useState, useCallback } from 'react'
import { Gauge } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import useStore from '../lib/store.js'
import { getCalibration } from '../lib/api.js'

interface CalibrationBin {
  range: string
  n: number
  raw_success_rate: number | null
  shrunk_success_rate: number
}

interface CalibrationRow {
  id: string
  agent_id: string
  business_id: string
  tasks_with_outcomes: number
  avg_stated_confidence: number | null
  avg_actual_outcome_rate: number | null
  calibration_error: number | null
  calibration_score: number | null
  calibration_offset: number | null
  calibration_method: string
  conservatism_factor: number
  trend: string | null
  notes: string | null
  bins: CalibrationBin[]
  calculated_at: string
  [key: string]: unknown
}

function pct(v: number | null | undefined) { return v == null ? '—' : `${Math.round(v * 100)}%` }

function AgentCalibrationCard({ row }: { row: CalibrationRow }) {
  const errorColor = (row.calibration_error ?? 0) > 0.15 ? 'var(--bp-red)' : (row.calibration_error ?? 0) > 0.08 ? 'var(--bp-amber)' : 'var(--bp-green)'
  const chartData = (row.bins || []).map((b) => ({
    range: b.range,
    stated: null,
    actual: Math.round((b.shrunk_success_rate ?? 0) * 100),
    n: b.n,
  }))

  return (
    <div className="bp-card" style={{ padding: 18, marginBottom: 14, borderLeft: `3px solid ${errorColor}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Gauge size={14} style={{ color: errorColor }} />
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)' }}>{row.agent_id}</div>
        {row.trend && <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>{row.trend}</span>}
        {row.conservatism_factor > 1 && (
          <span className="bp-pill bp-pill-blue" style={{ fontSize: 9 }}>{row.conservatism_factor.toFixed(2)}x more conservative</span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>Stated</div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 16 }}>{pct(row.avg_stated_confidence)}</div>
        </div>
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>Actual</div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 16 }}>{pct(row.avg_actual_outcome_rate)}</div>
        </div>
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>Error</div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 16, color: errorColor }}>{pct(row.calibration_error)}</div>
        </div>
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>Sample</div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 16 }}>{row.tasks_with_outcomes}</div>
        </div>
      </div>

      {chartData.length > 0 && (
        <div style={{ height: 140, marginBottom: 8 }}>
          <ResponsiveContainer>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bp-border)" strokeOpacity={0.3} />
              <XAxis dataKey="range" tick={{ fontSize: 9, fill: 'var(--bp-text-3)' }} stroke="var(--bp-text-3)" />
              <YAxis tick={{ fontSize: 9, fill: 'var(--bp-text-3)' }} stroke="var(--bp-text-3)" domain={[0, 100]} />
              <Tooltip
                formatter={(v: number, name: string, entry: any) => [`${v}% (n=${entry.payload.n})`, 'Actual success rate']}
                contentStyle={{ background: 'var(--bp-base)', border: '1px solid var(--bp-border)', fontSize: 11 }}
              />
              <Bar dataKey="actual" fill="var(--bp-blue)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
        Reliability by stated-confidence decile (Bayesian-shrunk, recency-weighted) · {row.calibration_method}
      </div>
      {row.notes && (
        <div style={{ marginTop: 10, padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', fontStyle: 'italic' }}>
          "{row.notes}"
        </div>
      )}
    </div>
  )
}

export default function Calibration() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [calibration, setCalibration] = useState<CalibrationRow[]>([])

  const load = useCallback(async () => {
    if (!currentBusiness) return
    try {
      const result = await getCalibration(currentBusiness.id)
      setCalibration(result?.calibration || [])
    } catch { setCalibration([]) }
  }, [currentBusiness])

  useEffect(() => { load() }, [load])

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>CALIBRATION</h1>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
          How well does each agent's stated confidence predict what actually happens? Agents repeatedly wrong become more conservative automatically.
        </p>
      </div>

      {calibration.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          No calibration data yet — this fills in once agents' recommendations have outcomes to measure against (via monthly retrospectives).
        </div>
      ) : (
        calibration.map((row) => <AgentCalibrationCard key={row.id} row={row} />)
      )}
    </div>
  )
}
