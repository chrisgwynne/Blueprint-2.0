/**
 * Brain — Conflict Detection.
 *
 * Detects three kinds of conflicts and records them in the conflicts table:
 *   1. GOAL_VS_GOAL: two active goals that strategically contradict each other.
 *   2. TASK_VS_WINDOW: a task would touch an area still in its measurement window.
 *   3. TASK_VS_GOAL: a task works against an active goal.
 *
 * Runs on-demand (goal/task creation) and weekly (full goal audit).
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const SYSTEM_PROMPT = `You assess whether two business entities are in strategic conflict.

Be conservative. Only flag a conflict if pursuing one would genuinely damage
the other. Don't flag things that are merely "unrelated" or "different focus".

Return only valid JSON. No prose outside JSON.

Shape:
{
  "in_conflict": true|false,
  "severity": "warning|critical",
  "description": "1-2 sentences describing what specifically conflicts",
  "why_it_matters": "what could go wrong",
  "resolution_kind": "pause_one|modify_one|accept_knowingly|no_action",
  "recommendation": "concrete action to resolve"
}`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

function insertConflict(row) {
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
  );
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO conflicts
    (id, business_id, conflict_type, severity,
     entity_a_type, entity_a_id, entity_a_title,
     entity_b_type, entity_b_id, entity_b_title,
     description, recommendation, resolution_kind, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(
    id, row.business_id, row.conflict_type, row.severity,
    row.entity_a_type, row.entity_a_id, row.entity_a_title ?? null,
    row.entity_b_type, row.entity_b_id, row.entity_b_title ?? null,
    row.description, row.recommendation ?? null, row.resolution_kind ?? null,
  );
  return id;
}

/* ─── Goal vs Goal ─────────────────────────────────────────────────────── */

async function assessGoalPair(goalA, goalB) {
  const user = `Goal A: "${goalA.title}" — metric ${goalA.metric_name ?? 'none'}, target ${goalA.metric_target ?? '?'}. Strategy: ${goalA.strategy ?? '(none)'}
Goal B: "${goalB.title}" — metric ${goalB.metric_name ?? 'none'}, target ${goalB.metric_target ?? '?'}. Strategy: ${goalB.strategy ?? '(none)'}

Do these two goals strategically conflict? (e.g. one requires expanding content while the other requires reducing it; one optimises for SEO while the other deliberately hides pages.)`;

  const { providerId, model } = resolveProfileLLM({
    model: 'claude-haiku-4-5-20251001',
  });
  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1, max_tokens: 600,
    });
    return extractJSON(result?.content ?? '');
  } catch { return null; }
}

export async function checkGoalConflicts(goalId, businessId) {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND business_id = ?').get(goalId, businessId);
  if (!goal || goal.status !== 'active') return [];

  const others = db.prepare(`
    SELECT * FROM goals
    WHERE business_id = ? AND id != ? AND status = 'active'
  `).all(businessId, goalId);

  const conflicts = [];
  for (const other of others) {
    const assessment = await assessGoalPair(goal, other);
    if (assessment?.in_conflict) {
      const id = insertConflict({
        business_id: businessId,
        conflict_type: 'goal_vs_goal',
        severity: assessment.severity === 'critical' ? 'critical' : 'warning',
        entity_a_type: 'goal', entity_a_id: goal.id, entity_a_title: goal.title,
        entity_b_type: 'goal', entity_b_id: other.id, entity_b_title: other.title,
        description: assessment.description,
        recommendation: assessment.recommendation,
        resolution_kind: assessment.resolution_kind,
      });
      conflicts.push(id);
    }
  }
  return conflicts;
}

/* ─── Task vs Measurement Window ───────────────────────────────────────── */

