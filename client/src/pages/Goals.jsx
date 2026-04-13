import React, { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Target, Plus, Sparkles, Check, X, Pause, Edit2, RefreshCw } from 'lucide-react'
import useStore from '../lib/store.js'
import {
  getGoals, createGoal, updateGoal, deleteGoal, checkGoal, proposeGoal,
} from '../lib/api.js'

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

function fmtRel(iso) {
  if (!iso) return '—'
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '—' }
}

function daysUntil(iso) {
  if (!iso) return null
  return Math.ceil((new Date(iso) - new Date()) / 86400000)
}

function GoalCard({ goal, businessId, onRefresh }) {
  const pct = Math.round(goal.progress_pct ?? 0)
  const days = daysUntil(goal.deadline)
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

  const lastNote = goal.notes?.length > 0 ? goal.notes[goal.notes.length - 1] : null
  const milestones = Array.isArray(goal.milestones) ? goal.milestones : []

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
      </div>
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
        {goal.assigned_agents?.length > 0 && <span>Assigned: {goal.assigned_agents.join(', ')}</span>}
        {goal.last_checked && <span>Last checked: {fmtRel(goal.last_checked)}</span>}
      </div>
      {lastNote && (
        <div style={{ padding: 8, background: 'var(--bp-surface-2)', borderRadius: 3, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', fontStyle: 'italic', marginBottom: 10 }}>
          "{typeof lastNote === 'string' ? lastNote : lastNote.text}"
        </div>
      )}
      {milestones.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 6 }}>Milestones</div>
          {milestones.map((m, i) => {
            const done = pct >= (m.target_pct ?? 100)
            return (
              <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: done ? 'var(--bp-green)' : 'var(--bp-text-3)', padding: '2px 0' }}>
                {done ? '✅' : '○'} {m.title}
              </div>
            )
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleCheck} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
          <RefreshCw size={11} /> Check now
        </button>
        <button onClick={handlePause} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
          <Pause size={11} /> {goal.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  )
}

function GoalForm({ businessId, initial, onSaved, onCancel }) {
  const [form, setForm] = useState(() => ({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    metric_name: initial?.metric_name ?? '',
    metric_target: initial?.metric_target ?? '',
    metric_unit: initial?.metric_unit ?? '',
    deadline: initial?.deadline?.slice(0, 10) ?? '',
    assigned_agents: initial?.assigned_agents ?? [],
    strategy: initial?.strategy ?? '',
    tags: initial?.tags ?? [],
  }))
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!form.title.trim()) return
    setSaving(true)
    try {
      const payload = { ...form, metric_target: form.metric_target ? Number(form.metric_target) : null }
      await createGoal(businessId, payload)
      onSaved()
    } finally { setSaving(false) }
  }

  function toggleAgent(a) {
    setForm(p => ({
      ...p,
      assigned_agents: p.assigned_agents.includes(a)
        ? p.assigned_agents.filter(x => x !== a)
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
          value={form.metric_target} onChange={(e) => setForm(p => ({ ...p, metric_target: e.target.value }))} />
        <input className="bp-input" type="date" style={{ fontSize: 11 }}
          value={form.deadline} onChange={(e) => setForm(p => ({ ...p, deadline: e.target.value }))} />
      </div>
      <textarea className="bp-input" placeholder="Strategy — how should agents approach this?" rows={2} style={{ width: '100%', fontSize: 11, marginBottom: 10 }}
        value={form.strategy} onChange={(e) => setForm(p => ({ ...p, strategy: e.target.value }))} />
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

export default function Goals() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [goals, setGoals] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [proposed, setProposed] = useState(null)

  const fetchGoals = useCallback(async () => {
    if (!currentBusiness) return
    setGoals(await getGoals(currentBusiness.id) ?? [])
  }, [currentBusiness])

  useEffect(() => { fetchGoals() }, [fetchGoals])

  async function handleAskAI() {
    const context = prompt('What do you want to achieve?')
    if (!context) return
    try {
      const { proposed } = await proposeGoal(currentBusiness.id, context)
      if (proposed) setProposed(proposed)
    } catch (err) {
      alert(`Failed: ${err.message}`)
    }
  }

  async function handleSaveProposed() {
    await createGoal(currentBusiness.id, proposed)
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

      {goals.length === 0 && !showForm && !proposed ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
          No goals yet. Click "New goal" or ask AI to propose one.
        </div>
      ) : (
        goals.map((g) => <GoalCard key={g.id} goal={g} businessId={currentBusiness.id} onRefresh={fetchGoals} />)
      )}
    </div>
  )
}
