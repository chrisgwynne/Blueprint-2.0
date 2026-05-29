import { X, Play } from 'lucide-react'
import type { AgentRosterEntry } from '../../types/index.js'
import { statusStyleFor, channelLabel, coerceUtc, formatConfidence } from './agentPresentation.js'
import AgentTimeline from './AgentTimeline.js'
import { formatDistanceToNow } from 'date-fns'

function rel(iso: string | null | undefined): string {
  if (!iso) return '—'
  try { return formatDistanceToNow(new Date(coerceUtc(iso)), { addSuffix: true }) } catch { return '—' }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        fontFamily: 'var(--bp-font-mono)', fontSize: 9.5, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 8,
      }}>{title}</div>
      {children}
    </div>
  )
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <span style={{ fontSize: 11, color: 'var(--bp-text-3)' }}>{empty}</span>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {items.map((t) => (
        <span key={t} style={{
          fontSize: 10.5, fontFamily: 'var(--bp-font-mono)', color: 'var(--bp-text-2)',
          background: 'var(--bp-surface-3)', border: '1px solid var(--bp-border)',
          padding: '2px 7px', borderRadius: 6,
        }}>{t}</span>
      ))}
    </div>
  )
}

function KV({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11.5, padding: '3px 0' }}>
      <span style={{ color: 'var(--bp-text-3)' }}>{k}</span>
      <span style={{ color: color ?? 'var(--bp-text)', textAlign: 'right' }}>{v}</span>
    </div>
  )
}

export interface AgentDetailDrawerProps {
  agent: AgentRosterEntry | null
  onClose: () => void
  onRun: (agentId: string) => void
  running: boolean
  refreshKey?: number
}

/**
 * Slide-in drawer with the full agent profile: scope, allowed tools, trigger
 * rules, permissions, reliability, failure reasons, and the recent-work
 * timeline. Driven entirely from real server state.
 */
export default function AgentDetailDrawer({ agent, onClose, onRun, running, refreshKey = 0 }: AgentDetailDrawerProps) {
  if (!agent) return null
  const s = statusStyleFor(agent)
  const confidence = formatConfidence(agent.confidence)
  const successPct = agent.success_rate != null ? `${Math.round(agent.success_rate * 100)}%` : '—'

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(6,15,30,0.55)', zIndex: 60, backdropFilter: 'blur(1px)' }}
      />
      {/* Panel */}
      <aside style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(420px, 92vw)', zIndex: 61,
        background: 'var(--bp-surface)', borderLeft: '1px solid var(--bp-border-2)',
        display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 32px rgba(0,0,0,0.35)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 18px', borderBottom: '1px solid var(--bp-border)' }}>
          <span style={{ fontSize: 28, lineHeight: 1 }}>{agent.avatar}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 17, fontWeight: 700, color: 'var(--bp-text)' }}>{agent.name}</div>
            {agent.role && <div style={{ fontSize: 11.5, color: 'var(--bp-text-3)' }}>{agent.role}</div>}
          </div>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999,
            background: s.tint, color: s.color, fontFamily: 'var(--bp-font-mono)', fontSize: 10.5,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color, animation: s.pulse ? 'bp-pulse 1.5s ease-in-out infinite' : 'none' }} />
            {s.label}
          </span>
          <button onClick={onClose} style={{ all: 'unset', cursor: 'pointer', color: 'var(--bp-text-3)', padding: 4, marginLeft: 2 }} title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
          {agent.purpose && (
            <Section title="Purpose">
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--bp-text-2)', lineHeight: 1.55 }}>{agent.purpose}</p>
            </Section>
          )}

          {(agent.current_task || agent.trigger_reason) && (
            <Section title="Right now">
              {agent.current_task && (
                <div style={{ fontSize: 12.5, color: 'var(--bp-text)', marginBottom: 4 }}>{agent.current_task.title}</div>
              )}
              {agent.trigger_reason && (
                <div style={{ fontSize: 11.5, color: 'var(--bp-text-2)', fontStyle: 'italic', lineHeight: 1.5 }}>{agent.trigger_reason}</div>
              )}
              <div style={{ marginTop: 6 }}>
                <KV k="Triggered by" v={channelLabel(agent.trigger_source)} />
                {agent.matched_areas.length > 0 && <KV k="Matched areas" v={agent.matched_areas.join(', ')} />}
                {confidence && <KV k="Confidence" v={confidence} />}
                {agent.evidence_count > 0 && <KV k="Evidence gathered" v={String(agent.evidence_count)} />}
              </div>
            </Section>
          )}

          <Section title="Permissions">
            <KV k="Approval" v={agent.requires_approval ? 'Required before any action' : 'Auto for low-risk'} color={agent.requires_approval ? 'var(--bp-amber)' : 'var(--bp-green)'} />
          </Section>

          <Section title="Knowledge scope">
            <Chips items={agent.kb_scope} empty="No scope assigned" />
          </Section>

          <Section title="Data sources allowed">
            <Chips items={agent.data_sources_allowed} empty="None" />
          </Section>

          <Section title="Tools enabled">
            <Chips items={agent.tools_allowed} empty="None" />
          </Section>

          <Section title="Tasks it can own">
            <Chips items={agent.task_types_allowed} empty="None" />
          </Section>

          <Section title="Reliability">
            <KV k="Success rate" v={successPct} color="var(--bp-green)" />
            <KV k="Completed" v={String(agent.success_count)} />
            <KV k="Failures" v={String(agent.failure_count)} color={agent.failure_count > 0 ? 'var(--bp-red)' : undefined} />
            <KV k="Last action" v={agent.last_action ?? '—'} />
            <KV k="Last run" v={rel(agent.last_run_at)} />
            {agent.cooldown_until && new Date(coerceUtc(agent.cooldown_until)).getTime() > Date.now() && (
              <KV k="Cooling down until" v={rel(agent.cooldown_until)} color="var(--bp-amber)" />
            )}
            {agent.last_error && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--bp-red)', background: 'rgba(255,82,82,0.08)', border: '1px solid rgba(255,82,82,0.2)', borderRadius: 6, padding: '6px 8px', lineHeight: 1.45 }}>
                Last failure: {agent.last_error}
              </div>
            )}
          </Section>

          <Section title="Recent activity">
            <AgentTimeline agentId={agent.id} refreshKey={refreshKey} />
          </Section>
        </div>

        {/* Footer actions */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bp-border)', display: 'flex', gap: 8 }}>
          <button
            onClick={() => onRun(agent.id)}
            disabled={running || agent.busy}
            title={agent.busy ? 'Agent is already working' : 'Manually trigger a run now'}
            style={{
              flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '9px 12px', borderRadius: 8, cursor: running || agent.busy ? 'default' : 'pointer',
              border: '1px solid var(--bp-border-2)', background: agent.busy ? 'transparent' : 'rgba(77,166,255,0.1)',
              color: agent.busy ? 'var(--bp-text-3)' : 'var(--bp-blue)', fontFamily: 'var(--bp-font-mono)', fontSize: 12,
            }}
          >
            <Play size={13} /> {running ? 'Starting…' : agent.busy ? 'Busy' : 'Run now'}
          </button>
        </div>
      </aside>
    </>
  )
}
