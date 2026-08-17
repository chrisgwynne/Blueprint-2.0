/**
 * Playbook version lifecycle (issue #74).
 *
 * Deliberately a copy of the shape operating-policy.ts (#68) already
 * established for a versioned, business-scoped, auditable document, rather
 * than a second lifecycle model for operators to learn:
 *
 *   draft       — authored, editable-by-superseding, never runnable.
 *   scheduled   — validated and accepted, effective_at is in the future.
 *   active      — the one version new runs bind to. At most one per
 *                 workflow, enforced by a partial unique index in db.ts.
 *   superseded  — replaced by a later version, or a cancelled schedule.
 *                 Kept forever: history is never rewound or deleted.
 *
 * Versions are immutable once written. An edit, a schedule and a rollback
 * are all "version N+1 with a different `source`" — which is what makes
 * "what did this playbook say when run X executed?" answerable, and what
 * lets an in-flight run keep executing the version it started on while a
 * newer version is activated underneath it (playbook-engine.ts binds each
 * run to `playbook_version_id` at start and never re-reads the active
 * version mid-run).
 *
 * Business scope is enforced on EVERY read and write: a version is
 * addressed by (workflow_id, business_id, version), so business B can
 * neither read, validate, activate nor run business A's playbook — it gets
 * a not-found, not someone else's definition.
 */
import db, { generateId, audit } from '../db/db.js';
import { getBusinessProfile } from '../business/business-profile.js';
import {
  type PlaybookDefinition, type PlaybookViolation,
  PlaybookValidationError, parsePlaybookDefinition, validatePlaybookDefinition,
} from './playbook-schema.js';

export type PlaybookVersionState = 'draft' | 'scheduled' | 'active' | 'superseded' | 'archived';
export type PlaybookValidationState = 'unvalidated' | 'valid' | 'invalid';
export type PlaybookVersionSource = 'edit' | 'rollback' | 'seed' | 'import';

export interface PlaybookVersion {
  id: string;
  workflow_id: string;
  business_id: string;
  version: number;
  state: PlaybookVersionState;
  definition: PlaybookDefinition;
  validation_state: PlaybookValidationState;
  validation_violations: PlaybookViolation[];
  validated_at: string | null;
  validated_by: string | null;
  effective_at: string | null;
  activated_at: string | null;
  superseded_at: string | null;
  superseded_by_id: string | null;
  source: PlaybookVersionSource;
  rolled_back_from_version: number | null;
  change_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type PlaybookEventType =
  | 'draft_created' | 'validated' | 'validation_failed' | 'scheduled' | 'activated'
  | 'superseded' | 'schedule_cancelled' | 'rolled_back' | 'archived'
  | 'run_started' | 'run_reused' | 'run_step_dispatched' | 'run_step_approved'
  | 'run_step_completed' | 'run_step_failed' | 'run_stopped' | 'run_completed'
  | 'run_rolled_back' | 'run_step_skipped';

export class PlaybookNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) { super(message); this.name = 'PlaybookNotFoundError'; }
}

export class PlaybookStateError extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = 'PlaybookStateError'; }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function safeParse<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function parseVersionRow(row: Record<string, unknown> | null | undefined): PlaybookVersion | null {
  if (!row) return null;
  const businessId = String(row.business_id);
  return {
    ...(row as unknown as PlaybookVersion),
    definition: parsePlaybookDefinition(safeParse<unknown>(row.definition, {}), businessId),
    validation_violations: safeParse<PlaybookViolation[]>(row.validation_violations, []),
  };
}

// ─── Scope ───────────────────────────────────────────────────────────────────

export interface WorkflowRef { workflowId: string; businessId: string }

interface WorkflowRow { id: string; business_id: string; name: string; status: string }

/**
 * Resolve the workflow this playbook versions, scoped to the business
 * asking. A workflow that exists but belongs to another business is
 * reported as not found — the caller learns nothing about it, which is the
 * point of scope isolation.
 */
export function requireWorkflow(ref: WorkflowRef): WorkflowRow {
  const row = db.prepare('SELECT id, business_id, name, status FROM workflows WHERE id = ? AND business_id = ?')
    .get(ref.workflowId, ref.businessId) as WorkflowRow | null;
  if (!row) {
    throw new PlaybookNotFoundError(
      `Workflow '${ref.workflowId}' was not found for business '${ref.businessId}'. ` +
      'A playbook belongs to exactly one business and cannot be addressed from another.',
    );
  }
  return row;
}

