import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, ChevronLeft, RefreshCw } from 'lucide-react'
import useStore from '../../lib/store.js'
import {
  getAgentRoster, getAgentProposals, runAgent,
  approveAgentProposal, rejectAgentProposal,
} from '../../lib/api.js'
import type { AgentRosterEntry, ProposedAgent, AgentSidebarGroup } from '../../types/index.js'
import { groupRoster, GROUP_LABELS, GROUP_ORDER } from './agentPresentation.js'
import AgentCard from './AgentCard.js'
import ProposedAgentCard from './ProposedAgentCard.js'
import AgentDetailDrawer from './AgentDetailDrawer.js'

const ACTIVITY_EVENTS = new Set([
  'agent_run_started', 'agent_run_complete', 'agent_run_failed', 'agent_activated',
])

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 4px 6px',
      fontFamily: 'var(--bp-font-mono)', fontSize: 9.5, letterSpacing: '0.1em',
      textTransform: 'uppercase', color: 'var(--bp-text-3)',
    }}>
      <span>{label}</span>
      <span style={{ background: 'var(--bp-surface-3)', borderRadius: 999, padding: '0 6px', color: 'var(--bp-text-2)' }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--bp-border)' }} />
    </div>
  )
}

export interface AgentSidebarProps {
  open: boolean
  onToggle: () => void
}

/**
 * The redesigned right sidebar. Roster grouped by what each agent is doing
 * (Working / Awaiting approval / Triggered / Blocked / Recently completed /
 * Standby), suggested hires up top (approval-gated), and a detail drawer per
 * agent. Live via SSE; everything is real server state — no fabricated activity.
 */
