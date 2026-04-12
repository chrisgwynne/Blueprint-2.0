import React, { useEffect, useState } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Scatter, ReferenceDot,
} from 'recharts'
import { formatDistanceToNow } from 'date-fns'
import { Target, TrendingUp, TrendingDown, ArrowRight, Circle } from 'lucide-react'
import useStore from '../lib/store.js'
import { getOutcomes, getAgentOutcomePerformance, getOutcomeTimeline } from '../lib/api.js'

const VERDICT_CONFIG = {
  improved:     { label: 'IMPROVED',    icon: '✅', color: 'var(--bp-green)' },
  worsened:     { label: 'WORSENED',    icon: '❌', color: 'var(--bp-red)'   },
  no_change:    { label: 'NO CHANGE',   icon: '→',  color: 'var(--bp-text-3)' },
  inconclusive: { label: 'INCONCLUSIVE', icon: '○',  color: 'var(--bp-text-3)' },
  pending:      { label: 'PENDING',     icon: '○',  color: 'var(--bp-blue)'  },
}

const METRIC_OPTIONS = [
  { value: 'gsc.total_clicks', label: 'GSC Clicks' },
  { value: 'ga4.sessions', label: 'GA4 Sessions' },
  { value: 'gsc.avg_ctr', label: 'GSC CTR' },
  { value: 'gsc.avg_position', label: 'GSC Position' },
  { value: 'pagespeed.mobile.performance_score', label: 'PageSpeed (Mobile)' },
]

function fmtRel(iso) {
  if (!iso) return '—'
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) }
  catch { return '—' }
}

// ─── Summary cards ───────────────────────────────────────────────────────────
function SummaryStrip({ summary }) {
  if (!summary) return null

  const rate = summary.improvement_rate ?? 0
  const ratePct = Math.round(rate * 100)

  const cards = [
    { label: 'Tasks Checked', value: summary.total_checked, sub: 'last 90 days' },
    { label: 'Improved', value: `${summary.improved} of ${summary.total_checked}`, sub: '' },
    { label: 'Improvement Rate', value: `${ratePct}%`, sub: '', color: ratePct >= 70 ? 'var(--bp-green)' : ratePct >= 40 ? 'var(--bp-amber)' : 'var(--bp-red)' },
    { label: 'Best Outcome', value: summary.best_label ?? '—', sub: summary.best_sub ?? '' },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
      {cards.map((c) => (
        <div key={c.label} className="bp-card">
          <div style={{
            fontFamily: 'var(--bp-font-mono)', fontSize: 9,
            letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase',
            marginBottom: 6,
          }}>{c.label}</div>
          <div style={{
            fontFamily: 'var(--bp-font-display)', fontSize: 22, fontWeight: 700,
            color: c.color ?? 'var(--bp-text)',
            lineHeight: 1.1,
          }}>{c.value}</div>
          {c.sub && <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
            {c.sub}
          </div>}
        </div>
      ))}
    </div>
  )
}

// ─── Impact timeline chart ────────────────────────────────────────────────────
function ImpactTimeline({ businessId }) {
  const [metric, setMetric] = useState('gsc.total_clicks')
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!businessId) return
    getOutcomeTimeline(businessId, { metric, days: 90 }).then(setData).catch(() => setData(null))
  }, [businessId, metric])

  const chartData = (data?.data_points ?? []).map((p) => {
    const markers = (data.task_markers ?? []).filter(t => t.date === p.date.split('T')[0])
    const marker = markers[0]
    return {
      date: p.date,
      value: p.value,
      marker: marker ? marker.verdict : null,
      task: marker ?? null,
    }
  })

  return (
    <div className="bp-card" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{
          fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em',
          color: 'var(--bp-text-3)', textTransform: 'uppercase',
        }}>Metric Impact Timeline</div>
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
          style={{
            background: 'var(--bp-surface-2)',
            border: '1px solid var(--bp-border)',
            color: 'var(--bp-text)',
            padding: '4px 8px',
            borderRadius: 4,
            fontFamily: 'var(--bp-font-mono)',
            fontSize: 11,
          }}
        >
          {METRIC_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div style={{ width: '100%', height: 260 }}>
        {chartData.length > 0 ? (
          <ResponsiveContainer>
            <ComposedChart data={chartData}>
              <CartesianGrid stroke="rgba(77,166,255,0.06)" strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fill: '#4d7a96', fontSize: 10 }} />
              <YAxis tick={{ fill: '#4d7a96', fontSize: 10 }} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bp-surface-2)',
                  border: '1px solid var(--bp-border)',
                  fontFamily: 'var(--bp-font-mono)',
                  fontSize: 11,
                }}
                formatter={(val, name, item) => {
                  if (name === 'value') return [val, 'Metric']
                  return [val, name]
                }}
                labelFormatter={(d) => new Date(d).toLocaleDateString()}
              />
              <Area dataKey="value" stroke="var(--bp-blue)" fill="rgba(77,166,255,0.15)" strokeWidth={2} />
              {chartData.filter(d => d.marker).map((d, i) => (
                <ReferenceDot
                  key={i}
                  x={d.date}
                  y={d.value}
                  r={6}
                  fill={VERDICT_CONFIG[d.marker]?.color ?? 'var(--bp-text-3)'}
                  stroke="var(--bp-base)"
                  strokeWidth={2}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
            Not enough data to render timeline.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Agent performance table ──────────────────────────────────────────────────
function AgentPerformance({ businessId }) {
  const [agents, setAgents] = useState([])

  useEffect(() => {
    if (!businessId) return
    getAgentOutcomePerformance(businessId).then(setAgents).catch(() => setAgents([]))
  }, [businessId])

  if (agents.length === 0) return null

  return (
    <div className="bp-card" style={{ padding: 0, marginBottom: 24, overflow: 'hidden' }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--bp-border)',
        fontFamily: 'var(--bp-font-mono)', fontSize: 10,
        letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase',
      }}>Agent Performance (30 days)</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bp-border)' }}>
            <Th>Agent</Th>
            <Th align="right">Proposed</Th>
            <Th align="right">Approved</Th>
            <Th align="right">Acceptance</Th>
            <Th align="right">Outcomes</Th>
            <Th align="right">Improved</Th>
            <Th>Calibration</Th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agent_id} style={{ borderBottom: '1px solid var(--bp-border)' }}>
              <Td><strong style={{ color: 'var(--bp-text)' }}>{a.agent_name}</strong></Td>
              <Td align="right">{a.tasks_proposed_30d}</Td>
              <Td align="right">{a.tasks_approved_30d}</Td>
              <Td align="right">{Math.round((a.acceptance_rate ?? 0) * 100)}%</Td>
              <Td align="right">{a.outcomes_measured}</Td>
              <Td align="right">
                <span style={{ color: (a.improvement_rate ?? 0) >= 0.7 ? 'var(--bp-green)' : (a.improvement_rate ?? 0) >= 0.4 ? 'var(--bp-amber)' : 'var(--bp-red)' }}>
                  {Math.round((a.improvement_rate ?? 0) * 100)}%
                </span>
              </Td>
              <Td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 80, height: 4, background: 'var(--bp-surface-3)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      width: `${Math.min(100, (a.calibration ?? 0) * 100)}%`,
                      height: '100%',
                      background: 'var(--bp-blue)',
                    }} />
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--bp-text-3)' }}>
                    {Math.round((a.calibration ?? 0) * 100)}%
                  </span>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, align = 'left' }) {
  return (
    <th style={{
      padding: '10px 16px',
      textAlign: align,
      fontFamily: 'var(--bp-font-mono)', fontSize: 9,
      letterSpacing: '0.10em', textTransform: 'uppercase',
      color: 'var(--bp-text-3)', fontWeight: 500,
    }}>{children}</th>
  )
}

