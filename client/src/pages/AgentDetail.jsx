import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { format, formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import {
  ArrowLeft, Play, Pause, RefreshCw, Save, Trash2,
  Cpu, Clock, Zap, TrendingUp, ChevronDown, ChevronRight,
  CheckCircle, XCircle, AlertCircle, Eye, Code,
} from 'lucide-react'
import useStore from '../lib/store.js'
import ProducedByEvent from '../components/ProducedByEvent.jsx'
import {
  getAgents, getAgentProfile, getAgentRuns, runAgent, updateAgent,
  updateAgentFile, getAgentMemory, clearAgentMemory,
  getLLMProviders, getLLMModels, saveLLMCredentials, testLLMCredentials,
  patchAgentProfile,
  getAgentCalibration, recalculateAgentCalibration,
} from '../lib/api.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const SOUL_FILES = [
  { key: 'IDENTITY.md', label: 'Identity', desc: 'Who am I? First-person voice, role definition.' },
  { key: 'SOUL.md',     label: 'Soul',     desc: 'Values, principles, what I will and will not do.' },
  { key: 'HEARTBEAT.md',label: 'Heartbeat',desc: 'Scheduled jobs and run cadence.' },
  { key: 'AGENTS.md',   label: 'Agents',   desc: 'Cross-agent relationships and communication.' },
]

const TABS = [
  { id: 'soul',        label: 'Soul Files' },
  { id: 'runs',        label: 'Runs' },
  { id: 'memory',      label: 'Memory' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'settings',    label: 'Settings' },
]

const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai:    'OpenAI',
  google:    'Google',
  ollama:    'Ollama (local)',
  lmstudio:  'LM Studio (local)',
  custom:    'Custom',
}

// ─── Stat mini-card ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub }) {
  return (
    <div style={{ padding: '10px 14px', background: 'var(--bp-bg)', borderRadius: 6, border: '1px solid var(--bp-border)', minWidth: 80 }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--bp-text)', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 4, letterSpacing: '0.05em' }}>
        {label}
      </div>
      {sub && <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ─── Soul file editor ─────────────────────────────────────────────────────────

function SoulFileEditor({ agentId, files, onSaved }) {
  const addNotification = useStore(s => s.addNotification)
  const [activeFile, setActiveFile] = useState('IDENTITY.md')
  const [contents, setContents] = useState({})
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState({})

  useEffect(() => {
    if (files) setContents(files)
  }, [files])

  function handleChange(key, val) {
    setContents(prev => ({ ...prev, [key]: val }))
    setDirty(prev => ({ ...prev, [key]: true }))
  }

  async function handleSave(key) {
    setSaving(true)
    try {
      await updateAgentFile(agentId, key, contents[key] ?? '')
      setDirty(prev => ({ ...prev, [key]: false }))
      addNotification({ type: 'success', message: `${key} saved` })
      onSaved?.()
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  const file = SOUL_FILES.find(f => f.key === activeFile)

  return (
    <div style={{ display: 'flex', height: '100%', gap: 0 }}>
      {/* File list sidebar */}
      <div style={{ width: 160, flexShrink: 0, borderRight: '1px solid var(--bp-border)', paddingTop: 4 }}>
        {SOUL_FILES.map(f => (
          <button
            key={f.key}
            onClick={() => setActiveFile(f.key)}
            style={{
              width: '100%', textAlign: 'left', padding: '10px 14px',
              background: activeFile === f.key ? 'var(--bp-card)' : 'transparent',
              border: 'none', borderRight: activeFile === f.key ? '2px solid var(--bp-blue)' : '2px solid transparent',
              cursor: 'pointer', transition: 'background 100ms',
            }}
          >
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 12, color: activeFile === f.key ? 'var(--bp-blue)' : 'var(--bp-text-2)' }}>
              {f.label}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 1 }}>
              {f.key}
              {dirty[f.key] && <span style={{ color: 'var(--bp-amber)', marginLeft: 4 }}>●</span>}
            </div>
          </button>
        ))}
      </div>

      {/* Editor area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Editor header */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--bp-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)' }}>
              {file?.label}
            </span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginLeft: 8 }}>
              {file?.desc}
            </span>
          </div>
          <button
            onClick={() => handleSave(activeFile)}
            disabled={saving || !dirty[activeFile]}
            className="bp-btn bp-btn-primary"
            style={{ fontSize: 11 }}
          >
            {saving ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Save size={11} />}
            Save
          </button>
        </div>

        {/* Textarea */}
        <textarea
          value={contents[activeFile] ?? ''}
          onChange={e => handleChange(activeFile, e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, resize: 'none', background: 'var(--bp-bg)', color: 'var(--bp-text)',
            fontFamily: 'var(--bp-font-mono)', fontSize: 12, lineHeight: 1.7,
            border: 'none', outline: 'none', padding: '16px 20px',
            borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
          }}
          placeholder={`Write the agent's ${file?.label.toLowerCase()} here…`}
        />
      </div>
    </div>
  )
}

