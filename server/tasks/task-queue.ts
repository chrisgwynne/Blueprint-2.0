import db, { generateId, audit } from '../db/db.js';
import { enqueueExecutionJob, getActiveJobForTask, cancelJob as cancelExecutionJob } from './execution-jobs.js';
import { recordDecision } from '../brain/decision-memory.js';
import { getActionRegistryEntry, validateAction, validatePayloadAgainstSchema } from './action-registry.js';
import { getBusinessProfile } from '../business/business-profile.js';
import { createSystemIssue } from '../system/system-issues.js';
import type { Connector } from '../types/db.js';
import type { ValidationIssue } from '../types/action-registry.js';
import { calculateApprovalTier, evaluateApplicability, explainRevenueRelevance, scheduleOutcomeMeasurements } from '../trust/trust-engine.js';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  | 'draft_ready'
  | 'cancelled'
  | 'manual_review';

export interface TaskRow {
  id: string;
  business_id: string;
  signal_id: string | null;
  goal_id: string | null;
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
  version: number;
  approved_payload_snapshot: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskParams {
  business_id: string;
  signal_id?: string | null;
  goal_id?: string | null;
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

// â”€â”€ Internals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  proposed: ['approved', 'rejected', 'cancelled'],
  approved: ['executing', 'rejected', 'cancelled', 'manual_review'],
  // 'approved' here is deliberately narrow: it's ONLY used by
  // execution-worker.ts's recoverStuckJobs() to put a crash-orphaned task
  // (its job's lease expired mid-execution, and the recovery classifier
  // determined a fresh attempt is safe â€” see execution-safety.ts) back at
  // the exact state executeTask()'s own approved-only guard requires
  // before it will run at all. No other code path performs this
  // transition â€” a normal 'executing' task cannot be pushed back to
  // 'approved' by an API call.
  executing: ['complete', 'failed', 'draft_ready', 'blocked', 'manual_review', 'approved'],
  draft_ready: ['complete', 'failed'], // human reviews the draft, then marks complete or rejects
  complete: ['verified'],
  failed: ['proposed'], // allow retry
  blocked: ['proposed', 'failed'],
  rejected: [],
  verified: [],
  deferred: ['proposed', 'rejected'], // Brain may defer; resurface on schedule
  cancelled: [],
  // A crash-recovery-flagged ambiguous outcome (execution-jobs.ts:markManualReview)
  // â€” a human must look at the actual external system and tell Blueprint
  // what happened before anything automated touches this task again.
  manual_review: ['proposed', 'cancelled', 'failed'],
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

function createProposalValidationError(message: string, issues: ValidationIssue[]): Error & { issues: ValidationIssue[]; statusCode: number } {
  const err = new Error(message) as Error & { issues: ValidationIssue[]; statusCode: number };
  err.issues = issues;
  err.statusCode = 400;
  return err;
}
function parseRow(row: Record<string, unknown> | null): TaskRow | null {
  if (!row) return null;
  return {
    ...(row as unknown as TaskRow),
    action_payload: safeJSON<Record<string, unknown>>(row.action_payload, {}),
    outcome_data: safeJSON<unknown>(row.outcome_data, null),
    rollback_data: safeJSON<unknown>(row.rollback_data, null),
    approved_payload_snapshot: safeJSON<Record<string, unknown> | null>(row.approved_payload_snapshot, null),
  };
}

// â”€â”€ Exports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Create a new task.
 */
export function createTask(taskData: CreateTaskParams): TaskRow | null {
  const {
    business_id,
    signal_id = null,
    goal_id = null,
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

  // goal_id is a real FK (Phase 3) â€” reject silently-wrong linkage rather
  // than storing a dangling reference to another business's goal.
  if (goal_id) {
    const goal = db.prepare('SELECT id FROM goals WHERE id = ? AND business_id = ?').get(goal_id, business_id);
    if (!goal) throw new Error(`Goal '${goal_id}' not found for this business.`);
  }

  if (action_type) {
    const entry = getActionRegistryEntry(action_type);
    if (!entry || entry.active === false) {
      const issues: ValidationIssue[] = [{
        code: 'unknown_action_type',
        message: `Action type '${action_type}' is not registered in the Typed Action Registry.`,
      }];
      createSystemIssue({
        business_id,
        issue_type: 'action_validation_failure',
        severity: 'warning',
        title: `Task action '${action_type}' cannot be proposed`,
        description: issues[0]!.message,
        related_action_type: action_type,
        metadata: { stage: 'proposal', issues },
      });
      throw createProposalValidationError(`Task action '${action_type}' cannot be proposed: ${issues[0]!.message}`, issues);
    }

    const payloadIssues = validatePayloadAgainstSchema(entry.payload_schema, action_payload ?? {});
    if (payloadIssues.length > 0) {
      const issues: ValidationIssue[] = [{
        code: 'payload_schema_mismatch',
        message: `action_type '${action_type}' payload does not match its schema: ${payloadIssues.map((issue) => issue.message).join('; ')}`,
      }];
      createSystemIssue({
        business_id,
        issue_type: 'action_validation_failure',
        severity: 'warning',
        title: `Task action '${action_type}' payload cannot be proposed`,
        description: issues[0]!.message,
        related_action_type: action_type,
        metadata: { stage: 'proposal', issues, payload_issues: payloadIssues },
      });
      throw createProposalValidationError(`Task action '${action_type}' cannot be proposed: ${issues[0]!.message}`, issues);
    }
  }

  const applicability = evaluateApplicability({
    businessId: business_id,
    candidateType: 'task',
    candidateKey: action_type ?? title,
    actionType: action_type,
    title,
    description,
    payload: action_payload,
    sourceType: 'task',
    recordSuppression: true,
  });
  if (applicability.status === 'not_applicable') {
    throw new Error(`Task is not actionable: ${applicability.reason}`);
  }
  const risk = calculateApprovalTier({ actionType: action_type, payload: action_payload, baseTier: trust_tier, agentConfidence: confidence, applicabilityStatus: applicability.status });
  const revenue = explainRevenueRelevance(business_id, { title, description, action_type });

  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tasks (
      id, business_id, signal_id, goal_id, mission_id, title, description,
      proposed_by, assigned_to, action_type, action_payload,
      status, trust_tier, priority, confidence, estimated_impact,
      rollback_data, approval_mode, degraded_data, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    business_id,
    signal_id,
    goal_id,
    mission_id,
    title,
    description,
    proposed_by,
    assigned_to,
    action_type,
    JSON.stringify(action_payload),
    risk.tier,
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
  if (created) {
    db.prepare('UPDATE tasks SET applicability_status = ?, applicability_reason = ?, approval_risk_evidence = ?, expected_outcome = ?, updated_at = ? WHERE id = ?')
      .run(applicability.status, applicability.reason, JSON.stringify({ ...risk.evidence, revenue }), revenue.explanation, now, id);
  }
  audit(business_id, 'task', id, 'create', proposed_by, null, created, { applicability, risk, revenue });

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

  // Brain â€” fire-and-forget conflict detection against goals + action windows
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

  // Brain â€” when a task completes, record action memory so the Restraint
  // system knows the measurement window is in flight.
  if (newStatus === 'complete' || newStatus === 'verified') {
    try {
      import('../brain/action-windows.js').then((m) => {
        try {
          const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
          m.recordActionMemory(task as unknown as Record<string, unknown>);
          try { scheduleOutcomeMeasurements(id); } catch (err) { console.warn('[outcomes] phase4 scheduling failed:', (err as Error).message); }
          // Smart spacing â€” defer related pending tasks until the window closes
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

// Lazy import for waking the execution worker immediately after enqueueing
// (avoids circular dependency at startup, same pattern as fireWebhook).
function triggerWorkerTick(): void {
  import('../jobs/scheduler.js')
    .then((m) => { (m as unknown as { runExecutionWorkerTickNow?: () => void }).runExecutionWorkerTickNow?.(); })
    .catch(() => {});
}

/**
 * Approve a task.
 *
 * This is THE canonical approval path â€” the dashboard, BAP, Telegram, and
 * every other surface all call this one function and nothing else (no
 * separate executeTask() call). It atomically:
 *   1. Compare-and-swaps status 'proposed' -> 'approved' (the WHERE
 *      status='proposed' clause is what makes this safe under concurrent
 *      approval attempts â€” e.g. dashboard and Telegram approving the same
 *      task at the same moment: exactly one UPDATE matches a row, the
 *      other sees changes=0 and reports "already approved/not proposed").
 *   2. Bumps the task's version and snapshots action_payload into
 *      approved_payload_snapshot â€” the execution job created in the same
 *      transaction is bound to this exact version/snapshot, so nothing
 *      that happens to the live task row afterwards can change what gets
 *      executed.
 *   3. For typed actions, enqueues exactly one execution_jobs row (enforced
 *      by a unique partial index, not just this function's own logic).
 *      Manual tasks with no action_type remain approved for an operator and
 *      deliberately do not enter the automated worker queue.
 * Trust-tier/approval-mode no longer branches into a separate immediate-
 * execution path (green+auto used to call updateTaskStatus(...,'executing',...)
 * directly here) â€” every approved typed action goes through the same queued
 * job, durable and crash-recoverable. Manual tasks stay approved without a
 * job. For typed actions, the execution worker is woken immediately for low
 * latency, but is not relied upon for correctness: the scheduled worker tick
 * picks up any job the immediate wake-up call missed
 * (e.g. because the process crashed right after this function returned).
 */
export function approveTask(id: string, approvedBy: string): TaskRow | null {
  const existingRaw = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> & { status: TaskStatus; business_id: string; title: string; trust_tier: string; approval_mode: string; action_type: string | null; action_payload: string } | null;
  if (!existingRaw) throw new Error(`Task '${id}' not found.`);
  const existing = parseRow(existingRaw)!;

  // â”€â”€â”€ Typed Action & Executor Registry validation gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // "Before a task can become executable Blueprint must validate: action
  // exists, executor exists, payload matches schema, business type
  // supports action, required connectors exist, connector confidence is
  // acceptable, permissions exist, executor is healthy." Every one of
  // those is a hard block here â€” this runs at the proposeâ†’approve
  // transition (not task creation) since gating creation would break
  // fixtures that build tasks before any connector exists; approval is
  // the actual "becomes executable" moment the spec means. A null
  // action_type (manual to-do) always passes untouched.
  const businessProfile = getBusinessProfile(existing.business_id);

  // â”€â”€â”€ Business Profile automation_policy: daily autonomous-task cap â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // "max_autonomous_tasks_per_day" caps how many tasks Blueprint approves
  // through non-human channels (BAP, Telegram, timed auto-approval) in a
  // calendar day â€” it does not cap what a human explicitly approves
  // through the dashboard, which is always allowed to proceed.
  const dailyCap = businessProfile?.automation_policy?.max_autonomous_tasks_per_day;
  if (dailyCap != null && !approvedBy.startsWith('dashboard:')) {
    const todayCount = (db.prepare(`
      SELECT COUNT(*) as n FROM tasks
      WHERE business_id = ? AND approved_by IS NOT NULL AND approved_by NOT LIKE 'dashboard:%'
        AND approved_at >= datetime('now', 'start of day')
    `).get(existing.business_id) as { n: number }).n;
    if (todayCount >= dailyCap) {
      createSystemIssue({
        business_id: existing.business_id,
        issue_type: 'automation_policy_daily_cap_reached',
        severity: 'warning',
        title: `Task "${existing.title}" cannot be auto-approved â€” daily autonomous task cap reached`,
        description: `automation_policy.max_autonomous_tasks_per_day is ${dailyCap}; ${todayCount} autonomous approval(s) already recorded today. A human can still approve this task via the dashboard.`,
        related_task_id: id,
        related_action_type: existing.action_type,
      });
      throw new Error(
        `Task cannot be approved: this business's automation_policy caps autonomous approvals at ${dailyCap}/day, ` +
        `and ${todayCount} have already been approved today. A human can still approve this task via the dashboard. ` +
        'A Blueprint System Issue has been created explaining why.'
      );
    }
  }

  const approvalApplicability = evaluateApplicability({
    businessId: existing.business_id,
    candidateType: 'task_approval',
    candidateKey: existing.action_type ?? existing.title,
    actionType: existing.action_type,
    title: existing.title,
    description: existing.description,
    payload: existing.action_payload,
    sourceType: 'task_approval',
    sourceId: id,
    recordSuppression: true,
  });
  if (approvalApplicability.status === 'not_applicable') {
    db.prepare('UPDATE tasks SET applicability_status = ?, applicability_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(approvalApplicability.status, approvalApplicability.reason, id);
    throw new Error(`Task cannot be approved: ${approvalApplicability.reason}`);
  }
  const approvalRisk = calculateApprovalTier({ actionType: existing.action_type, payload: existing.action_payload, baseTier: existing.trust_tier, agentConfidence: existing.confidence, applicabilityStatus: approvalApplicability.status });
  db.prepare('UPDATE tasks SET trust_tier = ?, approval_risk_evidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(approvalRisk.tier, JSON.stringify(approvalRisk.evidence), id);

  const connectors = db.prepare('SELECT * FROM connectors WHERE business_id = ?').all(existing.business_id) as Connector[];
  const actionValidation = validateAction({
    actionType: existing.action_type,
    payload: existing.action_payload,
    businessId: existing.business_id,
    businessProfile,
    connectors,
    approvedBy,
  });

  if (!actionValidation.valid) {
    createSystemIssue({
      business_id: existing.business_id,
      issue_type: 'action_validation_failure',
      severity: 'error',
      title: `Task "${existing.title}" cannot be approved â€” action validation failed`,
      description: actionValidation.issues.map((i) => i.message).join(' '),
      related_task_id: id,
      related_action_type: existing.action_type,
      metadata: { issues: actionValidation.issues },
    });
    throw new Error(
      `Task cannot be approved: ${actionValidation.issues.map((i) => i.message).join(' ')} ` +
      'A Blueprint System Issue has been created explaining why.'
    );
  }

  const runApproval = db.transaction(() => {
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE tasks SET
        status = 'approved',
        approved_by = ?,
        approved_at = ?,
        updated_at = ?,
        version = version + 1,
        approved_payload_snapshot = ?
      WHERE id = ? AND status = 'proposed'
    `).run(approvedBy, now, now, JSON.stringify(existing.action_payload ?? {}), id);

    if (!result.changes) {
      // CAS lost â€” re-check current status for an accurate error message.
      const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: TaskStatus };
      throw new Error(`Cannot approve task in status '${current.status}'. Task must be 'proposed'.`);
    }

    const after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>)!;
    if (String(after.action_type ?? '').trim() !== '') {
      enqueueExecutionJob(after);
    }
    return after;
  });

  const after = runApproval();

  audit(existing.business_id, 'task', id, 'approve', approvedBy, existing, after);
  recordDecision({
    business_id: existing.business_id, decision_type: 'task_approval',
    title: `Approved: ${existing.title}`,
    decision: `Approved task "${existing.title}" (${existing.action_type ?? 'no action_type'}).`,
    reasoning: existing.description ?? null,
    confidence: existing.confidence ?? null,
    author: approvedBy, related_task_id: id, related_signal_id: existing.signal_id ?? null,
    related_goal_id: existing.goal_id ?? null,
  });

  fireWebhook('task.approved', {
    task_id: id, business_id: existing.business_id,
    title: existing.title, approved_by: approvedBy,
    action_type: existing.action_type,
  });

  if (String(after.action_type ?? '').trim() !== '') {
    triggerWorkerTick();
  }

  return after;
}

/**
 * Cancel a task that hasn't started executing yet (proposed/approved), or
 * whose execution job is sitting in manual_review awaiting a human
 * decision. A task already 'executing' cannot be cancelled through this
 * path â€” see execution-jobs.ts's job states for why (it may be mid
 * external-write; cancelling blindly would risk exactly the ambiguity
 * this whole framework exists to avoid).
 */
export function cancelTask(id: string, cancelledBy: string, reason = ''): TaskRow | null {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> & { status: TaskStatus; business_id: string } | null;
  if (!existing) throw new Error(`Task '${id}' not found.`);

  const allowedFromStatuses: TaskStatus[] = ['proposed', 'approved', 'manual_review'];
  if (!allowedFromStatuses.includes(existing.status)) {
    throw new Error(`Cannot cancel task in status '${existing.status}'. Task must be 'proposed', 'approved', or 'manual_review'.`);
  }

  const runCancel = db.transaction(() => {
    const result = db.prepare(`
      UPDATE tasks SET status = 'cancelled', rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('proposed', 'approved', 'manual_review')
    `).run(reason, id);
    if (!result.changes) {
      const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: TaskStatus };
      throw new Error(`Cannot cancel task in status '${current.status}'.`);
    }
    const activeJob = getActiveJobForTask(id);
    if (activeJob) cancelExecutionJob(activeJob.id);
    return parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>);
  });

  const after = runCancel();
  audit(existing.business_id as string, 'task', id, 'cancel', cancelledBy, parseRow(existing), after, { reason });
  fireWebhook('task.cancelled', { task_id: id, business_id: existing.business_id, cancelled_by: cancelledBy, reason });
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
  recordDecision({
    business_id: existing.business_id as string, decision_type: 'task_rejection',
    title: `Rejected: ${before?.title ?? id}`,
    decision: `Rejected task "${before?.title ?? id}"${reason ? `: ${reason}` : '.'}`,
    reasoning: reason || null,
    author: rejectedBy, related_task_id: id,
    related_signal_id: (before?.signal_id as string | null) ?? null,
    related_goal_id: (before?.goal_id as string | null) ?? null,
  });

  return after;
}
