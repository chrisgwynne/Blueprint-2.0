import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { Share2, RefreshCw } from 'lucide-react'
import useStore from '../lib/store.js'
import { getGraph, rebuildGraph, getGoals, getTasks, getSignals, getDecisions } from '../lib/api.js'

interface GraphNode { id: string; entity_type: string; label: string; ref_table: string | null; ref_id: string | null }
interface GraphEdge { id: string; from_entity_id: string; to_entity_id: string; edge_type: string; weight: number; evidence: string | null }

const REF_TABLES = ['goals', 'tasks', 'signals', 'decisions', 'kg_entities']

const ENTITY_COLORS: Record<string, string> = {
  goal: 'var(--bp-blue)', task: 'var(--bp-green)', signal: 'var(--bp-amber)',
  decision: 'var(--bp-purple)', outcome: 'var(--bp-red)', connector: 'var(--bp-text-3)',
  competitor: '#e879f9', product: '#22d3ee', customer: '#a3e635', campaign: '#fb923c', person: '#94a3b8',
}

interface LayoutNode extends GraphNode { x: number; y: number }

/**
 * Minimal force-directed layout — no graph-visualization library is a
 * dependency of this project (see PHASE3.md's UI limitations). Plain
 * repulsion + spring + centering, run for a fixed number of iterations
 * synchronously; adequate for the bounded node count knowledge-graph.ts
 * already caps traversal to (MAX_NODES=200), well within what a
 * synchronous layout on the main thread can handle without jank.
 */
