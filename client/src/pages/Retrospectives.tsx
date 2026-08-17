import React, { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  BookMarked, Play, ArrowLeft, CheckCircle2, XCircle, Lightbulb,
  GitBranch, ShieldCheck, AlertTriangle, HelpCircle, Undo2, FileSearch,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import useStore from '../lib/store'
import {
  getRetrospectives, getRetrospective, runRetrospective,
  reviewRetrospectiveProposal, rollbackRetrospectiveProposal,
} from '../lib/api'
import type { ElementType } from 'react'

interface WhatWorkedItem {
  title: string
  evidence: string
  insight?: string
}

interface LearningItem {
  learning: string
  applies_to?: string
}

interface OpenWindowItem {
  action_type: string
  count: number
  note: string
}

interface AgentAssessment {
  agent_id: string
  grade?: string
  tasks_proposed?: number
  acceptance_rate?: number
  outcome_rate?: number
  avg_stated_confidence?: number
  avg_actual_outcome_rate?: number
  calibration_error?: number
  note?: string
}

// ─── Structured operating-change proposals (#73) ─────────────────────────────

interface CitedRecord {
  kind: string
  id: string
  summary: string
}

interface ProposalConflict {
  kind: string
  subject: string
  detail: string
  other_business_id?: string | null
}

interface MeasuredEffect {
  state: 'known' | 'unknown' | 'not_comparable'
  value?: Record<string, number | null> | null
  citation?: string | null
  reason?: string | null
}

type ProposalTarget = 'policy' | 'workflow' | 'agent_lifecycle'
type ProposalBasis = 'evidence_backed' | 'hypothesis' | 'conflicting_evidence'
type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'expired' | 'abandoned'

interface DraftRef {
  kind: 'policy_patch' | 'playbook_version' | 'agent_lifecycle'
  next_version?: number
  base_version?: number | null
  changes?: Array<{ field: string; from: unknown; to: unknown }>
  workflow_id?: string
  workflow_name?: string
  version?: number
  validation_state?: string
  agent_id?: string
  retention_verdict?: string
  action?: string
}

interface Proposal {
  id: string
  target: ProposalTarget
  title: string
  statement: string
  basis: ProposalBasis
  basis_reason: string
  cited_records?: CitedRecord[]
  measured_effect?: MeasuredEffect | null
  conflicts?: ProposalConflict[]
  expected_benefit: string
  risk: string
  rollback_plan: string
  expires_at?: string | null
  draft_ref?: DraftRef | null
  decision_task_id?: string | null
  status: ProposalStatus
  activation_result?: Record<string, unknown> | null
  review_reason?: string | null
  reviewed_by?: string | null
  business_id: string
}

interface EvidenceGap {
  subject: string
  reason: string
  detail: string
  measured_outcomes: number
  required_outcomes: number
}

interface UnstructuredSuggestion {
  text: string
  source: string
  not_proposed_reason: string
}

interface RetroData {
  id: string
  period_start: string
  period_end: string
  executive_summary?: string
  what_worked?: WhatWorkedItem[]
  what_didnt?: WhatWorkedItem[]
  learnings?: LearningItem[]
  agent_assessments?: AgentAssessment[]
  open_windows?: OpenWindowItem[]
  recommendations?: string[]
  operating_changes?: string[]
  proposals?: Proposal[]
  evidence_gaps?: EvidenceGap[]
  unstructured_suggestions?: UnstructuredSuggestion[]
  kb_path?: string
  created_at: string
  triggered_by?: string
}

interface RetroSummary {
  id: string
  period_start: string
  executive_summary?: string
  created_at: string
  triggered_by?: string
}

interface SectionProps<T> {
  title: string
  icon: ElementType
  color: string
  items: T[] | undefined
  render: (item: T) => React.ReactNode
}

function Section<T>({ title, icon: Icon, color, items, render }: SectionProps<T>) {
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <div className="bp-card" style={{ padding: 18, marginBottom: 14, borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon size={14} style={{ color }} />
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14 }}>{title}</div>
      </div>
      {items.map((it, i) => (
        <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-2)', padding: '6px 0', borderBottom: i < items.length - 1 ? '1px solid var(--bp-border)' : 'none' }}>
          {render(it)}
        </div>
      ))}
    </div>
  )
}

