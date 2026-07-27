/**
 * Brain — Conflict Detection.
 *
 * Detects conflicts and records them in the conflicts table. `conflict_type`
 * identifies *which entities* collided; `category` (Phase 3) identifies
 * *what kind* of conflict it is — independent dimensions, since e.g. a
 * task_vs_task collision can be either a direct contradiction or a
 * resource conflict:
 *   1. GOAL_VS_GOAL   (category: direct|resource) — two active goals that
 *      strategically contradict each other.
 *   2. TASK_VS_WINDOW (category: timing) — a task would touch an area
 *      still in its measurement window.
 *   3. TASK_VS_GOAL   (category: direct|resource) — a task works against
 *      an active goal.
 *   4. TASK_VS_TASK   (category: direct|resource, Phase 3) — two open
 *      tasks contradict each other or compete for the same resource.
 *   5. SIGNAL_VS_GOAL (category: direct, Phase 3) — an open signal
 *      contradicts an active goal's operating assumption.
 *   6. GOAL_DEPENDENCY (category: dependency, Phase 3) — a goal is
 *      active/progressing while a goal it explicitly depends on
 *      (goal_dependencies) isn't achieved yet — deterministic, no LLM call.
 *
 * Runs on-demand (goal/task/signal creation) and weekly (full goal audit).
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { recordDecision } from './decision-memory.js';

const SYSTEM_PROMPT = `You assess whether two business entities are in strategic conflict.

Be conservative. Only flag a conflict if pursuing one would genuinely damage
the other. Don't flag things that are merely "unrelated" or "different focus".

Return only valid JSON. No prose outside JSON.

Shape:
{
  "in_conflict": true|false,
  "severity": "warning|critical",
  "category": "direct|resource",
  "description": "1-2 sentences describing what specifically conflicts",
  "why_it_matters": "what could go wrong",
  "resolution_kind": "pause_one|modify_one|accept_knowingly|no_action",
  "recommendation": "concrete action to resolve"
}

"direct" means the two things actively work against each other (e.g. one
deletes a page while the other optimises its SEO). "resource" means they
compete for the same limited budget, spend, or capacity (e.g. cutting ad
spend while a goal depends on ad-driven revenue growth) rather than
directly undoing each other's work.`;

function extractJSON(content: string): Record<string, unknown> | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str!.trim()); } catch { return null; }
}

interface ConflictRow {
  business_id: string;
  conflict_type: string;
  category?: string; // direct|resource|timing|dependency — defaults per conflict_type if omitted
  severity: string;
  entity_a_type: string;
  entity_a_id: string;
  entity_a_title?: string | null;
  entity_b_type: string;
  entity_b_id: string;
  entity_b_title?: string | null;
  description: string;
  recommendation?: string | null;
  resolution_kind?: string | null;
}

const DEFAULT_CATEGORY_BY_TYPE: Record<string, string> = {
  task_vs_window: 'timing',
  goal_dependency: 'dependency',
};

function insertConflict(row: ConflictRow): string {
  // Avoid duplicate open conflicts between the same two entities.
  const existing = db.prepare(`
    SELECT id FROM conflicts
    WHERE business_id = ? AND status = 'open'
      AND (
        (entity_a_type = ? AND entity_a_id = ? AND entity_b_type = ? AND entity_b_id = ?)
        OR
        (entity_a_type = ? AND entity_a_id = ? AND entity_b_type = ? AND entity_b_id = ?)
      )
  `).get(
    row.business_id,
    row.entity_a_type, row.entity_a_id, row.entity_b_type, row.entity_b_id,
    row.entity_b_type, row.entity_b_id, row.entity_a_type, row.entity_a_id,
  ) as { id: string } | null;
  if (existing) return existing.id;

  const category = row.category ?? DEFAULT_CATEGORY_BY_TYPE[row.conflict_type] ?? 'direct';
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO conflicts
    (id, business_id, conflict_type, category, severity,
     entity_a_type, entity_a_id, entity_a_title,
     entity_b_type, entity_b_id, entity_b_title,
     description, recommendation, resolution_kind, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(
    id, row.business_id, row.conflict_type, category, row.severity,
    row.entity_a_type, row.entity_a_id, row.entity_a_title ?? null,
    row.entity_b_type, row.entity_b_id, row.entity_b_title ?? null,
    row.description, row.recommendation ?? null, row.resolution_kind ?? null,
  );
  return id;
}

/* ─── Goal vs Goal ─────────────────────────────────────────────────────── */