export async function checkTaskWindowConflicts(task, businessId) {
  if (!task?.action_type) return [];

  // Same URL or entity overlap
  let payload = {};
  try { payload = typeof task.action_payload === 'string' ? JSON.parse(task.action_payload) : (task.action_payload ?? {}); } catch {}
  const url = payload.url ?? null;
  const entity = payload.entity ?? null;

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
    task.action_type,
    url, url,
    entity, entity,
  );

  const conflicts = [];
  for (const c of candidates) {
    const daysLeft = Math.ceil((new Date(c.do_not_touch_until) - Date.now()) / 86400000);
    const description = `Proposed "${task.title}" would change the same area as "${c.title}" which was completed and is still in its ${c.display_name ?? c.action_type} measurement window (${daysLeft}d remaining). Acting now would destroy attribution for both.`;
    const id = insertConflict({
      business_id: businessId,
      conflict_type: 'task_vs_window',
      severity: 'warning',
      entity_a_type: 'task', entity_a_id: task.id, entity_a_title: task.title,
      entity_b_type: 'action_memory', entity_b_id: c.id, entity_b_title: c.title,
      description,
      recommendation: `Wait until ${new Date(c.do_not_touch_until).toLocaleDateString('en-GB')} before running this task.`,
      resolution_kind: 'pause_one',
    });
    conflicts.push(id);
  }
  return conflicts;
}

/* ─── Task vs Goal ─────────────────────────────────────────────────────── */

async function assessTaskGoal(task, goal) {
  const user = `Goal: "${goal.title}" — metric ${goal.metric_name ?? 'none'}, target ${goal.metric_target ?? '?'}. Strategy: ${goal.strategy ?? '(none)'}
Proposed task: "${task.title}". Description: ${task.description ?? '(none)'}. Action type: ${task.action_type ?? 'unknown'}.

Does this task work AGAINST this goal (i.e. if we run this task, it will hurt our ability to achieve the goal)?`;

  const { providerId, model } = resolveProfileLLM({
    model: 'claude-haiku-4-5-20251001',
  });
  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1, max_tokens: 500,
    });
    return extractJSON(result?.content ?? '');
  } catch { return null; }
}

export async function checkTaskGoalConflicts(task, businessId) {
  const activeGoals = db.prepare(`
    SELECT * FROM goals WHERE business_id = ? AND status = 'active'
  `).all(businessId);

  const conflicts = [];
  for (const goal of activeGoals) {
    const a = await assessTaskGoal(task, goal);
    if (a?.in_conflict) {
      const id = insertConflict({
        business_id: businessId,
        conflict_type: 'task_vs_goal',
        severity: a.severity === 'critical' ? 'critical' : 'warning',
        entity_a_type: 'task', entity_a_id: task.id, entity_a_title: task.title,
        entity_b_type: 'goal', entity_b_id: goal.id, entity_b_title: goal.title,
        description: a.description,
        recommendation: a.recommendation,
        resolution_kind: a.resolution_kind,
      });
      conflicts.push(id);
    }
  }
  return conflicts;
}

/* ─── Aggregate checks ─────────────────────────────────────────────────── */

export async function runTaskConflictCheck(task, businessId) {
  const [windowConflicts, goalConflicts] = await Promise.all([
    checkTaskWindowConflicts(task, businessId).catch(() => []),
    checkTaskGoalConflicts(task, businessId).catch(() => []),
  ]);
  return [...windowConflicts, ...goalConflicts];
}

export async function auditAllGoalConflicts(businessId) {
  const goals = db.prepare(`
    SELECT id FROM goals WHERE business_id = ? AND status = 'active'
  `).all(businessId);
  let total = 0;
  for (const g of goals) {
    const c = await checkGoalConflicts(g.id, businessId).catch(() => []);
    total += c.length;
  }
  return total;
}

/* ─── Resolution ───────────────────────────────────────────────────────── */

export function resolveConflict(id, note) {
  db.prepare(`
    UPDATE conflicts
    SET status = 'resolved', resolution_note = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(note ?? null, id);
}

export function dismissConflict(id, reason) {
  db.prepare(`
    UPDATE conflicts
    SET status = 'dismissed', resolution_note = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason ?? null, id);
}

/**
 * Auto-resolve conflicts whose entities are no longer active.
 */
export function autoResolveStale() {
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

export function listConflicts(businessId, filters = {}) {
  const clauses = ['business_id = ?'];
  const params = [businessId];
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (filters.entity_id) {
    clauses.push('(entity_a_id = ? OR entity_b_id = ?)');
    params.push(filters.entity_id, filters.entity_id);
  }
  return db.prepare(`
    SELECT * FROM conflicts
    WHERE ${clauses.join(' AND ')}
    ORDER BY detected_at DESC LIMIT 200
  `).all(...params);
}
