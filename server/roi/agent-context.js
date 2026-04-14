/**
 * Per-agent ROI context injected into every agent's system prompt.
 *
 * Creates a feedback loop: agents read their own performance data and
 * adapt. An agent with a low win rate sees that and becomes more selective.
 * An agent that's well-calibrated gets positive reinforcement.
 *
 * Honest properties preserved:
 *   - Insufficient data is stated, not papered over
 *   - Underperformance is surfaced, not hidden
 *   - Calibration feedback uses the pre-existing agent_calibration table
 */

import { computeAgentROI, computeAllAgentROI } from './agent-roi.js';
import { computeROIReport } from './attribution-engine.js';

const ROI_WINDOW_DAYS = 90;

/**
 * Build a short markdown block for the agent's system prompt summarising
 * its own ROI over the last 90 days. Returns empty string when nothing
 * useful can be said (the agent hasn't run here, or has 0 outcomes and
 * we don't want prompt bloat).
 */
export function buildAgentROIContext(agentId, businessId) {
  if (!agentId || !businessId || agentId === 'conductor') {
    // Conductor gets a different context block via buildConductorROIContext.
    // Other agents with no id/business have nothing to say.
    return '';
  }

  const r = computeAgentROI(agentId, businessId, { window_days: ROI_WINDOW_DAYS });
  if (!r || (r.tasks_proposed === 0 && r.tasks_with_outcomes === 0)) {
    return '';
  }

  const lines = [];
  lines.push(`## Your performance (last ${ROI_WINDOW_DAYS} days)`);
  lines.push('');
  lines.push(`- Cost: £${r.total_cost_usd.toFixed(2)}`);
  lines.push(`- Tasks: ${r.tasks_proposed} proposed, ${r.tasks_approved} approved, ${r.tasks_with_outcomes} measured`);
  if (r.improvement_rate_pct != null) {
    lines.push(`- Win rate: ${r.improvement_rate_pct}% (${r.outcomes_improved} improved, ${r.outcomes_worsened} worsened, ${r.outcomes_no_change} no change)`);
  }
  if (r.estimated_monthly_value_usd !== 0) {
    lines.push(`- Estimated value: £${r.estimated_monthly_value_usd.toFixed(2)}/month`);
  }
  if (r.roi_ratio != null) {
    lines.push(`- ROI: ${r.roi_ratio.toFixed(1)}x`);
  }
  if (r.calibration_score != null) {
    lines.push(`- Calibration: ${Math.round(r.calibration_score * 100)}% (trend: ${r.calibration_trend ?? 'n/a'})`);
  }

  // Feedback guidance. Spec-defined thresholds.
  lines.push('');
  if (r.roi_confidence === 'insufficient' || r.tasks_with_outcomes < 5) {
    lines.push(
      '_Too few measured outcomes yet to reach a verdict. Keep operating normally; ' +
      'the system will have a clearer picture after more measurement windows close._'
    );
  } else if (r.roi_ratio != null && r.roi_ratio < 2) {
    lines.push(
      '**Feedback: your recent win rate suggests you are proposing tasks that don\'t ' +
      'reliably produce results.** Be more selective. Only propose tasks with genuine ' +
      'evidence from the data. Quality over quantity.'
    );
  } else if (r.roi_ratio != null && r.roi_ratio >= 10) {
    lines.push('_Recent outcomes are strong. Continue the current approach._');
  } else if (r.status === 'review_needed') {
    lines.push(
      '**Feedback: more of your outcomes worsened metrics than improved them.** ' +
      'Pause to examine what recurring pattern is causing that before proposing more.'
    );
  }

  if (r.calibration_score != null && r.calibration_score < 0.7) {
    lines.push('');
    lines.push(
      `_Your stated confidence scores have been overconfident by ${Math.round((1 - r.calibration_score) * 100)}%. ` +
      `Lower your confidence numbers accordingly so Blueprint's aggregate calibration improves._`
    );
  }

  return lines.join('\n');
}

/**
 * Conductor-specific context: rather than the one-agent scorecard, Conductor
 * sees the whole ROI picture so its routing decisions weight agents by
 * current performance. Keeps the prompt focused; doesn't include every
 * raw number.
 */