async function assessGoalPair(goalA: Record<string, unknown>, goalB: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const user = `Goal A: "${goalA.title}" — metric ${(goalA.metric_name as string | null) ?? 'none'}, target ${(goalA.metric_target as unknown) ?? '?'}. Strategy: ${(goalA.strategy as string | null) ?? '(none)'}
Goal B: "${goalB.title}" — metric ${(goalB.metric_name as string | null) ?? 'none'}, target ${(goalB.metric_target as unknown) ?? '?'}. Strategy: ${(goalB.strategy as string | null) ?? '(none)'}

Do these two goals strategically conflict? (e.g. one requires expanding content while the other requires reducing it; one optimises for SEO while the other deliberately hides pages.)`;

  const { providerId, model } = resolveProfileLLM({}, { tier: 'triage' });
  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1, max_tokens: 600,
    });
    return extractJSON((result as { content: string } | null)?.content ?? '');
  } catch { return null; }
}

export async function checkGoalConflicts(goalId: string, businessId: string): Promise<string[]> {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND business_id = ?').get(goalId, businessId) as Record<string, unknown> | null;
  if (!goal || goal.status !== 'active') return [];

  const others = db.prepare(`
    SELECT * FROM goals
    WHERE business_id = ? AND id != ? AND status = 'active'
  `).all(businessId, goalId) as Record<string, unknown>[];

  const conflicts: string[] = [];
  for (const other of others) {
    const assessment = await assessGoalPair(goal, other);
    if (assessment?.in_conflict) {
      const id = insertConflict({
        business_id: businessId,
        conflict_type: 'goal_vs_goal',
        category: assessment.category === 'resource' ? 'resource' : 'direct',
        severity: assessment.severity === 'critical' ? 'critical' : 'warning',
        entity_a_type: 'goal', entity_a_id: goal.id as string, entity_a_title: goal.title as string,
        entity_b_type: 'goal', entity_b_id: other.id as string, entity_b_title: other.title as string,
        description: assessment.description as string,
        recommendation: assessment.recommendation as string | null,
        resolution_kind: assessment.resolution_kind as string | null,
      });
      conflicts.push(id);
    }
  }
  conflicts.push(...checkGoalDependencyConflicts(goalId, businessId));
  return conflicts;
}

/* ─── Task vs Measurement Window ───────────────────────────────────────── */

export async function checkTaskWindowConflicts(task: Record<string, unknown>, businessId: string): Promise<string[]> {
  if (!task?.action_type) return [];

  // Same URL or entity overlap
  let payload: Record<string, unknown> = {};
  try { payload = typeof task.action_payload === 'string' ? JSON.parse(task.action_payload as string) : ((task.action_payload as Record<string, unknown>) ?? {}); } catch {}
  const url = (payload.url as string | null) ?? null;
  const entity = (payload.entity as string | null) ?? null;

  const candidates = db.prepare(`
    SELECT am.*, aw.display_name, aw.expected_days
    FROM action_memory am
    LEFT JOIN action_windows aw ON aw.action_type = am.action_type
    WHERE am.business_id = ?
      AND am.outcome_measured = 0
      AND am.do_not_touch_until > CURRENT_TIMESTAMP
      AND (
        am.action_type = ?
        OR (? IS NOT NULL AND am.target_url = ?)
        OR (? IS NOT NULL AND am.target_entity = ?)
      )
    ORDER BY am.created_at DESC
  `).all(
    businessId,
    task.action_type as string,
    url, url,
    entity, entity,
  ) as Record<string, unknown>[];

  const conflicts: string[] = [];
  for (const c of candidates) {
    const daysLeft = Math.ceil((new Date(c.do_not_touch_until as string).getTime() - Date.now()) / 86400000);
    const description = `Proposed "${String(task.title)}" would change the same area as "${String(c.title)}" which was completed and is still in its ${(c.display_name as string | null) ?? (c.action_type as string)} measurement window (${daysLeft}d remaining). Acting now would destroy attribution for both.`;
    const id = insertConflict({
      business_id: businessId,
      conflict_type: 'task_vs_window',
      severity: 'warning',
      entity_a_type: 'task', entity_a_id: task.id as string, entity_a_title: task.title as string,
      entity_b_type: 'action_memory', entity_b_id: c.id as string, entity_b_title: c.title as string,
      description,
      recommendation: `Wait until ${new Date(c.do_not_touch_until as string).toLocaleDateString('en-GB')} before running this task.`,
      resolution_kind: 'pause_one',
    });
    conflicts.push(id);
  }
  return conflicts;
}

