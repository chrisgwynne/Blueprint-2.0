import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import {
  GitBranch, Play, Edit2, Plus, Sparkles, Clock, Check, X,
  ArrowRight, Lock, PauseCircle, AlertCircle, Trash2,
} from 'lucide-react'
import useStore from '../lib/store'
import {
  getWorkflows, createWorkflow, updateWorkflow, runWorkflow,
  getWorkflowRuns, getWorkflowRun, approveWorkflowStep, rejectWorkflowStep,
  cancelWorkflowRun, proposeWorkflow, deleteWorkflow,
} from '../lib/api'

const AVAILABLE_AGENTS = [
  'conductor', 'seo-sentinel', 'quill', 'velocity', 'trend-spotter',
  'merchant', 'ledger', 'sentinel', 'researcher', 'reporter', 'dev', 'outreach',
]

interface WorkflowStep {
  index: number
  name: string
  agent_id: string
  task_template: string
  approval_gate: boolean
  approval_message: string
  timeout_minutes: number
}

interface Workflow {
  id: string
  name: string
  description?: string
  status?: string
  version?: string | number
  trigger_type?: string
  trigger_config?: Record<string, unknown>
  tags?: string[]
  steps?: WorkflowStep[]
  last_run_at?: string
  run_count?: number
  created_by?: string
}

interface WorkflowFormState {
  name: string
  description: string
  status: string
  trigger_type: string
  trigger_config: Record<string, unknown>
  tags: string[]
  steps: WorkflowStep[]
}

interface WorkflowRun {
  id: string
  workflow_name?: string
  status: string
  started_at?: string
  error?: string
}

interface WorkflowRunStep {
  id: string
  step_index: number
  step_name: string
  status: string
}

interface WorkflowRunDetail {
  steps?: WorkflowRunStep[]
}

function fmtRel(iso: string | undefined) {
  if (!iso) return '—'
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) } catch { return '—' }
}

interface StatusBadgeProps {
  status: string | undefined
}

function StatusBadge({ status }: StatusBadgeProps) {
  const cfg = ({
    active: { color: 'var(--bp-green)', label: 'ACTIVE' },
    draft: { color: 'var(--bp-amber)', label: 'DRAFT' },
    archived: { color: 'var(--bp-text-3)', label: 'ARCHIVED' },
    running: { color: 'var(--bp-blue)', label: 'RUNNING' },
    complete: { color: 'var(--bp-green)', label: 'COMPLETE' },
    paused: { color: 'var(--bp-amber)', label: 'PAUSED' },
    failed: { color: 'var(--bp-red)', label: 'FAILED' },
    cancelled: { color: 'var(--bp-text-3)', label: 'CANCELLED' },
  } as Record<string, { color: string; label: string }>)[status ?? ''] ?? { color: 'var(--bp-text-3)', label: status?.toUpperCase() ?? '' }
  return (
    <span style={{
      fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '2px 7px',
      borderRadius: 3, background: `${cfg.color}15`, color: cfg.color,
      border: `1px solid ${cfg.color}40`, letterSpacing: '0.08em',
    }}>{cfg.label}</span>
  )
}

// ─── Workflow card ────────────────────────────────────────────────────────────
interface WorkflowCardProps {
  workflow: Workflow
  onRun: (id: string) => Promise<void>
  onEdit: (w: Workflow) => void
  onDelete: (w: Workflow) => void
}

