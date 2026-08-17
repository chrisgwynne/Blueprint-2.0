import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import {
  Play, Pause, RefreshCw, Download, ChevronRight, Cpu, AlertCircle,
  Clock, Zap, TrendingUp, Package, UserPlus, Sparkles, Archive, ShieldCheck,
} from 'lucide-react'
import useStore from '../lib/store.js'
import {
  getAgents, runAgent, updateAgent, getAgentTemplates, installAgent,
  hireAgent, getHireRecommendations, getAgentRoster, retireAgent,
} from '../lib/api.js'

// ─── Retention verdict badge ───────────────────────────────────────────────────

const RETENTION_COLORS: Record<string, string> = {
  retain: 'var(--bp-green)',
  monitor: 'var(--bp-text-3)',
  downgrade: 'var(--bp-amber)',
  retire: 'var(--bp-red)',
}

function RetentionBadge({ retention, hasVerifiedOutcome }: { retention: any; hasVerifiedOutcome?: boolean | null }) {
  if (!retention) return null
  // No measured trials yet — this is an installed/standby agent, not (yet)
  // an agent with productive activity behind it. Say so plainly rather than
  // implying a verdict the evidence doesn't support.
  if (retention.evidence?.trials_total === 0) {
    return (
      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', border: '1px solid var(--bp-border)', borderRadius: 3, padding: '1px 5px' }}>
        No verified outcome yet
      </span>
    )
  }
  const color = RETENTION_COLORS[retention.verdict] ?? 'var(--bp-text-3)'
  return (
    <span
      title={retention.reason}
      style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color, border: `1px solid ${color}55`, borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'inline-flex', alignItems: 'center', gap: 3 }}
    >
      {hasVerifiedOutcome && <ShieldCheck size={9} />}
      {retention.verdict}
    </span>
  )
}

// ─── Provider badge ───────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'var(--bp-blue)',
  openai:    'var(--bp-green)',
  google:    'var(--bp-amber)',
  ollama:    'var(--bp-purple)',
  lmstudio:  'var(--bp-orange)',
  custom:    'var(--bp-muted)',
}

function ProviderBadge({ llm }: { llm: any }) {
  if (!llm?.provider && !llm?.model) return null
  const color = PROVIDER_COLORS[llm?.provider] ?? 'var(--bp-muted)'
  const label = llm?.model ? llm.model.split('-').slice(0, 2).join('-') : llm?.provider
  return (
    <span style={{
      fontFamily: 'var(--bp-font-mono)', fontSize: 9, color,
      border: `1px solid ${color}33`, borderRadius: 3, padding: '1px 5px',
      letterSpacing: '0.04em',
    }}>
      {label}
    </span>
  )
}

// ─── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const cls = status === 'running' ? 'pulse-dot-blue' :
              status === 'active'  ? 'pulse-dot-green' :
              status === 'error'   ? 'pulse-dot-red' : 'pulse-dot-gray'
  return <span className={`pulse-dot ${cls}`} />
}

// ─── Installed agent card ─────────────────────────────────────────────────────

interface AgentCardProps {
  agent: any
  rosterEntry?: any
  onNavigate: (id: string) => void
  onRun: (agent: any) => Promise<void>
  onToggle: (agent: any) => Promise<void>
  onRetire: (agent: any) => Promise<void>
  retiring?: boolean
}

