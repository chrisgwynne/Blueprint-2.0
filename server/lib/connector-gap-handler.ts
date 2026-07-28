/**
 * Unified connector-gap handler.
 */

import db, { generateId } from '../db/db.js';
import {
  logIntelligenceEvent,
  parseSourceLabel,
} from './intelligence-events.js';

// Single source of truth for connectors Blueprint already ships with.
export const BUILT_CONNECTORS = new Set([
  'ga4', 'gsc', 'pagespeed', 'gbp', 'google-ads', 'shopify',
  'stripe', 'github', 'brevo', 'klaviyo', 'semrush', 'meta-ads',
  'social', 'buffer', 'wix', 'stannp', 'todoist', 'uptimerobot',
  'wordpress', 'kirby', 'tavily', 'brave-search', 'server-access',
]);

interface SurfaceConnectorGapOpts {
  business_id: string;
  connector_name: string;
  source: string;
  reason?: string | null;
  use_case?: string | null;
  implied_by?: string | null;
  priority?: string;
}

interface SurfaceResult {
  gap_id: string | null;
  task_id: string | null;
  first_time: boolean;
}

/**
 * Surface a connector gap from any mesh component.
 */
export async function surfaceConnectorGap({
  business_id,
  connector_name,
  source,
  reason = null,
  use_case = null,
  implied_by = null,
  priority = 'p3',
}: SurfaceConnectorGapOpts): Promise<SurfaceResult | null> {
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
  `).get(business_id, normalised) as any;

  if (existing) {
    const linkedTask = existing.task_id
      ? db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(existing.task_id) as any
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
  } catch (err: any) {
    // Unique-constraint race: another caller wrote this same gap concurrently.
    const raced = db.prepare(
      'SELECT id FROM connector_gaps WHERE business_id = ? AND connector_name = ?'
    ).get(business_id, normalised) as { id: string } | undefined;
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
}: {
  business_id: string;
  connector_name: string;
  isBuilt: boolean;
  source: string;
  reason: string | null | undefined;
  use_case: string | null | undefined;
  implied_by: string | null | undefined;
  priority: string;
}): Promise<any> {
  const { createTask } = await import('../tasks/task-queue.js') as unknown as { createTask: (opts: any) => any };
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
        description: use_case ?? reason ?? connector_name,
        use_case: use_case ?? null,
        implied_by: implied_by ?? null,
      },
    });
  } catch (err: any) {
    console.warn('[connector-gap] createTask failed:', err.message);
    return null;
  }
}

function logSurfacing({
  business_id, source, gap_id, connector_name, description,
  first_time, task_id = null, is_built = null,
}: {
  business_id: string;
  source: string;
  gap_id: string | null;
  connector_name: string;
  description: string;
  first_time: boolean;
  task_id?: string | null;
  is_built?: boolean | null;
}): void {
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
