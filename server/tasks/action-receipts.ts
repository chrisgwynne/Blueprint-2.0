/**
 * Verified action receipts (issue #70).
 *
 * An execution acknowledgement is not proof that an external change
 * happened correctly. A receipt is the durable, human-readable record that
 * separates the five things Blueprint previously smeared together into one
 * task status:
 *
 *   requested                 — a task was proposed
 *   authorized                — a human/policy approved it (who, when)
 *   executed                  — Blueprint actually ran the action
 *   externally acknowledged   — the external system confirmed receipt and
 *                               handed back an ID/permalink (an HTTP 200
 *                               with an issue number is an acknowledgement,
 *                               NOT proof the change took effect)
 *   verified                  — a later, independent measurement confirmed
 *                               the change actually took effect
 *
 * Each is its own timestamp on the receipt. A receipt that reached
 * `externally_acknowledged` but never `verified` is exactly the honest
 * answer to "did this work?" — "the API accepted it; nothing has checked
 * the result yet" — instead of a green tick.
 *
 * ── Relationship to the existing machinery ────────────────────────────────
 *
 * Receipts are a RECORD, never a gate. Nothing here decides whether an
 * action runs, retries, or goes to manual review — execution-safety.ts and
 * execution-worker.ts own those decisions, and this module only writes down
 * what they decided. Every hook is best-effort at the call site (except the
 * one inside approveTask's transaction, where atomicity with the approval
 * is the point), so a receipt failure can never break an execution path.
 *
 * ── Correlation: retries and duplicate deliveries ─────────────────────────
 *
 * The correlation key is `buildIdempotencyMarker(task_id, task_version)`
 * from execution-safety.ts — the very same string embedded in the external
 * objects Blueprint creates, and the same (task, version) pair the
 * execution job is bound to. No parallel idempotency mechanism is invented
 * here. Consequences:
 *
 *   • Every retry of one approved task version — worker backoff retry,
 *     crash-recovery requeue, operator "retry job" — resolves to the SAME
 *     receipt row (unique index on correlation_key). Attempts accumulate in
 *     `attempt_count`/`attempt_history`; they never fork into two receipts
 *     telling different stories about one action.
 *   • A task rejected, re-proposed and re-approved gets a NEW version,
 *     therefore a new marker, therefore a deliberately distinct receipt —
 *     matching how the external idempotency marker already behaves.
 *   • A duplicate external acknowledgement for a reference we already hold
 *     is a no-op. A *conflicting* one (different external ID for the same
 *     correlation key) never silently overwrites: the first reference is
 *     kept, the conflict is appended to `anomalies`, and the receipt is
 *     flagged `ambiguous` so a human resolves it — the same "never guess"
 *     posture as execution-safety.ts.
 *
 * ── Redaction ─────────────────────────────────────────────────────────────
 *
 * Everything free-form (external reference, result detail, verification
 * evidence, follow-ups, errors) passes through lib/redaction.ts on the way
 * IN, and the readback view redacts again on the way OUT, so a row written
 * before a redaction rule existed still cannot leak through the API.
 */
import db, { generateId } from '../db/db.js';
import { buildIdempotencyMarker } from './execution-safety.js';
import { redactSensitive, redactSensitiveText, redactRecord } from '../lib/redaction.js';

/**
 * Receipt schema version. Bump when the persisted shape changes in a way a
 * reader must know about; stored per-row so old receipts stay readable.
 */
export const RECEIPT_SCHEMA_VERSION = 1;

export type ReceiptState =
  /** Never ran: a gate rejected it before execution (validation, policy, integrity, no executor, human rejection). */
  | 'rejected_pre_execution'
  /** Approved and recorded; execution not started (or not applicable — manual tasks). */
  | 'authorized'
  /** Execution in flight. */
  | 'executing'
  /** Blueprint completed the action; nothing external to acknowledge (or none returned). */
  | 'executed'
  /** The external system confirmed receipt and returned an ID/permalink. */
  | 'externally_acknowledged'
  /** A later, independent measurement confirmed the change took effect. */
  | 'verified'
  /** Execution failed (terminally, or pending retry — see attempt_history). */
  | 'failed'
  /** Outcome cannot be determined without a human (crash mid-external-write, reference conflict). */
  | 'ambiguous'
  /** Cancelled before execution completed. */
  | 'cancelled';

export type ReceiptResultStatus =
  | 'pending'   // nothing has run yet
  | 'success'
  | 'partial'   // ran, but the action is not fully done (e.g. a draft awaiting human review)
  | 'failure'
  | 'rejected'  // never ran
  | 'unknown';  // ran or may have run; outcome undetermined

export interface ReceiptAttempt {
  attempt: number;
  at: string;
  phase: string;
  status: string;
  detail?: string | null;
  settled_at?: string | null;
}

