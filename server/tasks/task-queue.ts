import db, { generateId, audit } from '../db/db.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'complete'
  | 'failed'
  | 'blocked'
  | 'rejected'
  | 'verified'
  | 'deferred'
  | 'draft_ready';

export interface TaskRow {
  id: string;
  business_id: string;
  signal_id: string | null;
  mission_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  proposed_by: string;
  assigned_to: string | null;
  action_type: string | null;
  action_payload: Record<string, unknown>;
  trust_tier: string;
  priority: string;
  confidence: number | null;
  estimated_impact: string | null;
  rollback_data: unknown;
  outcome_data: unknown;
  approval_mode: string;
  degraded_data: number;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskParams {
  business_id: string;
  signal_id?: string | null;
  mission_id?: string | null;
  title: string;
  description?: string | null;
  proposed_by: string;
  assigned_to?: string | null;
  action_type?: string | null;
  action_payload?: Record<string, unknown>;
  trust_tier?: string;
  priority?: string;
  confidence?: number | null;
  estimated_impact?: string | null;
  rollback_data?: unknown;
  approval_mode?: string;
  degraded_data?: number;
  parent_task_id?: string | null;
  [key: string]: unknown;  // allow extra fields passed by callers
}

interface UpdateStatusMetadata {
  outcome?: string;
  outcome_data?: unknown;
  reason?: string;
  [key: string]: unknown;
}

// ── Internals ────────────────────────────────────────────────────────────────

// Lazy import for webhook dispatch (avoids circular dependency at startup)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _dispatch: ((event: string, data: any) => void) | null = null;
function fireWebhook(event: string, data: unknown): void {
  if (!_dispatch) {
    import('../bap/webhook-dispatcher.js')
      .then((m) => { _dispatch = m.dispatchWebhookEvent; _dispatch!(event, data); })
      .catch(() => {});
  } else {
    try { _dispatch(event, data); } catch {}
  }
}

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  proposed: ['approved', 'rejected'],
  approved: ['executing', 'rejected'],
  executing: ['complete', 'failed', 'draft_ready'],
  draft_ready: ['complete', 'failed'], // human reviews the draft, then marks complete or rejects
  complete: ['verified'],
  failed: ['proposed'], // allow retry
  blocked: ['proposed', 'failed'],
  rejected: [],
  verified: [],
  deferred: ['proposed', 'rejected'], // Brain may defer; resurface on schedule
};

function safeJSON<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  try { return JSON.parse(raw as string) as T; }
  catch {
    console.warn('[task-queue] Failed to parse JSON field, using fallback. Raw:', String(raw).slice(0, 120));
    return fallback;
  }
}

function parseRow(row: Record<string, unknown> | null): TaskRow | null {
  if (!row) return null;
  return {
    ...(row as unknown as TaskRow),
    action_payload: safeJSON<Record<string, unknown>>(row.action_payload, {}),
    outcome_data: safeJSON<unknown>(row.outcome_data, null),
    rollback_data: safeJSON<unknown>(row.rollback_data, null),
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Create a new task.
 */
export function createTask(taskData: CreateTaskParams): TaskRow | null {
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
    degraded_data = 0,
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
      rollback_data, approval_mode, degraded_data, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    degraded_data ? 1 : 0,
    now,
    now
  );

  const created = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null);
  audit(business_id, 'task', id, 'create', proposed_by, null, created);

  // Auto-populate target_metric for outcome tracking, then generate the
  // counterfactual estimate ("cost of inaction") so the approver sees it
  // inline in the task description before deciding.
  try {
    import('./outcomes.js').then(async (m) => {
      if (action_type) m.setTaskTargetMetric(id, business_id, action_type);
      try {
        const { generateCounterfactual } = await import('../roi/counterfactual.js');
        await generateCounterfactual(id);
      } catch (err) {
        console.warn('[tasks] counterfactual failed:', (err as Error).message);
      }
    }).catch(() => {});
  } catch {}

  // Brain — fire-and-forget conflict detection against goals + action windows
  (async () => {
    try {
      const { runTaskConflictCheck } = await import('../brain/conflict-engine.js');
      await runTaskConflictCheck(created as unknown as Record<string, unknown>, business_id);
    } catch (err) {
      console.warn('[tasks] Conflict check failed:', (err as Error).message);
    }
  })();

  return created;
}

/**
 * Get a single task by ID.
 */
export function getTask(id: string): TaskRow | null {
  return parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null);
}

/**
 * List tasks for a business with optional filters.
 */
export function listTasks(
  businessId: string,
  filters: {
    status?: string;
    signal_id?: string;
    mission_id?: string;
    proposed_by?: string;
  } = {}
): Array<TaskRow | null> {
  const conditions: string[] = ['business_id = ?'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [businessId];

  if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters.signal_id) { conditions.push('signal_id = ?'); params.push(filters.signal_id); }
  if (filters.mission_id) { conditions.push('mission_id = ?'); params.push(filters.mission_id); }
  if (filters.proposed_by) { conditions.push('proposed_by = ?'); params.push(filters.proposed_by); }

  const where = conditions.join(' AND ');
  return (db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC`).all(...params) as Array<Record<string, unknown>>).map(parseRow);
}

/**
 * Update task status with transition validation.
 */
export function updateTaskStatus(
  id: string,
  newStatus: TaskStatus,
  actor: string,
  metadata: UpdateStatusMetadata = {}
): TaskRow | null {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> & { status: TaskStatus; business_id: string; title: string; trust_tier: string; approval_mode: string; started_at?: string | null } | null;
  if (!existing) throw new Error(`Task '${id}' not found.`);

  const allowed: TaskStatus[] = VALID_TRANSITIONS[existing.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Cannot transition task from '${existing.status}' to '${newStatus}'. Allowed transitions: ${allowed.join(', ') || 'none'}`
    );
  }

  const updates: string[] = ['status = ?', 'updated_at = ?'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const values: any[] = [newStatus, new Date().toISOString()];

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
        try {
          const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
          m.recordActionMemory(task as unknown as Record<string, unknown>);
          // Smart spacing — defer related pending tasks until the window closes
          import('../jobs/constraint-check.js').then((cc) => {
            try { cc.applySmartSpacing(task); } catch {}
          }).catch(() => {});
        }
        catch (err) { console.warn('[brain] recordActionMemory failed:', (err as Error).message); }
      });
    } catch {}
  }

  const before = parseRow(existing);
  const after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null);
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
export function approveTask(id: string, approvedBy: string): TaskRow | null {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> & { status: TaskStatus; business_id: string; title: string; trust_tier: string; approval_mode: string; action_type: string | null } | null;
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
  let after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null);
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
export function rejectTask(id: string, rejectedBy: string, reason = ''): TaskRow | null {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> & { status: TaskStatus; business_id: string } | null;
  if (!existing) throw new Error(`Task '${id}' not found.`);

  const allowedFromStatuses: TaskStatus[] = ['proposed', 'approved'];
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
  const after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null);
  audit(existing.business_id, 'task', id, 'reject', rejectedBy, before, after, { reason });

  return after;
}
