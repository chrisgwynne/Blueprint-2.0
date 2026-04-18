/**
 * Investigation Context Assembler
 *
 * Assembles everything Blueprint knows that is relevant to a given
 * investigation task. Connector-agnostic — uses keywords from the task
 * title and description to determine what data to pull.
 */
import db from '../../db/db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InvestigationTask {
  id: string;
  title?: string | null;
  description?: string | null;
  signal_id?: string | null;
  [key: string]: unknown;
}

interface ConnectorRow {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface MetricRow {
  metric_name: string;
  metric_value: number | null;
  metric_data: string | null;
  recorded_at: string;
}

interface HistoricalRow {
  metric_name: string;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
}

interface SeasonalPatternRow {
  metric_name: string;
  pattern_type: string;
  pattern_data: string | null;
  confidence: number;
}

interface OutcomeRow {
  title: string;
  action_type: string;
  verdict: string | null;
  change_pct: number | null;
  metric_name: string | null;
}

interface GoalRow {
  title: string;
  metric_name: string;
  metric_target: number | null;
  metric_current: number | null;
  progress_pct: number | null;
  deadline: string | null;
}

// ─── Keyword → connector type mapping ────────────────────────────────────────

const KEYWORD_CONNECTOR_MAP: Record<string, string[]> = {
  // Performance keywords
  'performance': ['pagespeed', 'ga4'],
  'mobile': ['pagespeed', 'ga4'],
  'lcp': ['pagespeed'],
  'tti': ['pagespeed'],
  'speed': ['pagespeed', 'ga4'],
  'core web vitals': ['pagespeed'],
  'cwv': ['pagespeed'],

  // SEO keywords
  'seo': ['gsc', 'semrush', 'pagespeed'],
  'ranking': ['gsc', 'semrush'],
  'keyword': ['gsc', 'semrush'],
  'traffic': ['gsc', 'ga4', 'semrush'],
  'organic': ['gsc', 'ga4', 'semrush'],
  'impressions': ['gsc'],
  'clicks': ['gsc', 'ga4'],
  'ctr': ['gsc'],
  'position': ['gsc', 'semrush'],
  'backlink': ['semrush'],
  'crawl': ['gsc'],

  // Revenue / ecommerce
  'revenue': ['shopify', 'stripe', 'ga4'],
  'sales': ['shopify', 'stripe'],
  'conversion': ['shopify', 'ga4', 'klaviyo'],
  'orders': ['shopify', 'stripe'],
  'cart': ['shopify', 'ga4', 'klaviyo'],
  'abandoned': ['shopify', 'klaviyo'],
  'product': ['shopify', 'ga4'],
  'checkout': ['shopify', 'ga4'],
  'mrr': ['stripe'],
  'subscription': ['stripe'],
  'churn': ['stripe'],
  'ltv': ['stripe', 'shopify'],

  // Email / marketing
  'email': ['klaviyo', 'brevo'],
  'campaign': ['klaviyo', 'brevo', 'meta-ads', 'google-ads'],
  'open rate': ['klaviyo', 'brevo'],
  'click rate': ['klaviyo', 'brevo'],
  'unsubscribe': ['klaviyo', 'brevo'],
  'flow': ['klaviyo'],
  'automation': ['klaviyo', 'brevo'],
  'deliverability': ['klaviyo', 'brevo'],

  // Ads
  'roas': ['meta-ads', 'google-ads'],
  'ads': ['meta-ads', 'google-ads'],
  'paid': ['meta-ads', 'google-ads'],
  'cpc': ['meta-ads', 'google-ads'],
  'cpm': ['meta-ads'],
  'facebook': ['meta-ads', 'social'],
  'instagram': ['meta-ads', 'social'],
  'google ads': ['google-ads'],
  'spend': ['meta-ads', 'google-ads'],
  'budget': ['meta-ads', 'google-ads'],

  // Social
  'social': ['social', 'buffer'],
  'engagement': ['social', 'buffer'],
  'followers': ['social'],
  'reach': ['social', 'meta-ads'],
  'post': ['social', 'buffer'],
  'content': ['social', 'buffer', 'gsc', 'klaviyo'],

  // Technical / code
  'error': ['uptimerobot', 'github', 'server-access'],
  'uptime': ['uptimerobot'],
  'down': ['uptimerobot'],
  'deploy': ['github', 'server-access'],
  'code': ['github', 'server-access'],
  'bug': ['github', 'server-access'],
  'javascript': ['pagespeed', 'server-access'],
  'css': ['pagespeed', 'server-access'],

  // GBP / local
  'review': ['gbp'],
  'google business': ['gbp'],
  'local': ['gbp', 'gsc'],
  'maps': ['gbp'],
  'directions': ['gbp'],

  // Analytics / behaviour
  'bounce': ['ga4'],
  'session': ['ga4'],
  'user': ['ga4'],
  'behaviour': ['ga4'],
  'funnel': ['ga4', 'shopify'],
  'goal': ['ga4'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParseJSON(val: unknown): unknown {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val as string); } catch { return null; }
}

async function queryKBForContext(queryText: string, businessId: string): Promise<string | null> {
  try {
    const { getKBForBusiness } = await import('../../kb/kb-config.js') as {
      getKBForBusiness(id: string): Promise<{
        engine: {
          listFiles(folder: string): Promise<string[]>;
          readFile(f: string): Promise<{ frontmatter?: { title?: string }; content?: string }>;
        };
      } | null>;
    };
    const result = await getKBForBusiness(businessId);
    if (!result?.engine) return null;

    // Collect recent signal and research files for context
    const picks: string[] = [];
    for (const folder of ['signals', 'research', 'wiki']) {
      const files = await result.engine.listFiles(folder).catch(() => [] as string[]);
      for (const f of files.slice(-6)) {
        try {
          const parsed = await result.engine.readFile(f);
          const title = parsed.frontmatter?.title ?? f;
          const excerpt = (parsed.content || '').slice(0, 300).replace(/\n+/g, ' ').trim();
          if (excerpt) picks.push(`[${title}] ${excerpt}`);
        } catch {}
      }
    }
    return picks.length > 0 ? picks.slice(0, 8).join('\n\n') : null;
  } catch {
    return null;
  }
}

async function getSeasonalContext(metricNames: string[], businessId: string): Promise<string | null> {
  if (!metricNames.length) return null;
  try {
    const placeholders = metricNames.map(() => '?').join(', ');
    const patterns = db.prepare(`
      SELECT metric_name, pattern_type, pattern_data, confidence
      FROM seasonal_patterns
      WHERE business_id = ? AND metric_name IN (${placeholders})
      ORDER BY confidence DESC LIMIT 6
    `).all(businessId, ...metricNames) as SeasonalPatternRow[];

    if (!patterns.length) return null;
    return patterns.map(p => {
      const data = safeParseJSON(p.pattern_data);
      return `${p.metric_name} (${p.pattern_type}, confidence ${(p.confidence * 100).toFixed(0)}%): ${JSON.stringify(data).slice(0, 120)}`;
    }).join('\n');
  } catch {
    return null;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Assemble investigation context from all relevant connectors.
 *
 * @param task - The investigation task row
 * @param businessId
 * @returns Full context object
 */
export async function assembleInvestigationContext(task: InvestigationTask, businessId: string): Promise<Record<string, unknown>> {
  const text = ((task.title ?? '') + ' ' + (task.description ?? '')).toLowerCase();

  // 1. Identify relevant connectors from task keywords
  const relevantConnectorTypes = new Set<string>();
  for (const [keyword, connTypes] of Object.entries(KEYWORD_CONNECTOR_MAP)) {
    if (text.includes(keyword)) {
      connTypes.forEach(c => relevantConnectorTypes.add(c));
    }
  }

  // 2. Get active connectors for this business that match
  const activeConnectors = db.prepare(`
    SELECT * FROM connectors
    WHERE business_id = ? AND status = 'connected'
  `).all(businessId) as ConnectorRow[];

  // If no keywords matched, use all active connectors
  const relevantActive = relevantConnectorTypes.size > 0
    ? activeConnectors.filter(c => relevantConnectorTypes.has(c.type))
    : activeConnectors.slice(0, 5);

  // 3. Pull latest metrics for relevant connectors
  const currentMetrics: Record<string, Record<string, { value: number | null; data: unknown; recorded_at: string }>> = {};
  for (const connector of relevantActive) {
    const connectorMetrics = db.prepare(`
      SELECT metric_name, metric_value, metric_data, recorded_at
      FROM metrics
      WHERE business_id = ?
        AND connector_id = ?
        AND recorded_at > datetime('now', '-7 days')
      ORDER BY recorded_at DESC
    `).all(businessId, connector.id) as MetricRow[];

    currentMetrics[connector.type] = {};
    const seen = new Set<string>();
    for (const m of connectorMetrics) {
      if (!seen.has(m.metric_name)) {
        seen.add(m.metric_name);
        currentMetrics[connector.type]![m.metric_name] = {
          value: m.metric_value,
          data: safeParseJSON(m.metric_data),
          recorded_at: m.recorded_at,
        };
      }
    }
  }

  // 4. Get historical comparison (same metrics 30 days ago)
  const historicalMetrics: Record<string, Record<string, { avg: number | null; min: number | null; max: number | null }>> = {};
  for (const connector of relevantActive) {
    const historical = db.prepare(`
      SELECT metric_name,
             AVG(metric_value) AS avg_value,
             MIN(metric_value) AS min_value,
             MAX(metric_value) AS max_value
      FROM metrics
      WHERE business_id = ?
        AND connector_id = ?
        AND recorded_at BETWEEN datetime('now', '-37 days') AND datetime('now', '-7 days')
      GROUP BY metric_name
    `).all(businessId, connector.id) as HistoricalRow[];

    historicalMetrics[connector.type] = {};
    for (const m of historical) {
      historicalMetrics[connector.type]![m.metric_name] = {
        avg: m.avg_value,
        min: m.min_value,
        max: m.max_value,
      };
    }
  }

  // 5. Get triggering signal
  const signal = task.signal_id
    ? db.prepare('SELECT * FROM signals WHERE id = ?').get(task.signal_id) as Record<string, unknown> | null
    : null;

  // 6. Get in-flight actions (restraint context)
  const inFlight = db.prepare(`
    SELECT am.*, aw.measurement_notes, aw.expected_days
    FROM action_memory am
    LEFT JOIN action_windows aw ON aw.action_type = am.action_type
    WHERE am.business_id = ?
      AND am.outcome_measured = 0
      AND am.measurement_window_end > CURRENT_TIMESTAMP
  `).all(businessId) as Record<string, unknown>[];

  // 7. Get recent outcomes (what has worked / not worked)
  const recentOutcomes = db.prepare(`
    SELECT t.title, t.action_type, o.verdict,
           o.change_pct, t.target_metric AS metric_name
    FROM tasks t
    JOIN task_outcomes o ON o.task_id = t.id
    WHERE t.business_id = ?
      AND t.completed_at > datetime('now', '-90 days')
    ORDER BY t.completed_at DESC
    LIMIT 10
  `).all(businessId) as OutcomeRow[];

  // 8. Get KB context
  const kbContext = await queryKBForContext(
    (task.title ?? '') + ' ' + ((signal?.description as string | undefined) ?? ''),
    businessId
  );

  // 9. Get active goals
  const activeGoals = db.prepare(`
    SELECT title, metric_name, metric_target,
           metric_current, progress_pct, deadline
    FROM goals
    WHERE business_id = ? AND status = 'active'
  `).all(businessId) as GoalRow[];

  // 10. Get seasonal context
  const allMetricNames = Object.values(currentMetrics)
    .flatMap(c => Object.keys(c));
  const seasonalContext = await getSeasonalContext(allMetricNames, businessId);

  // 11. Business info
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Record<string, unknown> | null;

  return {
    task,
    signal,
    relevant_connectors: relevantActive.map(c => c.type),
    // All connected connector types for this business — used by the prompt
    // builder to filter the valid action types to only what's executable.
    all_connected_connectors: activeConnectors.map(c => c.type),
    current_metrics: currentMetrics,
    historical_metrics: historicalMetrics,
    in_flight_actions: inFlight,
    recent_outcomes: recentOutcomes,
    kb_context: kbContext,
    active_goals: activeGoals,
    seasonal_context: seasonalContext,
    business,
  };
}
