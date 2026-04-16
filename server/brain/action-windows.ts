/**
 * Brain — Action Windows knowledge base.
 *
 * Defines how long each type of action takes to produce measurable
 * results. Used by:
 *   - restraint.js  (block re-action before window closes)
 *   - causal.js     (assess whether a metric change matches an action)
 *   - agent-runner  (inject temporal context into agent prompts)
 *   - conductor     (temporal health summary)
 */
import crypto from 'crypto';
import db from '../db/db.js';

interface ActionWindow {
  action_type: string;
  display_name: string;
  min_days: number;
  expected_days: number;
  max_days: number;
  metric_types: string[];
  measurement_notes: string;
  volatility: string;
}

export const ACTION_WINDOWS: ActionWindow[] = [
  {
    action_type: 'meta_update',
    display_name: 'Meta title/description change',
    min_days: 7,
    expected_days: 21,
    max_days: 42,
    metric_types: ['gsc.avg_ctr', 'gsc.total_clicks', 'ga4.sessions'],
    measurement_notes: 'Google recrawls pages on its own schedule. CTR changes visible in GSC after recrawl and sufficient impression volume. Allow 3 weeks minimum, 6 weeks for low-traffic pages.',
    volatility: 'medium',
  },
  {
    action_type: 'shopify_description_update',
    display_name: 'Product description rewrite',
    min_days: 7,
    expected_days: 14,
    max_days: 28,
    metric_types: ['shopify.conversion_rate', 'ga4.bounce_rate', 'ga4.sessions'],
    measurement_notes: 'Conversion rate changes visible within 1-2 weeks with sufficient traffic. Requires minimum ~100 sessions to the page for statistical significance.',
    volatility: 'high',
  },
  {
    action_type: 'shopify_page_create',
    display_name: 'New landing page',
    min_days: 21,
    expected_days: 56,
    max_days: 112,
    metric_types: ['gsc.total_clicks', 'gsc.impressions', 'ga4.sessions'],
    measurement_notes: 'New pages take time to be discovered, crawled, indexed, and ranked. Expect 4-8 weeks before meaningful ranking signals, up to 16 weeks for competitive keywords.',
    volatility: 'low',
  },
  {
    action_type: 'github_pr',
    display_name: 'Code change / deployment',
    min_days: 0,
    expected_days: 3,
    max_days: 14,
    metric_types: ['pagespeed.mobile.performance_score', 'pagespeed.mobile.lcp_ms', 'ga4.bounce_rate', 'ga4.sessions'],
    measurement_notes: 'Code changes affect PageSpeed immediately. User behaviour metrics (bounce rate, sessions) need 1-2 weeks of data to show statistically significant change.',
    volatility: 'low',
  },
  {
    action_type: 'content_draft',
    display_name: 'New content / blog post',
    min_days: 28,
    expected_days: 56,
    max_days: 120,
    metric_types: ['gsc.total_clicks', 'gsc.impressions', 'ga4.sessions'],
    measurement_notes: 'Content SEO is slow. New posts typically take 3-6 months to reach peak rankings. Do not evaluate content performance before 4 weeks, and ideally measure at 3 months.',
    volatility: 'low',
  },
  {
    action_type: 'meta-ads-change',
    display_name: 'Meta Ads campaign change',
    min_days: 3,
    expected_days: 7,
    max_days: 21,
    metric_types: ['meta-ads.roas', 'meta-ads.ctr', 'meta-ads.cpm', 'meta-ads.cpc'],
    measurement_notes: 'Meta algorithm needs a learning period (typically 50 conversions or 7 days). Do not evaluate or change ads during the learning phase — it resets progress.',
    volatility: 'high',
  },
  {
    action_type: 'shopify_meta_update',
    display_name: 'Shopify SEO title/description',
    min_days: 7,
    expected_days: 21,
    max_days: 42,
    metric_types: ['gsc.avg_ctr', 'gsc.total_clicks'],
    measurement_notes: 'Same as meta_update — depends on Googlebot recrawl schedule.',
    volatility: 'medium',
  },
  {
    action_type: 'shopify_collection_update',
    display_name: 'Collection page update',
    min_days: 14,
    expected_days: 28,
    max_days: 56,
    metric_types: ['gsc.total_clicks', 'shopify.revenue', 'shopify.conversion_rate'],
    measurement_notes: 'Collection pages have SEO and UX components. SEO takes weeks, conversion rate impact visible sooner with sufficient traffic.',
    volatility: 'medium',
  },
  {
    action_type: 'gbp_post',
    display_name: 'Google Business Profile post',
    min_days: 1,
    expected_days: 7,
    max_days: 28,
    metric_types: ['gbp.views_total', 'gbp.actions_website', 'gbp.actions_phone'],
    measurement_notes: 'GBP posts have immediate but short-lived visibility. Views peak in first week. Measure within 7-14 days.',
    volatility: 'high',
  },
  {
    action_type: 'shopify_theme_edit',
    display_name: 'Shopify theme file edit',
    min_days: 0,
    expected_days: 7,
    max_days: 21,
    metric_types: ['shopify.conversion_rate', 'ga4.bounce_rate', 'ga4.sessions', 'pagespeed.mobile.performance_score'],
    measurement_notes: 'Theme changes take effect immediately. Conversion and UX metric changes need 7-14 days of traffic for statistical significance.',
    volatility: 'medium',
  },
];

