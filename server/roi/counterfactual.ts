/**
 * Counterfactual estimator — "what does it cost if this task is NOT approved?"
 *
 * Every proposed task with a measurable target_metric gets a counterfactual
 * estimate written to the counterfactual_estimates table and appended to
 * the task's description so the approver sees the opportunity cost inline.
 *
 * The counterfactual is deliberately specific and conservative:
 *   - uses the task's target_metric baseline + current value
 *   - passes through the same value-estimator used for post-hoc attribution,
 *     so the cost-of-inaction numbers speak the same language as the ROI
 *     dashboard
 *   - quotes confidence + assumptions verbatim — no manufactured urgency
 *   - when current is already close to baseline (or the metric has no value
 *     model), the counterfactual says so instead of guessing
 *
 * The estimator never invents an urgency. "Low-impact improvement with
 * minimal ongoing cost" is a valid and expected output.
 */

import db, { generateId } from '../db/db.js';
import { estimateMonthlyValue } from './value-estimator.js';
import { getCurrentMetric, getBaseline } from './baselines.js';

interface CounterfactualData {
  target_metric: string | null;
  baseline_value: number | null;
  estimated_monthly_cost_of_inaction_usd: number | null;
  confidence: string;
  assumptions: string[];
  reasoning: string;
}

interface TaskRow {
  id: string;
  business_id: string;
  target_metric: string | null;
  target_metric_baseline: number | null;
  description: string | null;
}

interface CounterfactualRow {
  id: string;
  task_id: string;
  business_id: string;
  target_metric: string | null;
  baseline_value: number | null;
  estimated_monthly_cost_of_inaction_usd: number | null;
  confidence: string;
  assumptions: string;
  reasoning: string;
  created_at: string;
}

/**
 * Generate a counterfactual for a single task. Idempotent: if one already
 * exists for this task, reads and returns it instead of generating anew.
 *
 * Writes a counterfactual_estimates row + appends a plain-English paragraph
 * to tasks.description.
 *
 * @param {string} taskId
 * @returns {Promise<object|null>} the counterfactual row or null if nothing
 *   useful could be computed.
 */
