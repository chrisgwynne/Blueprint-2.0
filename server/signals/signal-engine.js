import db, { generateId } from '../db/db.js';
import { getRulesForConnector } from './rules.js';

// ─── Signal cool-down (per rule) ─────────────────────────────────────────────
// Prevents the same signal from re-firing too soon after resolution.

const COOLDOWN_HOURS = {
  default: 24,
  monitor_down: 1,
  monitor_seems_down: 1,
  connector_stale: 6,
  agent_consecutive_failures: 12,
  gbp_negative_review: 48,
  ranking_drop_keyword: 48,
  traffic_drop_7day: 72,
  shopify_no_orders: 12,
};

function shouldFireSignal(ruleId, connectorId, businessId) {
  const cooldown = COOLDOWN_HOURS[ruleId] ?? COOLDOWN_HOURS.default;

  // Already open?
  const alreadyOpen = db.prepare(`
    SELECT id FROM signals
    WHERE rule_id = ? AND connector_id = ? AND business_id = ? AND status = 'open'
  `).get(ruleId, connectorId, businessId);
  if (alreadyOpen) return false;

  // Recently resolved (in cool-down)?
  const recentResolved = db.prepare(`
    SELECT id FROM signals
    WHERE rule_id = ? AND connector_id = ? AND business_id = ?
    AND status = 'resolved'
    AND resolved_at > datetime('now', '-' || ? || ' hours')
  `).get(ruleId, connectorId, businessId, cooldown);
  if (recentResolved) return false;

  return true;
}

/**
 * Run all applicable signal rules against new connector data.
 *
 * @param {string} businessId
 * @param {string} connectorId
 * @param {any} currentData - Latest data from connector fetch
 * @param {any} previousData - Previous data for comparison
 * @param {string} connectorType - e.g. 'gsc', 'ga4', 'pagespeed'
 * @returns {Promise<string[]>} Array of new signal IDs that were created
 */
