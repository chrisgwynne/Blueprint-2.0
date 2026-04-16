/**
 * Task intelligence — what happens AFTER a task outcome is recorded.
 *
 * outcomes.js already does a lot:
 *   - writes the task_outcomes row
 *   - files an outcome entry to KB at outcomes/<slug>.md
 *   - calls shared-kb.maybeFileProvenTactic() when verdict=improved AND
 *     change_pct >= 20% (files to shared/tactics/)
 *   - triggers recalculateCalibrationForBusiness()
 *
 * What's still missing and this module adds:
 *   - verdict=worsened → raise a warning signal via createSignalIfNotDuplicate
 *     so the mesh treats a bad outcome as a first-class anomaly
 *   - verdict=no_change → create a follow-up investigation task (parent_task_id
 *     set) asking why the action had no measurable effect
 *   - intelligence_events log entries so the Timeline shows outcome → signal /
 *     outcome → follow-up-task flows
 *
 * processTaskCompletion() is fire-and-forget from checkTaskOutcome().
 */

import db from '../db/db.js';
import { createSignalIfNotDuplicate } from '../signals/signal-helpers.js';
import { createTask } from './task-queue.js';
import { logIntelligenceEvent } from '../lib/intelligence-events.js';

type Verdict = 'improved' | 'worsened' | 'no_change' | 'inconclusive';

interface TaskIntelRow {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  status: string;
  proposed_by: string;
  action_type: string | null;
  target_metric: string | null;
}

interface OutcomeInput {
  verdict: Verdict;
  changePct: number;
  detail: string;
  weeksAfter: number;
}

interface SignalResult {
  created?: boolean;
  id?: string;
}

interface CreatedTask {
  id?: string;
}

interface ExistingRow {
  id: string;
}

/**
 * Main entry point — called fire-and-forget from checkTaskOutcome().
 */
export async function processTaskCompletion(taskId: string, outcome: OutcomeInput): Promise<void> {
  if (!taskId || !outcome) return;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskIntelRow | null;
  if (!task) return;

  const businessId = task.business_id;
  const { verdict, changePct, weeksAfter } = outcome;

  try {
    switch (verdict) {
      case 'worsened':
        await handleWorsened(task, outcome);
        break;
      case 'no_change':
        await handleNoChange(task, outcome);
        break;
      case 'improved':
        // outcomes.ts + shared-kb already handle the proven-tactic path.
        // We just log the mesh event so Timeline shows the improvement.
        logIntelligenceEvent({
          business_id: businessId,
          source_type: 'task',
          source_id: task.id,
          target_type: 'outcome',
          target_id: task.id,
          event_type: 'outcome_improved',
          description: `+${changePct?.toFixed?.(1) ?? '?'}% on ${task.target_metric} (${weeksAfter}w)`,
          metadata: { verdict, change_pct: changePct, weeks_after: weeksAfter },
        });
        break;
      default:
        // 'inconclusive' or unknown — nothing mesh-level to do.
        break;
    }
  } catch (err) {
    console.warn(`[task-intel] processing outcome for ${taskId} failed:`, (err as Error).message);
  }
}

// ─── Worsened → warning signal ───────────────────────────────────────────────