/**
 * Seed action_windows table. Idempotent — only inserts missing rows.
 */
export function seedActionWindows(): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO action_windows
    (id, action_type, display_name, min_days, expected_days, max_days,
     metric_types, measurement_notes, volatility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const w of ACTION_WINDOWS) {
    const existing = db.prepare('SELECT id FROM action_windows WHERE action_type = ?').get(w.action_type);
    if (existing) continue;
    insert.run(
      crypto.randomUUID(), w.action_type, w.display_name,
      w.min_days, w.expected_days, w.max_days,
      JSON.stringify(w.metric_types), w.measurement_notes, w.volatility
    );
    inserted++;
  }
  if (inserted > 0) console.log(`[brain] Seeded ${inserted} action windows.`);
  return inserted;
}

/**
 * Record action memory when a task reaches 'complete' status.
 */
export function recordActionMemory(task: Record<string, unknown>): string | null {
  if (!task?.action_type) return null;
  const window = db.prepare(
    'SELECT * FROM action_windows WHERE action_type = ?'
  ).get(task.action_type as string) as Record<string, unknown> | null;
  if (!window) return null;

  // Don't double-record
  const existing = db.prepare(
    'SELECT id FROM action_memory WHERE task_id = ?'
  ).get(task.id as string) as { id: string } | null;
  if (existing) return existing.id;

  const windowStart = new Date((task.completed_at as string | number) || Date.now());
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + (window.expected_days as number));

  const doNotTouchUntil = new Date(windowStart);
  doNotTouchUntil.setDate(doNotTouchUntil.getDate() + (window.min_days as number));

  let payload: Record<string, unknown> = {};
  try { payload = typeof task.action_payload === 'string' ? JSON.parse(task.action_payload) : ((task.action_payload as Record<string, unknown>) ?? {}); } catch {}

  const id = crypto.randomUUID();
  const params: any[] = [
    id, task.business_id as string, task.id as string,
    task.action_type as string, task.title as string, (task.description as string | null) ?? null,
    (payload.url as string | null) ?? null, (payload.entity as string | null) ?? null,
    window.metric_types as string,
    windowStart.toISOString(), windowEnd.toISOString(), doNotTouchUntil.toISOString(),
  ];
  db.prepare(`
    INSERT INTO action_memory
    (id, business_id, task_id, action_type, title, description,
     target_url, target_entity, metrics_expected,
     measurement_window_start, measurement_window_end, do_not_touch_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...params);

  return id;
}

/**
 * Mark measurement_ready on action_memory rows whose window has closed.
 * Called by the scheduler daily.
 */
export function markMeasurementReady(): number {
  const result = db.prepare(`
    UPDATE action_memory
    SET measurement_ready = 1
    WHERE measurement_ready = 0
      AND measurement_window_end <= CURRENT_TIMESTAMP
  `).run();
  return result.changes;
}
