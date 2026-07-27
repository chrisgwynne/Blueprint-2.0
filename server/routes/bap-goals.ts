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
 *                                                signals/outcomes, blockers,
 *                                                conflicts, dependencies)
 *   PATCH  /goals/:id                         — update (progress/status/etc)
 *   POST   /goals/:id/archive                 — soft-cancel (status='cancelled')
 *   POST   /goals/:id/check                   — recompute progress now
 *   GET    /goals/:id/conflicts               — conflicts referencing this goal
 *   GET    /goals/:id/timeline                — Phase 3: chronological history
 *   GET    /goals/:id/assessment              — Phase 3: latest strategic assessment
 *   GET    /goals/:id/assessments             — Phase 3: assessment history
 *   GET    /goals/:id/strategies              — Phase 3: comparable candidate strategies
 *   POST   /goals/:id/plan                    — Phase 3: (re)run strategic planning now
 *
 * Phase 3 (see PHASE3.md, GOAL_ENGINE.md) replaced the project_id proxy
 * this file used for linked_tasks/linked_signals with real foreign keys
 * (tasks.goal_id, signals.goal_id, task_outcomes.goal_id) — the proxy is
 * kept as a fallback merge for goals/tasks/signals created before the FK
 * existed, not as the primary mechanism any more.
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

/**
 * Milestones live in goal_milestones (Phase 3) going forward. Goals
 * created before that table existed only have the legacy `goals.milestones`
 * JSON column — merged in here (by title) as a read-only fallback rather
 * than requiring a data migration of free-form historical JSON.
 */
function loadMilestones(goalId: string, legacyJson: unknown): Record<string, unknown>[] {
  const real = (db.prepare(
    'SELECT id, title, target_pct, notes, status, achieved_at, source, created_at FROM goal_milestones WHERE goal_id = ? ORDER BY created_at ASC'
  ).all(goalId) as Array<Record<string, unknown>>).map((m) => normalizeTimestamps(m, ['achieved_at', 'created_at']));
  const realTitles = new Set(real.map((m) => m.title));
  const legacy = safeJSON<Record<string, unknown>[]>(legacyJson, []).filter((m) => m?.title && !realTitles.has(m.title));
  return [...real, ...legacy.map((m) => ({ ...m, id: null, source: 'legacy_json', status: m.status ?? 'pending' }))];
}

function loadDependencies(goalId: string): Record<string, unknown>[] {
  return db.prepare(`
    SELECT gd.depends_on_goal_id AS goal_id, gd.note, g.title, g.status, g.progress_pct
    FROM goal_dependencies gd JOIN goals g ON g.id = gd.depends_on_goal_id
    WHERE gd.goal_id = ?
  `).all(goalId) as Array<Record<string, unknown>>;
}

function parseGoalRow(row: Record<string, unknown>): Record<string, unknown> {
  const { milestones: _legacyMilestones, ...rest } = row;
  return normalizeTimestamps({
    ...rest,
    assigned_agents: safeJSON(row.assigned_agents, []),
    milestones: loadMilestones(row.id as string, row.milestones),
    dependencies: loadDependencies(row.id as string),
    notes: safeJSON(row.notes, []),
    tags: safeJSON(row.tags, []),
  }, GOAL_TIMESTAMP_KEYS);
}

function likeTerm(raw: string): string {
  return `%${raw.replace(/[%_]/g, (c) => `\\${c}`)}%`;
}