function AgentCard({ agent, rosterEntry, onNavigate, onRun, onToggle, onRetire, retiring }: AgentCardProps) {
  const [running, setRunning] = useState(false)
  const [toggling, setToggling] = useState(false)

  const isConductor = agent.id === 'conductor'
  const isActive = agent.status === 'active' || agent.status === 'running'
  const isRetired = agent.status === 'retired'
  const ps = agent.profile_summary ?? {}
  const stats = agent.stats_7d ?? {}
  const retention = rosterEntry?.retention ?? null
  const currentTaskTitle = rosterEntry?.current_task?.title ?? null
  const lastVerdict = retention?.evidence?.last_verdict ?? null

  async function handleRun(e: React.MouseEvent) {
    e.stopPropagation()
    setRunning(true)
    try { await onRun(agent) }
    finally { setRunning(false) }
  }

  async function handleToggle(e: React.MouseEvent) {
    e.stopPropagation()
    setToggling(true)
    try { await onToggle(agent) }
    finally { setToggling(false) }
  }

  async function handleRetire(e: React.MouseEvent) {
    e.stopPropagation()
    await onRetire(agent)
  }

  return (
    <div
      onClick={() => onNavigate(agent.id)}
      className="bp-card"
      style={{
        display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
        cursor: 'pointer', position: 'relative',
        transition: 'border-color 150ms, transform 150ms',
        borderColor: isConductor ? 'var(--bp-blue)44' : undefined,
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = isConductor ? 'var(--bp-blue)88' : 'var(--bp-border-hover, #2a5070)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = isConductor ? 'var(--bp-blue)44' : ''; e.currentTarget.style.transform = '' }}
    >
      {/* Conductor accent strip */}
      {isConductor && (
        <div style={{ height: 2, background: 'linear-gradient(90deg, var(--bp-blue), var(--bp-purple))' }} />
      )}

      {/* Header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bp-border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ fontSize: 26, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>
            {ps.avatar ?? '🤖'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)' }}>
                {agent.name}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                <StatusDot status={agent.status} />
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', letterSpacing: '0.08em' }}>
                  {agent.status?.toUpperCase()}
                </span>
              </div>
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: retention ? 6 : 0 }}>
              {ps.title ?? agent.title ?? ''}
            </div>
            {retention && <RetentionBadge retention={retention} hasVerifiedOutcome={rosterEntry?.has_verified_outcome} />}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ padding: '10px 16px', flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
        {/* LLM — only show a specific model when the profile explicitly
            overrides. Otherwise the agent inherits the global default set
            in Settings → LLM Providers, so we don't mislead the user into
            thinking it's pinned to Claude when they've switched default. */}
        {ps.llm?.model_override && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Cpu size={10} />Model
            </span>
            <ProviderBadge llm={ps.llm} />
          </div>
        )}

        {/* Current work (#69) */}
        {currentTaskTitle && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <Zap size={10} />Working on
            </span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {currentTaskTitle}
            </span>
          </div>
        )}

        {/* Last verified outcome (#69) */}
        {lastVerdict && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Last verified outcome</span>
            <span style={{
              fontFamily: 'var(--bp-font-mono)', fontSize: 10,
              color: lastVerdict === 'successful' ? 'var(--bp-green)' : lastVerdict === 'unsuccessful' ? 'var(--bp-red)' : 'var(--bp-text-2)',
            }}>
              {lastVerdict}
            </span>
          </div>
        )}

        {/* Last run */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Clock size={10} />Last run
          </span>
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)' }}>
            {agent.last_run ? formatDistanceToNow(parseTimestamp(agent.last_run) || new Date(), { addSuffix: true }) : 'Never'}
          </span>
        </div>

        {/* 7d stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 2 }}>
          {[
            { label: 'Runs', value: stats.runs ?? 0, icon: <Zap size={10} /> },
            { label: 'Tasks', value: stats.tasks_proposed ?? 0, icon: <TrendingUp size={10} /> },
            { label: 'Cost', value: stats.cost_usd != null ? `$${Number(stats.cost_usd).toFixed(3)}` : '$0.000', icon: null },
          ].map(({ label, value, icon }) => (
            <div key={label} style={{ textAlign: 'center', padding: '6px 4px', background: 'var(--bp-bg)', borderRadius: 4, border: '1px solid var(--bp-border)' }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--bp-text)' }}>
                {value}
              </div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, marginTop: 1 }}>
                {icon}{label}
              </div>
            </div>
          ))}
        </div>

        {/* Not installed warning */}
        {!agent.installed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'rgba(255,82,82,0.08)', borderRadius: 4, border: '1px solid rgba(255,82,82,0.2)' }}>
            <AlertCircle size={11} style={{ color: 'var(--bp-red)', flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)' }}>
              Not installed — profile missing
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--bp-border)', display: 'flex', gap: 6 }}>
        <button
          onClick={handleRun}
          disabled={running || agent.status === 'running' || !agent.installed}
          className="bp-btn bp-btn-primary"
          style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
        >
          {running
            ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} />
            : <Play size={11} />}
          {running ? 'Running…' : 'Run Now'}
        </button>
        <button
          onClick={handleToggle}
          disabled={toggling || isRetired}
          className="bp-btn bp-btn-secondary"
          style={{ fontSize: 11 }}
          title={isActive ? 'Pause' : 'Enable'}
        >
          {toggling ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : isActive ? <Pause size={11} /> : <Play size={11} />}
        </button>
        {!isConductor && !isRetired && (
          <button
            onClick={handleRetire}
            disabled={retiring}
            className="bp-btn bp-btn-secondary"
            style={{ fontSize: 11, color: 'var(--bp-red)' }}
            title="Retire — stops new work; in-flight work finishes, queued work is unassigned for reassignment"
          >
            {retiring ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Archive size={11} />}
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
          <ChevronRight size={13} style={{ color: 'var(--bp-text-3)' }} />
        </div>
      </div>
    </div>
  )
}

