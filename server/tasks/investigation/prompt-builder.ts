/**
 * Investigation Prompt Builder
 *
 * Builds a detailed, data-rich prompt for the investigation LLM call.
 * The prompt is specific enough that the LLM produces actionable findings
 * regardless of which connectors are involved.
 */

import { sanitiseExternalContent, wrapInContentBoundary } from '../../lib/content-sanitiser.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InvestigationTask {
  title?: string | null;
  description?: string | null;
  priority?: string | null;
  [key: string]: unknown;
}

interface MetricEntry {
  value: number | null;
  data?: unknown;
  recorded_at?: string;
}

interface HistoricalEntry {
  avg: number | null;
  min?: number | null;
  max?: number | null;
}

interface InvestigationContext {
  current_metrics: Record<string, Record<string, MetricEntry>>;
  historical_metrics: Record<string, Record<string, HistoricalEntry>>;
  signal?: Record<string, unknown> | null;
  in_flight_actions: Array<Record<string, unknown>>;
  recent_outcomes: Array<{ title: string; action_type: string; verdict?: string | null; change_pct?: number | null; metric_name?: string | null }>;
  active_goals: Array<{ title: string; metric_name: string; metric_current?: number | null; metric_target?: number | null; progress_pct?: number | null }>;
  kb_context?: string | null;
  seasonal_context?: string | null;
  all_connected_connectors?: string[];
  theme_files?: Record<string, string> | null;
  [key: string]: unknown;
}

/**
 * Build a complete investigation prompt from task + assembled context.
 *
 * @param task - The investigation task row
 * @param context - Output from assembleInvestigationContext
 * @returns Full prompt string
 */
export function buildInvestigationPrompt(task: InvestigationTask, context: InvestigationContext): string {
  const metricsBlock = buildMetricsBlock(context);
  const signalBlock = buildSignalBlock(context.signal);
  const inFlightBlock = buildInFlightBlock(context.in_flight_actions);
  const outcomesBlock = buildOutcomesBlock(context.recent_outcomes);
  const goalsBlock = buildGoalsBlock(context.active_goals);
  const themeFilesBlock = buildThemeFilesBlock(context.theme_files);

  const actionTypesBlock = buildActionTypesBlock(context.all_connected_connectors ?? []);

  // KB context is internally generated but compounds with external research
  // over time, so it still gets sanitised + wrapped as a defensive measure.
  const rawKbContext = _truncate(context.kb_context ?? null, MAX_KB_CONTEXT_CHARS) || 'No relevant knowledge base entries found.';
  const kbSanitised = sanitiseExternalContent(rawKbContext, 'kb_context') as { content: string };
  const kbContext = wrapInContentBoundary(kbSanitised.content, 'kb_context') as string;
  const seasonalContext = _truncate(context.seasonal_context ?? null, MAX_SEASONAL_CHARS) || 'No seasonal patterns detected yet.';

  const fullFileContent = context.theme_files?.['layout/theme.liquid'] ?? '';
  const themeFileIsTruncated = fullFileContent.length > MAX_THEME_FILE_CHARS;
  const themeSection = themeFilesBlock
    ? `\n# SHOPIFY THEME FILES (read by Blueprint from the live theme)\n` +
      `When proposing a shopify_theme_edit action:\n` +
      `  • Set file_key to "layout/theme.liquid"\n` +
      (themeFileIsTruncated
        ? `  • Only the <head> section is shown (file too large to display in full)\n` +
          `  • Set new_content to the COMPLETE modified <head>…</head> block only — Blueprint will splice it into the live file\n`
        : `  • The complete file is shown below — set new_content to the ENTIRE modified file\n`) +
      `\n` +
      themeFilesBlock + '\n'
    : '';

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
${kbContext}

# SEASONAL CONTEXT
${seasonalContext}
${themeSection}
---

Produce a complete investigation report as JSON.

Every field must be filled. No null values.
Every claim must reference specific data from above.
action_tasks must be specific enough to execute without further research.
Only use action_types listed in the VALID ACTION TYPES section below — those
are the only types this business can currently execute.
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

${actionTypesBlock}

# ORDER YOUR action_tasks

Order by: highest expected impact first.
If task B depends on task A completing first, set depends_on_order: A's order number.
Maximum 5 action_tasks per investigation.
If more fixes are needed, the top 5 most impactful ones only.
Additional fixes can be found in the next investigation cycle.`;
}

// ─── Block builders ───────────────────────────────────────────────────────────

// Hard limits to prevent runaway prompt sizes on large accounts
const MAX_METRICS_PER_CONNECTOR = 20;
const MAX_METRICS_BLOCK_CHARS   = 4_000;
const MAX_SIGNAL_DATA_CHARS     = 500;
const MAX_KB_CONTEXT_CHARS      = 2_000;
const MAX_SEASONAL_CHARS        = 1_000;
const MAX_THEME_FILE_CHARS      = 10_000;

function buildMetricsBlock(context: InvestigationContext): string | null {
  const entries = Object.entries(context.current_metrics);
  if (!entries.length) return null;

  const connectorBlocks = entries.map(([connectorType, metrics]) => {
    const historical = context.historical_metrics[connectorType] ?? {};
    let metricEntries = Object.entries(metrics);

    // Sort by absolute % deviation (most anomalous first), then cap count
    metricEntries.sort(([nameA, a], [nameB, b]) => {
      const devA = _deviation(a, historical[nameA]);
      const devB = _deviation(b, historical[nameB]);
      return devB - devA;
    });
    const capped = metricEntries.slice(0, MAX_METRICS_PER_CONNECTOR);
    const omitted = metricEntries.length - capped.length;

    const metricLines = capped.map(([name, data]) => {
      const hist = historical[name];
      let change = 'no history';
      if (hist?.avg != null && data.value != null) {
        const pct = ((data.value - hist.avg) / Math.abs(hist.avg)) * 100;
        change = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
      }
      return `  ${name}: ${data.value ?? 'n/a'} (vs 30d avg: ${hist?.avg?.toFixed(2) ?? 'unknown'}, change: ${change})`;
    });
    if (omitted > 0) metricLines.push(`  … ${omitted} additional metrics omitted (low deviation)`);
    return `## ${connectorType.toUpperCase()}\n${metricLines.join('\n')}`;
  });

  const full = connectorBlocks.join('\n\n');
  if (full.length > MAX_METRICS_BLOCK_CHARS) {
    return full.slice(0, MAX_METRICS_BLOCK_CHARS) + '\n… [metrics truncated for length]';
  }
  return full;
}