function WorkflowCard({ workflow, onRun, onEdit, onDelete }: WorkflowCardProps) {
  const [running, setRunning] = useState(false)

  const stepsPreview = workflow.steps?.map((s, i) => (
    <span key={s.index ?? i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ padding: '2px 8px', background: 'var(--bp-surface-2)', borderRadius: 3, fontSize: 10 }}>
        {s.agent_id}{s.approval_gate ? ' 🔐' : ''}
      </span>
      {i < (workflow.steps?.length ?? 0) - 1 && <ArrowRight size={10} style={{ color: 'var(--bp-text-3)' }} />}
    </span>
  ))

  async function handleRun() {
    setRunning(true)
    try { await onRun(workflow.id) } catch {}
    finally { setRunning(false) }
  }

  return (
    <div className="bp-card" style={{ padding: 18, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        {workflow.created_by === 'conductor' && (
          <span title="AI proposed" style={{ fontSize: 12 }}>✨</span>
        )}
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 15, color: 'var(--bp-text)' }}>
          {workflow.name}
        </div>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>v{workflow.version}</span>
        <div style={{ flex: 1 }} />
        <StatusBadge status={workflow.status} />
      </div>
      {workflow.description && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 10 }}>
          {workflow.description}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', fontFamily: 'var(--bp-font-mono)', marginBottom: 10 }}>
        {stepsPreview}
      </div>
      <div style={{ display: 'flex', gap: 12, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 10 }}>
        <span>Last run: {fmtRel(workflow.last_run_at)}</span>
        <span>Ran {workflow.run_count} time{workflow.run_count !== 1 ? 's' : ''}</span>
        {workflow.tags && workflow.tags.length > 0 && (
          <span>Tags: {workflow.tags.map((t) => `[${t}]`).join(' ')}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleRun} disabled={running} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
          <Play size={11} /> {running ? 'Starting…' : 'Run'}
        </button>
        <button onClick={() => onEdit(workflow)} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
          <Edit2 size={11} /> Edit
        </button>
        <button onClick={() => onDelete(workflow)} className="bp-btn bp-btn-ghost" style={{ fontSize: 11, color: 'var(--bp-red)' }}>
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

// ─── Run card ─────────────────────────────────────────────────────────────────
interface RunCardProps {
  run: WorkflowRun
  businessId: string
  onRefresh: () => Promise<void>
}

function RunCard({ run, businessId, onRefresh }: RunCardProps) {
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null)
  const [acting, setActing] = useState<number | null>(null)

  useEffect(() => {
    getWorkflowRun(businessId, run.id).then((d) => setDetail(d as WorkflowRunDetail)).catch(() => {})
  }, [businessId, run.id, run.status])

  async function handleApprove(stepIndex: number) {
    setActing(stepIndex)
    try {
      await approveWorkflowStep(businessId, run.id, stepIndex)
      await onRefresh()
    } finally { setActing(null) }
  }
  async function handleReject(stepIndex: number) {
    const reason = prompt('Reason for rejection?') || 'Rejected by user'
    setActing(stepIndex)
    try {
      await rejectWorkflowStep(businessId, run.id, stepIndex, { reason })
      await onRefresh()
    } finally { setActing(null) }
  }
  async function handleCancel() {
    if (!confirm('Cancel this workflow run?')) return
    await cancelWorkflowRun(businessId, run.id)
    await onRefresh()
  }

  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13, color: 'var(--bp-text)' }}>
          {run.workflow_name}
        </div>
        <StatusBadge status={run.status} />
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
          started {fmtRel(run.started_at)}
        </span>
      </div>

      {detail?.steps?.map((s) => (
        <div key={s.id} style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0',
          borderBottom: '1px solid var(--bp-border)', fontFamily: 'var(--bp-font-mono)', fontSize: 11,
        }}>
          <span style={{ minWidth: 70, color: 'var(--bp-text-3)' }}>Step {s.step_index + 1}:</span>
          <span style={{ flex: 1, color: 'var(--bp-text)' }}>{s.step_name}</span>
          <span style={{
            fontSize: 10,
            color:
              s.status === 'complete' ? 'var(--bp-green)' :
              s.status === 'awaiting_approval' ? 'var(--bp-amber)' :
              s.status === 'failed' ? 'var(--bp-red)' :
              s.status === 'running' ? 'var(--bp-blue)' : 'var(--bp-text-3)',
          }}>
            {s.status === 'complete' && '✅ complete'}
            {s.status === 'running' && '● running'}
            {s.status === 'pending' && '○ pending'}
            {s.status === 'awaiting_approval' && '🔐 awaiting approval'}
            {s.status === 'failed' && '✗ failed'}
            {s.status === 'skipped' && 'skipped'}
          </span>
          {s.status === 'awaiting_approval' && (
            <>
              <button onClick={() => handleApprove(s.step_index)} disabled={acting !== null} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--bp-green)' }}>
                <Check size={10} /> Approve
              </button>
              <button onClick={() => handleReject(s.step_index)} disabled={acting !== null} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--bp-red)' }}>
                <X size={10} /> Reject
              </button>
            </>
          )}
        </div>
      ))}

      {(run.status === 'running' || run.status === 'paused') && (
        <div style={{ marginTop: 10 }}>
          <button onClick={handleCancel} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}>
            Cancel run
          </button>
        </div>
      )}
      {run.error && (
        <div style={{ marginTop: 10, padding: 8, background: 'rgba(255,82,82,0.08)', borderRadius: 3, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)' }}>
          {run.error}
        </div>
      )}
    </div>
  )
}

// ─── Simple workflow editor ──────────────────────────────────────────────────
interface WorkflowEditorProps {
  businessId: string
  workflow: Workflow | null
  onSaved: () => void
  onCancel: () => void
}

