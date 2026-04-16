/**
 * ROI routes — REST surface for the /roi dashboard.
 *
 *   GET  /api/roi/:businessId           — headline report + narrative
 *   GET  /api/roi/:businessId/agents    — per-agent ROI scorecard
 *   GET  /api/roi/:businessId/trajectory — chart-ready metric timeline
 *   GET  /api/roi/:businessId/assessment — LLM-generated honest assessment
 *                                          (falls back to template if no LLM
 *                                          is configured, always honest)
 *   GET  /api/roi/:businessId/baselines  — raw baselines list
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { computeROIReport } from '../roi/attribution-engine.js';
import { computeAllAgentROI } from '../roi/agent-roi.js';
import { getBaselines } from '../roi/baselines.js';

const router = Router();
router.use(isAuthenticated);

// ─── GET /api/roi/:businessId ─────────────────────────────────────────────────
router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const report = computeROIReport(businessId);
    if (!report) return res.status(404).json({ error: 'Business not found' });
    res.json(report);
  } catch (err) {
    console.error('[roi] report error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/roi/:businessId/agents ──────────────────────────────────────────
router.get('/:businessId/agents', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const windowDays = Math.max(7, Math.min(365, parseInt(String(req.query.window_days ?? ''), 10) || 90));
    const rows = computeAllAgentROI(businessId, { window_days: windowDays });
    res.json({ window_days: windowDays, agents: rows });
  } catch (err) {
    console.error('[roi/agents] error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/roi/:businessId/baselines ──────────────────────────────────────
router.get('/:businessId/baselines', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    res.json({ baselines: getBaselines(businessId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/roi/:businessId/trajectory ─────────────────────────────────────
// Chart data: for each baselined metric, all metrics-table points since
// the baseline. Client renders one line per metric with a vertical rule at
// baseline_date.
router.get('/:businessId/trajectory', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const metricsFilter = req.query.metrics
      ? String(req.query.metrics).split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    const baselines = getBaselines(businessId);
    const out: any[] = [];
    for (const b of baselines) {
      if (metricsFilter && !metricsFilter.includes(b.metric_name)) continue;
      const points = db.prepare(`
        SELECT metric_value as value, recorded_at as at
          FROM metrics
         WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
           AND recorded_at >= ?
         ORDER BY recorded_at ASC
      `).all(businessId, b.metric_name, b.baseline_date);
      out.push({
        metric_name: b.metric_name,
        baseline_value: b.baseline_value,
        baseline_date: b.baseline_date,
        points,
      });
    }
    res.json({ series: out });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/roi/:businessId/assessment ──────────────────────────────────────
// Generates a plain-English honest assessment of Blueprint's performance.
// Uses the configured LLM via resolveProfileLLM({}). If no LLM is configured,
// falls back to a template that still must include at least one thing that's
// not working or uncertain.
router.get('/:businessId/assessment', async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const report = computeROIReport(businessId);
    if (!report) return res.status(404).json({ error: 'Business not found' });
    const agentRows = computeAllAgentROI(businessId, { window_days: 90 });

    // If there's no LLM configured we still return a useful assessment.
    // Template version: guarantees uncertainty mention via the narrative
    // builder in attribution-engine, plus appends agent-level commentary.
    const fallbackAssessment = buildTemplateAssessment(report, agentRows);

    let llmAssessment: string | null = null;
    try {
      const { resolveProfileLLM, runLLM } = await import('../lib/llm-providers.js') as unknown as {
        resolveProfileLLM: (opts: Record<string, unknown>) => { providerId: string; model: string };
        runLLM: (providerId: string, model: string, opts: Record<string, unknown>) => Promise<{ content?: string } | null>;
      };
      // Use the default tier — this is a summary-writing task, not routing.
      const { providerId, model } = resolveProfileLLM({});

      const prompt = buildAssessmentPrompt(report, agentRows);
      const result = await runLLM(providerId, model, {
        system:
          'You are Blueprint summarising its own performance for the business ' +
          'owner. Be specific, use real numbers from the data, and be honest ' +
          'about what is not working or uncertain. An assessment that is purely ' +
          'positive is unacceptable — you MUST include at least one item that is ' +
          'not working, not known yet, or a risk Blueprint might be getting wrong. ' +
          'Plain English paragraphs. No markdown headers, no bullet lists. 3-5 short paragraphs.',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1200,
      });
      llmAssessment = result?.content?.trim() || null;
    } catch (err) {
      // Any LLM failure → the template is still served. Honesty requirement
      // is preserved because the template always includes uncertainty.
      console.warn('[roi/assessment] LLM unavailable, serving template:', (err as Error).message);
    }

    // Final honesty gate — even if the LLM returned text, verify it includes
    // at least one uncertainty signal. If not, prepend the template's
    // honesty line. This is belt-and-braces for when an LLM over-optimises
    // a prompt into pure positivity.
    const assessment = llmAssessment && containsUncertainty(llmAssessment)
      ? llmAssessment
      : fallbackAssessment;

    res.json({
      assessment,
      source: llmAssessment && containsUncertainty(llmAssessment) ? 'llm' : 'template',
      confidence_level: report.confidence_level,
      report_summary: {
        attributed_value_usd_per_month: report.attributed_value_usd_per_month,
        total_cost_usd: report.total_cost_usd,
        roi_ratio: report.roi_ratio,
        outcomes_count: report.outcomes_count,
        declines_count: report.attributed_declines.length,
      },
    });
  } catch (err) {
    console.error('[roi/assessment] error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAssessmentPrompt(report: any, agentRows: any[]): string {
  const declines = report.attributed_declines ?? [];
  const improvements = report.attributed_improvements ?? [];
  const unattributed = report.unattributed_improvements ?? [];
  const agentsByStatus = {
    strong: agentRows.filter((a: any) => a.status === 'strong'),
    marginal: agentRows.filter((a: any) => a.status === 'marginal'),
    review: agentRows.filter((a: any) => a.status === 'review_needed'),
    too_soon: agentRows.filter((a: any) => a.status === 'too_soon'),
  };

  return `Summarise Blueprint's performance on ${report.business_name} over the ${report.days_since_install} days since installation.

# Data to work from

Confidence level: ${report.confidence_level}
Outcomes measured: ${report.outcomes_count}
Total cost (LLM): $${report.total_cost_usd}
Attributed monthly improvement: £${report.attributed_value_usd_per_month}
Attributed monthly decline: £${report.attributed_decline_usd_per_month}
ROI ratio: ${report.roi_ratio ?? 'not yet computed'}

Improved outcomes attributed to Blueprint (${improvements.length}):
${improvements.slice(0, 5).map((r: any) =>
  `- ${r.task_title} (${r.proposed_by}, ${r.metric_name}, ${r.change_pct?.toFixed?.(1)}%, ` +
  `£${r.estimated_monthly_usd}/mo, confidence: ${r.confidence})`
).join('\n') || '- none yet'}

Declined outcomes attributed to Blueprint (${declines.length}):
${declines.slice(0, 5).map((r: any) =>
  `- ${r.task_title} (${r.proposed_by}, ${r.metric_name}, ${r.change_pct?.toFixed?.(1)}%, ` +
  `-£${Math.abs(r.estimated_monthly_usd ?? 0)}/mo)`
).join('\n') || '- none'}

Unattributed improvements (metric moved up, no Blueprint task linked, ${unattributed.length}):
${unattributed.slice(0, 3).map((r: any) => `- ${r.metric_name} ${r.change_pct?.toFixed?.(1)}% — no Blueprint cause identified`).join('\n') || '- none'}

Natural trajectory (pre-Blueprint growth projection):
${report.natural_trajectory?.available
  ? `Projected £${report.natural_trajectory.projected_change_usd_per_month}/month from organic trend; observed £${report.natural_trajectory.observed_change_usd_per_month}/month; gap ≈ Blueprint's potential contribution.`
  : report.natural_trajectory?.reason ?? 'not yet available'}

Agents:
- Strong ROI: ${agentsByStatus.strong.map((a: any) => `${a.agent_name} (${a.roi_ratio?.toFixed?.(1)}x)`).join(', ') || 'none'}
- Marginal ROI: ${agentsByStatus.marginal.map((a: any) => `${a.agent_name}`).join(', ') || 'none'}
- Review needed: ${agentsByStatus.review.map((a: any) => `${a.agent_name} (${a.outcomes_worsened} worsened of ${a.tasks_with_outcomes} measured)`).join(', ') || 'none'}
- Too soon to tell: ${agentsByStatus.too_soon.map((a: any) => a.agent_name).join(', ') || 'none'}

# Rules for your response

1. 3-5 short paragraphs, plain English, no markdown headers or bullet lists.
2. Start by stating the period and headline numbers.
3. State what is clearly working with specific evidence (agent + metric + £).
4. State what is not working with specific evidence. If there are no declines yet, state what is NOT YET KNOWN instead (e.g. "measurement windows still open for X tasks").
5. State one specific risk Blueprint might be getting wrong. Examples: over-attributing seasonal growth, relying on unvalidated proxies, ignoring upstream factors. Do not invent this — tie it to real data when you can.
6. End with a concrete recommendation for the next 4 weeks.

This assessment will be shown directly to the business owner. Be useful, not reassuring.`;
}

function buildTemplateAssessment(report: any, agentRows: any[]): string {
  const parts: string[] = [];
  parts.push(report.narrative);
  parts.push('');

  const strong = agentRows.filter((a: any) => a.status === 'strong');
  const review = agentRows.filter((a: any) => a.status === 'review_needed');
  const tooSoon = agentRows.filter((a: any) => a.status === 'too_soon');

  if (strong.length > 0) {
    parts.push(
      `Working well: ${strong.map((a: any) => `${a.agent_name} (${a.roi_ratio?.toFixed?.(1)}x ROI)`).join(', ')}.`
    );
  }
  if (review.length > 0) {
    parts.push(
      `Not working: ${review.map((a: any) => `${a.agent_name} (${a.outcomes_worsened}/${a.tasks_with_outcomes} outcomes worsened)`).join(', ')}. ` +
      `Consider pausing or tightening these agents' task-proposal thresholds.`
    );
  } else if (tooSoon.length > 0) {
    parts.push(
      `Not known yet: ${tooSoon.map((a: any) => a.agent_name).join(', ')} — fewer than 5 measured outcomes, insufficient data.`
    );
  }

  parts.push(
    `One risk to keep in mind: attributing improvement to Blueprint when concurrent ` +
    `external factors (seasonality, market changes, unrelated content) may be the ` +
    `real cause. The attribution engine quotes confidence levels alongside figures, ` +
    `but the most honest statement is that directly-measured task outcomes are the ` +
    `only tight signal. Everything beyond that is best-effort inference.`
  );

  return parts.filter(Boolean).join('\n\n');
}

function containsUncertainty(text: string): boolean {
  if (!text) return false;
  // Must mention at least one of: uncertainty, not working, don't know, too soon,
  // risk, worsened, decline, insufficient, open measurement.
  return /\b(uncertain|unclear|not working|don'?t know|too soon|risk|worsen|decline|insufficient|open measurement|not yet|may be wrong|could be wrong|would need|limited data|not known|might be)\b/i
    .test(text);
}

export default router;
