/**
 * Unified connector-gap handler.
 *
 * Call surfaceConnectorGap() whenever any part of the mesh notices a data
 * source that would help but isn't connected. KB analyser, signal intelligence,
 * task-outcome processors, chat intent extractor, and agents all funnel through
 * here so we have one place that:
 *
 *   - decides if the gap is a built-in connector or a research-request
 *   - checks whether the connector is already actively connected (skip if so)
 *   - dedups via (business_id, connector_name) — repeat callers bump a counter
 *     instead of filing a duplicate task
 *   - creates a connect_connector or research_connector task on first surfacing
 *   - reopens the task if a previous one was rejected/completed
 *   - logs an intelligence event so the Timeline sees the flow
 */

import db, { generateId } from '../db/db.js';
import {
  logIntelligenceEvent,
  parseSourceLabel,
} from './intelligence-events.js';

// Single source of truth for connectors Blueprint already ships with.
// Keep in sync with /server/connectors/*. If a surfacing comes in with a name
// that's NOT in this set, it's filed as a research_connector task instead.
export const BUILT_CONNECTORS = new Set([
  'ga4', 'gsc', 'pagespeed', 'gbp', 'google-ads', 'shopify',
  'stripe', 'github', 'brevo', 'klaviyo', 'semrush', 'meta-ads',
  'social', 'buffer', 'wix', 'stannp', 'todoist', 'uptimerobot',
  'wordpress', 'kirby', 'tavily', 'brave-search', 'server-access',
]);

/**
 * Surface a connector gap from any mesh component.
 *
 * @param {object}  opts
 * @param {string}  opts.business_id
 * @param {string}  opts.connector_name  — 'semrush' | 'klaviyo' | free-form text
 *                                         for unknown tools. Normalised to lowercase.
 * @param {string}  opts.source          — 'kb-analyser' | 'signal-intelligence' |
 *                                         'agent:seo-sentinel' | 'chat' | etc.
 * @param {string=} opts.reason          — why this connector would help
 * @param {string=} opts.use_case        — elaboration for the resulting task body
 * @param {string=} opts.implied_by      — 'signal abc12345' | 'kb research/foo.md' | ...
 * @param {string=} opts.priority        — 'p1' | 'p2' | 'p3' (default p3)
 * @returns {Promise<{ gap_id, task_id, first_time } | null>}
 */
