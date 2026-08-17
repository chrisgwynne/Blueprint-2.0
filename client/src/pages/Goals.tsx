import React, { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import { Target, Plus, Sparkles, Check, X, Pause, Edit2, RefreshCw, GitBranch, Clock } from 'lucide-react'
import useStore from '../lib/store.js'
import {
  getGoals, createGoal, updateGoal, deleteGoal, checkGoal, proposeGoal, reasonGoal,
  getGoalSuggestions, runGoalSuggestionScan,
  acceptGoalSuggestion, dismissGoalSuggestion, snoozeGoalSuggestion,
  getGoalAssessment, getGoalStrategies, getGoalTimeline,
} from '../lib/api.js'

const PRIORITY_LABELS: Record<string, string> = { p1: 'P1 · Critical', p2: 'P2 · Normal', p3: 'P3 · Low' }
const PRIORITY_COLORS: Record<string, string> = { p1: 'var(--bp-red)', p2: 'var(--bp-blue)', p3: 'var(--bp-text-3)' }

const AGENTS = ['conductor', 'seo-sentinel', 'quill', 'velocity', 'trend-spotter', 'merchant', 'ledger', 'sentinel', 'researcher', 'reporter', 'dev', 'outreach']

const METRIC_OPTIONS = [
  { group: 'GA4', options: [
    'ga4.sessions', 'ga4.users', 'ga4.bounce_rate', 'ga4.conversions',
  ]},
  { group: 'GSC', options: [
    'gsc.total_clicks', 'gsc.total_impressions', 'gsc.avg_ctr', 'gsc.avg_position',
  ]},
  { group: 'PageSpeed', options: [
    'pagespeed.mobile.performance_score', 'pagespeed.mobile.lcp_ms',
  ]},
  { group: 'Shopify', options: [
    'shopify.total_revenue_30d', 'shopify.order_count_30d',
  ]},
  { group: 'Meta Ads', options: [
    'meta-ads.roas', 'meta-ads.revenue_30d', 'meta-ads.spend_30d',
  ]},
]

interface Goal {
  id: string
  title: string
  metric_name?: string
  metric_target?: number
  metric_current?: number | null
  metric_baseline?: number | null
  metric_unit?: string
  description?: string
  status: string
  progress_pct?: number
  deadline?: string
  assigned_agents?: string[]
  last_checked?: string
  notes?: any[]
  milestones?: any[]
  dependencies?: Array<{ goal_id: string; title: string; status: string; progress_pct: number; note?: string }>
  strategy?: string
  owner?: string | null
  confidence?: number | null
  priority?: string
  [key: string]: unknown
}

interface Suggestion {
  id: string
  title: string
  description?: string
  metric_name?: string
  current_value?: number
  target_value?: number
  opportunity_value?: number
  opportunity_unit?: string
  barrier?: string
  confidence?: number
  [key: string]: unknown
}

function fmtRel(iso: string | undefined | null) {
  if (!iso) return '—'
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) } catch { return '—' }
}

function daysUntil(iso: string | undefined | null) {
  if (!iso) return null
  const d = parseTimestamp(iso)
  if (!d) return null
  return Math.ceil((d.getTime() - Date.now()) / 86400000)
}

