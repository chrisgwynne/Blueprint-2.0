import db, { generateId } from '../db/db.js';
import { getRulesForConnector } from './rules.js';

interface RuleResult {
  triggered: boolean;
  confidence: number;
  data: Record<string, unknown>;
  title: string;
  description: string;
}

interface SignalRule {
  id: string;
  connectorType: string;
  type: string;
  severity: string;
  name: string;
  primaryMetric?: string;
  evaluate(current: unknown, previous: unknown): RuleResult;
}

// ─── Signal cool-down (per rule) ─────────────────────────────────────────────
// Prevents the same signal from re-firing too soon after resolution.

const COOLDOWN_HOURS: Record<string, number> & { default: number } = {
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

function shouldFireSignal(ruleId: string, connectorId: string, businessId: string): boolean {
  const cooldown = COOLDOWN_HOURS[ruleId] ?? COOLDOWN_HOURS.default;

  // Already open?
  const alreadyOpen = db.prepare(`
    SELECT id FROM signals
    WHERE rule_id = ? AND connector_id = ? AND business_id = ? AND status = 'open'
  `).get(ruleId, connectorId, businessId) as { id: string } | null;
  if (alreadyOpen) return false;

  // Recently resolved (in cool-down)?
  const recentResolved = db.prepare(`
    SELECT id FROM signals
    WHERE rule_id = ? AND connector_id = ? AND business_id = ?
    AND status = 'resolved'
    AND resolved_at > datetime('now', '-' || ? || ' hours')
  `).get(ruleId, connectorId, businessId, cooldown) as { id: string } | null;
  if (recentResolved) return false;

  return true;
}

/**
 * Auto-resolve a still-open signal for this exact rule/connector/business
 * once the rule's own re-evaluation shows the underlying metric has
 * recovered (issue #28). Only ever touches 'open'/'acknowledged' signals
 * — a 'suppressed' signal (an active do-not-touch window from causal.ts,
 * see the triggered branch above) is deliberately left alone here.
 */
function autoResolveIfStillOpen(ruleId: string, connectorId: string, businessId: string, result: RuleResult): void {
  const existing = db.prepare(`
    SELECT id FROM signals
    WHERE business_id = ? AND connector_id = ? AND rule_id = ? AND status IN ('open', 'acknowledged')
    ORDER BY created_at DESC LIMIT 1
  `).get(businessId, connectorId, ruleId) as { id: string } | null;
  if (!existing) return;

  db.prepare(`
    UPDATE signals
    SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
        description = COALESCE(description, '') || char(10) || char(10) ||
          '✅ Auto-resolved: a later measurement no longer triggers this rule (' || ? || ').'
    WHERE id = ?
  `).run(JSON.stringify(result.data).slice(0, 300), existing.id);
  console.log(`[signal-engine] Auto-resolved stale signal ${existing.id} (rule: ${ruleId}) — metric recovered.`);
}

/**
 * Run all applicable signal rules against new connector data.
 *
 * @param businessId
 * @param connectorId
 * @param currentData - Latest data from connector fetch
 * @param previousData - Previous data for comparison
 * @param connectorType - e.g. 'gsc', 'ga4', 'pagespeed'
 * @returns Array of new signal IDs that were created
 */
export async function runSignalEngine(
  businessId: string,
  connectorId: string,
  currentData: unknown,
  previousData: unknown,
  connectorType: string,
): Promise<string[]> {
  const applicableRules: SignalRule[] = getRulesForConnector(connectorType);
  const newSignalIds: string[] = [];

  for (const rule of applicableRules) {
    let result: RuleResult;
    try {
      // Normalise null → undefined so rules' `= {}` parameter defaults kick
      // in. Many rules access fields directly and would throw on null.
      result = rule.evaluate(currentData ?? undefined, previousData ?? undefined);
    } catch (err) {
      console.error(`[signal-engine] Rule '${rule.id}' threw during evaluate():`, (err as Error).message);
      continue;
    }

    if (!result.triggered) {
      // Issue #28: a rule that evaluated real current data and found the
      // condition no longer holds means the underlying metric recovered —
      // auto-resolve any signal left open from a prior firing of this
      // exact rule instead of leaving it stale forever, waiting on a
      // human or a proposed cleanup task to notice. Restricted to rules
      // whose "not triggered" result carries a non-empty `data` — every
      // rule in rules.ts returns `data: {}` on its early-out ("no data
      // this cycle, can't evaluate") branch, so a non-empty `data` here
      // reliably means the rule genuinely ran against real data and came
      // back healthy, not that this cycle simply had nothing to check.
      if (Object.keys(result.data ?? {}).length > 0) {
        autoResolveIfStillOpen(rule.id, connectorId, businessId, result);
      }
      continue;
    }

    // Cool-down + dedup check — don't re-fire same rule too soon
    if (!shouldFireSignal(rule.id, connectorId, businessId)) {
      // If there's an open signal, update its data silently
      const existing = db.prepare(`
        SELECT id FROM signals
        WHERE business_id = ? AND rule_id = ? AND status IN ('open', 'acknowledged')
        ORDER BY created_at DESC LIMIT 1
      `).get(businessId, rule.id) as { id: string } | null;
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
        const { analyseMetricChange } = await import('../brain/causal.js') as {
          analyseMetricChange: (metric: string, current: number, previous: number, businessId: string) => Promise<{
            do_not_change?: boolean;
            do_not_change_reason?: string;
            likely_cause?: string;
            confidence?: number;
            reasoning?: string;
          } | null>;
        };
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
        } else if (assessment?.likely_cause && (assessment.confidence ?? 0) >= 0.5) {
          // Enrich the signal with causal context
          db.prepare(`
            UPDATE signals
            SET description = COALESCE(description, '') || char(10) || char(10) || '📊 Causal analysis: ' || ?
            WHERE id = ?
          `).run(
            `${assessment.reasoning} (confidence: ${Math.round((assessment.confidence ?? 0) * 100)}%)`,
            signalId
          );
        }
      }
    } catch (err) {
      console.warn('[brain] causal analysis failed (non-fatal):', (err as Error).message);
    }

    // Brain — attribution analysis (fire-and-forget)
    (async () => {
      try {
        const { analyseAndStoreSignalAttribution } = await import('../brain/attribution-engine.js');
        await analyseAndStoreSignalAttribution(signalId);
      } catch (err) {
        console.warn('[brain] attribution failed (non-fatal):', (err as Error).message);
      }
    })();

    // Auto-trigger any workflows configured for this signal rule
    try {
      const triggered = db.prepare(`
        SELECT id FROM workflows
        WHERE business_id = ? AND trigger_type = 'signal' AND status = 'active'
          AND json_extract(trigger_config, '$.signal_rule_id') = ?
      `).all(businessId, rule.id) as Array<{ id: string }>;
      if (triggered.length > 0) {
        const { startWorkflow } = await import('../workflows/workflow-engine.js') as {
          startWorkflow: (id: string, businessId: string, triggeredBy?: string, reason?: string) => Promise<unknown>;
        };
        for (const wf of triggered) {
          startWorkflow(wf.id, businessId, 'signal-engine', `Triggered by signal: ${result.title}`).catch((err: Error) =>
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
        console.warn('[signal-intel] processNewSignal failed:', (err as Error).message);
      }
    })();
  }

  // If we created at least one new signal, kick the Conductor so it can
  // (a) propose hires for any specialist that would help with the new
  // signal type, and (b) re-evaluate its strategic plan. Fire-and-forget
  // — the sync caller doesn't wait for this.
  // The nudge carries its trigger provenance; the hiring service decides
  // whether it is actually due (cooldown / material change) and coalesces it
  // with any connector-sync or scheduled analysis already running for this
  // business (#46). It never proposes a hire on its own authority.
  if (newSignalIds.length > 0) {
    (async () => {
      try {
        const { analyseAndProposeHires } = await import('../agents/conductor-hiring.js');
        await analyseAndProposeHires(businessId, {
          trigger: 'signal',
          triggerRef: newSignalIds[0] ?? null,
          triggerReason: `${newSignalIds.length} new signal${newSignalIds.length === 1 ? '' : 's'} detected`,
        });
      } catch (err) {
        console.warn('[signal-engine] Conductor hiring nudge failed:', (err as Error).message);
      }
    })();
  }

  return newSignalIds;
}

