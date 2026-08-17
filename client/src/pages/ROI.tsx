/**
 * ROI dashboard — Blueprint's own report card.
 *
 * Four sections per the spec:
 *   1. Headline numbers (ROI ratio, attributed value, cost, actions)
 *   2. Business trajectory charts
 *   3. Agent scorecards with underperformers surfaced first
 *   4. Honest assessment — always includes uncertainty
 *
 * If the business has insufficient data (<30 days or <5 outcomes) the
 * page shows a progress-toward-meaningful-data state rather than
 * fabricating numbers.
 */

import React, { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from 'recharts'
import { format } from 'date-fns'
import {
  PiggyBank, TrendingUp, TrendingDown, Activity, AlertCircle,
  CheckCircle2, XCircle, Clock, RefreshCw,
} from 'lucide-react'
import useStore from '../lib/store'
import {
  getROIReport, getROIAgents, getROITrajectory, getROIAssessment,
} from '../lib/api'

const CONFIDENCE_LABELS: Record<string, { label: string; color: string }> & { insufficient: { label: string; color: string } } = {
  insufficient: { label: 'INSUFFICIENT DATA', color: 'var(--bp-text-3)' },
  early:        { label: 'EARLY SIGNAL',      color: 'var(--bp-amber)' },
  developing:   { label: 'DEVELOPING',        color: 'var(--bp-cyan)' },
  established:  { label: 'ESTABLISHED',       color: 'var(--bp-green)' },
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> & { unknown: { label: string; color: string; icon: string } } = {
  strong:          { label: 'Strong',     color: 'var(--bp-green)',  icon: '✅' },
  marginal:        { label: 'Marginal',   color: 'var(--bp-amber)',  icon: '⚠️' },
  review_needed:   { label: 'Review',     color: 'var(--bp-red)',    icon: '❌' },
  too_soon:        { label: 'Too soon',   color: 'var(--bp-text-3)', icon: '○' },
  no_cost_yet:     { label: 'No runs',    color: 'var(--bp-text-3)', icon: '○' },
  unknown:         { label: 'Unknown',    color: 'var(--bp-text-3)', icon: '?' },
}

interface Citation {
  task_id: string
  outcome_id: string | null
  window_start: string | null
  window_end: string | null
  window_end_is_expected: boolean
}

interface AttributedItem {
  task_id: string
  task_title: string
  metric_name: string
  change_pct?: number | null
  estimated_monthly_usd?: number | null
  taxonomy_state?: string
  citation?: Citation
}

interface TaxonomyCounts {
  activity: number
  verified_action: number
  outcome_measured: number
  roi_not_measurable: number
}

interface ROIReport {
  confidence_level: string
  days_since_install: number
  outcomes_count: number
  roi_ratio: number | null
  attributed_value_usd_per_month: number
  attributed_decline_usd_per_month: number
  total_cost_usd: number
  attributed_improvements?: AttributedItem[]
  attributed_declines?: AttributedItem[]
  taxonomy?: {
    counts: TaxonomyCounts
    pending_measurement?: Array<{ task_id: string; state: string; reason: string; citation: Citation }>
  }
}

const TAXONOMY_CONFIG: Record<string, { label: string; color: string }> = {
  activity:            { label: 'Activity',              color: 'var(--bp-text-3)' },
  verified_action:     { label: 'Verified action',       color: 'var(--bp-cyan)'   },
  outcome_measured:    { label: 'Outcome measured',      color: 'var(--bp-green)'  },
  roi_not_measurable:  { label: 'ROI not yet measurable', color: 'var(--bp-amber)' },
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString() } catch { return '—' }
}

interface ROIAgent {
  agent_id: string
  agent_name?: string
  total_cost_usd?: number
  tasks_proposed?: number
  tasks_approved?: number
  tasks_with_outcomes?: number
  improvement_rate_pct?: number | null
  estimated_monthly_value_usd?: number
  roi_ratio?: number | null
  status?: string
}

interface TrajectoryPoint {
  at: string
  value: number
}

interface TrajectorySeries {
  metric_name: string
  points: TrajectoryPoint[]
  baseline_date: string
  baseline_value?: number
}

interface ROIAssessment {
  assessment: string
  source?: string
  confidence_level?: string
}

function fmtMoney(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  return `${sign}£${abs.toFixed(2)}`
}
function fmtRatio(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(1)}x`
}

export default function ROIPage() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [report, setReport] = useState<ROIReport | null>(null)
  const [agents, setAgents] = useState<ROIAgent[] | null>(null)
  const [trajectory, setTrajectory] = useState<TrajectorySeries[] | null>(null)
  const [assessment, setAssessment] = useState<ROIAssessment | null>(null)
  const [loadingAssessment, setLoadingAssessment] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!currentBusiness?.id) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      getROIReport(currentBusiness.id).catch(() => null),
      getROIAgents(currentBusiness.id, { window_days: 90 }).catch(() => ({ agents: [] })),
      getROITrajectory(currentBusiness.id).catch(() => ({ series: [] })),
    ]).then(([r, a, t]) => {
      if (cancelled) return
      setReport(r as ROIReport | null)
      setAgents((a as { agents?: ROIAgent[] })?.agents ?? [])
      setTrajectory((t as { series?: TrajectorySeries[] })?.series ?? [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [currentBusiness?.id])

  // Assessment is fetched separately because it may invoke an LLM call.
  useEffect(() => {
    if (!currentBusiness?.id) return
    let cancelled = false
    setLoadingAssessment(true)
    getROIAssessment(currentBusiness.id)
      .then((a) => { if (!cancelled) setAssessment(a as ROIAssessment) })
      .catch(() => { if (!cancelled) setAssessment(null) })
      .finally(() => { if (!cancelled) setLoadingAssessment(false) })
    return () => { cancelled = true }
  }, [currentBusiness?.id])

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }
  if (loading) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>Loading ROI data…</div>
  }
  if (!report) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>No ROI data for this business yet.</div>
  }

  const confidence = CONFIDENCE_LABELS[report.confidence_level] ?? CONFIDENCE_LABELS.insufficient
  const isInsufficient = report.confidence_level === 'insufficient'

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <PiggyBank size={22} style={{ color: 'var(--bp-green)' }} />
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>
            RETURN ON INVESTMENT
          </h1>
          <span style={{
            fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.08em',
            color: confidence.color, border: `1px solid ${confidence.color}`,
            padding: '3px 8px', borderRadius: 3,
          }}>
            {confidence.label}
          </span>
        </div>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
          Blueprint's own report card. {report.days_since_install} days of data · {report.outcomes_count} outcomes measured.
        </p>
      </div>

      {/* Insufficient-data state */}
      {isInsufficient && (
        <InsufficientState report={report} />
      )}

      {/* Section 1 — headline numbers */}
      <Section title="Headline">
        <HeadlineCards report={report} />
      </Section>

      {/* Section 1b — outcome taxonomy (issue #63): distinguishes activity,
          verified action, measured outcome and ROI not yet measurable so
          the headline numbers above can't be mistaken for more certainty
          than the data supports. */}
      {report.taxonomy && (
        <Section title="Outcome taxonomy">
          <TaxonomyStrip counts={report.taxonomy.counts} />
          <AttributedOutcomesList
            improvements={report.attributed_improvements ?? []}
            declines={report.attributed_declines ?? []}
          />
        </Section>
      )}

      {/* Section 2 — trajectory */}
      {trajectory && trajectory.length > 0 && (
        <Section title="Business trajectory">
          <TrajectoryCharts trajectory={trajectory} report={report} />
        </Section>
      )}

      {/* Section 3 — agent scorecards */}
      <Section title="Agent scorecards (last 90 days)">
        <AgentScorecards agents={agents ?? []} />
      </Section>

      {/* Section 4 — honest assessment */}
      <Section title="Honest assessment">
        <HonestAssessment
          assessment={assessment}
          loading={loadingAssessment}
        />
      </Section>
    </div>
  )
}

// ─── Sections ────────────────────────────────────────────────────────────────

interface SectionProps {
  title: string
  children: React.ReactNode
}

function Section({ title, children }: SectionProps) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em',
        color: 'var(--bp-text-3)', textTransform: 'uppercase',
        marginBottom: 10, paddingBottom: 4, borderBottom: '1px solid var(--bp-border)',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

interface InsufficientStateProps {
  report: ROIReport
}

function InsufficientState({ report }: InsufficientStateProps) {
  const daysTarget = 30, outcomesTarget = 5
  const daysPct = Math.min(100, (report.days_since_install / daysTarget) * 100)
  const outcomesPct = Math.min(100, (report.outcomes_count / outcomesTarget) * 100)
  return (
    <div style={{
      padding: 16, marginBottom: 20,
      background: 'rgba(77,166,255,0.04)',
      border: '1px solid var(--bp-border)', borderRadius: 4,
    }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-2)', marginBottom: 10 }}>
        Blueprint needs <strong>at least 30 days</strong> of operating data and <strong>5 measured outcomes</strong> before it can produce a meaningful ROI estimate.
      </div>
      <ProgressBar label={`Days: ${report.days_since_install} / ${daysTarget}`} pct={daysPct} />
      <ProgressBar label={`Outcomes measured: ${report.outcomes_count} / ${outcomesTarget}`} pct={outcomesPct} />
    </div>
  )
}

interface ProgressBarProps {
  label: string
  pct: number
}

function ProgressBar({ label, pct }: ProgressBarProps) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ height: 4, background: 'var(--bp-border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--bp-blue)' }} />
      </div>
    </div>
  )
}

// ─── Headline cards ──────────────────────────────────────────────────────────

interface HeadlineCardsProps {
  report: ROIReport
}

function HeadlineCards({ report }: HeadlineCardsProps) {
  const improved = report.attributed_improvements?.length ?? 0
  const declined = report.attributed_declines?.length ?? 0
  const pending = (report.outcomes_count ?? 0) - improved - declined
  const improvedPct = (improved + declined) > 0
    ? Math.round((improved / (improved + declined)) * 100)
    : null

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
      <MetricCard
        label="Blueprint ROI"
        value={fmtRatio(report.roi_ratio)}
        color={report.roi_ratio == null ? 'var(--bp-text-3)'
             : report.roi_ratio >= 1 ? 'var(--bp-green)' : 'var(--bp-red)'}
        hint={report.roi_ratio == null
          ? 'Not yet meaningful — need more measured outcomes'
          : 'Value generated per £ spent'}
      />
      <MetricCard
        label="Attributed value"
        value={fmtMoney(report.attributed_value_usd_per_month) + '/mo'}
        color={report.attributed_value_usd_per_month > 0 ? 'var(--bp-green)' : 'var(--bp-text-3)'}
        hint={report.attributed_decline_usd_per_month > 0
          ? `minus ${fmtMoney(report.attributed_decline_usd_per_month)}/mo from worsened outcomes`
          : 'from task outcomes directly linked to Blueprint'}
      />
      <MetricCard
        label="Running cost"
        value={fmtMoney(report.total_cost_usd)}
        color="var(--bp-text)"
        hint={`over ${report.days_since_install} days`}
      />
      <MetricCard
        label="Outcomes measured"
        value={String(report.outcomes_count ?? 0)}
        color={report.outcomes_count >= 5 ? 'var(--bp-text)' : 'var(--bp-amber)'}
        hint={improvedPct != null
          ? `${improvedPct}% improved · ${pending} pending measurement`
          : 'none yet'}
      />
    </div>
  )
}

interface MetricCardProps {
  label: string
  value: string
  color: string
  hint?: string
}

function MetricCard({ label, value, color, hint }: MetricCardProps) {
  return (
    <div style={{
      padding: 14, background: 'var(--bp-bg)',
      border: '1px solid var(--bp-border)', borderRadius: 4,
    }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)',
        textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 22, fontWeight: 600,
        color, marginBottom: 4 }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}

// ─── Outcome taxonomy (issue #63) ──────────────────────────────────────────

interface TaxonomyStripProps {
  counts: TaxonomyCounts
}

function TaxonomyStrip({ counts }: TaxonomyStripProps) {
  const order: Array<keyof TaxonomyCounts> = ['activity', 'verified_action', 'outcome_measured', 'roi_not_measurable']
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 14 }}>
      {order.map((key) => {
        const cfg = TAXONOMY_CONFIG[key] ?? { label: key, color: 'var(--bp-text-3)' }
        return (
          <div key={key} style={{
            padding: 10, background: 'var(--bp-bg)',
            border: `1px solid ${cfg.color}`, borderRadius: 4,
          }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 18, fontWeight: 700, color: cfg.color }}>
              {counts[key] ?? 0}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
              {cfg.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface AttributedOutcomesListProps {
  improvements: AttributedItem[]
  declines: AttributedItem[]
}

function AttributedOutcomesList({ improvements, declines }: AttributedOutcomesListProps) {
  const items = [...improvements, ...declines]
  if (items.length === 0) {
    return (
      <div style={{ padding: 12, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        No outcome-measured tasks are attributed to Blueprint yet.
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it) => {
        const cfg = (it.taxonomy_state ? TAXONOMY_CONFIG[it.taxonomy_state] : null) ?? TAXONOMY_CONFIG.outcome_measured!
        const positive = (it.estimated_monthly_usd ?? 0) >= 0
        return (
          <div key={it.task_id} style={{
            padding: 10, background: 'var(--bp-bg)',
            border: '1px solid var(--bp-border)', borderRadius: 4,
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>
                {it.task_title} <span style={{ color: 'var(--bp-text-3)' }}>({it.metric_name})</span>
              </div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, marginTop: 4 }}>
                <span style={{ color: cfg.color, border: `1px solid ${cfg.color}`, borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' }}>
                  {cfg.label}
                </span>
              </div>
              {it.citation && (
                <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 4 }}>
                  Based on: task {it.citation.task_id.slice(0, 8)}
                  {it.citation.outcome_id ? ` · outcome ${it.citation.outcome_id.slice(0, 8)}` : ''}
                  {' · window '}
                  {fmtDate(it.citation.window_start)} → {fmtDate(it.citation.window_end)}
                  {it.citation.window_end_is_expected ? ' (expected)' : ''}
                </div>
              )}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 13, fontWeight: 600, color: positive ? 'var(--bp-green)' : 'var(--bp-red)' }}>
              {fmtMoney(it.estimated_monthly_usd)}/mo
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Trajectory charts ──────────────────────────────────────────────────────

interface TrajectoryChartsProps {
  trajectory: TrajectorySeries[]
  report: ROIReport
}

function TrajectoryCharts({ trajectory, report }: TrajectoryChartsProps) {
  // Pick up to 3 revenue-ish metrics to chart. Don't overload.
  const preferred = [
    'shopify.revenue_30d', 'stripe.mrr', 'stripe.revenue_30d',
    'ga4.sessions_30d', 'gsc.total_clicks',
  ]
  const chartable = trajectory
    .filter(s => s.points?.length >= 2)
    .sort((a, b) => {
      const ai = preferred.indexOf(a.metric_name); const bi = preferred.indexOf(b.metric_name)
      const aw = ai === -1 ? 99 : ai; const bw = bi === -1 ? 99 : bi
      return aw - bw
    })
    .slice(0, 3)

  if (chartable.length === 0) {
    return (
      <div style={{ padding: 16, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        Not enough metric samples yet to draw trajectory charts. Charts appear after a few connector syncs.
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
      {chartable.map((series) => (
        <MetricChart key={series.metric_name} series={series} baselineDate={series.baseline_date} />
      ))}
    </div>
  )
}

interface MetricChartProps {
  series: TrajectorySeries
  baselineDate: string
}

function MetricChart({ series, baselineDate }: MetricChartProps) {
  const data = series.points.map(p => ({
    t: new Date(p.at).getTime(),
    v: p.value,
    label: format(new Date(p.at), 'MMM d'),
  }))
  const baselineMs = new Date(baselineDate).getTime()

  return (
    <div style={{ padding: 12, background: 'var(--bp-bg)',
      border: '1px solid var(--bp-border)', borderRadius: 4 }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10,
        color: 'var(--bp-text-2)', marginBottom: 6 }}>
        {series.metric_name}
      </div>
      <div style={{ height: 180 }}>
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--bp-border)" strokeOpacity={0.3} />
            <XAxis
              dataKey="t"
              tickFormatter={(v) => format(new Date(v), 'MMM d')}
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 10, fill: 'var(--bp-text-3)' }}
              stroke="var(--bp-text-3)"
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--bp-text-3)' }}
              stroke="var(--bp-text-3)"
            />
            <Tooltip
              labelFormatter={(v) => format(new Date(v as number), 'MMM d, HH:mm')}
              contentStyle={{ background: 'var(--bp-base)', border: '1px solid var(--bp-border)', fontSize: 11 }}
            />
            <ReferenceLine x={baselineMs} stroke="var(--bp-blue)" strokeDasharray="3 3"
              label={{ value: 'baseline', position: 'top', fontSize: 9, fill: 'var(--bp-blue)' }} />
            <Line type="monotone" dataKey="v" stroke="var(--bp-green)" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9,
        color: 'var(--bp-text-3)', marginTop: 6 }}>
        baseline {series.baseline_value} → current {data[data.length - 1]?.v}
      </div>
    </div>
  )
}

// ─── Agent scorecards ───────────────────────────────────────────────────────

interface AgentScorecardsProps {
  agents: ROIAgent[]
}

function AgentScorecards({ agents }: AgentScorecardsProps) {
  if (!agents?.length) {
    return (
      <div style={{ padding: 16, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        No agents have run against this business yet.
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse',
        fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bp-border)' }}>
            {['Agent', 'Cost', 'Proposed', 'Measured', 'Win rate', 'Est. value/mo', 'ROI', 'Status'].map((h) => (
              <th key={h} style={{
                textAlign: 'left', padding: '6px 8px',
                fontSize: 9, color: 'var(--bp-text-3)',
                textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const status = STATUS_CONFIG[a.status ?? ''] ?? STATUS_CONFIG.unknown
            return (
              <tr key={a.agent_id} style={{ borderBottom: '1px solid var(--bp-border)22' }}>
                <td style={{ padding: '8px', color: 'var(--bp-text)' }}>{a.agent_name}</td>
                <td style={{ padding: '8px', color: 'var(--bp-text-2)' }}>{fmtMoney(a.total_cost_usd)}</td>
                <td style={{ padding: '8px', color: 'var(--bp-text-2)' }}>
                  {a.tasks_proposed} <span style={{ color: 'var(--bp-text-3)' }}>({a.tasks_approved} ok)</span>
                </td>
                <td style={{ padding: '8px', color: 'var(--bp-text-2)' }}>
                  {a.tasks_with_outcomes}
                </td>
                <td style={{ padding: '8px', color: 'var(--bp-text-2)' }}>
                  {a.improvement_rate_pct != null ? `${a.improvement_rate_pct}%` : '—'}
                </td>
                <td style={{ padding: '8px', color: (a.estimated_monthly_value_usd ?? 0) >= 0 ? 'var(--bp-green)' : 'var(--bp-red)' }}>
                  {fmtMoney(a.estimated_monthly_value_usd)}
                </td>
                <td style={{ padding: '8px', color: 'var(--bp-text)' }}>
                  {a.roi_ratio != null ? fmtRatio(a.roi_ratio) : '—'}
                </td>
                <td style={{ padding: '8px', color: status.color, fontWeight: 500 }}>
                  {status.icon} {status.label}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Honest assessment ──────────────────────────────────────────────────────

interface HonestAssessmentProps {
  assessment: ROIAssessment | null
  loading: boolean
}

function HonestAssessment({ assessment, loading }: HonestAssessmentProps) {
  if (loading) {
    return <div style={{ color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>Generating…</div>
  }
  if (!assessment) {
    return <div style={{ color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>No assessment available yet.</div>
  }

  return (
    <div style={{ padding: 16, background: 'var(--bp-bg)',
      border: '1px solid var(--bp-border)', borderRadius: 4 }}>
      <div style={{ whiteSpace: 'pre-wrap',
        fontFamily: 'var(--bp-font-body)', fontSize: 13, lineHeight: 1.6,
        color: 'var(--bp-text)' }}>
        {assessment.assessment}
      </div>
      <div style={{ marginTop: 12, fontFamily: 'var(--bp-font-mono)', fontSize: 9,
        color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Source: {assessment.source ?? 'unknown'} · Confidence: {assessment.confidence_level ?? 'unknown'}
      </div>
    </div>
  )
}