export interface ReceiptAnomaly {
  type: string;
  at: string;
  detail: string;
  evidence?: Record<string, unknown> | null;
}

export interface VerificationEvidence {
  /** How the verification was performed, e.g. 'metric_delta', 'provider_readback'. */
  method: string;
  /** Where the evidence came from, e.g. 'task_outcomes', 'outcome_measurement_runs'. */
  source: string;
  /** Structured, machine-checkable observations — never free text. */
  checks?: Array<{ name: string; expected?: unknown; observed?: unknown; passed?: boolean | null }>;
  metric?: string | null;
  baseline_value?: number | null;
  observed_value?: number | null;
  change_pct?: number | null;
  verdict?: string | null;
  measured_at?: string | null;
  task_outcome_ids?: string[];
  measurement_run_ids?: string[];
  [key: string]: unknown;
}

export interface ReceiptFollowUp {
  spawned_task_ids?: string[];
  system_issue_ids?: string[];
  measurement_run_ids?: string[];
  notes?: string[];
  [key: string]: unknown;
}

export interface ActionReceiptRow {
  id: string;
  receipt_version: number;
  business_id: string;
  task_id: string;
  task_version: number;
  correlation_key: string;
  execution_job_id: string | null;
  action_type: string | null;
  title: string | null;
  state: ReceiptState;
  result_status: ReceiptResultStatus;
  result_summary: string | null;
  result_detail: Record<string, unknown> | null;
  requested_at: string | null;
  requested_by: string | null;
  authorized_at: string | null;
  authorized_by: string | null;
  execution_started_at: string | null;
  executed_at: string | null;
  externally_acknowledged_at: string | null;
  verified_at: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_stage: string | null;
  rejection_reason: string | null;
  external_system: string | null;
  external_id: string | null;
  external_permalink: string | null;
  external_reference: Record<string, unknown> | null;
  verification_evidence: VerificationEvidence | null;
  follow_up: ReceiptFollowUp | null;
  anomalies: ReceiptAnomaly[] | null;
  attempt_count: number;
  attempt_history: ReceiptAttempt[] | null;
  created_at: string;
  updated_at: string;
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function parseJSON<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(value as string) as T; } catch { return fallback; }
}

function parseReceiptRow(row: Record<string, unknown> | null | undefined): ActionReceiptRow | null {
  if (!row) return null;
  return {
    ...(row as unknown as ActionReceiptRow),
    result_detail: parseJSON<Record<string, unknown> | null>(row.result_detail, null),
    external_reference: parseJSON<Record<string, unknown> | null>(row.external_reference, null),
    verification_evidence: parseJSON<VerificationEvidence | null>(row.verification_evidence, null),
    follow_up: parseJSON<ReceiptFollowUp | null>(row.follow_up, null),
    anomalies: parseJSON<ReceiptAnomaly[] | null>(row.anomalies, null),
    attempt_history: parseJSON<ReceiptAttempt[] | null>(row.attempt_history, null),
  };
}

function nowIso(): string { return new Date().toISOString(); }

// ─── External reference extraction ───────────────────────────────────────────

/**
 * Which external system an action type writes to. Derived from the action
 * type rather than stored per-handler so a new handler is covered without
 * touching the receipt layer; unknown prefixes simply yield null (an
 * internal, Blueprint-only action).
 */
export function externalSystemForAction(actionType: string | null | undefined): string | null {
  if (!actionType) return null;
  const type = actionType.toLowerCase();
  if (type.startsWith('github_')) return 'github';
  if (type.startsWith('shopify_')) return 'shopify';
  if (type.startsWith('wix_')) return 'wix';
  if (type.startsWith('gbp_')) return 'google_business_profile';
  if (type.startsWith('klaviyo_')) return 'klaviyo';
  if (type.startsWith('meta_ads_')) return 'meta_ads';
  if (type.startsWith('server_file_')) return 'server';
  return null;
}

// Ordered most-specific-first: the first key present wins, so a GitHub
// payload's `issue_number` is preferred over a generic `id`.
const EXTERNAL_ID_KEYS = [
  'issue_number', 'pr_number', 'product_id', 'page_id', 'article_id', 'post_id',
  'collection_id', 'theme_id', 'flow_id', 'campaign_id', 'deployment_id',
  'external_id', 'resource_id', 'remote_id', 'id',
];
const EXTERNAL_URL_KEYS = [
  'issue_url', 'pr_url', 'admin_url', 'permalink', 'public_url', 'html_url', 'url',
];

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

export interface ExtractedExternalReference {
  external_system: string | null;
  external_id: string | null;
  external_permalink: string | null;
  reference: Record<string, unknown>;
}

