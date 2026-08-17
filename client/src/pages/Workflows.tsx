import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import {
  GitBranch, Play, Edit2, Plus, Sparkles, Clock, Check, X,
  ArrowRight, Lock, PauseCircle, AlertCircle, Trash2, Eye, RotateCcw, ShieldCheck,
} from 'lucide-react'
import useStore from '../lib/store'
import {
  getWorkflows, createWorkflow, updateWorkflow, runWorkflow,
  getWorkflowRuns, getWorkflowRun, approveWorkflowStep, rejectWorkflowStep,
  cancelWorkflowRun, proposeWorkflow, deleteWorkflow,
  getPlaybookVersions, createPlaybookDraft, validatePlaybookVersion,
  activatePlaybookVersion, rollbackPlaybookVersion, simulatePlaybook,
  startPlaybookRun, getPlaybookRun, approvePlaybookStep, rejectPlaybookStep,
  retryPlaybookStep, rollbackPlaybookRun, cancelPlaybookRun,
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
  workflow_id?: string
  workflow_name?: string
  status: string
  started_at?: string
  error?: string
  /** Present only on runs bound to a playbook version (#74). */
  playbook_version?: number | null
  stopped_reason?: string | null
  rollback_state?: string | null
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

// ─── Playbook types (#74) ─────────────────────────────────────────────────────

interface PlaybookViolation {
  code: string
  field: string
  message: string
}

interface PlaybookVersion {
  id: string
  version: number
  state: 'draft' | 'scheduled' | 'active' | 'superseded' | 'archived'
  validation_state: 'unvalidated' | 'valid' | 'invalid'
  validation_violations: PlaybookViolation[]
  source: string
  change_reason?: string | null
  created_by: string
  created_at: string
  rolled_back_from_version?: number | null
  definition: { name: string; description?: string | null; steps: unknown[] }
}

interface SimulatedStep {
  index: number
  name: string
  kind: 'action' | 'manual'
  action_type: string | null
  would_run: boolean
  would_not_run_reason: string | null
  resolved_input: unknown
  deferred_references: string[]
  input_valid: boolean
  input_issues: string[]
  output_schema_declared: boolean
  risk_level: string | null
  risk_tier: string | null
  requires_approval: boolean
  approval_explanation: string | null
  side_effect_classification: string | null
  timeout_seconds: number
  max_attempts: number
  on_failure: string
  missing_connector_types: string[]
  required_permissions: string[]
  supports_rollback: boolean
  rollback_note: string
  produces_receipt: boolean
  execution_route: string
  blocking_issues: string[]
}

interface PlaybookSimulation {
  definition_valid: boolean
  violations: PlaybookViolation[]
  input_violations: PlaybookViolation[]
  steps: SimulatedStep[]
  approval_points: number[]
  would_complete_without_human: boolean
  side_effects_performed: string
  summary: Record<string, number>
}

interface PlaybookRunStepDetail {
  id: string
  step_index: number
  step_name: string
  status: string
  step_kind?: string | null
  action_type?: string | null
  risk_tier?: string | null
  approval_reason?: string | null
  attempt_count?: number
  max_attempts?: number
  timeout_seconds?: number | null
  error?: string | null
  rollback_status?: string | null
  rollback_detail?: string | null
  resolved_input?: unknown
  typed_output?: unknown
  receipt?: {
    state: string | null
    result_status: string | null
    external_id: string | null
    external_permalink: string | null
    correlation_key: string | null
    verdict: string
    reason: string
  } | null
  definition?: { kind: string; action_type: string | null; on_failure: string } | null
}

interface PlaybookRunDetail {
  run: WorkflowRun & { inputs?: Record<string, unknown>; rollback_report?: unknown }
  playbook: { version: number; name: string; state: string } | null
  steps: PlaybookRunStepDetail[]
  receipt_summary: { aggregate_state: string; verification_failed: boolean }
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
  onOpenPlaybook: (w: Workflow) => void
}

function WorkflowCard({ workflow, onRun, onEdit, onDelete, onOpenPlaybook }: WorkflowCardProps) {
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
        <button onClick={() => onOpenPlaybook(workflow)} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}
          title="Versioned, bounded playbook: draft → validate → activate, simulate, and run with typed inputs">
          <ShieldCheck size={11} /> Playbook
        </button>
        <button onClick={() => onDelete(workflow)} className="bp-btn bp-btn-ghost" style={{ fontSize: 11, color: 'var(--bp-red)' }}>
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

// ─── Playbook panel (#74) ─────────────────────────────────────────────────────
//
// The lifecycle surface for one workflow's playbook: its version history
// (draft → validated → active → superseded), a preview that provably runs
// nothing, and a bounded run with typed inputs.

const MONO = 'var(--bp-font-mono)'

function VersionStateBadge({ version }: { version: PlaybookVersion }) {
  const cfg = ({
    active: { color: 'var(--bp-green)', label: 'ACTIVE' },
    draft: { color: 'var(--bp-amber)', label: 'DRAFT' },
    scheduled: { color: 'var(--bp-blue)', label: 'SCHEDULED' },
    superseded: { color: 'var(--bp-text-3)', label: 'SUPERSEDED' },
    archived: { color: 'var(--bp-text-3)', label: 'ARCHIVED' },
  } as Record<string, { color: string; label: string }>)[version.state]
    ?? { color: 'var(--bp-text-3)', label: version.state.toUpperCase() }
  return (
    <span style={{
      fontFamily: MONO, fontSize: 9, padding: '2px 7px', borderRadius: 3,
      background: `${cfg.color}15`, color: cfg.color, border: `1px solid ${cfg.color}40`, letterSpacing: '0.08em',
    }}>{cfg.label}</span>
  )
}

function RiskPill({ tier }: { tier: string | null | undefined }) {
  if (!tier) return null
  const color = ({
    green: 'var(--bp-green)', yellow: 'var(--bp-amber)',
    orange: 'var(--bp-amber)', red: 'var(--bp-red)',
  } as Record<string, string>)[tier] ?? 'var(--bp-text-3)'
  return (
    <span style={{ fontFamily: MONO, fontSize: 9, color, border: `1px solid ${color}40`, borderRadius: 3, padding: '1px 5px' }}>
      {tier.toUpperCase()}
    </span>
  )
}

interface PlaybookPanelProps {
  businessId: string
  workflow: Workflow
  onClose: () => void
  onRunStarted: () => void
}

function PlaybookPanel({ businessId, workflow, onClose, onRunStarted }: PlaybookPanelProps) {
  const [versions, setVersions] = useState<PlaybookVersion[]>([])
  const [active, setActive] = useState<PlaybookVersion | null>(null)
  const [draftJson, setDraftJson] = useState('')
  const [inputsJson, setInputsJson] = useState('{}')
  const [simulation, setSimulation] = useState<PlaybookSimulation | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await getPlaybookVersions(businessId, workflow.id) as { versions: PlaybookVersion[]; active: PlaybookVersion | null }
      setVersions(result.versions ?? [])
      setActive(result.active ?? null)
      if (!draftJson) {
        const seed = result.active ?? result.versions?.[0]
        setDraftJson(JSON.stringify(seed?.definition ?? {
          name: workflow.name,
          business_scope: { business_id: businessId, business_types: [] },
          inputs: { type: 'object', required: [], properties: {} },
          steps: [{
            index: 0, name: 'Step 1', kind: 'manual', agent_id: 'conductor',
            task_template: 'What this step should do', timeout_seconds: 900, max_attempts: 1, on_failure: 'stop',
          }],
        }, null, 2))
      }
    } catch (err) { setMessage((err as Error).message) }
  }, [businessId, workflow.id, workflow.name, draftJson])

  useEffect(() => { load() }, [businessId, workflow.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function guard(label: string, fn: () => Promise<unknown>) {
    setBusy(true); setMessage(null)
    try {
      await fn()
      setMessage(`${label} succeeded.`)
      await load()
    } catch (err) {
      setMessage(`${label} failed: ${(err as Error).message}`)
    } finally { setBusy(false) }
  }

  function parseOr(json: string, fallback: unknown): unknown {
    try { return JSON.parse(json) } catch { return fallback }
  }

  async function handleSaveDraft() {
    await guard('Save draft', async () => {
      const result = await createPlaybookDraft(businessId, workflow.id, {
        definition: JSON.parse(draftJson), validate: true,
      }) as { version: PlaybookVersion }
      if (result.version.validation_state === 'invalid') {
        throw new Error(result.version.validation_violations.map((v) => `${v.field}: ${v.message}`).join(' | '))
      }
    })
  }

  async function handleSimulate() {
    setBusy(true); setMessage(null); setSimulation(null)
    try {
      const result = await simulatePlaybook(businessId, workflow.id, {
        definition: parseOr(draftJson, undefined),
        inputs: parseOr(inputsJson, {}),
      }) as PlaybookSimulation
      setSimulation(result)
    } catch (err) { setMessage(`Simulation failed: ${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  async function handleRun() {
    await guard('Start run', async () => {
      await startPlaybookRun(businessId, workflow.id, { inputs: parseOr(inputsJson, {}) })
      onRunStarted()
    })
  }

  const label = { fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase' as const, marginBottom: 6 }

  return (
    <div className="bp-card" style={{ padding: 20, marginBottom: 12, borderLeft: '2px solid var(--bp-blue)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <GitBranch size={13} style={{ color: 'var(--bp-blue)' }} />
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14 }}>
          Playbook — {workflow.name}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>
          {active ? `active v${active.version}` : 'no active version'}
        </span>
        <button onClick={onClose} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}><X size={10} /></button>
      </div>

      {message && (
        <div style={{
          marginBottom: 12, padding: 8, borderRadius: 3, fontFamily: MONO, fontSize: 10,
          background: message.includes('failed') ? 'rgba(255,82,82,0.08)' : 'rgba(80,200,120,0.08)',
          color: message.includes('failed') ? 'var(--bp-red)' : 'var(--bp-green)',
        }}>{message}</div>
      )}

      {/* ── Version history ── */}
      <div style={label}>Version lifecycle</div>
      {versions.length === 0 ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 14 }}>
          No playbook versions yet. Save a draft below, then validate and activate it.
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          {versions.map((v) => (
            <div key={v.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
              borderBottom: '1px solid var(--bp-border)', fontFamily: MONO, fontSize: 11,
            }}>
              <span style={{ minWidth: 34, color: 'var(--bp-text-3)' }}>v{v.version}</span>
              <VersionStateBadge version={v} />
              <span style={{
                fontSize: 10,
                color: v.validation_state === 'valid' ? 'var(--bp-green)'
                  : v.validation_state === 'invalid' ? 'var(--bp-red)' : 'var(--bp-text-3)',
              }}>
                {v.validation_state === 'valid' ? '✓ valid'
                  : v.validation_state === 'invalid' ? `✗ ${v.validation_violations.length} problem(s)` : '— unvalidated'}
              </span>
              <span style={{ flex: 1, color: 'var(--bp-text-3)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {v.source === 'rollback' ? `rollback of v${v.rolled_back_from_version} · ` : ''}
                {v.change_reason ?? v.definition?.name ?? ''}
              </span>
              <button disabled={busy} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}
                onClick={() => guard(`Validate v${v.version}`, () => validatePlaybookVersion(businessId, workflow.id, v.version))}>
                Validate
              </button>
              {(v.state === 'draft' || v.state === 'scheduled') && (
                <button disabled={busy} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, color: 'var(--bp-green)' }}
                  onClick={() => guard(`Activate v${v.version}`, () => activatePlaybookVersion(businessId, workflow.id, v.version))}>
                  Activate
                </button>
              )}
              {v.state === 'superseded' && (
                <button disabled={busy} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}
                  onClick={() => guard(`Roll back to v${v.version}`, () => rollbackPlaybookVersion(businessId, workflow.id, { to_version: v.version }))}>
                  Roll back to
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Definition editor ── */}
      <div style={label}>Definition (JSON)</div>
      <textarea className="bp-input" rows={10} spellCheck={false}
        style={{ width: '100%', fontFamily: MONO, fontSize: 10, marginBottom: 8 }}
        value={draftJson} onChange={(e) => setDraftJson(e.target.value)} />

      <div style={label}>Run inputs (JSON)</div>
      <textarea className="bp-input" rows={3} spellCheck={false}
        style={{ width: '100%', fontFamily: MONO, fontSize: 10, marginBottom: 10 }}
        value={inputsJson} onChange={(e) => setInputsJson(e.target.value)} />

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={handleSaveDraft} disabled={busy} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
          <Plus size={11} /> Save as new draft
        </button>
        <button onClick={handleSimulate} disabled={busy} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
          <Eye size={11} /> Simulate (no side effects)
        </button>
        <button onClick={handleRun} disabled={busy || !active} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}
          title={active ? `Run active v${active.version}` : 'Activate a version before running'}>
          <Play size={11} /> Run active version
        </button>
      </div>

      {/* ── Simulation result ── */}
      {simulation && (
        <div style={{ borderTop: '1px solid var(--bp-border)', paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{ ...label, marginBottom: 0 }}>Preview</div>
            <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-green)', border: '1px solid var(--bp-green)40', borderRadius: 3, padding: '1px 5px' }}>
              SIDE EFFECTS: {simulation.side_effects_performed.toUpperCase()}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>
              {simulation.approval_points.length} approval point(s)
              {simulation.would_complete_without_human ? ' · would complete unattended' : ''}
            </span>
          </div>

          {[...simulation.violations, ...simulation.input_violations].map((v, i) => (
            <div key={i} style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-red)', marginBottom: 3 }}>
              ✗ {v.field}: {v.message}
            </div>
          ))}

          {simulation.steps.map((step) => (
            <div key={step.index} style={{
              padding: 10, marginTop: 8, borderRadius: 4, border: '1px solid var(--bp-border)',
              background: step.would_run ? 'var(--bp-surface-2)' : 'transparent',
              opacity: step.would_run ? 1 : 0.55,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 11 }}>
                <span style={{ color: 'var(--bp-text-3)' }}>Step {step.index + 1}</span>
                <span style={{ fontWeight: 700 }}>{step.name}</span>
                <span style={{ fontSize: 9, color: 'var(--bp-text-3)' }}>
                  {step.kind === 'action' ? `typed · ${step.action_type}` : 'manual · free text'}
                </span>
                <RiskPill tier={step.risk_tier} />
                {step.requires_approval && (
                  <span style={{ fontSize: 9, color: 'var(--bp-amber)' }}><Lock size={9} /> approval</span>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 9, color: 'var(--bp-text-3)' }}>
                  {step.timeout_seconds}s · {step.max_attempts} attempt(s) · on failure: {step.on_failure}
                </span>
              </div>

              {step.approval_explanation && (
                <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-amber)', marginTop: 5 }}>
                  {step.approval_explanation}
                </div>
              )}
              {step.kind === 'action' && (
                <pre style={{
                  fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-2)', margin: '6px 0 0',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>{JSON.stringify(step.resolved_input, null, 1)}</pre>
              )}
              {step.deferred_references.length > 0 && (
                <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
                  Resolved at run time: {step.deferred_references.join(', ')}
                </div>
              )}
              <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
                {step.execution_route}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
                Rollback: {step.rollback_note}
              </div>
              {(step.required_permissions?.length > 0 || step.side_effect_classification) && (
                <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
                  {step.side_effect_classification ? `Side effects: ${step.side_effect_classification}` : ''}
                  {step.required_permissions?.length > 0 ? ` · permissions: ${step.required_permissions.join(', ')}` : ''}
                </div>
              )}
              {step.blocking_issues.map((issue, i) => (
                <div key={i} style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-red)', marginTop: 4 }}>
                  <AlertCircle size={9} /> {issue}
                </div>
              ))}
              {!step.would_run && step.would_not_run_reason && (
                <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
                  {step.would_not_run_reason}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Playbook run card (#74) ──────────────────────────────────────────────────
//
// The receipt-linked view of a bounded run: what each step actually did,
// what its receipt says, and whether a rollback could undo it.

function PlaybookRunCard({ run, businessId, onRefresh }: RunCardProps) {
  const [detail, setDetail] = useState<PlaybookRunDetail | null>(null)
  const [acting, setActing] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setDetail(await getPlaybookRun(businessId, run.id) as PlaybookRunDetail) } catch { /* run may be pre-playbook */ }
  }, [businessId, run.id])

  useEffect(() => { load() }, [load, run.status])

  async function act(label: string, fn: () => Promise<unknown>) {
    setActing(true); setNote(null)
    try {
      const result = await fn() as { reason?: string; summary?: string; retried?: boolean }
      if (result?.reason) setNote(result.reason)
      else if (result?.summary) setNote(result.summary)
      await load(); await onRefresh()
    } catch (err) { setNote(`${label} failed: ${(err as Error).message}`) }
    finally { setActing(false) }
  }

  const summary = detail?.receipt_summary

  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13 }}>
          {run.workflow_name ?? detail?.playbook?.name}
        </div>
        <StatusBadge status={run.status} />
        {detail?.playbook && (
          <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)' }}>
            playbook v{detail.playbook.version}
          </span>
        )}
        {summary && (
          <span style={{
            fontFamily: MONO, fontSize: 9,
            color: summary.verification_failed ? 'var(--bp-red)' : 'var(--bp-text-3)',
          }}>
            receipts: {summary.aggregate_state}
            {summary.verification_failed ? ' · VERIFICATION FAILED' : ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>
          started {fmtRel(run.started_at)}
        </span>
      </div>

      {detail?.run?.inputs && Object.keys(detail.run.inputs).length > 0 && (
        <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 8 }}>
          inputs: {JSON.stringify(detail.run.inputs)}
        </div>
      )}

      {detail?.steps?.map((s) => (
        <div key={s.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--bp-border)', fontFamily: MONO, fontSize: 11 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ minWidth: 62, color: 'var(--bp-text-3)' }}>Step {s.step_index + 1}:</span>
            <span style={{ color: 'var(--bp-text)' }}>{s.step_name}</span>
            <span style={{ fontSize: 9, color: 'var(--bp-text-3)' }}>
              {s.step_kind === 'action' ? s.action_type : 'manual'}
            </span>
            <RiskPill tier={s.risk_tier} />
            <span style={{
              fontSize: 10,
              color:
                s.status === 'complete' ? 'var(--bp-green)' :
                s.status === 'awaiting_approval' ? 'var(--bp-amber)' :
                s.status === 'failed' ? 'var(--bp-red)' :
                s.status === 'dispatched' ? 'var(--bp-blue)' : 'var(--bp-text-3)',
            }}>{s.status}</span>
            {(s.attempt_count ?? 0) > 0 && (
              <span style={{ fontSize: 9, color: 'var(--bp-text-3)' }}>
                attempt {s.attempt_count}/{s.max_attempts}
              </span>
            )}
            <div style={{ flex: 1 }} />
            {s.status === 'awaiting_approval' && (
              <>
                <button disabled={acting} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, color: 'var(--bp-green)' }}
                  onClick={() => act('Approve', () => approvePlaybookStep(businessId, run.id, s.step_index))}>
                  <Check size={10} /> Approve
                </button>
                <button disabled={acting} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, color: 'var(--bp-red)' }}
                  onClick={() => act('Reject', () => rejectPlaybookStep(businessId, run.id, s.step_index, { reason: prompt('Reason?') || 'Rejected' }))}>
                  <X size={10} /> Reject
                </button>
              </>
            )}
            {s.status === 'failed' && (
              <button disabled={acting} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}
                onClick={() => act('Retry', () => retryPlaybookStep(businessId, run.id, s.step_index))}>
                Retry
              </button>
            )}
          </div>

          {s.approval_reason && s.status === 'awaiting_approval' && (
            <div style={{ fontSize: 10, color: 'var(--bp-amber)', marginTop: 4 }}>{s.approval_reason}</div>
          )}
          {s.receipt && s.receipt.state && (
            <div style={{ fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
              receipt {s.receipt.state}
              {s.receipt.result_status ? ` · ${s.receipt.result_status}` : ''}
              {s.receipt.external_id ? ` · external ${s.receipt.external_id}` : ''}
              {s.receipt.external_permalink && (
                <> · <a href={s.receipt.external_permalink} target="_blank" rel="noreferrer" style={{ color: 'var(--bp-blue)' }}>open</a></>
              )}
              <div>{s.receipt.reason}</div>
            </div>
          )}
          {s.error && <div style={{ fontSize: 10, color: 'var(--bp-red)', marginTop: 4 }}>{s.error}</div>}
          {s.rollback_detail && (
            <div style={{ fontSize: 10, color: s.rollback_status === 'compensated' ? 'var(--bp-green)' : 'var(--bp-amber)', marginTop: 4 }}>
              rollback [{s.rollback_status}] {s.rollback_detail}
            </div>
          )}
        </div>
      ))}

      {run.stopped_reason && (
        <div style={{ marginTop: 10, padding: 8, background: 'rgba(255,82,82,0.08)', borderRadius: 3, fontFamily: MONO, fontSize: 10, color: 'var(--bp-red)' }}>
          {run.stopped_reason}
        </div>
      )}
      {note && (
        <div style={{ marginTop: 10, padding: 8, background: 'var(--bp-surface-2)', borderRadius: 3, fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-2)' }}>
          {note}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {['running', 'paused', 'awaiting_execution'].includes(run.status) && (
          <button disabled={acting} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}
            onClick={() => act('Cancel', () => cancelPlaybookRun(businessId, run.id, { reason: 'Cancelled from the dashboard' }))}>
            <PauseCircle size={10} /> Cancel run
          </button>
        )}
        {run.status !== 'rolled_back' && (
          <button disabled={acting} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, color: 'var(--bp-amber)' }}
            title="Stops every step that has not run, and reports honestly which executed steps cannot be undone"
            onClick={() => act('Rollback', () => rollbackPlaybookRun(businessId, run.id, { reason: 'Rolled back from the dashboard' }))}>
            <RotateCcw size={10} /> Roll back run
          </button>
        )}
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

// ─── Run rendering ────────────────────────────────────────────────────────────

/** A run still needing attention. 'awaiting_execution' is a playbook run whose step receipt has not settled. */
function isActiveRun(run: WorkflowRun): boolean {
  return ['running', 'paused', 'awaiting_execution'].includes(run.status)
}

/**
 * A run bound to a playbook version gets the receipt-linked card; a
 * pre-playbook workflow run keeps the original one, unchanged.
 */
function renderRunCard(run: WorkflowRun, businessId: string, onRefresh: () => Promise<void>) {
  return run.playbook_version != null
    ? <PlaybookRunCard key={run.id} run={run} businessId={businessId} onRefresh={onRefresh} />
    : <RunCard key={run.id} run={run} businessId={businessId} onRefresh={onRefresh} />
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Workflows() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [tab, setTab] = useState('templates')
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [editing, setEditing] = useState<Workflow | Record<string, never> | null>(null)  // workflow or {} for new
  const [askOpen, setAskOpen] = useState(false)
  const [playbookFor, setPlaybookFor] = useState<Workflow | null>(null)

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
            }}>{t} {t === 'templates' && `(${workflows.length})`}{t === 'runs' && ` (${runs.filter(isActiveRun).length})`}</button>
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

      {playbookFor && (
        <PlaybookPanel
          businessId={currentBusiness.id}
          workflow={playbookFor}
          onClose={() => setPlaybookFor(null)}
          onRunStarted={() => { fetchAll(); setTab('runs') }}
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
              <WorkflowCard key={w.id} workflow={w} onRun={handleRun} onEdit={setEditing}
                onDelete={handleDelete} onOpenPlaybook={setPlaybookFor} />
            ))
          )}
        </>
      )}

      {tab === 'runs' && (
        <>
          {runs.filter(isActiveRun).length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
              No workflows currently running.
            </div>
          ) : (
            runs.filter(isActiveRun).map((r) => renderRunCard(r, currentBusiness.id, fetchAll))
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
            runs.map((r) => renderRunCard(r, currentBusiness.id, fetchAll))
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
