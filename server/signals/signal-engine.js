import db, { generateId } from '../db/db.js';
import { getRulesForConnector } from './rules.js';

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

    // Check if an open signal with same rule_id already exists for this business
    const existing = db.prepare(`
      SELECT id FROM signals
      WHERE business_id = ? AND rule_id = ? AND status IN ('open', 'acknowledged')
      ORDER BY created_at DESC LIMIT 1
    `).get(businessId, rule.id);

    if (existing) {
      // Update the existing signal's data and confidence (upsert pattern)
      db.prepare(`
        UPDATE signals
        SET data = ?, confidence = ?, title = ?, description = ?, created_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        JSON.stringify(result.data),
        result.confidence,
        result.title,
        result.description,
        existing.id
      );
      console.log(`[signal-engine] Updated existing signal ${existing.id} for rule '${rule.id}'`);
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
  }

  return newSignalIds;
}
