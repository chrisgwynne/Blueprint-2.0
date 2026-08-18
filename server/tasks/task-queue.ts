import db, { generateId, audit } from '../db/db.js';
import { enqueueExecutionJob, getActiveJobForTask, cancelJob as cancelExecutionJob } from './execution-jobs.js';
import { recordDecision } from '../brain/decision-memory.js';
import { getActionRegistryEntry, validateAction, validatePayloadAgainstSchema } from './action-registry.js';
import { getBusinessProfile } from '../business/business-profile.js';
import { createSystemIssue } from '../system/system-issues.js';
import type { Connector } from '../types/db.js';
import type { ValidationIssue } from '../types/action-registry.js';
import { calculateApprovalTier, evaluateApplicability, explainRevenueRelevance, scheduleOutcomeMeasurements } from '../trust/trust-engine.js';
import {
  openReceipt, recordPreExecutionRejection, recordCancellation, recordFollowUp, safeReceipt,
} from './action-receipts.js';
import { abandonTrialForTask, activateTrialForTask, recordHiringDecision, releaseProposalSlotForTask } from '../agents/hiring/store.js';
import { effectiveDailyTaskCap, evaluateAutonomyGate, resolveOperatingPolicy, tierRank } from '../policy/operating-policy.js';
import { guardSimulationSideEffect } from '../simulation/simulation-context.js';
import { authorizeFromPreview } from '../simulation/simulation-store.js';

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