// ─── Template card ────────────────────────────────────────────────────────────

interface TemplateCardProps {
  template: any
  onInstall: (id: string) => Promise<void>
  installing: string | null
}

function TemplateCard({ template, onInstall, installing }: TemplateCardProps) {
  return (
    <div className="bp-card" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', opacity: template.installed ? 0.5 : 1 }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bp-border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ fontSize: 24, lineHeight: 1, flexShrink: 0 }}>{template.avatar ?? '🤖'}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13, color: 'var(--bp-text)', marginBottom: 3 }}>
              {template.name}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
              {template.title ?? ''}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '10px 16px', flex: 1 }}>
        {template.description && (
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5, margin: 0, marginBottom: 8 }}>
            {template.description}
          </p>
        )}

        {/* Connectors */}
        {template.connectors_required?.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>Requires:</span>
            {template.connectors_required.map((c: string) => (
              <span key={c} style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-amber)', border: '1px solid var(--bp-amber)44', borderRadius: 3, padding: '1px 5px' }}>
                {c}
              </span>
            ))}
          </div>
        )}
        {template.llm?.model_override ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>Model:</span>
            <ProviderBadge llm={template.llm} />
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>Uses:</span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-2)' }}>default LLM</span>
          </div>
        )}
      </div>

      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--bp-border)' }}>
        {template.installed ? (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-green)', textAlign: 'center', padding: '6px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            ✓ Installed
          </div>
        ) : (
          <button
            onClick={() => onInstall(template.id)}
            disabled={installing === template.id}
            className="bp-btn bp-btn-secondary"
            style={{ width: '100%', justifyContent: 'center', fontSize: 11 }}
          >
            {installing === template.id
              ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} />
              : <Download size={11} />}
            {installing === template.id ? 'Installing…' : 'Install Agent'}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Recommendation card ──────────────────────────────────────────────────────

interface RecommendationCardProps {
  rec: any
  onHire: (agentId: string) => Promise<void>
  hiring: string | null
}

