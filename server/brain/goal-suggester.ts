/**
 * Brain — Proactive Goal Suggestions (Feature 6).
 *
 * Scans business data for quantified opportunities the user hasn't noticed.
 * Each opportunity identifies:
 *   - a specific pattern (not "improve SEO" — "keyword X has 500 impressions but 0.8% CTR")
 *   - an estimated monetary value
 *   - a barrier
 *   - a suggested goal with metric, target, deadline, and agents
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { recordDecision } from './decision-memory.js';

const SYSTEM_PROMPT = `You turn detected business-data patterns into a concrete goal suggestion.

Return only valid JSON. No prose outside JSON.

Requirements:
- The opportunity must be quantified (a number).
- The barrier must be specific (not "things could be better").
- Confidence >= 0.7 or set to null and we'll drop the suggestion.
- The goal must be achievable and measurable.

Schema:
{
  "title": "specific headline (under 80 chars)",
  "description": "one sentence why this matters",
  "opportunity_value": <number>,
  "opportunity_unit": "gbp_per_month|usd_per_month|traffic_per_month|conversions_per_month",
  "metric_name": "namespaced.metric.name",
  "current_value": <number>,
  "target_value": <number>,
  "barrier": "the specific thing stopping this from happening",
  "suggested_deadline_days": <number>,
  "suggested_agents": ["seo-sentinel"],
  "confidence": 0.0-1.0,
  "reasoning": "why we think this will work",
  "required_effort": "low|medium|high",
  "why_it_matters": "one sentence on the business impact of acting (or not acting) on this",
  "related_risks": ["what could go wrong if we pursue this"]
}`;

function extractJSON(content: string): Record<string, unknown> | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str!.trim()); } catch { return null; }
}

/* ─── Pattern detectors (cheap, deterministic) ─────────────────────────── */

interface Pattern {
  connector: string;
  pattern: string;
  summary: string;
  page?: string;
  query?: string;
  product?: string;
  impressions?: number;
  ctr?: number;
  position?: number;
  sessions?: number;
  bounce_rate?: number;
  views?: number;
  atc?: number;
  score?: number;
  lcp_ms?: number;
  from?: number;
  to?: number;
  frequency?: number;
}

function detectGSCPatterns(businessId: string): Pattern[] {
  const patterns: Pattern[] = [];
  // Pages with high impressions and low CTR — meta opportunity
  const lowCtrHighImp = db.prepare(`
    SELECT metric_name, metric_value, metric_data, recorded_at
    FROM metrics
    WHERE business_id = ? AND metric_name = 'gsc.page_performance'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId) as { metric_data: string | null } | null;
  if (lowCtrHighImp?.metric_data) {
    try {
      const data = JSON.parse(lowCtrHighImp.metric_data) as Record<string, unknown>;
      const pages = (data.pages || data.rows || []) as Record<string, unknown>[];
      for (const p of pages.slice(0, 50)) {
        const imp = Number(p.impressions || 0);
        const ctr = Number(p.ctr || 0);
        if (imp > 500 && ctr < 0.02) {
          patterns.push({
            connector: 'gsc',
            pattern: 'low_ctr_high_impressions',
            page: (p.page || p.url) as string,
            impressions: imp, ctr,
            summary: `Page ${(p.page ?? p.url) as string} has ${imp} monthly impressions at ${(ctr * 100).toFixed(1)}% CTR — meta rewrite opportunity.`,
          });
          if (patterns.length >= 3) break;
        }
      }
    } catch {}
  }

  // Keywords in position 4-15 with good volume = ranking opportunity
  const rankingOpp = db.prepare(`
    SELECT metric_data FROM metrics
    WHERE business_id = ? AND metric_name = 'gsc.queries'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId) as { metric_data: string | null } | null;
  if (rankingOpp?.metric_data) {
    try {
      const data = JSON.parse(rankingOpp.metric_data) as Record<string, unknown>;
      const queries = (data.queries || data.rows || []) as Record<string, unknown>[];
      for (const q of queries.slice(0, 100)) {
        const pos = Number(q.position || 0);
        const imp = Number(q.impressions || 0);
        if (pos >= 4 && pos <= 15 && imp > 200) {
          patterns.push({
            connector: 'gsc',
            pattern: 'ranking_opportunity',
            query: q.query as string,
            position: pos, impressions: imp,
            summary: `Query "${q.query as string}" ranks at position ${pos.toFixed(1)} with ${imp} monthly impressions — push to top 3.`,
          });
          if (patterns.filter((p) => p.pattern === 'ranking_opportunity').length >= 3) break;
        }
      }
    } catch {}
  }
  return patterns;
}

