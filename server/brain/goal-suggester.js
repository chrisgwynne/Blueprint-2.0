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
  "reasoning": "why we think this will work"
}`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

/* ─── Pattern detectors (cheap, deterministic) ─────────────────────────── */

function detectGSCPatterns(businessId) {
  const patterns = [];
  // Pages with high impressions and low CTR — meta opportunity
  const lowCtrHighImp = db.prepare(`
    SELECT metric_name, metric_value, metric_data, recorded_at
    FROM metrics
    WHERE business_id = ? AND metric_name = 'gsc.page_performance'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId);
  if (lowCtrHighImp?.metric_data) {
    try {
      const data = JSON.parse(lowCtrHighImp.metric_data);
      const pages = data.pages || data.rows || [];
      for (const p of pages.slice(0, 50)) {
        const imp = Number(p.impressions || 0);
        const ctr = Number(p.ctr || 0);
        if (imp > 500 && ctr < 0.02) {
          patterns.push({
            connector: 'gsc',
            pattern: 'low_ctr_high_impressions',
            page: p.page || p.url,
            impressions: imp, ctr,
            summary: `Page ${p.page ?? p.url} has ${imp} monthly impressions at ${(ctr * 100).toFixed(1)}% CTR — meta rewrite opportunity.`,
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
  `).get(businessId);
  if (rankingOpp?.metric_data) {
    try {
      const data = JSON.parse(rankingOpp.metric_data);
      const queries = data.queries || data.rows || [];
      for (const q of queries.slice(0, 100)) {
        const pos = Number(q.position || 0);
        const imp = Number(q.impressions || 0);
        if (pos >= 4 && pos <= 15 && imp > 200) {
          patterns.push({
            connector: 'gsc',
            pattern: 'ranking_opportunity',
            query: q.query,
            position: pos, impressions: imp,
            summary: `Query "${q.query}" ranks at position ${pos.toFixed(1)} with ${imp} monthly impressions — push to top 3.`,
          });
          if (patterns.filter((p) => p.pattern === 'ranking_opportunity').length >= 3) break;
        }
      }
    } catch {}
  }
  return patterns;
}

function detectGA4Patterns(businessId) {
  const patterns = [];
  const pages = db.prepare(`
    SELECT metric_data FROM metrics
    WHERE business_id = ? AND metric_name = 'ga4.page_performance'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId);
  if (pages?.metric_data) {
    try {
      const data = JSON.parse(pages.metric_data);
      const rows = data.pages || data.rows || [];
      for (const p of rows.slice(0, 50)) {
        const sessions = Number(p.sessions || 0);
        const bounce = Number(p.bounce_rate || 0);
        if (sessions > 300 && bounce > 0.7) {
          patterns.push({
            connector: 'ga4',
            pattern: 'high_traffic_high_bounce',
            page: p.page || p.path,
            sessions, bounce_rate: bounce,
            summary: `Page ${p.page ?? p.path} has ${sessions} sessions at ${(bounce * 100).toFixed(0)}% bounce — conversion opportunity.`,
          });
          if (patterns.length >= 2) break;
        }
      }
    } catch {}
  }
  return patterns;
}

function detectShopifyPatterns(businessId) {
  const patterns = [];
  const products = db.prepare(`
    SELECT metric_data FROM metrics
    WHERE business_id = ? AND metric_name = 'shopify.products'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId);
  if (products?.metric_data) {
    try {
      const data = JSON.parse(products.metric_data);
      const rows = data.products || data.rows || [];
      for (const p of rows.slice(0, 40)) {
        const views = Number(p.views || 0);
        const atc = Number(p.add_to_cart_rate || 0);
        const purchases = Number(p.purchases || 0);
        if (views > 100 && atc < 0.03) {
          patterns.push({
            connector: 'shopify',
            pattern: 'high_views_low_atc',
            product: p.title || p.handle,
            views, atc,
            summary: `Product "${p.title ?? p.handle}" has ${views} views at ${(atc * 100).toFixed(1)}% add-to-cart — product page opportunity.`,
          });
          if (patterns.length >= 2) break;
        } else if (views > 150 && purchases === 0) {
          patterns.push({
            connector: 'shopify',
            pattern: 'views_without_purchases',
            product: p.title || p.handle,
            views,
            summary: `Product "${p.title ?? p.handle}" has ${views} views but 0 purchases — pricing or description problem.`,
          });
          if (patterns.length >= 2) break;
        }
      }
    } catch {}
  }
  return patterns;
}

function detectPageSpeedPatterns(businessId) {
  const patterns = [];
  const latest = db.prepare(`
    SELECT metric_value, metric_data FROM metrics
    WHERE business_id = ? AND metric_name = 'pagespeed.mobile.performance_score'
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId);
  if (latest?.metric_value != null && Number(latest.metric_value) < 70) {
    patterns.push({
      connector: 'pagespeed',
      pattern: 'low_mobile_score',
      score: Number(latest.metric_value),
      summary: `Mobile PageSpeed score is ${Math.round(latest.metric_value)} — below 70 correlates with ranking ceiling.`,
    });
  }
  const lcp = db.prepare(`
    SELECT metric_value FROM metrics
    WHERE business_id = ? AND metric_name = 'pagespeed.mobile.lcp_ms'
    ORDER BY recorded_at DESC LIMIT 1
  `).get(businessId);
  if (lcp?.metric_value != null && Number(lcp.metric_value) > 2500) {
    patterns.push({
      connector: 'pagespeed',
      pattern: 'lcp_over_threshold',
      lcp_ms: Number(lcp.metric_value),
      summary: `Largest Contentful Paint is ${Math.round(lcp.metric_value)}ms — Core Web Vitals failure affecting rankings.`,
    });
  }
  return patterns;
}

function detectMetaAdsPatterns(businessId) {
  const patterns = [];
  const roasTrend = db.prepare(`
    SELECT metric_value, recorded_at FROM metrics
    WHERE business_id = ? AND metric_name = 'meta-ads.roas'
      AND recorded_at > datetime('now', '-30 days')
    ORDER BY recorded_at ASC
  `).all(businessId);
  if (roasTrend.length >= 5) {
    const first = Number(roasTrend[0].metric_value);
    const last = Number(roasTrend[roasTrend.length - 1].metric_value);
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
  `).get(businessId);
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

function detectAllPatterns(businessId) {
  return [
    ...detectGSCPatterns(businessId),
    ...detectGA4Patterns(businessId),
    ...detectShopifyPatterns(businessId),
    ...detectPageSpeedPatterns(businessId),
    ...detectMetaAdsPatterns(businessId),
  ];
}

/* ─── LLM expansion ─────────────────────────────────────────────────────── */

async function expandPatternToSuggestion(businessId, business, pattern) {
  const user = `Business: ${business?.name ?? 'unknown'} (${business?.type ?? 'general'})
Detected pattern: ${pattern.summary}

Pattern details: ${JSON.stringify(pattern)}

Produce a goal suggestion per the JSON schema. Estimate opportunity value conservatively.`;

  const { providerId, model } = resolveProfileLLM({
    model: 'claude-haiku-4-5-20251001',
  });

  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2, max_tokens: 900,
    });
    const parsed = extractJSON(result?.content ?? '');
    if (!parsed) return null;
    if ((parsed.confidence ?? 0) < 0.7) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ─── Main entry point ─────────────────────────────────────────────────── */

export async function scanForGoalSuggestions(businessId, { limit = 5 } = {}) {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) throw new Error('Business not found');

  const patterns = detectAllPatterns(businessId);
  if (patterns.length === 0) return [];

  // Avoid duplicates — don't suggest the same pattern twice within 30 days
  const createdRecent = db.prepare(`
    SELECT evidence FROM goal_suggestions
    WHERE business_id = ? AND status IN ('pending', 'snoozed')
      AND created_at > datetime('now', '-30 days')
  `).all(businessId).map((r) => { try { return JSON.parse(r.evidence || '{}'); } catch { return {}; } });

  const seen = new Set(createdRecent.map((e) => `${e.connector}:${e.pattern}:${e.page || e.query || e.product || ''}`));

  const suggestions = [];
  for (const pattern of patterns) {
    if (suggestions.length >= limit) break;
    const key = `${pattern.connector}:${pattern.pattern}:${pattern.page || pattern.query || pattern.product || ''}`;
    if (seen.has(key)) continue;

    const expanded = await expandPatternToSuggestion(businessId, business, pattern);
    if (!expanded) continue;

    const id = crypto.randomUUID();
    const deadline = expanded.suggested_deadline_days
      ? new Date(Date.now() + expanded.suggested_deadline_days * 86400000).toISOString()
      : null;

    db.prepare(`
      INSERT INTO goal_suggestions
      (id, business_id, title, description, opportunity_value, opportunity_unit,
       metric_name, current_value, target_value, barrier, suggested_deadline,
       suggested_agents, confidence, connector_source, evidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      id, businessId,
      expanded.title, expanded.description,
      expanded.opportunity_value ?? null, expanded.opportunity_unit ?? 'gbp_per_month',
      expanded.metric_name ?? null,
      expanded.current_value ?? null, expanded.target_value ?? null,
      expanded.barrier ?? null,
      deadline,
      JSON.stringify(expanded.suggested_agents ?? []),
      expanded.confidence ?? null,
      pattern.connector,
      JSON.stringify({ ...pattern, reasoning: expanded.reasoning })
    );
    suggestions.push({ id, ...expanded, connector_source: pattern.connector });
  }

  return suggestions;
}

export function listGoalSuggestions(businessId, status = 'pending') {
  const clauses = ['business_id = ?'];
  const params = [businessId];
  if (status === 'active') {
    clauses.push("status IN ('pending','snoozed')");
    clauses.push("(snoozed_until IS NULL OR snoozed_until <= CURRENT_TIMESTAMP)");
  } else if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  return db.prepare(`
    SELECT * FROM goal_suggestions
    WHERE ${clauses.join(' AND ')}
    ORDER BY opportunity_value DESC NULLS LAST, created_at DESC LIMIT 50
  `).all(...params).map(parseRow);
}

function parseRow(r) {
  if (!r) return null;
  let agents = []; let evidence = {};
  try { agents = JSON.parse(r.suggested_agents || '[]'); } catch {}
  try { evidence = r.evidence ? JSON.parse(r.evidence) : {}; } catch {}
  return { ...r, suggested_agents: agents, evidence };
}

export function snoozeSuggestion(id, days = 30) {
  const until = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare(`
    UPDATE goal_suggestions
    SET status = 'snoozed', snoozed_until = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(until, id);
}

export function dismissSuggestion(id, reason) {
  db.prepare(`
    UPDATE goal_suggestions
    SET status = 'dismissed', dismissed_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason ?? null, id);
}

/**
 * Accept a suggestion — creates the underlying goal, runs the reasoner,
 * and returns the created goal plus its reasoning.
 */
export async function acceptSuggestion(id, businessId) {
  const sugg = db.prepare('SELECT * FROM goal_suggestions WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!sugg) throw new Error('Suggestion not found');

  let agents = [];
  try { agents = JSON.parse(sugg.suggested_agents || '[]'); } catch {}

  const goalId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO goals
    (id, business_id, title, description, deadline, metric_name,
     metric_baseline, metric_target, metric_current, metric_unit,
     assigned_agents, created_by, tags, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brain', ?, 'active')
  `).run(
    goalId, businessId,
    sugg.title, sugg.description, sugg.suggested_deadline,
    sugg.metric_name,
    sugg.current_value, sugg.target_value, sugg.current_value,
    null,
    JSON.stringify(agents),
    JSON.stringify(['suggested', sugg.connector_source].filter(Boolean))
  );

  db.prepare(`
    UPDATE goal_suggestions
    SET status = 'accepted', accepted_goal_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(goalId, id);

  // Fire-and-forget reasoning + conflict check on the new goal
  (async () => {
    try {
      const { runGoalReasoning } = await import('./goal-reasoner.js');
      await runGoalReasoning(goalId, businessId);
    } catch (err) {
      console.warn('[goal-suggester] reasoning failed:', err.message);
    }
  })();
  (async () => {
    try {
      const { checkGoalConflicts } = await import('./conflict-engine.js');
      await checkGoalConflicts(goalId, businessId);
    } catch {}
  })();

  return { goal_id: goalId };
}