/** Options for approveTask(). Additive — every existing caller is unaffected. */
export interface ApproveTaskOptions {
  /**
   * A #67 simulation preview this approval is being made on the strength of.
   * When supplied it is re-validated against live state before anything
   * changes, and approval is refused if the preview has expired, has already
   * been used, or no longer matches the data it was computed from.
   */
  simulationPreviewId?: string | null;
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
  // 'deferred' is reachable from 'proposed' so a human reviewer in the
  // decision centre (#61) can push a proposal to later instead of being
  // forced into a yes/no. The system already produced deferred tasks via
  // jobs/constraint-check.ts's smart spacing, but it wrote the status with
  // raw SQL, bypassing this table — a human deferral goes through
  // updateTaskStatus()/deferTask() like every other transition, and
  // brain/restraint.ts's resurfaceDeferredTasks() picks it back up on the
  // same schedule.
  proposed: ['approved', 'rejected', 'cancelled', 'deferred'],
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

/**
 * The subset of a task an action receipt (#70) needs to identify what was
 * requested. Kept here so every pre-execution rejection site records the
 * same shape without repeating the field list.
 */
function receiptTaskFacts(task: {
  id: string; business_id: string; version?: number; action_type?: string | null;
  title?: string | null; proposed_by?: string | null; created_at?: string | null;
}): { id: string; business_id: string; version: number; action_type: string | null; title: string | null; proposed_by: string | null; created_at: string | null } {
  return {
    id: task.id,
    business_id: task.business_id,
    version: Number(task.version ?? 1) || 1,
    action_type: task.action_type ?? null,
    title: task.title ?? null,
    proposed_by: task.proposed_by ?? null,
    created_at: task.created_at ?? null,
  };
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
  // #67: 'Simulation cannot create tasks'. Enforced at the single function
  // every proposal path in Blueprint funnels through, so a preview cannot
  // create one however indirectly it got here.
  guardSimulationSideEffect(
    'task.create', taskData.action_type ?? null,
    `creating task '${taskData.title}' for business '${taskData.business_id}'`,
  );
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
      // Refuse UP FRONT with a structured 400 — no task row, no system issue.
      // A system issue would accumulate on every proposal attempt for an
      // unregistered type and never resolve; the structured error response IS
      // the caller's signal to fix the action_type, not an issue to diagnose
      // later. System issues are raised at approval time (validateAction) where
      // they relate to a real task that exists but cannot execute.
      const issues: ValidationIssue[] = [{
        code: 'unknown_action_type',
        message: `Action type '${action_type}' is not registered in the Typed Action Registry.`,
      }];
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
  // #68: risk tiering uses this business's Operating Policy thresholds, and
  // the resulting evidence records which policy version produced the tier.
  const proposalPolicy = resolveOperatingPolicy(business_id);
  const risk = calculateApprovalTier({ actionType: action_type, payload: action_payload, baseTier: trust_tier, agentConfidence: confidence, applicabilityStatus: applicability.status, policy: proposalPolicy });
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
 *   3. For typed actions with a real executor.ts dispatch case, enqueues
 *      exactly one execution_jobs row (enforced by a unique partial index,
 *      not just this function's own logic). Manual tasks with no
 *      action_type remain approved for an operator and deliberately do not
 *      enter the automated worker queue. A typed action registered in the
 *      Typed Action Registry but with no executor.ts dispatch case (see
 *      `dispatched_by_executor`) is routed straight to 'manual_review'
 *      instead of being enqueued -- there is no executor to run it, so a
 *      job would only ever be retried and dead-lettered for no reason
 *      (issue #39).
 * Trust-tier/approval-mode no longer branches into a separate immediate-
 * execution path (green+auto used to call updateTaskStatus(...,'executing',...)
 * directly here) â€” every approved typed action goes through the same queued
 * job, durable and crash-recoverable. Manual tasks stay approved without a
 * job. For typed actions, the execution worker is woken immediately for low
 * latency, but is not relied upon for correctness: the scheduled worker tick
 * picks up any job the immediate wake-up call missed
 * (e.g. because the process crashed right after this function returned).
 */
export function approveTask(
  id: string,
  approvedBy: string,
  options: ApproveTaskOptions = {},
): TaskRow | null {
  // #67: approving is the execution step a preview precedes, so it must
  // never itself run inside a simulation. Guarded before anything is read.
  guardSimulationSideEffect('task.approve', id, `approving task '${id}' as '${approvedBy}'`);

  // â”€â”€â”€ Separately authorised execution (#67) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // When this approval is being made ON THE STRENGTH OF a preview, the
  // preview is re-validated against live state FIRST. Not "was a preview
  // shown?" but "is what it showed still true?" â€” if the task was edited,
  // re-tiered, already approved, or the operating policy or connectors
  // moved since, authorisation is refused with a report naming exactly what
  // drifted, and the operator has to preview again.
  //
  // This is the mechanism behind "cannot reuse stale approval silently":
  // silence is impossible, because a drifted snapshot throws rather than
  // proceeding. See server/simulation/simulation-store.ts.
  if (options.simulationPreviewId) {
    const authorization = authorizeFromPreview({
      previewId: options.simulationPreviewId,
      actor: approvedBy,
      expectedKind: 'task_approval',
      expectedTargetId: id,
    });
    if (!authorization.ok) {
      const err = new Error(
        `Task cannot be approved from this preview: ${authorization.message} ` +
        'Approval must be authorised against a current preview, never a stale one.',
      ) as Error & { statusCode: number; code: string; drift: unknown };
      err.statusCode = 409;
      err.code = authorization.reason ?? 'preview_not_current';
      err.drift = authorization.drift;
      throw err;
    }
  }

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

  // â”€â”€â”€ Operating Policy: autonomy limits and approval requirements (#68) â”€â”€â”€â”€
  // THE central policy integration point. The per-business Operating Policy
  // decides whether Blueprint may approve this task on its own: the master
  // autonomy switch, dry-run mode, action types that always need a human,
  // the auto-approval tier ceiling, connector applicability rules, and the
  // daily cap. None of it constrains a human approving through the
  // dashboard — the policy governs what Blueprint does unattended, not what
  // a person chooses to do.
  //
  // The pre-#68 setting, business_profiles.automation_policy
  // .max_autonomous_tasks_per_day, is still honoured: effectiveDailyTaskCap()
  // takes the STRICTER of the two, so an Operating Policy can never quietly
  // loosen a cap an operator already set on the business profile.
  const registryEntry = existing.action_type ? getActionRegistryEntry(existing.action_type) : null;
  const autonomy = evaluateAutonomyGate({
    businessId: existing.business_id,
    approvedBy,
    actionType: existing.action_type,
    tier: (['green', 'yellow', 'orange', 'red'] as const).find((t) => t === existing.trust_tier) ?? null,
    requiredConnectorTypes: registryEntry?.required_connector_types ?? [],
  });
  const effectivePolicy = autonomy.policy;

  if (!autonomy.allowed) {
    createSystemIssue({
      business_id: existing.business_id,
      issue_type: 'operating_policy_blocked_autonomous_approval',
      severity: 'warning',
      title: `Task "${existing.title}" cannot be auto-approved â€” blocked by operating policy`,
      description: autonomy.reason ?? 'Blocked by this business\'s operating policy.',
      related_task_id: id,
      related_action_type: existing.action_type,
      metadata: {
        policy_code: autonomy.code,
        policy_id: effectivePolicy.policy_id,
        policy_version: effectivePolicy.policy_version,
        policy_scope: effectivePolicy.policy_scope,
      },
    });
    throw new Error(
      `Task cannot be approved: ${autonomy.reason} ` +
      'A Blueprint System Issue has been created explaining why.'
    );
  }

  const { cap: dailyCap, source: capSource } = effectiveDailyTaskCap(
    effectivePolicy,
    businessProfile?.automation_policy?.max_autonomous_tasks_per_day ?? null,
  );
  if (dailyCap != null && !approvedBy.startsWith('dashboard:')) {
    const todayCount = (db.prepare(`
      SELECT COUNT(*) as n FROM tasks
      WHERE business_id = ? AND approved_by IS NOT NULL AND approved_by NOT LIKE 'dashboard:%'
        AND approved_at >= datetime('now', 'start of day')
    `).get(existing.business_id) as { n: number }).n;
    if (todayCount >= dailyCap) {
      const capLabel = capSource === 'operating_policy'
        ? `operating policy autonomy.max_autonomous_tasks_per_day (${effectivePolicy.citation})`
        : 'automation_policy.max_autonomous_tasks_per_day';
      createSystemIssue({
        business_id: existing.business_id,
        issue_type: 'automation_policy_daily_cap_reached',
        severity: 'warning',
        title: `Task "${existing.title}" cannot be auto-approved â€” daily autonomous task cap reached`,
        description: `${capLabel} is ${dailyCap}; ${todayCount} autonomous approval(s) already recorded today. A human can still approve this task via the dashboard.`,
        related_task_id: id,
        related_action_type: existing.action_type,
        metadata: {
          cap: dailyCap, cap_source: capSource, approved_today: todayCount,
          policy_id: effectivePolicy.policy_id,
          policy_version: effectivePolicy.policy_version,
          policy_scope: effectivePolicy.policy_scope,
        },
      });
      safeReceipt(() => recordPreExecutionRejection({
        task: receiptTaskFacts(existing),
        stage: 'automation_policy_cap',
        reason:
          `automation_policy.max_autonomous_tasks_per_day is ${dailyCap}; ${todayCount} autonomous approval(s) ` +
          'already recorded today, so this action was never authorized or executed.',
        actor: approvedBy,
        evidence: { daily_cap: dailyCap, approvals_today: todayCount },
      }));
      throw new Error(
        `Task cannot be approved: this business's automation_policy caps autonomous approvals at ${dailyCap}/day ` +
        `(from ${capLabel}), and ${todayCount} have already been approved today. ` +
        'A human can still approve this task via the dashboard. ' +
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
    safeReceipt(() => recordPreExecutionRejection({
      task: receiptTaskFacts(existing),
      stage: 'applicability',
      reason: `Not applicable to this business: ${approvalApplicability.reason}`,
      actor: approvedBy,
      evidence: { applicability_status: approvalApplicability.status },
    }));
    throw new Error(`Task cannot be approved: ${approvalApplicability.reason}`);
  }
  const approvalRisk = calculateApprovalTier({ actionType: existing.action_type, payload: existing.action_payload, baseTier: existing.trust_tier, agentConfidence: existing.confidence, applicabilityStatus: approvalApplicability.status, policy: effectivePolicy });
  db.prepare('UPDATE tasks SET trust_tier = ?, approval_risk_evidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(approvalRisk.tier, JSON.stringify(approvalRisk.evidence), id);

  // Re-check the auto-approval ceiling against the tier just recalculated:
  // applicability or payload may have escalated the task since it was
  // proposed, and the gate above only saw the stored tier.
  if (!approvedBy.startsWith('dashboard:')
      && effectivePolicy.document.approvals.auto_approve_max_tier !== null
      && tierRank(approvalRisk.tier) > tierRank(effectivePolicy.document.approvals.auto_approve_max_tier)) {
    createSystemIssue({
      business_id: existing.business_id,
      issue_type: 'operating_policy_blocked_autonomous_approval',
      severity: 'warning',
      title: `Task "${existing.title}" cannot be auto-approved â€” risk tier above policy ceiling`,
      description: `Re-evaluated approval tier is '${approvalRisk.tier}', above approvals.auto_approve_max_tier '${effectivePolicy.document.approvals.auto_approve_max_tier}'.`,
      related_task_id: id,
      related_action_type: existing.action_type,
      metadata: {
        policy_code: 'tier_above_auto_approve_ceiling',
        recalculated_tier: approvalRisk.tier,
        policy_id: effectivePolicy.policy_id,
        policy_version: effectivePolicy.policy_version,
        policy_scope: effectivePolicy.policy_scope,
      },
    });
    throw new Error(
      `Task cannot be approved: its re-evaluated approval tier is '${approvalRisk.tier}', above this business's ` +
      `approvals.auto_approve_max_tier of '${effectivePolicy.document.approvals.auto_approve_max_tier}'. ` +
      `A human can still approve this task via the dashboard. (effective ${effectivePolicy.citation}) ` +
      'A Blueprint System Issue has been created explaining why.'
    );
  }

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
    safeReceipt(() => recordPreExecutionRejection({
      task: receiptTaskFacts(existing),
      stage: 'action_validation',
      reason: actionValidation.issues.map((i) => i.message).join(' '),
      actor: approvedBy,
      evidence: { issues: actionValidation.issues },
    }));
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

    // Approving a hire starts the clock on its bounded trial (#51) and
    // records the positive decision alongside the negative ones, so the
    // engine's memory covers both directions (#50). Same transaction as the
    // status change — an approved hire always has a live trial to judge it by.
    if (existing.action_type === 'hire_agent') {
      const templateId = (existing.action_payload as { template_id?: unknown })?.template_id;
      if (typeof templateId === 'string' && templateId) {
        recordHiringDecision({
          businessId: existing.business_id,
          templateId,
          decision: 'approved',
          actor: approvedBy,
          reason: 'Hire proposal approved.',
          taskId: id,
          analysisId: typeof (existing.action_payload as { analysis_id?: unknown })?.analysis_id === 'string'
            ? (existing.action_payload as { analysis_id: string }).analysis_id : null,
          evidenceFingerprint: typeof (existing.action_payload as { evidence_fingerprint?: unknown })?.evidence_fingerprint === 'string'
            ? (existing.action_payload as { evidence_fingerprint: string }).evidence_fingerprint : null,
          disposition: 'changed_circumstances',
          reconsiderPolicy: 'new_evidence',
        });
        activateTrialForTask(existing.business_id, id);
      }
    }

    const after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>)!;
    const actionType = String(after.action_type ?? '').trim();

    // Verified action receipt (#70) — opened in the SAME transaction as the
    // approval itself, exactly like the execution job above it, so an
    // approved action can never exist without a receipt recording who
    // authorized it and when. The receipt is keyed on the freshly-bumped
    // version, which is also the idempotency marker every retry and every
    // externally-created object for this approval will carry.
    const receipt = openReceipt({
      task: {
        id: after.id, business_id: after.business_id, version: after.version,
        action_type: after.action_type, title: after.title,
        proposed_by: after.proposed_by, created_at: after.created_at,
      },
      authorizedBy: approvedBy,
    });

    if (actionType !== '') {
      // Issue #39: `actionValidation.entry.dispatched_by_executor` mirrors
      // executor.ts's EXECUTABLE_ACTION_TYPES set 1:1 (see db.ts migration
      // notes) -- it's the executable check available here without a
      // task-queue.ts -> executor.ts -> task-queue.ts import cycle. An
      // action_type can pass every other validateAction() gate (registered,
      // right business type, connectors present, payload valid) yet still
      // have no real executor.ts dispatch case (e.g. `product_suggestion`,
      // `page_optimisation`) -- enqueueing a job for those would only ever
      // produce pointless retry churn: the worker claims it, executeTask()
      // rejects it as not executable, and it cycles back to 'queued' with
      // an incremented attempt_count until it dead-letters for no reason.
      // Route straight to manual_review instead -- no job, no retry budget
      // spent on something that can never succeed on its own.
      //
      // One exception: `side_effect_classification === 'external_verifiable'`
      // action types with no dispatch case (currently only `scheduled_workflow`,
      // issue #37) aren't orphaned -- they're deliberately never executed by
      // Blueprint at all. An external system (e.g. Hermes) performs and
      // verifies the work itself; Blueprint's job is only to record that a
      // human approved it. Routing those to manual_review would misrepresent
      // already-complete external tracking as something still needing
      // operator attention, so they stay 'approved' with no job, same as a
      // plain manual (action_type-less) task.
      if (actionValidation.entry?.dispatched_by_executor) {
        const job = enqueueExecutionJob(after);
        if (receipt) {
          db.prepare('UPDATE action_receipts SET execution_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(job.id, receipt.id);
        }
      } else if (actionValidation.entry?.side_effect_classification === 'external_verifiable') {
        // No-op: task remains 'approved', tracked but not queued for
        // Blueprint execution or manual review. The receipt records the
        // authorization and says plainly that Blueprint is not the executor
        // — otherwise a receipt stuck at 'authorized' forever would read as
        // a stalled action rather than an intentional hand-off.
        recordFollowUp(after.id, Number(after.version ?? 1), {
          notes: [
            `action_type '${actionType}' is executed and verified by an external system, not by Blueprint. ` +
            'This receipt records the authorization only.',
          ],
        });
      } else {
        const reason =
          `action_type '${actionType}' is registered in the Typed Action Registry but has no executor ` +
          'implementation -- routed directly to manual review instead of being queued for automated execution.';
        // Nothing will ever execute this: an explicit pre-execution
        // rejection record, not a receipt left dangling at 'authorized'.
        recordPreExecutionRejection({
          task: {
            id: after.id, business_id: after.business_id, version: after.version,
            action_type: after.action_type, title: after.title,
            proposed_by: after.proposed_by, created_at: after.created_at,
          },
          stage: 'no_executor',
          reason,
          actor: 'system:action-registry',
        });
        return updateTaskStatus(id, 'manual_review', 'system:action-registry', { outcome: reason })!;
      }
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
    // Cite the exact policy version the gating above used, not a fresh
    // resolve — a policy activating mid-approval must not make the record
    // claim a version that was not actually applied (#68).
    effective_policy_id: effectivePolicy.policy_id,
    effective_policy_version: effectivePolicy.policy_version,
    effective_policy_scope: effectivePolicy.policy_scope,
    evidence: [{
      type: 'operating_policy',
      citation: effectivePolicy.citation,
      approval_tier: approvalRisk.tier,
      auto_approve_max_tier: effectivePolicy.document.approvals.auto_approve_max_tier,
      thresholds_applied: effectivePolicy.document.thresholds,
    }],
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
  // A cancelled action stops mattering as "pending"; the receipt records
  // that it never completed rather than being quietly dropped.
  safeReceipt(() => recordCancellation(
    id, Number((existing.version as number | undefined) ?? 1) || 1, cancelledBy,
    reason || 'Cancelled before execution completed.',
  ));
  audit(existing.business_id as string, 'task', id, 'cancel', cancelledBy, parseRow(existing), after, { reason });
  fireWebhook('task.cancelled', { task_id: id, business_id: existing.business_id, cancelled_by: cancelledBy, reason });
  return after;
}

/**
 * Options for rejecting a hire proposal. These map onto the durable hiring
 * suppression record (#44) so the operator's "no" is a decision the engine
 * remembers, not just a status change on one task.
 */
export interface RejectOptions {
  /**
   * How binding the rejection is:
   *   'hard_suppression'      — never re-propose until a human clears it
   *   'temporary_deferral'    — re-propose after `expiresAt`
   *   'changed_circumstances' — re-propose only on materially new evidence (default)
   */
  disposition?: 'hard_suppression' | 'temporary_deferral' | 'changed_circumstances';
  reconsiderPolicy?: 'never' | 'after_expiry' | 'new_evidence';
  expiresAt?: string | null;
}

/**
 * Reject a task with an optional reason.
 *
 * For `hire_agent` tasks the status change and the durable hiring-suppression
 * record are written in ONE transaction (#44). Before this, rejecting a hire
 * proposal left no trace the hiring engine could see: its dedup only looked at
 * tasks still in 'proposed'/'approved', so the next analysis re-proposed the
 * role the operator had just declined, forever.
 */
export function rejectTask(id: string, rejectedBy: string, reason = '', opts: RejectOptions = {}): TaskRow | null {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> & { status: TaskStatus; business_id: string } | null;
  if (!existing) throw new Error(`Task '${id}' not found.`);

  const allowedFromStatuses: TaskStatus[] = ['proposed', 'approved'];
  if (!allowedFromStatuses.includes(existing.status)) {
    throw new Error(`Cannot reject task in status '${existing.status}'. Task must be 'proposed' or 'approved'.`);
  }

  const now = new Date().toISOString();
  const payload = safeJSON<Record<string, unknown>>(existing.action_payload, {});
  const isHire = existing.action_type === 'hire_agent';
  const templateId = typeof payload.template_id === 'string' ? payload.template_id : null;

  const runReject = db.transaction(() => {
    const res = db.prepare(`
      UPDATE tasks SET
        status = 'rejected',
        rejection_reason = ?,
        updated_at = ?
      WHERE id = ? AND status IN ('proposed', 'approved')
    `).run(reason, now, id);
    if (!res.changes) {
      const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: TaskStatus };
      throw new Error(`Cannot reject task in status '${current.status}'.`);
    }

    if (isHire && templateId) {
      recordHiringDecision({
        businessId: existing.business_id as string,
        templateId,
        decision: 'rejected',
        actor: rejectedBy,
        reason: reason || null,
        taskId: id,
        analysisId: typeof payload.analysis_id === 'string' ? payload.analysis_id : null,
        // The evidence snapshot the proposal was built from. A later analysis
        // must produce a DIFFERENT fingerprint before this role is eligible
        // again — that is what "new evidence" means concretely (#50).
        evidenceFingerprint: typeof payload.evidence_fingerprint === 'string' ? payload.evidence_fingerprint : null,
        disposition: opts.disposition ?? 'changed_circumstances',
        reconsiderPolicy: opts.reconsiderPolicy ?? 'new_evidence',
        expiresAt: opts.expiresAt ?? null,
        metadata: { task_title: existing.title ?? null },
      });
      // Any trial planned for this hire never happened.
      abandonTrialForTask(existing.business_id as string, id, reason || 'Hire proposal rejected.');
      // Free the concurrency slot this proposal held. Whether the role can be
      // proposed again is now governed by the suppression record above, not by
      // a leftover idempotency key.
      releaseProposalSlotForTask(existing.business_id as string, id);
    }
  });
  runReject();

  // An explicit pre-execution rejection record (#70): a human said no, so
  // the action provably never ran. Recorded for a task rejected while still
  // 'proposed' as well as one rejected after approval — in the latter case
  // it settles the receipt approval already opened.
  safeReceipt(() => recordPreExecutionRejection({
    task: receiptTaskFacts({
      id,
      business_id: existing.business_id as string,
      version: existing.version as number | undefined,
      action_type: existing.action_type as string | null,
      title: existing.title as string | null,
      proposed_by: existing.proposed_by as string | null,
      created_at: existing.created_at as string | null,
    }),
    stage: 'human_rejection',
    reason: reason || 'Rejected by a human reviewer before execution.',
    actor: rejectedBy,
  }));

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

/**
 * Defer a proposal to a later date — the decision centre's "not now" (#61).
 *
 * A reviewer who is neither ready to approve nor willing to reject needs an
 * outcome that is honest about that, instead of leaving the item to rot in
 * the queue or rejecting something they actually want later. The task moves
 * to 'deferred' with the resurface date the reviewer chose, and
 * brain/restraint.ts's resurfaceDeferredTasks() puts it back into 'proposed'
 * when that date passes — the same machinery the system's own smart-spacing
 * deferrals already use, so there is no second scheduler to maintain.
 *
 * The deferral is a recorded decision like any other, so it carries the
 * operating policy version in force (#68) via recordDecision().
 */
export function deferTask(
  id: string,
  deferredBy: string,
  reason: string,
  deferUntil: string,
): TaskRow | null {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> & { status: TaskStatus; business_id: string; title: string } | null;
  if (!existing) throw new Error(`Task '${id}' not found.`);
  if (existing.status !== 'proposed') {
    throw new Error(`Cannot defer task in status '${existing.status}'. Task must be 'proposed'.`);
  }
  if (!reason || !reason.trim()) {
    throw new Error('A deferral reason is required: a decision to postpone is still a decision, and it is recorded as one.');
  }
  const until = new Date(deferUntil);
  if (Number.isNaN(until.getTime())) {
    throw new Error(`defer_until '${deferUntil}' is not a valid ISO-8601 timestamp (e.g. 2026-09-01T09:00:00.000Z).`);
  }
  if (until.getTime() <= Date.now()) {
    throw new Error('defer_until must be in the future — a deferral to a past date would resurface immediately.');
  }

  const before = parseRow(existing);
  db.prepare(`
    UPDATE tasks SET
      status = 'deferred', deferred_until = ?, deferred_reason = ?, deferred_by = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'proposed'
  `).run(until.toISOString(), reason.trim(), deferredBy, id);
  const after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null);

  audit(existing.business_id, 'task', id, 'defer', deferredBy, before, after, { reason, defer_until: until.toISOString() });
  recordDecision({
    business_id: existing.business_id,
    decision_type: 'task_deferral',
    title: `Deferred: ${existing.title}`,
    decision: `Deferred task "${existing.title}" until ${until.toISOString()}: ${reason.trim()}`,
    reasoning: reason.trim(),
    author: deferredBy,
    related_task_id: id,
    related_signal_id: (before?.signal_id as string | null) ?? null,
    related_goal_id: (before?.goal_id as string | null) ?? null,
    evidence: [{ type: 'deferral', defer_until: until.toISOString(), deferred_by: deferredBy }],
  });
  return after;
}

/**
 * Amend a proposal's payload before approving it — the decision centre's
 * "yes, but not like that" (#61).
 *
 * Approve-with-modification only means something if the modification is
 * visible afterwards, so the payload as proposed is preserved in
 * pre_amendment_payload and the change is recorded as its own decision.
 * The amendment is deliberately NOT an approval: the caller approves
 * separately through approveTask(), which re-runs the full gate — payload
 * validation, applicability and the risk-tier calculation — against the
 * amended payload. A human edit therefore cannot smuggle a payload past
 * the checks the original proposal had to pass.
 */
export function amendTaskPayload(
  id: string,
  amendedBy: string,
  amendedPayload: Record<string, unknown>,
  reason: string,
): TaskRow | null {
  const existingRaw = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> & { status: TaskStatus; business_id: string; title: string } | null;
  if (!existingRaw) throw new Error(`Task '${id}' not found.`);
  const existing = parseRow(existingRaw)!;
  if (existing.status !== 'proposed') {
    throw new Error(`Cannot amend task in status '${existing.status}'. Task must be 'proposed'.`);
  }
  if (!reason || !reason.trim()) {
    throw new Error('An amendment reason is required: changing what an agent proposed is a decision, and it is recorded as one.');
  }
  if (!amendedPayload || typeof amendedPayload !== 'object' || Array.isArray(amendedPayload)) {
    throw new Error('amended_payload must be a JSON object.');
  }

  // Validate the amended payload against the action's registered schema
  // before it is stored, so a malformed human edit is rejected at the point
  // it is made rather than surfacing later at approval time.
  if (existing.action_type) {
    const entry = getActionRegistryEntry(existing.action_type);
    if (entry) {
      const issues = validatePayloadAgainstSchema(entry.payload_schema, amendedPayload);
      if (issues.length > 0) {
        throw new Error(
          `Amended payload is not valid for action type '${existing.action_type}': ` +
          issues.map((i) => i.message).join(' ')
        );
      }
    }
  }

  const originalPayload = existing.action_payload ?? {};
  db.prepare(`
    UPDATE tasks SET
      action_payload = ?,
      pre_amendment_payload = COALESCE(pre_amendment_payload, ?),
      amended_by = ?, amended_at = CURRENT_TIMESTAMP,
      version = version + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'proposed'
  `).run(JSON.stringify(amendedPayload), JSON.stringify(originalPayload), amendedBy, id);
  const after = parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null);

  audit(existing.business_id, 'task', id, 'amend', amendedBy, existing, after, { reason });
  recordDecision({
    business_id: existing.business_id,
    decision_type: 'task_amendment',
    title: `Amended: ${existing.title}`,
    decision: `Amended the proposed payload of task "${existing.title}" before review: ${reason.trim()}`,
    reasoning: reason.trim(),
    author: amendedBy,
    related_task_id: id,
    related_signal_id: existing.signal_id ?? null,
    related_goal_id: existing.goal_id ?? null,
    evidence: [{
      type: 'payload_amendment',
      payload_as_proposed: originalPayload,
      payload_as_amended: amendedPayload,
      amended_by: amendedBy,
    }],
  });
  return after;
}
