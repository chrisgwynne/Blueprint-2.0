import db, { generateId, audit } from '../db/db.js';

// Lazy import for webhook dispatch (avoids circular dependency at startup)
let _dispatch = null;
function fireWebhook(event, data) {
  if (!_dispatch) {
    import('../bap/webhook-dispatcher.js')
      .then((m) => { _dispatch = m.dispatchWebhookEvent; _dispatch(event, data); })
      .catch(() => {});
  } else {
    try { _dispatch(event, data); } catch {}
  }
}

const VALID_TRANSITIONS = {
  proposed: ['approved', 'rejected'],
  approved: ['executing', 'rejected'],
  executing: ['complete', 'failed', 'draft_ready'],
  draft_ready: ['complete', 'failed'],  // human reviews the draft, then marks complete or rejects
  complete: ['verified'],
  failed: ['proposed'], // allow retry
  rejected: [],
  verified: [],
  deferred: ['proposed', 'rejected'],  // Brain may defer; resurface on schedule
};

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    action_payload: row.action_payload ? JSON.parse(row.action_payload) : {},
    outcome_data: row.outcome_data ? JSON.parse(row.outcome_data) : null,
    rollback_data: row.rollback_data ? JSON.parse(row.rollback_data) : null,
  };
}

/**
 * Create a new task.
 * @param {Object} taskData
 * @returns {Object} Created task (parsed)
 */
export function createTask(taskData) {
  const {
    business_id,
    signal_id = null,
    mission_id = null,
    title,
    description = null,
    proposed_by,
    assigned_to = null,
    action_type = null,
    action_payload = {},
    trust_tier = 'yellow',
    priority = 'p2',
    confidence = null,
    estimated_impact = null,
    rollback_data = null,
    approval_mode = 'requires_approval',
  } = taskData;

  if (!business_id) throw new Error('business_id is required.');
  if (!title) throw new Error('title is required.');
  if (!proposed_by) throw new Error('proposed_by is required.');

  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tasks (
      id, business_id, signal_id, mission_id, title, description,
      proposed_by, assigned_to, action_type, action_payload,
      status, trust_tier, priority, confidence, estimated_impact,
      rollback_data, approval_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    business_id,
    signal_id,
    mission_id,
    title,
    description,
    proposed_by,
    assigned_to,
    action_type,
    JSON.stringify(action_payload),
    trust_tier,
    priority,
    confidence,
    estimated_impact,
    rollback_data ? JSON.stringify(rollback_data) : null,
    approval_mode,
    now,
    now
  );

  const created = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  audit(business_id, 'task', id, 'create', proposed_by, null, created);

  // Auto-populate target_metric for outcome tracking
  try {
    import('./outcomes.js').then((m) => m.setTaskTargetMetric(id, business_id, action_type)).catch(() => {});
  } catch {}

  return created;
}

/**
 * Get a single task by ID.
 */
export function getTask(id) {
  return parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

/**
 * List tasks for a business with optional filters.
 */
export function listTasks(businessId, filters = {}) {
  const conditions = ['business_id = ?'];
  const params = [businessId];

  if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters.signal_id) { conditions.push('signal_id = ?'); params.push(filters.signal_id); }
  if (filters.mission_id) { conditions.push('mission_id = ?'); params.push(filters.mission_id); }
  if (filters.proposed_by) { conditions.push('proposed_by = ?'); params.push(filters.proposed_by); }

  const where = conditions.join(' AND ');
  return db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC`).all(...params).map(parseRow);
}

/**
 * Update task status with transition validation.
 */
export function updateTaskStatus(id, newStatus, actor, metadata = {}) {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) throw new Error(`Task '${id}' not found.`);

  const allowed = VALID_TRANSITIONS[existing.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Cannot transition task from '${existing.status}' to '${newStatus}'. Allowed transitions: ${allowed.join(', ') || 'none'}`
    );
  }

  const updates = ['status = ?', 'updated_at = ?'];
  const values = [newStatus, new Date().toISOString()];

  if (newStatus === 'executing' && !existing.started_at) {
    updates.push('started_at = CURRENT_TIMESTAMP');
  }
  if (newStatus === 'complete' || newStatus === 'verified' || newStatus === 'failed') {
    updates.push('completed_at = CURRENT_TIMESTAMP');
  }
  if (metadata.outcome !== undefined) {
    updates.push('outcome = ?');
    values.push(metadata.outcome);
  }
  if (metadata.outcome_data !== undefined) {
    updates.push('outcome_data = ?');
    values.push(JSON.stringify(metadata.outcome_data));
  }

  values.push(id);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // Brain — when a task completes, record action memory so the Restraint
  // system knows the measurement window is in flight.
  if (newStatus === 'complete' || newStatus === 'verified') {
    try {
      import('../brain/action-windows.js').then((m) => {
        try { m.recordActionMemory(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)); }
        catch (err) { console.warn('[brain] recordActionMemory failed:', err.message); }
      });
    } catch {}
  }

  const before = parseRow(existing);
  const after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  audit(
    existing.business_id,
    'task',
    id,
    `status_change:${existing.status}->${newStatus}`,
    actor,
    before,
    after,
    metadata
  );

  // Dispatch BAP webhook for terminal statuses
  if (newStatus === 'complete' || newStatus === 'verified') {
    fireWebhook('task.complete', {
      task_id: id, business_id: existing.business_id,
      title: existing.title, outcome: metadata.outcome ?? null,
    });
  } else if (newStatus === 'failed') {
    fireWebhook('task.failed', {
      task_id: id, business_id: existing.business_id,
      title: existing.title, outcome: metadata.outcome ?? null,
    });
  } else if (newStatus === 'rejected') {
    fireWebhook('task.rejected', {
      task_id: id, business_id: existing.business_id,
      title: existing.title, rejection_reason: metadata.reason ?? null,
    });
  }

  return after;
}

/**
 * Approve a task. Validates trust_tier enforcement.
 * Green + auto mode → immediately transitions to 'executing'.
 */
export function approveTask(id, approvedBy) {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) throw new Error(`Task '${id}' not found.`);

  if (existing.status !== 'proposed') {
    throw new Error(`Cannot approve task in status '${existing.status}'. Task must be 'proposed'.`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET
      status = 'approved',
      approved_by = ?,
      approved_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(approvedBy, now, now, id);

  const before = parseRow(existing);
  let after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  audit(existing.business_id, 'task', id, 'approve', approvedBy, before, after);

  // Dispatch BAP webhook
  fireWebhook('task.approved', {
    task_id: id, business_id: existing.business_id,
    title: existing.title, approved_by: approvedBy,
    action_type: existing.action_type,
  });

  // Auto-execute green tasks in auto approval mode
  if (existing.trust_tier === 'green' && existing.approval_mode === 'auto') {
    after = updateTaskStatus(id, 'executing', approvedBy, {});
  }

  return after;
}

/**
 * Reject a task with an optional reason.
 */
export function rejectTask(id, rejectedBy, reason = '') {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) throw new Error(`Task '${id}' not found.`);

  const allowedFromStatuses = ['proposed', 'approved'];
  if (!allowedFromStatuses.includes(existing.status)) {
    throw new Error(`Cannot reject task in status '${existing.status}'. Task must be 'proposed' or 'approved'.`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET
      status = 'rejected',
      rejection_reason = ?,
      updated_at = ?
    WHERE id = ?
  `).run(reason, now, id);

  const before = parseRow(existing);
  const after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  audit(existing.business_id, 'task', id, 'reject', rejectedBy, before, after, { reason });

  return after;
}
