import { useState } from 'react'
import { ChevronDown, ChevronUp, Wrench, ShieldCheck, FileSearch, Clock, AlertTriangle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import type { AgentRosterEntry } from '../../types/index.js'
import { statusStyleFor, channelLabel, coerceUtc, formatConfidence } from './agentPresentation.js'

function rel(iso: string | null | undefined): string {
  if (!iso) return '—'
  try { return formatDistanceToNow(new Date(coerceUtc(iso)), { addSuffix: true }) } catch { return '—' }
}

function StatusBadge({ agent }: { agent: AgentRosterEntry }) {
  const s = statusStyleFor(agent)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 999, background: s.tint,
      fontFamily: 'var(--bp-font-mono)', fontSize: 10, fontWeight: 500,
      color: s.color, letterSpacing: '0.02em', whiteSpace: 'nowrap',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: s.color, flexShrink: 0,
        animation: s.pulse ? 'bp-pulse 1.5s ease-in-out infinite' : 'none',
        boxShadow: s.pulse ? `0 0 6px ${s.color}` : 'none',
      }} />
      {s.label}
    </span>
  )
}

function MetaRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, color: 'var(--bp-text-2)', fontSize: 11, lineHeight: 1.5 }}>
      <span style={{ color: 'var(--bp-text-3)', flexShrink: 0, marginTop: 1 }}>{icon}</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  )
}

export interface AgentCardProps {
  agent: AgentRosterEntry
  onOpen: (agentId: string) => void
}

/**
 * A single agent row in the sidebar roster. Collapsed: name, role, status,
 * current task / trigger reason. Expanded: confidence, tools, evidence, last
 * action, next check, risk. Click the header to open the full detail drawer.
 */
export default function AgentCard({ agent, onOpen }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false)
  const confidence = formatConfidence(agent.confidence)
  const inCooldown = !!agent.cooldown_until && new Date(coerceUtc(agent.cooldown_until)).getTime() > Date.now()

  return (
    <div style={{
      border: '1px solid var(--bp-border)', borderRadius: 10,
      background: 'var(--bp-surface-2)', marginBottom: 8, overflow: 'hidden',
    }}>
      {/* Header — click to open the drawer */}
      <button
        onClick={() => onOpen(agent.id)}
        style={{
          all: 'unset', boxSizing: 'border-box', display: 'flex', gap: 9, width: '100%',
          padding: '10px 11px', cursor: 'pointer', alignItems: 'center',
        }}
        title={`Open ${agent.name} details`}
      >
        <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0 }}>{agent.avatar}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--bp-text)', fontFamily: 'var(--bp-font-display)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent.name}
          </span>
          {agent.role && (
            <span style={{ display: 'block', fontSize: 10.5, color: 'var(--bp-text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {agent.role}
            </span>
          )}
        </span>
        <StatusBadge agent={agent} />
      </button>

      {/* Always-visible context: what it's doing + why */}
      <div style={{ padding: '0 11px 9px 11px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {agent.current_task && (
          <MetaRow icon={<FileSearch size={12} />}>
            <span style={{ color: 'var(--bp-text)' }}>{agent.current_task.title}</span>
          </MetaRow>
        )}
        {agent.trigger_reason && (
          <MetaRow icon={<span style={{ fontSize: 11 }}>↳</span>}>
            <span style={{ fontStyle: 'italic' }}>{agent.trigger_reason}</span>
          </MetaRow>
        )}
        {inCooldown && (
          <MetaRow icon={<Clock size={12} />}>
            <span style={{ color: 'var(--bp-amber)' }}>Cooling down — resumes {rel(agent.cooldown_until)}</span>
          </MetaRow>
        )}
        {agent.last_error && agent.lifecycle_state === 'blocked' && (
          <MetaRow icon={<AlertTriangle size={12} />}>
            <span style={{ color: 'var(--bp-red)' }}>{agent.last_error.slice(0, 120)}</span>
          </MetaRow>
        )}

        {/* Compact stat strip */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 2, fontSize: 10, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
          {confidence && <span title="Confidence in the current assignment">conf {confidence}</span>}
          {agent.evidence_count > 0 && <span title="Pieces of evidence gathered">{agent.evidence_count} evidence</span>}
          {agent.success_rate != null && <span title="Lifetime success rate">{Math.round(agent.success_rate * 100)}% success</span>}
          {agent.tools_allowed.length > 0 && <span title="Tools enabled">{agent.tools_allowed.length} tools</span>}
        </div>

        {/* Expand toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
          style={{
            all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 10, color: 'var(--bp-text-3)', marginTop: 3, fontFamily: 'var(--bp-font-mono)',
          }}
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? 'Less' : 'Details'}
        </button>

        {expanded && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4, paddingTop: 6, borderTop: '1px solid var(--bp-border)' }}>
            {agent.tools_allowed.length > 0 && (
              <MetaRow icon={<Wrench size={12} />}>
                <span style={{ color: 'var(--bp-text-3)' }}>Tools: </span>{agent.tools_allowed.join(', ')}
              </MetaRow>
            )}
            <MetaRow icon={<ShieldCheck size={12} />}>
              <span style={{ color: 'var(--bp-text-3)' }}>Approval: </span>
              {agent.requires_approval ? 'required before any action' : 'auto for low-risk'}
            </MetaRow>
            <MetaRow icon={<Clock size={12} />}>
              <span style={{ color: 'var(--bp-text-3)' }}>Last action: </span>{agent.last_action ?? '—'}
              <span style={{ color: 'var(--bp-text-3)' }}> · {rel(agent.last_run_at)}</span>
            </MetaRow>
            <MetaRow icon={<Clock size={12} />}>
              <span style={{ color: 'var(--bp-text-3)' }}>Next check: </span>
              {agent.next_check_minutes ? `~${agent.next_check_minutes} min poll` : 'event-driven'}
            </MetaRow>
            {agent.trigger_source && (
              <MetaRow icon={<span style={{ fontSize: 11 }}>⚡</span>}>
                <span style={{ color: 'var(--bp-text-3)' }}>Triggered by: </span>{channelLabel(agent.trigger_source)}
                {agent.matched_areas.length > 0 && <span style={{ color: 'var(--bp-text-3)' }}> · {agent.matched_areas.join(', ')}</span>}
              </MetaRow>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
