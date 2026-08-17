import React, { useEffect, useState, useCallback } from 'react'
import { ReceiptText, ExternalLink, ShieldAlert, CheckCircle2, Circle, XCircle, HelpCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import useStore from '../lib/store.js'
import { getActionReceipts } from '../lib/api.js'

/**
 * Verified action receipts (issue #70).
 *
 * The point of this page is the five-stage chain, kept visibly separate:
 * an external acknowledgement ("GitHub returned issue #412") is NOT
 * verification ("the metric moved four weeks later"). A receipt that stops
 * at ACKNOWLEDGED is showing the honest answer, not a failure — so the
 * chain renders unreached stages as explicitly unreached rather than
 * hiding them.
 */

interface ReceiptStage {
  at?: string | null
  by?: string | null
  reached: boolean
}

interface AckStage extends ReceiptStage {
  system?: string | null
  external_id?: string | null
  permalink?: string | null
}

interface VerifiedStage extends ReceiptStage {
  evidence?: Record<string, unknown> | null
}

interface Receipt {
  id: string
  receipt_version: number
  task_id: string
  task_version: number
  correlation_key: string
  action_type?: string | null
  title?: string | null
  state: string
  result_status: string
  result_summary?: string | null
  result_detail?: Record<string, unknown> | null
  rejection?: { at?: string; by?: string | null; stage?: string | null; reason?: string | null } | null
  states: {
    requested: ReceiptStage
    authorized: ReceiptStage
    executed: ReceiptStage
    externally_acknowledged: AckStage
    verified: VerifiedStage
  }
  external_reference?: Record<string, unknown> | null
  follow_up?: Record<string, unknown> | null
  anomalies?: unknown[]
  attempt_count: number
  attempt_history?: unknown[]
  created_at: string
  updated_at: string
}

const STATE_COLOURS: Record<string, string> = {
  verified: 'var(--bp-green)',
  externally_acknowledged: 'var(--bp-blue)',
  executed: 'var(--bp-blue)',
  executing: 'var(--bp-blue)',
  authorized: 'var(--bp-text-3)',
  failed: 'var(--bp-red)',
  ambiguous: 'var(--bp-amber)',
  rejected_pre_execution: 'var(--bp-text-3)',
  cancelled: 'var(--bp-text-3)',
}

const STATE_FILTERS = [
  '', 'verified', 'externally_acknowledged', 'executed', 'authorized',
  'failed', 'ambiguous', 'rejected_pre_execution', 'cancelled',
]

function rel(iso?: string | null) {
  if (!iso) return null
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) }
  catch { return null }
}

const LABEL: React.CSSProperties = {
  fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4,
}
const MONO: React.CSSProperties = { fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }

function StageNode({ label, stage, detail }: { label: string; stage: ReceiptStage; detail?: string | null }) {
  const colour = stage.reached ? 'var(--bp-green)' : 'var(--bp-text-3)'
  return (
    <div style={{ flex: 1, minWidth: 108 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
        {stage.reached
          ? <CheckCircle2 size={12} style={{ color: colour, flexShrink: 0 }} />
          : <Circle size={12} style={{ color: colour, flexShrink: 0, opacity: 0.5 }} />}
        <span style={{
          fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: colour, opacity: stage.reached ? 1 : 0.6,
        }}>{label}</span>
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', paddingLeft: 17 }}>
        {stage.reached ? (rel(stage.at) ?? '—') : 'not reached'}
      </div>
      {stage.reached && detail && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', paddingLeft: 17, wordBreak: 'break-all' }}>
          {detail}
        </div>
      )}
    </div>
  )
}

function StateChain({ receipt }: { receipt: Receipt }) {
  const s = receipt.states
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '10px 0', borderTop: '1px solid var(--bp-border)', marginTop: 8 }}>
      <StageNode label="Requested" stage={s.requested} detail={s.requested.by} />
      <StageNode label="Authorized" stage={s.authorized} detail={s.authorized.by} />
      <StageNode label="Executed" stage={s.executed} />
      <StageNode
        label="Acknowledged"
        stage={s.externally_acknowledged}
        detail={s.externally_acknowledged.external_id
          ? `${s.externally_acknowledged.system ?? 'external'} · ${s.externally_acknowledged.external_id}`
          : null}
      />
      <StageNode
        label="Verified"
        stage={s.verified}
        detail={(s.verified.evidence?.verdict as string | undefined) ?? null}
      />
    </div>
  )
}