/* ─── Task vs Goal ─────────────────────────────────────────────────────── */

async function assessTaskGoal(task: Record<string, unknown>, goal: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const user = `Goal: "${goal.title}" — metric ${(goal.metric_name as string | null) ?? 'none'}, target ${(goal.metric_target as unknown) ?? '?'}. Strategy: ${(goal.strategy as string | null) ?? '(none)'}
Proposed task: "${task.title}". Description: ${(task.description as string | null) ?? '(none)'}. Action type: ${(task.action_type as string | null) ?? 'unknown'}.

Does this task work AGAINST this goal (i.e. if we run this task, it will hurt our ability to achieve the goal)?`;

  const { providerId, model } = resolveProfileLLM({}, { tier: 'triage' });
  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1, max_tokens: 500,
    });
    return extractJSON((result as { content: string } | null)?.content ?? '');
  } catch { return null; }
}

export async function checkTaskGoalConflicts(task: Record<string, unknown>, businessId: string): Promise<string[]> {
  const activeGoals = db.prepare(`
    SELECT * FROM goals WHERE business_id = ? AND status = 'active'
  `).all(businessId) as Record<string, unknown>[];

  const conflicts: string[] = [];
  for (const goal of activeGoals) {
    const a = await assessTaskGoal(task, goal);
    if (a?.in_conflict) {
      const id = insertConflict({
        business_id: businessId,
        conflict_type: 'task_vs_goal',
        category: a.category === 'resource' ? 'resource' : 'direct',
        severity: a.severity === 'critical' ? 'critical' : 'warning',
        entity_a_type: 'task', entity_a_id: task.id as string, entity_a_title: task.title as string,
        entity_b_type: 'goal', entity_b_id: goal.id as string, entity_b_title: goal.title as string,
        description: a.description as string,
        recommendation: a.recommendation as string | null,
        resolution_kind: a.resolution_kind as string | null,
      });
      conflicts.push(id);
    }
  }
  return conflicts;
}

/* ─── Task vs Task (Phase 3) ───────────────────────────────────────────── */

async function assessTaskPair(taskA: Record<string, unknown>, taskB: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const user = `Task A: "${taskA.title}" (${(taskA.action_type as string | null) ?? 'unknown'}). ${(taskA.description as string | null) ?? ''}
Task B: "${taskB.title}" (${(taskB.action_type as string | null) ?? 'unknown'}). ${(taskB.description as string | null) ?? ''}

Do these two proposed/in-flight tasks contradict each other or compete for the same limited resource (budget, headcount, the same page/entity)?`;

  const { providerId, model } = resolveProfileLLM({}, { tier: 'triage' });
  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1, max_tokens: 500,
    });
    return extractJSON((result as { content: string } | null)?.content ?? '');
  } catch { return null; }
}

/**
 * Candidates are narrowed to other open tasks (proposed/approved/executing)
 * that plausibly overlap — same signal, same action_type, or the same
 * action_payload.url/entity — same bounding strategy as
 * checkTaskWindowConflicts, so this never runs an LLM call against every
 * other open task in the business.
 */