export async function generateCounterfactual(taskId: string): Promise<CounterfactualRow | null> {
  if (!taskId) return null;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | null;
  if (!task) return null;

  // Skip if already generated — idempotence lets callers re-run safely.
  const existing = db.prepare(
    'SELECT * FROM counterfactual_estimates WHERE task_id = ?'
  ).get(taskId) as CounterfactualRow | null;
  if (existing) return existing;

  const { target_metric, target_metric_baseline, business_id } = task;

  // Tasks without a measurable target metric get a qualitative counterfactual.
  if (!target_metric) {
    return writeRow(taskId, business_id, {
      target_metric: null,
      baseline_value: null,
      estimated_monthly_cost_of_inaction_usd: null,
      confidence: 'unknown',
      assumptions: ['This task has no measurable target metric.'],
      reasoning:
        'If not approved: no direct financial impact is estimable because this ' +
        'task does not target a metric Blueprint measures automatically. The ' +
        'value judgement is qualitative and belongs with the approver.',
    });
  }

  // If we don't have a live current reading of the metric there's nothing
  // sharper to say than "the gap to baseline would remain". Honest + short.
  const currentRow = getCurrentMetric(business_id, target_metric);
  const baseline: number | null = target_metric_baseline
    ?? getBaseline(business_id, target_metric)?.baseline_value
    ?? null;

  if (!currentRow || !Number.isFinite(currentRow.value) || baseline == null) {
    return writeRow(taskId, business_id, {
      target_metric,
      baseline_value: baseline,
      estimated_monthly_cost_of_inaction_usd: null,
      confidence: 'unknown',
      assumptions: ['No recent metric reading found for the target metric.'],
      reasoning:
        `If not approved: Blueprint cannot estimate the ongoing cost of inaction ` +
        `on \`${target_metric}\` until the connector providing it syncs.`,
    });
  }

  // Pass the current-vs-baseline gap through the value estimator. If the
  // metric is already at or above baseline, the "cost of inaction" is the
  // opportunity cost of NOT improving further — which is a separate question
  // the estimator can't answer from baseline alone. Be explicit.
  const gapEstimate = estimateMonthlyValue({
    metricName: target_metric,
    baselineValue: baseline,
    currentValue: currentRow.value,
    businessId: business_id,
  });

  const directionAwayFromBaseline = gapEstimate.direction === 'worsened';
  let monthlyCost: number | null = null;
  let reasoning: string;
  let confidence = gapEstimate.confidence;

  if (directionAwayFromBaseline && Number.isFinite(gapEstimate.estimated_usd_per_month)) {
    // Metric has declined from baseline — the gap has a monthly value.
    monthlyCost = Math.abs(gapEstimate.estimated_usd_per_month as number);
    reasoning =
      `If not approved: ${target_metric} is currently ${currentRow.value} vs ` +
      `baseline ${baseline}. The gap costs approximately £${monthlyCost.toFixed(2)}/month ` +
      `in missed value each month until closed. ${gapEstimate.reasoning}`;
  } else if (gapEstimate.direction === 'flat') {
    // Metric at baseline — no cost of inaction, but perhaps opportunity.
    monthlyCost = 0;
    confidence = 'low';
    reasoning =
      `If not approved: ${target_metric} is currently at baseline (${baseline}). ` +
      `There is no measurable ongoing cost of inaction. The upside from ` +
      `this task is opportunity, not loss-avoidance — judge the business case accordingly.`;
  } else if (gapEstimate.direction === 'improved') {
    // Metric already improved past baseline — a counterfactual here is murky.
    // Honest statement: the metric is moving in the right direction already.
    monthlyCost = 0;
    confidence = 'low';
    reasoning =
      `If not approved: ${target_metric} is already above baseline (${baseline} → ${currentRow.value}). ` +
      `The task would pursue additional gains, not recover a loss. Cost of ` +
      `inaction is low — this task is discretionary upside, not urgent.`;
  } else {
    // Estimator returned null — we know the metric moved but can't price it.
    reasoning =
      `If not approved: ${target_metric} gap remains (${baseline} → ${currentRow.value}) ` +
      `but the monetary cost of that gap isn't estimable from current data. ` +
      `${gapEstimate.reasoning}`;
  }

  return writeRow(taskId, business_id, {
    target_metric,
    baseline_value: baseline,
    estimated_monthly_cost_of_inaction_usd: monthlyCost,
    confidence,
    assumptions: gapEstimate.assumptions,
    reasoning,
  });
}

// Persist the counterfactual + append a readable paragraph to the task description.
function writeRow(taskId: string, businessId: string, data: CounterfactualData): CounterfactualRow | null {
  const id = generateId();
  try {
    db.prepare(`
      INSERT INTO counterfactual_estimates (
        id, task_id, business_id, target_metric, baseline_value,
        estimated_monthly_cost_of_inaction_usd, confidence, assumptions,
        reasoning, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id, taskId, businessId,
      data.target_metric, data.baseline_value,
      data.estimated_monthly_cost_of_inaction_usd,
      data.confidence,
      JSON.stringify(data.assumptions ?? []),
      data.reasoning,
    );
  } catch (err: any) {
    console.warn('[counterfactual] insert failed:', err.message);
    return null;
  }

  // Append to task description so the approver sees it inline. Idempotency:
  // we tag the block so re-running doesn't duplicate.
  try {
    const task = db.prepare('SELECT description FROM tasks WHERE id = ?').get(taskId) as { description: string | null } | null;
    if (task && !/### Cost of inaction/i.test(task.description ?? '')) {
      const costText = data.estimated_monthly_cost_of_inaction_usd == null
        ? '(not estimable)'
        : `~£${Number(data.estimated_monthly_cost_of_inaction_usd).toFixed(2)}/month`;
      const assumptionsBlock = data.assumptions?.length
        ? '\n\n**Assumptions:**\n' + data.assumptions.map((a) => `- ${a}`).join('\n')
        : '';
      const appended =
        `\n\n---\n### Cost of inaction (Blueprint estimate)\n\n` +
        `${data.reasoning}\n\n` +
        `**Estimated ongoing cost:** ${costText}  \n` +
        `**Confidence:** ${data.confidence}${assumptionsBlock}`;
      db.prepare('UPDATE tasks SET description = COALESCE(description, \'\') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(appended, taskId);
    }
  } catch (err: any) {
    console.warn('[counterfactual] description update failed:', err.message);
  }

  return db.prepare('SELECT * FROM counterfactual_estimates WHERE id = ?').get(id) as CounterfactualRow | null;
}
