/**
 * Brain — Knowledge Graph (Phase 3).
 *
 * Extends the KB from a document store (git-backed markdown +
 * `[[wikilinks]]`) into a typed entity/edge graph Hermes can traverse
 * relationship-by-relationship instead of only keyword-searching text.
 *
 * Entities backed by a real table (goal, signal, task, outcome, connector,
 * decision) are derived automatically by deriveEdgesForBusiness() from the
 * relationships that already exist in those tables/columns — nothing is
 * duplicated, kg_entities.ref_table/ref_id just points back at the row.
 *
 * Entities with NO backing table in this schema (competitor, product,
 * customer, campaign, person) have no automatic extraction pipeline —
 * there is nothing today that reliably identifies "this KB page mentions
 * competitor X" without an LLM entity-extraction pass this phase does not
 * build. createStandaloneEntity() lets a human or BAP caller register one
 * manually and link edges to it; see PHASE3.md's "remaining limitations."
 */
import crypto from 'crypto';
import db from '../db/db.js';

export type KgEdgeType =
  | 'caused' | 'supports' | 'blocks' | 'depends_on' | 'relates_to'
  | 'mentions' | 'supersedes' | 'contradicts' | 'improves' | 'regresses';

export interface EntityRef { ref_table: string; ref_id: string }

