/**
 * Outcome attribution system.
 *
 * After a task completes, waits 2 and 4 weeks, then checks whether the
 * target metric improved, stayed flat, or worsened. Records the result
 * in task_outcomes and feeds it back to agent memory.
 */
import db, { generateId } from '../db/db.js';
import { createTaskEvent } from './task-events.js';
import { getActionRegistryEntry } from './action-registry.js';

type Verdict = 'improved' | 'worsened' | 'no_change' | 'inconclusive';

interface TaskOutcomeRow {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  status: string;
  proposed_by: string;
  action_type: string | null;
  target_metric: string | null;
  target_metric_baseline: number | null;
  completed_at: string | null;
}

interface MetricRow {
  metric_value: number;
}

interface TaskIdRow {
  id: string;
}

interface BusinessIdRow {
  id: string;
}

export interface OutcomeResult {
  verdict: Verdict;
  changePct: number;
  detail: string;
}

export interface OutcomeData {
  verdict: Verdict;
  change_pct: number;
  target_metric: string;
  weeks_after: number;
}

const ACTION_TYPE_METRICS: Record<string, string> = {
  'shopify_description_update':    'ga4.sessions',
  'shopify_page_create':           'gsc.total_clicks',
  'shopify_meta_update':           'gsc.avg_ctr',
  'github_pr':                     'pagespeed.mobile.performance_score',
  'meta_update':                   'gsc.avg_ctr',
  'content_draft':                 'gsc.total_clicks',
};

const LOWER_IS_BETTER = new Set<string>([
  'pagespeed.mobile.lcp_ms',
  'ga4.bounce_rate',
  'gsc.avg_position',
]);

/**
 * Called when a task is created — auto-populates target_metric + baseline.
 */
export function setTaskTargetMetric(taskId: string, businessId: string, actionType: string): void {
  const metricName = ACTION_TYPE_METRICS[actionType];
  if (!metricName) return;

  const latest = db.prepare(
    'SELECT metric_value FROM metrics WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL ORDER BY recorded_at DESC LIMIT 1'
  ).get(businessId, metricName) as MetricRow | null;

  if (latest?.metric_value != null) {
    db.prepare('UPDATE tasks SET target_metric = ?, target_metric_baseline = ? WHERE id = ?')
      .run(metricName, latest.metric_value, taskId);
  }
}

/**
 * Check outcome for a single task at N weeks after completion.
 */
export function checkTaskOutcome(taskId: string, weeksAfter: number): OutcomeResult | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskOutcomeRow | null;
  if (!task || !task.target_metric || task.target_metric_baseline == null) return null;

  const current = db.prepare(
    'SELECT metric_value FROM metrics WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL ORDER BY recorded_at DESC LIMIT 1'
  ).get(task.business_id, task.target_metric) as MetricRow | null;

  if (current?.metric_value == null) return null;

  const baseline = task.target_metric_baseline;
  const now = current.metric_value;
  const changePct = baseline !== 0 ? ((now - baseline) / Math.abs(baseline)) * 100 : 0;
  const isLowerBetter = LOWER_IS_BETTER.has(task.target_metric);
  const improved = isLowerBetter ? now < baseline : now > baseline;
  const meaningful = Math.abs(changePct) > 5;

  let verdict: Verdict = 'inconclusive';
  if (meaningful && improved) verdict = 'improved';
  else if (meaningful && !improved) verdict = 'worsened';
  else if (!meaningful) verdict = 'no_change';

  const detail = `${task.target_metric}: ${baseline.toFixed(2)} → ${now.toFixed(2)} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%)`;

  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value,
      baseline_value, change_pct, verdict, verdict_detail)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)
  `).run(generateId(), taskId, weeksAfter, now, baseline, changePct, verdict, detail);

  // Move task to 'verified' if still 'complete'
  if (task.status === 'complete') {
    db.prepare("UPDATE tasks SET status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'complete'")
      .run(taskId);
  }

  // Add timeline event
  try {
    createTaskEvent(
      taskId, 'outcome_check', 'system:outcome',
      `${weeksAfter}-week outcome: ${verdict}. ${detail}`,
      { verdict, changePct: Math.round(changePct * 10) / 10, weeksAfter }
    );
  } catch { /* non-fatal */ }

  // Auto-file outcome to KB (non-fatal)
  (async () => {
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
        getKBForBusiness: (businessId: string) => Promise<{ engine: { writeFile: (path: string, body: string, meta: Record<string, unknown>, msg: string) => Promise<void> } } | null>;
      };
      const kbResult = await getKBForBusiness(task.business_id);
      if (!kbResult?.engine) return;
      const today = new Date().toISOString().split('T')[0];
      const slug = `task-${taskId.slice(0, 8)}-${weeksAfter}w`;
      const body = `# Outcome: ${task.title}

**Verdict:** ${verdict}
**Change:** ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%
**Metric:** ${task.target_metric}
**Check:** ${weeksAfter} weeks after completion
**Baseline:** ${baseline.toFixed(2)}
**Current:** ${now.toFixed(2)}
**Agent:** ${task.proposed_by}