function detectGA4Patterns(businessId: string): Pattern[] {
  const patterns: Pattern[] = [];
  const pages = db.prepare(`
    SELECT metric_data FROM metrics
    WHERE business_id = ? AND metric_name = 'ga4.page_performance'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId) as { metric_data: string | null } | null;
  if (pages?.metric_data) {
    try {
      const data = JSON.parse(pages.metric_data) as Record<string, unknown>;
      const rows = (data.pages || data.rows || []) as Record<string, unknown>[];
      for (const p of rows.slice(0, 50)) {
        const sessions = Number(p.sessions || 0);
        const bounce = Number(p.bounce_rate || 0);
        if (sessions > 300 && bounce > 0.7) {
          patterns.push({
            connector: 'ga4',
            pattern: 'high_traffic_high_bounce',
            page: (p.page || p.path) as string,
            sessions, bounce_rate: bounce,
            summary: `Page ${(p.page ?? p.path) as string} has ${sessions} sessions at ${(bounce * 100).toFixed(0)}% bounce — conversion opportunity.`,
          });
          if (patterns.length >= 2) break;
        }
      }
    } catch {}
  }
  return patterns;
}

function detectShopifyPatterns(businessId: string): Pattern[] {
  const patterns: Pattern[] = [];
  const products = db.prepare(`
    SELECT metric_data FROM metrics
    WHERE business_id = ? AND metric_name = 'shopify.products'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId) as { metric_data: string | null } | null;
  if (products?.metric_data) {
    try {
      const data = JSON.parse(products.metric_data) as Record<string, unknown>;
      const rows = (data.products || data.rows || []) as Record<string, unknown>[];
      for (const p of rows.slice(0, 40)) {
        const views = Number(p.views || 0);
        const atc = Number(p.add_to_cart_rate || 0);
        const purchases = Number(p.purchases || 0);
        if (views > 100 && atc < 0.03) {
          patterns.push({
            connector: 'shopify',
            pattern: 'high_views_low_atc',
            product: (p.title || p.handle) as string,
            views, atc,
            summary: `Product "${(p.title ?? p.handle) as string}" has ${views} views at ${(atc * 100).toFixed(1)}% add-to-cart — product page opportunity.`,
          });
          if (patterns.length >= 2) break;
        } else if (views > 150 && purchases === 0) {
          patterns.push({
            connector: 'shopify',
            pattern: 'views_without_purchases',
            product: (p.title || p.handle) as string,
            views,
            summary: `Product "${(p.title ?? p.handle) as string}" has ${views} views but 0 purchases — pricing or description problem.`,
          });
          if (patterns.length >= 2) break;
        }
      }
    } catch {}
  }
  return patterns;
}

