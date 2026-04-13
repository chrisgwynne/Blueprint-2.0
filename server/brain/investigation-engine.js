/**
 * Brain — Investigation Engine (Feature 9).
 *
 * "Why is this happening?" — runs a deep causal investigation on a metric
 * or signal and returns a 150-200 word plain-English explanation with
 * evidence, alternative causes, recommendation, and a confidence score.
 *
 * Results are cached for 6 hours per (business, metric/signal).
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { isWithinSeasonalVariation } from './seasonality.js';

const CACHE_HOURS = 6;

const SYSTEM_PROMPT = `You are Blueprint's investigator. A business owner wants to know why a metric
changed. Produce a clear, honest explanation in plain English.

Rules:
- Write 150-200 words in plain_english. No jargon. No bullet lists. No "metric".
  Write like you're explaining it to a friend running the business.
- Be specific. Reference real numbers from the evidence.
- Quantify uncertainty. If evidence is thin, say so.
- Give ONE clear recommendation.

Return only valid JSON. No prose outside JSON.

Schema:
{
  "primary_cause": "the single most likely explanation",
  "primary_confidence": 0.0-1.0,
  "supporting_evidence": ["specific data point that supports primary cause", ...],
  "alternative_causes": [
    { "cause": "name", "confidence": 0.0-1.0, "why_lower": "why we think this is less likely" }
  ],
  "what_rules_out": ["what evidence rules out other causes"],
  "seasonal_factor_pct": <number 0-100 — how much of the change is plausibly seasonal>,
  "recommendation": "act_now|wait|monitor|investigate",
  "recommended_action": "what to do specifically, or null",
  "plain_english": "150-200 words explaining it to a non-technical business owner",
  "confidence_note": "one sentence acknowledging the limits of the analysis"
}`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

/* ─── Data assembly ─────────────────────────────────────────────────────── */

function gatherTimeline(businessId, metricName) {
  if (!metricName) return { points: [], change_point: null };
  const points = db.prepare(`
    SELECT metric_value AS v, recorded_at AS t FROM metrics
    WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
      AND recorded_at > datetime('now', '-90 days')
    ORDER BY recorded_at ASC
  `).all(businessId, metricName);

  // Naive change-point: largest delta between consecutive 7-day averages
  let changePoint = null;
  if (points.length >= 14) {
    let best = 0;
    for (let i = 7; i < points.length - 7; i++) {
      const before = points.slice(i - 7, i).reduce((s, p) => s + Number(p.v), 0) / 7;
      const after = points.slice(i, i + 7).reduce((s, p) => s + Number(p.v), 0) / 7;
      const delta = Math.abs(before - after);
      if (delta > best) {
        best = delta;
        changePoint = { at: points[i].t, before_avg: before, after_avg: after, delta };
      }
    }
  }
  return { points, change_point: changePoint };
}

function gatherActionCorrelation(businessId, metricName) {
  if (!metricName) return [];
  return db.prepare(`
    SELECT am.*, aw.expected_days, aw.min_days, aw.display_name
    FROM action_memory am
    JOIN action_windows aw ON aw.action_type = am.action_type
    WHERE am.business_id = ?
      AND am.measurement_window_start > datetime('now', '-120 days')
      AND EXISTS (SELECT 1 FROM json_each(am.metrics_expected) me WHERE me.value = ?)
    ORDER BY am.measurement_window_start DESC LIMIT 10
  `).all(businessId, metricName);
}

function gatherMetricCorrelation(businessId, metricName) {
  if (!metricName) return [];
  const startOfWindow = new Date(Date.now() - 14 * 86400000).toISOString();
  return db.prepare(`
    SELECT metric_name,
           AVG(CASE WHEN recorded_at > datetime('now', '-7 days') THEN metric_value END) AS recent_avg,
           AVG(CASE WHEN recorded_at BETWEEN ? AND datetime('now', '-7 days') THEN metric_value END) AS prior_avg
    FROM metrics
    WHERE business_id = ? AND metric_name != ? AND metric_value IS NOT NULL
      AND recorded_at > ?
    GROUP BY metric_name
    HAVING prior_avg IS NOT NULL AND recent_avg IS NOT NULL
  `).all(startOfWindow, businessId, metricName, startOfWindow).filter((r) => {
    if (!r.prior_avg || r.prior_avg === 0) return false;
    const diff = Math.abs((r.recent_avg - r.prior_avg) / r.prior_avg);
    return diff > 0.05;
  }).slice(0, 12);
}

async function gatherExternalContext(businessId, metricName) {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(businessId);
    if (!result?.engine) return [];
    const signals = await result.engine.listFiles('signals').catch(() => []);
    const picks = [];
    for (const f of signals.slice(-12)) {
      try {
        const parsed = await result.engine.readFile(f);
        picks.push({
          path: f,
          title: parsed.frontmatter?.title ?? f,
          excerpt: (parsed.content || '').slice(0, 220).replace(/\n+/g, ' ').trim(),
        });
      } catch {}
    }
    return picks;
  } catch { return []; }
}

