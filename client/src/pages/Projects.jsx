import React, { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import { FolderOpen, Plus, Sparkles, ArrowRight, X, Check } from 'lucide-react'
import useStore from '../lib/store.js'
import {
  getProjects, getProject, createProject, updateProject, deleteProject, proposeProject,
} from '../lib/api.js'

const COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#9d7aff', '#ff8c42', '#00c9a7']
const ICONS = ['📁', '🔍', '⚡', '🚀', '📊', '🎯', '✍️', '🔬', '💡', '🛠️']

function fmtRel(iso) {
  if (!iso) return '—'
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) } catch { return '—' }
}

function ProjectCard({ project, onOpen }) {
  const days = project.target_date ? Math.ceil((new Date(project.target_date) - new Date()) / 86400000) : null

  return (
    <div className="bp-card" style={{ padding: 18, cursor: 'pointer' }} onClick={() => onOpen(project.id)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 20 }}>{project.icon}</span>
        <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 15, color: 'var(--bp-text)', flex: 1 }}>
          {project.name}
        </div>
        <span style={{
          fontFamily: 'var(--bp-font-mono)', fontSize: 9, padding: '2px 7px', borderRadius: 3,
          background: `${project.color}20`, color: project.color,
          border: `1px solid ${project.color}40`, letterSpacing: '0.08em',
        }}>{project.status?.toUpperCase()}</span>
      </div>
      {project.description && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', marginBottom: 14, lineHeight: 1.5 }}>
          {project.description}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 8 }}>
        <span>{project.workflow_count ?? 0} workflows</span>
        <span>{project.goal_count ?? 0} goals</span>
        <span>{project.task_count ?? 0} tasks</span>
        <span>{project.signal_count ?? 0} signals</span>
      </div>
      {project.assigned_agents?.length > 0 && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 8 }}>
          {project.assigned_agents.join(', ')} assigned
        </div>
      )}
      {days != null && (
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: days < 14 ? 'var(--bp-amber)' : 'var(--bp-text-3)' }}>
          Target: {new Date(project.target_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          {days >= 0 ? ` (${days} days)` : ' (overdue)'}
        </div>
      )}
    </div>
  )
}

function NewProjectForm({ businessId, initial, onSaved, onCancel }) {
  const [form, setForm] = useState(() => ({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    color: initial?.color ?? '#3b82f6',
    icon: initial?.icon ?? '📁',
    assigned_agents: initial?.assigned_agents ?? [],
    tags: initial?.tags ?? [],
    target_date: initial?.target_date?.slice(0, 10) ?? '',
  }))

  async function handleSave() {
    if (!form.name.trim()) return
    await createProject(businessId, form)
    onSaved()
  }

  return (
    <div className="bp-card" style={{ padding: 20, marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 12 }}>
        New Project
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <select style={{ background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border)', color: 'var(--bp-text)', padding: '8px', borderRadius: 4, fontSize: 16 }}
          value={form.icon} onChange={(e) => setForm(p => ({ ...p, icon: e.target.value }))}>
          {ICONS.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
        <input className="bp-input" placeholder="Project name" style={{ flex: 1, fontSize: 14, fontWeight: 600 }}
          value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} />
      </div>
      <textarea className="bp-input" rows={3} placeholder="Description" style={{ width: '100%', fontSize: 11, marginBottom: 10 }}
        value={form.description} onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))} />
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 6 }}>Color</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {COLORS.map(c => (
          <button key={c} onClick={() => setForm(p => ({ ...p, color: c }))}
            style={{ width: 24, height: 24, borderRadius: 4, background: c, border: form.color === c ? '2px solid var(--bp-text)' : 'none', cursor: 'pointer' }} />
        ))}
      </div>
      <input className="bp-input" type="date" style={{ fontSize: 11, marginBottom: 14 }}
        value={form.target_date} onChange={(e) => setForm(p => ({ ...p, target_date: e.target.value }))} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleSave} disabled={!form.name.trim()} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>Save</button>
        <button onClick={onCancel} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>Cancel</button>
      </div>
    </div>
  )
}

function ProjectDetail({ businessId, projectId, onBack }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    getProject(businessId, projectId).then(setData).catch(() => {})
  }, [businessId, projectId])

  if (!data) return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Loading…</div>
  const { project, tasks, signals, workflows, goals } = data

  return (
    <div>
      <button onClick={onBack} className="bp-btn bp-btn-ghost" style={{ fontSize: 11, marginBottom: 14 }}>
        ← All projects
      </button>
      <div className="bp-card" style={{ padding: 20, marginBottom: 14, borderLeft: `3px solid ${project.color}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 24 }}>{project.icon}</span>
          <h2 style={{ fontFamily: 'var(--bp-font-display)', fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--bp-text)' }}>
            {project.name}
          </h2>
        </div>
        {project.description && (
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-2)', marginBottom: 10 }}>{project.description}</p>
        )}
        <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
          Updated {fmtRel(project.updated_at)} · {project.assigned_agents?.join(', ') || 'no agents'}
        </div>
      </div>

      {[
        { key: 'workflows', title: 'Workflows', items: workflows, field: 'name' },
        { key: 'goals', title: 'Goals', items: goals, field: 'title' },
        { key: 'tasks', title: 'Tasks', items: tasks, field: 'title' },
        { key: 'signals', title: 'Signals', items: signals, field: 'title' },
      ].map(section => (
        <div key={section.key} className="bp-card" style={{ padding: 16, marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 10 }}>
            {section.title} ({section.items?.length ?? 0})
          </div>
          {(section.items ?? []).slice(0, 10).map((item) => (
            <div key={item.id} style={{ padding: '6px 0', borderTop: '1px solid var(--bp-border)', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
              {item[section.field]}
            </div>
          ))}
          {(!section.items || section.items.length === 0) && (
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)', fontStyle: 'italic' }}>None linked yet.</div>
          )}
        </div>
      ))}
    </div>
  )
}

export default function Projects() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [projects, setProjects] = useState([])
  const [showForm, setShowForm] = useState(false)

  const fetchAll = useCallback(async () => {
    if (!currentBusiness) return
    setProjects(await getProjects(currentBusiness.id) ?? [])
  }, [currentBusiness])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function handleAskAI() {
    const context = prompt('What are you working on?')
    if (!context) return
    try {
      const { proposed } = await proposeProject(currentBusiness.id, context)
      if (proposed && confirm(`Create project "${proposed.name}"?\n\n${proposed.description}`)) {
        await createProject(currentBusiness.id, proposed)
        fetchAll()
      }
    } catch (err) { alert(`Failed: ${err.message}`) }
  }

  if (!currentBusiness) return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>

  if (projectId) {
    return (
      <div style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
        <ProjectDetail businessId={currentBusiness.id} projectId={projectId} onBack={() => navigate('/projects')} />
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>PROJECTS</h1>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Group related work into focused projects
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleAskAI} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
            <Sparkles size={11} /> Ask AI
          </button>
          <button onClick={() => setShowForm(true)} className="bp-btn bp-btn-primary" style={{ fontSize: 11 }}>
            <Plus size={11} /> New project
          </button>
        </div>
      </div>

      {showForm && (
        <NewProjectForm
          businessId={currentBusiness.id}
          onSaved={() => { setShowForm(false); fetchAll() }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {projects.length === 0 && !showForm ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
          No projects yet. Group related workflows, goals, tasks, and signals together.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {projects.map((p) => <ProjectCard key={p.id} project={p} onOpen={(id) => navigate(`/projects/${id}`)} />)}
        </div>
      )}
    </div>
  )
}