// ─── Proposal presentation (#73) ─────────────────────────────────────────────

/**
 * The basis badge is the most important thing on a proposal. It is what stops
 * a reader treating "we noticed a pattern" as "we proved this fix works", so
 * it is shown before the proposal text rather than tucked into a footnote.
 */
const BASIS_META: Record<ProposalBasis, { label: string; color: string; icon: ElementType; blurb: string }> = {
  evidence_backed: {
    label: 'Evidence-backed',
    color: 'var(--bp-green)',
    icon: ShieldCheck,
    blurb: 'Measured outcome records support this pattern. That is not the same as proving the change will fix it.',
  },
  conflicting_evidence: {
    label: 'Conflicting evidence',
    color: 'var(--bp-amber)',
    icon: AlertTriangle,
    blurb: 'The records disagree. They have been shown side by side rather than averaged into one answer.',
  },
  hypothesis: {
    label: 'Hypothesis',
    color: 'var(--bp-text-3)',
    icon: HelpCircle,
    blurb: 'Not enough measured evidence to claim a pattern. This is something to try, not a finding.',
  },
}

const TARGET_META: Record<ProposalTarget, { label: string; icon: ElementType }> = {
  policy: { label: 'Operating policy', icon: ShieldCheck },
  workflow: { label: 'Workflow / playbook', icon: GitBranch },
  agent_lifecycle: { label: 'Agent lifecycle', icon: BookMarked },
}

const STATUS_COLOR: Record<ProposalStatus, string> = {
  proposed: 'var(--bp-blue)',
  approved: 'var(--bp-green)',
  rejected: 'var(--bp-red)',
  expired: 'var(--bp-text-3)',
  abandoned: 'var(--bp-text-3)',
}

const mono = 'var(--bp-font-mono)'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--bp-text-3)' }}>
        {label}
      </div>
      <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5, marginTop: 2 }}>
        {children}
      </div>
    </div>
  )
}

/** What approving this proposal would actually activate, and where. */
function DraftSummary({ draft }: { draft: DraftRef }) {
  if (draft.kind === 'policy_patch') {
    return (
      <Field label="Draft it would activate">
        Operating policy version <strong>{draft.next_version}</strong> (from version {draft.base_version}).
        {Array.isArray(draft.changes) && draft.changes.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {draft.changes.map((c, i) => (
              <div key={i} style={{ color: 'var(--bp-text-3)' }}>
                <code>{c.field}</code>: {JSON.stringify(c.from)} → {JSON.stringify(c.to)}
              </div>
            ))}
          </div>
        )}
        <div style={{ color: 'var(--bp-text-3)', marginTop: 4 }}>
          No policy version is written until this is approved.
        </div>
      </Field>
    )
  }
  if (draft.kind === 'playbook_version') {
    return (
      <Field label="Draft it would activate">
        Draft playbook version <strong>{draft.version}</strong> of "{draft.workflow_name}"
        {draft.base_version != null && <> (replacing version {draft.base_version})</>}
        {draft.validation_state && <> · validation: {draft.validation_state}</>}
        {draft.workflow_id && (
          <> · <Link to={`/workflows/${draft.workflow_id}`} style={{ color: 'var(--bp-blue)' }}>open playbook →</Link></>
        )}
        <div style={{ color: 'var(--bp-text-3)', marginTop: 4 }}>
          The draft exists now but never runs. Only the active version runs.
        </div>
      </Field>
    )
  }
  return (
    <Field label="Action it would take">
      {draft.action === 'retire' ? 'Retire' : 'Move to standby'} agent <strong>{draft.agent_id}</strong>
      {draft.retention_verdict && <> · retention verdict: {draft.retention_verdict}</>}
    </Field>
  )
}

interface ProposalCardProps {
  proposal: Proposal
  onReview: (proposal: Proposal, outcome: 'approve' | 'reject') => void
  onRollback: (proposal: Proposal) => void
  busy: boolean
}

