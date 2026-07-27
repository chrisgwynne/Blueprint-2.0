/**
 * Blueprint Agent Protocol (BAP) — Goals.
 *
 * Mounted at /api/bap/v1 alongside bap.ts (server/index.ts) — a separate
 * file purely to keep bap.ts from growing unboundedly as Phase 2 adds
 * subsystem after subsystem, not a different auth/consistency model.
 *
 * Goals were previously reachable only through server/routes/goals.ts,
 * gated by `isAuthenticated` (dashboard session cookie) — no BAP surface
 * existed at all (AUDIT-BAP-GAPS.md's F-20, "the single largest
 * functional blocker to autonomous operation": an agent couldn't know
 * what the business is trying to achieve, propose a goal, or report
 * progress against one). These routes reuse the exact same underlying
 * tables/engine functions the dashboard uses (server/goals/goal-engine.ts,
 * server/brain/goal-reasoner.ts, server/brain/conflict-engine.ts) — goals
 * created or updated via BAP are indistinguishable from dashboard-created
 * ones to every other part of the system.
 *
 * Endpoints:
 *   GET    /businesses/:bid/goals             — list (search/filter/paginate)
 *   POST   /businesses/:bid/goals             — propose a new goal
 *   GET    /goals/:id                         — detail (progress, milestones,
 *                                                notes, linked metrics/tasks/
 *                                                signals, blockers, conflicts)
 *   PATCH  /goals/:id                         — update (progress/status/etc)
 *   POST   /goals/:id/archive                 — soft-cancel (status='cancelled')
 *   POST   /goals/:id/check                   — recompute progress now
 *   GET    /goals/:id/conflicts               — conflicts referencing this goal
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db, { generateId } from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import {
  parsePagination, paginationMeta, toIso, normalizeTimestamps,
  withRequiredIdempotency, sendError,
} from '../bap/route-helpers.js';

// No auth/rate-limit middleware here — this router is mounted as a
// sub-router *inside* bap.ts, after bap.ts's own `router.use(bapAuth)`.
// Applying bapAuth again here would re-validate the API key and write a
// second bap_audit row for every request that falls through bap.ts's own
// routes to reach one of these — see bap.ts's mounting comment.
const router = Router();

const GOAL_TIMESTAMP_KEYS = ['deadline', 'last_checked', 'achieved_at', 'created_at', 'updated_at'] as const;

function safeJSON<T>(val: unknown, fallback: T): T {
  if (Array.isArray(val) || (typeof val === 'object' && val !== null)) return val as T;
  if (!val) return fallback;
  try { return JSON.parse(val as string) as T; } catch { return fallback; }
}

function parseGoalRow(row: Record<string, unknown>): Record<string, unknown> {
  return normalizeTimestamps({
    ...row,
    assigned_agents: safeJSON(row.assigned_agents, []),
    milestones: safeJSON(row.milestones, []),
    notes: safeJSON(row.notes, []),
    tags: safeJSON(row.tags, []),
  }, GOAL_TIMESTAMP_KEYS);
}

function likeTerm(raw: string): string {
  return `%${raw.replace(/[%_]/g, (c) => `\\${c}`)}%`;
}

// ─── List / create ──────────────────────────────────────────────────────────

router.get('/businesses/:businessId/goals', requirePermission('goals:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { q, status, tags } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (status) {
      const arr = String(status).split(',');
      conditions.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    } else {
      conditions.push("status != 'cancelled'"); // matches routes/goals.ts's default list behaviour
    }
    if (q) {
      conditions.push('(title LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')');
      const term = likeTerm(String(q));
      params.push(term, term);
    }
    if (tags) {
      // tags is a JSON array column — LIKE match is a reasonable low-volume
      // approach (same tradeoff the rest of the codebase makes for search).
      for (const tag of String(tags).split(',')) {
        conditions.push('tags LIKE ?');
        params.push(`%"${tag}"%`);
      }
    }

    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM goals WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = db.prepare(
      `SELECT * FROM goals WHERE ${where}
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, deadline ASC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>;

    return res.json({ goals: rows.map(parseGoalRow), total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/businesses/:businessId/goals', requirePermission('goals:propose'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!biz) return sendError(req, res, 404, 'not_found', 'Business not found.');

    const {
      title, description, deadline, metric_name, metric_baseline, metric_target, metric_unit,
      strategy, project_id, assigned_agents, milestones, tags,
    } = req.body as Record<string, unknown>;
    if (!title || typeof title !== 'string') return sendError(req, res, 400, 'validation_error', 'title is required.');

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;

    await withRequiredIdempotency(req, res, 'goals:propose', async () => {
      const id = generateId();
      // Auto-fill baseline from the latest matching metric, same as the
      // dashboard create route, if the caller didn't supply one.
      let baseline = typeof metric_baseline === 'number' ? metric_baseline : null;
      if (baseline == null && typeof metric_name === 'string' && metric_name) {
        const latest = db.prepare(
          'SELECT metric_value FROM metrics WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL ORDER BY recorded_at DESC LIMIT 1'
        ).get(businessId, metric_name) as { metric_value: number } | undefined;
        baseline = latest?.metric_value ?? null;
      }

      db.prepare(`
        INSERT INTO goals (
          id, business_id, title, description, status, created_by, assigned_agents,
          deadline, metric_name, metric_baseline, metric_target, metric_current, metric_unit,
          strategy, milestones, tags, project_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        id, businessId, title, (description as string) ?? null, `bap:${bapAgent.id as string}`,
        JSON.stringify(Array.isArray(assigned_agents) ? assigned_agents : []),
        (deadline as string) ?? null, (metric_name as string) ?? null, baseline,
        typeof metric_target === 'number' ? metric_target : null, baseline,
        (metric_unit as string) ?? null, (strategy as string) ?? null,
        JSON.stringify(Array.isArray(milestones) ? milestones : []),
        JSON.stringify(Array.isArray(tags) ? tags : []),
        (project_id as string) ?? null,
      );

      // Fire-and-forget, matching routes/goals.ts's create route — never
      // blocks the response on an LLM call.
      import('../brain/goal-reasoner.js').then((m) => (m as unknown as { runGoalReasoning: (id: string, bid: string) => Promise<unknown> }).runGoalReasoning(id, businessId)).catch(() => {});
      import('../brain/conflict-engine.js').then((m) => (m as unknown as { checkGoalConflicts: (id: string, bid: string) => Promise<unknown> }).checkGoalConflicts(id, businessId)).catch(() => {});

      const created = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown>;
      return { status: 201, body: { goal: parseGoalRow(created) } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

// ─── Detail / update / archive / check ──────────────────────────────────────

function loadGoalOr404(req: Request, res: Response, goalId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined;
  if (!row) { sendError(req, res, 404, 'not_found', `Goal '${goalId}' not found.`); return null; }
  const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
  if (!hasPermission(bapAgent, 'goals:read', row.business_id as string)) {
    sendError(req, res, 403, 'permission_denied', 'Permission denied: goal does not belong to an authorized business.');
    return null;
  }
  return row;
}

router.get('/goals/:goalId', requirePermission('goals:read'), (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;

    const goal = parseGoalRow(row);
    const businessId = row.business_id as string;

    const checks = (db.prepare(
      'SELECT metric_value, progress_pct, status_change, agent_note, checked_at FROM goal_checks WHERE goal_id = ? ORDER BY checked_at DESC LIMIT 50'
    ).all(goalId) as Array<Record<string, unknown>>).map((c) => normalizeTimestamps(c, ['checked_at']));

    // Goals and tasks/signals have no direct FK — the only structural link
    // either can share today is project_id (see PHASE2.md). Best-effort,
    // not a substitute for a real goal_id column.
    const linkedTasks = row.project_id
      ? db.prepare('SELECT id, title, status, action_type, created_at FROM tasks WHERE project_id = ? AND business_id = ? ORDER BY created_at DESC LIMIT 50')
          .all(row.project_id as string, businessId) as Array<Record<string, unknown>>
      : [];
    const linkedSignals = row.project_id
      ? db.prepare("SELECT id, title, severity, status, created_at FROM signals WHERE project_id = ? AND business_id = ? ORDER BY created_at DESC LIMIT 50")
          .all(row.project_id as string, businessId) as Array<Record<string, unknown>>
      : [];

    const conflicts = db.prepare(
      "SELECT id, conflict_type, severity, entity_a_type, entity_a_id, entity_a_title, entity_b_type, entity_b_id, entity_b_title, description, recommendation, status, detected_at FROM conflicts WHERE business_id = ? AND status = 'open' AND ((entity_a_type = 'goal' AND entity_a_id = ?) OR (entity_b_type = 'goal' AND entity_b_id = ?))"
    ).all(businessId, goalId, goalId) as Array<Record<string, unknown>>;

    const deadlineAtRisk = Boolean(
      row.deadline && row.status === 'active' &&
      new Date(row.deadline as string).getTime() < Date.now() + 7 * 86400000 &&
      Number(row.progress_pct ?? 0) < 90
    );

    return res.json({
      goal,
      linked_metrics: row.metric_name ? {
        metric_name: row.metric_name, baseline: row.metric_baseline, target: row.metric_target,
        current: row.metric_current, unit: row.metric_unit, progress_pct: row.progress_pct,
      } : null,
      linked_tasks: linkedTasks.map((t) => normalizeTimestamps(t, ['created_at'])),
      linked_signals: linkedSignals.map((s) => normalizeTimestamps(s, ['created_at'])),
      progress: {
        progress_pct: row.progress_pct ?? 0,
        last_checked: toIso(row.last_checked as string | null),
        checks,
      },
      blockers: { open_conflicts: conflicts.map((c) => normalizeTimestamps(c, ['detected_at'])), deadline_at_risk: deadlineAtRisk },
      conflicts: conflicts.map((c) => normalizeTimestamps(c, ['detected_at'])),
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

const GOAL_UPDATE_SCALAR_FIELDS = ['title', 'description', 'status', 'deadline', 'metric_name', 'metric_baseline', 'metric_target', 'metric_unit', 'strategy', 'project_id'] as const;
const GOAL_UPDATE_JSON_FIELDS = ['assigned_agents', 'milestones', 'notes', 'tags'] as const;
const GOAL_VALID_STATUSES = new Set(['active', 'paused', 'achieved', 'missed', 'cancelled']);

router.patch('/goals/:goalId', requirePermission('goals:update'), async (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;
    if (!hasPermission((req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>, 'goals:update', row.business_id as string)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: goal does not belong to an authorized business.');
    }

    const body = req.body as Record<string, unknown>;
    if (body.status !== undefined && !GOAL_VALID_STATUSES.has(String(body.status))) {
      return sendError(req, res, 400, 'validation_error', `status must be one of: ${Array.from(GOAL_VALID_STATUSES).join(', ')}.`);
    }

    await withRequiredIdempotency(req, res, 'goals:update', async () => {
      const updates: string[] = [];
      const values: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const field of GOAL_UPDATE_SCALAR_FIELDS) {
        if (body[field] !== undefined) { updates.push(`${field} = ?`); values.push(body[field]); }
      }
      for (const field of GOAL_UPDATE_JSON_FIELDS) {
        if (body[field] !== undefined) { updates.push(`${field} = ?`); values.push(JSON.stringify(body[field])); }
      }
      if (!updates.length) return { status: 400, body: { error: 'No updatable fields provided.' } };

      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(goalId);
      db.prepare(`UPDATE goals SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const after = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown>;
      return { status: 200, body: { goal: parseGoalRow(after) } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/goals/:goalId/archive', requirePermission('goals:update'), async (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;
    if (!hasPermission((req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>, 'goals:update', row.business_id as string)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: goal does not belong to an authorized business.');
    }

    await withRequiredIdempotency(req, res, 'goals:archive', async () => {
      db.prepare("UPDATE goals SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(goalId);
      return { status: 200, body: { goal_id: goalId, status: 'cancelled' } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/goals/:goalId/check', requirePermission('goals:update'), async (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;
    if (!hasPermission((req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>, 'goals:update', row.business_id as string)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: goal does not belong to an authorized business.');
    }

    await withRequiredIdempotency(req, res, 'goals:check', async () => {
      const { checkGoalById } = await import('../goals/goal-engine.js') as unknown as { checkGoalById: (id: string) => Promise<unknown> };
      const result = await checkGoalById(goalId);
      const after = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown>;
      return { status: 200, body: { goal: parseGoalRow(after), check_result: result } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/goals/:goalId/conflicts', requirePermission('goals:read'), (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;

    const conflicts = db.prepare(
      "SELECT id, conflict_type, severity, entity_a_type, entity_a_id, entity_a_title, entity_b_type, entity_b_id, entity_b_title, description, recommendation, resolution_kind, status, resolution_note, detected_at, resolved_at FROM conflicts WHERE business_id = ? AND ((entity_a_type = 'goal' AND entity_a_id = ?) OR (entity_b_type = 'goal' AND entity_b_id = ?)) ORDER BY detected_at DESC"
    ).all(row.business_id as string, goalId, goalId) as Array<Record<string, unknown>>;

    return res.json({ conflicts: conflicts.map((c) => normalizeTimestamps(c, ['detected_at', 'resolved_at'])) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
