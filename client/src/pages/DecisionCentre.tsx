/**
 * Decision Centre — the reviewer's queue (#61).
 *
 * The counterpart to Decisions.tsx: that page answers "why did we decide
 * this?", this one answers "what still needs me, and what do I need to know
 * to decide it?". Everything shown here is derived server-side in
 * server/decisions/decision-queue.ts from tasks and the per-business
 * operating policy (#68) — this page classifies nothing itself, so the
 * lanes, holds and override rules a reviewer sees are exactly the ones the
 * server enforces.
 *
 * Policy is edited in PolicyEditor.tsx, not here. "Make this a standing
 * rule" previews a patch and hands the reviewer to that editor.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, Check, Clock, FileEdit, Gavel, Scale, ShieldAlert, X,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import useStore from '../lib/store.js'
import {
  getDecisionClasses, getDecisionQueue, proposePolicyRule, reviewPendingDecision,
} from '../lib/api.js'

type Lane = 'manual_review' | 'policy_gated' | 'routine'
type Outcome = 'approve' | 'reject' | 'defer' | 'amend'

interface EvidenceItem { type: string; summary: string; detail?: unknown }

interface PendingDecision {
  task_id: string
  business_id: string
  title: string
  description: string | null
  status: string
  required_action: {
    action_type: string | null
    display_name: string | null
    executable: boolean
    required_connector_types: string[]
    supports_rollback: boolean
    payload: Record<string, unknown>
  }
  risk_tier: 'green' | 'yellow' | 'orange' | 'red'
  lane: Lane
  lane_reason: string
  policy_recommendation: 'approve_allowed' | 'human_required' | 'hold'
  hold_reasons: string[]
  requires_override_reason: boolean
  policy: { policy_id: string | null; policy_version: number; policy_scope: string; citation: string }
  decision_class: string
  evidence: EvidenceItem[]
  confidence: number | null
  priority: string
  estimated_impact: string | null
  proposed_by: string
  amended_by: string | null
  deferred_until: string | null
  created_at: string
}

interface DecisionClass {
  decision_class: string
  action_type: string | null
  pending_count: number
  lanes: Record<Lane, number>
  highest_risk_tier: string
  already_has_human_rule: boolean
  reviewed_count: number
}

const LANE_META: Record<Lane, { label: string; blurb: string; colour: string; Icon: typeof AlertTriangle }> = {
  manual_review: {
    label: 'NEEDS INVESTIGATION',
    blurb: 'Blueprint does not know what happened, or cannot carry this out. Not routine.',
    colour: 'var(--bp-red)',
    Icon: AlertTriangle,
  },
  policy_gated: {
    label: 'HELD BY POLICY',
    blurb: 'Your operating policy stops this from proceeding on its own.',
    colour: 'var(--bp-amber)',
    Icon: ShieldAlert,
  },
  routine: {
    label: 'ROUTINE REVIEW',
    blurb: 'Nothing unusual — waiting on a yes or no.',
    colour: 'var(--bp-blue)',
    Icon: Scale,
  },
}

const TIER_COLOUR: Record<string, string> = {
  green: 'var(--bp-green)',
  yellow: 'var(--bp-amber)',
  orange: 'var(--bp-amber)',
  red: 'var(--bp-red)',
}

const mono = 'var(--bp-font-mono)'

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: mono, fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>
      {children}
    </div>
  )
}

function defaultDeferDate(): string {
  const d = new Date(Date.now() + 7 * 86_400_000)
  return d.toISOString().slice(0, 10)
}

function DecisionCard({
  decision, businessId, onDone,
}: { decision: PendingDecision; businessId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [reason, setReason] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [deferDate, setDeferDate] = useState(defaultDeferDate())
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(decision.required_action.payload, null, 2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rule, setRule] = useState<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any

  const lane = LANE_META[decision.lane]
  const held = decision.policy_recommendation === 'hold'

  async function submit() {
    if (!outcome) return
    setBusy(true); setError(null)
    try {
      const body: Parameters<typeof reviewPendingDecision>[2] = { outcome }
      if (outcome === 'reject' || outcome === 'defer' || outcome === 'amend') body.reason = reason
      if (outcome === 'defer') body.defer_until = new Date(`${deferDate}T09:00:00`).toISOString()
      if (outcome === 'amend') {
        try { body.amended_payload = JSON.parse(payloadText) }
        catch { setError('The amended payload is not valid JSON.'); setBusy(false); return }
      }
      // Sent for approve and amend; the server decides whether it was needed
      // and refuses with 422 if a hold applies and this is missing.
      if (overrideReason.trim()) body.override_reason = overrideReason
      await reviewPendingDecision(businessId, decision.task_id, body)
      onDone()
    } catch (err) {
      setError((err as Error).message || 'The review could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  async function makeRule(kind: 'always_require_human' | 'cap_auto_approve_tier') {
    setBusy(true); setError(null)
    try { setRule(await proposePolicyRule(businessId, decision.task_id, kind)) }
    catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 10, borderLeft: `3px solid ${lane.colour}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span className="bp-pill" style={{ fontSize: 9, background: 'transparent', border: `1px solid ${lane.colour}`, color: lane.colour }}>
          {lane.label}
        </span>
        <span className="bp-pill" style={{ fontSize: 9, background: 'transparent', border: `1px solid ${TIER_COLOUR[decision.risk_tier]}`, color: TIER_COLOUR[decision.risk_tier] }}>
          {decision.risk_tier.toUpperCase()}
        </span>
        <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)' }}>{decision.decision_class}</span>
        {decision.amended_by && (
          <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-amber)' }}>amended</span>
        )}
        <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', marginLeft: 'auto' }}>
          {formatDistanceToNow(parseTimestamp(decision.created_at) || new Date(), { addSuffix: true })} · {decision.proposed_by}
        </span>
      </div>

      <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)', marginBottom: 4 }}>
        {decision.title}
      </div>
      <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5, marginBottom: 8 }}>
        {decision.lane_reason}
      </div>

      {/* What would actually happen. */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 8 }}>
        <span>Action: <strong style={{ color: 'var(--bp-text-2)' }}>{decision.required_action.display_name || decision.required_action.action_type || 'manual task (no automated action)'}</strong></span>
        {!decision.required_action.executable && decision.required_action.action_type && (
          <span style={{ color: 'var(--bp-red)' }}>no executor — approving cannot make this run</span>
        )}
        {decision.required_action.required_connector_types.length > 0 && (
          <span>needs: {decision.required_action.required_connector_types.join(', ')}</span>
        )}
        {decision.confidence != null && <span>{Math.round(decision.confidence * 100)}% agent confidence</span>}
      </div>

      {held && (
        <div style={{ border: '1px solid var(--bp-red)', borderRadius: 3, padding: 10, marginBottom: 8 }}>
          <Label>Policy says hold</Label>
          {decision.hold_reasons.map((r, i) => (
            <div key={i} style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>{r}</div>
          ))}
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Approving anyway is an override and needs a written reason.
          </div>
        </div>
      )}

      <button className="bp-btn-ghost" style={{ fontSize: 10 }} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide evidence' : `Evidence (${decision.evidence.length})`}
      </button>

      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bp-border)' }}>
          {decision.evidence.map((e, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <Label>{e.type.replace(/_/g, ' ')}</Label>
              <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>{e.summary}</div>
              {e.detail != null && (
                <pre style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: '4px 0 0' }}>
                  {JSON.stringify(e.detail, null, 2)}
                </pre>
              )}
            </div>
          ))}
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)' }}>
            Governed by {decision.policy.citation}.{' '}
            <Link to="/policy" style={{ color: 'var(--bp-blue)' }}>Review the operating policy</Link>
          </div>
        </div>
      )}

      {/* Outcomes. */}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        {([
          ['approve', 'Approve', Check],
          ['amend', 'Amend & approve', FileEdit],
          ['defer', 'Defer', Clock],
          ['reject', 'Reject', X],
        ] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            className={outcome === value ? 'bp-btn' : 'bp-btn-ghost'}
            style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => { setOutcome(outcome === value ? null : value); setError(null) }}
          >
            <Icon size={11} /> {label}
          </button>
        ))}
        <button
          className="bp-btn-ghost"
          style={{ fontSize: 10, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => makeRule('always_require_human')}
          disabled={busy || !decision.required_action.action_type}
          title={decision.required_action.action_type
            ? 'Preview a standing rule for this kind of decision'
            : 'Only decisions with an action type form a bounded, reusable class'}
        >
          <Gavel size={11} /> Make this a standing rule
        </button>
      </div>

      {outcome && (
        <div style={{ marginTop: 10, padding: 10, background: 'var(--bp-surface-2)', borderRadius: 3 }}>
          {(outcome === 'reject' || outcome === 'defer' || outcome === 'amend') && (
            <div style={{ marginBottom: 8 }}>
              <Label>{outcome === 'reject' ? 'Why are you rejecting this?' : outcome === 'defer' ? 'Why defer, and what changes by then?' : 'What are you changing, and why?'}</Label>
              <textarea
                className="bp-input" rows={2} style={{ width: '100%', fontSize: 11 }}
                value={reason} onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}
          {outcome === 'defer' && (
            <div style={{ marginBottom: 8 }}>
              <Label>Resurface on</Label>
              <input
                type="date" className="bp-input" style={{ fontSize: 11 }}
                value={deferDate} onChange={(e) => setDeferDate(e.target.value)}
              />
            </div>
          )}
          {outcome === 'amend' && (
            <div style={{ marginBottom: 8 }}>
              <Label>Amended payload (re-validated and re-scored on approval)</Label>
              <textarea
                className="bp-input" rows={6} style={{ width: '100%', fontSize: 10, fontFamily: mono }}
                value={payloadText} onChange={(e) => setPayloadText(e.target.value)}
              />
            </div>
          )}
          {held && (outcome === 'approve' || outcome === 'amend') && (
            <div style={{ marginBottom: 8 }}>
              <Label>Override reason — required, and recorded against the policy version</Label>
              <textarea
                className="bp-input" rows={2} style={{ width: '100%', fontSize: 11 }}
                placeholder="Why is it safe to proceed despite the policy hold?"
                value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
              />
            </div>
          )}
          {error && (
            <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-red)', marginBottom: 8, lineHeight: 1.5 }}>{error}</div>
          )}
          <button className="bp-btn" style={{ fontSize: 11 }} onClick={submit} disabled={busy}>
            {busy ? 'Recording…' : `Record ${outcome}`}
          </button>
        </div>
      )}

      {rule && (
        <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--bp-blue)', borderRadius: 3 }}>
          <Label>Proposed standing rule</Label>
          <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>{rule.statement}</div>
          <div style={{ fontFamily: mono, fontSize: 10, color: rule.preview?.valid ? 'var(--bp-text-3)' : 'var(--bp-red)', marginTop: 6 }}>
            {rule.already_in_effect
              ? 'This rule is already in force for this business.'
              : rule.preview?.valid
                ? `Valid — would become operating policy version ${rule.preview.next_version}. Nothing has been saved.`
                : 'This rule would be rejected by policy validation.'}
          </div>
          {!rule.already_in_effect && rule.preview?.valid && (
            <Link to="/policy" className="bp-btn-ghost" style={{ fontSize: 10, marginTop: 8, display: 'inline-block' }}>
              Open the policy editor to test and save it
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

export default function DecisionCentre() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [queue, setQueue] = useState<{ decisions: PendingDecision[]; counts: Record<string, number>; policy: PendingDecision['policy'] } | null>(null)
  const [classes, setClasses] = useState<DecisionClass[]>([])
  const [lane, setLane] = useState<Lane | ''>('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!currentBusiness) return
    setLoading(true)
    try {
      const [q, c] = await Promise.all([
        getDecisionQueue(currentBusiness.id, lane ? { lane } : undefined),
        getDecisionClasses(currentBusiness.id),
      ])
      setQueue(q as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      setClasses(((c as any)?.classes ?? []) as DecisionClass[]) // eslint-disable-line @typescript-eslint/no-explicit-any
    } catch {
      setQueue(null); setClasses([])
    } finally {
      setLoading(false)
    }
  }, [currentBusiness, lane])

  useEffect(() => { load() }, [load])

  const recurring = useMemo(
    () => classes.filter((c) => c.reviewed_count >= 2 && !c.already_has_human_rule),
    [classes],
  )

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  const counts = queue?.counts ?? { total: 0, manual_review: 0, policy_gated: 0, routine: 0 }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>DECISION CENTRE</h1>
        <p style={{ fontFamily: mono, fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6, lineHeight: 1.6 }}>
          What needs a human in <strong style={{ color: 'var(--bp-text-2)' }}>{currentBusiness.name}</strong>, and why.
          {queue && <> Governed by {queue.policy.citation}. </>}
          <Link to="/decisions" style={{ color: 'var(--bp-blue)' }}>See decisions already made →</Link>
        </p>
      </div>

      {/* Lane triage. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <button className={lane === '' ? 'bp-btn' : 'bp-btn-ghost'} style={{ fontSize: 10 }} onClick={() => setLane('')}>
          All ({counts.total ?? 0})
        </button>
        {(Object.keys(LANE_META) as Lane[]).map((l) => {
          const meta = LANE_META[l]
          return (
            <button
              key={l}
              className={lane === l ? 'bp-btn' : 'bp-btn-ghost'}
              style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 4, borderColor: meta.colour, color: lane === l ? undefined : meta.colour }}
              onClick={() => setLane(l)}
              title={meta.blurb}
            >
              <meta.Icon size={11} /> {meta.label} ({counts[l] ?? 0})
            </button>
          )
        })}
      </div>

      {/* Recurring classes worth a standing rule. */}
      {recurring.length > 0 && (
        <div className="bp-card" style={{ padding: 12, marginBottom: 14, borderLeft: '3px solid var(--bp-blue)' }}>
          <Label>Decisions you keep making by hand</Label>
          {recurring.map((c) => (
            <div key={c.decision_class} style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.6 }}>
              <strong>{c.decision_class}</strong> — reviewed {c.reviewed_count} time(s), {c.pending_count} pending.
              A standing rule in your operating policy could handle this class consistently.
            </div>
          ))}
          <Link to="/policy" style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-blue)' }}>Open the operating policy editor →</Link>
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: mono, fontSize: 12 }}>Loading…</div>
      ) : !queue || queue.decisions.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: mono, fontSize: 12, lineHeight: 1.6 }}>
          Nothing is waiting on you.
          <br />
          Proposals needing approval, and actions whose outcome Blueprint could not determine, appear here.
        </div>
      ) : (
        queue.decisions.map((d) => (
          <DecisionCard key={d.task_id} decision={d} businessId={currentBusiness.id} onDone={load} />
        ))
      )}
    </div>
  )
}