/**
 * Pull a structured external identity out of a handler's free-form
 * `outcome_data`. Returns null when the outcome contains nothing that
 * identifies an object in an external system — which is the honest answer
 * for a Blueprint-internal action (a KB draft, an investigation), not a
 * failure.
 */
export function extractExternalReference(
  actionType: string | null | undefined,
  outcomeData: unknown,
): ExtractedExternalReference | null {
  if (!outcomeData || typeof outcomeData !== 'object' || Array.isArray(outcomeData)) return null;
  const data = outcomeData as Record<string, unknown>;

  const externalId = firstString(data, EXTERNAL_ID_KEYS);
  const rawUrl = firstString(data, EXTERNAL_URL_KEYS);
  const permalink = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
  if (!externalId && !permalink) return null;

  return {
    external_system: externalSystemForAction(actionType),
    external_id: externalId,
    external_permalink: permalink,
    reference: redactSensitive<Record<string, unknown>>(data),
  };
}

// ─── Core upsert plumbing ────────────────────────────────────────────────────

export function buildCorrelationKey(taskId: string, taskVersion: number): string {
  return buildIdempotencyMarker(taskId, Number(taskVersion) || 1);
}

interface TaskFacts {
  id: string;
  business_id: string;
  version: number;
  action_type: string | null;
  title: string | null;
  proposed_by: string | null;
  created_at: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
}