// ─── Runs tab ─────────────────────────────────────────────────────────────────

function RunsTab({ agentId, businessId }) {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({})
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    setLoading(true)
    getAgentRuns(agentId, { page, limit: 15 })
      .then(d => {
        setRuns(d?.data ?? (Array.isArray(d) ? d : []))
        setPagination(d?.pagination ?? {})
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [agentId, page])

  const statusColor = s => s === 'complete' ? 'var(--bp-green)' : s === 'failed' ? 'var(--bp-red)' : 'var(--bp-amber)'

  return (
    <div style={{ padding: '20px 24px' }}>
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bp-skeleton" style={{ height: 42, borderRadius: 4 }} />
          ))}
        </div>
      )}

      {!loading && runs.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⚙️</div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)' }}>No runs yet. Trigger a run to see history.</div>
        </div>
      )}

      {!loading && runs.length > 0 && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bp-border)' }}>
                {['Date', 'Trigger', 'Status', 'Tokens', 'Tasks', 'Cost', ''].map(h => (
                  <th key={h} style={{ padding: '6px 8px 8px', textAlign: 'left', fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <React.Fragment key={run.id}>
                  <tr
                    style={{ borderBottom: '1px solid var(--bp-border)22', cursor: 'pointer' }}
                    onClick={() => setExpanded(expanded === run.id ? null : run.id)}
                  >
                    <td style={{ padding: '9px 8px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
                      {run.started_at ? format(new Date(run.started_at), 'MMM d, HH:mm') : '—'}
                    </td>
                    <td style={{ padding: '9px 8px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', textTransform: 'capitalize' }}>
                      {run.trigger ?? 'manual'}
                    </td>
                    <td style={{ padding: '9px 8px' }}>
                      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: statusColor(run.status), fontWeight: 600 }}>
                        {run.status?.toUpperCase() ?? '—'}
                      </span>
                    </td>
                    <td style={{ padding: '9px 8px', fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
                      {run.prompt_tokens != null ? `${(run.prompt_tokens + (run.completion_tokens ?? 0)).toLocaleString()}` : '—'}
                    </td>
                    <td style={{ padding: '9px 8px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text)' }}>
                      {run.tasks_proposed ?? 0}
                    </td>
                    <td style={{ padding: '9px 8px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
                      {run.cost_usd != null ? `$${Number(run.cost_usd).toFixed(4)}` : '—'}
                    </td>
                    <td style={{ padding: '9px 8px' }}>
                      {expanded === run.id ? <ChevronDown size={12} style={{ color: 'var(--bp-text-3)' }} /> : <ChevronRight size={12} style={{ color: 'var(--bp-text-3)' }} />}
                    </td>
                  </tr>
                  {expanded === run.id && (
                    <tr>
                      <td colSpan={7} style={{ padding: '12px 16px 16px', background: 'var(--bp-bg)', borderBottom: '1px solid var(--bp-border)' }}>
                        {run.error && (
                          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-red)', marginBottom: 8, padding: '8px 10px', background: 'rgba(255,82,82,0.08)', borderRadius: 4 }}>
                            Error: {run.error}
                          </div>
                        )}
                        {run.reasoning && (
                          <div>
                            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Reasoning</div>
                            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>
                              {run.reasoning}
                            </div>
                          </div>
                        )}
                        {/* Mesh: what this specific run produced (signals,
                            tasks, KB entries, agent briefs, connector gaps). */}
                        {businessId && (
                          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bp-border)' }}>
                            <ProducedByEvent
                              businessId={businessId}
                              sourceType="agent_run"
                              sourceId={run.id}
                            />
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {pagination.pages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
                Page {pagination.page} of {pagination.pages}
              </span>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="bp-btn bp-btn-secondary"
                style={{ fontSize: 10, padding: '4px 10px' }}
              >
                Prev
              </button>
              <button
                onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
                disabled={page >= pagination.pages}
                className="bp-btn bp-btn-secondary"
                style={{ fontSize: 10, padding: '4px 10px' }}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Memory tab ───────────────────────────────────────────────────────────────

function MemoryTab({ agentId }) {
  const addNotification = useStore(s => s.addNotification)
  const [memory, setMemory] = useState(null)
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)

  const load = () => {
    setLoading(true)
    getAgentMemory(agentId).then(setMemory).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [agentId])

  async function handleClear() {
    if (!confirm('Clear all memory for this agent? This cannot be undone.')) return
    setClearing(true)
    try {
      await clearAgentMemory(agentId)
      addNotification({ type: 'success', message: 'Memory cleared' })
      load()
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setClearing(false)
    }
  }

  if (loading) return <div style={{ padding: 24 }}><div className="bp-skeleton" style={{ height: 120, borderRadius: 6 }} /></div>

  const isEmpty = !memory?.learnings?.length && !memory?.patterns?.length

  return (
    <div style={{ padding: '20px 24px' }}>
      {/* Stats */}
      {memory?.stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatCard label="Total runs" value={memory.stats.total_runs ?? 0} />
          <StatCard label="Tasks proposed" value={memory.stats.total_tasks_proposed ?? 0} />
          {memory.last_updated && (
            <StatCard label="Last updated" value={formatDistanceToNow(parseTimestamp(memory.last_updated) || new Date(), { addSuffix: true })} />
          )}
        </div>
      )}

      {isEmpty && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🧠</div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)' }}>
            No memory yet. Memory accumulates across agent runs.
          </div>
        </div>
      )}

      {memory?.learnings?.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Learnings ({memory.learnings.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[...memory.learnings].reverse().map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 12px', background: 'var(--bp-bg)', borderRadius: 4, border: '1px solid var(--bp-border)' }}>
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-blue)', flexShrink: 0, paddingTop: 1 }}>
                  {memory.learnings.length - i}
                </span>
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
                  {l}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {memory?.patterns?.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Patterns ({memory.patterns.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {memory.patterns.map((p, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 12px', background: 'var(--bp-bg)', borderRadius: 4, border: '1px solid var(--bp-border)' }}>
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-purple)', flexShrink: 0, paddingTop: 1 }}>~</span>
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>{p}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isEmpty && (
        <button
          onClick={handleClear}
          disabled={clearing}
          className="bp-btn bp-btn-secondary"
          style={{ fontSize: 11, color: 'var(--bp-red)', borderColor: 'var(--bp-red)44' }}
        >
          {clearing ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Trash2 size={11} />}
          Clear Memory
        </button>
      )}
    </div>
  )
}

// ─── Calibration tab (Feature 5) ──────────────────────────────────────────────

function CalibrationTab({ agentId }) {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [data, setData] = useState({ latest: null, history: [] })
  const [loading, setLoading] = useState(true)
  const [recalculating, setRecalculating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await getAgentCalibration(agentId, currentBusiness?.id)
      setData(d)
    } catch { setData({ latest: null, history: [] }) }
    finally { setLoading(false) }
  }, [agentId, currentBusiness])

  useEffect(() => { load() }, [load])

  async function handleRecalculate() {
    if (!currentBusiness) return
    setRecalculating(true)
    try { await recalculateAgentCalibration(agentId, currentBusiness.id); await load() }
    finally { setRecalculating(false) }
  }

  if (loading) return <div style={{ padding: 24 }}><div className="bp-skeleton" style={{ height: 120, borderRadius: 6 }} /></div>

  const latest = data.latest
  const history = data.history || []

  const scoreColor = latest?.calibration_score >= 0.85 ? 'var(--bp-green)'
                  : latest?.calibration_score >= 0.7 ? 'var(--bp-amber)' : 'var(--bp-red)'

  return (
    <div style={{ padding: 20, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontSize: 14, fontWeight: 700 }}>Calibration</div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginTop: 4 }}>
            How well this agent's stated confidence predicts actual outcomes
          </div>
        </div>
        <button onClick={handleRecalculate} disabled={recalculating || !currentBusiness} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
          {recalculating ? 'Recalculating…' : 'Recalculate now'}
        </button>
      </div>

      {!latest && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          Not enough outcome data yet. Calibration appears after this agent has at least 3 completed tasks with measured outcomes.
        </div>
      )}

      {latest && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 20 }}>
          <StatCard label="Calibration score"
            value={<span style={{ color: scoreColor }}>{Math.round((latest.calibration_score ?? 0) * 100)}</span>}
            sub={latest.trend ? `Trend: ${latest.trend}` : null} />
          <StatCard label="Error"
            value={`${((latest.calibration_error ?? 0) * 100).toFixed(1)}%`}
            sub={latest.calibration_error > 0 ? 'Overconfident' : latest.calibration_error < 0 ? 'Underconfident' : 'Balanced'} />
          <StatCard label="Stated avg"
            value={`${((latest.avg_stated_confidence ?? 0) * 100).toFixed(0)}%`}
            sub={`${latest.tasks_with_outcomes ?? 0} outcomes`} />
          <StatCard label="Actual outcome rate"
            value={`${((latest.avg_actual_outcome_rate ?? 0) * 100).toFixed(0)}%`}
            sub={`Offset applied: ${((latest.calibration_offset ?? 0) * 100).toFixed(1)}%`} />
        </div>
      )}

      {history.length > 1 && (
        <div className="bp-card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 10 }}>
            History
          </div>
          <table style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>
            <thead>
              <tr style={{ color: 'var(--bp-text-3)', borderBottom: '1px solid var(--bp-border)' }}>
                <th align="left" style={{ padding: '6px 0' }}>Period ending</th>
                <th align="center">n</th>
                <th align="center">Stated</th>
                <th align="center">Actual</th>
                <th align="center">Error</th>
                <th align="center">Score</th>
                <th align="center">Trend</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} style={{ borderBottom: '1px solid var(--bp-border)', color: 'var(--bp-text-2)' }}>
                  <td style={{ padding: '6px 0' }}>{new Date(h.period_end).toLocaleDateString()}</td>
                  <td align="center">{h.tasks_with_outcomes}</td>
                  <td align="center">{((h.avg_stated_confidence ?? 0) * 100).toFixed(0)}%</td>
                  <td align="center">{((h.avg_actual_outcome_rate ?? 0) * 100).toFixed(0)}%</td>
                  <td align="center" style={{ color: Math.abs(h.calibration_error ?? 0) > 0.1 ? 'var(--bp-red)' : undefined }}>
                    {((h.calibration_error ?? 0) * 100).toFixed(1)}%
                  </td>
                  <td align="center">{Math.round((h.calibration_score ?? 0) * 100)}</td>
                  <td align="center">{h.trend ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {latest?.notes && (
        <div className="bp-card" style={{ padding: 16, borderLeft: '3px solid var(--bp-blue)' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 6 }}>
            Note
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-2)' }}>
            {latest.notes}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

function SettingsTab({ agentId, profile, onRefresh }) {
  const addNotification = useStore(s => s.addNotification)
  const [providers, setProviders] = useState([])
  const [models, setModels] = useState([])
  const [loadingModels, setLoadingModels] = useState(false)

  const llm = profile?.llm ?? {}
  const [form, setForm] = useState({
    provider: llm.provider ?? 'anthropic',
    model: llm.model ?? 'claude-sonnet-4-20250514',
    temperature: llm.temperature ?? 0.7,
    max_tokens: llm.max_tokens ?? 4096,
    cost_cap_daily_usd: llm.cost_cap_daily_usd ?? 2.0,
    trust_tier: profile?.trust_tier ?? 'yellow',
    approval_mode: profile?.approval_mode ?? 'requires_approval',
  })
  const [saving, setSaving] = useState(false)

  // LLM credential form
  const [credForm, setCredForm] = useState({ apiKey: '', baseUrl: '' })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [savingCreds, setSavingCreds] = useState(false)

  useEffect(() => {
    getLLMProviders().then(setProviders).catch(() => {})
  }, [])

  useEffect(() => {
    if (!form.provider) return
    setLoadingModels(true)
    getLLMModels(form.provider)
      .then(d => setModels(d?.models ?? []))
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false))
  }, [form.provider])

  async function handleSaveProfile() {
    setSaving(true)
    try {
      await patchAgentProfile(agentId, {
        llm: {
          provider: form.provider,
          model: form.model,
          temperature: Number(form.temperature),
          max_tokens: Number(form.max_tokens),
          cost_cap_daily_usd: Number(form.cost_cap_daily_usd),
        },
        trust_tier: form.trust_tier,
        approval_mode: form.approval_mode,
      })
      addNotification({ type: 'success', message: 'Profile updated' })
      onRefresh?.()
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleTestCreds() {
    setTesting(true)
    setTestResult(null)
    try {
      await testLLMCredentials(form.provider, credForm)
      setTestResult({ ok: true, message: 'Connection successful' })
    } catch (err) {
      setTestResult({ ok: false, message: err.message })
    } finally {
      setTesting(false)
    }
  }

  async function handleSaveCreds() {
    setSavingCreds(true)
    try {
      await saveLLMCredentials(form.provider, credForm)
      addNotification({ type: 'success', message: `${PROVIDER_LABELS[form.provider] ?? form.provider} credentials saved` })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setSavingCreds(false)
    }
  }

  const selectedProvider = providers.find(p => p.id === form.provider)

  return (
    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* LLM Configuration */}
      <section>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>
          LLM Configuration
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          {/* Provider */}
          <div>
            <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>Provider</label>
            <select
              value={form.provider}
              onChange={e => { setForm(f => ({ ...f, provider: e.target.value, model: '' })); setTestResult(null) }}
              className="bp-input"
              style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
            >
              {providers.map(p => (
                <option key={p.id} value={p.id}>
                  {PROVIDER_LABELS[p.id] ?? p.id} {p.configured ? '✓' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div>
            <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>
              Model {loadingModels && <RefreshCw size={9} style={{ display: 'inline', animation: 'bp-spin-slow 1s linear infinite', marginLeft: 4 }} />}
            </label>
            {models.length > 0 ? (
              <select
                value={form.model}
                onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                className="bp-input"
                style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
              >
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                type="text"
                value={form.model}
                onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                className="bp-input"
                style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
                placeholder="model name"
              />
            )}
          </div>

          {/* Temperature */}
          <div>
            <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>
              Temperature ({form.temperature})
            </label>
            <input
              type="range" min="0" max="1" step="0.1"
              value={form.temperature}
              onChange={e => setForm(f => ({ ...f, temperature: Number(e.target.value) }))}
              style={{ width: '100%' }}
            />
          </div>

          {/* Max tokens */}
          <div>
            <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>Max tokens</label>
            <input
              type="number"
              value={form.max_tokens}
              onChange={e => setForm(f => ({ ...f, max_tokens: Number(e.target.value) }))}
              className="bp-input"
              style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
              min={512} max={200000} step={512}
            />
          </div>

          {/* Daily cost cap */}
          <div>
            <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>Daily cost cap (USD)</label>
            <input
              type="number"
              value={form.cost_cap_daily_usd}
              onChange={e => setForm(f => ({ ...f, cost_cap_daily_usd: Number(e.target.value) }))}
              className="bp-input"
              style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
              min={0} step={0.5}
            />
          </div>
        </div>
      </section>

      {/* Trust & Approval */}
      <section>
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>
          Trust & Approval
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>Trust tier</label>
            <select
              value={form.trust_tier}
              onChange={e => setForm(f => ({ ...f, trust_tier: e.target.value }))}
              className="bp-input"
              style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
            >
              <option value="green">Green — auto-execute safe actions</option>
              <option value="yellow">Yellow — require approval</option>
              <option value="red">Red — propose only, no execution</option>
            </select>
          </div>
          <div>
            <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>Approval mode</label>
            <select
              value={form.approval_mode}
              onChange={e => setForm(f => ({ ...f, approval_mode: e.target.value }))}
              className="bp-input"
              style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
            >
              <option value="requires_approval">Requires approval</option>
              <option value="auto_approve">Auto-approve</option>
            </select>
          </div>
        </div>
      </section>

      <button
        onClick={handleSaveProfile}
        disabled={saving}
        className="bp-btn bp-btn-primary"
        style={{ alignSelf: 'flex-start', fontSize: 12 }}
      >
        {saving ? <RefreshCw size={12} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Save size={12} />}
        Save Profile Settings
      </button>

      {/* API Credentials */}
      {selectedProvider?.requires_key && (
        <section style={{ paddingTop: 8, borderTop: '1px solid var(--bp-border)' }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>
            {PROVIDER_LABELS[form.provider] ?? form.provider} Credentials
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {selectedProvider.requires_key && (
              <div>
                <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>API Key</label>
                <input
                  type="password"
                  value={credForm.apiKey}
                  onChange={e => { setCredForm(f => ({ ...f, apiKey: e.target.value })); setTestResult(null) }}
                  className="bp-input"
                  style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
                  placeholder="sk-…"
                />
              </div>
            )}
            {selectedProvider.requires_base_url && (
              <div>
                <label style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'block', marginBottom: 4 }}>{selectedProvider.base_url_label ?? 'Base URL'}</label>
                <input
                  type="text"
                  value={credForm.baseUrl}
                  onChange={e => { setCredForm(f => ({ ...f, baseUrl: e.target.value })); setTestResult(null) }}
                  className="bp-input"
                  style={{ width: '100%', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}
                  placeholder="https://…"
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleTestCreds} disabled={testing} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
                {testing ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Zap size={11} />}
                Test Connection
              </button>
              <button onClick={handleSaveCreds} disabled={savingCreds} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
                {savingCreds ? <RefreshCw size={11} style={{ animation: 'bp-spin-slow 1s linear infinite' }} /> : <Save size={11} />}
                Save Credentials
              </button>
            </div>

            {testResult && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 4, background: testResult.ok ? 'rgba(0,201,167,0.08)' : 'rgba(255,82,82,0.08)', border: `1px solid ${testResult.ok ? 'var(--bp-green)' : 'var(--bp-red)'}44` }}>
                {testResult.ok
                  ? <CheckCircle size={12} style={{ color: 'var(--bp-green)' }} />
                  : <XCircle size={12} style={{ color: 'var(--bp-red)' }} />}
                <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: testResult.ok ? 'var(--bp-green)' : 'var(--bp-red)' }}>
                  {testResult.message}
                </span>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

// ─── Agent Detail page ────────────────────────────────────────────────────────

export default function AgentDetail() {
  const { agentId } = useParams()
  const navigate = useNavigate()
  const addNotification = useStore(s => s.addNotification)
  const currentBusiness = useStore(s => s.currentBusiness)

  const [data, setData] = useState(null)
  const [agent, setAgent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('soul')
  const [running, setRunning] = useState(false)
  const [toggling, setToggling] = useState(false)

  const load = useCallback(() => {
    Promise.all([
      getAgentProfile(agentId).catch(() => null),
      getAgents().catch(() => []),
    ]).then(([profileData, agents]) => {
      setData(profileData)
      const a = (Array.isArray(agents) ? agents : []).find(x => x.id === agentId)
      if (a) setAgent(a)
    }).finally(() => setLoading(false))
  }, [agentId])

  useEffect(() => { load() }, [load])

  async function handleRun() {
    setRunning(true)
    try {
      await runAgent(agentId, { business_id: currentBusiness?.id })
      addNotification({ type: 'success', title: agent?.name, message: 'Run queued' })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setRunning(false) }
  }

  async function handleToggle() {
    setToggling(true)
    const newStatus = agent?.status === 'active' ? 'paused' : 'active'
    try {
      await updateAgent(agentId, { status: newStatus })
      setAgent(prev => ({ ...prev, status: newStatus }))
      addNotification({ type: 'success', message: `Agent ${newStatus}` })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setToggling(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '24px 28px' }}>
        <div style={{ display: 'flex', gap: 24 }}>
          <div className="bp-skeleton" style={{ width: 260, height: 380, borderRadius: 8 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="bp-skeleton" style={{ height: 44, borderRadius: 6 }} />
            <div className="bp-skeleton" style={{ height: 300, borderRadius: 6 }} />
          </div>
        </div>
      </div>
    )
  }

  const profile = data?.profile ?? {}
  const files = data?.files ?? {}
  const memorySummary = data?.memory_summary ?? null
  const ps = agent?.profile_summary ?? {}
  const stats = agent?.stats_7d ?? {}
  const isActive = agent?.status === 'active' || agent?.status === 'running'

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <button
          onClick={() => navigate('/agents')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bp-text-3)', display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}
        >
          <ArrowLeft size={13} />
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11 }}>Agents</span>
        </button>
        <span style={{ color: 'var(--bp-border)' }}>/</span>
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>{agent?.name ?? agentId}</span>
      </div>

      <div style={{ display: 'flex', gap: 20, flex: 1, minHeight: 0 }}>
        {/* Left column — identity */}
        <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Identity card */}
          <div className="bp-card" style={{ padding: '20px 18px', textAlign: 'center' }}>
            <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 12 }}>
              {ps.avatar ?? profile?.avatar ?? '🤖'}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 18, color: 'var(--bp-text)', marginBottom: 4 }}>
              {agent?.name ?? agentId}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', marginBottom: 14 }}>
              {ps.title ?? profile?.title ?? ''}
            </div>

            {/* Status */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 16 }}>
              <span className={`pulse-dot ${isActive ? 'pulse-dot-green' : 'pulse-dot-gray'}`} />
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', letterSpacing: '0.05em' }}>
                {agent?.status?.toUpperCase() ?? 'UNKNOWN'}
              </span>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 0 }}>
              <button
                onClick={handleRun}
                disabled={running || agent?.status === 'running' || !data}
                className="bp-btn bp-btn-primary"
                style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}
              >
                {running
                  ? <RefreshCw size={12} style={{ animation: 'bp-spin-slow 1s linear infinite' }} />
                  : <Play size={12} />}
                {running ? 'Running…' : 'Run'}
              </button>
              <button
                onClick={handleToggle}
                disabled={toggling}
                className="bp-btn bp-btn-secondary"
                style={{ fontSize: 12 }}
                title={isActive ? 'Pause' : 'Enable'}
              >
                {toggling
                  ? <RefreshCw size={12} style={{ animation: 'bp-spin-slow 1s linear infinite' }} />
                  : isActive ? <Pause size={12} /> : <Play size={12} />}
              </button>
            </div>
          </div>

          {/* 7-day stats */}
          <div className="bp-card" style={{ padding: '16px 18px' }}>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
              7-Day Stats
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { label: 'Runs', value: stats.runs ?? 0 },
                { label: 'Tasks proposed', value: stats.tasks_proposed ?? 0 },
                { label: 'Total cost', value: `$${Number(stats.cost_usd ?? 0).toFixed(4)}` },
                { label: 'Total runs', value: agent?.run_count ?? 0 },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--bp-text)' }}>{value}</span>
                </div>
              ))}

              {agent?.last_run && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Last run</span>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
                    {formatDistanceToNow(parseTimestamp(agent.last_run) || new Date(), { addSuffix: true })}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* LLM info */}
          {(ps.llm || profile?.llm) && (
            <div className="bp-card" style={{ padding: '16px 18px' }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
                LLM Configuration
              </div>
              {[
                { label: 'Provider', value: (ps.llm ?? profile?.llm)?.provider },
                { label: 'Model', value: (ps.llm ?? profile?.llm)?.model },
                { label: 'Temperature', value: (ps.llm ?? profile?.llm)?.temperature },
                { label: 'Cost cap/day', value: (ps.llm ?? profile?.llm)?.cost_cap_daily_usd ? `$${(ps.llm ?? profile?.llm).cost_cap_daily_usd}` : null },
              ].filter(r => r.value != null).map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)', textAlign: 'right', maxWidth: '55%', wordBreak: 'break-all' }}>{String(value)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Memory summary */}
          {memorySummary && (
            <div className="bp-card" style={{ padding: '16px 18px' }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
                Memory
              </div>
              {[
                { label: 'Learnings', value: memorySummary.learnings_count },
                { label: 'Patterns', value: memorySummary.patterns_count },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--bp-text)' }}>{value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Not installed notice */}
          {!data && (
            <div style={{ padding: '12px 16px', background: 'rgba(255,82,82,0.08)', borderRadius: 6, border: '1px solid rgba(255,82,82,0.2)' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <AlertCircle size={13} style={{ color: 'var(--bp-red)', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-red)', marginBottom: 4 }}>Agent not installed</div>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
                    Go to Agents page to install from template.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right column — tabs */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--bp-border)', marginBottom: 0, flexShrink: 0 }}>
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '10px 18px',
                  fontFamily: 'var(--bp-font-mono)', fontSize: 12,
                  color: activeTab === tab.id ? 'var(--bp-text)' : 'var(--bp-text-3)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  borderBottom: activeTab === tab.id ? '2px solid var(--bp-blue)' : '2px solid transparent',
                  marginBottom: -1,
                  transition: 'color 100ms',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="bp-card" style={{ flex: 1, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {activeTab === 'soul' && data && (
              <SoulFileEditor agentId={agentId} files={files} onSaved={load} />
            )}
            {activeTab === 'soul' && !data && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
                Agent not installed — no soul files available.
              </div>
            )}
            {activeTab === 'runs' && (
              <RunsTab agentId={agentId} businessId={currentBusiness?.id} />
            )}
            {activeTab === 'memory' && (
              <MemoryTab agentId={agentId} />
            )}
            {activeTab === 'calibration' && (
              <CalibrationTab agentId={agentId} />
            )}
            {activeTab === 'settings' && (
              <div style={{ overflowY: 'auto', flex: 1 }}>
                <SettingsTab agentId={agentId} profile={profile} onRefresh={load} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