function RecommendationCard({ rec, onHire, hiring }: RecommendationCardProps) {
  const isHiring = hiring === rec.agent_id
  const confidencePct = Math.round((rec.confidence ?? 0) * 100)
  const confidenceColor = confidencePct >= 80 ? 'var(--bp-green)' : confidencePct >= 60 ? 'var(--bp-amber)' : 'var(--bp-text-3)'

  return (
    <div className="bp-card" style={{
      display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
      borderColor: 'var(--bp-blue)33',
    }}>
      <div style={{ height: 2, background: 'linear-gradient(90deg, var(--bp-blue)88, var(--bp-purple)44)' }} />
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bp-border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ fontSize: 24, lineHeight: 1, flexShrink: 0, marginTop: 2 }}>
            {rec.avatar ?? '🤖'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)' }}>
                {rec.name}
              </span>
              <span style={{
                fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: confidenceColor,
                border: `1px solid ${confidenceColor}55`, borderRadius: 3, padding: '1px 5px',
                marginLeft: 'auto',
              }}>
                {confidencePct}% match
              </span>
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
              {rec.title ?? ''}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '10px 16px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.5, margin: 0 }}>
          {rec.reason}
        </p>
        {rec.expected_value && (
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5, margin: 0, fontStyle: 'italic' }}>
            {rec.expected_value}
          </p>
        )}
        {rec.required_connectors?.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginTop: 2 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>Needs:</span>
            {rec.required_connectors.map((c: string) => (
              <span key={c} style={{
                fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-blue)',
                border: '1px solid var(--bp-blue)44', borderRadius: 3, padding: '1px 5px',
              }}>{c}</span>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--bp-border)' }}>
        <button
          onClick={() => onHire(rec.agent_id)}
          disabled={isHiring}
          className="bp-btn bp-btn-primary"
          style={{ width: '100%', justifyContent: 'center', fontSize: 11 }}
        >
          {isHiring
            ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} />
            : <UserPlus size={11} />}
          {isHiring ? 'Hiring…' : 'Hire Agent'}
        </button>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Agents() {
  const navigate = useNavigate()
  const addNotification = useStore((s) => s.addNotification)
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [agents, setAgents] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<string | null>(null)
  const [recommendations, setRecommendations] = useState<any[]>([])
  const [recsLoading, setRecsLoading] = useState(false)
  const [hiring, setHiring] = useState<string | null>(null)
  // Business-scoped lifecycle cockpit data (#69) — lifecycle_state, current
  // work and retention verdict per agent. Merged onto the installed-agent
  // list below rather than replacing it; GET /agents stays the source of
  // truth for install state, run stats and soul files.
  const [roster, setRoster] = useState<any[]>([])
  const [retiring, setRetiring] = useState<string | null>(null)

  const loadData = useCallback(() => {
    Promise.all([
      getAgents().catch(() => []),
      getAgentTemplates().catch(() => []),
    ]).then(([a, t]) => {
      setAgents(Array.isArray(a) ? a : [])
      setTemplates(Array.isArray(t) ? t : [])
    }).finally(() => setLoading(false))
  }, [])

  const loadRecommendations = useCallback(() => {
    if (!currentBusiness?.id) return
    setRecsLoading(true)
    getHireRecommendations(currentBusiness.id)
      .then((res: any) => setRecommendations(Array.isArray(res?.recommendations) ? res.recommendations : []))
      .catch(() => setRecommendations([]))
      .finally(() => setRecsLoading(false))
  }, [currentBusiness?.id])

  const loadRoster = useCallback(() => {
    if (!currentBusiness?.id) { setRoster([]); return }
    getAgentRoster(currentBusiness.id)
      .then((res: any) => setRoster(Array.isArray(res?.agents) ? res.agents : []))
      .catch(() => setRoster([]))
  }, [currentBusiness?.id])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => { loadRecommendations() }, [loadRecommendations])
  useEffect(() => { loadRoster() }, [loadRoster])

  const rosterById = new Map(roster.map((r: any) => [r.id, r]))

  async function handleRun(agent: any) {
    try {
      await runAgent(agent.id, { business_id: currentBusiness?.id })
      addNotification({ type: 'success', title: agent.name, message: 'Run queued' })
    } catch (err: any) {
      addNotification({ type: 'error', message: err.message })
    }
  }

  async function handleToggle(agent: any) {
    const newStatus = agent.status === 'active' || agent.status === 'running' ? 'paused' : 'active'
    try {
      await updateAgent(agent.id, { status: newStatus })
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, status: newStatus } : a))
      addNotification({ type: 'success', message: `Agent ${newStatus}` })
    } catch (err: any) {
      addNotification({ type: 'error', message: err.message })
    }
  }

  // Retirement (#69) — a distinct, terminal lifecycle state from 'paused'.
  // It stops the agent being selected for new work; in-flight tasks are left
  // to finish and merely-queued tasks are unassigned for reassignment (see
  // POST /agents/:id/retire for the full documented semantics).
  async function handleRetire(agent: any) {
    if (!window.confirm(
      `Retire ${agent.name}? It will no longer be selected for new work. ` +
      `Any in-flight task will be allowed to finish; queued-but-not-started tasks will be unassigned for reassignment.`,
    )) return
    setRetiring(agent.id)
    try {
      const result: any = await retireAgent(agent.id, { business_id: currentBusiness?.id, reason: 'Retired from the Agents page.' })
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, status: 'retired' } : a))
      addNotification({ type: 'success', message: result?.message ?? `${agent.name} retired` })
      loadRoster()
    } catch (err: any) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setRetiring(null)
    }
  }

  async function handleInstall(agentId: string) {
    setInstalling(agentId)
    try {
      await installAgent(agentId)
      addNotification({ type: 'success', message: `Agent '${agentId}' installed` })
      loadData()
    } catch (err: any) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setInstalling(null)
    }
  }

  async function handleHire(agentId: string) {
    if (!currentBusiness?.id) {
      addNotification({ type: 'error', message: 'No business selected' })
      return
    }
    setHiring(agentId)
    try {
      const result = await hireAgent(agentId, currentBusiness.id)
      addNotification({ type: 'success', message: (result as any).message ?? `${agentId} hired` })
      loadData()
      loadRecommendations()
    } catch (err: any) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setHiring(null)
    }
  }

  // Separate installed agents from those that have template entries but aren't in agents list
  const installedIds = new Set(agents.map(a => a.id))
  const installedTemplates = templates.filter(t => installedIds.has(t.id))
  const recommendedIds = new Set(recommendations.map(r => r.agent_id))
  // Exclude from "Available" those that are recommended (shown in their own section)
  const uninstalledTemplates = templates.filter(t => !installedIds.has(t.id) && !recommendedIds.has(t.id))

  // Sort: conductor first
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.id === 'conductor') return -1
    if (b.id === 'conductor') return 1
    return a.name.localeCompare(b.name)
  })

  // Lifecycle buckets:
  //   active  — installed, connectors ready, running normally
  //   pending — installed, waiting for a required connector
  //   retired — archived
  const activeAgents = sortedAgents.filter(a => a.status === 'active' || a.status === 'running')
  const pendingAgents = sortedAgents.filter(a => a.status === 'pending')
  const pausedAgents = sortedAgents.filter(a => a.status === 'paused' || a.status === 'disabled')
  const retiredAgents = sortedAgents.filter(a => a.status === 'retired')
  const activeCount = activeAgents.length

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 22, color: 'var(--bp-text)', marginBottom: 4 }}>
            Agents
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
              {agents.length} installed
            </span>
            {activeCount > 0 && (
              <>
                <span style={{ color: 'var(--bp-border)' }}>·</span>
                <span className="pulse-dot pulse-dot-green" />
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
                  {activeCount} active
                </span>
              </>
            )}
            {recommendations.length > 0 && (
              <>
                <span style={{ color: 'var(--bp-border)' }}>·</span>
                <Sparkles size={11} style={{ color: 'var(--bp-blue)' }} />
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-blue)' }}>
                  {recommendations.length} recommended
                </span>
              </>
            )}
            {uninstalledTemplates.length > 0 && (
              <>
                <span style={{ color: 'var(--bp-border)' }}>·</span>
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
                  {uninstalledTemplates.length} available to install
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bp-card" style={{ padding: 0, overflow: 'hidden', height: 220 }}>
              <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bp-border)' }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div className="bp-skeleton" style={{ width: 32, height: 32, borderRadius: '50%' }} />
                  <div style={{ flex: 1 }}>
                    <div className="bp-skeleton" style={{ height: 13, width: '55%', marginBottom: 6, borderRadius: 3 }} />
                    <div className="bp-skeleton" style={{ height: 10, width: '40%', borderRadius: 3 }} />
                  </div>
                </div>
              </div>
              <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[100, 80, 90].map((w, j) => (
                  <div key={j} className="bp-skeleton" style={{ height: 10, width: `${w}%`, borderRadius: 3 }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Active agents */}
      {!loading && activeAgents.length > 0 && (
        <>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>
            Active — {activeAgents.length} agent{activeAgents.length !== 1 ? 's' : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 36 }}>
            {activeAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                rosterEntry={rosterById.get(agent.id)}
                onNavigate={(id) => navigate(`/agents/${id}`)}
                onRun={handleRun}
                onToggle={handleToggle}
                onRetire={handleRetire}
                retiring={retiring === agent.id}
              />
            ))}
          </div>
        </>
      )}

      {/* Pending agents — installed but waiting for a required connector */}
      {!loading && pendingAgents.length > 0 && (
        <>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>
            Pending — {pendingAgents.length} agent{pendingAgents.length !== 1 ? 's' : ''} waiting for connectors
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 36 }}>
            {pendingAgents.map(agent => {
              const required = agent.connectors_required ?? agent.required_connectors ?? []
              return (
                <div key={agent.id} className="bp-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(250,204,21,0.12)', color: 'var(--bp-amber)', fontSize: 16 }}>
                      {agent.avatar ?? '⏳'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13 }}>{agent.name}</div>
                      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-amber)' }}>Pending — waiting for connector</div>
                    </div>
                  </div>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
                    {required.length > 0
                      ? <>Requires <strong>{required.join(', ')}</strong>. Connect {required.length > 1 ? 'these connectors' : 'it'} and this agent activates automatically.</>
                      : 'Waiting for initial readiness check.'}
                  </div>
                  <button
                    onClick={() => navigate('/connectors')}
                    className="bp-btn bp-btn-secondary"
                    style={{ fontSize: 11, alignSelf: 'flex-start' }}
                  >
                    Go to Connectors →
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Paused agents (if any) */}
      {!loading && pausedAgents.length > 0 && (
        <>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>
            Paused — {pausedAgents.length}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 36 }}>
            {pausedAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                rosterEntry={rosterById.get(agent.id)}
                onNavigate={(id) => navigate(`/agents/${id}`)}
                onRun={handleRun}
                onToggle={handleToggle}
                onRetire={handleRetire}
                retiring={retiring === agent.id}
              />
            ))}
          </div>
        </>
      )}

      {/* Retired agents — kept visible (not deleted) so ownership, cost and
          past outcomes remain auditable; distinct from Paused (#69). */}
      {!loading && retiredAgents.length > 0 && (
        <>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Archive size={11} />Retired — {retiredAgents.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 36 }}>
            {retiredAgents.map(agent => {
              const r = rosterById.get(agent.id)
              return (
                <div
                  key={agent.id}
                  onClick={() => navigate(`/agents/${agent.id}`)}
                  className="bp-card"
                  style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', opacity: 0.7 }}
                >
                  <span style={{ fontSize: 18 }}>{agent.profile_summary?.avatar ?? '🤖'}</span>
                  <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13, color: 'var(--bp-text-2)' }}>{agent.name}</span>
                  {r?.retention && <RetentionBadge retention={r.retention} hasVerifiedOutcome={r.has_verified_outcome} />}
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginLeft: 'auto' }}>
                    Not selected for new work
                  </span>
                  <ChevronRight size={13} style={{ color: 'var(--bp-text-3)' }} />
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Recommended by Conductor */}
      {!loading && (recsLoading || recommendations.length > 0) && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={12} style={{ color: 'var(--bp-blue)' }} />
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-blue)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Recommended by Conductor
              </div>
            </div>
            {recsLoading && <RefreshCw size={10} style={{ color: 'var(--bp-text-3)', animation: 'bp-spin-slow 1s linear infinite' }} />}
            <div style={{ flex: 1, height: 1, background: 'var(--bp-blue)22' }} />
          </div>
          {recsLoading && recommendations.length === 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14, marginBottom: 36 }}>
              {[1, 2].map(i => (
                <div key={i} className="bp-card" style={{ padding: 0, overflow: 'hidden', height: 180 }}>
                  <div style={{ height: 2, background: 'var(--bp-border)' }} />
                  <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bp-border)' }}>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <div className="bp-skeleton" style={{ width: 28, height: 28, borderRadius: '50%' }} />
                      <div style={{ flex: 1 }}>
                        <div className="bp-skeleton" style={{ height: 12, width: '50%', marginBottom: 6, borderRadius: 3 }} />
                        <div className="bp-skeleton" style={{ height: 9, width: '35%', borderRadius: 3 }} />
                      </div>
                    </div>
                  </div>
                  <div style={{ padding: '12px 16px' }}>
                    <div className="bp-skeleton" style={{ height: 9, width: '90%', marginBottom: 5, borderRadius: 3 }} />
                    <div className="bp-skeleton" style={{ height: 9, width: '70%', borderRadius: 3 }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14, marginBottom: 36 }}>
              {recommendations.map(rec => (
                <RecommendationCard
                  key={rec.agent_id}
                  rec={rec}
                  onHire={handleHire}
                  hiring={hiring}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Available templates */}
      {!loading && uninstalledTemplates.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Available to hire — {uninstalledTemplates.length}
            </div>
            <div style={{ flex: 1, height: 1, background: 'var(--bp-border)' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {uninstalledTemplates.map(template => (
              <TemplateCard
                key={template.id}
                template={template}
                onInstall={handleInstall}
                installing={installing}
              />
            ))}
          </div>
        </>
      )}

      {/* Empty state */}
      {!loading && agents.length === 0 && templates.length === 0 && (
        <div className="bp-card" style={{ textAlign: 'center', padding: '64px 20px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 14, color: 'var(--bp-text-2)', marginBottom: 6 }}>
            No agents configured
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
            Run the database initialisation script to install core agents
          </div>
        </div>
      )}
    </div>
  )
}
