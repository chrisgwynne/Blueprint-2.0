import db, { generateId } from '../db/db.js';
import { createTask } from '../tasks/task-queue.js';
import { createTaskEvent } from '../tasks/task-events.js';
import { runLLM, getProviderCredentials, listProviders } from '../lib/llm-providers.js';

// Resolve which provider + model to use for AI analysis.
// Priority: settings table 'ai_analysis_provider' → first configured provider → anthropic
function resolveAnalysisProvider() {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'ai_analysis_provider'").get();
  if (stored?.value) {
    try {
      const { provider, model } = JSON.parse(stored.value);
      if (provider && model) return { provider, model };
    } catch {}
  }
  // Fall back to claude-cli if available, then anthropic
  const providers = listProviders();
  const cli = providers.find(p => p.id === 'claude-cli');
  if (cli?.configured) return { provider: 'claude-cli', model: 'claude-sonnet-4-20250514' };
  const ant = providers.find(p => p.id === 'anthropic');
  if (ant?.configured) return { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
  // Last resort
  return { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
}

const ANALYSIS_SYSTEM_PROMPT = `You are Blueprint's intelligence engine analyzing real business data to surface actionable insights.

You look for:
- ANOMALIES: Unusual patterns vs historical baselines
- OPPORTUNITIES: Positive signals suggesting high-value actions
- RISKS: Declining metrics or warning patterns
- CORRELATIONS: Connections between data from different sources
- QUICK WINS: High-confidence, low-effort improvements

Rules:
- Only surface insights with confidence >= 0.70
- Do not report on normal/expected patterns
- For each insight, propose one specific concrete task

Respond ONLY in valid JSON:
{
  "summary": "2-3 sentence business health overview",
  "health_score": <0-100>,
  "insights": [
    {
      "type": "anomaly|opportunity|risk|correlation|quick_win",
      "severity": "critical|alert|warning|opportunity|info",
      "title": "Short specific title",
      "description": "2-3 sentences explaining finding and why it matters",
      "evidence": ["specific data point 1", "data point 2"],
      "connectors_involved": ["ga4", "gsc"],
      "confidence": 0.92,
      "actionable": true,
      "priority": "p1|p2|p3",
      "proposed_task": {
        "title": "Specific action",
        "description": "Exactly what to do",
        "action_type": "investigation|content_draft|meta_update|shopify_edit|github_issue",
        "estimated_impact": "Expected improvement",
        "agent": "seo-sentinel|quill|conductor"
      }
    }
  ]
}`;

function buildShopifySummary(latestByName) {
  const revenue   = latestByName['revenue']?.value;
  const orders    = latestByName['orders']?.value;
  const aov       = latestByName['aov']?.value;
  const customers = latestByName['customers']?.value;

  const dailyRevenue  = latestByName['daily_revenue']?.data  ?? [];
  const dailyOrders   = latestByName['orders_daily']?.data   ?? [];
  const topProducts   = latestByName['top_products_data']?.data ?? [];

  // Period summaries
  const sumRevenue = (arr, from, to) => arr.slice(from, to).reduce((s, d) => s + (d.amount || 0), 0);
  const sumOrders  = (arr, from, to) => arr.slice(from, to).reduce((s, d) => s + (d.count  || 0), 0);

  const rev7    = sumRevenue(dailyRevenue, -7);
  const rev14   = sumRevenue(dailyRevenue, -14, -7);
  const rev30   = sumRevenue(dailyRevenue, -30);
  const ord7    = sumOrders(dailyOrders, -7);
  const ord14   = sumOrders(dailyOrders, -14, -7);
  const wow     = rev14 > 0 ? (((rev7 - rev14) / rev14) * 100).toFixed(1) : 'N/A';
  const wowOrd  = ord14 > 0 ? (((ord7 - ord14) / ord14) * 100).toFixed(1) : 'N/A';

  // Find best and worst days
  const sorted = [...dailyRevenue].sort((a, b) => b.amount - a.amount);
  const bestDay  = sorted[0];
  const worstDay = sorted[sorted.length - 1];

  // Weekend vs weekday split (last 30 days)
  const last30Days = dailyRevenue.slice(-30);
  const weekendRev  = last30Days.filter(d => { const dow = new Date(d.date).getDay(); return dow === 0 || dow === 6; }).reduce((s, d) => s + d.amount, 0);
  const weekdayRev  = last30Days.filter(d => { const dow = new Date(d.date).getDay(); return dow >= 1 && dow <= 5; }).reduce((s, d) => s + d.amount, 0);
  const weekendDays = last30Days.filter(d => { const dow = new Date(d.date).getDay(); return dow === 0 || dow === 6; }).length;
  const weekdayDays = last30Days.filter(d => { const dow = new Date(d.date).getDay(); return dow >= 1 && dow <= 5; }).length;
  const weekendAvg = weekendDays > 0 ? (weekendRev / weekendDays).toFixed(2) : 'N/A';
  const weekdayAvg = weekdayDays > 0 ? (weekdayRev / weekdayDays).toFixed(2) : 'N/A';

  // Zero-revenue days in last 30
  const zeroDays = last30Days.filter(d => d.amount === 0).length;

  // Daily revenue last 30
  const recentDailyLines = dailyRevenue.slice(-30)
    .map(d => {
      const ordEntry = dailyOrders.find(o => o.date === d.date);
      return `  ${d.date}: £${d.amount.toFixed(2)} (${ordEntry?.count ?? 0} orders)`;
    }).join('\n');

  return `### SHOPIFY
Overall (last 120 days): £${revenue?.toFixed(2) ?? 'N/A'} revenue | ${orders ?? 'N/A'} orders | £${aov?.toFixed(2) ?? 'N/A'} AOV | ${customers ?? 'N/A'} customers

Period comparison:
- Last 7 days:  £${rev7.toFixed(2)} revenue, ${ord7} orders
- Prev 7 days:  £${rev14.toFixed(2)} revenue, ${ord14} orders
- Week-on-week: revenue ${wow}%, orders ${wowOrd}%
- Last 30 days: £${rev30.toFixed(2)} revenue

Day-of-week analysis (last 30 days):
- Weekday avg daily revenue: £${weekdayAvg}
- Weekend avg daily revenue: £${weekendAvg}
- Zero-revenue days in last 30: ${zeroDays}

Peak / trough (all time):
- Best day:  ${bestDay?.date ?? 'N/A'} — £${bestDay?.amount?.toFixed(2) ?? 'N/A'}
- Worst day: ${worstDay?.date ?? 'N/A'} — £${worstDay?.amount?.toFixed(2) ?? 'N/A'}

Daily revenue + orders (last 30 days):
${recentDailyLines}

Top products by revenue (last 120 days):
${topProducts.slice(0, 15).map((p, i) => `  ${i + 1}. ${p.title} — £${p.revenue?.toFixed(2)} revenue, ${p.quantity} units`).join('\n')}`;
}

/**
 * Run AI analysis for a business.
 *
 * @param {string} businessId
 * @param {string} runId - Pre-created analysis_run ID to update
 * @returns {Promise<{ runId, insightsCount, tasksCreated, healthScore, summary }>}
 */
export async function runAIAnalysis(businessId, runId) {
  try {
    // 1. Gather data
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    if (!business) throw new Error(`Business '${businessId}' not found.`);

    // Get connected connectors
    const connectors = db.prepare(
      `SELECT id, type, name, status, last_sync FROM connectors WHERE business_id = ? AND status != 'disconnected'`
    ).all(businessId);

    const connectorIds = connectors.map(c => c.id);
    const connectorNames = connectors.map(c => c.type);

    // Get recent metrics (last 28 days) grouped by connector
    const since28d = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const metricsRaw = connectorIds.length > 0
      ? db.prepare(`
          SELECT connector_id, metric_name, metric_value, metric_data, recorded_at
          FROM metrics
          WHERE business_id = ? AND recorded_at >= ?
          ORDER BY recorded_at DESC
        `).all(businessId, since28d)
      : [];

    // Group metrics by connector type
    const metricsByConnector = {};
    for (const m of metricsRaw) {
      const connector = connectors.find(c => c.id === m.connector_id);
      const key = connector?.type ?? m.connector_id;
      if (!metricsByConnector[key]) metricsByConnector[key] = [];
      metricsByConnector[key].push({
        metric: m.metric_name,
        value: m.metric_value,
        data: m.metric_data ? JSON.parse(m.metric_data) : null,
        recorded_at: m.recorded_at,
      });
    }

    // Get open non-AI signals as context (rule-based alerts already in flight).
    // Exclude previous ai_analysis signals — those are about to be replaced.
    const openSignals = db.prepare(`
      SELECT rule_id, type, severity, title, description, confidence, created_at
      FROM signals
      WHERE business_id = ? AND status = 'open' AND rule_id != 'ai_analysis'
      ORDER BY created_at DESC LIMIT 20
    `).all(businessId);

    // Build the user prompt
    const userPrompt = `Analyse the following business data and surface actionable insights.

## Business
- Name: ${business.name}
- Type: ${business.type ?? 'ecommerce'}
- Description: ${business.description ?? 'N/A'}

## Connected Connectors
${connectors.length > 0
  ? connectors.map(c => `- ${c.type} (${c.name}) — status: ${c.status}, last sync: ${c.last_sync ?? 'never'}`).join('\n')
  : '- No connectors connected'}

## Metrics
${Object.keys(metricsByConnector).length > 0
  ? Object.entries(metricsByConnector).map(([type, metrics]) => {
      const latestByName = {};
      for (const m of metrics) {
        if (!latestByName[m.metric]) latestByName[m.metric] = m;
      }
      if (type === 'shopify') return buildShopifySummary(latestByName);
      // Generic fallback for other connectors
      return `### ${type.toUpperCase()}\n${Object.values(latestByName)
        .filter(m => m.value !== null || !m.data)
        .map(m => `- ${m.metric}: ${m.value ?? 'N/A'}`)
        .join('\n')}`;
    }).join('\n\n')
  : '- No metrics available'}

## Open Signals (existing alerts)
${openSignals.length > 0
  ? openSignals.map(s => `- [${s.severity}] ${s.title} (confidence: ${s.confidence ?? 'N/A'}, created: ${s.created_at})`).join('\n')
  : '- No open signals'}

Identify insights and proposed tasks based solely on this data.`;

    // 2. Call LLM (uses configured provider — claude-cli, anthropic, etc.)
    const { provider: analysisProvider, model: analysisModel } = resolveAnalysisProvider();
    console.log(`[ai-analysis] Using provider: ${analysisProvider}, model: ${analysisModel}`);

    console.log(`[ai-analysis] System prompt: ${ANALYSIS_SYSTEM_PROMPT.length} chars, user prompt: ${userPrompt.length} chars`);

    const response = await runLLM(analysisProvider, analysisModel, {
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 4096,
      temperature: 0.3,
    });

    console.log(`[ai-analysis] Response content length: ${response.content?.length ?? 0}`);
    const rawContent = response.content ?? '';
    const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };

    // 3. Parse JSON response (handle markdown code blocks like agent-runner.js)
    let parsed;
    try {
      const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                        rawContent.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1] : rawContent;
      parsed = JSON.parse(jsonStr.trim());
    } catch (err) {
      console.error('[ai-analysis] Failed to parse response as JSON:', rawContent.substring(0, 500));
      parsed = { summary: 'Analysis failed to parse.', health_score: null, insights: [] };
    }

    const insights = Array.isArray(parsed.insights) ? parsed.insights : [];
    const healthScore = parsed.health_score ?? null;
    const summary = parsed.summary ?? '';

    // 4. Commit signals + retire previous batch — all in one transaction so a
    //    failed run never touches existing signals.
    let insightsCount = 0;
    let tasksCreated = 0;

    const validInsights = insights.filter(i => i.title && i.type && i.severity);

    const commitSignals = db.transaction(() => {
      // Retire previous ai_analysis signals for this business: null out any task
      // foreign-key references first, then soft-delete the signals.
      const oldIds = db.prepare(
        `SELECT id FROM signals WHERE business_id = ? AND rule_id = 'ai_analysis' AND status = 'open'`
      ).all(businessId).map(r => r.id);

      if (oldIds.length > 0) {
        const placeholders = oldIds.map(() => '?').join(',');
        db.prepare(`UPDATE tasks SET signal_id = NULL WHERE signal_id IN (${placeholders})`).run(...oldIds);
        db.prepare(`UPDATE signals SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...oldIds);
      }

      // Insert new signals
      for (const insight of validInsights) {
        const signalId = generateId();
        db.prepare(`
          INSERT INTO signals (
            id, business_id, connector_id, rule_id, type, severity,
            title, description, data, status, confidence, agent_id, created_at
          ) VALUES (?, ?, NULL, 'ai_analysis', ?, ?, ?, ?, ?, 'open', ?, 'conductor', CURRENT_TIMESTAMP)
        `).run(
          signalId,
          businessId,
          insight.type,
          insight.severity,
          insight.title,
          insight.description ?? null,
          JSON.stringify({
            evidence: insight.evidence ?? [],
            connectors_involved: insight.connectors_involved ?? [],
            actionable: insight.actionable ?? false,
            priority: insight.priority ?? 'p2',
            proposed_task: insight.proposed_task ?? null,
            run_id: runId,
          }),
          insight.confidence ?? null
        );

        insightsCount++;

        // For high-confidence actionable insights: create a proposed task
        if (
          insight.actionable &&
          (insight.confidence ?? 0) > 0.85 &&
          insight.proposed_task?.title
        ) {
          try {
            const pt = insight.proposed_task;
            const task = createTask({
              business_id: businessId,
              signal_id: signalId,
              title: pt.title,
              description: pt.description ?? null,
              proposed_by: pt.agent ?? 'conductor',
              action_type: pt.action_type ?? null,
              action_payload: { estimated_impact: pt.estimated_impact ?? null },
              trust_tier: 'yellow',
              priority: insight.priority ?? 'p2',
              confidence: insight.confidence ?? null,
              approval_mode: 'requires_approval',
            });

            createTaskEvent(
              task.id,
              'created',
              pt.agent ?? 'conductor',
              `Task created from AI analysis insight: "${insight.title}"`,
              { signal_id: signalId, run_id: runId, insight_type: insight.type }
            );

            tasksCreated++;
          } catch (taskErr) {
            console.error('[ai-analysis] Failed to create task for insight:', taskErr.message);
          }
        }
      }
    });

    commitSignals(); // only runs if LLM call above succeeded

    // 5. Cost is already calculated by runLLM (0 for claude-cli subscription use)
    const costUsd = response.cost_usd ?? 0;

    // 6. Mark analysis_run as complete
    db.prepare(`
      UPDATE analysis_runs SET
        status = 'complete',
        connectors_analysed = ?,
        insights_count = ?,
        tasks_created = ?,
        health_score = ?,
        summary = ?,
        model_used = ?,
        prompt_tokens = ?,
        completion_tokens = ?,
        cost_usd = ?,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      JSON.stringify(connectorNames),
      insightsCount,
      tasksCreated,
      healthScore,
      summary,
      `${analysisProvider}/${analysisModel}`,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      costUsd,
      runId
    );

    console.log(`[ai-analysis] Run ${runId} complete: ${insightsCount} insights, ${tasksCreated} tasks created, health: ${healthScore}`);

    return { runId, insightsCount, tasksCreated, healthScore, summary };

  } catch (err) {
    // Mark run as failed
    try {
      db.prepare(`
        UPDATE analysis_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(runId);
    } catch (_) {}

    console.error('[ai-analysis] Analysis run failed:', err);
    throw err;
  }
}

/**
 * Get the status of an analysis run.
 * @param {string} runId
 * @returns {Object|null}
 */
export async function getAnalysisStatus(runId) {
  return db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId) ?? null;
}
