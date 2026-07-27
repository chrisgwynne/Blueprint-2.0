/**
 * Blueprint Agent Protocol (BAP) — Outcomes.
 *
 * Closes the outcome-read gap from AUDIT-BAP-GAPS.md: `task_outcomes` rows
 * (written by the internal 2/4-week outcome-check job, server/tasks/
 * outcomes.ts) were previously reachable only via the session-authenticated
 * dashboard route (server/routes/outcomes.ts) — an agent proposing a new
 * task had no BAP-accessible way to check whether a similar past action
 * actually worked.
 *
 * The DB's real verdict vocabulary (improved/worsened/no_change) is mapped
 * to the wider pending/measuring/successful/neutral/unsuccessful/abandoned
 * set via server/tasks/outcome-status.ts — see that module's docstring for
 * why the mapping exists rather than being a DB column.
 *
 * Read-only surface — no BAP route writes outcome data; only the internal
 * scheduled job does, matching how outcome measurement works in the
 * dashboard today.
 *
 * Endpoints:
 *   GET    /businesses/:bid/outcomes          — list (filterable, paginated)
 *   GET    /tasks/:id/outcome                 — single-task outcome detail
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { parsePagination, paginationMeta, normalizeTimestamps, sendError } from '../bap/route-helpers.js';
import { computeOutcomeStatus, type OutcomeStatus } from '../tasks/outcome-status.js';
import { actionTypeTrackRecord } from '../tasks/historical-learning.js';

// No blanket auth/rate-limit middleware here — see bap-goals.ts's
// docstring on this file's mounting inside bap.ts's already-authenticated
// router chain.
const router = Router();

interface TaskForOutcome {
  id: string; business_id: string; title: string; status: string; action_type: string | null;
  proposed_by: string; confidence: number | null; target_metric: string | null;
  target_metric_baseline: number | null; completed_at: string | null;
}
interface CheckRow { task_id: string; check_date: string; weeks_after: number; metric_value: number | null; baseline_value: number | null; change_pct: number | null; verdict: string | null; verdict_detail: string | null }

function checksByTask(taskIds: string[]): Map<string, CheckRow[]> {
  const map = new Map<string, CheckRow[]>();
  if (!taskIds.length) return map;
  const rows = db.prepare(
    `SELECT * FROM task_outcomes WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY task_id, weeks_after ASC`
  ).all(...taskIds) as CheckRow[];
  for (const row of rows) {
    if (!map.has(row.task_id)) map.set(row.task_id, []);
    map.get(row.task_id)!.push(row);
  }
  return map;
}


function buildOutcomeDetail(task: TaskForOutcome, checks: CheckRow[]): Record<string, unknown> {
  const { status, is_final } = computeOutcomeStatus({
    task_status: task.status, target_metric: task.target_metric, completed_at: task.completed_at, checks,
  });
  return {
    task_id: task.id, task_title: task.title, action_type: task.action_type, proposed_by: task.proposed_by,
    status: status as OutcomeStatus | null, is_final,
    target_metric: task.target_metric, baseline: task.target_metric_baseline,
    checks: checks.map((c) => normalizeTimestamps(c as unknown as Record<string, unknown>, ['check_date'])),
    latest: checks.length ? normalizeTimestamps(checks[checks.length - 1]! as unknown as Record<string, unknown>, ['check_date']) : null,
  };
}

router.get('/businesses/:businessId/outcomes', requirePermission('outcomes:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { status, action_type, proposed_by } = req.query;

    const conditions = ['business_id = ?', 'target_metric IS NOT NULL'];
    const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (action_type) {
      const arr = String(action_type).split(',');
      conditions.push(`action_type IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (proposed_by) {
      const arr = String(proposed_by).split(',');
      conditions.push(`proposed_by IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    const where = conditions.join(' AND ');

    // status (the mapped vocabulary) can't be filtered in SQL — it's
    // derived, not stored — so this route fetches candidates, maps, then
    // filters/paginates in memory. Bounded by target_metric IS NOT NULL,
    // which is a small subset of all tasks in practice.
    const tasks = db.prepare(
      `SELECT id, business_id, title, status, action_type, proposed_by, confidence, target_metric, target_metric_baseline, completed_at
       FROM tasks WHERE ${where} ORDER BY completed_at DESC, created_at DESC`
    ).all(...params) as TaskForOutcome[];

    const checkMap = checksByTask(tasks.map((t) => t.id));
    let outcomes = tasks.map((t) => buildOutcomeDetail(t, checkMap.get(t.id) ?? []));

    if (status) {
      const wanted = new Set(String(status).split(','));
      outcomes = outcomes.filter((o) => wanted.has(String(o.status)));
    }

    const total = outcomes.length;
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const paged = outcomes.slice(offset, offset + limit);

    return res.json({ outcomes: paged, total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/tasks/:taskId/outcome', requirePermission('outcomes:read'), async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId);
    const task = db.prepare(
      'SELECT id, business_id, title, status, action_type, proposed_by, confidence, target_metric, target_metric_baseline, completed_at FROM tasks WHERE id = ?'
    ).get(taskId) as TaskForOutcome | undefined;
    if (!task) return sendError(req, res, 404, 'not_found', `Task '${taskId}' not found.`);

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'outcomes:read', task.business_id)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: task does not belong to an authorized business.');
    }

    const checks = (checksByTask([taskId]).get(taskId) ?? []);
    const detail = buildOutcomeDetail(task, checks);

    const { getLatestCalibration, adjustedConfidence } = await import('../brain/calibration.js') as unknown as {
      getLatestCalibration: (agentId: string, businessId?: string | null) => Record<string, unknown> | null;
      adjustedConfidence: (stated: number | null, agentId: string, businessId?: string | null) => number | null;
    };
    const calibration = getLatestCalibration(task.proposed_by, task.business_id);

    return res.json({
      ...detail,
      linked_task: taskId,
      confidence: {
        stated: task.confidence,
        calibrated: adjustedConfidence(task.confidence, task.proposed_by, task.business_id),
        agent_calibration: calibration ? { score: calibration.calibration_score, trend: calibration.trend } : null,
      },
      recommendation: actionTypeTrackRecord(task.business_id, task.action_type),
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
