import { useState } from 'react'
import { Check, X, ShieldAlert, Database, Zap } from 'lucide-react'
import type { ProposedAgent } from '../../types/index.js'
import { RISK_STYLES, formatConfidence } from './agentPresentation.js'

export interface ProposedAgentCardProps {
  proposal: ProposedAgent
  onApprove: (taskId: string) => Promise<void> | void
  onReject: (taskId: string) => Promise<void> | void
}

/**
 * A SUGGESTED agent — explicitly NOT auto-hired. Surfaces why it's needed, the
 * gap it fills, what it can access/do, its risk level and confidence, with
 * Approve / Reject controls. Approving hires it onto standby (it still won't run
 * until a real trigger fires).
 */
export default function ProposedAgentCard({ proposal, onApprove, onReject }: ProposedAgentCardProps) {
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null)
  const risk = RISK_STYLES[proposal.risk_level]
  const confidence = formatConfidence(proposal.confidence)

  async function act(kind: 'approve' | 'reject') {
    setBusy(kind)
    try { await (kind === 'approve' ? onApprove(proposal.task_id) : onReject(proposal.task_id)) }
    finally { setBusy(null) }
  }

  return (
    <div style={{
      border: '1px dashed var(--bp-border-2)', borderRadius: 10,
      background: 'var(--bp-surface-2)', marginBottom: 8, padding: '11px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        <span style={{
          fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.08em',
          color: 'var(--bp-purple)', background: 'rgba(157,122,255,0.14)',
          padding: '2px 7px', borderRadius: 999, textTransform: 'uppercase',
        }}>Suggested hire</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: risk.color, fontFamily: 'var(--bp-font-mono)' }}>
          <ShieldAlert size={11} /> {risk.label}
        </span>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--bp-text)', fontFamily: 'var(--bp-font-display)', marginBottom: 2 }}>
        {proposal.role ?? proposal.title}
      </div>
      {proposal.why_needed && (
        <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
          {proposal.why_needed}
        </p>
      )}

      {proposal.gap_filled && (
        <div style={{ fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 6, lineHeight: 1.5 }}>
          <span style={{ color: 'var(--bp-text-3)' }}>Fills the gap: </span>{proposal.gap_filled}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        {proposal.can_access.length > 0 && (
          <div style={{ display: 'flex', gap: 6, fontSize: 10.5, color: 'var(--bp-text-2)' }}>
            <Database size={12} style={{ color: 'var(--bp-text-3)', flexShrink: 0, marginTop: 1 }} />
            <span><span style={{ color: 'var(--bp-text-3)' }}>Can access: </span>{proposal.can_access.join(', ')}</span>
          </div>
        )}
        {proposal.can_do.length > 0 && (
          <div style={{ display: 'flex', gap: 6, fontSize: 10.5, color: 'var(--bp-text-2)' }}>
            <Zap size={12} style={{ color: 'var(--bp-text-3)', flexShrink: 0, marginTop: 1 }} />
            <span><span style={{ color: 'var(--bp-text-3)' }}>Can do: </span>{proposal.can_do.slice(0, 6).join(', ')}{proposal.can_do.length > 6 ? '…' : ''}</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '4px 10px', flexWrap: 'wrap', fontSize: 10, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', marginBottom: 9 }}>
        {confidence && <span>fit {confidence}</span>}
        {proposal.estimated_impact && <span title={proposal.estimated_impact}>est. impact ✓</span>}
        {proposal.requires_approval && <span>approval-gated</span>}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={() => act('approve')}
          disabled={busy !== null}
          style={{
            flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            padding: '7px 10px', borderRadius: 7, cursor: busy ? 'default' : 'pointer',
            border: '1px solid var(--bp-green)', background: 'rgba(0,201,167,0.12)',
            color: 'var(--bp-green)', fontFamily: 'var(--bp-font-mono)', fontSize: 11, fontWeight: 500,
            opacity: busy === 'reject' ? 0.5 : 1,
          }}
        >
          <Check size={13} /> {busy === 'approve' ? 'Hiring…' : 'Approve'}
        </button>
        <button
          onClick={() => act('reject')}
          disabled={busy !== null}
          style={{
            flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            padding: '7px 10px', borderRadius: 7, cursor: busy ? 'default' : 'pointer',
            border: '1px solid var(--bp-border-2)', background: 'transparent',
            color: 'var(--bp-text-2)', fontFamily: 'var(--bp-font-mono)', fontSize: 11,
            opacity: busy === 'approve' ? 0.5 : 1,
          }}
        >
          <X size={13} /> {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
    </div>
  )
}