function detectPageSpeedPatterns(businessId: string): Pattern[] {
  const patterns: Pattern[] = [];
  const latest = db.prepare(`
    SELECT metric_value, metric_data FROM metrics
    WHERE business_id = ? AND metric_name = 'pagespeed.mobile.performance_score'
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId) as { metric_value: string | number | null } | null;
  if (latest?.metric_value != null && Number(latest.metric_value) < 70) {
    patterns.push({
      connector: 'pagespeed',
      pattern: 'low_mobile_score',
      score: Number(latest.metric_value),
      summary: `Mobile PageSpeed score is ${Math.round(Number(latest.metric_value))} — below 70 correlates with ranking ceiling.`,
    });
  }
  const lcp = db.prepare(`
    SELECT metric_value FROM metrics
    WHERE business_id = ? AND metric_name = 'pagespeed.mobile.lcp_ms'
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId) as { metric_value: string | number | null } | null;
  if (lcp?.metric_value != null && Number(lcp.metric_value) > 2500) {
    patterns.push({
      connector: 'pagespeed',
      pattern: 'lcp_over_threshold',
      lcp_ms: Number(lcp.metric_value),
      summary: `Largest Contentful Paint is ${Math.round(Number(lcp.metric_value))}ms — Core Web Vitals failure affecting rankings.`,
    });
  }
  return patterns;
}

