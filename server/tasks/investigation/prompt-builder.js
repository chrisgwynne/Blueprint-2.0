/**
 * Investigation Prompt Builder
 *
 * Builds a detailed, data-rich prompt for the investigation LLM call.
 * The prompt is specific enough that the LLM produces actionable findings
 * regardless of which connectors are involved.
 */

/**
 * Build a complete investigation prompt from task + assembled context.
 *
 * @param {Object} task - The investigation task row
 * @param {Object} context - Output from assembleInvestigationContext
 * @returns {string} Full prompt string
 */
export function buildInvestigationPrompt(task, context) {
  const metricsBlock = buildMetricsBlock(context);
  const signalBlock = buildSignalBlock(context.signal);
  const inFlightBlock = buildInFlightBlock(context.in_flight_actions);
  const outcomesBlock = buildOutcomesBlock(context.recent_outcomes);
  const goalsBlock = buildGoalsBlock(context.active_goals);

  return `Investigate this specific business problem and produce actionable findings.

# INVESTIGATION TASK
Title: ${task.title}
Description: ${task.description || '(no description)'}
Priority: ${task.priority || 'p2'}

# TRIGGERING SIGNAL
${signalBlock}

# CURRENT METRICS vs 30-DAY HISTORICAL AVERAGE
${metricsBlock || 'No relevant metrics available for this investigation.'}

# IN-FLIGHT ACTIONS (do not propose re-acting on these)
${inFlightBlock}

# WHAT HAS WORKED / NOT WORKED RECENTLY
${outcomesBlock}

# ACTIVE BUSINESS GOALS
${goalsBlock}

# RELEVANT KB CONTEXT
${context.kb_context || 'No relevant knowledge base entries found.'}

# SEASONAL CONTEXT
${context.seasonal_context || 'No seasonal patterns detected yet.'}

---

Produce a complete investigation report as JSON.

Every field must be filled. No null values.
Every claim must reference specific data from above.
action_tasks must be specific enough to execute without further research.
If you cannot determine a specific fix, set action_type to 'investigation'
with a focused scope — not a repeat of this investigation.

{
  "summary": "2-3 sentence plain English summary. What is happening. Why. Business impact.",

  "primary_cause": "The single most specific root cause. Name specific metrics, files, or systems.",

  "confidence": 0.0-1.0,

  "evidence": [
    "Specific data point 1 — cite exact metric name and value",
    "Specific data point 2",
    "Specific data point 3"
  ],

  "explanation": "4-6 sentences. What is happening mechanically. Why it is happening. What it means for the business in concrete terms (revenue, rankings, conversions). What will happen if not addressed.",

  "alternatives": [
    {
      "cause": "Alternative explanation",
      "probability": 0.0-1.0,
      "ruling_out": "Specific reason this is less likely than primary cause"
    }
  ],

  "recommendation": "act_now|wait|monitor|investigate_further",

  "recommendation_reason": "Why this specific recommendation. If wait: when to check again and what to look for.",

  "action_tasks": [
    {
      "title": "Specific action title. Not vague. Name the exact thing being changed.",
      "description": "Complete description. Include: what exactly to change, where to find it, what the new value should be, why this change addresses the root cause.",
      "action_type": "One of the valid Blueprint action types — see list below",
      "priority": "p1|p2|p3",
      "confidence": 0.0-1.0,
      "expected_impact": "Specific expected improvement. Name the metric. Give a number range.",
      "measurement_window_days": 14,
      "target_metric": "exact.metric.name",
      "order": 1,
      "depends_on_order": null,
      "action_payload": {}
    }
  ],

  "do_not_do": [
    "Specific thing that would seem logical but would be wrong or premature"
  ],

  "measurement_plan": {
    "primary_metric": "exact.metric.name",
    "check_at_days": 14,
    "leading_indicator": {
      "metric": "metric to check sooner",
      "check_at_days": 7,
      "good_sign": "what value or direction indicates the fix is working",
      "bad_sign": "what value indicates the fix is not working"
    }
  }
}

# VALID ACTION TYPES AND THEIR PAYLOADS

meta_update:
  payload: { url: string, field: "title|description", current: string, proposed: string }

shopify_description_update:
  payload: { product_id: string, product_title: string, current_description: string, proposed_description: string }

shopify_theme_edit:
  payload: { file_key: string, change_description: string, change_type: "add_defer|add_async|image_optimization|remove_render_blocking|css_optimization|other" }

shopify_product_create:
  payload: { title: string, description: string, product_type: string }

shopify_page_create:
  payload: { title: string, body_html: string, handle: string }

shopify_meta_update:
  payload: { resource_type: "product|page|collection", resource_id: string, seo_title: string, seo_description: string }

github_issue:
  payload: { title: string, body: string, labels: string[], assignees: string[] }

github_pr:
  payload: { title: string, branch: string, description: string, files_to_change: string[] }

content_draft:
  payload: { content_type: "blog_post|landing_page|product_description|email", title: string, brief: string, target_keyword: string, word_count: number }

investigation:
  payload: { focus: string, data_needed: string[], hypothesis: string }

server_file_write:
  payload: { connector_id: string, file_path: string, change_description: string }

wix_seo_update:
  payload: { page_id: string, field: "title|description", current: string, proposed: string }

gbp_update:
  payload: { field: "description|hours|category", current: string, proposed: string }

klaviyo_flow_update:
  payload: { flow_id: string, flow_name: string, change_description: string }

meta_ads_update:
  payload: { campaign_id: string, change_type: "budget|audience|creative|bid", change_description: string }

# ORDER YOUR action_tasks

Order by: highest expected impact first.
If task B depends on task A completing first, set depends_on_order: A's order number.
Maximum 5 action_tasks per investigation.
If more fixes are needed, the top 5 most impactful ones only.
Additional fixes can be found in the next investigation cycle.`;
}