export async function checkTaskTaskConflicts(task: Record<string, unknown>, businessId: string): Promise<string[]> {
  if (!task?.id) return [];
  let payload: Record<string, unknown> = {};
  try { payload = typeof task.action_payload === 'string' ? JSON.parse(task.action_payload as string) : ((task.action_payload as Record<string, unknown>) ?? {}); } catch {}
  const url = (payload.url as string | null) ?? null;
  const entity = (payload.entity as string | null) ?? null;

  const candidates = db.prepare(`
    SELECT * FROM tasks
    WHERE business_id = ? AND id != ? AND status IN ('proposed', 'approved', 'executing')
      AND (
        (signal_id IS NOT NULL AND signal_id = ?)
        OR action_type = ?
        OR (? IS NOT NULL AND action_payload LIKE ?)
        OR (? IS NOT NULL AND action_payload LIKE ?)
      )
    ORDER BY created_at DESC LIMIT 5
  `).all(
    businessId, task.id as string,
    (task.signal_id as string | null) ?? null,
    (task.action_type as string | null) ?? null,
    url, url ? `%${url}%` : null,
    entity, entity ? `%${entity}%` : null,
  ) as Record<string, unknown>[];

  const conflicts: string[] = [];
  for (const other of candidates) {
    const a = await assessTaskPair(task, other);
    if (a?.in_conflict) {
      const id = insertConflict({
        business_id: businessId,
        conflict_type: 'task_vs_task',
        category: a.category === 'resource' ? 'resource' : 'direct',
        severity: a.severity === 'critical' ? 'critical' : 'warning',
        entity_a_type: 'task', entity_a_id: task.id as string, entity_a_title: task.title as string,
        entity_b_type: 'task', entity_b_id: other.id as string, entity_b_title: other.title as string,
        description: a.description as string,
        recommendation: a.recommendation as string | null,
        resolution_kind: a.resolution_kind as string | null,
      });
      conflicts.push(id);
    }
  }
  return conflicts;
}

/* ─── Signal vs Goal (Phase 3) ─────────────────────────────────────────── */

async function assessSignalGoal(signal: Record<string, unknown>, goal: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const user = `Goal: "${goal.title}" — metric ${(goal.metric_name as string | null) ?? 'none'}, target ${(goal.metric_target as unknown) ?? '?'}. Strategy: ${(goal.strategy as string | null) ?? '(none)'}
Open signal: "${signal.title}" (${(signal.type as string | null) ?? 'unknown'}/${(signal.severity as string | null) ?? 'unknown'}). ${(signal.description as string | null) ?? ''}

Does this signal contradict an assumption this goal's strategy depends on (e.g. a "traffic declining" signal while the goal's plan assumes steady organic traffic)?`;

  const { providerId, model } = resolveProfileLLM({}, { tier: 'triage' });
  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1, max_tokens: 500,
    });
    return extractJSON((result as { content: string } | null)?.content ?? '');
  } catch { return null; }
}

export async function checkSignalGoalConflicts(signal: Record<string, unknown>, businessId: string): Promise<string[]> {
  if (!signal?.id) return [];
  const activeGoals = db.prepare(
    "SELECT * FROM goals WHERE business_id = ? AND status = 'active'"
  ).all(businessId) as Record<string, unknown>[];

  const conflicts: string[] = [];
  for (const goal of activeGoals) {
    const a = await assessSignalGoal(signal, goal);
    if (a?.in_conflict) {
      const id = insertConflict({
        business_id: businessId,
        conflict_type: 'signal_vs_goal',
        category: 'direct',
        severity: a.severity === 'critical' ? 'critical' : 'warning',
        entity_a_type: 'signal', entity_a_id: signal.id as string, entity_a_title: signal.title as string,
        entity_b_type: 'goal', entity_b_id: goal.id as string, entity_b_title: goal.title as string,
        description: a.description as string,
        recommendation: a.recommendation as string | null,
        resolution_kind: a.resolution_kind as string | null,
      });
      conflicts.push(id);
    }
  }
  return conflicts;
}

/* ─── Goal dependency conflicts (Phase 3, deterministic — no LLM call) ──── */

/**
 * A goal_dependencies edge (see GOAL_ENGINE.md) says "this goal depends on
 * that goal." If the dependency isn't achieved (or, for an active
 * dependency, isn't reasonably far along) while the dependent goal is
 * itself active, that is a real, checkable conflict — no judgment call
 * needed, so no LLM involved.
 */