function loadTaskFacts(taskId: string): TaskFacts | null {
  const row = db.prepare(
    'SELECT id, business_id, version, action_type, title, proposed_by, created_at, approved_by, approved_at FROM tasks WHERE id = ?'
  ).get(taskId) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: String(row.id),
    business_id: String(row.business_id),
    version: Number(row.version ?? 1),
    action_type: (row.action_type as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    proposed_by: (row.proposed_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    approved_by: (row.approved_by as string | null) ?? null,
    approved_at: (row.approved_at as string | null) ?? null,
  };
}

/**
 * Find the receipt for this exact (task, version), creating a skeleton one
 * if it is missing. "Missing" is always recoverable rather than fatal:
 * criterion one of issue #70 is that an action never leaves an ambiguous
 * *absence* of a record, so any later hook that finds no receipt writes the
 * one that should have existed instead of silently doing nothing.
 */
function ensureReceipt(taskId: string, taskVersion?: number): ActionReceiptRow | null {
  const facts = loadTaskFacts(taskId);
  if (!facts) return null;
  const version = Number(taskVersion ?? facts.version) || 1;
  const key = buildCorrelationKey(taskId, version);

  const existing = getReceiptByCorrelationKey(key);
  if (existing) return existing;

  db.prepare(`
    INSERT INTO action_receipts (
      id, receipt_version, business_id, task_id, task_version, correlation_key,
      action_type, title, state, result_status, requested_at, requested_by,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'authorized', 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(correlation_key) DO NOTHING
  `).run(
    generateId(), RECEIPT_SCHEMA_VERSION, facts.business_id, taskId, version, key,
    facts.action_type, facts.title, facts.created_at, facts.proposed_by,
  );

  return getReceiptByCorrelationKey(key);
}

type ReceiptPatch = Partial<Omit<ActionReceiptRow, 'id' | 'correlation_key' | 'created_at'>>;

const JSON_COLUMNS = new Set([
  'result_detail', 'external_reference', 'verification_evidence', 'follow_up',
  'anomalies', 'attempt_history',
]);

function applyPatch(receipt: ActionReceiptRow, patch: ReceiptPatch): ActionReceiptRow | null {
  const sets: string[] = [];
  const values: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(JSON_COLUMNS.has(column) ? (value == null ? null : JSON.stringify(value)) : value);
  }
  if (!sets.length) return receipt;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(receipt.id);
  db.prepare(`UPDATE action_receipts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getReceipt(receipt.id);
}

/**
 * A receipt's state is set explicitly by each recorder — every recorder
 * corresponds to a real transition that happened — with one invariant: a
 * `verified` receipt is never walked back. Verification is the strongest
 * claim the system can make about an action, and a later unrelated retry
 * or bookkeeping write must not quietly downgrade it.
 */
function nextState(current: ReceiptState, proposed: ReceiptState): ReceiptState {
  if (current === 'verified' && proposed !== 'verified') return 'verified';
  return proposed;
}

function appendAttempt(
  receipt: ActionReceiptRow,
  attempt: Omit<ReceiptAttempt, 'attempt' | 'at'> & { at?: string; increment?: boolean },
): { attempt_history: ReceiptAttempt[]; attempt_count: number } {
  const history = receipt.attempt_history ?? [];
  // `increment: false` records something that happened *about* the current
  // attempt (a retry being scheduled) without counting a new run.
  const attemptNumber = attempt.increment === false ? receipt.attempt_count : receipt.attempt_count + 1;
  const entry: ReceiptAttempt = {
    attempt: attemptNumber,
    at: attempt.at ?? nowIso(),
    phase: attempt.phase,
    status: attempt.status,
    detail: attempt.detail ? redactSensitiveText(String(attempt.detail)).slice(0, 400) : null,
  };
  // Bounded history — a receipt is a readable record, not a log sink.
  const next = [...history, entry].slice(-20);
  return { attempt_history: next, attempt_count: attemptNumber };
}

/**
 * Close out the attempt recordExecutionStarted opened, rather than
 * counting one run twice. Falls back to appending a fresh attempt when the
 * result arrives without a matching start (e.g. executeTask() called
 * directly, outside the worker's start→settle pairing).
 */
function settleAttempt(
  receipt: ActionReceiptRow, status: string, detail: string,
): { attempt_history: ReceiptAttempt[]; attempt_count: number } {
  const history = receipt.attempt_history ?? [];
  const last = history[history.length - 1];
  if (last && last.status === 'started') {
    const settled: ReceiptAttempt = {
      ...last,
      status,
      detail: redactSensitiveText(detail).slice(0, 400),
      settled_at: nowIso(),
    };
    return { attempt_history: [...history.slice(0, -1), settled], attempt_count: receipt.attempt_count };
  }
  return appendAttempt(receipt, { phase: 'execution', status, detail });
}

function appendAnomaly(receipt: ActionReceiptRow, anomaly: Omit<ReceiptAnomaly, 'at'>): ReceiptAnomaly[] {
  const existing = receipt.anomalies ?? [];
  return [...existing, {
    ...anomaly,
    at: nowIso(),
    detail: redactSensitiveText(anomaly.detail).slice(0, 400),
    evidence: anomaly.evidence ? redactRecord(anomaly.evidence) : null,
  }].slice(-20);
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function getReceipt(id: string): ActionReceiptRow | null {
  return parseReceiptRow(db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(id) as Record<string, unknown> | null);
}

export function getReceiptByCorrelationKey(key: string): ActionReceiptRow | null {
  return parseReceiptRow(
    db.prepare('SELECT * FROM action_receipts WHERE correlation_key = ?').get(key) as Record<string, unknown> | null
  );
}

export function getReceiptForTaskVersion(taskId: string, taskVersion: number): ActionReceiptRow | null {
  return getReceiptByCorrelationKey(buildCorrelationKey(taskId, taskVersion));
}

/** Most recent receipt for a task across all approved versions. */
export function getLatestReceiptForTask(taskId: string): ActionReceiptRow | null {
  return parseReceiptRow(
    db.prepare(
      'SELECT * FROM action_receipts WHERE task_id = ? ORDER BY task_version DESC, created_at DESC LIMIT 1'
    ).get(taskId) as Record<string, unknown> | null
  );
}

export function listReceiptsForTask(taskId: string): ActionReceiptRow[] {
  return (db.prepare('SELECT * FROM action_receipts WHERE task_id = ? ORDER BY task_version DESC').all(taskId) as Array<Record<string, unknown>>)
    .map((r) => parseReceiptRow(r)!);
}

export interface ListReceiptsFilters {
  state?: string[];
  action_type?: string[];
  result_status?: string[];
  task_id?: string;
  page?: number;
  limit?: number;
}

export function listReceipts(
  businessId: string,
  filters: ListReceiptsFilters = {},
): { receipts: ActionReceiptRow[]; total: number; page: number; limit: number; pages: number } {
  const conditions = ['business_id = ?'];
  const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any

  if (filters.state?.length) {
    conditions.push(`state IN (${filters.state.map(() => '?').join(',')})`);
    params.push(...filters.state);
  }
  if (filters.action_type?.length) {
    conditions.push(`action_type IN (${filters.action_type.map(() => '?').join(',')})`);
    params.push(...filters.action_type);
  }
  if (filters.result_status?.length) {
    conditions.push(`result_status IN (${filters.result_status.map(() => '?').join(',')})`);
    params.push(...filters.result_status);
  }
  if (filters.task_id) {
    conditions.push('task_id = ?');
    params.push(filters.task_id);
  }

  const where = conditions.join(' AND ');
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * limit;

  const total = (db.prepare(`SELECT COUNT(*) as n FROM action_receipts WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db.prepare(
    `SELECT * FROM action_receipts WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Array<Record<string, unknown>>;

  return {
    receipts: rows.map((r) => parseReceiptRow(r)!),
    total, page, limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/** Aggregate counts by state, for the receipts dashboard header. */
export function receiptStateSummary(businessId: string): Record<string, number> {
  const rows = db.prepare(
    'SELECT state, COUNT(*) as n FROM action_receipts WHERE business_id = ? GROUP BY state'
  ).all(businessId) as Array<{ state: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.state] = row.n;
  return out;
}

// ─── Readback view ───────────────────────────────────────────────────────────

export interface ReceiptView extends Record<string, unknown> {
  id: string;
  receipt_version: number;
  correlation_key: string;
  states: {
    requested: { at: string | null; by: string | null; reached: boolean };
    authorized: { at: string | null; by: string | null; reached: boolean };
    executed: { at: string | null; reached: boolean };
    externally_acknowledged: {
      at: string | null; reached: boolean;
      system: string | null; external_id: string | null; permalink: string | null;
    };
    verified: { at: string | null; reached: boolean; evidence: VerificationEvidence | null };
  };
}

/**
 * Shape a stored row for readback. Redacts a second time on the way out —
 * a row persisted before a redaction rule existed (or written by a path
 * that somehow skipped sanitisation) still cannot leak through the API.
 */
export function toReceiptView(row: ActionReceiptRow): ReceiptView {
  return {
    id: row.id,
    receipt_version: row.receipt_version,
    business_id: row.business_id,
    task_id: row.task_id,
    task_version: row.task_version,
    correlation_key: row.correlation_key,
    execution_job_id: row.execution_job_id,
    action_type: row.action_type,
    title: row.title,
    state: row.state,
    result_status: row.result_status,
    result_summary: row.result_summary ? redactSensitiveText(row.result_summary) : null,
    result_detail: redactRecord(row.result_detail),
    rejection: row.rejected_at
      ? {
          at: row.rejected_at,
          by: row.rejected_by,
          stage: row.rejection_stage,
          reason: row.rejection_reason ? redactSensitiveText(row.rejection_reason) : null,
        }
      : null,
    states: {
      requested: { at: row.requested_at, by: row.requested_by, reached: !!row.requested_at },
      authorized: { at: row.authorized_at, by: row.authorized_by, reached: !!row.authorized_at },
      executed: { at: row.executed_at, reached: !!row.executed_at },
      externally_acknowledged: {
        at: row.externally_acknowledged_at,
        reached: !!row.externally_acknowledged_at,
        system: row.external_system,
        external_id: row.external_id,
        permalink: row.external_permalink,
      },
      verified: {
        at: row.verified_at,
        reached: !!row.verified_at,
        evidence: redactRecord(row.verification_evidence) as VerificationEvidence | null,
      },
    },
    execution_started_at: row.execution_started_at,
    external_reference: redactRecord(row.external_reference),
    follow_up: redactRecord(row.follow_up),
    anomalies: redactSensitive(row.anomalies ?? []),
    attempt_count: row.attempt_count,
    attempt_history: redactSensitive(row.attempt_history ?? []),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Writers: state progression ──────────────────────────────────────────────

export interface OpenReceiptParams {
  task: {
    id: string; business_id: string; version?: number; action_type?: string | null;
    title?: string | null; proposed_by?: string | null; created_at?: string | null;
  };
  authorizedBy: string;
  executionJobId?: string | null;
  /** Optional note explaining an unusual authorization path (e.g. externally executed). */
  note?: string | null;
}

/**
 * Record the requested + authorized states. Called from within
 * approveTask()'s transaction, so an approved task and its receipt commit
 * or roll back together — an approval can never exist without a receipt.
 */
export function openReceipt(params: OpenReceiptParams): ActionReceiptRow | null {
  const { task, authorizedBy, executionJobId = null, note = null } = params;
  const version = Number(task.version ?? 1) || 1;
  const key = buildCorrelationKey(task.id, version);
  const now = nowIso();

  db.prepare(`
    INSERT INTO action_receipts (
      id, receipt_version, business_id, task_id, task_version, correlation_key,
      execution_job_id, action_type, title, state, result_status,
      requested_at, requested_by, authorized_at, authorized_by,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', 'pending', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(correlation_key) DO UPDATE SET
      execution_job_id = COALESCE(excluded.execution_job_id, action_receipts.execution_job_id),
      authorized_at = COALESCE(action_receipts.authorized_at, excluded.authorized_at),
      authorized_by = COALESCE(action_receipts.authorized_by, excluded.authorized_by),
      updated_at = CURRENT_TIMESTAMP
  `).run(
    generateId(), RECEIPT_SCHEMA_VERSION, task.business_id, task.id, version, key,
    executionJobId, task.action_type ?? null, task.title ?? null,
    task.created_at ?? now, task.proposed_by ?? null, now, authorizedBy,
  );

  const receipt = getReceiptByCorrelationKey(key);
  if (receipt && note) {
    return applyPatch(receipt, { follow_up: mergeFollowUp(receipt.follow_up, { notes: [note] }) });
  }
  return receipt;
}

function mergeFollowUp(existing: ReceiptFollowUp | null, addition: ReceiptFollowUp): ReceiptFollowUp {
  const merged: ReceiptFollowUp = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(addition)) {
    if (Array.isArray(value)) {
      const previous = Array.isArray(merged[key]) ? (merged[key] as unknown[]) : [];
      merged[key] = Array.from(new Set([...previous, ...value])).slice(0, 50);
    } else {
      merged[key] = value;
    }
  }
  return redactSensitive<ReceiptFollowUp>(merged);
}

export interface PreExecutionRejectionParams {
  task: {
    id: string; business_id: string; version?: number; action_type?: string | null;
    title?: string | null; proposed_by?: string | null; created_at?: string | null;
  };
  /** Which gate rejected it: 'action_validation' | 'applicability' | 'automation_policy_cap' | 'no_executor' | 'payload_integrity' | 'human_rejection' | ... */
  stage: string;
  reason: string;
  actor: string;
  evidence?: Record<string, unknown> | null;
}

/**
 * Record an explicit pre-execution rejection: the action never ran, and
 * this is the receipt that says so. Without it, a rejected action would be
 * indistinguishable from one whose receipt was simply never written —
 * exactly the ambiguous absence issue #70 exists to eliminate.
 *
 * Keyed on the task's CURRENT version (approval bumps the version only on
 * success), so a rejection at v1 and a later successful approval at v2
 * are two distinct, non-conflicting receipts. Repeated rejections of the
 * same version update the one record rather than piling up duplicates.
 */
export function recordPreExecutionRejection(params: PreExecutionRejectionParams): ActionReceiptRow | null {
  const { task, stage, reason, actor, evidence = null } = params;
  const version = Number(task.version ?? 1) || 1;
  const key = buildCorrelationKey(task.id, version);
  const now = nowIso();
  const safeReason = redactSensitiveText(reason).slice(0, 1000);

  db.prepare(`
    INSERT INTO action_receipts (
      id, receipt_version, business_id, task_id, task_version, correlation_key,
      action_type, title, state, result_status, result_summary,
      requested_at, requested_by, rejected_at, rejected_by, rejection_stage, rejection_reason,
      result_detail, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rejected_pre_execution', 'rejected', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(correlation_key) DO NOTHING
  `).run(
    generateId(), RECEIPT_SCHEMA_VERSION, task.business_id, task.id, version, key,
    task.action_type ?? null, task.title ?? null, safeReason,
    task.created_at ?? now, task.proposed_by ?? null, now, actor, stage, safeReason,
    evidence ? JSON.stringify(redactRecord(evidence)) : null,
  );

  const receipt = getReceiptByCorrelationKey(key);
  if (!receipt) return null;
  // An existing receipt for this version (a re-attempted approval, or a
  // human rejecting an already-approved task) is updated in place rather
  // than duplicated.
  if (receipt.state !== 'rejected_pre_execution' || receipt.rejection_reason !== safeReason) {
    return applyPatch(receipt, {
      state: nextState(receipt.state, 'rejected_pre_execution'),
      result_status: 'rejected',
      result_summary: safeReason,
      rejected_at: now,
      rejected_by: actor,
      rejection_stage: stage,
      rejection_reason: safeReason,
      result_detail: evidence ? redactRecord(evidence) : receipt.result_detail,
    });
  }
  return receipt;
}

/** Blueprint has started executing this approved action. */
export function recordExecutionStarted(taskId: string, taskVersion: number, executionJobId: string | null): ActionReceiptRow | null {
  const receipt = ensureReceipt(taskId, taskVersion);
  if (!receipt) return null;
  const attempt = appendAttempt(receipt, { phase: 'execution', status: 'started' });
  return applyPatch(receipt, {
    state: nextState(receipt.state, 'executing'),
    execution_started_at: nowIso(),
    execution_job_id: executionJobId ?? receipt.execution_job_id,
    ...attempt,
  });
}

export interface ExternalAcknowledgementParams {
  taskId: string;
  taskVersion: number;
  actionType: string | null;
  /** The handler's outcome_data — the raw material the reference is extracted from. */
  outcomeData: unknown;
  /** True when the reference came from a marker/recovery lookup rather than a fresh create. */
  recovered?: boolean;
}

/**
 * Record that the external system acknowledged the write and handed back
 * an identity. This is deliberately a SEPARATE state from `verified`: an
 * HTTP 200 with an issue number proves the API accepted the call, not that
 * the change is correct or still in place.
 *
 * Idempotent by design. A duplicate acknowledgement carrying the same
 * external ID is a no-op. A *conflicting* one keeps the first reference,
 * records the conflict in `anomalies` and flags the receipt `ambiguous` —
 * never silently overwriting, for the same reason execution-safety.ts
 * refuses to guess about ambiguous external writes.
 */
export function recordExternalAcknowledgement(params: ExternalAcknowledgementParams): ActionReceiptRow | null {
  const { taskId, taskVersion, actionType, outcomeData, recovered = false } = params;
  const extracted = extractExternalReference(actionType, outcomeData);
  if (!extracted) return getReceiptForTaskVersion(taskId, taskVersion);

  const receipt = ensureReceipt(taskId, taskVersion);
  if (!receipt) return null;

  const conflicting =
    !!receipt.external_id && !!extracted.external_id && receipt.external_id !== extracted.external_id;

  if (conflicting) {
    return applyPatch(receipt, {
      state: 'ambiguous',
      result_status: 'unknown',
      anomalies: appendAnomaly(receipt, {
        type: 'external_reference_conflict',
        detail:
          `A second external acknowledgement reported ID '${extracted.external_id}' for an action already ` +
          `acknowledged as '${receipt.external_id}'. The first reference is kept; a human must confirm whether ` +
          'two external objects now exist.',
        evidence: { held_external_id: receipt.external_id, reported_external_id: extracted.external_id },
      }),
    });
  }

  // Same identity re-reported (duplicate delivery, retry that adopted the
  // existing reference) — keep the original acknowledgement timestamp.
  const alreadyAcknowledged = !!receipt.externally_acknowledged_at && !!receipt.external_id;

  return applyPatch(receipt, {
    state: nextState(receipt.state, 'externally_acknowledged'),
    externally_acknowledged_at: alreadyAcknowledged ? receipt.externally_acknowledged_at : nowIso(),
    external_system: extracted.external_system ?? receipt.external_system,
    external_id: receipt.external_id ?? extracted.external_id,
    external_permalink: receipt.external_permalink ?? extracted.external_permalink,
    external_reference: receipt.external_reference ?? extracted.reference,
    follow_up: recovered
      ? mergeFollowUp(receipt.follow_up, { notes: ['External reference adopted from a prior attempt rather than a fresh create.'] })
      : receipt.follow_up,
  });
}

/**
 * Pull follow-up references out of a handler's outcome data. Handlers
 * already report the tasks they spawn (investigation follow-ons, evidence
 * gap tasks); the receipt links to them so "what happened next" is part of
 * the record rather than something to reconstruct from the task table.
 */
function extractFollowUpFromDetail(detail: unknown): ReceiptFollowUp | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const data = detail as Record<string, unknown>;
  const ids = new Set<string>();

  if (Array.isArray(data.spawned_task_ids)) {
    for (const id of data.spawned_task_ids) if (typeof id === 'string' && id) ids.add(id);
  }
  for (const key of ['evidence_gap_task_id', 'follow_up_task_id', 'child_task_id']) {
    const value = data[key];
    if (typeof value === 'string' && value) ids.add(value);
  }

  return ids.size ? { spawned_task_ids: Array.from(ids) } : null;
}

export interface ExecutionResultParams {
  taskId: string;
  taskVersion: number;
  /** 'success' — Blueprint completed it; 'partial' — ran but not finished (draft awaiting review); 'failure'/'blocked'. */
  status: 'success' | 'partial' | 'failure' | 'blocked';
  summary: string;
  detail?: unknown;
  /** The task status the executor settled on, for cross-reference. */
  taskStatus?: string | null;
}

/**
 * Record the result of an execution attempt from Blueprint's side.
 *
 * `executed_at` is set only when Blueprint actually completed the action —
 * a failed or blocked attempt leaves it null, so "did this run?" and "did
 * this work?" stay separable at readback. Attempt-level detail (including
 * failures) always lands in attempt_history regardless.
 */
export function recordExecutionResult(params: ExecutionResultParams): ActionReceiptRow | null {
  const { taskId, taskVersion, status, summary, detail, taskStatus = null } = params;
  const receipt = ensureReceipt(taskId, taskVersion);
  if (!receipt) return null;

  const safeSummary = redactSensitiveText(summary).slice(0, 1000);
  const ran = status === 'success' || status === 'partial';

  const resultStatus: ReceiptResultStatus =
    status === 'success' ? 'success' : status === 'partial' ? 'partial' : 'failure';

  // A completed action that already carries an external acknowledgement
  // stays at 'externally_acknowledged' — the stronger, more specific claim.
  const proposedState: ReceiptState = ran
    ? (receipt.externally_acknowledged_at ? 'externally_acknowledged' : 'executed')
    : 'failed';

  const settled = settleAttempt(receipt, status === 'blocked' ? 'blocked' : status, safeSummary);

  return applyPatch(receipt, {
    state: nextState(receipt.state, proposedState),
    result_status: resultStatus,
    result_summary: safeSummary,
    result_detail: redactRecord(detail) ?? receipt.result_detail,
    executed_at: ran ? nowIso() : receipt.executed_at,
    follow_up: mergeFollowUp(receipt.follow_up, {
      ...(extractFollowUpFromDetail(detail) ?? {}),
      ...(taskStatus ? { notes: [`Task settled at status '${taskStatus}'.`] } : {}),
    }),
    ...settled,
  });
}

/**
 * Record an attempt that is going to be retried (worker backoff, crash
 * recovery requeue). The receipt returns to `authorized` — the action is
 * approved and pending another run — with the failed attempt preserved in
 * history, so one receipt tells the whole retry story.
 */
export function recordRetryScheduled(
  taskId: string, taskVersion: number, phase: string, detail: string,
): ActionReceiptRow | null {
  const receipt = ensureReceipt(taskId, taskVersion);
  if (!receipt) return null;
  return applyPatch(receipt, {
    state: nextState(receipt.state, 'authorized'),
    ...appendAttempt(receipt, { phase, status: 'retry_scheduled', detail, increment: false }),
  });
}

/**
 * Record an outcome Blueprint cannot resolve on its own — a crash mid
 * external write with no reference recorded, a lease that expired during
 * an external-write action, an approved payload that changed before
 * execution. Mirrors (never replaces) execution-safety.ts's manual_review
 * routing: that logic decides, this records the decision.
 */
export function recordAmbiguousOutcome(
  taskId: string, taskVersion: number, reason: string, evidence?: Record<string, unknown> | null,
): ActionReceiptRow | null {
  const receipt = ensureReceipt(taskId, taskVersion);
  if (!receipt) return null;
  const safeReason = redactSensitiveText(reason).slice(0, 1000);
  return applyPatch(receipt, {
    state: nextState(receipt.state, 'ambiguous'),
    result_status: 'unknown',
    result_summary: safeReason,
    anomalies: appendAnomaly(receipt, { type: 'ambiguous_outcome', detail: safeReason, evidence: evidence ?? null }),
    ...settleAttempt(receipt, 'ambiguous', safeReason),
  });
}

/**
 * Settle an existing receipt as cancelled. Deliberately does NOT create one
 * when none exists: a task cancelled while still 'proposed' was never
 * authorized, so there is no action to receipt — only approval opens one.
 */
export function recordCancellation(taskId: string, taskVersion: number, actor: string, reason: string): ActionReceiptRow | null {
  const receipt = getReceiptForTaskVersion(taskId, taskVersion);
  if (!receipt) return null;
  const safeReason = redactSensitiveText(reason || 'Cancelled.').slice(0, 1000);
  return applyPatch(receipt, {
    state: nextState(receipt.state, 'cancelled'),
    result_status: receipt.result_status === 'pending' ? 'rejected' : receipt.result_status,
    result_summary: safeReason,
    rejected_at: receipt.rejected_at ?? nowIso(),
    rejected_by: receipt.rejected_by ?? actor,
    rejection_stage: receipt.rejection_stage ?? 'cancelled',
    rejection_reason: receipt.rejection_reason ?? safeReason,
  });
}

/**
 * Record that an independent, later measurement confirmed the change
 * actually took effect. Distinct from `externally_acknowledged` on
 * purpose, and always accompanied by structured evidence rather than a
 * free-text claim of success.
 */
export function recordVerification(
  taskId: string, evidence: VerificationEvidence, taskVersion?: number,
): ActionReceiptRow | null {
  const receipt = taskVersion != null
    ? ensureReceipt(taskId, taskVersion)
    : (getLatestReceiptForTask(taskId) ?? ensureReceipt(taskId));
  if (!receipt) return null;

  const safeEvidence = redactSensitive<VerificationEvidence>({
    ...evidence,
    measured_at: evidence.measured_at ?? nowIso(),
  });

  return applyPatch(receipt, {
    state: 'verified',
    verified_at: nowIso(),
    verification_evidence: safeEvidence,
    result_status: receipt.result_status === 'pending' ? 'success' : receipt.result_status,
  });
}

/** Attach follow-up references (spawned tasks, system issues, measurement runs). */
export function recordFollowUp(
  taskId: string, taskVersion: number, followUp: ReceiptFollowUp,
): ActionReceiptRow | null {
  const receipt = getReceiptForTaskVersion(taskId, taskVersion);
  if (!receipt) return null;
  return applyPatch(receipt, { follow_up: mergeFollowUp(receipt.follow_up, followUp) });
}

/**
 * Every receipt hook outside approveTask's transaction is best-effort:
 * bookkeeping must never break an execution path. Wrap with this so the
 * intent is explicit at each call site rather than a bare empty catch.
 */
export function safeReceipt<T>(fn: () => T): T | null {
  try { return fn(); }
  catch (err) {
    console.warn('[receipts] non-fatal receipt write failed:', (err as Error).message);
    return null;
  }
}
