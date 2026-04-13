import React, { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { BookMarked, Play, ArrowLeft, CheckCircle2, XCircle, Lightbulb } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import useStore from '../lib/store.js'
import { getRetrospectives, getRetrospective, runRetrospective } from '../lib/api.js'

function Section({ title, icon: Icon, color, items, render }) {
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

function RetroDetail({ retro, onBack }) {
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

      <Section title="What worked" icon={CheckCircle2} color="var(--bp-green)" items={retro.what_worked}
        render={(w) => (<><strong>{w.title}</strong> — {w.evidence}{w.insight && <div style={{ fontStyle: 'italic', color: 'var(--bp-text-3)', marginTop: 4 }}>{w.insight}</div>}</>)} />

      <Section title="What didn't work" icon={XCircle} color="var(--bp-red)" items={retro.what_didnt}
        render={(w) => (<><strong>{w.title}</strong> — {w.evidence}{w.insight && <div style={{ fontStyle: 'italic', color: 'var(--bp-text-3)', marginTop: 4 }}>{w.insight}</div>}</>)} />

      <Section title="Learnings" icon={Lightbulb} color="var(--bp-blue)" items={retro.learnings}
        render={(l) => (<>{l.learning}{l.applies_to && <span style={{ color: 'var(--bp-text-3)' }}> — {l.applies_to}</span>}</>)} />

      {Array.isArray(retro.agent_assessments) && retro.agent_assessments.length > 0 && (
        <div className="bp-card" style={{ padding: 18, marginBottom: 14 }}>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
            Agent scorecards
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
                  <td align="center" style={{ color: a.calibration_error > 0.1 ? 'var(--bp-red)' : undefined }}>
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

      <Section title="Open measurement windows" icon={BookMarked} color="var(--bp-amber)" items={retro.open_windows}
        render={(w) => (<><strong>{w.action_type}</strong> ({w.count}) — {w.note}</>)} />

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
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 10 }}>
            How Blueprint should operate differently
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
  const [list, setList] = useState([])
  const [selected, setSelected] = useState(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    if (!currentBusiness) return
    const rows = await getRetrospectives(currentBusiness.id).catch(() => [])
    setList(rows || [])
    if (routeId) {
      try {
        const r = await getRetrospective(currentBusiness.id, routeId)
        setSelected(r)
      } catch {}
    }
  }, [currentBusiness, routeId])

  useEffect(() => { load() }, [load])

  async function handleRun() {
    setRunning(true)
    try {
      const r = await runRetrospective(currentBusiness.id)
      if (r?.id) {
        await load()
        const detail = await getRetrospective(currentBusiness.id, r.id)
        setSelected(detail)
        navigate(`/retrospectives/${r.id}`)
      }
    } catch (err) {
      alert(`Failed: ${err.message}`)
    } finally {
      setRunning(false)
    }
  }

  async function handleOpen(id) {
    const r = await getRetrospective(currentBusiness.id, id)
    setSelected(r)
    navigate(`/retrospectives/${id}`)
  }

  function handleBack() {
    setSelected(null)
    navigate('/retrospectives')
  }

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
        <RetroDetail retro={selected} onBack={handleBack} />
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