async function handleWorsened(task: TaskIntelRow, outcome: OutcomeInput): Promise<void> {
  const { verdict, changePct, detail, weeksAfter } = outcome;
  const businessId = task.business_id;

  // rule_id uniquely identifies this task's worsened outcome so repeat
  // outcome-checks on the same task (2w then 4w) collapse into one signal
  // via createSignalIfNotDuplicate's merge path.
  const ruleId = `task_outcome:worsened_${String(task.id).slice(0, 10)}`;

  const title = `Task outcome worsened: ${String(task.title ?? '(task)').slice(0, 120)}`;
  const description =
    `A task Blueprint completed produced a negative outcome.\n\n` +
    `**Task:** ${task.title}\n` +
    `**Agent:** ${task.proposed_by}\n` +
    `**Action type:** ${task.action_type ?? '(unknown)'}\n` +
    `**Metric:** \`${task.target_metric}\`\n` +
    `**Change:** ${changePct != null ? (changePct > 0 ? '+' : '') + changePct.toFixed(1) + '%' : 'n/a'} ` +
    `(measured ${weeksAfter}w after completion)\n` +
    `**Detail:** ${detail ?? '(none)'}\n\n` +
    `This may indicate the approach was wrong, or the measurement window ` +
    `is too short, or an unrelated factor moved the metric the wrong way.`;

  const res = createSignalIfNotDuplicate({
    business_id: businessId,
    rule_id: ruleId,
    type: 'risk',
    severity: 'warning',
    title,
    description,
    confidence: 0.85,
    data: {
      task_id: task.id,
      verdict,
      change_pct: changePct,
      weeks_after: weeksAfter,
      target_metric: task.target_metric,
      agent: task.proposed_by,
    },
    source_label: 'task-intelligence',
  }) as SignalResult | null;

  if (res?.created) {
    logIntelligenceEvent({
      business_id: businessId,
      source_type: 'task',
      source_id: task.id,
      target_type: 'signal',
      target_id: res.id,
      event_type: 'outcome_worsened_signal',
      description: `warning: ${changePct != null ? changePct.toFixed(1) + '%' : '?'} on ${task.target_metric}`,
      metadata: { verdict, change_pct: changePct, weeks_after: weeksAfter },
    });
  }
}

// ─── No change → follow-up investigation ─────────────────────────────────────

async function handleNoChange(task: TaskIntelRow, outcome: OutcomeInput): Promise<void> {
  const { changePct, weeksAfter } = outcome;
  const businessId = task.business_id;

  // Don't propose another follow-up if the parent already has one open.
  const followupTitle = `Re-investigate: ${String(task.title ?? '(task)').slice(0, 140)}`;
  const existing = db.prepare(`
    SELECT id FROM tasks
     WHERE business_id = ?
       AND (title = ? OR parent_task_id = ?)
       AND status IN ('proposed', 'approved', 'executing')
  `).get(businessId, followupTitle, task.id) as ExistingRow | null;
  if (existing) return;

  // 4-week check is more decisive than the 2-week check — only propose
  // follow-ups once the longer window has been measured. (outcomes.ts runs
  // 2w and 4w checks; we'd otherwise propose twice for the same task.)
  if (weeksAfter < 4) return;

  try {
    const created = createTask({
      business_id: businessId,
      parent_task_id: task.id,
      title: followupTitle,
      description:
        `This task's outcome was inconclusive after ${weeksAfter} weeks ` +
        `(change on \`${task.target_metric}\` was ` +
        `${changePct != null ? changePct.toFixed(1) + '%' : 'unmeasured'}, below the ` +
        `5% meaningful threshold).\n\n` +
        `**Original task:** ${task.title}\n` +
        `**Agent:** ${task.proposed_by}\n` +
        `**Action type:** ${task.action_type ?? '(unknown)'}\n\n` +
        `Possible reasons:\n` +
        `- The action had no effect (tactic doesn't work here)\n` +
        `- Effect was real but masked by other factors\n` +
        `- Measurement window was too short for this action type\n` +
        `- Target metric was the wrong choice\n\n` +
        `Investigate which of these is most likely and act accordingly. ` +
        `If you conclude the tactic is ineffective, mark this task rejected and ` +
        `update the agent's memory so it stops proposing this action type ` +
        `for similar contexts.\n\n` +
        `*Surfaced by task intelligence.*`,
      proposed_by: 'task-intelligence',
      action_type: 'investigation',
      priority: 'p3',
      trust_tier: 'green',
      confidence: 0.7,
      action_payload: {
        original_task_id: task.id,
        original_metric: task.target_metric,
        weeks_after: weeksAfter,
        change_pct: changePct,
      },
    }) as CreatedTask | null;

    if (created?.id) {
      // Tasks-table schema has parent_task_id ALTER-added, but createTask
      // doesn't accept it. Set it directly on the fresh row.
      db.prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?')
        .run(task.id, created.id);

      logIntelligenceEvent({
        business_id: businessId,
        source_type: 'task',
        source_id: task.id,
        target_type: 'task',
        target_id: created.id,
        event_type: 'outcome_followup_task',
        description: `no_change → investigation (parent ${String(task.id).slice(0, 8)})`,
        metadata: { weeks_after: weeksAfter, change_pct: changePct },
      });
    }
  } catch (err) {
    console.warn('[task-intel] follow-up task creation failed:', (err as Error).message);
  }
}