/** Compute absolute % deviation for sorting — returns 0 if unknown. */
function _deviation(data: MetricEntry, hist: HistoricalEntry | undefined): number {
  if (hist?.avg == null || data?.value == null || hist.avg === 0) return 0;
  return Math.abs((data.value - hist.avg) / Math.abs(hist.avg)) * 100;
}

/** Truncate a string to maxChars, appending an ellipsis if cut. */
function _truncate(str: string | null | undefined, maxChars: number): string | null | undefined {
  if (!str) return str;
  return str.length > maxChars ? str.slice(0, maxChars) + '\n… [truncated for length]' : str;
}

function buildSignalBlock(signal: Record<string, unknown> | null | undefined): string {
  if (!signal) return 'No linked signal — investigation triggered manually or from task.';
  let signalData: unknown = null;
  try { signalData = signal.data ? JSON.parse(signal.data as string) : null; } catch {}
  let dataStr = '';
  if (signalData) {
    const raw = JSON.stringify(signalData);
    const trimmed = raw.length > MAX_SIGNAL_DATA_CHARS ? raw.slice(0, MAX_SIGNAL_DATA_CHARS) + '…' : raw;
    // Signal data often embeds connector-derived strings (URLs, product
    // descriptions, GBP reviews). Sanitise before putting them in a prompt.
    const { content } = sanitiseExternalContent(trimmed, 'signal_data') as { content: string };
    dataStr = `Data: ${content}`;
  }
  return [
    `Title: ${signal.title as string}`,
    `Severity: ${signal.severity as string}`,
    `Description: ${(signal.description as string | undefined) ?? '(none)'}`,
    dataStr,
  ].filter(Boolean).join('\n');
}

function buildInFlightBlock(inFlight: Array<Record<string, unknown>>): string {
  if (!inFlight.length) return 'None — all areas are available for action.';
  return inFlight.map(a =>
    `- "${a.title as string}" (${a.action_type as string}) — do not re-act until: ${a.do_not_touch_until as string}\n` +
    `  Note: ${(a.measurement_notes as string | undefined) ?? 'Standard measurement window'}`
  ).join('\n');
}

function buildOutcomesBlock(outcomes: Array<{ title: string; action_type: string; verdict?: string | null; change_pct?: number | null; metric_name?: string | null }>): string {
  if (!outcomes.length) return 'No outcome history yet.';
  return outcomes.map(o =>
    `- ${o.title}: ${o.verdict ?? 'pending'}${o.change_pct != null ? ` (${o.change_pct > 0 ? '+' : ''}${o.change_pct.toFixed(1)}%)` : ''} on ${o.metric_name ?? 'unknown metric'}`
  ).join('\n');
}

