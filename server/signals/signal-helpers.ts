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
import { createHash } from 'node:crypto';
import {
  logIntelligenceEvent,
  parseSourceLabel,
} from '../lib/intelligence-events.js';

type SignalParams = {
  business_id: string;
  rule_id: string;
  connector_id?: string | null;
  type?: string;
  severity?: string;
  title: string;
  description?: string | null;
  confidence?: number;
  data?: Record<string, unknown>;
  source_label?: string | null;
  dedup_hours?: number;
  process_through_mesh?: boolean;
  canonical_key?: string | null;
  condition_key?: string | null;
  actionable?: boolean;
  agent_id?: string | null;
  goal_id?: string | null;
};

// Default dedup window for non-connector signals. If the same rule_id produced
// a signal that resolved less than this many hours ago, don't re-raise it —
// treat the recurrence as noise. Callers can override per-signal if needed.
const DEFAULT_DEDUP_HOURS = 24;

/**
 * Create a signal, or quietly merge into an existing open one if the same
 * canonical business condition is already live.
 *
 * rule_id identifies the producer; canonical_key identifies the underlying
 * business condition and is the durable dedup key.
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
  canonical_key = null,
  condition_key = null,
  actionable,
  agent_id = null,
  goal_id = null,
}: SignalParams): { id: string; created: boolean } | null {
  if (!business_id || !rule_id || !title) return null;

  const normalizedData = stableValue(data ?? {});
  const semanticKey = canonical_key || [connector_id ?? 'none', type, signalIdentity(normalizedData, title)].join('|');
  const canonicalFingerprint = hash(semanticKey);
  const conditionFingerprint = hash(condition_key || JSON.stringify(normalizedData));

  // Informational observations are telemetry, not active work, unless a
  // producer explicitly marks them actionable.
  if (!(actionable ?? severity !== 'info')) return { id: `suppressed:${canonicalFingerprint}`, created: false };

  // Collapse into any currently-open (or acknowledged) signal for this condition.
  const openOrAck = db.prepare(`
    SELECT id FROM signals
     WHERE business_id = ?
       AND canonical_fingerprint = ?
       AND status IN ('open', 'acknowledged')
     ORDER BY created_at DESC
     LIMIT 1
  `).get(business_id, canonicalFingerprint) as { id: string } | null;

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

  // Dismissal/resolution is durable for the same underlying condition. A new
  // wording variant or a later timestamp cannot resurrect it; a changed
  // condition fingerprint can create a new generation.
  const historical = db.prepare(`
    SELECT id FROM signals
     WHERE business_id = ? AND canonical_fingerprint = ?
       AND condition_fingerprint = ?
       AND status IN ('resolved', 'suppressed', 'dismissed')
     ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(business_id, canonicalFingerprint, conditionFingerprint) as { id: string } | null;
  if (historical) return { id: historical.id, created: false };

  const explicitSuppression = db.prepare(`
    SELECT source_signal_id FROM signal_suppressions
     WHERE business_id = ? AND canonical_fingerprint = ? AND condition_fingerprint = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(business_id, canonicalFingerprint, conditionFingerprint) as { source_signal_id: string | null } | null;
  if (explicitSuppression) return { id: explicitSuppression.source_signal_id ?? `suppressed:${canonicalFingerprint}`, created: false };

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
    `).get(business_id, rule_id, dedup_hours) as { id: string } | null;
    if (recentResolved) return { id: recentResolved.id, created: false };
  }

  // Fresh signal.
  const id = generateId();
  const generationRow = db.prepare(`
    SELECT COALESCE(MAX(canonical_generation), 0) AS generation
      FROM signals
     WHERE business_id = ? AND canonical_fingerprint = ?
  `).get(business_id, canonicalFingerprint) as { generation: number };
  const canonicalGeneration = Number(generationRow?.generation ?? 0) + 1;
  try {
    db.prepare(`
      INSERT INTO signals (
        id, business_id, connector_id, rule_id, type, severity,
        title, description, data, status, confidence, canonical_fingerprint,
        condition_fingerprint, canonical_generation, agent_id, goal_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
      canonicalFingerprint,
      conditionFingerprint,
      canonicalGeneration,
      agent_id,
      goal_id,
    );
  } catch (err) {
    console.warn('[signal-helpers] insert failed:', (err as Error).message);
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
      .then(({ processNewSignal }: { processNewSignal: (id: string, businessId: string) => Promise<void> }) =>
        processNewSignal(id, business_id)
      )
      .catch((err: Error) => console.warn('[signal-helpers] mesh routing failed:', err.message));
  }

  return { id, created: true };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function signalIdentity(data: unknown, title: string): string {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of ['canonical_key', 'condition_key', 'metric', 'metric_name', 'resource_id', 'product_id', 'provider', 'url', 'path', 'source']) {
      if (typeof record[key] === 'string' && record[key]) return `${key}:${record[key]}`;
    }
  }
  return title.toLowerCase().replace(/\b\d+(?:\.\d+)?\b/g, '#').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['created_at', 'recorded_at', 'timestamp', 'run_id', 'observed_at'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

/** Record a durable operator suppression for a signal's current condition. */
export function recordSignalSuppression(signalId: string, reason: string): void {
  const signal = db.prepare('SELECT business_id, canonical_fingerprint, condition_fingerprint FROM signals WHERE id = ?').get(signalId) as { business_id: string; canonical_fingerprint: string | null; condition_fingerprint: string | null } | null;
  if (!signal?.canonical_fingerprint || !signal.condition_fingerprint) return;
  db.prepare(`INSERT INTO signal_suppressions (id, business_id, canonical_fingerprint, condition_fingerprint, source_signal_id, reason) VALUES (?, ?, ?, ?, ?, ?)`).run(
    generateId(), signal.business_id, signal.canonical_fingerprint, signal.condition_fingerprint, signalId, reason.slice(0, 500),
  );
}