function GoalCard({ goal, businessId, onRefresh }: { goal: Goal; businessId: string; onRefresh: () => void }) {
  const pct = Math.round(goal.progress_pct ?? 0)
  const days = daysUntil(goal.deadline as string | undefined)
  const isAchieved = goal.status === 'achieved'
  const isAtRisk = days != null && days < 14 && pct < 70
  const isMissed = goal.status === 'missed'

  const borderColor = isAchieved ? 'var(--bp-green)'
                    : isMissed ? 'var(--bp-red)'
                    : isAtRisk ? 'var(--bp-amber)'
                    : 'var(--bp-border)'

  async function handleCheck() {
    await checkGoal(businessId, goal.id)
    await onRefresh()
  }
  async function handlePause() {
    await updateGoal(businessId, goal.id, { status: goal.status === 'paused' ? 'active' : 'paused' })
    await onRefresh()
  }

  const lastNote = (goal.notes?.length ?? 0) > 0 ? goal.notes![goal.notes!.length - 1] : null
  const milestones = Array.isArray(goal.milestones) ? goal.milestones : []
  const reasoningNote = Array.isArray(goal.notes)
    ? [...goal.notes].reverse().find((n) => n && typeof n === 'object' && n.source === 'goal-reasoner')
    : null
  const [reasoning, setReasoning] = useState(false)
  const [showStrategy, setShowStrategy] = useState(false)
  async function handleReason() {
    setReasoning(true)
    try { await reasonGoal(businessId, goal.id); await onRefresh() }
    finally { setReasoning(false) }
  }

  const feasibilityColor =
    reasoningNote?.feasibility === 'achievable' ? 'var(--bp-green)'
    : reasoningNote?.feasibility === 'ambitious' ? 'var(--bp-amber)'
    : reasoningNote?.feasibility === 'unlikely' ? 'var(--bp-amber)'
    : reasoningNote?.feasibility === 'unrealistic' ? 'var(--bp-red)'
    : 'var(--bp-text-3)'

  return (
    <div className="bp-card" style={{ padding: 20, marginBottom: 14, borderLeft: `3px solid ${borderColor}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <Target size={14} style={{ color: borderColor }} />
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)' }}>
          {goal.title}
        </div>
        {isAchieved && <span style={{ fontSize: 10, color: 'var(--bp-green)', fontFamily: 'var(--bp-font-mono)' }}>✅ ACHIEVED</span>}
        {isAtRisk && !isAchieved && <span style={{ fontSize: 10, color: 'var(--bp-amber)', fontFamily: 'var(--bp-font-mono)' }}>⚠ AT RISK</span>}
        {isMissed && <span style={{ fontSize: 10, color: 'var(--bp-red)', fontFamily: 'var(--bp-font-mono)' }}>❌ MISSED</span>}
        {goal.priority && (
          <span className="bp-pill" style={{ marginLeft: 'auto', background: `${PRIORITY_COLORS[goal.priority] ?? 'var(--bp-text-3)'}20`, color: PRIORITY_COLORS[goal.priority] ?? 'var(--bp-text-3)', fontSize: 9 }}>
            {PRIORITY_LABELS[goal.priority] ?? goal.priority}
          </span>
        )}
      </div>
      {(goal.owner || goal.confidence != null) && (
        <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 8 }}>
          {goal.owner && <span>Owner: {goal.owner}</span>}
          {goal.confidence != null && <span>Confidence: {Math.round((goal.confidence as number) * 100)}%</span>}
        </div>
      )}
      {goal.description && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 12 }}>
          {goal.description}
        </div>
      )}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 4 }}>
          <span>Progress</span>
          <span style={{ color: pct >= 70 ? 'var(--bp-green)' : pct >= 40 ? 'var(--bp-amber)' : 'var(--bp-red)' }}>{pct}%</span>
        </div>
        <div style={{ height: 6, background: 'var(--bp-surface-3)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, pct)}%`, height: '100%',
            background: pct >= 70 ? 'var(--bp-green)' : pct >= 40 ? 'var(--bp-amber)' : 'var(--bp-red)',
          }} />
        </div>
      </div>
      {goal.metric_name && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 8 }}>
          {goal.metric_name}: <strong>{goal.metric_current ?? '—'}</strong>
          {' → '}
          <strong>{goal.metric_target}</strong> target
          {goal.metric_baseline != null && ` (baseline: ${goal.metric_baseline})`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 10 }}>
        {days != null && <span>{days > 0 ? `${days} days remaining` : `${-days} days overdue`}</span>}
        {(goal.assigned_agents?.length ?? 0) > 0 && <span>Assigned: {(goal.assigned_agents as string[]).join(', ')}</span>}
        {goal.last_checked && <span>Last checked: {fmtRel(goal.last_checked as string)}</span>}
      </div>
      {lastNote && (
        <div style={{ padding: 8, background: 'var(--bp-surface-2)', borderRadius: 3, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', fontStyle: 'italic', marginBottom: 10 }}>
          "{typeof lastNote === 'string' ? lastNote : lastNote.text}"
        </div>
      )}
      {milestones.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 6 }}>Milestones</div>
          {milestones.map((m: any, i: number) => {
            const done = pct >= (m.target_pct ?? 100)
            return (
              <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: done ? 'var(--bp-green)' : 'var(--bp-text-3)', padding: '2px 0' }}>
                {done ? '✅' : '○'} {m.title}
              </div>
            )
          })}
        </div>
      )}
      {Array.isArray(goal.dependencies) && goal.dependencies.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 6 }}>
            <GitBranch size={9} style={{ display: 'inline', marginRight: 4 }} /> Depends on
          </div>
          {goal.dependencies.map((d) => (
            <div key={d.goal_id} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: d.status === 'achieved' ? 'var(--bp-green)' : 'var(--bp-text-3)', padding: '2px 0' }}>
              {d.status === 'achieved' ? '✅' : '○'} {d.title} ({Math.round(d.progress_pct ?? 0)}%)
            </div>
          ))}
        </div>
      )}
      {reasoningNote && (
        <div style={{ marginTop: 4, marginBottom: 10, padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3, borderLeft: `2px solid ${feasibilityColor}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)' }}>
              Strategic reasoning
            </span>
            {reasoningNote.feasibility && (
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: feasibilityColor, textTransform: 'uppercase' }}>
                {reasoningNote.feasibility}
                {reasoningNote.confidence != null && ` · ${Math.round(reasoningNote.confidence * 100)}%`}
              </span>
            )}
          </div>
          {reasoningNote.text && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 4 }}>
              {reasoningNote.text}
            </div>
          )}
          {reasoningNote.recommended_path && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
              Recommended path: <strong style={{ color: 'var(--bp-text-2)' }}>{reasoningNote.recommended_path}</strong>
            </div>
          )}
          {goal.strategy && (
            <div style={{ marginTop: 6, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', whiteSpace: 'pre-wrap' }}>
              {goal.strategy as string}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleCheck} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
          <RefreshCw size={11} /> Check now
        </button>
        <button onClick={handleReason} disabled={reasoning} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
          <Sparkles size={11} /> {reasoning ? 'Reasoning…' : (reasoningNote ? 'Re-run analysis' : 'Analyse strategy')}
        </button>
        <button onClick={handlePause} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
          <Pause size={11} /> {goal.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button onClick={() => setShowStrategy((s) => !s)} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
          <Clock size={11} /> {showStrategy ? 'Hide strategy & timeline' : 'Strategy & timeline'}
        </button>
      </div>
      {showStrategy && <StrategyPanel businessId={businessId} goalId={goal.id} />}
    </div>
  )
}

interface TimelineEvent {
  at: string | null
  type: string
  source?: string
  summary: string
  status?: string | null
  evidence?: string | null
  business_scope?: string
  attribution?: 'correlation' | 'verified_attribution' | null
  reason?: string
  gap_type?: string
}

interface StrategyData {
  assessment: Record<string, any> | null
  strategies: Array<Record<string, any>>
  timeline: TimelineEvent[]
}

const ATTRIBUTION_LABELS: Record<string, string> = {
  verified_attribution: 'Verified attribution',
  correlation: 'Correlation only',
}
const ATTRIBUTION_COLORS: Record<string, string> = {
  verified_attribution: 'var(--bp-green)',
  correlation: 'var(--bp-text-3)',
}

const GAP_LABELS: Record<string, string> = {
  no_signal_linked: 'No signal linked',
  stale_activity: 'Stale — no activity',
  no_downstream_action: 'No downstream action',
  no_measured_outcome: 'No measured outcome',
}

function StrategyPanel({ businessId, goalId }: { businessId: string; goalId: string }) {
  const [data, setData] = useState<StrategyData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const [assessmentRes, strategiesRes, timelineRes] = await Promise.all([
        getGoalAssessment(businessId, goalId).catch(() => null),
        getGoalStrategies(businessId, goalId).catch(() => ({ strategies: [] })),
        getGoalTimeline(businessId, goalId).catch(() => ({ events: [] })),
      ])
      if (cancelled) return
      setData({
        assessment: assessmentRes?.assessment ?? null,
        strategies: strategiesRes?.strategies ?? [],
        timeline: timelineRes?.events ?? [],
      })
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [businessId, goalId])

  if (loading) return <div style={{ padding: 12, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>Loading…</div>
  if (!data) return null

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--bp-border)' }}>
      {data.assessment ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 6 }}>
            Strategic assessment — {data.assessment.feasibility_verdict}
            {data.assessment.feasibility_confidence != null && ` (${Math.round(data.assessment.feasibility_confidence * 100)}%)`}
          </div>
          {Array.isArray(data.assessment.risks) && data.assessment.risks.length > 0 && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-amber)', marginBottom: 4 }}>
              Risks: {data.assessment.risks.join('; ')}
            </div>
          )}
          {Array.isArray(data.assessment.success_criteria) && data.assessment.success_criteria.length > 0 && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
              Success criteria: {data.assessment.success_criteria.join('; ')}
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 12 }}>No strategic assessment yet.</div>
      )}

      {data.strategies.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 6 }}>
            Candidate strategies
          </div>
          {data.strategies.map((s) => (
            <div key={s.id} style={{ padding: 8, marginBottom: 4, background: s.is_recommended ? 'rgba(59,130,246,0.08)' : 'var(--bp-surface-2)', borderRadius: 3, borderLeft: s.is_recommended ? '2px solid var(--bp-blue)' : 'none' }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text)', fontWeight: 600 }}>
                {s.name}{s.is_recommended && <span style={{ color: 'var(--bp-blue)', fontWeight: 400 }}> · recommended</span>}
              </div>
              {s.summary && <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginTop: 2 }}>{s.summary}</div>}
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
                {s.confidence != null && `${Math.round(s.confidence * 100)}% confidence`}
                {s.estimated_effort && ` · ${s.estimated_effort} effort`}
                {s.estimated_cost != null && ` · ~${s.estimated_cost} ${s.estimated_cost_unit ?? ''}`}
                {s.historical_sample_size > 0 && ` · ${Math.round((s.historical_success_rate ?? 0) * 100)}% historical success (n=${s.historical_sample_size})`}
              </div>
            </div>
          ))}
        </div>
      )}

      {data.timeline.length > 0 && (
        <div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 6 }}>
            Timeline
          </div>
          {data.timeline.map((e, i) => (
            e.type === 'gap' ? (
              <div key={i} style={{
                fontFamily: 'var(--bp-font-mono)', fontSize: 11, padding: '6px 8px', margin: '3px 0',
                display: 'flex', gap: 8, alignItems: 'flex-start',
                background: 'rgba(245, 158, 11, 0.08)', border: '1px dashed var(--bp-amber)', borderRadius: 3,
              }}>
                <span style={{ color: 'var(--bp-text-3)', flexShrink: 0 }}>{fmtRel(e.at)}</span>
                <span style={{ flex: 1, color: 'var(--bp-amber)' }}>
                  <strong>⚠ Gap{e.gap_type ? ` — ${GAP_LABELS[e.gap_type] ?? e.gap_type}` : ''}:</strong>{' '}
                  <span style={{ color: 'var(--bp-text-2)', fontWeight: 400 }}>{e.reason ?? e.summary}</span>
                </span>
              </div>
            ) : (
              <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', padding: '3px 0', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: 'var(--bp-text-3)', flexShrink: 0 }}>{fmtRel(e.at)}</span>
                <span style={{ flex: 1 }}>{e.summary}</span>
                {e.attribution && (
                  <span style={{
                    fontSize: 9, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.08em',
                    color: ATTRIBUTION_COLORS[e.attribution] ?? 'var(--bp-text-3)',
                    border: `1px solid ${ATTRIBUTION_COLORS[e.attribution] ?? 'var(--bp-text-3)'}`,
                    borderRadius: 3, padding: '1px 5px',
                  }}>
                    {ATTRIBUTION_LABELS[e.attribution] ?? e.attribution}
                  </span>
                )}
              </div>
            )
          ))}
        </div>
      )}
    </div>
  )
}

interface GoalFormProps {
  businessId: string
  initial?: Partial<Goal>
  onSaved: () => void
  onCancel: () => void
}

function GoalForm({ businessId, initial, onSaved, onCancel }: GoalFormProps) {
  const [form, setForm] = useState(() => ({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    metric_name: initial?.metric_name ?? '',
    metric_target: initial?.metric_target ?? '',
    metric_unit: initial?.metric_unit ?? '',
    deadline: (initial?.deadline as string | undefined)?.slice(0, 10) ?? '',
    assigned_agents: initial?.assigned_agents ?? [] as string[],
    strategy: initial?.strategy ?? '',
    tags: (initial as any)?.tags ?? [] as string[],
    owner: initial?.owner ?? '',
    confidence: initial?.confidence ?? '',
    priority: initial?.priority ?? 'p2',
  }))
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!form.title.trim()) return
    setSaving(true)
    try {
      const payload = {
        ...form,
        metric_target: form.metric_target ? Number(form.metric_target) : null,
        confidence: form.confidence !== '' ? Number(form.confidence) : null,
        owner: form.owner || null,
      }
      await createGoal(businessId, payload)
      onSaved()
    } finally { setSaving(false) }
  }

  function toggleAgent(a: string) {
    setForm(p => ({
      ...p,
      assigned_agents: p.assigned_agents.includes(a)
        ? p.assigned_agents.filter((x: string) => x !== a)
        : [...p.assigned_agents, a],
    }))
  }

  return (
    <div className="bp-card" style={{ padding: 20, marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 12 }}>
        New Goal
      </div>
      <input className="bp-input" placeholder="Goal title" style={{ width: '100%', fontSize: 14, fontWeight: 600, marginBottom: 8 }}
        value={form.title} onChange={(e) => setForm(p => ({ ...p, title: e.target.value }))} />
      <textarea className="bp-input" placeholder="Description" rows={2} style={{ width: '100%', fontSize: 11, marginBottom: 10 }}
        value={form.description} onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))} />
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
        <select className="bp-input" style={{ fontSize: 11 }}
          value={form.metric_name} onChange={(e) => setForm(p => ({ ...p, metric_name: e.target.value }))}>
          <option value="">Target metric…</option>
          {METRIC_OPTIONS.map(g => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map(o => <option key={o} value={o}>{o}</option>)}
            </optgroup>
          ))}
        </select>
        <input className="bp-input" placeholder="Target value" type="number" style={{ fontSize: 11 }}
          value={form.metric_target as string | number} onChange={(e) => setForm(p => ({ ...p, metric_target: e.target.value }))} />
        <input className="bp-input" type="date" style={{ fontSize: 11 }}
          value={form.deadline} onChange={(e) => setForm(p => ({ ...p, deadline: e.target.value }))} />
      </div>
      <textarea className="bp-input" placeholder="Strategy — how should agents approach this?" rows={2} style={{ width: '100%', fontSize: 11, marginBottom: 10 }}
        value={form.strategy} onChange={(e) => setForm(p => ({ ...p, strategy: e.target.value }))} />
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
        <input className="bp-input" placeholder="Owner (e.g. human:chris)" style={{ fontSize: 11 }}
          value={form.owner} onChange={(e) => setForm(p => ({ ...p, owner: e.target.value }))} />
        <input className="bp-input" placeholder="Confidence (0-1)" type="number" min={0} max={1} step={0.05} style={{ fontSize: 11 }}
          value={form.confidence as string | number} onChange={(e) => setForm(p => ({ ...p, confidence: e.target.value }))} />
        <select className="bp-input" style={{ fontSize: 11 }}
          value={form.priority} onChange={(e) => setForm(p => ({ ...p, priority: e.target.value }))}>
          {Object.entries(PRIORITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 6 }}>Assigned agents</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 14 }}>
        {AGENTS.map(a => (
          <button key={a} onClick={() => toggleAgent(a)}
            className={`bp-pill ${form.assigned_agents.includes(a) ? 'bp-pill-blue' : 'bp-pill-grey'}`}
            style={{ cursor: 'pointer', background: 'none', border: form.assigned_agents.includes(a) ? undefined : '1px solid var(--bp-border)' }}>
            {a}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleSave} disabled={saving || !form.title.trim()} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
          {saving ? 'Saving…' : 'Save goal'}
        </button>
        <button onClick={onCancel} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>Cancel</button>
      </div>
    </div>
  )
}

function SuggestionCard({ suggestion, businessId, onRefresh }: { suggestion: Suggestion; businessId: string; onRefresh: () => void }) {
  const [working, setWorking] = useState(false)
  async function handle(fn: () => Promise<unknown>) { setWorking(true); try { await fn(); await onRefresh() } finally { setWorking(false) } }

  const val = suggestion.opportunity_value
  const unit = suggestion.opportunity_unit?.startsWith('gbp') ? '£'
             : suggestion.opportunity_unit?.startsWith('usd') ? '$' : ''
  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 10, borderLeft: '3px solid var(--bp-purple)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <Sparkles size={14} style={{ color: 'var(--bp-purple)', marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)' }}>
            {suggestion.title}
          </div>
          {suggestion.description && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginTop: 4 }}>
              {suggestion.description}
            </div>
          )}
        </div>
        {val != null && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              Opportunity
            </div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 16, color: 'var(--bp-purple)' }}>
              {unit}{Math.round(val).toLocaleString()}
              <span style={{ fontSize: 10, color: 'var(--bp-text-3)', fontWeight: 400 }}>/mo</span>
            </div>
          </div>
        )}
      </div>
      {suggestion.barrier && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 6 }}>
          <strong style={{ color: 'var(--bp-text-2)' }}>Barrier:</strong> {suggestion.barrier}
        </div>
      )}
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 10 }}>
        {suggestion.metric_name} · {suggestion.current_value} → {suggestion.target_value}
        {suggestion.confidence != null && <> · {Math.round(suggestion.confidence * 100)}% confidence</>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => handle(() => acceptGoalSuggestion(businessId, suggestion.id))} disabled={working} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
          <Check size={11} /> Set this goal
        </button>
        <button onClick={() => handle(() => dismissGoalSuggestion(businessId, suggestion.id, prompt('Reason?') ?? ''))} disabled={working} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
          <X size={11} /> Dismiss
        </button>
        <button onClick={() => handle(() => snoozeGoalSuggestion(businessId, suggestion.id, 30))} disabled={working} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
          Snooze 30d
        </button>
      </div>
    </div>
  )
}

export default function Goals() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [goals, setGoals] = useState<Goal[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [showForm, setShowForm] = useState(false)
  const [proposed, setProposed] = useState<Goal | null>(null)
  const [tab, setTab] = useState('active')
  const [scanning, setScanning] = useState(false)

  const fetchGoals = useCallback(async () => {
    if (!currentBusiness) return
    setGoals(await getGoals(currentBusiness.id) ?? [])
    try {
      const { suggestions } = await getGoalSuggestions(currentBusiness.id) ?? {}
      setSuggestions(suggestions || [])
    } catch { setSuggestions([]) }
  }, [currentBusiness])

  useEffect(() => { fetchGoals() }, [fetchGoals])

  async function handleScan() {
    setScanning(true)
    try { await runGoalSuggestionScan(currentBusiness!.id); await fetchGoals() }
    finally { setScanning(false) }
  }

  async function handleAskAI() {
    const context = prompt('What do you want to achieve?')
    if (!context) return
    try {
      const { proposed } = await proposeGoal(currentBusiness!.id, context)
      if (proposed) setProposed(proposed)
    } catch (err: any) {
      alert(`Failed: ${err.message}`)
    }
  }

  async function handleSaveProposed() {
    await createGoal(currentBusiness!.id, proposed)
    setProposed(null)
    fetchGoals()
  }

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>GOALS</h1>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
            What Blueprint is actively working toward
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleAskAI} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
            <Sparkles size={11} /> Ask AI to set a goal
          </button>
          <button onClick={() => setShowForm(true)} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
            <Plus size={11} /> New goal
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid var(--bp-border)', paddingBottom: 10 }}>
        {[
          { id: 'active', label: `Active (${goals.filter((g) => g.status === 'active').length})` },
          { id: 'suggested', label: `Suggested (${suggestions.length})` },
          { id: 'achieved', label: `Achieved (${goals.filter((g) => g.status === 'achieved').length})` },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`bp-pill ${tab === t.id ? 'bp-pill-blue' : 'bp-pill-grey'}`}
            style={{ cursor: 'pointer', background: 'none', border: tab === t.id ? undefined : '1px solid var(--bp-border)' }}>
            {t.label}
          </button>
        ))}
        {tab === 'suggested' && (
          <button onClick={handleScan} disabled={scanning} className="bp-btn bp-btn-secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
            <RefreshCw size={11} /> {scanning ? 'Scanning…' : 'Scan for opportunities'}
          </button>
        )}
      </div>

      {showForm && (
        <GoalForm
          businessId={currentBusiness.id}
          onSaved={() => { setShowForm(false); fetchGoals() }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {proposed && (
        <div className="bp-card" style={{ padding: 20, marginBottom: 14, borderLeft: '3px solid var(--bp-purple)' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-purple)', textTransform: 'uppercase', marginBottom: 10 }}>
            ✨ AI-proposed goal
          </div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{proposed.title}</div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 10 }}>{proposed.description}</div>
          <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', marginBottom: 10 }}>
{JSON.stringify({
  metric: proposed.metric_name,
  target: proposed.metric_target,
  deadline: proposed.deadline,
  assigned_agents: proposed.assigned_agents,
}, null, 2)}
          </pre>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleSaveProposed} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
              <Check size={11} /> Accept and save
            </button>
            <button onClick={() => setProposed(null)} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
              <X size={11} /> Discard
            </button>
          </div>
        </div>
      )}

      {tab === 'suggested' ? (
        suggestions.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
            No suggestions yet. Click "Scan for opportunities" to check your business data.
          </div>
        ) : (
          suggestions.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} businessId={currentBusiness.id} onRefresh={fetchGoals} />
          ))
        )
      ) : (() => {
        const filteredGoals = goals.filter((g) =>
          tab === 'active' ? g.status === 'active'
          : tab === 'achieved' ? g.status === 'achieved'
          : true)
        return filteredGoals.length === 0 && !showForm && !proposed ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
            No {tab} goals yet. Click "New goal" or ask AI to propose one.
          </div>
        ) : (
          filteredGoals.map((g) => <GoalCard key={g.id} goal={g} businessId={currentBusiness.id} onRefresh={fetchGoals} />)
        )
      })()}
    </div>
  )
}