function businessTypeOf(businessId: string): string | null {
  try { return getBusinessProfile(businessId)?.business_type ?? null; }
  catch { return null; }
}

// ─── Audit trail ─────────────────────────────────────────────────────────────

export function recordPlaybookEvent(input: {
  playbookVersionId: string | null;
  workflowId: string;
  businessId: string;
  version: number;
  eventType: PlaybookEventType;
  actor: string;
  reason?: string | null;
  runId?: string | null;
  stepIndex?: number | null;
  metadata?: unknown;
}): void {
  db.prepare(`
    INSERT INTO playbook_events (
      id, playbook_version_id, workflow_id, business_id, version, event_type,
      actor, reason, run_id, step_index, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    generateId(), input.playbookVersionId, input.workflowId, input.businessId,
    input.version, input.eventType, input.actor, input.reason ?? null,
    input.runId ?? null, input.stepIndex ?? null, JSON.stringify(input.metadata ?? {}),
  );
}

export function listPlaybookEvents(ref: WorkflowRef, limit = 200): Array<Record<string, unknown>> {
  requireWorkflow(ref);
  const rows = db.prepare(`
    SELECT * FROM playbook_events
     WHERE workflow_id = ? AND business_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(ref.workflowId, ref.businessId, Math.min(500, Math.max(1, limit))) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...r, metadata: safeParse(r.metadata, {}) }));
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listPlaybookVersions(ref: WorkflowRef): PlaybookVersion[] {
  requireWorkflow(ref);
  return (db.prepare(
    'SELECT * FROM playbook_versions WHERE workflow_id = ? AND business_id = ? ORDER BY version DESC',
  ).all(ref.workflowId, ref.businessId) as Array<Record<string, unknown>>).map((r) => parseVersionRow(r)!);
}

export function getPlaybookVersion(ref: WorkflowRef, version: number): PlaybookVersion | null {
  requireWorkflow(ref);
  return parseVersionRow(db.prepare(
    'SELECT * FROM playbook_versions WHERE workflow_id = ? AND business_id = ? AND version = ?',
  ).get(ref.workflowId, ref.businessId, version) as Record<string, unknown> | null);
}

/** Look up a version by its own id, still scoped — used to re-read the version an in-flight run is bound to. */
export function getPlaybookVersionById(id: string, businessId: string): PlaybookVersion | null {
  return parseVersionRow(db.prepare(
    'SELECT * FROM playbook_versions WHERE id = ? AND business_id = ?',
  ).get(id, businessId) as Record<string, unknown> | null);
}

function maxVersion(ref: WorkflowRef): number {
  const row = db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM playbook_versions WHERE workflow_id = ?',
  ).get(ref.workflowId) as { v: number };
  return Number(row.v ?? 0);
}

/**
 * Flip every scheduled version whose effective_at has arrived to 'active'.
 * Lazy activation on read (activateDuePolicies's approach) rather than a
 * scheduler job: a playbook scheduled for 09:00 takes effect at the first
 * run started after 09:00 whether or not a background worker is alive.
 */