export async function surfaceConnectorGap({
  business_id,
  connector_name,
  source,
  reason = null,
  use_case = null,
  implied_by = null,
  priority = 'p3',
}) {
  if (!business_id || !connector_name || !source) return null;

  const normalised = String(connector_name).toLowerCase().trim().slice(0, 80);
  if (!normalised) return null;

  const isBuilt = BUILT_CONNECTORS.has(normalised);

  // Skip if the business already has this connector actively connected.
  if (isBuilt) {
    const connected = db.prepare(`
      SELECT id FROM connectors
       WHERE business_id = ? AND type = ? AND status = 'active'
    `).get(business_id, normalised);
    if (connected) return null;
  }

  // Look up any existing gap row for this (business, connector) pair.
  const existing = db.prepare(`
    SELECT * FROM connector_gaps
     WHERE business_id = ? AND connector_name = ?
  `).get(business_id, normalised);

  if (existing) {
    // If there's a linked task and it's still open/approved/executing, just
    // bump the counter. Otherwise (task rejected, completed, or deleted)
    // create a fresh task and update the gap row.
    const linkedTask = existing.task_id
      ? db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(existing.task_id)
      : null;

    const stillActive = linkedTask && [
      'proposed', 'approved', 'executing', 'draft_ready',
    ].includes(linkedTask.status);

    if (stillActive) {
      db.prepare(`
        UPDATE connector_gaps
           SET times_surfaced = times_surfaced + 1,
               last_surfaced_by = ?,
               last_surfaced_at = CURRENT_TIMESTAMP,
               last_reason = COALESCE(?, last_reason)
         WHERE id = ?
      `).run(source, reason, existing.id);

      logSurfacing({
        business_id, source, gap_id: existing.id,
        connector_name: normalised,
        description: `${normalised} surfaced again (${existing.times_surfaced + 1}× total)`,
        first_time: false,
      });

      return {
        gap_id: existing.id,
        task_id: existing.task_id,
        first_time: false,
      };
    }

    // Previous task is gone or closed — create a new task for the same gap.
    const task = await createGapTask({
      business_id, connector_name: normalised, isBuilt,
      source, reason, use_case, implied_by, priority,
    });
    if (!task) return null;

    db.prepare(`
      UPDATE connector_gaps
         SET task_id = ?,
             status = 'task_created',
             times_surfaced = times_surfaced + 1,
             last_surfaced_by = ?,
             last_surfaced_at = CURRENT_TIMESTAMP,
             last_reason = COALESCE(?, last_reason)
       WHERE id = ?
    `).run(task.id, source, reason, existing.id);

    logSurfacing({
      business_id, source, gap_id: existing.id,
      connector_name: normalised,
      description: `${normalised} re-surfaced — previous task closed, new task created`,
      first_time: false,
      task_id: task.id,
    });

    return { gap_id: existing.id, task_id: task.id, first_time: false };
  }

  // First time we've seen this gap — create task + gap row.
  const task = await createGapTask({
    business_id, connector_name: normalised, isBuilt,
    source, reason, use_case, implied_by, priority,
  });
  if (!task) return null;

  const gapId = generateId();
  try {
    db.prepare(`
      INSERT INTO connector_gaps (
        id, business_id, connector_name, is_built,
        first_surfaced_by, last_surfaced_by, task_id,
        status, description, last_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'task_created', ?, ?)
    `).run(
      gapId, business_id, normalised, isBuilt ? 1 : 0,
      source, source, task.id,
      use_case ?? reason ?? null, reason ?? null,
    );
  } catch (err) {
    // Unique-constraint race: another caller wrote this same gap concurrently.
    // The task is already created; return the concurrent row's id instead.
    const raced = db.prepare(
      'SELECT id FROM connector_gaps WHERE business_id = ? AND connector_name = ?'
    ).get(business_id, normalised);
    if (raced) return { gap_id: raced.id, task_id: task.id, first_time: false };
    console.warn('[connector-gap] insert failed:', err.message);
    return { gap_id: null, task_id: task.id, first_time: true };
  }

  logSurfacing({
    business_id, source, gap_id: gapId,
    connector_name: normalised,
    description: `${normalised} (${isBuilt ? 'built-in' : 'needs research'}) — ${(reason ?? '').slice(0, 120)}`,
    first_time: true,
    task_id: task.id,
    is_built: isBuilt,
  });

  return { gap_id: gapId, task_id: task.id, first_time: true };
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function createGapTask({
  business_id, connector_name, isBuilt,
  source, reason, use_case, implied_by, priority,
}) {
  const { createTask } = await import('../tasks/task-queue.js');
  try {
    return createTask({
      business_id,
      title: isBuilt
        ? `Connect ${connector_name} — requested by ${source}`
        : `Research connector: ${connector_name.slice(0, 80)}`,
      description: isBuilt
        ? `**Why this connector is needed:**\n\n${reason ?? '(not specified)'}\n\n` +
          `**Surfaced by:** ${source}\n` +
          (implied_by ? `**Context:** ${implied_by}\n` : '') +
          `\nThis connector is built into Blueprint and ready to connect.\n` +
          `Go to: Settings → Connectors → Add Connector → ${connector_name}.`
        : `**Surfaced by:** ${source}\n` +
          (implied_by ? `**Context:** ${implied_by}\n` : '') +
          `**Use case:** ${use_case ?? reason ?? '(not specified)'}\n\n` +
          `This data source doesn't have a Blueprint connector yet.\n` +
          `Blueprint will research available APIs and produce a connector spec.`,
      proposed_by: source,
      action_type: isBuilt ? 'connect_connector' : 'research_connector',
      priority,
      trust_tier: 'green',
      confidence: isBuilt ? 0.8 : 0.7,
      action_payload: {
        connector_type: connector_name,
        connector_name,
        requested_by: source,
        reason: reason ?? null,
        use_case: use_case ?? null,
        implied_by: implied_by ?? null,
      },
    });
  } catch (err) {
    console.warn('[connector-gap] createTask failed:', err.message);
    return null;
  }
}

function logSurfacing({
  business_id, source, gap_id, connector_name, description,
  first_time, task_id = null, is_built = null,
}) {
  const { type, id } = parseSourceLabel(source);
  logIntelligenceEvent({
    business_id,
    source_type: type,
    source_id: id,
    target_type: 'connector_gap',
    target_id: gap_id,
    event_type: first_time ? 'surfaced_connector_gap' : 'resurfaced_connector_gap',
    description,
    metadata: { connector_name, task_id, is_built },
  });
}