function upsertEntity(businessId: string | null, entityType: string, ref: EntityRef | null, label: string, metadata: Record<string, unknown> = {}): string {
  if (ref) {
    const existing = db.prepare(
      'SELECT id FROM kg_entities WHERE ref_table = ? AND ref_id = ?'
    ).get(ref.ref_table, ref.ref_id) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO kg_entities (id, business_id, entity_type, ref_table, ref_id, label, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, businessId, entityType, ref?.ref_table ?? null, ref?.ref_id ?? null, label, JSON.stringify(metadata));
  return id;
}

/** Manually register an entity with no backing table (competitor, product, customer, campaign, person). */
export function createStandaloneEntity(businessId: string, entityType: string, label: string, metadata: Record<string, unknown> = {}): string {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO kg_entities (id, business_id, entity_type, ref_table, ref_id, label, metadata, created_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, businessId, entityType, label, JSON.stringify(metadata));
  return id;
}

function upsertEdge(businessId: string | null, fromId: string, toId: string, edgeType: KgEdgeType, weight = 1.0, evidence: string | null = null): void {
  if (fromId === toId) return;
  db.prepare(`
    INSERT INTO kg_edges (id, business_id, from_entity_id, to_entity_id, edge_type, weight, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(from_entity_id, to_entity_id, edge_type) DO UPDATE SET weight = excluded.weight, evidence = excluded.evidence
  `).run(crypto.randomUUID(), businessId, fromId, toId, edgeType, weight, evidence);
}

export function createEdge(businessId: string, fromRef: EntityRef, fromLabel: string, fromType: string, toRef: EntityRef, toLabel: string, toType: string, edgeType: KgEdgeType, evidence: string | null = null): void {
  const fromId = upsertEntity(businessId, fromType, fromRef, fromLabel);
  const toId = upsertEntity(businessId, toType, toRef, toLabel);
  upsertEdge(businessId, fromId, toId, edgeType, 1.0, evidence);
}

/**
 * Rebuilds every derivable edge for a business from current relational
 * state. Idempotent (upserts) — safe to call repeatedly (BAP's
 * POST /businesses/:id/graph/rebuild, or a future scheduled pass).
 * Returns how many entities/edges exist afterward, not how many changed.
 */
export function deriveEdgesForBusiness(businessId: string): { entities: number; edges: number } {
  // Tasks: signal caused it, it supports its goal, its outcome
  // improves/regresses that goal.
  const tasks = db.prepare(
    'SELECT id, title, signal_id, goal_id FROM tasks WHERE business_id = ?'
  ).all(businessId) as Array<{ id: string; title: string; signal_id: string | null; goal_id: string | null }>;
  for (const t of tasks) {
    if (t.signal_id) {
      const signal = db.prepare('SELECT id, title FROM signals WHERE id = ?').get(t.signal_id) as { id: string; title: string } | undefined;
      if (signal) createEdge(businessId, { ref_table: 'signals', ref_id: signal.id }, signal.title, 'signal', { ref_table: 'tasks', ref_id: t.id }, t.title, 'task', 'caused');
    }
    if (t.goal_id) {
      const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(t.goal_id) as { id: string; title: string } | undefined;
      if (goal) createEdge(businessId, { ref_table: 'tasks', ref_id: t.id }, t.title, 'task', { ref_table: 'goals', ref_id: goal.id }, goal.title, 'goal', 'supports');
    }
  }

  const outcomes = db.prepare(`
    SELECT o.id, o.task_id, o.verdict, t.title AS task_title, t.goal_id
    FROM task_outcomes o JOIN tasks t ON t.id = o.task_id
    WHERE t.business_id = ? AND o.verdict IS NOT NULL AND t.goal_id IS NOT NULL
  `).all(businessId) as Array<{ id: string; task_id: string; verdict: string; task_title: string; goal_id: string }>;
  for (const o of outcomes) {
    const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(o.goal_id) as { id: string; title: string } | undefined;
    if (!goal) continue;
    const edgeType: KgEdgeType = o.verdict === 'improved' ? 'improves' : o.verdict === 'worsened' ? 'regresses' : 'relates_to';
    createEdge(businessId, { ref_table: 'tasks', ref_id: o.task_id }, o.task_title, 'task', { ref_table: 'goals', ref_id: goal.id }, goal.title, 'goal', edgeType);
  }

  const conflicts = db.prepare(
    "SELECT id, category, entity_a_type, entity_a_id, entity_a_title, entity_b_type, entity_b_id, entity_b_title FROM conflicts WHERE business_id = ? AND status = 'open'"
  ).all(businessId) as Array<{ id: string; category: string; entity_a_type: string; entity_a_id: string; entity_a_title: string | null; entity_b_type: string; entity_b_id: string; entity_b_title: string | null }>;
  for (const c of conflicts) {
    const edgeType: KgEdgeType = c.category === 'dependency' || c.category === 'timing' ? 'blocks' : 'contradicts';
    createEdge(
      businessId,
      { ref_table: `${c.entity_a_type}s`, ref_id: c.entity_a_id }, c.entity_a_title ?? c.entity_a_id, c.entity_a_type,
      { ref_table: `${c.entity_b_type}s`, ref_id: c.entity_b_id }, c.entity_b_title ?? c.entity_b_id, c.entity_b_type,
      edgeType, `conflict:${c.id}`,
    );
  }

  const decisions = db.prepare(
    'SELECT id, title, related_goal_id, related_task_id, related_signal_id FROM decisions WHERE business_id = ?'
  ).all(businessId) as Array<{ id: string; title: string; related_goal_id: string | null; related_task_id: string | null; related_signal_id: string | null }>;
  for (const d of decisions) {
    if (d.related_goal_id) {
      const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(d.related_goal_id) as { id: string; title: string } | undefined;
      if (goal) createEdge(businessId, { ref_table: 'decisions', ref_id: d.id }, d.title, 'decision', { ref_table: 'goals', ref_id: goal.id }, goal.title, 'goal', 'relates_to');
    }
    if (d.related_task_id) {
      const task = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(d.related_task_id) as { id: string; title: string } | undefined;
      if (task) createEdge(businessId, { ref_table: 'decisions', ref_id: d.id }, d.title, 'decision', { ref_table: 'tasks', ref_id: task.id }, task.title, 'task', 'relates_to');
    }
  }

  const dependencies = db.prepare(`
    SELECT gd.goal_id, g1.title AS goal_title, gd.depends_on_goal_id, g2.title AS dep_title
    FROM goal_dependencies gd
    JOIN goals g1 ON g1.id = gd.goal_id JOIN goals g2 ON g2.id = gd.depends_on_goal_id
    WHERE gd.business_id = ?
  `).all(businessId) as Array<{ goal_id: string; goal_title: string; depends_on_goal_id: string; dep_title: string }>;
  for (const d of dependencies) {
    createEdge(businessId, { ref_table: 'goals', ref_id: d.goal_id }, d.goal_title, 'goal', { ref_table: 'goals', ref_id: d.depends_on_goal_id }, d.dep_title, 'goal', 'depends_on');
  }

  const entityCount = (db.prepare('SELECT COUNT(*) AS n FROM kg_entities WHERE business_id = ?').get(businessId) as { n: number }).n;
  const edgeCount = (db.prepare('SELECT COUNT(*) AS n FROM kg_edges WHERE business_id = ?').get(businessId) as { n: number }).n;
  return { entities: entityCount, edges: edgeCount };
}

export interface GraphNode { id: string; entity_type: string; label: string; ref_table: string | null; ref_id: string | null }
export interface GraphEdge { id: string; from_entity_id: string; to_entity_id: string; edge_type: string; weight: number; evidence: string | null }

const MAX_NODES = 200;

/**
 * BFS from a starting entity (looked up by ref_table/ref_id, since callers
 * think in terms of "this goal"/"this task", not opaque kg_entities IDs).
 * Traverses edges in both directions (a "depends_on" edge is as relevant
 * when arrived at from either end). Capped at MAX_NODES to keep this a
 * bounded read even on a densely-connected graph.
 */
export function traverseGraph(
  businessId: string,
  start: EntityRef,
  opts: { depth?: number; edgeTypes?: string[] } = {}
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const depth = Math.min(5, Math.max(1, opts.depth ?? 2));
  const startEntity = db.prepare(
    'SELECT id FROM kg_entities WHERE business_id = ? AND ref_table = ? AND ref_id = ?'
  ).get(businessId, start.ref_table, start.ref_id) as { id: string } | undefined;
  if (!startEntity) return { nodes: [], edges: [] };

  const visitedNodeIds = new Set<string>([startEntity.id]);
  const edgeRows: GraphEdge[] = [];
  let frontier = [startEntity.id];

  const edgeTypeFilter = opts.edgeTypes?.length ? `AND edge_type IN (${opts.edgeTypes.map(() => '?').join(',')})` : '';

  for (let hop = 0; hop < depth && frontier.length > 0 && visitedNodeIds.size < MAX_NODES; hop++) {
    const placeholders = frontier.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM kg_edges WHERE business_id = ? AND (from_entity_id IN (${placeholders}) OR to_entity_id IN (${placeholders})) ${edgeTypeFilter}`
    ).all(businessId, ...frontier, ...frontier, ...(opts.edgeTypes ?? [])) as GraphEdge[];

    const nextFrontier: string[] = [];
    for (const e of rows) {
      if (!edgeRows.some((existing) => existing.id === e.id)) edgeRows.push(e);
      for (const candidate of [e.from_entity_id, e.to_entity_id]) {
        if (!visitedNodeIds.has(candidate) && visitedNodeIds.size < MAX_NODES) {
          visitedNodeIds.add(candidate);
          nextFrontier.push(candidate);
        }
      }
    }
    frontier = nextFrontier;
  }

  const nodeIds = Array.from(visitedNodeIds);
  const nodes = nodeIds.length
    ? db.prepare(`SELECT id, entity_type, label, ref_table, ref_id FROM kg_entities WHERE id IN (${nodeIds.map(() => '?').join(',')})`).all(...nodeIds) as GraphNode[]
    : [];

  return { nodes, edges: edgeRows };
}