function detectMetaAdsPatterns(businessId: string): Pattern[] {
  const patterns: Pattern[] = [];
  const roasTrend = db.prepare(`
    SELECT metric_value, recorded_at FROM metrics
    WHERE business_id = ? AND metric_name = 'meta-ads.roas'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at ASC
  `).all(businessId) as Array<{ metric_value: string | number }>;
  if (roasTrend.length >= 5) {
    const first = Number(roasTrend[0]!.metric_value);
    const last = Number(roasTrend[roasTrend.length - 1]!.metric_value);
    if (first > 0 && (last - first) / first < -0.15) {
      patterns.push({
        connector: 'meta-ads',
        pattern: 'roas_declining',
        from: first, to: last,
        summary: `Meta Ads ROAS declined from ${first.toFixed(2)} to ${last.toFixed(2)} over 30 days — creative fatigue suspected.`,
      });
    }
  }
  const freq = db.prepare(`
    SELECT metric_value FROM metrics
    WHERE business_id = ? AND metric_name = 'meta-ads.frequency'
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId) as { metric_value: string | number | null } | null;
  if (freq?.metric_value != null && Number(freq.metric_value) > 3.5) {
    patterns.push({
      connector: 'meta-ads',
      pattern: 'high_frequency',
      frequency: Number(freq.metric_value),
      summary: `Meta Ads frequency is ${Number(freq.metric_value).toFixed(1)} — audience exhaustion likely.`,
    });
  }
  return patterns;
}

function detectAllPatterns(businessId: string): Pattern[] {
  return [
    ...detectGSCPatterns(businessId),
    ...detectGA4Patterns(businessId),
    ...detectShopifyPatterns(businessId),
    ...detectPageSpeedPatterns(businessId),
    ...detectMetaAdsPatterns(businessId),
  ];
}

/* ─── LLM expansion ─────────────────────────────────────────────────────── */

async function expandPatternToSuggestion(
  businessId: string,
  business: Record<string, unknown> | null,
  pattern: Pattern
): Promise<Record<string, unknown> | null> {
  const user = `Business: ${(business?.name as string) ?? 'unknown'} (${(business?.type as string) ?? 'general'})
Detected pattern: ${pattern.summary}

Pattern details: ${JSON.stringify(pattern)}

Produce a goal suggestion per the JSON schema. Estimate opportunity value conservatively.`;

  const { providerId, model } = resolveProfileLLM({}, { tier: 'triage' });

  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2, max_tokens: 900,
    });
    const parsed = extractJSON((result as { content: string } | null)?.content ?? '');
    if (!parsed) return null;
    if (((parsed.confidence as number | null) ?? 0) < 0.7) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ─── Main entry point ─────────────────────────────────────────────────── */

export async function scanForGoalSuggestions(
  businessId: string,
  { limit = 5 }: { limit?: number } = {}
): Promise<Record<string, unknown>[]> {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Record<string, unknown> | null;
  if (!business) throw new Error('Business not found');

  const patterns = detectAllPatterns(businessId);
  if (patterns.length === 0) return [];

  // Avoid duplicates — don't suggest the same pattern twice within 30 days
  const createdRecent = (db.prepare(`
    SELECT evidence FROM goal_suggestions
    WHERE business_id = ? AND status IN ('pending', 'snoozed')
      AND created_at > datetime('now', '-30 days')
  `).all(businessId) as Array<{ evidence: string | null }>).map((r) => { try { return JSON.parse(r.evidence || '{}') as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } });

  const seen = new Set(createdRecent.map((e) => `${e.connector}:${e.pattern}:${e.page || e.query || e.product || ''}`));

  const suggestions: Record<string, unknown>[] = [];
  for (const pattern of patterns) {
    if (suggestions.length >= limit) break;
    const key = `${pattern.connector}:${pattern.pattern}:${pattern.page || pattern.query || pattern.product || ''}`;
    if (seen.has(key)) continue;

    const expanded = await expandPatternToSuggestion(businessId, business, pattern);
    if (!expanded) continue;

    const id = crypto.randomUUID();
    const deadline = expanded.suggested_deadline_days
      ? new Date(Date.now() + (expanded.suggested_deadline_days as number) * 86400000).toISOString()
      : null;

    // related_goal_ids is computed deterministically (same metric_name on
    // an active goal), not asked of the LLM — it cannot know real goal
    // IDs, so having it invent them would be worse than not having the
    // field at all.
    const relatedGoalIds = expanded.metric_name
      ? (db.prepare("SELECT id FROM goals WHERE business_id = ? AND metric_name = ? AND status = 'active'").all(businessId, expanded.metric_name as string) as Array<{ id: string }>).map((g) => g.id)
      : [];

    const insertParams: any[] = [
      id, businessId,
      expanded.title as string, expanded.description as string,
      (expanded.opportunity_value as number | null) ?? null, (expanded.opportunity_unit as string | null) ?? 'gbp_per_month',
      (expanded.metric_name as string | null) ?? null,
      (expanded.current_value as number | null) ?? null, (expanded.target_value as number | null) ?? null,
      (expanded.barrier as string | null) ?? null,
      deadline,
      JSON.stringify((expanded.suggested_agents as string[] | null) ?? []),
      (expanded.confidence as number | null) ?? null,
      pattern.connector,
      JSON.stringify({ ...pattern, reasoning: expanded.reasoning }),
      (expanded.required_effort as string | null) ?? null,
      JSON.stringify(relatedGoalIds),
      JSON.stringify((expanded.related_risks as string[] | null) ?? []),
      (expanded.why_it_matters as string | null) ?? null,
    ];
    db.prepare(`
      INSERT INTO goal_suggestions
      (id, business_id, title, description, opportunity_value, opportunity_unit,
       metric_name, current_value, target_value, barrier, suggested_deadline,
       suggested_agents, confidence, connector_source, evidence,
       required_effort, related_goal_ids, related_risks, why_it_matters, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(...insertParams);
    suggestions.push({ id, ...expanded, connector_source: pattern.connector, related_goal_ids: relatedGoalIds });
  }

  return suggestions;
}

export function listGoalSuggestions(businessId: string, status = 'pending'): Record<string, unknown>[] {
  const clauses = ['business_id = ?'];
  const params: any[] = [businessId];
  if (status === 'active') {
    clauses.push("status IN ('pending','snoozed')");
    clauses.push("(snoozed_until IS NULL OR snoozed_until <= CURRENT_TIMESTAMP)");
  } else if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  return (db.prepare(`
    SELECT * FROM goal_suggestions
    WHERE ${clauses.join(' AND ')}
    ORDER BY opportunity_value DESC NULLS LAST, created_at DESC LIMIT 50
  `).all(...params) as Record<string, unknown>[]).map(parseRow).filter(Boolean) as Record<string, unknown>[];
}

function parseRow(r: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!r) return null;
  let agents: string[] = []; let evidence: Record<string, unknown> = {};
  let relatedGoalIds: string[] = []; let relatedRisks: string[] = [];
  try { agents = JSON.parse((r.suggested_agents as string) || '[]'); } catch {}
  try { evidence = r.evidence ? JSON.parse(r.evidence as string) as Record<string, unknown> : {}; } catch {}
  try { relatedGoalIds = JSON.parse((r.related_goal_ids as string) || '[]'); } catch {}
  try { relatedRisks = JSON.parse((r.related_risks as string) || '[]'); } catch {}
  return { ...r, suggested_agents: agents, evidence, related_goal_ids: relatedGoalIds, related_risks: relatedRisks };
}