function ProposalCard({ proposal, onReview, onRollback, busy }: ProposalCardProps) {
  const [showRecords, setShowRecords] = useState(false)
  const basis = BASIS_META[proposal.basis] ?? BASIS_META.hypothesis
  const target = TARGET_META[proposal.target]
  const BasisIcon = basis.icon
  const TargetIcon = target?.icon ?? BookMarked
  const pending = proposal.status === 'proposed'
  const records = proposal.cited_records ?? []
  const conflicts = proposal.conflicts ?? []

  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 12, borderLeft: `3px solid ${basis.color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: mono, fontSize: 9,
              letterSpacing: '0.08em', textTransform: 'uppercase', color: basis.color,
              border: `1px solid ${basis.color}`, borderRadius: 3, padding: '2px 6px' }}>
              <BasisIcon size={10} /> {basis.label}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: mono, fontSize: 9,
              letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--bp-text-3)' }}>
              <TargetIcon size={10} /> {target?.label ?? proposal.target}
            </span>
            <span style={{ fontFamily: mono, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: STATUS_COLOR[proposal.status] ?? 'var(--bp-text-3)' }}>
              {proposal.status}
            </span>
          </div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13 }}>
            {proposal.title}
          </div>
        </div>
      </div>

      <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text)', lineHeight: 1.5, marginTop: 8 }}>
        {proposal.statement}
      </div>

      <div style={{ fontFamily: mono, fontSize: 10, color: basis.color, lineHeight: 1.5, marginTop: 8,
        background: 'var(--bp-bg-2)', padding: '6px 8px', borderRadius: 3 }}>
        <div style={{ fontWeight: 700 }}>{basis.blurb}</div>
        <div style={{ color: 'var(--bp-text-2)', marginTop: 3 }}>{proposal.basis_reason}</div>
      </div>

      {conflicts.length > 0 && (
        <Field label="Conflicts (not averaged away)">
          {conflicts.map((c, i) => (
            <div key={i} style={{ marginTop: i === 0 ? 0 : 4, color: 'var(--bp-amber)' }}>{c.detail}</div>
          ))}
        </Field>
      )}

      <Field label="Expected benefit">{proposal.expected_benefit}</Field>
      <Field label="Risk">{proposal.risk}</Field>
      <Field label="Rollback">{proposal.rollback_plan}</Field>
      {proposal.expires_at && (
        <Field label="Expires">
          {new Date(proposal.expires_at).toLocaleDateString()} — if nobody reviews it by then it lapses and its draft is abandoned.
        </Field>
      )}
      {proposal.draft_ref && <DraftSummary draft={proposal.draft_ref} />}
      {proposal.decision_task_id && (
        <Field label="Decision queue">
          <Link to={`/tasks/${proposal.decision_task_id}`} style={{ color: 'var(--bp-blue)' }}>
            Review item {proposal.decision_task_id.slice(0, 8)} →
          </Link>
          {' '}Approval and rejection go through the same queue as any other decision.
        </Field>
      )}
      {proposal.review_reason && (
        <Field label={`Reviewer note${proposal.reviewed_by ? ` (${proposal.reviewed_by})` : ''}`}>
          {proposal.review_reason}
        </Field>
      )}

      {records.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setShowRecords((v) => !v)} className="bp-btn bp-btn-ghost" style={{ fontSize: 10 }}>
            <FileSearch size={10} /> {showRecords ? 'Hide' : 'Show'} the {records.length} record(s) analysed
          </button>
          {showRecords && (
            <div style={{ marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
              {records.map((r, i) => (
                <div key={i} style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', padding: '3px 0',
                  borderBottom: '1px solid var(--bp-border)' }}>
                  <code>{r.kind}</code> {r.id.slice(0, 8)} — {r.summary}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {pending && (
          <>
            <button onClick={() => onReview(proposal, 'approve')} disabled={busy}
              className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
              <CheckCircle2 size={11} /> Approve &amp; activate
            </button>
            <button onClick={() => onReview(proposal, 'reject')} disabled={busy}
              className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
              <XCircle size={11} /> Reject
            </button>
          </>
        )}
        {proposal.status === 'approved' && proposal.target !== 'agent_lifecycle' && (
          <button onClick={() => onRollback(proposal)} disabled={busy}
            className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
            <Undo2 size={11} /> Roll back
          </button>
        )}
      </div>
    </div>
  )
}

interface RetroDetailProps {
  retro: RetroData
  onBack: () => void
  onChanged: () => void
}

function RetroDetail({ retro, onBack, onChanged }: RetroDetailProps) {
  const [busy, setBusy] = useState(false)

  async function handleReview(proposal: Proposal, outcome: 'approve' | 'reject') {
    const reason = window.prompt(
      outcome === 'approve'
        ? 'Optional note: why is this change worth making?'
        : 'A rejection reason is required — the proposing side learns from why, not that.',
      '',
    )
    if (outcome === 'reject' && !reason?.trim()) return
    setBusy(true)
    try {
      await reviewRetrospectiveProposal(proposal.business_id, proposal.id, {
        outcome, reason: reason?.trim() || undefined,
      })
      onChanged()
    } catch (err) {
      alert(`Review failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleRollback(proposal: Proposal) {
    const reason = window.prompt('Why are you rolling this change back?', '')
    if (!reason?.trim()) return
    setBusy(true)
    try {
      await rollbackRetrospectiveProposal(proposal.business_id, proposal.id, reason.trim())
      onChanged()
    } catch (err) {
      alert(`Rollback failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button onClick={onBack} className="bp-btn bp-btn-ghost" style={{ fontSize: 11, marginBottom: 14 }}>
        <ArrowLeft size={11} /> Back to list
      </button>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 22, margin: 0 }}>
          Retrospective — {new Date(retro.period_start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
        </h1>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginTop: 4 }}>
          {new Date(retro.period_start).toLocaleDateString()} to {new Date(retro.period_end).toLocaleDateString()}
          {retro.kb_path && <> · Filed to KB: <code>{retro.kb_path}</code></>}
        </div>
      </div>

      {retro.executive_summary && (
        <div className="bp-card" style={{ padding: 20, marginBottom: 14, borderLeft: '3px solid var(--bp-blue)' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-blue)', textTransform: 'uppercase', marginBottom: 8 }}>
            Executive summary
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 13, color: 'var(--bp-text)', lineHeight: 1.5 }}>
            {retro.executive_summary}
          </div>
        </div>
      )}

      <Section<WhatWorkedItem> title="What worked" icon={CheckCircle2} color="var(--bp-green)" items={retro.what_worked}
        render={(w) => (<><strong>{w.title}</strong> — {w.evidence}{w.insight && <div style={{ fontStyle: 'italic', color: 'var(--bp-text-3)', marginTop: 4 }}>{w.insight}</div>}</>)} />

      <Section<WhatWorkedItem> title="What didn't work" icon={XCircle} color="var(--bp-red)" items={retro.what_didnt}
        render={(w) => (<><strong>{w.title}</strong> — {w.evidence}{w.insight && <div style={{ fontStyle: 'italic', color: 'var(--bp-text-3)', marginTop: 4 }}>{w.insight}</div>}</>)} />

      <Section<LearningItem> title="Learnings" icon={Lightbulb} color="var(--bp-blue)" items={retro.learnings}
        render={(l) => (<>{l.learning}{l.applies_to && <span style={{ color: 'var(--bp-text-3)' }}> — {l.applies_to}</span>}</>)} />

      {Array.isArray(retro.agent_assessments) && retro.agent_assessments.length > 0 && (
        <div className="bp-card" style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14 }}>
              Agent scorecards
            </div>
            <Link to="/calibration" style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)' }}>
              Full calibration →
            </Link>
          </div>
          <table style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bp-border)', color: 'var(--bp-text-3)' }}>
                <th align="left" style={{ padding: '6px 0' }}>Agent</th>
                <th>Grade</th>
                <th>Proposed</th>
                <th>Accept</th>
                <th>Outcome</th>
                <th>Stated</th>
                <th>Actual</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {retro.agent_assessments.map((a, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--bp-border)' }}>
                  <td style={{ padding: '6px 0' }}>{a.agent_id}</td>
                  <td align="center">{a.grade ?? '-'}</td>
                  <td align="center">{a.tasks_proposed ?? 0}</td>
                  <td align="center">{((a.acceptance_rate ?? 0) * 100).toFixed(0)}%</td>
                  <td align="center">{((a.outcome_rate ?? 0) * 100).toFixed(0)}%</td>
                  <td align="center">{((a.avg_stated_confidence ?? 0) * 100).toFixed(0)}%</td>
                  <td align="center">{((a.avg_actual_outcome_rate ?? 0) * 100).toFixed(0)}%</td>
                  <td align="center" style={{ color: (a.calibration_error ?? 0) > 0.1 ? 'var(--bp-red)' : undefined }}>
                    {a.calibration_error != null ? (a.calibration_error * 100).toFixed(1) + '%' : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {retro.agent_assessments.filter((a) => a.note).length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bp-border)' }}>
              {retro.agent_assessments.filter((a) => a.note).map((a, i) => (
                <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, padding: '4px 0' }}>
                  <strong>{a.agent_id}:</strong> <span style={{ color: 'var(--bp-text-2)' }}>{a.note}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Section<OpenWindowItem> title="Open measurement windows" icon={BookMarked} color="var(--bp-amber)" items={retro.open_windows}
        render={(w) => (<><strong>{w.action_type}</strong> ({w.count}) — {w.note}</>)} />

      {/* ── Proposed operating changes (#73) ── */}
      <div className="bp-card" style={{ padding: 18, marginBottom: 14, borderLeft: '3px solid var(--bp-purple)' }}>
        <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-purple)', textTransform: 'uppercase', marginBottom: 6 }}>
          Proposed operating changes
        </div>
        <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5, marginBottom: 12 }}>
          Bounded changes this retrospective is proposing, each targeting one system. Nothing here has taken
          effect: a proposal becomes real only when you approve it, and the change is then made by the system
          that owns it — the operating policy editor, the playbook versioner, or the agent lifecycle controls.
        </div>

        {Array.isArray(retro.proposals) && retro.proposals.length > 0 ? (
          retro.proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} busy={busy}
              onReview={handleReview} onRollback={handleRollback} />
          ))
        ) : (
          <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-3)' }}>
            No operating change was proposed from this period. See the evidence gaps below for what was
            looked at and why it did not support one.
          </div>
        )}
      </div>

      {/* ── Where the evidence ran out ── */}
      {Array.isArray(retro.evidence_gaps) && retro.evidence_gaps.length > 0 && (
        <div className="bp-card" style={{ padding: 18, marginBottom: 14, borderLeft: '3px solid var(--bp-text-3)' }}>
          <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 6 }}>
            Where the evidence ran out
          </div>
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5, marginBottom: 10 }}>
            Subjects that were analysed and deliberately produced no proposal. "We could not tell" is a
            result — a low-confidence guess would not be.
          </div>
          {retro.evidence_gaps.map((g, i) => (
            <div key={i} style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', padding: '6px 0',
              borderBottom: i < retro.evidence_gaps!.length - 1 ? '1px solid var(--bp-border)' : 'none' }}>
              <strong>{g.subject}</strong>{' '}
              <span style={{ color: 'var(--bp-text-3)' }}>({g.reason.replace(/_/g, ' ')})</span>
              <div style={{ color: 'var(--bp-text-3)', marginTop: 2 }}>{g.detail}</div>
              <div style={{ color: 'var(--bp-text-3)', marginTop: 2 }}>
                {g.measured_outcomes} of {g.required_outcomes} measured outcome(s) needed.
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Narrative that stayed narrative ── */}
      {Array.isArray(retro.unstructured_suggestions) && retro.unstructured_suggestions.length > 0 && (
        <div className="bp-card" style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 6 }}>
            Analyst suggestions kept as narrative
          </div>
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5, marginBottom: 10 }}>
            Written advice from the retrospective that no record could back. It is shown, but it was
            deliberately not turned into an approvable operating change.
          </div>
          {retro.unstructured_suggestions.map((s, i) => (
            <div key={i} style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', padding: '6px 0',
              borderBottom: i < retro.unstructured_suggestions!.length - 1 ? '1px solid var(--bp-border)' : 'none' }}>
              {s.text}
              <div style={{ color: 'var(--bp-text-3)', fontStyle: 'italic', marginTop: 3 }}>
                {s.not_proposed_reason}
              </div>
            </div>
          ))}
        </div>
      )}

      {Array.isArray(retro.recommendations) && retro.recommendations.length > 0 && (
        <div className="bp-card" style={{ padding: 18, marginBottom: 14, borderLeft: '3px solid var(--bp-purple)' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-purple)', textTransform: 'uppercase', marginBottom: 10 }}>
            Recommendations for next month
          </div>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {retro.recommendations.map((r, i) => (
              <li key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text)', padding: '4px 0' }}>
                {r}
              </li>
            ))}
          </ol>
        </div>
      )}

      {Array.isArray(retro.operating_changes) && retro.operating_changes.length > 0 && (
        <div className="bp-card" style={{ padding: 18 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 4 }}>
            Analyst's written view: how Blueprint should operate differently
          </div>
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5, marginBottom: 10 }}>
            Prose, not proposals. Only the items under "Proposed operating changes" above can actually be
            approved and take effect.
          </div>
          {retro.operating_changes.map((c, i) => (
            <div key={i} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-2)', padding: '4px 0' }}>
              • {c}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Retrospectives() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const { id: routeId } = useParams()
  const navigate = useNavigate()
  const [list, setList] = useState<RetroSummary[]>([])
  const [selected, setSelected] = useState<RetroData | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    if (!currentBusiness) return
    const rows = await getRetrospectives(currentBusiness.id).catch(() => [])
    setList(rows || [])
    if (routeId) {
      try {
        const r = await getRetrospective(currentBusiness.id, routeId)
        setSelected(r as RetroData)
      } catch {}
    }
  }, [currentBusiness, routeId])

  useEffect(() => { load() }, [load])

  async function handleRun() {
    setRunning(true)
    try {
      const r = await runRetrospective(currentBusiness!.id) as { id?: string }
      if (r?.id) {
        await load()
        const detail = await getRetrospective(currentBusiness!.id, r.id)
        setSelected(detail as RetroData)
        navigate(`/retrospectives/${r.id}`)
      }
    } catch (err) {
      const e = err as Error
      alert(`Failed: ${e.message}`)
    } finally {
      setRunning(false)
    }
  }

  async function handleOpen(id: string) {
    const r = await getRetrospective(currentBusiness!.id, id)
    setSelected(r as RetroData)
    navigate(`/retrospectives/${id}`)
  }

  function handleBack() {
    setSelected(null)
    navigate('/retrospectives')
  }

  /**
   * Re-fetch after a review or rollback. The proposals are read live from the
   * server rather than patched locally, because approving one activates a
   * change in another system — the authoritative status is whatever that
   * system ended up in, not what the click intended.
   */
  const handleRefreshSelected = useCallback(async () => {
    if (!currentBusiness || !selected) return
    try {
      setSelected(await getRetrospective(currentBusiness.id, selected.id) as RetroData)
    } catch { /* leave the current view in place rather than blanking it */ }
  }, [currentBusiness, selected])

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      {!selected && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0 }}>RETROSPECTIVES</h1>
            <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
              What Blueprint has learned from running your business
            </p>
          </div>
          <button onClick={handleRun} disabled={running} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
            <Play size={11} /> {running ? 'Running…' : 'Run retrospective now'}
          </button>
        </div>
      )}

      {selected ? (
        <RetroDetail retro={selected} onBack={handleBack} onChanged={handleRefreshSelected} />
      ) : list.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          No retrospectives yet. Click "Run retrospective now" to generate the first one.
        </div>
      ) : (
        list.map((r) => (
          <div key={r.id} onClick={() => handleOpen(r.id)}
            className="bp-card"
            style={{ padding: 16, marginBottom: 10, cursor: 'pointer', borderLeft: '3px solid var(--bp-blue)' }}>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
              {new Date(r.period_start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
            </div>
            {r.executive_summary && (
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.4, marginBottom: 6 }}>
                {r.executive_summary.slice(0, 220)}{r.executive_summary.length > 220 ? '…' : ''}
              </div>
            )}
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
              {formatDistanceToNow(parseTimestamp(r.created_at) || new Date(), { addSuffix: true })} · {r.triggered_by}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