function Td({ children, align = 'left' }) {
  return <td style={{ padding: '10px 16px', textAlign: align, color: 'var(--bp-text-2)' }}>{children}</td>
}

// ─── Outcome cards list ───────────────────────────────────────────────────────
function OutcomesList({ outcomes }) {
  if (!outcomes?.length) {
    return (
      <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
        No outcomes yet. Tasks measured 2–4 weeks after completion will appear here.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {outcomes.map((o) => {
        const verdict = o.final_verdict ?? 'pending'
        const cfg = VERDICT_CONFIG[verdict] ?? VERDICT_CONFIG.pending
        const check = o.check_4w ?? o.check_2w
        return (
          <div key={o.task_id} className="bp-card" style={{ borderLeft: `3px solid ${cfg.color}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{
                fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em',
                color: cfg.color, textTransform: 'uppercase', fontWeight: 600,
              }}>
                {cfg.icon} {cfg.label}
              </div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
                {fmtRel(o.completed_at)}
              </div>
            </div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 14, fontWeight: 600, color: 'var(--bp-text)', marginBottom: 6 }}>
              {o.task_title}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 12 }}>
              Proposed by <span style={{ color: 'var(--bp-text-2)' }}>{o.proposed_by}</span>
            </div>
            {o.target_metric && (
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 8 }}>
                <div style={{ color: 'var(--bp-text-3)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 3 }}>
                  Target Metric: {o.target_metric}
                </div>
                {check && (
                  <div>
                    Baseline: <strong>{Number(o.baseline_value ?? 0).toFixed(2)}</strong>
                    {' → '}
                    {check.weeks_after}-week: <strong>{Number(check.metric_value ?? 0).toFixed(2)}</strong>
                    {' '}
                    <span style={{ color: (check.change_pct ?? 0) > 0 ? 'var(--bp-green)' : 'var(--bp-red)' }}>
                      ({(check.change_pct ?? 0) > 0 ? '+' : ''}{Number(check.change_pct ?? 0).toFixed(1)}%)
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Outcomes() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [outcomes, setOutcomes] = useState(null)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    if (!currentBusiness) return
    const verdictFilter = filter === 'all' ? undefined : filter
    getOutcomes(currentBusiness.id, { verdict: verdictFilter, limit: 30 }).then(setOutcomes).catch(() => setOutcomes(null))
  }, [currentBusiness, filter])

  if (!currentBusiness) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)' }}>
        Select a business to view outcomes.
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24,
          color: 'var(--bp-text)', letterSpacing: '0.02em', marginBottom: 6,
        }}>OUTCOMES</h1>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)' }}>
          How Blueprint's actions have moved the needle.
        </p>
      </div>

      <SummaryStrip summary={outcomes?.summary} />
      <ImpactTimeline businessId={currentBusiness.id} />
      <AgentPerformance businessId={currentBusiness.id} />

      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{
          fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em',
          color: 'var(--bp-text-3)', textTransform: 'uppercase',
        }}>Task Outcomes</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['all', 'improved', 'worsened', 'no_change', 'pending'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '4px 10px',
                background: filter === f ? 'rgba(77,166,255,0.12)' : 'transparent',
                border: `1px solid ${filter === f ? 'var(--bp-blue)' : 'var(--bp-border)'}`,
                borderRadius: 3,
                color: filter === f ? 'var(--bp-blue)' : 'var(--bp-text-3)',
                fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em',
              }}
            >
              {f.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      <OutcomesList outcomes={outcomes?.outcomes} />
    </div>
  )
}