/** Replace a goal's full dependency set. Silently drops IDs that aren't real goals in this business rather than erroring — same "best effort, not fatal" philosophy as elsewhere in this file. */
function setDependencies(goalId: string, businessId: string, dependsOn: unknown): void {
  if (!Array.isArray(dependsOn)) return;
  const validIds = (dependsOn as unknown[])
    .filter((id): id is string => typeof id === 'string' && id !== goalId)
    .filter((id) => db.prepare('SELECT 1 FROM goals WHERE id = ? AND business_id = ?').get(id, businessId));
  db.prepare('DELETE FROM goal_dependencies WHERE goal_id = ?').run(goalId);
  for (const dep of validIds) {
    db.prepare(`
      INSERT INTO goal_dependencies (id, goal_id, depends_on_goal_id, business_id, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(goal_id, depends_on_goal_id) DO NOTHING
    `).run(generateId(), goalId, dep, businessId);
  }
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
      owner, confidence, priority, depends_on,
    } = req.body as Record<string, unknown>;
    if (!title || typeof title !== 'string') return sendError(req, res, 400, 'validation_error', 'title is required.');
    if (priority !== undefined && !['p1', 'p2', 'p3'].includes(String(priority))) {
      return sendError(req, res, 400, 'validation_error', 'priority must be one of: p1, p2, p3.');
    }
    if (confidence !== undefined && confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
      return sendError(req, res, 400, 'validation_error', 'confidence must be a number between 0 and 1.');
    }

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
          strategy, milestones, tags, project_id, owner, confidence, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        id, businessId, title, (description as string) ?? null, `bap:${bapAgent.id as string}`,
        JSON.stringify(Array.isArray(assigned_agents) ? assigned_agents : []),
        (deadline as string) ?? null, (metric_name as string) ?? null, baseline,
        typeof metric_target === 'number' ? metric_target : null, baseline,
        (metric_unit as string) ?? null, (strategy as string) ?? null,
        JSON.stringify(Array.isArray(milestones) ? milestones : []),
        JSON.stringify(Array.isArray(tags) ? tags : []),
        (project_id as string) ?? null,
        (owner as string) ?? null,
        typeof confidence === 'number' ? confidence : null,
        (priority as string) ?? 'p2',
      );

      if (depends_on) setDependencies(id, businessId, depends_on);

      // Fire-and-forget, matching routes/goals.ts's create route — never
      // blocks the response on an LLM call. This is also where the Phase 3
      // Strategic Planning Engine (goal-reasoner.ts) now persists a
      // goal_assessments row and one goal_strategies row per candidate path.
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

    // Real FK (Phase 3, see GOAL_ENGINE.md) — UNION with the legacy
    // project_id proxy so goals/tasks/signals created before the FK
    // existed don't lose their linkage.
    const projectId = (row.project_id as string | null) ?? null;
    const linkedTasks = db.prepare(`
      SELECT id, title, status, action_type, created_at FROM tasks
      WHERE business_id = ? AND (goal_id = ? OR (? IS NOT NULL AND project_id = ?))
      ORDER BY created_at DESC LIMIT 50
    `).all(businessId, goalId, projectId, projectId) as Array<Record<string, unknown>>;
    const linkedSignals = db.prepare(`
      SELECT id, title, severity, status, created_at FROM signals
      WHERE business_id = ? AND (goal_id = ? OR (? IS NOT NULL AND project_id = ?))
      ORDER BY created_at DESC LIMIT 50
    `).all(businessId, goalId, projectId, projectId) as Array<Record<string, unknown>>;
    const linkedOutcomes = db.prepare(`
      SELECT o.id, o.task_id, o.check_date, o.weeks_after, o.change_pct, o.verdict, t.title AS task_title
      FROM task_outcomes o JOIN tasks t ON t.id = o.task_id
      WHERE o.goal_id = ? ORDER BY o.check_date DESC LIMIT 50
    `).all(goalId) as Array<Record<string, unknown>>;

    const latestAssessment = db.prepare(
      'SELECT * FROM goal_assessments WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(goalId) as Record<string, unknown> | undefined;
    const strategyCount = (db.prepare("SELECT COUNT(*) AS n FROM goal_strategies WHERE goal_id = ?").get(goalId) as { n: number }).n;

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
      linked_outcomes: linkedOutcomes.map((o) => normalizeTimestamps(o, ['check_date'])),
      progress: {
        progress_pct: row.progress_pct ?? 0,
        last_checked: toIso(row.last_checked as string | null),
        checks,
      },
      blockers: { open_conflicts: conflicts.map((c) => normalizeTimestamps(c, ['detected_at'])), deadline_at_risk: deadlineAtRisk },
      conflicts: conflicts.map((c) => normalizeTimestamps(c, ['detected_at'])),
      strategic_planning: {
        latest_assessment: latestAssessment ? normalizeTimestamps({
          ...latestAssessment,
          assumptions: safeJSON(latestAssessment.assumptions, []),
          risks: safeJSON(latestAssessment.risks, []),
          dependencies: safeJSON(latestAssessment.dependencies, []),
          gap_analysis: safeJSON(latestAssessment.gap_analysis, null),
          measurement_plan: safeJSON(latestAssessment.measurement_plan, null),
          success_criteria: safeJSON(latestAssessment.success_criteria, []),
        }, ['created_at']) : null,
        strategy_count: strategyCount,
      },
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

const GOAL_UPDATE_SCALAR_FIELDS = ['title', 'description', 'status', 'deadline', 'metric_name', 'metric_baseline', 'metric_target', 'metric_unit', 'strategy', 'project_id', 'owner', 'confidence', 'priority'] as const;
const GOAL_UPDATE_JSON_FIELDS = ['assigned_agents', 'milestones', 'notes', 'tags'] as const;
const GOAL_VALID_STATUSES = new Set(['active', 'paused', 'achieved', 'missed', 'cancelled']);
const GOAL_VALID_PRIORITIES = new Set(['p1', 'p2', 'p3']);

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
    if (body.priority !== undefined && !GOAL_VALID_PRIORITIES.has(String(body.priority))) {
      return sendError(req, res, 400, 'validation_error', 'priority must be one of: p1, p2, p3.');
    }
    if (body.confidence !== undefined && body.confidence !== null && (typeof body.confidence !== 'number' || body.confidence < 0 || body.confidence > 1)) {
      return sendError(req, res, 400, 'validation_error', 'confidence must be a number between 0 and 1.');
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
      if (body.depends_on !== undefined) setDependencies(goalId, row.business_id as string, body.depends_on);
      if (!updates.length && body.depends_on === undefined) return { status: 400, body: { error: 'No updatable fields provided.' } };
      if (!updates.length) {
        const after = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown>;
        return { status: 200, body: { goal: parseGoalRow(after) } };
      }

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

// ─── Phase 3: Strategic Planning Engine + Multi-Strategy Planning ──────────

function parseAssessmentRow(row: Record<string, unknown>): Record<string, unknown> {
  return normalizeTimestamps({
    ...row,
    assumptions: safeJSON(row.assumptions, []),
    risks: safeJSON(row.risks, []),
    dependencies: safeJSON(row.dependencies, []),
    gap_analysis: safeJSON(row.gap_analysis, null),
    measurement_plan: safeJSON(row.measurement_plan, null),
    success_criteria: safeJSON(row.success_criteria, []),
  }, ['created_at']);
}

function parseStrategyRow(row: Record<string, unknown>): Record<string, unknown> {
  return normalizeTimestamps({
    ...row,
    evidence: safeJSON(row.evidence, []),
    depends_on: safeJSON(row.depends_on, []),
    is_recommended: Boolean(row.is_recommended),
  }, ['created_at']);
}

router.get('/goals/:goalId/assessment', requirePermission('goals:read'), (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;
    const latest = db.prepare('SELECT * FROM goal_assessments WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1').get(goalId) as Record<string, unknown> | undefined;
    if (!latest) return sendError(req, res, 404, 'not_found', `No strategic assessment exists yet for goal '${goalId}' — trigger one with POST /goals/${goalId}/plan.`);
    return res.json({ assessment: parseAssessmentRow(latest) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/goals/:goalId/assessments', requirePermission('goals:read'), (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM goal_assessments WHERE goal_id = ?').get(goalId) as { n: number }).n;
    const rows = db.prepare(
      'SELECT * FROM goal_assessments WHERE goal_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(goalId, limit, offset) as Array<Record<string, unknown>>;
    return res.json({ assessments: rows.map(parseAssessmentRow), total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/goals/:goalId/strategies', requirePermission('goals:read'), (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;
    const { status } = req.query;
    const conditions = ['goal_id = ?'];
    const params: any[] = [goalId]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (status) { conditions.push('status = ?'); params.push(String(status)); }
    const rows = db.prepare(
      `SELECT * FROM goal_strategies WHERE ${conditions.join(' AND ')} ORDER BY is_recommended DESC, confidence DESC NULLS LAST, created_at DESC`
    ).all(...params) as Array<Record<string, unknown>>;
    return res.json({ strategies: rows.map(parseStrategyRow), total: rows.length });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/goals/:goalId/plan', requirePermission('goals:update'), async (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;
    if (!hasPermission((req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>, 'goals:update', row.business_id as string)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: goal does not belong to an authorized business.');
    }

    await withRequiredIdempotency(req, res, 'goals:plan', async () => {
      // Fire-and-forget, same shape as agent-run / connector-sync triggers
      // elsewhere in BAP — a fresh LLM-backed planning pass can take many
      // seconds, so this returns immediately rather than holding the
      // connection open. Poll GET /goals/:id/assessment for the result.
      import('../brain/goal-reasoner.js')
        .then((m) => (m as unknown as { runGoalReasoning: (id: string, bid: string) => Promise<unknown> }).runGoalReasoning(goalId, row.business_id as string))
        .catch((err) => console.warn(`[bap-goals] plan trigger failed for ${goalId}:`, (err as Error).message));
      return { status: 202, body: { goal_id: goalId, status: 'planning', message: 'Strategic planning triggered. Poll GET /goals/:id/assessment and GET /goals/:id/strategies for the result.' } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

// ─── Phase 3: goal timeline — every dated event this goal has, merged ──────

router.get('/goals/:goalId/timeline', requirePermission('goals:read'), (req: Request, res: Response) => {
  try {
    const goalId = String(req.params.goalId);
    const row = loadGoalOr404(req, res, goalId);
    if (!row) return;
    const businessId = row.business_id as string;

    const events: Array<{ at: string | null; type: string; summary: string; data: Record<string, unknown> }> = [];

    events.push({ at: toIso(row.created_at as string), type: 'goal_created', summary: `Goal created: ${row.title as string}`, data: { created_by: row.created_by } });

    for (const c of db.prepare('SELECT * FROM goal_checks WHERE goal_id = ? ORDER BY checked_at ASC').all(goalId) as Array<Record<string, unknown>>) {
      events.push({ at: toIso(c.checked_at as string), type: 'progress_check', summary: `Progress check: ${(c.progress_pct as number | null)?.toFixed?.(0) ?? c.progress_pct}% (${c.status_change ?? 'no change'})`, data: c });
    }
    for (const a of db.prepare('SELECT id, feasibility_verdict, feasibility_confidence, created_at FROM goal_assessments WHERE goal_id = ? ORDER BY created_at ASC').all(goalId) as Array<Record<string, unknown>>) {
      events.push({ at: toIso(a.created_at as string), type: 'strategic_assessment', summary: `Strategic assessment: ${a.feasibility_verdict ?? 'unknown'} (${Math.round(((a.feasibility_confidence as number | null) ?? 0) * 100)}% confidence)`, data: a });
    }
    for (const s of db.prepare('SELECT id, name, is_recommended, created_at FROM goal_strategies WHERE goal_id = ? ORDER BY created_at ASC').all(goalId) as Array<Record<string, unknown>>) {
      events.push({ at: toIso(s.created_at as string), type: 'strategy_proposed', summary: `Strategy proposed: ${s.name}${s.is_recommended ? ' (recommended)' : ''}`, data: s });
    }
    for (const c of db.prepare(
      "SELECT id, conflict_type, description, detected_at FROM conflicts WHERE business_id = ? AND ((entity_a_type = 'goal' AND entity_a_id = ?) OR (entity_b_type = 'goal' AND entity_b_id = ?)) ORDER BY detected_at ASC"
    ).all(businessId, goalId, goalId) as Array<Record<string, unknown>>) {
      events.push({ at: toIso(c.detected_at as string), type: 'conflict_detected', summary: `Conflict detected: ${c.description}`, data: c });
    }
    for (const d of db.prepare(
      'SELECT id, decision_type, title, decision, confidence, created_at FROM decisions WHERE related_goal_id = ? ORDER BY created_at ASC'
    ).all(goalId) as Array<Record<string, unknown>>) {
      events.push({ at: toIso(d.created_at as string), type: 'decision', summary: `Decision: ${d.title}`, data: d });
    }
    if (row.achieved_at) {
      events.push({ at: toIso(row.achieved_at as string), type: 'goal_achieved', summary: `Goal achieved: ${row.title as string}`, data: {} });
    }

    events.sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());
    return res.json({ goal_id: goalId, events });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
