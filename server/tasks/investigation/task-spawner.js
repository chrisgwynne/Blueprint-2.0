/**
 * Investigation Task Spawner
 *
 * Spawns follow-on action tasks from investigation findings.
 * Each task is checked against the restraint system before creation.
 * Restrained areas get deferred tasks with wake dates.
 * Sends a single Telegram + dashboard notification with specific findings.
 */
import crypto from 'crypto';
import db, { generateId } from '../../db/db.js';

// ─── Trust tier determination ─────────────────────────────────────────────────

function determineTrustTier(actionTask) {
  // All write operations require human approval
  const alwaysYellow = [
    'shopify_description_update', 'shopify_theme_edit',
    'shopify_product_create', 'shopify_page_create',
    'shopify_meta_update', 'github_pr', 'github_issue',
    'server_file_write', 'wix_seo_update', 'gbp_update',
    'meta_ads_update', 'klaviyo_flow_update', 'meta_update',
  ];
  if (alwaysYellow.includes(actionTask.action_type)) return 'yellow';

  // High-confidence nested investigations can auto-surface
  if (actionTask.action_type === 'investigation' && (actionTask.confidence ?? 0) > 0.85) {
    return 'green';
  }

  // Content drafts: green (no external effect until human publishes)
  if (actionTask.action_type === 'content_draft') return 'green';

  return 'yellow';
}

// ─── Notification body ────────────────────────────────────────────────────────

function buildNotificationBody(findings, created) {
  const lines = [
    `Found: ${findings.primary_cause ?? 'Unknown cause'}`,
    `Confidence: ${Math.round((findings.confidence ?? 0) * 100)}%`,
    '',
    'Action tasks proposed:',
  ];

  created.filter(t => t.status === 'proposed').forEach((t, i) => {
    lines.push(`${i + 1}. [${(t.priority ?? 'p2').toUpperCase()}] ${t.title}`);
  });

  if (created.filter(t => t.status === 'deferred').length > 0) {
    lines.push('');
    lines.push(`${created.filter(t => t.status === 'deferred').length} task(s) deferred (measurement window in progress).`);
  }

  if (findings.measurement_plan?.primary_metric) {
    lines.push('');
    lines.push(`Check ${findings.measurement_plan.primary_metric} in ${findings.measurement_plan.check_at_days ?? 14} days.`);
  }

  return lines.join('\n');
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Spawn follow-on action tasks from investigation findings.
 *
 * @param {Object} findings - Parsed LLM findings (must have action_tasks array)
 * @param {Object} parentTask - The parent investigation task row
 * @returns {Promise<Array>} Array of created task summaries
 */
export async function spawnFollowOnTasks(findings, parentTask) {
  if (!Array.isArray(findings.action_tasks) || findings.action_tasks.length === 0) return [];

  const { checkRestraint } = await import('../../brain/restraint.js');
  const { createTaskEvent } = await import('../task-events.js');

  const created = [];

  // Sort by order field (ascending)
  const sorted = [...findings.action_tasks].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  );

  for (const actionTask of sorted) {
    if (!actionTask?.title || !actionTask?.action_type) continue;

    // Check restraint before creating
    let status = 'proposed';
    let deferredUntil = null;
    let deferredReason = null;

    try {
      const restraint = await checkRestraint(
        {
          action_type: actionTask.action_type,
          action_payload: actionTask.action_payload ?? {},
          title: actionTask.title,
        },
        parentTask.business_id
      );

      if (!restraint.allowed) {
        status = 'deferred';
        deferredUntil = restraint.measurement_window_ends;
        deferredReason = restraint.reason;
      }
    } catch (err) {
      console.warn('[task-spawner] Restraint check failed (allowing):', err.message);
    }

    const taskId = generateId();

    const descriptionWithContext = [
      actionTask.description ?? '',
      '',
      '---',
      `*Follow-on from: [${parentTask.title}](/tasks/${parentTask.id})*`,
      actionTask.expected_impact ? `*Expected impact: ${actionTask.expected_impact}*` : null,
    ].filter(l => l !== null).join('\n');

    try {
      db.prepare(`
        INSERT INTO tasks (
          id, business_id, title, description,
          status, proposed_by, trust_tier, priority,
          action_type, action_payload, confidence,
          target_metric, measurement_window_days,
          parent_task_id, signal_id, project_id,
          deferred_until, deferred_reason,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, 'conductor:investigation', ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(
        taskId,
        parentTask.business_id,
        actionTask.title,
        descriptionWithContext,
        status,
        determineTrustTier(actionTask),
        actionTask.priority ?? 'p2',
        actionTask.action_type,
        JSON.stringify(actionTask.action_payload ?? {}),
        actionTask.confidence ?? null,
        actionTask.target_metric ?? null,
        actionTask.measurement_window_days ?? null,
        parentTask.id,
        parentTask.signal_id ?? null,
        parentTask.project_id ?? null,
        deferredUntil,
        deferredReason
      );

      createTaskEvent(
        taskId, 'created', 'conductor:investigation',
        `Task spawned from investigation: ${parentTask.title}`,
        { parent_task_id: parentTask.id, investigation_confidence: findings.confidence }
      );

      created.push({
        id: taskId,
        title: actionTask.title,
        action_type: actionTask.action_type,
        priority: actionTask.priority ?? 'p2',
        status,
        deferred_until: deferredUntil,
      });
    } catch (err) {
      console.warn('[task-spawner] Failed to create follow-on task:', err.message);
    }
  }

  if (created.length === 0) return created;

  // Send notifications
  try {
    const { dispatchToAll } = await import('../../notifications/dispatcher.js');
    const proposedCount = created.filter(t => t.status === 'proposed').length;
    if (proposedCount > 0) {
      await dispatchToAll(['dashboard', 'telegram'], {
        business_id: parentTask.business_id,
        severity: 'info',
        title: `Investigation complete: ${proposedCount} action task${proposedCount > 1 ? 's' : ''} ready`,
        body: buildNotificationBody(findings, created),
        entity_type: 'task',
        entity_id: parentTask.id,
      });
    }
  } catch (err) {
    console.warn('[task-spawner] Notification dispatch failed (non-fatal):', err.message);
  }

  return created;
}