export function snoozeSuggestion(id: string, days = 30): void {
  const until = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare(`
    UPDATE goal_suggestions
    SET status = 'snoozed', snoozed_until = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(until, id);
}

export function dismissSuggestion(id: string, reason?: string | null, actor = 'human'): void {
  const before = db.prepare('SELECT * FROM goal_suggestions WHERE id = ?').get(id) as Record<string, unknown> | null;
  db.prepare(`
    UPDATE goal_suggestions
    SET status = 'dismissed', dismissed_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason ?? null, id);
  if (before) {
    recordDecision({
      business_id: before.business_id as string, decision_type: 'opportunity_dismissed',
      title: `Dismissed opportunity: ${before.title}`,
      decision: `Dismissed opportunity "${before.title}".${reason ? ` ${reason}` : ''}`,
      reasoning: reason ?? null, confidence: (before.confidence as number | null) ?? null,
      author: actor,
    });
  }
}

/**
 * Accept a suggestion — creates the underlying goal, runs the reasoner,
 * and returns the created goal plus its reasoning.
 */
export async function acceptSuggestion(id: string, businessId: string): Promise<{ goal_id: string }> {
  const sugg = db.prepare('SELECT * FROM goal_suggestions WHERE id = ? AND business_id = ?').get(id, businessId) as Record<string, unknown> | null;
  if (!sugg) throw new Error('Suggestion not found');

  let agents: string[] = [];
  try { agents = JSON.parse((sugg.suggested_agents as string) || '[]'); } catch {}

  const goalId = crypto.randomUUID();
  const goalParams: any[] = [
    goalId, businessId,
    sugg.title as string, sugg.description as string | null, sugg.suggested_deadline as string | null,
    sugg.metric_name as string | null,
    sugg.current_value as number | null, sugg.target_value as number | null, sugg.current_value as number | null,
    null,
    JSON.stringify(agents),
    JSON.stringify(['suggested', sugg.connector_source].filter(Boolean)),
  ];
  db.prepare(`
    INSERT INTO goals
    (id, business_id, title, description, deadline, metric_name,
     metric_baseline, metric_target, metric_current, metric_unit,
     assigned_agents, created_by, tags, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brain', ?, 'active')
  `).run(...goalParams);

  db.prepare(`
    UPDATE goal_suggestions
    SET status = 'accepted', accepted_goal_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(goalId, id);

  recordDecision({
    business_id: businessId, decision_type: 'opportunity_accepted',
    title: `Accepted opportunity: ${sugg.title as string}`,
    decision: `Accepted opportunity "${sugg.title as string}" and created goal "${sugg.title as string}".`,
    reasoning: (sugg.barrier as string | null) ?? null,
    evidence: [sugg.evidence ?? null].filter(Boolean),
    confidence: (sugg.confidence as number | null) ?? null,
    author: 'human', related_goal_id: goalId,
  });

  // Fire-and-forget reasoning + conflict check on the new goal
  (async () => {
    try {
      const { runGoalReasoning } = await import('./goal-reasoner.js') as unknown as { runGoalReasoning: (goalId: string, businessId: string) => Promise<unknown> };
      await runGoalReasoning(goalId, businessId);
    } catch (err) {
      console.warn('[goal-suggester] reasoning failed:', (err as Error).message);
    }
  })();
  (async () => {
    try {
      const { checkGoalConflicts } = await import('./conflict-engine.js') as unknown as { checkGoalConflicts: (goalId: string, businessId: string) => Promise<unknown> };
      await checkGoalConflicts(goalId, businessId);
    } catch {}
  })();

  return { goal_id: goalId };
}