export function checkGoalDependencyConflicts(goalId: string, businessId: string): string[] {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND business_id = ?').get(goalId, businessId) as Record<string, unknown> | null;
  if (!goal || goal.status !== 'active') return [];

  const deps = db.prepare(`
    SELECT gd.depends_on_goal_id, g.title, g.status, g.progress_pct
    FROM goal_dependencies gd JOIN goals g ON g.id = gd.depends_on_goal_id
    WHERE gd.goal_id = ?
  `).all(goalId) as Array<{ depends_on_goal_id: string; title: string; status: string; progress_pct: number | null }>;

  const conflicts: string[] = [];
  for (const dep of deps) {
    const blocked = dep.status === 'missed' || dep.status === 'cancelled' ||
      (dep.status === 'active' && (dep.progress_pct ?? 0) < 50);
    if (!blocked) continue;
    const id = insertConflict({
      business_id: businessId,
      conflict_type: 'goal_dependency',
      category: 'dependency',
      severity: dep.status === 'missed' || dep.status === 'cancelled' ? 'critical' : 'warning',
      entity_a_type: 'goal', entity_a_id: goalId, entity_a_title: goal.title as string,
      entity_b_type: 'goal', entity_b_id: dep.depends_on_goal_id, entity_b_title: dep.title,
      description: dep.status === 'missed' || dep.status === 'cancelled'
        ? `"${goal.title as string}" depends on "${dep.title}", which is ${dep.status} — this goal cannot proceed as planned.`
        : `"${goal.title as string}" depends on "${dep.title}", which is only ${(dep.progress_pct ?? 0).toFixed(0)}% complete.`,
      recommendation: `Prioritise "${dep.title}" or update "${goal.title as string}"'s dependency.`,
      resolution_kind: 'pause_one',
    });
    conflicts.push(id);
  }
  return conflicts;
}

/* ─── Aggregate checks ─────────────────────────────────────────────────── */

export async function runTaskConflictCheck(task: Record<string, unknown>, businessId: string): Promise<string[]> {
  const [windowConflicts, goalConflicts, taskConflicts] = await Promise.all([
    checkTaskWindowConflicts(task, businessId).catch(() => [] as string[]),
    checkTaskGoalConflicts(task, businessId).catch(() => [] as string[]),
    checkTaskTaskConflicts(task, businessId).catch(() => [] as string[]),
  ]);
  return [...windowConflicts, ...goalConflicts, ...taskConflicts];
}

export async function auditAllGoalConflicts(businessId: string): Promise<number> {
  const goals = db.prepare(`
    SELECT id FROM goals WHERE business_id = ? AND status = 'active'
  `).all(businessId) as { id: string }[];
  let total = 0;
  for (const g of goals) {
    const c = await checkGoalConflicts(g.id, businessId).catch(() => [] as string[]);
    total += c.length;
  }
  return total;
}

/* ─── Resolution ───────────────────────────────────────────────────────── */

export function resolveConflict(id: string, note?: string | null, actor = 'human'): void {
  const before = db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as Record<string, unknown> | null;
  db.prepare(`
    UPDATE conflicts
    SET status = 'resolved', resolution_note = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(note ?? null, id);
  if (before) {
    recordDecision({
      business_id: before.business_id as string, decision_type: 'conflict_resolution',
      title: `Resolved conflict: ${before.entity_a_title ?? before.entity_a_id} vs ${before.entity_b_title ?? before.entity_b_id}`,
      decision: `Resolved ${before.conflict_type as string} conflict.${note ? ` ${note}` : ''}`,
      reasoning: (before.description as string | null) ?? null,
      author: actor, related_conflict_id: id,
      related_goal_id: before.entity_a_type === 'goal' ? (before.entity_a_id as string) : before.entity_b_type === 'goal' ? (before.entity_b_id as string) : null,
      related_task_id: before.entity_a_type === 'task' ? (before.entity_a_id as string) : before.entity_b_type === 'task' ? (before.entity_b_id as string) : null,
      related_signal_id: before.entity_a_type === 'signal' ? (before.entity_a_id as string) : before.entity_b_type === 'signal' ? (before.entity_b_id as string) : null,
    });
  }
}

export function dismissConflict(id: string, reason?: string | null, actor = 'human'): void {
  const before = db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as Record<string, unknown> | null;
  db.prepare(`
    UPDATE conflicts
    SET status = 'dismissed', resolution_note = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason ?? null, id);
  if (before) {
    recordDecision({
      business_id: before.business_id as string, decision_type: 'conflict_dismissal',
      title: `Dismissed conflict: ${before.entity_a_title ?? before.entity_a_id} vs ${before.entity_b_title ?? before.entity_b_id}`,
      decision: `Dismissed ${before.conflict_type as string} conflict as not actionable.${reason ? ` ${reason}` : ''}`,
      reasoning: reason ?? null,
      author: actor, related_conflict_id: id,
      related_goal_id: before.entity_a_type === 'goal' ? (before.entity_a_id as string) : before.entity_b_type === 'goal' ? (before.entity_b_id as string) : null,
      related_task_id: before.entity_a_type === 'task' ? (before.entity_a_id as string) : before.entity_b_type === 'task' ? (before.entity_b_id as string) : null,
      related_signal_id: before.entity_a_type === 'signal' ? (before.entity_a_id as string) : before.entity_b_type === 'signal' ? (before.entity_b_id as string) : null,
    });
  }
}