function gatherSeasonalCheck(businessId, metricName, pointsTimeline) {
  if (!metricName || pointsTimeline.length < 2) return null;
  try {
    const latest = Number(pointsTimeline[pointsTimeline.length - 1].v);
    const earliest = Number(pointsTimeline[0].v);
    if (!earliest) return null;
    const changePct = ((latest - earliest) / Math.abs(earliest)) * 100;
    const within = isWithinSeasonalVariation(metricName, changePct, businessId);
    return { within_seasonal: !!within, change_pct: changePct };
  } catch { return null; }
}

function gatherHistoricalPrecedent(businessId, metricName) {
  // Look for outcome records that mention this metric's improvement/decline in reports
  if (!metricName) return [];
  return db.prepare(`
    SELECT o.verdict, o.change_pct, o.check_date, t.title
    FROM task_outcomes o JOIN tasks t ON t.id = o.task_id
    WHERE t.business_id = ? AND t.target_metric = ?
    ORDER BY o.check_date DESC LIMIT 5
  `).all(businessId, metricName);
}

/* ─── Entry point ──────────────────────────────────────────────────────── */

/**
 * Run an investigation.
 * @param {{ businessId, metricName?, signalId?, question?, triggeredBy? }} params
 */
export async function runInvestigation({ businessId, metricName = null, signalId = null, question = null, triggeredBy = 'human' }) {
  if (!businessId) throw new Error('businessId required');

  // Cache check
  const cached = findCached(businessId, metricName, signalId);
  if (cached) {
    return { ...cached, from_cache: true };
  }

  // Pull metric name from signal if not given
  let signal = null;
  if (signalId) {
    signal = db.prepare('SELECT * FROM signals WHERE id = ? AND business_id = ?').get(signalId, businessId);
    if (signal?.data) {
      try {
        const data = JSON.parse(signal.data);
        if (!metricName) metricName = data.metric_name ?? data.metric ?? null;
      } catch {}
    }
  }

  const timeline = gatherTimeline(businessId, metricName);
  const actionCorr = gatherActionCorrelation(businessId, metricName);
  const metricCorr = gatherMetricCorrelation(businessId, metricName);
  const seasonal = gatherSeasonalCheck(businessId, metricName, timeline.points);
  const external = await gatherExternalContext(businessId, metricName);
  const historical = gatherHistoricalPrecedent(businessId, metricName);

  const prompt = buildPrompt({
    businessId, metricName, signal, question,
    timeline, actionCorr, metricCorr, seasonal, external, historical,
  });

  const { providerId, model } = resolveProfileLLM({
    provider: 'anthropic', model: 'claude-sonnet-4-20250514',
  });

  let rawContent = '';
  let parsed = null;
  const startedAt = new Date().toISOString();
  const { recordAgentActivity } = await import('../agents/activity.js');
  let result = null;
  try {
    result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, max_tokens: 2000,
    });
    rawContent = result?.content ?? '';
    parsed = extractJSON(rawContent);
  } catch (err) {
    console.warn('[investigation] LLM failed:', err.message);
    recordAgentActivity({
      agentId: 'conductor', businessId, trigger: 'investigation',
      status: 'failed', reasoning: `Investigation failed: ${err.message.slice(0, 160)}`,
      error: err.message.slice(0, 500), startedAt,
    });
    throw new Error(`LLM call failed (${providerId}/${model}): ${err.message}`);
  }
  recordAgentActivity({
    agentId: 'conductor', businessId, trigger: 'investigation',
    status: 'complete', reasoning: `Investigation: ${metricName || signalId || (question ?? '').slice(0, 80)}`,
    usage: result?.usage, cost_usd: result?.cost_usd, startedAt,
  });

  if (!parsed) {
    const preview = rawContent
      ? ` Response preview: ${rawContent.slice(0, 160)}`
      : ' The provider returned an empty response — check that your LLM provider credentials are configured in Settings.';
    throw new Error(`LLM response could not be parsed into an investigation.${preview}`);
  }

  const id = crypto.randomUUID();
  const cacheUntil = new Date(Date.now() + CACHE_HOURS * 3600000).toISOString();

  db.prepare(`
    INSERT INTO investigations
    (id, business_id, metric_name, signal_id, question, triggered_by,
     report_json, plain_english, primary_cause, primary_confidence,
     recommendation, recommended_action, cache_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, businessId, metricName, signalId ?? null, question ?? null, triggeredBy,
    JSON.stringify(parsed),
    parsed.plain_english ?? null,
    parsed.primary_cause ?? null,
    parsed.primary_confidence ?? null,
    parsed.recommendation ?? null,
    parsed.recommended_action ?? null,
    cacheUntil
  );

  return { id, ...parsed, from_cache: false };
}

function buildPrompt(ctx) {
  const L = [];
  L.push(`Business: ${ctx.businessId}`);
  if (ctx.metricName) L.push(`Metric under investigation: ${ctx.metricName}`);
  if (ctx.signal) L.push(`Signal: "${ctx.signal.title}" — ${ctx.signal.description ?? ''}`);
  if (ctx.question) L.push(`User question: ${ctx.question}`);
  L.push('');
  L.push('TIMELINE:');
  if (ctx.timeline.points.length === 0) {
    L.push('No metric history available.');
  } else {
    const first = ctx.timeline.points[0];
    const last = ctx.timeline.points[ctx.timeline.points.length - 1];
    L.push(`- ${ctx.timeline.points.length} data points, from ${first.t.slice(0, 10)} (${first.v}) to ${last.t.slice(0, 10)} (${last.v})`);
    if (ctx.timeline.change_point) {
      L.push(`- Change point around ${ctx.timeline.change_point.at.slice(0, 10)}: 7-day avg went from ${ctx.timeline.change_point.before_avg.toFixed(2)} to ${ctx.timeline.change_point.after_avg.toFixed(2)}`);
    }
  }
  L.push('');
  L.push('ACTIONS AFFECTING THIS METRIC (known in-flight + recent):');
  if (ctx.actionCorr.length === 0) L.push('- (none recorded)');
  for (const a of ctx.actionCorr) {
    const days = Math.ceil((Date.now() - new Date(a.measurement_window_start)) / 86400000);
    const inWindow = days >= a.min_days && days <= a.expected_days * 1.5;
    L.push(`- "${a.title}" (${a.action_type}), ${days}d ago, window ${a.min_days}-${a.expected_days}d, ${inWindow ? 'IN WINDOW' : 'out of window'}`);
  }
  L.push('');
  L.push('CORRELATED METRICS (moved >5% in last 14 days):');
  if (ctx.metricCorr.length === 0) L.push('- (none)');
  for (const m of ctx.metricCorr) {
    const diff = ((m.recent_avg - m.prior_avg) / m.prior_avg) * 100;
    L.push(`- ${m.metric_name}: ${m.prior_avg?.toFixed(2)} → ${m.recent_avg?.toFixed(2)} (${diff > 0 ? '+' : ''}${diff.toFixed(1)}%)`);
  }
  L.push('');
  if (ctx.seasonal) {
    L.push(`SEASONAL CHECK: ${ctx.seasonal.within_seasonal ? 'Within expected seasonal variation' : 'NOT explained by seasonal pattern'} (change ${ctx.seasonal.change_pct.toFixed(1)}%)`);
    L.push('');
  }
  L.push('EXTERNAL CONTEXT (from KB signals/):');
  if (ctx.external.length === 0) L.push('- (none)');
  for (const e of ctx.external.slice(0, 4)) {
    L.push(`- ${e.title}: ${e.excerpt}`);
  }
  L.push('');
  L.push('HISTORICAL PRECEDENT (prior outcomes on this metric):');
  if (ctx.historical.length === 0) L.push('- (none)');
  for (const h of ctx.historical) {
    L.push(`- "${h.title}" — ${h.verdict} ${h.change_pct != null ? `(${h.change_pct > 0 ? '+' : ''}${h.change_pct.toFixed(1)}%)` : ''} on ${h.check_date.slice(0, 10)}`);
  }
  L.push('');
  L.push('Produce the investigation JSON per the schema.');
  return L.join('\n');
}

function findCached(businessId, metricName, signalId) {
  const where = [];
  const params = [businessId];
  where.push('business_id = ?');
  if (signalId) { where.push('signal_id = ?'); params.push(signalId); }
  else if (metricName) { where.push('metric_name = ?'); params.push(metricName); }
  else return null;
  where.push('cache_until > CURRENT_TIMESTAMP');

  const row = db.prepare(`
    SELECT * FROM investigations
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC LIMIT 1
  `).get(...params);
  if (!row) return null;
  let parsed = null;
  try { parsed = row.report_json ? JSON.parse(row.report_json) : {}; } catch {}
  return { id: row.id, ...parsed, created_at: row.created_at };
}

export function listInvestigations(businessId, limit = 50) {
  return db.prepare(`
    SELECT id, metric_name, signal_id, question, primary_cause,
           primary_confidence, recommendation, triggered_by, created_at
    FROM investigations WHERE business_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(businessId, limit);
}

export function getInvestigation(id, businessId) {
  const row = db.prepare('SELECT * FROM investigations WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!row) return null;
  let parsed = {};
  try { parsed = row.report_json ? JSON.parse(row.report_json) : {}; } catch {}
  return { ...row, ...parsed };
}