function WorkflowEditor({ businessId, workflow, onSaved, onCancel }: WorkflowEditorProps) {
  const [form, setForm] = useState<WorkflowFormState>(() => ({
    name: workflow?.name ?? '',
    description: workflow?.description ?? '',
    status: workflow?.status ?? 'active',
    trigger_type: workflow?.trigger_type ?? 'manual',
    trigger_config: workflow?.trigger_config ?? {},
    tags: workflow?.tags ?? [],
    steps: workflow?.steps && workflow.steps.length > 0 ? workflow.steps : [
      { index: 0, name: 'Step 1', agent_id: 'conductor', task_template: '', approval_gate: false, approval_message: '', timeout_minutes: 30 },
    ],
  }))
  const [saving, setSaving] = useState(false)

  function updateStep(i: number, patch: Partial<WorkflowStep>) {
    setForm(prev => ({
      ...prev,
      steps: prev.steps.map((s, idx) => idx === i ? { ...s, ...patch } : s),
    }))
  }
  function addStep() {
    setForm(prev => ({
      ...prev,
      steps: [...prev.steps, {
        index: prev.steps.length, name: `Step ${prev.steps.length + 1}`,
        agent_id: 'conductor', task_template: '', approval_gate: false,
        approval_message: '', timeout_minutes: 30,
      }],
    }))
  }
  function removeStep(i: number) {
    setForm(prev => ({
      ...prev,
      steps: prev.steps.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, index: idx })),
    }))
  }

  async function handleSave() {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      if (workflow?.id) {
        await updateWorkflow(businessId, workflow.id, form)
      } else {
        await createWorkflow(businessId, form)
      }
      onSaved()
    } finally { setSaving(false) }
  }

  return (
    <div className="bp-card" style={{ padding: 20, marginBottom: 12 }}>
      <div style={{
        fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em',
        color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 12,
      }}>{workflow?.id ? 'Edit Workflow' : 'New Workflow'}</div>

      <input
        className="bp-input" style={{ width: '100%', marginBottom: 10, fontSize: 14, fontWeight: 600 }}
        placeholder="Workflow name"
        value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))}
      />
      <textarea
        className="bp-input" style={{ width: '100%', marginBottom: 12, fontSize: 11 }}
        placeholder="Description (what does this workflow do?)"
        rows={2}
        value={form.description} onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))}
      />

      <div style={{
        fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em',
        color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 8,
      }}>Steps</div>

      {form.steps.map((step, i) => (
        <div key={i} style={{
          padding: 12, marginBottom: 10,
          background: 'var(--bp-surface-2)', borderRadius: 4,
          border: '1px solid var(--bp-border)',
        }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', minWidth: 40 }}>
              Step {i + 1}
            </span>
            <input className="bp-input" placeholder="Step name" style={{ flex: 1, fontSize: 12 }}
              value={step.name} onChange={(e) => updateStep(i, { name: e.target.value })} />
            <select className="bp-input" style={{ fontSize: 11 }}
              value={step.agent_id} onChange={(e) => updateStep(i, { agent_id: e.target.value })}>
              {AVAILABLE_AGENTS.map(a => <option key={a}>{a}</option>)}
            </select>
            <button onClick={() => removeStep(i)} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}>
              <X size={10} />
            </button>
          </div>
          <textarea className="bp-input" placeholder="Task template — what this step should do"
            rows={3} style={{ width: '100%', fontSize: 11, marginBottom: 8 }}
            value={step.task_template} onChange={(e) => updateStep(i, { task_template: e.target.value })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
            <input type="checkbox" checked={!!step.approval_gate}
              onChange={(e) => updateStep(i, { approval_gate: e.target.checked })} />
            Approval gate before next step
          </label>
          {step.approval_gate && (
            <input className="bp-input" placeholder="Approval message" style={{ width: '100%', fontSize: 11, marginTop: 6 }}
              value={step.approval_message} onChange={(e) => updateStep(i, { approval_message: e.target.value })} />
          )}
        </div>
      ))}

      <button onClick={addStep} className="bp-btn bp-btn-ghost" style={{ fontSize: 11, marginBottom: 14 }}>
        <Plus size={11} /> Add step
      </button>

      <div style={{ display: 'flex', gap: 6, paddingTop: 10, borderTop: '1px solid var(--bp-border)' }}>
        <button onClick={handleSave} disabled={saving || !form.name.trim()} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
          {saving ? 'Saving…' : 'Save workflow'}
        </button>
        <button onClick={onCancel} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>Cancel</button>
      </div>
    </div>
  )
}

// ─── Ask AI modal ─────────────────────────────────────────────────────────────
interface AskAIModalProps {
  businessId: string
  onClose: () => void
  onSaved: (workflow: Workflow) => Promise<void>
}

