import React, { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import { Check, X, ChevronDown, ChevronUp, Clock } from 'lucide-react'
import clsx from 'clsx'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { approveTask, rejectTask, updateTask } from '../lib/api.js'
import useStore from '../lib/store.js'

const COLUMNS = [
  { id: 'proposed',  label: 'Proposed',  color: 'var(--bp-amber)' },
  { id: 'approved',  label: 'Approved',  color: 'var(--bp-blue)' },
  { id: 'executing', label: 'Executing', color: 'var(--bp-blue)' },
  { id: 'complete',  label: 'Complete',  color: 'var(--bp-green)' },
  { id: 'verified',  label: 'Verified',  color: 'var(--bp-text-3)' },
  { id: 'failed',    label: 'Failed',    color: 'var(--bp-red)' },
  { id: 'rejected',  label: 'Rejected',  color: 'var(--bp-text-3)' },
  { id: 'deferred',  label: 'Deferred',  color: 'var(--bp-amber)' },
]

const PRIORITY_PILL = { 1: 'bp-pill-red', 2: 'bp-pill-amber', 3: 'bp-pill-blue', 4: 'bp-pill-grey' }
const PRIORITY_LABEL = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' }

function ConfidenceBar({ value }) {
  if (value == null) return null
  const pct = Math.round(value * 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div className="confidence-bar" style={{ flex: 1 }}>
        <div className="confidence-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', flexShrink: 0 }}>{pct}%</span>
    </div>
  )
}

function TaskCard({ task, isDragging = false, onUpdate, onSelect }) {
  const addNotification = useStore((s) => s.addNotification)
  const [expanded,  setExpanded]  = useState(false)
  const [acting,    setActing]    = useState(false)
  const [reviewNote, setReviewNote] = useState('')

  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: task.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const isExecuting = task.status === 'executing'
  const age = task.created_at
    ? formatDistanceToNow(parseTimestamp(task.created_at) || new Date(), { addSuffix: true })
    : '—'

  async function handleApprove() {
    setActing(true)
    try {
      await approveTask(task.id, reviewNote ? { note: reviewNote } : {})
      addNotification({ type: 'success', message: 'Task approved' })
      onUpdate?.()
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally { setActing(false) }
  }

  async function handleReject() {
    setActing(true)
    try {
      await rejectTask(task.id, reviewNote ? { note: reviewNote } : {})
      addNotification({ type: 'success', message: 'Task rejected' })
      onUpdate?.()
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally { setActing(false) }
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        background: 'var(--bp-surface-2)',
        border: `1px solid var(--bp-border)`,
        borderRadius: 6,
        overflow: 'hidden',
        cursor: 'grab',
      }}
      {...attributes}
      {...listeners}
    >
      {/* Status bar */}
      <div style={{ height: 3, background: isExecuting ? 'var(--bp-blue)' : 'rgba(255,255,255,0.06)', position: 'relative', overflow: 'hidden' }}>
        {isExecuting && (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--bp-blue)', animation: 'bp-shimmer 2s infinite' }} />
        )}
      </div>

      <div style={{ padding: '12px 14px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 8 }}>
          {task.priority && (
            <span className={clsx('bp-pill', PRIORITY_PILL[task.priority] || 'bp-pill-grey')} style={{ padding: '1px 5px', fontSize: 9, flexShrink: 0 }}>
              {PRIORITY_LABEL[task.priority] || `P${task.priority}`}
            </span>
          )}
          {task.trust_tier && (
            <span className="bp-pill bp-pill-grey" style={{ padding: '1px 5px', fontSize: 9, flexShrink: 0 }}>
              {task.trust_tier}
            </span>
          )}
          {task.action_type === 'hire_agent' && (
            <span
              className="bp-pill"
              style={{
                padding: '1px 6px', fontSize: 9, flexShrink: 0,
                background: 'rgba(168,85,247,0.15)', color: '#c4b5fd',
                border: '1px solid rgba(168,85,247,0.3)',
              }}
            >
              Conductor recommends
            </span>
          )}
          {task.degraded_data ? (
            <span
              className="bp-pill"
              title="Proposed with incomplete or stale connector data — confidence capped and human review required."
              style={{
                padding: '1px 6px', fontSize: 9, flexShrink: 0,
                background: 'rgba(239,68,68,0.12)', color: '#fca5a5',
                border: '1px solid rgba(239,68,68,0.3)',
              }}
            >
              degraded data
            </span>
          ) : null}
        </div>

        {/* Title — click to open detail drawer (stopPropagation so the
            drag handler on the card root doesn't fire). */}
        <div
          onClick={(e) => { e.stopPropagation(); onSelect?.(task.id) }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            fontFamily: 'var(--bp-font-mono)', fontSize: 12,
            color: 'var(--bp-text)', lineHeight: 1.45, marginBottom: 8,
            cursor: 'pointer', textDecoration: 'underline',
            textDecorationColor: 'rgba(255,255,255,0.15)',
            textUnderlineOffset: 2,
          }}
        >
          {task.title}
        </div>

        {/* Meta */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          {task.agent_name && (
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
              {task.agent_name}
            </span>
          )}
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginLeft: 'auto' }}>
            {age}
          </span>
        </div>

        {/* Confidence */}
        <ConfidenceBar value={task.confidence} />

        {/* Propose actions */}
        {task.status === 'proposed' && (
          <div style={{ marginTop: 10, display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
            <button
              onClick={handleApprove}
              disabled={acting}
              className="bp-btn bp-btn-primary"
              style={{ flex: 1, justifyContent: 'center', fontSize: 10, padding: '4px 6px' }}
            >
              <Check size={10} /> Approve
            </button>
            <button
              onClick={handleReject}
              disabled={acting}
              className="bp-btn bp-btn-ghost"
              style={{ fontSize: 10, padding: '4px 6px', color: 'var(--bp-red)' }}
            >
              <X size={10} /> Reject
            </button>
          </div>
        )}

        {/* Expand toggle */}
        {task.description && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
            style={{
              marginTop: 8, width: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              background: 'none', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)',
            }}
          >
            {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {expanded ? 'Less' : 'Details'}
          </button>
        )}

        {expanded && task.description && (
          <div style={{ marginTop: 8, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5 }}>
            {task.description}
          </div>
        )}
      </div>
    </div>
  )
}

function KanbanColumn({ column, tasks, onUpdate, onSelect }) {
  const { setNodeRef, isOver } = useSortable ? { setNodeRef: null, isOver: false } : {}

  return (
    <div
      className="kanban-col"
      style={{
        background: isOver ? 'rgba(59,130,246,0.03)' : 'transparent',
        borderRadius: 6,
        transition: 'background 150ms ease',
      }}
    >
      {/* Column header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 4px 10px',
        borderBottom: `2px solid ${column.color}`,
        marginBottom: 10,
      }}>
        <span style={{
          fontFamily: 'var(--bp-font-display)',
          fontSize: 10, fontWeight: 600,
          letterSpacing: '0.1em', textTransform: 'uppercase',
          color: column.color,
        }}>
          {column.label}
        </span>
        <span style={{
          fontFamily: 'var(--bp-font-mono)', fontSize: 9,
          padding: '1px 5px', borderRadius: 2,
          background: 'rgba(255,255,255,0.06)',
          color: 'var(--bp-text-3)',
        }}>
          {tasks.length}
        </span>
      </div>

      {/* Tasks */}
      <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tasks.map(task => (
            <TaskCard key={task.id} task={task} onUpdate={onUpdate} onSelect={onSelect} />
          ))}
          {tasks.length === 0 && (
            <div style={{
              padding: '20px 12px',
              border: '1px dashed rgba(255,255,255,0.06)',
              borderRadius: 6,
              textAlign: 'center',
              fontFamily: 'var(--bp-font-mono)', fontSize: 10,
              color: 'var(--bp-text-3)',
            }}>
              No {column.label.toLowerCase()} tasks
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

function TaskKanban({ tasks = [], onUpdate, onSelect }) {
  const addNotification = useStore((s) => s.addNotification)
  const [activeId, setActiveId] = useState(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  // Group by status
  const columns = COLUMNS.map(col => ({
    ...col,
    tasks: tasks.filter(t => t.status === col.id),
  }))

  const activeTask = activeId ? tasks.find(t => t.id === activeId) : null

  async function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) { setActiveId(null); return }

    // Find which column the dropped item is in
    const targetCol = COLUMNS.find(c => c.tasks?.some(t => t.id === over.id))
      || COLUMNS.find(c => c.id === over.id)

    if (targetCol) {
      try {
        await updateTask(active.id, { status: targetCol.id })
        onUpdate?.()
      } catch (err) {
        addNotification({ type: 'error', message: err.message })
      }
    }
    setActiveId(null)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={({ active }) => setActiveId(active.id)}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div style={{
        display: 'flex',
        gap: 16,
        overflowX: 'auto',
        paddingBottom: 16,
        minHeight: 400,
      }} className="no-scrollbar">
        {columns.map(col => (
          <KanbanColumn key={col.id} column={col} tasks={col.tasks} onUpdate={onUpdate} onSelect={onSelect} />
        ))}
      </div>

      <DragOverlay>
        {activeTask && (
          <TaskCard task={activeTask} isDragging />
        )}
      </DragOverlay>
    </DndContext>
  )
}

export default TaskKanban