function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): LayoutNode[] {
  const cx = width / 2, cy = height / 2
  const positioned: LayoutNode[] = nodes.map((n, i) => {
    const angle = (i / Math.max(1, nodes.length)) * 2 * Math.PI
    const r = Math.min(width, height) / 3
    return { ...n, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
  })
  const byId = new Map(positioned.map((n) => [n.id, n]))
  const iterations = Math.min(300, 60 + nodes.length * 4)
  const idealEdgeLength = Math.max(60, Math.min(width, height) / Math.max(3, Math.sqrt(nodes.length)))

  for (let iter = 0; iter < iterations; iter++) {
    const forces = new Map<string, { fx: number; fy: number }>()
    for (const n of positioned) forces.set(n.id, { fx: 0, fy: 0 })

    for (let i = 0; i < positioned.length; i++) {
      for (let j = i + 1; j < positioned.length; j++) {
        const a = positioned[i]!, b = positioned[j]!
        const dx = a.x - b.x, dy = a.y - b.y
        const distSq = Math.max(1, dx * dx + dy * dy)
        const dist = Math.sqrt(distSq)
        const repulse = (idealEdgeLength * idealEdgeLength * 4) / distSq
        const fx = (dx / dist) * repulse, fy = (dy / dist) * repulse
        const fa = forces.get(a.id)!, fb = forces.get(b.id)!
        fa.fx += fx; fa.fy += fy
        fb.fx -= fx; fb.fy -= fy
      }
    }

    for (const e of edges) {
      const a = byId.get(e.from_entity_id), b = byId.get(e.to_entity_id)
      if (!a || !b) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const displacement = (dist - idealEdgeLength) * 0.05
      const fx = (dx / dist) * displacement, fy = (dy / dist) * displacement
      const fa = forces.get(a.id)!, fb = forces.get(b.id)!
      fa.fx += fx; fa.fy += fy
      fb.fx -= fx; fb.fy -= fy
    }

    for (const n of positioned) {
      const f = forces.get(n.id)!
      f.fx += (cx - n.x) * 0.01
      f.fy += (cy - n.y) * 0.01
      n.x += Math.max(-10, Math.min(10, f.fx * 0.1))
      n.y += Math.max(-10, Math.min(10, f.fy * 0.1))
      n.x = Math.max(30, Math.min(width - 30, n.x))
      n.y = Math.max(30, Math.min(height - 30, n.y))
    }
  }
  return positioned
}

export default function RelationshipGraph() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [refTable, setRefTable] = useState('goals')
  const [entities, setEntities] = useState<Array<{ id: string; label: string }>>([])
  const [refId, setRefId] = useState('')
  const [depth, setDepth] = useState(2)
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [rebuilding, setRebuilding] = useState(false)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)

  const WIDTH = 860, HEIGHT = 560

  // Populate the entity picker for the chosen ref_table.
  useEffect(() => {
    if (!currentBusiness) return
    setRefId('')
    async function loadEntities() {
      try {
        if (refTable === 'goals') {
          const rows = await getGoals(currentBusiness!.id)
          setEntities((rows || []).map((r: any) => ({ id: r.id, label: r.title })))
        } else if (refTable === 'tasks') {
          const rows = await getTasks(currentBusiness!.id)
          setEntities((rows || []).map((r: any) => ({ id: r.id, label: r.title })))
        } else if (refTable === 'signals') {
          const rows = await getSignals(currentBusiness!.id)
          setEntities((rows || []).map((r: any) => ({ id: r.id, label: r.title })))
        } else if (refTable === 'decisions') {
          const result = await getDecisions(currentBusiness!.id, { limit: 100 })
          setEntities((result?.decisions || []).map((r: any) => ({ id: r.id, label: r.title })))
        } else {
          setEntities([])
        }
      } catch { setEntities([]) }
    }
    loadEntities()
  }, [currentBusiness, refTable])

  const load = useCallback(async () => {
    if (!currentBusiness || !refId) { setNodes([]); setEdges([]); return }
    try {
      const result = await getGraph(currentBusiness.id, { ref_table: refTable, ref_id: refId, depth })
      setNodes(result?.nodes || [])
      setEdges(result?.edges || [])
      setSelectedNode(null)
    } catch { setNodes([]); setEdges([]) }
  }, [currentBusiness, refTable, refId, depth])

  useEffect(() => { load() }, [load])

  async function handleRebuild() {
    setRebuilding(true)
    try { await rebuildGraph(currentBusiness!.id); await load() }
    finally { setRebuilding(false) }
  }

  function handleNodeClick(n: GraphNode) {
    if (n.ref_table && n.ref_id) {
      setRefTable(n.ref_table)
      setRefId(n.ref_id)
    }
    setSelectedNode(n)
  }

  const layout = useMemo(() => layoutGraph(nodes, edges, WIDTH, HEIGHT), [nodes, edges])
  const layoutById = useMemo(() => new Map(layout.map((n) => [n.id, n])), [layout])

  if (!currentBusiness) {
    return <div style={{ padding: 40, color: 'var(--bp-text-3)' }}>Select a business.</div>
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Share2 size={20} style={{ color: 'var(--bp-blue)' }} />
            <h1 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--bp-text)' }}>RELATIONSHIP GRAPH</h1>
          </div>
          <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 12, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Traverse typed relationships between goals, tasks, signals, and decisions — click a node to re-centre.
          </p>
        </div>
        <button onClick={handleRebuild} disabled={rebuilding} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
          <RefreshCw size={11} /> {rebuilding ? 'Rebuilding…' : 'Rebuild derived edges'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select className="bp-input" style={{ fontSize: 12 }} value={refTable} onChange={(e) => setRefTable(e.target.value)}>
          {REF_TABLES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {refTable === 'kg_entities' ? (
          <input className="bp-input" placeholder="kg_entities id…" style={{ fontSize: 12, width: 260 }}
            value={refId} onChange={(e) => setRefId(e.target.value)} />
        ) : (
          <select className="bp-input" style={{ fontSize: 12, width: 260 }} value={refId} onChange={(e) => setRefId(e.target.value)}>
            <option value="">Start from…</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        )}
        <select className="bp-input" style={{ fontSize: 12 }} value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>depth {d}</option>)}
        </select>
      </div>

      {!refId ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          Pick a starting entity above to traverse its graph.
        </div>
      ) : nodes.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
          No derived edges for this entity yet. Try "Rebuild derived edges".
        </div>
      ) : (
        <div className="bp-card" style={{ padding: 0, overflow: 'auto' }}>
          <svg width={WIDTH} height={HEIGHT} style={{ display: 'block' }}>
            {edges.map((e) => {
              const a = layoutById.get(e.from_entity_id), b = layoutById.get(e.to_entity_id)
              if (!a || !b) return null
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
              return (
                <g key={e.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--bp-border-2)" strokeWidth={1 + e.weight} />
                  <text x={mx} y={my} fontSize={8} fontFamily="var(--bp-font-mono)" fill="var(--bp-text-3)" textAnchor="middle">
                    {e.edge_type}
                  </text>
                </g>
              )
            })}
            {layout.map((n) => {
              const color = ENTITY_COLORS[n.entity_type] ?? 'var(--bp-text-2)'
              const isSelected = selectedNode?.id === n.id
              return (
                <g key={n.id} onClick={() => handleNodeClick(n)} style={{ cursor: n.ref_table ? 'pointer' : 'default' }}>
                  <circle cx={n.x} cy={n.y} r={isSelected ? 10 : 7} fill={color} stroke="var(--bp-surface)" strokeWidth={2} />
                  <text x={n.x} y={n.y - 12} fontSize={9} fontFamily="var(--bp-font-mono)" fill="var(--bp-text-2)" textAnchor="middle">
                    {n.label.length > 24 ? `${n.label.slice(0, 24)}…` : n.label}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      )}

      {selectedNode && (
        <div className="bp-card" style={{ padding: 14, marginTop: 14 }}>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--bp-text-3)', marginBottom: 4 }}>
            {selectedNode.entity_type}
          </div>
          <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14 }}>{selectedNode.label}</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
        {Object.entries(ENTITY_COLORS).map(([type, color]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
            {type}
          </div>
        ))}
      </div>
    </div>
  )
}