export async function runSignalEngine(businessId, connectorId, currentData, previousData, connectorType) {
  const applicableRules = getRulesForConnector(connectorType);
  const newSignalIds = [];

  for (const rule of applicableRules) {
    let result;
    try {
      result = rule.evaluate(currentData, previousData);
    } catch (err) {
      console.error(`[signal-engine] Rule '${rule.id}' threw during evaluate():`, err.message);
      continue;
    }

    if (!result.triggered) continue;

    // Cool-down + dedup check — don't re-fire same rule too soon
    if (!shouldFireSignal(rule.id, connectorId, businessId)) {
      // If there's an open signal, update its data silently
      const existing = db.prepare(`
        SELECT id FROM signals
        WHERE business_id = ? AND rule_id = ? AND status IN ('open', 'acknowledged')
        ORDER BY created_at DESC LIMIT 1
      `).get(businessId, rule.id);
      if (existing) {
        db.prepare(`
          UPDATE signals SET data = ?, confidence = ?, title = ?, description = ?, created_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(JSON.stringify(result.data), result.confidence, result.title, result.description, existing.id);
      }
      continue;
    }

    // Create a new signal
    const signalId = generateId();
    db.prepare(`
      INSERT INTO signals (
        id, business_id, connector_id, rule_id, type, severity,
        title, description, data, status, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, CURRENT_TIMESTAMP)
    `).run(
      signalId,
      businessId,
      connectorId,
      rule.id,
      rule.type,
      rule.severity,
      result.title,
      result.description,
      JSON.stringify(result.data),
      result.confidence
    );

    newSignalIds.push(signalId);
    console.log(`[signal-engine] New signal created: ${signalId} (rule: ${rule.id}, severity: ${rule.severity})`);

    // Brain — causal reasoning on the triggering metric
    try {
      const primaryMetric = rule.primaryMetric ?? pickPrimaryMetric(rule, currentData);
      const currentMetricValue = extractMetricValue(currentData, primaryMetric);
      const previousMetricValue = extractMetricValue(previousData, primaryMetric);
      if (primaryMetric && currentMetricValue != null && previousMetricValue != null) {
        const { analyseMetricChange } = await import('../brain/causal.js');
        const assessment = await analyseMetricChange(
          primaryMetric, currentMetricValue, previousMetricValue, businessId
        );
        if (assessment?.do_not_change) {
          // Suppress the signal — a known action is likely causing this
          db.prepare(`
            UPDATE signals
            SET status = 'suppressed',
                description = COALESCE(description, '') || char(10) || char(10) || '⏳ SUPPRESSED: ' || ?
            WHERE id = ?
          `).run(assessment.do_not_change_reason ?? 'recent action pending measurement', signalId);
          console.log(`[brain] Signal ${signalId.slice(0,8)} suppressed: ${assessment.do_not_change_reason}`);
        } else if (assessment?.likely_cause && assessment.confidence >= 0.5) {
          // Enrich the signal with causal context
          db.prepare(`
            UPDATE signals
            SET description = COALESCE(description, '') || char(10) || char(10) || '📊 Causal analysis: ' || ?
            WHERE id = ?
          `).run(
            `${assessment.reasoning} (confidence: ${Math.round(assessment.confidence * 100)}%)`,
            signalId
          );
        }
      }
    } catch (err) {
      console.warn('[brain] causal analysis failed (non-fatal):', err.message);
    }

    // Brain — attribution analysis (fire-and-forget)
    (async () => {
      try {
        const { analyseAndStoreSignalAttribution } = await import('../brain/attribution-engine.js');
        await analyseAndStoreSignalAttribution(signalId);
      } catch (err) {
        console.warn('[brain] attribution failed (non-fatal):', err.message);
      }
    })();

    // Auto-trigger any workflows configured for this signal rule
    try {
      const triggered = db.prepare(`
        SELECT id FROM workflows
        WHERE business_id = ? AND trigger_type = 'signal' AND status = 'active'
          AND json_extract(trigger_config, '$.signal_rule_id') = ?
      `).all(businessId, rule.id);
      if (triggered.length > 0) {
        const { startWorkflow } = await import('../workflows/workflow-engine.js');
        for (const wf of triggered) {
          startWorkflow(wf.id, businessId, 'signal-engine', `Triggered by signal: ${result.title}`).catch(err =>
            console.warn('[signal-engine] workflow trigger failed:', err.message)
          );
        }
      }
    } catch {}

    // Dispatch BAP webhook events
    try {
      const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js');
      dispatchWebhookEvent('signal.created', {
        signal_id: signalId, business_id: businessId, type: rule.type,
        severity: rule.severity, title: result.title, confidence: result.confidence,
        connector: connectorId, rule_id: rule.id,
      });
      if (rule.severity === 'critical') {
        dispatchWebhookEvent('signal.critical', {
          signal_id: signalId, business_id: businessId, type: rule.type,
          severity: 'critical', title: result.title, confidence: result.confidence,
        });
      }
    } catch {}

    // Signal intelligence — file to KB, check goal impact, trigger agents
    // (alert/critical only), and check connector implications. Fire-and-forget.
    (async () => {
      try {
        const { processNewSignal } = await import('./signal-intelligence.js');
        await processNewSignal(signalId, businessId);
      } catch (err) {
        console.warn('[signal-intel] processNewSignal failed:', err.message);
      }
    })();
  }

  // If we created at least one new signal, kick the Conductor so it can
  // (a) propose hires for any specialist that would help with the new
  // signal type, and (b) re-evaluate its strategic plan. Fire-and-forget
  // — the sync caller doesn't wait for this.
  if (newSignalIds.length > 0) {
    (async () => {
      try {
        const { analyseAndProposeHires } = await import('../agents/conductor-hiring.js');
        await analyseAndProposeHires(businessId);
      } catch (err) {
        console.warn('[signal-engine] Conductor hiring nudge failed:', err.message);
      }
    })();
  }

  return newSignalIds;
}

// Helpers for brain causal analysis — map rule.connectorType to a primary
// metric path in the current data blob.
const PRIMARY_METRIC_FOR_CONNECTOR = {
  ga4: 'ga4.sessions',
  gsc: 'gsc.total_clicks',
  pagespeed: 'pagespeed.mobile.performance_score',
  shopify: 'shopify.conversion_rate',
  'meta-ads': 'meta-ads.roas',
  stripe: 'stripe.revenue_30d',
  gbp: 'gbp.views_total',
};

function pickPrimaryMetric(rule, currentData) {
  if (rule.primaryMetric) return rule.primaryMetric;
  return PRIMARY_METRIC_FOR_CONNECTOR[rule.connectorType] ?? null;
}

function extractMetricValue(data, metricPath) {
  if (!data || !metricPath) return null;
  // Dotted-path lookup (best effort). Fall back to top-level keys.
  const segments = metricPath.split('.');
  let cur = data;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return null;
    if (seg in cur) { cur = cur[seg]; continue; }
    // try without prefix (e.g. 'ga4.sessions' → data.sessions)
    return null;
  }
  if (typeof cur === 'number') return cur;
  if (typeof cur === 'string' && !Number.isNaN(parseFloat(cur))) return parseFloat(cur);
  return null;
}
