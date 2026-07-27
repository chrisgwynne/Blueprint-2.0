import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { deriveEdgesForBusiness, traverseGraph, createStandaloneEntity, createEdge } from './knowledge-graph.js';

const BIZ = 'biz_knowledge_graph_test';

function insertGoal(title: string): string {
  const id = generateId();
  db.prepare(`INSERT INTO goals (id, business_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(id, BIZ, title);
  return id;
}
function insertSignal(title: string): string {
  const id = generateId();
  db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, status, created_at) VALUES (?, ?, 'test', 'anomaly', 'info', ?, 'open', CURRENT_TIMESTAMP)`).run(id, BIZ, title);
  return id;
}
function insertTask(title: string, signalId: string | null, goalId: string | null): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, signal_id, goal_id, title, proposed_by, status, trust_tier, approval_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'agent:x', 'proposed', 'yellow', 'requires_approval', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, BIZ, signalId, goalId, title);
  return id;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Knowledge Graph Test', 'knowledge-graph-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM kg_edges WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM kg_entities WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM signals WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM goals WHERE business_id = ?`).run(BIZ);
});

describe('deriveEdgesForBusiness', () => {
  test('derives signal->task caused edge and task->goal supports edge', () => {
    const goalId = insertGoal('Grow revenue');
    const signalId = insertSignal('Traffic drop');
    const taskId = insertTask('Investigate traffic drop', signalId, goalId);

    deriveEdgesForBusiness(BIZ);

    const graph = traverseGraph(BIZ, { ref_table: 'tasks', ref_id: taskId }, { depth: 2 });
    const edgeTypes = graph.edges.map((e) => e.edge_type);
    expect(edgeTypes).toContain('caused');
    expect(edgeTypes).toContain('supports');
    expect(graph.nodes.some((n) => n.ref_id === signalId)).toBe(true);
    expect(graph.nodes.some((n) => n.ref_id === goalId)).toBe(true);
  });

  test('re-running is idempotent — no duplicate edges', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM kg_edges WHERE business_id = ?').get(BIZ) as { n: number }).n;
    deriveEdgesForBusiness(BIZ);
    deriveEdgesForBusiness(BIZ);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM kg_edges WHERE business_id = ?').get(BIZ) as { n: number }).n;
    expect(after).toBe(before);
  });

  test('derives improves/regresses edges from task outcomes', () => {
    const goalId = insertGoal('Improve CTR');
    const taskId = insertTask('Rewrite meta', null, goalId);
    db.prepare(`INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, verdict, created_at) VALUES (?, ?, CURRENT_TIMESTAMP, 4, 'improved', CURRENT_TIMESTAMP)`)
      .run(generateId(), taskId);

    deriveEdgesForBusiness(BIZ);
    const graph = traverseGraph(BIZ, { ref_table: 'goals', ref_id: goalId }, { depth: 1 });
    expect(graph.edges.some((e) => e.edge_type === 'improves')).toBe(true);
  });
});

describe('traverseGraph', () => {
  test('returns empty for an unknown starting entity', () => {
    const result = traverseGraph(BIZ, { ref_table: 'tasks', ref_id: 'does-not-exist' });
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  test('edgeTypes filter excludes non-matching edges', () => {
    const goalId = insertGoal('Filter test goal');
    const taskId = insertTask('Filter test task', null, goalId);
    deriveEdgesForBusiness(BIZ);

    const onlySupports = traverseGraph(BIZ, { ref_table: 'tasks', ref_id: taskId }, { edgeTypes: ['supports'] });
    expect(onlySupports.edges.every((e) => e.edge_type === 'supports')).toBe(true);

    const onlyCaused = traverseGraph(BIZ, { ref_table: 'tasks', ref_id: taskId }, { edgeTypes: ['caused'] });
    expect(onlyCaused.edges).toHaveLength(0);
  });

  test('depth limits how far traversal goes', () => {
    const goalId = insertGoal('Depth test goal');
    const signalId = insertSignal('Depth test signal');
    const taskId = insertTask('Depth test task', signalId, goalId);
    deriveEdgesForBusiness(BIZ);

    const shallow = traverseGraph(BIZ, { ref_table: 'tasks', ref_id: taskId }, { depth: 1 });
    expect(shallow.nodes.some((n) => n.ref_id === signalId)).toBe(true);
    expect(shallow.nodes.some((n) => n.ref_id === goalId)).toBe(true);
  });
});

describe('createStandaloneEntity (competitor/product/etc — no backing table)', () => {
  test('creates a node with no ref_table/ref_id, distinct from FK-backed entities', () => {
    const competitorId = createStandaloneEntity(BIZ, 'competitor', 'Acme Rival Co', { url: 'https://acme-rival.example' });
    const entity = db.prepare('SELECT * FROM kg_entities WHERE id = ?').get(competitorId) as Record<string, unknown>;
    expect(entity.entity_type).toBe('competitor');
    expect(entity.label).toBe('Acme Rival Co');
    expect(entity.ref_table).toBeNull();
    expect(entity.ref_id).toBeNull();
  });

  test('createEdge links two real (FK-backed) entities derived from the graph', () => {
    const goalId = insertGoal('Edge helper test goal');
    const taskId = insertTask('Edge helper test task', null, goalId);
    createEdge(
      BIZ, { ref_table: 'tasks', ref_id: taskId }, 'Edge helper test task', 'task',
      { ref_table: 'goals', ref_id: goalId }, 'Edge helper test goal', 'goal',
      'supports',
    );
    const graph = traverseGraph(BIZ, { ref_table: 'tasks', ref_id: taskId }, { depth: 1 });
    expect(graph.edges.some((e) => e.edge_type === 'supports')).toBe(true);
  });
});