function AskAIModal({ businessId, onClose, onSaved }: AskAIModalProps) {
  const [text, setText] = useState('')
  const [generating, setGenerating] = useState(false)

  async function handleGenerate() {
    if (!text.trim()) return
    setGenerating(true)
    try {
      const result = await proposeWorkflow(businessId, text) as { workflow: Workflow }
      await onSaved(result.workflow)
      onClose()
    } catch (err) {
      const e = err as Error
      alert(`Failed: ${e.message}`)
    } finally { setGenerating(false) }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }} onClick={onClose}>
      <div className="bp-card" style={{ width: 500, padding: 24 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
          ✨ Ask AI to propose a workflow
        </div>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 14 }}>
          Describe what you want to achieve. Conductor will propose a draft.
        </div>
        <textarea className="bp-input"
          placeholder="e.g. I want to improve our GSC rankings on top product pages"
          rows={5} style={{ width: '100%', fontSize: 12, marginBottom: 12 }}
          value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>Cancel</button>
          <button onClick={handleGenerate} disabled={generating || !text.trim()} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
            <Sparkles size={11} /> {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Workflows() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [tab, setTab] = useState('templates')
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [editing, setEditing] = useState<Workflow | Record<string, never> | null>(null)  // workflow or {} for new
  const [askOpen, setAskOpen] = useState(false)

  const fetchAll = useCallback(async () => {
    if (!currentBusiness) return
    const [wfs, rs] = await Promise.all([
      getWorkflows(currentBusiness.id),
      getWorkflowRuns(currentBusiness.id),
    ])
    setWorkflows((wfs ?? []) as Workflow[])
    setRuns((rs ?? []) as WorkflowRun[])
  }, [currentBusiness])

  useEffect(() => {
    fetchAll()
    const poll = setInterval(fetchAll, 5000)
    return () => clearInterval(poll)
  }, [fetchAll])

  async function handleRun(id: string) {
    await runWorkflow(currentBusiness!.id, id, { reason: 'Manual run' })
    setTimeout(fetchAll, 500)
    setTab('runs')
  }

  async function handleDelete(workflow: Workflow) {
    if (!confirm(`Archive workflow "${workflow.name}"?`)) return
    await deleteWorkflow(currentBusiness!.id, workflow.id)
    fetchAll()
  }

  if (!currentBusiness) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>WORKFLOWS</h1>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Reusable multi-step agent pipelines
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setAskOpen(true)} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
            <Sparkles size={11} /> Ask AI
          </button>
          <button onClick={() => setEditing({})} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
            <Plus size={11} /> New workflow
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--bp-border)', marginBottom: 20 }}>
        {['templates', 'runs', 'history'].map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '10px 20px', background: 'transparent', border: 'none',
              borderBottom: `2px solid ${tab === t ? 'var(--bp-blue)' : 'transparent'}`,
              marginBottom: -1, cursor: 'pointer',
              fontFamily: 'var(--bp-font-mono)', fontSize: 11,
              color: tab === t ? 'var(--bp-blue)' : 'var(--bp-text-3)',
              textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: tab === t ? 700 : 500,
            }}>{t} {t === 'templates' && `(${workflows.length})`}{t === 'runs' && ` (${runs.filter(r => r.status === 'running' || r.status === 'paused').length})`}</button>
        ))}
      </div>

      {editing && (
        <WorkflowEditor
          businessId={currentBusiness.id}
          workflow={(editing as Workflow).id ? editing as Workflow : null}
          onSaved={() => { setEditing(null); fetchAll() }}
          onCancel={() => setEditing(null)}
        />
      )}

      {tab === 'templates' && (
        <>
          {workflows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
              No workflows yet. Built-ins seed automatically when the server starts.
            </div>
          ) : (
            workflows.map((w) => (
              <WorkflowCard key={w.id} workflow={w} onRun={handleRun} onEdit={setEditing} onDelete={handleDelete} />
            ))
          )}
        </>
      )}

      {tab === 'runs' && (
        <>
          {runs.filter(r => r.status === 'running' || r.status === 'paused').length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
              No workflows currently running.
            </div>
          ) : (
            runs.filter(r => r.status === 'running' || r.status === 'paused').map((r) => (
              <RunCard key={r.id} run={r} businessId={currentBusiness.id} onRefresh={fetchAll} />
            ))
          )}
        </>
      )}

      {tab === 'history' && (
        <>
          {runs.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
              No runs yet.
            </div>
          ) : (
            runs.map((r) => (
              <RunCard key={r.id} run={r} businessId={currentBusiness.id} onRefresh={fetchAll} />
            ))
          )}
        </>
      )}

      {askOpen && (
        <AskAIModal
          businessId={currentBusiness.id}
          onClose={() => setAskOpen(false)}
          onSaved={async () => { await fetchAll() }}
        />
      )}
    </div>
  )
}