function buildGoalsBlock(goals: Array<{ title: string; metric_name: string; metric_current?: number | null; metric_target?: number | null; progress_pct?: number | null }>): string {
  if (!goals.length) return 'No active goals set.';
  return goals.map(g =>
    `- ${g.title}: ${(g.progress_pct ?? 0).toFixed(0)}% toward target (${g.metric_name}: ${g.metric_current ?? '?'} → ${g.metric_target ?? '?'})`
  ).join('\n');
}

function buildThemeFilesBlock(themeFiles: Record<string, string> | null | undefined): string | null {
  if (!themeFiles) return null;

  const fullFile = themeFiles['layout/theme.liquid'] ?? '';
  const headSection = themeFiles['layout/theme.liquid#head'] ?? fullFile;

  if (!fullFile && !headSection) return null;

  // Show the full file if it fits — LLM needs the complete file to write new_content.
  // If too large, show the <head> section only (still useful for targeted changes).
  const fitsInFull = fullFile.length <= MAX_THEME_FILE_CHARS;
  const display = fitsInFull ? fullFile : headSection;
  const content = _truncate(display || fullFile, MAX_THEME_FILE_CHARS);
  if (!content) return null;

  const label = fitsInFull ? 'layout/theme.liquid (complete file)' : 'layout/theme.liquid (<head> section — rest of file omitted)';
  return [`## ${label}`, '```liquid', content, '```'].join('\n');
}

// ─── Action types filtered to connected connectors ────────────────────────────

// Maps connector type → action types it enables.
// Connectors not in this map have no dedicated write-back actions.
const CONNECTOR_ACTIONS: Record<string, string[]> = {
  shopify:       ['shopify_description_update', 'shopify_theme_edit', 'shopify_product_create', 'shopify_page_create', 'shopify_meta_update'],
  github:        ['github_issue', 'github_pr'],
  'server-access': ['server_file_write'],
  wix:           ['wix_seo_update'],
  gbp:           ['gbp_update'],
  klaviyo:       ['klaviyo_flow_update'],
  'meta-ads':    ['meta_ads_update'],
};

const ACTION_TYPE_PAYLOADS: Record<string, string> = {
  investigation:              'payload: { focus: string, data_needed: string[], hypothesis: string }',
  content_draft:              'payload: { content_type: "blog_post|landing_page|product_description|email", title: string, brief: string, target_keyword: string, word_count: number }',
  meta_update:                'payload: { url: string, field: "title|description", current: string, proposed: string }',
  shopify_description_update: 'payload: { product_id: string, product_title: string, current_description: string, proposed_description: string }',
  shopify_theme_edit:         'payload: { file_key: string, new_content: string, change_description: string }',
  shopify_product_create:     'payload: { title: string, description: string, product_type: string }',
  shopify_page_create:        'payload: { title: string, body_html: string, handle: string }',
  shopify_meta_update:        'payload: { resource_type: "product|page|collection", resource_id: string, seo_title: string, seo_description: string }',
  github_issue:               'payload: { title: string, body: string, labels: string[], assignees: string[] }',
  github_pr:                  'payload: { title: string, branch: string, description: string, files_to_change: string[] }',
  server_file_write:          'payload: { connector_id: string, file_path: string, change_description: string }',
  wix_seo_update:             'payload: { page_id: string, field: "title|description", current: string, proposed: string }',
  gbp_update:                 'payload: { field: "description|hours|category", current: string, proposed: string }',
  klaviyo_flow_update:        'payload: { flow_id: string, flow_name: string, change_description: string }',
  meta_ads_update:            'payload: { campaign_id: string, change_type: "budget|audience|creative|bid", change_description: string }',
};

function buildActionTypesBlock(connectedTypes: string[]): string {
  const connected = new Set(connectedTypes);

  // Always available regardless of connectors
  const available: string[] = ['investigation', 'content_draft', 'meta_update'];

  // Add connector-specific types
  for (const [connectorType, actionTypes] of Object.entries(CONNECTOR_ACTIONS)) {
    if (connected.has(connectorType)) {
      available.push(...actionTypes);
    }
  }

  const lines: string[] = ['# VALID ACTION TYPES AND THEIR PAYLOADS', ''];
  for (const type of available) {
    const payload = ACTION_TYPE_PAYLOADS[type];
    if (payload) lines.push(`${type}:\n  ${payload}\n`);
  }

  return lines.join('\n');
}