// Helpers for brain causal analysis — map rule.connectorType to a primary
// metric path in the current data blob.
const PRIMARY_METRIC_FOR_CONNECTOR: Record<string, string> = {
  ga4: 'ga4.sessions',
  gsc: 'gsc.total_clicks',
  pagespeed: 'pagespeed.mobile.performance_score',
  shopify: 'shopify.conversion_rate',
  'meta-ads': 'meta-ads.roas',
  stripe: 'stripe.revenue_30d',
  gbp: 'gbp.views_total',
};

function pickPrimaryMetric(rule: SignalRule, _currentData: unknown): string | null {
  if (rule.primaryMetric) return rule.primaryMetric;
  return PRIMARY_METRIC_FOR_CONNECTOR[rule.connectorType] ?? null;
}

function extractMetricValue(data: unknown, metricPath: string | null): number | null {
  if (!data || !metricPath) return null;
  // Dotted-path lookup (best effort). Fall back to top-level keys.
  const segments = metricPath.split('.');
  let cur: unknown = data;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return null;
    if (seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    // try without prefix (e.g. 'ga4.sessions' → data.sessions)
    return null;
  }
  if (typeof cur === 'number') return cur;
  if (typeof cur === 'string' && !Number.isNaN(parseFloat(cur))) return parseFloat(cur);
  return null;
}
