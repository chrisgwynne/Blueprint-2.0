/**
 * Signal helpers for non-connector code paths.
 *
 * The existing runSignalEngine() in signal-engine.js creates signals from
 * connector data with its own cool-down logic. The rest of the mesh (KB
 * analyser, task-outcome processor, agent-surfaced patterns, chat intent
 * extractor) also needs to raise signals occasionally, but shouldn't have to
 * reimplement dedup every time.
 *
 * createSignalIfNotDuplicate() is the single helper those callers use.
 */

import db, { generateId } from '../db/db.js';
import {
  logIntelligenceEvent,
  parseSourceLabel,
} from '../lib/intelligence-events.js';

// Default dedup window for non-connector signals. If the same rule_id produced
// a signal that resolved less than this many hours ago, don't re-raise it —
// treat the recurrence as noise. Callers can override per-signal if needed.
const DEFAULT_DEDUP_HOURS = 24;

/**
 * Create a signal, or quietly merge into an existing open one if the same
 * (business_id, rule_id) pair is already live.
 *
 * rule_id is the dedup key. Use a stable prefix per source so collisions
 * across sources can't happen: e.g. 'kb_analyser:contradiction_<hash>',
 * 'task_outcome:worsened_<task_id>', 'agent_pattern:<signature>'.
 *
 * @returns {{ id, created } | null}  created=false if merged into an existing signal.
 */
export function createSignalIfNotDuplicate({
  business_id,
  rule_id,
  // connector_id is nullable in the schema and is a FK to connectors(id).
  // Non-connector-driven signals (KB, chat, task outcomes) leave it null.
  // Pass an actual connector id only when the signal genuinely attaches to
  // a live connector.
  connector_id = null,
  type = 'anomaly',
  severity = 'info',
  title,
  description = null,
  confidence = 0.7,
  data = {},
  source_label = null,
  dedup_hours = DEFAULT_DEDUP_HOURS,
  // When a brand new signal is created, push it through signal-intelligence
  // (file to KB, goal impact, agent trigger for alert/critical, connector
  // implications). Callers that do their own downstream routing can disable.
  process_through_mesh = true,
}) {
  if (!business_id || !rule_id || !title) return null;

  // Collapse into any currently-open (or acknowledged) signal with the same rule.
  const openOrAck = db.prepare(`
    SELECT id FROM signals
     WHERE business_id = ?
       AND rule_id = ?
       AND status IN ('open', 'acknowledged')
     ORDER BY created_at DESC
     LIMIT 1
  `).get(business_id, rule_id);

  if (openOrAck) {
    db.prepare(`
      UPDATE signals
         SET data = ?, confidence = ?, title = ?, description = ?,
             severity = ?, created_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(
      JSON.stringify(data ?? {}),
      confidence,
      String(title).slice(0, 500),
      description ? String(description).slice(0, 4000) : null,
      severity,
      openOrAck.id,
    );
    return { id: openOrAck.id, created: false };
  }

  // Skip if a resolved signal with the same rule closed recently — avoids
  // flapping. The caller can pass dedup_hours=0 to bypass this check.
  if (dedup_hours > 0) {
    const recentResolved = db.prepare(`
      SELECT id FROM signals
       WHERE business_id = ?
         AND rule_id = ?
         AND status = 'resolved'
         AND resolved_at > datetime('now', '-' || ? || ' hours')
       ORDER BY resolved_at DESC
       LIMIT 1
    `).get(business_id, rule_id, dedup_hours);
    if (recentResolved) return { id: recentResolved.id, created: false };
  }

  // Fresh signal.
  const id = generateId();
  try {
    db.prepare(`
      INSERT INTO signals (
        id, business_id, connector_id, rule_id, type, severity,
        title, description, data, status, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      business_id,
      connector_id,
      rule_id,
      type,
      severity,
      String(title).slice(0, 500),
      description ? String(description).slice(0, 4000) : null,
      JSON.stringify(data ?? {}),
      confidence,
    );
  } catch (err) {
    console.warn('[signal-helpers] insert failed:', err.message);
    return null;
  }

  if (source_label) {
    const { type: st, id: sid } = parseSourceLabel(source_label);
    logIntelligenceEvent({
      business_id,
      source_type: st,
      source_id: sid,
      target_type: 'signal',
      target_id: id,
      event_type: 'created_signal',
      description: `${severity}: ${String(title).slice(0, 180)}`,
      metadata: { rule_id, confidence, connector_id },
    });
  }

  // Downstream mesh routing: file to KB, goal impact, trigger agents for
  // alert/critical severity, check connector implications. Fire-and-forget.
  if (process_through_mesh) {
    import('./signal-intelligence.js')
      .then(({ processNewSignal }) => processNewSignal(id, business_id))
      .catch((err) => console.warn('[signal-helpers] mesh routing failed:', err.message));
  }

  return { id, created: true };
}