export function buildConductorROIContext(businessId) {
  if (!businessId) return '';

  const report = computeROIReport(businessId);
  if (!report || report.confidence_level === 'insufficient') {
    return (
      '## Blueprint ROI\n\n' +
      `_Insufficient data yet (${report?.days_since_install ?? 0} days, ` +
      `${report?.outcomes_count ?? 0} outcomes). Routing decisions should not ` +
      `yet weight agents by performance — everyone still on probation._`
    );
  }

  const lines = [];
  lines.push('## Blueprint ROI — use this when routing');
  lines.push('');
  lines.push(`- Confidence: ${report.confidence_level} · ${report.outcomes_count} outcomes · ${report.days_since_install} days`);
  if (report.attributed_value_usd_per_month) {
    lines.push(`- Attributed value: £${report.attributed_value_usd_per_month.toFixed(2)}/month`);
  }
  if (report.attributed_decline_usd_per_month) {
    lines.push(`- Attributed decline: -£${report.attributed_decline_usd_per_month.toFixed(2)}/month`);
  }
  if (report.total_cost_usd) {
    lines.push(`- Cost: £${report.total_cost_usd.toFixed(2)}`);
  }
  if (report.roi_ratio != null) {
    lines.push(`- ROI ratio: ${report.roi_ratio.toFixed(1)}x`);
  }

  // Agent rankings so Conductor knows who's earning their keep.
  const agentRows = computeAllAgentROI(businessId, { window_days: 90 });
  const review = agentRows.filter((r) => r.status === 'review_needed');
  const strong = agentRows.filter((r) => r.status === 'strong');
  if (strong.length) {
    lines.push('');
    lines.push(`**Strong ROI this period:** ${strong.map((a) => a.agent_name).join(', ')}`);
  }
  if (review.length) {
    lines.push(`**Review needed:** ${review.map((a) => `${a.agent_name} (${a.outcomes_worsened}/${a.tasks_with_outcomes} worsened)`).join(', ')}`);
  }

  lines.push('');
  lines.push(
    '_When two agents could plausibly take a piece of work, prefer the one with ' +
    'the stronger recent ROI. When an agent has status=review_needed, prefer to ' +
    'raise a health task rather than route more work to them._'
  );

  return lines.join('\n');
}

/**
 * Reporter-specific context: the full ROI report object (compacted) so the
 * weekly briefing can cite specific numbers. Reporter's HEARTBEAT instructs
 * it to synthesise — never re-derive — so feeding it the already-computed
 * numbers is the right shape.
 */
export function buildReporterROIContext(businessId) {
  if (!businessId) return '';

  const report = computeROIReport(businessId);
  if (!report) return '';

  const improvements = (report.attributed_improvements ?? []).slice(0, 5).map((r) =>
    `  - ${r.task_title} (${r.proposed_by}, ${r.metric_name}, ${r.change_pct?.toFixed?.(1)}%, ` +
    `£${r.estimated_monthly_usd}/mo, ${r.confidence} confidence)`
  );
  const declines = (report.attributed_declines ?? []).slice(0, 5).map((r) =>
    `  - ${r.task_title} (${r.proposed_by}, ${r.metric_name}, ${r.change_pct?.toFixed?.(1)}%, ` +
    `-£${Math.abs(r.estimated_monthly_usd ?? 0)}/mo)`
  );

  const lines = [];
  lines.push('## ROI data for this week\'s briefing');
  lines.push('');
  lines.push(`- Days since install: ${report.days_since_install}`);
  lines.push(`- Confidence level: ${report.confidence_level}`);
  lines.push(`- Outcomes measured: ${report.outcomes_count}`);
  lines.push(`- Attributed value: £${report.attributed_value_usd_per_month.toFixed(2)}/month`);
  lines.push(`- Attributed decline: -£${report.attributed_decline_usd_per_month.toFixed(2)}/month`);
  lines.push(`- Total cost: £${report.total_cost_usd.toFixed(2)}`);
  if (report.roi_ratio != null) lines.push(`- ROI ratio: ${report.roi_ratio.toFixed(1)}x`);
  lines.push('');
  if (improvements.length > 0) {
    lines.push('### Wins this period');
    lines.push(...improvements);
    lines.push('');
  }
  if (declines.length > 0) {
    lines.push('### Declines attributed to Blueprint (be honest about these)');
    lines.push(...declines);
    lines.push('');
  }
  if (report.natural_trajectory?.available) {
    lines.push(
      `Natural trajectory: organic trend would have added ` +
      `£${report.natural_trajectory.projected_change_usd_per_month.toFixed(2)}/month. ` +
      `Observed was £${report.natural_trajectory.observed_change_usd_per_month.toFixed(2)}/month. ` +
      `Blueprint's contribution lies in the gap.`
    );
    lines.push('');
  }
  lines.push(
    'Include an ROI section in the weekly briefing using the numbers above. ' +
    'Be honest about declines. Do not manufacture enthusiasm. An honest "we ' +
    'don\'t know yet" section is fine when confidence is insufficient.'
  );

  return lines.join('\n');
}