${detail}
`;
      await kbResult.engine.writeFile(
        `outcomes/${slug}.md`,
        body,
        {
          title: `Outcome: ${task.title}`,
          tags: ['outcome', verdict],
          created: today,
          updated: today,
          written_by: 'system',
          review_status: 'auto_approved',
          task_id: taskId,
          weeks_after: weeksAfter,
        },
        `outcome: ${String(task.title).slice(0, 50)}`
      );
    } catch (err) {
      console.warn('[outcomes] KB file failed:', (err as Error).message);
    }
  })();

  // Shared KB — file a proven tactic if the change was large
  (async () => {
    try {
      const { maybeFileProvenTactic } = await import('../kb/shared-kb.js') as unknown as {
        maybeFileProvenTactic: (task: TaskOutcomeRow, data: OutcomeData) => Promise<void>;
      };
      await maybeFileProvenTactic(task, {
        verdict, change_pct: changePct, target_metric: task.target_metric!,
        weeks_after: weeksAfter,
      });
    } catch { /* non-fatal */ }
  })();

  // Task intelligence — raises a warning signal on worsened, spawns a
  // follow-up investigation on no_change, logs a Timeline event on
  // improved. Fire-and-forget.
  (async () => {
    try {
      const { processTaskCompletion } = await import('./task-intelligence.js') as unknown as {
        processTaskCompletion: (taskId: string, outcome: { verdict: Verdict; changePct: number; detail: string; weeksAfter: number }) => Promise<void>;
      };
      await processTaskCompletion(taskId, {
        verdict, changePct, detail, weeksAfter,
      });
    } catch (err) {
      console.warn('[task-intel] processTaskCompletion failed:', (err as Error).message);
    }
  })();

  return { verdict, changePct, detail };
}

/**
 * Does this action_type's registry entry ask for a check at `weekNumber`
 * weeks after completion? Reads `action_registry.measurement_window_days`
 * (Outcome Learning Engine field — e.g. the spec's SEO example of
 * checking at 7/14/28 days). Missing action_type/registry entry falls
 * back to the pre-existing 2-week/4-week schedule for backward
 * compatibility with tasks created before the registry existed.
 */
function shouldCheckAtWeek(actionType: string | null, weekNumber: number): boolean {
  if (!actionType) return weekNumber === 2 || weekNumber === 4;
  const entry = getActionRegistryEntry(actionType);
  const days = entry?.measurement_window_days?.length ? entry.measurement_window_days : [14, 28];
  return days.some((d) => Math.max(1, Math.round(d / 7)) === weekNumber);
}

/**
 * Run all pending outcome checks. Called by scheduler weekly.
 */
export function runOutcomeChecks(): number {
  let checked = 0;

  // 1-week checks — new: the Outcome Learning Engine's per-action-type
  // measurement_window_days (default [7,14,28] days) adds an early check
  // that didn't exist before this table existed, matching the spec's own
  // SEO example (measured at 7/14/28 days). handleNoChange() in
  // task-intelligence.ts still only proposes a follow-up investigation
  // once the 4-week check lands, so this never causes a premature one.
  const oneWeek = db.prepare(`
    SELECT t.id, t.action_type FROM tasks t
    LEFT JOIN task_outcomes o ON o.task_id = t.id AND o.weeks_after = 1
    WHERE t.status IN ('complete', 'verified')
    AND t.target_metric IS NOT NULL
    AND t.completed_at < datetime('now', '-7 days')
    AND o.id IS NULL
    LIMIT 20
  `).all() as Array<{ id: string; action_type: string | null }>;

  for (const t of oneWeek) {
    if (!shouldCheckAtWeek(t.action_type, 1)) continue;
    checkTaskOutcome(t.id, 1);
    checked++;
  }

  // 2-week checks
  const twoWeek = db.prepare(`
    SELECT t.id FROM tasks t
    LEFT JOIN task_outcomes o ON o.task_id = t.id AND o.weeks_after = 2
    WHERE t.status IN ('complete', 'verified')
    AND t.target_metric IS NOT NULL
    AND t.completed_at < datetime('now', '-14 days')
    AND o.id IS NULL
    LIMIT 20
  `).all() as TaskIdRow[];

  for (const t of twoWeek) {
    checkTaskOutcome(t.id, 2);
    checked++;
  }

  // 4-week checks
  const fourWeek = db.prepare(`
    SELECT t.id FROM tasks t
    LEFT JOIN task_outcomes o ON o.task_id = t.id AND o.weeks_after = 4
    WHERE t.status IN ('complete', 'verified')
    AND t.target_metric IS NOT NULL
    AND t.completed_at < datetime('now', '-28 days')
    AND o.id IS NULL
    LIMIT 20
  `).all() as TaskIdRow[];

  for (const t of fourWeek) {
    checkTaskOutcome(t.id, 4);
    checked++;
  }

  // Brain — recalculate agent calibration after fresh outcome data
  if (checked > 0) {
    try {
      import('../brain/calibration.js').then(async (m: { recalculateCalibrationForBusiness: (id: string) => void }) => {
        const biz = db.prepare('SELECT id FROM businesses').all() as BusinessIdRow[];
        for (const b of biz) {
          try { m.recalculateCalibrationForBusiness(b.id); } catch { /* non-fatal */ }
        }
      }).catch(() => { /* non-fatal */ });
    } catch { /* non-fatal */ }
  }

  return checked;
}