export function activateDuePlaybooks(ref?: WorkflowRef): number {
  const params: string[] = [new Date().toISOString()];
  let where = "state = 'scheduled' AND effective_at IS NOT NULL AND effective_at <= ?";
  if (ref) { where += ' AND workflow_id = ? AND business_id = ?'; params.push(ref.workflowId, ref.businessId); }

  const due = db.prepare(
    `SELECT * FROM playbook_versions WHERE ${where} ORDER BY effective_at ASC, version ASC`,
  ).all(...params) as Array<Record<string, unknown>>;
  if (due.length === 0) return 0;

  let activated = 0;
  db.transaction(() => {
    for (const raw of due) {
      const version = parseVersionRow(raw)!;
      // Re-read under the transaction: a concurrent activation may already
      // have moved this row on.
      const current = db.prepare('SELECT state FROM playbook_versions WHERE id = ?').get(version.id) as { state: string } | null;
      if (!current || current.state !== 'scheduled') continue;
      supersedeActive(version.workflow_id, version.id, 'system:playbook-activation', version.version);
      db.prepare(
        "UPDATE playbook_versions SET state = 'active', activated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).run(version.id);
      recordPlaybookEvent({
        playbookVersionId: version.id, workflowId: version.workflow_id, businessId: version.business_id,
        version: version.version, eventType: 'activated', actor: 'system:playbook-activation',
        reason: `Scheduled effective_at ${version.effective_at} reached.`,
      });
      activated++;
    }
  })();
  return activated;
}

/** The active version for a workflow, after settling any due activations. */
export function getActivePlaybookVersion(ref: WorkflowRef): PlaybookVersion | null {
  requireWorkflow(ref);
  activateDuePlaybooks(ref);
  return parseVersionRow(db.prepare(
    "SELECT * FROM playbook_versions WHERE workflow_id = ? AND business_id = ? AND state = 'active'",
  ).get(ref.workflowId, ref.businessId) as Record<string, unknown> | null);
}

function supersedeActive(workflowId: string, replacementId: string, actor: string, replacementVersion: number): void {
  const previous = parseVersionRow(db.prepare(
    "SELECT * FROM playbook_versions WHERE workflow_id = ? AND state = 'active'",
  ).get(workflowId) as Record<string, unknown> | null);
  if (!previous) return;
  db.prepare(`
    UPDATE playbook_versions
       SET state = 'superseded', superseded_at = CURRENT_TIMESTAMP, superseded_by_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND state = 'active'
  `).run(replacementId, previous.id);
  recordPlaybookEvent({
    playbookVersionId: previous.id, workflowId, businessId: previous.business_id,
    version: previous.version, eventType: 'superseded', actor,
    reason: `Superseded by version ${replacementVersion}.`,
  });
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface SavePlaybookDraftInput {
  workflowId: string;
  businessId: string;
  /** Raw definition JSON; coerced and (separately) validated. */
  definition: unknown;
  actor: string;
  change_reason?: string | null;
  /**
   * Optimistic concurrency: the version the author was editing from. If the
   * playbook has moved on, the draft is rejected rather than quietly
   * branching off stale content.
   */
  base_version?: number | null;
  source?: PlaybookVersionSource;
  rolled_back_from_version?: number | null;
  /** Validate immediately and store the result (the API's create+validate path). */
  validate?: boolean;
}

/**
 * Write a new DRAFT version. Never mutates an existing row and never
 * activates anything: authoring and taking effect are separate acts, so a
 * half-finished edit cannot change what runs today.
 *
 * A draft is stored even when it does not validate — with its violations
 * recorded — because "here is my broken draft and here is exactly what is
 * wrong with it" is more useful than refusing to save.
 */
export function savePlaybookDraft(input: SavePlaybookDraftInput): PlaybookVersion {
  const ref: WorkflowRef = { workflowId: input.workflowId, businessId: input.businessId };
  requireWorkflow(ref);

  const latest = listPlaybookVersions(ref)[0] ?? null;
  if (input.base_version != null && latest && latest.version !== input.base_version) {
    throw new PlaybookStateError(
      `This playbook has changed since your edit began: you are editing from version ${input.base_version} ` +
      `but the latest version is ${latest.version}. Reload the playbook and re-apply your change.`,
    );
  }

  const definition = parsePlaybookDefinition(input.definition, input.businessId);
  const version = maxVersion(ref) + 1;
  const id = generateId();

  const violations = input.validate
    ? validatePlaybookDefinition(definition, {
        businessId: input.businessId, businessType: businessTypeOf(input.businessId),
      })
    : null;

  db.prepare(`
    INSERT INTO playbook_versions (
      id, workflow_id, business_id, version, state, definition,
      validation_state, validation_violations, validated_at, validated_by,
      source, rolled_back_from_version, change_reason, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, input.workflowId, input.businessId, version, JSON.stringify(definition),
    violations == null ? 'unvalidated' : (violations.length === 0 ? 'valid' : 'invalid'),
    JSON.stringify(violations ?? []),
    violations == null ? null : new Date().toISOString(),
    violations == null ? null : input.actor,
    input.source ?? 'edit', input.rolled_back_from_version ?? null,
    input.change_reason ?? null, input.actor,
  );

  recordPlaybookEvent({
    playbookVersionId: id, workflowId: input.workflowId, businessId: input.businessId,
    version, eventType: 'draft_created', actor: input.actor, reason: input.change_reason ?? null,
    metadata: { source: input.source ?? 'edit', step_count: definition.steps.length },
  });
  audit(input.businessId, 'playbook_version', id, 'draft', input.actor, null, definition,
    { workflow_id: input.workflowId, version });

  return getPlaybookVersion(ref, version)!;
}

export interface PlaybookValidationResult {
  valid: boolean;
  version: number;
  violations: PlaybookViolation[];
}

/**
 * Validate a stored version against the registry and business as they are
 * NOW, and record the verdict on the row. Re-validating an already-active
 * version is legitimate and useful: an action type deactivated since
 * activation should surface as a problem, not stay hidden behind a stale
 * "valid" stamp.
 */
export function validatePlaybookVersion(
  ref: WorkflowRef, version: number, actor: string,
): PlaybookValidationResult {
  const stored = getPlaybookVersion(ref, version);
  if (!stored) {
    throw new PlaybookNotFoundError(
      `Version ${version} does not exist for this playbook. ` +
      `Available versions: ${listPlaybookVersions(ref).map((v) => v.version).join(', ') || 'none'}.`,
    );
  }

  const violations = validatePlaybookDefinition(stored.definition, {
    businessId: ref.businessId, businessType: businessTypeOf(ref.businessId),
  });
  const valid = violations.length === 0;

  db.prepare(`
    UPDATE playbook_versions
       SET validation_state = ?, validation_violations = ?, validated_at = CURRENT_TIMESTAMP,
           validated_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(valid ? 'valid' : 'invalid', JSON.stringify(violations), actor, stored.id);

  recordPlaybookEvent({
    playbookVersionId: stored.id, workflowId: ref.workflowId, businessId: ref.businessId,
    version, eventType: valid ? 'validated' : 'validation_failed', actor,
    metadata: { violation_count: violations.length, violations },
  });

  return { valid, version, violations };
}

export interface ActivatePlaybookInput {
  workflowId: string;
  businessId: string;
  version: number;
  actor: string;
  /** ISO timestamp. Future = scheduled; omitted/past = immediate. */
  effective_at?: string | null;
  change_reason?: string | null;
}

function normaliseEffectiveAt(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`effective_at '${value}' is not a valid ISO-8601 timestamp (e.g. 2026-09-01T09:00:00.000Z).`);
  }
  return parsed.toISOString();
}

/**
 * Activate (or schedule) a version. Validation is re-run here rather than
 * trusted from the draft's stored verdict: activation is the moment the
 * definition becomes something that can touch the real world, and the
 * registry may have changed since the draft was validated. An invalid
 * definition is refused with its violations, never activated "provisionally".
 */
export function activatePlaybookVersion(input: ActivatePlaybookInput): PlaybookVersion {
  const ref: WorkflowRef = { workflowId: input.workflowId, businessId: input.businessId };
  const target = getPlaybookVersion(ref, input.version);
  if (!target) {
    throw new PlaybookNotFoundError(
      `Version ${input.version} does not exist for this playbook. ` +
      `Available versions: ${listPlaybookVersions(ref).map((v) => v.version).join(', ') || 'none'}.`,
    );
  }
  if (target.state === 'active') {
    throw new PlaybookStateError(`Version ${input.version} is already the active playbook.`);
  }
  if (target.state === 'superseded' || target.state === 'archived') {
    throw new PlaybookStateError(
      `Version ${input.version} is '${target.state}' and cannot be re-activated directly. ` +
      'Roll back to it instead — that writes it forward as a new version and preserves the history.',
    );
  }

  const result = validatePlaybookVersion(ref, input.version, input.actor);
  if (!result.valid) throw new PlaybookValidationError(result.violations);

  const effectiveAt = normaliseEffectiveAt(input.effective_at);
  const immediate = new Date(effectiveAt).getTime() <= Date.now();

  db.transaction(() => {
    if (immediate) supersedeActive(input.workflowId, target.id, input.actor, target.version);
    db.prepare(`
      UPDATE playbook_versions
         SET state = ?, effective_at = ?, activated_at = ?, change_reason = COALESCE(?, change_reason),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(
      immediate ? 'active' : 'scheduled', effectiveAt,
      immediate ? new Date().toISOString() : null,
      input.change_reason ?? null, target.id,
    );
    recordPlaybookEvent({
      playbookVersionId: target.id, workflowId: input.workflowId, businessId: input.businessId,
      version: target.version, eventType: immediate ? 'activated' : 'scheduled', actor: input.actor,
      reason: input.change_reason ?? (immediate ? 'Effective immediately.' : `Scheduled for ${effectiveAt}.`),
      metadata: { effective_at: effectiveAt },
    });
  })();

  audit(input.businessId, 'playbook_version', target.id, immediate ? 'activate' : 'schedule', input.actor,
    null, target.definition, { workflow_id: input.workflowId, version: target.version, effective_at: effectiveAt });

  return getPlaybookVersion(ref, input.version)!;
}

/**
 * Roll back to a prior version by writing it forward as a NEW version and
 * activating that — history is never rewound, exactly as rollbackPolicy()
 * does. In-flight runs are untouched: they are bound to their own version
 * id and keep executing it (see playbook-engine.ts).
 */
export function rollbackPlaybookVersion(input: {
  workflowId: string; businessId: string; to_version: number; actor: string; change_reason?: string | null;
}): PlaybookVersion {
  const ref: WorkflowRef = { workflowId: input.workflowId, businessId: input.businessId };
  const target = getPlaybookVersion(ref, input.to_version);
  if (!target) {
    const available = listPlaybookVersions(ref).map((v) => v.version);
    throw new PlaybookNotFoundError(
      `Version ${input.to_version} does not exist for this playbook. ` +
      (available.length ? `Available versions: ${available.join(', ')}.` : 'No versions have been authored yet.'),
    );
  }
  const current = getActivePlaybookVersion(ref);
  if (current && current.version === input.to_version) {
    throw new PlaybookStateError(
      `Version ${input.to_version} is already active — there is nothing to roll back to.`,
    );
  }

  const draft = savePlaybookDraft({
    workflowId: input.workflowId,
    businessId: input.businessId,
    definition: target.definition,
    actor: input.actor,
    change_reason: input.change_reason ?? `Rolled back to version ${input.to_version}.`,
    source: 'rollback',
    rolled_back_from_version: input.to_version,
    validate: true,
  });

  const activated = activatePlaybookVersion({
    workflowId: input.workflowId, businessId: input.businessId, version: draft.version,
    actor: input.actor, change_reason: input.change_reason ?? `Restored version ${input.to_version}.`,
  });

  recordPlaybookEvent({
    playbookVersionId: activated.id, workflowId: input.workflowId, businessId: input.businessId,
    version: activated.version, eventType: 'rolled_back', actor: input.actor,
    reason: input.change_reason ?? `Restored version ${input.to_version} as version ${activated.version}.`,
    metadata: { rolled_back_from_version: input.to_version, replaced_version: current?.version ?? null },
  });
  return activated;
}

/** Cancel a not-yet-effective scheduled version. The row is retained as superseded. */
export function cancelScheduledPlaybookVersion(input: {
  workflowId: string; businessId: string; version: number; actor: string; reason?: string | null;
}): PlaybookVersion {
  const ref: WorkflowRef = { workflowId: input.workflowId, businessId: input.businessId };
  const target = getPlaybookVersion(ref, input.version);
  if (!target) throw new PlaybookNotFoundError(`Version ${input.version} does not exist for this playbook.`);
  if (target.state !== 'scheduled') {
    throw new PlaybookStateError(
      `Version ${input.version} is '${target.state}', not 'scheduled' — only a version that has not taken effect yet can be cancelled.`,
    );
  }
  db.prepare(
    "UPDATE playbook_versions SET state = 'superseded', superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'scheduled'",
  ).run(target.id);
  recordPlaybookEvent({
    playbookVersionId: target.id, workflowId: input.workflowId, businessId: input.businessId,
    version: target.version, eventType: 'schedule_cancelled', actor: input.actor, reason: input.reason ?? null,
  });
  return getPlaybookVersion(ref, input.version)!;
}