export default function AgentSidebar({ open, onToggle }: AgentSidebarProps) {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [roster, setRoster] = useState<AgentRosterEntry[] | null>(null)
  const [proposals, setProposals] = useState<ProposedAgent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openAgentId, setOpenAgentId] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const businessId = currentBusiness?.id ?? null

  const load = useCallback(async () => {
    if (!businessId) return
    try {
      const [r, p] = await Promise.all([
        getAgentRoster(businessId),
        getAgentProposals(businessId).catch(() => ({ proposals: [] as ProposedAgent[], business_id: businessId })),
      ])
      setRoster(r.agents)
      setProposals(p.proposals ?? [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [businessId])

  useEffect(() => {
    setRoster(null)
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [load])

  // Live updates via the dashboard SSE bus.
  useEffect(() => {
    if (!businessId) return
    let es: EventSource | undefined
    try {
      es = new EventSource(`/api/dashboard/stream/${businessId}`)
      es.onmessage = (evt) => {
        try {
          const { type } = JSON.parse(evt.data) as { type?: string }
          if (type && ACTIVITY_EVENTS.has(type)) { load(); setRefreshKey((k) => k + 1) }
        } catch { /* ignore keep-alives */ }
      }
      es.onerror = () => { try { es?.close() } catch { /* noop */ } }
    } catch { /* SSE unavailable */ }
    return () => { try { es?.close() } catch { /* noop */ } }
  }, [businessId, load])

  const grouped = useMemo(() => (roster ? groupRoster(roster) : null), [roster])
  const openAgent = useMemo(
    () => (roster && openAgentId ? roster.find((a) => a.id === openAgentId) ?? null : null),
    [roster, openAgentId],
  )

  async function handleRun(agentId: string) {
    if (!businessId) return
    setRunning(agentId)
    try { await runAgent(agentId, { business_id: businessId }); setTimeout(load, 800) }
    catch { /* surfaced via roster refresh */ }
    finally { setTimeout(() => setRunning(null), 1200) }
  }

  async function handleApprove(taskId: string) {
    await approveAgentProposal(taskId); await load()
  }
  async function handleReject(taskId: string) {
    await rejectAgentProposal(taskId); await load()
  }

  const width = open ? 312 : 48

  // Collapsed rail.
  if (!open) {
    const busyCount = roster?.filter((a) => a.busy).length ?? 0
    return (
      <aside style={railStyle(width)}>
        <button onClick={onToggle} style={railToggle} title="Expand agents panel">
          <ChevronLeft size={14} />
        </button>
        <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.14em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginTop: 12 }}>
          Agents{busyCount ? ` · ${busyCount} working` : ''}
        </div>
      </aside>
    )
  }

  const activeCount = roster?.filter((a) => a.lifecycle_state !== 'archived').length ?? 0

  return (
    <aside style={panelStyle(width)}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 14px', borderBottom: '1px solid var(--bp-border)' }}>
        <div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 14, fontWeight: 700, color: 'var(--bp-text)' }}>Your team</div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9.5, color: 'var(--bp-text-3)' }}>
            {activeCount} specialist{activeCount === 1 ? '' : 's'}{proposals.length ? ` · ${proposals.length} suggested` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => { load(); setRefreshKey((k) => k + 1) }} style={iconBtn} title="Refresh"><RefreshCw size={13} /></button>
          <button onClick={onToggle} style={iconBtn} title="Collapse"><ChevronRight size={14} /></button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 12px 16px' }}>
        {/* Loading */}
        {roster === null && !error && (
          <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 11.5, color: 'var(--bp-text-3)' }}>Loading your team…</div>
        )}

        {/* Error */}
        {error && (
          <div style={{ margin: '12px 0', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(255,82,82,0.25)', background: 'rgba(255,82,82,0.08)', fontSize: 11.5, color: 'var(--bp-red)' }}>
            Couldn’t load agents: {error}
            <button onClick={load} style={{ ...iconBtn, display: 'block', marginTop: 6, color: 'var(--bp-text-2)', fontSize: 11, fontFamily: 'var(--bp-font-mono)' }}>Retry</button>
          </div>
        )}

        {/* Suggested hires (approval-gated) */}
        {proposals.length > 0 && (
          <>
            <GroupHeader label="Suggested hires" count={proposals.length} />
            {proposals.map((p) => (
              <ProposedAgentCard key={p.task_id} proposal={p} onApprove={handleApprove} onReject={handleReject} />
            ))}
          </>
        )}

        {/* Grouped roster */}
        {grouped && GROUP_ORDER.map((g: AgentSidebarGroup) => {
          const list = grouped[g]
          if (!list || list.length === 0) return null
          return (
            <div key={g}>
              <GroupHeader label={GROUP_LABELS[g]} count={list.length} />
              {list.map((a) => (
                <AgentCard key={a.id} agent={a} onOpen={setOpenAgentId} />
              ))}
            </div>
          )
        })}

        {/* Empty state */}
        {grouped && roster && roster.filter((a) => a.lifecycle_state !== 'archived').length === 0 && proposals.length === 0 && !error && (
          <div style={{ padding: '28px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, marginBottom: 8 }}>🧑‍💼</div>
            <div style={{ fontSize: 12.5, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>No specialists hired yet.</div>
            <div style={{ fontSize: 11, color: 'var(--bp-text-3)', marginTop: 4, lineHeight: 1.5 }}>
              Connect data sources and Blueprint will suggest specialists to hire.
            </div>
          </div>
        )}
      </div>

      {/* Detail drawer */}
      <AgentDetailDrawer
        agent={openAgent}
        onClose={() => setOpenAgentId(null)}
        onRun={handleRun}
        running={running === openAgentId}
        refreshKey={refreshKey}
      />
    </aside>
  )
}

// ── styles ────────────────────────────────────────────────────────────────────

function panelStyle(width: number): React.CSSProperties {
  return {
    width, borderLeft: '1px solid var(--bp-border)', background: 'var(--bp-surface)',
    display: 'flex', flexDirection: 'column', transition: 'width 180ms ease',
    overflow: 'hidden', flexShrink: 0,
  }
}
function railStyle(width: number): React.CSSProperties {
  return {
    width, borderLeft: '1px solid var(--bp-border)', background: 'var(--bp-surface)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', transition: 'width 180ms ease',
    flexShrink: 0, paddingTop: 12,
  }
}
const iconBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', color: 'var(--bp-text-3)', padding: 4, borderRadius: 6,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}
const railToggle: React.CSSProperties = { ...iconBtn }