// ─── Block builders ───────────────────────────────────────────────────────────

function buildMetricsBlock(context) {
  const entries = Object.entries(context.current_metrics);
  if (!entries.length) return null;

  return entries.map(([connectorType, metrics]) => {
    const historical = context.historical_metrics[connectorType] ?? {};
    const metricLines = Object.entries(metrics).map(([name, data]) => {
      const hist = historical[name];
      let change = 'no history';
      if (hist?.avg != null && data.value != null) {
        const pct = ((data.value - hist.avg) / Math.abs(hist.avg)) * 100;
        change = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
      }
      return `  ${name}: ${data.value ?? 'n/a'} (vs 30d avg: ${hist?.avg?.toFixed(2) ?? 'unknown'}, change: ${change})`;
    });
    return `## ${connectorType.toUpperCase()}\n${metricLines.join('\n')}`;
  }).join('\n\n');
}

function buildSignalBlock(signal) {
  if (!signal) return 'No linked signal — investigation triggered manually or from task.';
  let signalData = null;
  try { signalData = signal.data ? JSON.parse(signal.data) : null; } catch {}
  return [
    `Title: ${signal.title}`,
    `Severity: ${signal.severity}`,
    `Description: ${signal.description ?? '(none)'}`,
    signalData ? `Data: ${JSON.stringify(signalData, null, 2)}` : '',
  ].filter(Boolean).join('\n');
}

function buildInFlightBlock(inFlight) {
  if (!inFlight.length) return 'None — all areas are available for action.';
  return inFlight.map(a =>
    `- "${a.title}" (${a.action_type}) — do not re-act until: ${a.do_not_touch_until}\n` +
    `  Note: ${a.measurement_notes ?? 'Standard measurement window'}`
  ).join('\n');
}

function buildOutcomesBlock(outcomes) {
  if (!outcomes.length) return 'No outcome history yet.';
  return outcomes.map(o =>
    `- ${o.title}: ${o.verdict ?? 'pending'}${o.change_pct != null ? ` (${o.change_pct > 0 ? '+' : ''}${o.change_pct.toFixed(1)}%)` : ''} on ${o.metric_name ?? 'unknown metric'}`
  ).join('\n');
}

function buildGoalsBlock(goals) {
  if (!goals.length) return 'No active goals set.';
  return goals.map(g =>
    `- ${g.title}: ${(g.progress_pct ?? 0).toFixed(0)}% toward target (${g.metric_name}: ${g.metric_current ?? '?'} → ${g.metric_target ?? '?'})`
  ).join('\n');
}
