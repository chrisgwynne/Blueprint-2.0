/**
 * Brain — Restraint system.
 *
 * Before any agent creates a task, checkRestraint() asks:
 *   "Did we already change something in this area? If so, has its
 *    measurement window closed yet?"
 *
 * If the area is still in flight, the task is blocked and deferred
 * until the window closes. Prevents reactive churn that makes
 * attribution impossible.
 */
import db from '../db/db.js';

interface ProposedTask {
  action_type?: string | null;
  action_payload?: Record<string, unknown> | null;
  title?: string | null;
}

interface RestraintResult {
  allowed: boolean;
  reason: string | null;
  blocked_by: Record<string, unknown> | null;
  measurement_window_ends: string | null;
  recommendation: string | null;
  confounding_warning: string | null;
}

export async function checkRestraint(proposedTask: ProposedTask, businessId: string): Promise<RestraintResult> {
  const result: RestraintResult = {
    allowed: true,
    reason: null,
    blocked_by: null,
    measurement_window_ends: null,
    recommendation: null,
    confounding_warning: null,
  };

  if (!proposedTask?.action_type) return result;

  const proposedUrl = (proposedTask.action_payload?.url as string | null) ?? null;
  const proposedEntity = (proposedTask.action_payload?.entity as string | null) ?? null;

  // Candidate: same action type, OR same target URL, OR overlapping metric types
  const candidates = db.prepare(`
    SELECT am.*, aw.expected_days, aw.measurement_notes, aw.volatility, aw.display_name
    FROM action_memory am
    LEFT JOIN action_windows aw ON aw.action_type = am.action_type
    WHERE am.business_id = ?
      AND am.outcome_measured = 0
      AND am.do_not_touch_until > CURRENT_TIMESTAMP
      AND (
        am.action_type = ?
        OR (? IS NOT NULL AND am.target_url = ?)
        OR (? IS NOT NULL AND am.target_entity = ?)
        OR EXISTS (
          SELECT 1 FROM json_each(am.metrics_expected) me
          WHERE me.value IN (
            SELECT value FROM json_each(
              COALESCE((SELECT metric_types FROM action_windows WHERE action_type = ?), '[]')
            )
          )
        )
      )
    ORDER BY am.created_at DESC
    LIMIT 5
  `).all(
    businessId,
    proposedTask.action_type,
    proposedUrl, proposedUrl,
    proposedEntity, proposedEntity,
    proposedTask.action_type
  ) as Record<string, unknown>[];

  if (candidates.length === 0) {
    // Still report confounding from unrelated in-flight actions
    result.confounding_warning = checkConfounding(businessId, null);
    return result;
  }

  // Pick the most restrictive: longest do_not_touch_until
  const blocking = candidates.reduce((a, b) =>
    new Date(b.do_not_touch_until as string) > new Date(a.do_not_touch_until as string) ? b : a
  );

  const daysAgo = Math.ceil((Date.now() - new Date(blocking.measurement_window_start as string).getTime()) / 86400000);
  const daysLeft = Math.ceil((new Date(blocking.do_not_touch_until as string).getTime() - Date.now()) / 86400000);

  result.allowed = false;
  result.blocked_by = {
    id: blocking.id,
    task_id: blocking.task_id,
    title: blocking.title,
    action_type: blocking.action_type,
    days_ago: daysAgo,
    days_left: daysLeft,
    measurement_window_end: blocking.measurement_window_end,
  };
  result.measurement_window_ends = blocking.measurement_window_end as string;
  result.reason = buildReason(blocking, daysAgo, daysLeft);
  result.recommendation = buildRecommendation(blocking);

  result.confounding_warning = checkConfounding(businessId, blocking.id as string);
  return result;
}

function buildReason(blocking: Record<string, unknown>, daysAgo: number, daysLeft: number): string {
  const notes = blocking.measurement_notes ? ` ${blocking.measurement_notes}` : '';
  return `"${blocking.title}" was completed ${daysAgo} days ago and is still in its measurement window. ${daysLeft} more day${daysLeft === 1 ? '' : 's'} needed before re-acting on the same area.${notes}`;
}

function buildRecommendation(blocking: Record<string, unknown>): string {
  const d = new Date(blocking.measurement_window_end as string);
  const formatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  return `Wait until ${formatted} to measure the outcome of "${blocking.title}" before making further changes in this area.`;
}

function checkConfounding(businessId: string, excludeId: string | null): string | null {
  const clauses = [
    "business_id = ?",
    "outcome_measured = 0",
    "measurement_window_start > datetime('now', '-30 days')",
  ];
  const params: any[] = [businessId];
  if (excludeId) { clauses.push('id != ?'); params.push(excludeId); }
  const rows = (db.prepare(
    `SELECT COUNT(*) as c FROM action_memory WHERE ${clauses.join(' AND ')}`
  ) as { get: (...args: any[]) => { c: number } }).get(...params);
  if (rows.c >= 3) {
    return `${rows.c} other changes are currently in their measurement windows. Attribution will be difficult. Consider completing fewer changes at once.`;
  }
  return null;
}

/**
 * Scheduler hook — every morning, resurface deferred tasks whose
 * wake-up time has arrived.
 */
export async function processDeferredTasks(): Promise<number> {
  const ready = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'deferred'
      AND deferred_until IS NOT NULL
      AND deferred_until <= CURRENT_TIMESTAMP
  `).all() as Record<string, unknown>[];

  for (const task of ready) {
    try {
      db.prepare(`
        UPDATE tasks
        SET status = 'proposed', deferred_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(task.id as string);

      const { createTaskEvent } = await import('../tasks/task-events.js') as unknown as {
        createTaskEvent: (taskId: string, event: string, actor: string, message: string, data: Record<string, unknown>) => void;
      };
      createTaskEvent(
        task.id as string, 'deferred_ready', 'system:brain',
        `Task ready — measurement window has closed.${task.deferred_reason ? ' Previously deferred: ' + task.deferred_reason : ''}`,
        {}
      );

      try {
        const { dispatchNotification } = await import('../notifications/dispatcher.js') as unknown as {
          dispatchNotification: (params: Record<string, unknown>) => Promise<void>;
        };
        await dispatchNotification({
          businessId: task.business_id,
          severity: 'info',
          title: `📋 Deferred task ready: ${task.title}`,
          body: `The measurement window has closed. This task is now ready for approval.`,
          channels: ['dashboard', 'telegram'],
          entityType: 'task',
          entityId: task.id,
        });
      } catch {}
    } catch (err) {
      console.warn('[brain] processDeferred error:', (err as Error).message);
    }
  }

  if (ready.length > 0) {
    console.log(`[brain] Resurfaced ${ready.length} deferred task(s).`);
  }
  return ready.length;
}