function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const [expanded, setExpanded] = useState(false)
  const colour = STATE_COLOURS[receipt.state] ?? 'var(--bp-text-3)'
  const ack = receipt.states.externally_acknowledged

  return (
    <div className="bp-card" style={{ padding: 16, marginBottom: 10, borderLeft: `3px solid ${colour}`, cursor: 'pointer' }}
      onClick={() => setExpanded((e) => !e)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <ReceiptText size={13} style={{ color: colour }} />
        <span className="bp-pill" style={{ fontSize: 9, color: colour, borderColor: colour }}>{receipt.state}</span>
        {receipt.action_type && (
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{receipt.action_type}</span>
        )}
        {receipt.result_status !== 'pending' && (
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>result: {receipt.result_status}</span>
        )}
        {receipt.attempt_count > 1 && (
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-amber)' }}>{receipt.attempt_count} attempts</span>
        )}
        {Array.isArray(receipt.anomalies) && receipt.anomalies.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-amber)' }}>
            <ShieldAlert size={11} /> {receipt.anomalies.length} anomaly
          </span>
        )}
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginLeft: 'auto' }}>
          {rel(receipt.updated_at) ?? '—'}
        </span>
      </div>

      <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13, color: 'var(--bp-text)', marginBottom: 4 }}>
        {receipt.title ?? receipt.task_id}
      </div>
      {receipt.result_summary && (
        <div style={{ ...MONO, lineHeight: 1.5 }}>{receipt.result_summary}</div>
      )}

      {receipt.rejection && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 6 }}>
          <XCircle size={12} style={{ color: 'var(--bp-text-3)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ ...MONO, color: 'var(--bp-text-3)' }}>
            Rejected before execution at the <strong>{receipt.rejection.stage}</strong> gate
            {receipt.rejection.by ? ` by ${receipt.rejection.by}` : ''}.
          </div>
        </div>
      )}

      <StateChain receipt={receipt} />

      {ack.permalink && (
        <a href={ack.permalink} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)' }}>
          <ExternalLink size={11} /> {ack.permalink}
        </a>
      )}

      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bp-border)' }}>
          <div style={{ marginBottom: 8 }}>
            <div style={LABEL}>Correlation key (retries and duplicates map here)</div>
            <div style={{ ...MONO, wordBreak: 'break-all' }}>{receipt.correlation_key}</div>
            <div style={{ ...MONO, color: 'var(--bp-text-3)' }}>
              task {receipt.task_id} · approved version {receipt.task_version} · receipt schema v{receipt.receipt_version}
            </div>
          </div>

          {receipt.states.verified.evidence ? (
            <div style={{ marginBottom: 8 }}>
              <div style={LABEL}>Verification evidence</div>
              <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(receipt.states.verified.evidence, null, 2)}
              </pre>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <HelpCircle size={12} style={{ color: 'var(--bp-text-3)' }} />
              <span style={{ ...MONO, color: 'var(--bp-text-3)' }}>
                No independent verification yet — nothing has confirmed this change actually took effect.
              </span>
            </div>
          )}

          {receipt.external_reference && (
            <div style={{ marginBottom: 8 }}>
              <div style={LABEL}>External reference (redacted)</div>
              <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(receipt.external_reference, null, 2)}
              </pre>
            </div>
          )}

          {Array.isArray(receipt.attempt_history) && receipt.attempt_history.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={LABEL}>Attempts</div>
              <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(receipt.attempt_history, null, 2)}
              </pre>
            </div>
          )}

          {Array.isArray(receipt.anomalies) && receipt.anomalies.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={LABEL}>Anomalies</div>
              <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-amber)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(receipt.anomalies, null, 2)}
              </pre>
            </div>
          )}

          {receipt.follow_up && (
            <div>
              <div style={LABEL}>Follow-up</div>
              <pre style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', background: 'var(--bp-surface-2)', padding: 8, borderRadius: 3, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(receipt.follow_up, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Receipts() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [state, setState] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!currentBusiness) return
    try {
      const result = await getActionReceipts(currentBusiness.id, { state: state || undefined, limit: 100 })
      setReceipts(result?.receipts || [])
      setSummary(result?.summary || {})
      setTotal(result?.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setReceipts([]); setSummary({}); setTotal(0)
      setError((err as Error).message)
    }
  }, [currentBusiness, state])

  useEffect(() => { load() }, [load])

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  const verified = summary.verified ?? 0
  const acknowledged = summary.externally_acknowledged ?? 0
  const ambiguous = summary.ambiguous ?? 0

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>ACTION RECEIPTS</h1>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
          What was actually done, and what proves it. An external acknowledgement means the API accepted the
          call — only VERIFIED means a later measurement confirmed the change took effect. {total} recorded.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 18 }}>
        {[
          { label: 'Verified', value: verified, colour: 'var(--bp-green)', sub: 'independently confirmed' },
          { label: 'Acknowledged only', value: acknowledged, colour: 'var(--bp-blue)', sub: 'API accepted, unverified' },
          { label: 'Ambiguous', value: ambiguous, colour: 'var(--bp-amber)', sub: 'needs a human check' },
        ].map((card) => (
          <div key={card.label} className="bp-card" style={{ padding: 14 }}>
            <div style={LABEL}>{card.label}</div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 22, color: card.colour }}>{card.value}</div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{card.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <select className="bp-input" style={{ fontSize: 12 }} value={state} onChange={(e) => setState(e.target.value)}>
          {STATE_FILTERS.map((s) => <option key={s} value={s}>{s || 'All states'}</option>)}
        </select>
      </div>

      {error && (
        <div style={{ ...MONO, color: 'var(--bp-red)', marginBottom: 12 }}>{error}</div>
      )}

      {receipts.length === 0 && !error ? (
        <div style={{ ...MONO, color: 'var(--bp-text-3)', padding: 30, textAlign: 'center' }}>
          No action receipts yet. One is created for every task that reaches the approval/execution path.
        </div>
      ) : (
        receipts.map((r) => <ReceiptCard key={r.id} receipt={r} />)
      )}
    </div>
  )
}