/**
 * Auto-resolve conflicts whose entities are no longer active.
 */
export function autoResolveStale(): number {
  // Task entities: resolve if task is cancelled/complete
  const taskStale = db.prepare(`
    UPDATE conflicts
    SET status = 'resolved', resolution_note = 'Auto-resolved: task is no longer pending',
        resolved_at = CURRENT_TIMESTAMP
    WHERE status = 'open'
      AND entity_a_type = 'task'
      AND entity_a_id IN (
        SELECT id FROM tasks WHERE status IN ('complete', 'cancelled', 'rejected')
      )
  `).run();
  const taskStaleB = db.prepare(`
    UPDATE conflicts
    SET status = 'resolved', resolution_note = 'Auto-resolved: task is no longer pending',
        resolved_at = CURRENT_TIMESTAMP
    WHERE status = 'open'
      AND entity_b_type = 'task'
      AND entity_b_id IN (
        SELECT id FROM tasks WHERE status IN ('complete', 'cancelled', 'rejected')
      )
  `).run();
  // Goal entities: resolve if goal is cancelled/achieved
  const goalStale = db.prepare(`
    UPDATE conflicts
    SET status = 'resolved', resolution_note = 'Auto-resolved: goal is no longer active',
        resolved_at = CURRENT_TIMESTAMP
    WHERE status = 'open'
      AND (
        (entity_a_type = 'goal' AND entity_a_id IN (SELECT id FROM goals WHERE status IN ('achieved','cancelled','missed')))
        OR
        (entity_b_type = 'goal' AND entity_b_id IN (SELECT id FROM goals WHERE status IN ('achieved','cancelled','missed')))
      )
  `).run();
  // Action memory: if outcome_measured, window is closed
  const actionStale = db.prepare(`
    UPDATE conflicts
    SET status = 'resolved', resolution_note = 'Auto-resolved: measurement window closed',
        resolved_at = CURRENT_TIMESTAMP
    WHERE status = 'open'
      AND conflict_type = 'task_vs_window'
      AND entity_b_id IN (SELECT id FROM action_memory WHERE outcome_measured = 1)
  `).run();
  return (taskStale.changes || 0) + (taskStaleB.changes || 0) + (goalStale.changes || 0) + (actionStale.changes || 0);
}

export function listConflicts(businessId: string, filters: Record<string, string> = {}): Record<string, unknown>[] {
  const clauses = ['business_id = ?'];
  const params: any[] = [businessId];
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (filters.entity_id) {
    clauses.push('(entity_a_id = ? OR entity_b_id = ?)');
    params.push(filters.entity_id, filters.entity_id);
  }
  if (filters.conflict_type) { clauses.push('conflict_type = ?'); params.push(filters.conflict_type); }
  if (filters.category) { clauses.push('category = ?'); params.push(filters.category); }
  return db.prepare(`
    SELECT * FROM conflicts
    WHERE ${clauses.join(' AND ')}
    ORDER BY detected_at DESC LIMIT 200
  `).all(...params) as Record<string, unknown>[];
}
