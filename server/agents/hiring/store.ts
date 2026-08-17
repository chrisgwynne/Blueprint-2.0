/**
 * Business-scoped persistence for the hiring engine (#44, #49, #51, #54, #55, #56).
 *
 * ISOLATION CONTRACT — every exported function in this module:
 *   1. takes an explicit `businessId` as its first argument,
 *   2. calls assertBusiness() so the id is validated against the authoritative
 *      `businesses` table rather than trusted from the caller, and
 *   3. carries `business_id = ?` in the WHERE clause of every read and the
 *      column list of every write.
 *
 * Nothing in the hiring lifecycle — candidate discovery, installed-agent
 * state, suppression memory, analysis runs, proposals, notifications or
 * outcome evidence — may reach the DB except through here.
 */

import db, { generateId } from '../../db/db.js';
import type {
  ConnectorEvidence, HiringAnalysisRunRecord, HiringDecisionRecord, HiringMode,
  HiringRunStatus, ReconsiderPolicy, SuppressionDisposition, TrialPlan, TrialVerdict,
} from './types.js';

export const CONTRACT_VERSION = 'hiring.analysis.v1';

/** Guard rail: a hiring query without a real business id is a bug, not a no-op. */
export function assertBusiness(businessId: string): { id: string; name: string | null; type: string | null } {
  if (!businessId || typeof businessId !== 'string') {
    throw new Error('hiring: businessId is required and must be a string');
  }
  const row = db.prepare('SELECT id, name, type FROM businesses WHERE id = ?').get(businessId) as
    { id: string; name: string | null; type: string | null } | null;
  if (!row) throw new Error(`hiring: business '${businessId}' not found`);
  return row;
}

// ─── Connectors + freshness ───────────────────────────────────────────────────

export function getConnectorEvidence(businessId: string, maxAgeHours: number): ConnectorEvidence[] {
  assertBusiness(businessId);
  const rows = db.prepare(`
    SELECT id, type, name, last_sync FROM connectors
     WHERE business_id = ? AND status = 'connected'
  `).all(businessId) as Array<{ id: string; type: string; name: string | null; last_sync: string | null }>;

  const now = Date.now();
  return rows.map((r) => {
    let ageHours: number | null = null;
    if (r.last_sync) {
      const ts = Date.parse(r.last_sync.includes('T') ? r.last_sync : `${r.last_sync.replace(' ', 'T')}Z`);
      if (Number.isFinite(ts)) ageHours = Math.max(0, (now - ts) / 3_600_000);
    }
    return {
      id: r.id, type: r.type, name: r.name, last_sync: r.last_sync,
      age_hours: ageHours,
      // A connector that has never synced has no data behind it, so it can
      // never satisfy the freshness gate — `status='connected'` alone is
      // exactly the weak signal issue #48 rejects.
      fresh: ageHours != null && ageHours <= maxAgeHours,
    };
  });
}

// ─── Installed agents (business-scoped — issue #49) ──────────────────────────

/**
 * Agents this SPECIFIC business has hired. The `agents` table is an
 * instance-wide roster keyed by template id with no business dimension, so
 * reading it (as the old code did) treats one business's hire as every
 * business's hire.
 */
export function getInstalledAgentIds(businessId: string): Set<string> {
  assertBusiness(businessId);
  const rows = db.prepare(`
    SELECT agent_id FROM agent_installations
     WHERE business_id = ? AND status = 'installed'
  `).all(businessId) as Array<{ agent_id: string }>;
  return new Set(rows.map((r) => r.agent_id));
}

/** Called by the installer so the per-business record tracks reality. */
export function recordInstallation(
  businessId: string,
  agentId: string,
  opts: { installedBy?: string; lifecycleState?: string | null; metadata?: unknown } = {},
): void {
  assertBusiness(businessId);
  db.prepare(`
    INSERT INTO agent_installations (id, business_id, agent_id, status, installed_by, lifecycle_state, installed_at, metadata)
    VALUES (?, ?, ?, 'installed', ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(business_id, agent_id) DO UPDATE SET
      status = 'installed',
      installed_by = excluded.installed_by,
      lifecycle_state = excluded.lifecycle_state,
      uninstalled_at = NULL,
      metadata = excluded.metadata
  `).run(
    generateId(), businessId, agentId,
    opts.installedBy ?? 'human', opts.lifecycleState ?? null,
    JSON.stringify(opts.metadata ?? {}),
  );
}

export function recordUninstallation(businessId: string, agentId: string): void {
  assertBusiness(businessId);
  db.prepare(`
    UPDATE agent_installations SET status = 'uninstalled', uninstalled_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND agent_id = ?
  `).run(businessId, agentId);
}

// ─── Open hire proposals (business-scoped) ───────────────────────────────────

export function getOpenProposalTemplateIds(businessId: string): Set<string> {
  assertBusiness(businessId);
  const rows = db.prepare(`
    SELECT action_payload FROM tasks
     WHERE business_id = ? AND action_type = 'hire_agent' AND status IN ('proposed', 'approved')
  `).all(businessId) as Array<{ action_payload: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const templateId = (JSON.parse(r.action_payload) as { template_id?: string })?.template_id;
      if (templateId) out.add(templateId);
    } catch { /* malformed payload — cannot dedupe on it */ }
  }
  return out;
}

export function countOpenProposals(businessId: string): number {
  assertBusiness(businessId);
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
     WHERE business_id = ? AND action_type = 'hire_agent' AND status IN ('proposed', 'approved')
  `).get(businessId) as { n: number };
  return row?.n ?? 0;
}

// ─── Decision / suppression memory (#44, consumed by #50) ────────────────────

export interface RecordDecisionInput {
  businessId: string;
  templateId: string;
  decision: 'rejected' | 'approved' | 'deferred';
  actor: string;
  reason?: string | null;
  taskId?: string | null;
  analysisId?: string | null;
  evidenceFingerprint?: string | null;
  disposition?: SuppressionDisposition;
  reconsiderPolicy?: ReconsiderPolicy;
  expiresAt?: string | null;
  metadata?: unknown;
}

export function recordHiringDecision(input: RecordDecisionInput): string {
  assertBusiness(input.businessId);
  if (!input.templateId) throw new Error('hiring: templateId required to record a decision');
  const id = generateId();
  db.prepare(`
    INSERT INTO hiring_decisions (
      id, business_id, template_id, decision, disposition, actor, reason, task_id,
      analysis_id, evidence_fingerprint, reconsider_policy, expires_at, metadata, decided_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, input.businessId, input.templateId, input.decision,
    input.disposition ?? 'changed_circumstances',
    input.actor, input.reason ?? null, input.taskId ?? null, input.analysisId ?? null,
    input.evidenceFingerprint ?? null,
    input.reconsiderPolicy ?? 'new_evidence',
    input.expiresAt ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
  return id;
}

/** Latest decision per template for one business — never crosses businesses. */
export function getHiringDecisions(businessId: string, limit = 200): HiringDecisionRecord[] {
  assertBusiness(businessId);
  return db.prepare(`
    SELECT * FROM hiring_decisions
     WHERE business_id = ?
     ORDER BY decided_at DESC, rowid DESC
     LIMIT ?
  `).all(businessId, limit) as HiringDecisionRecord[];
}

export function getLatestDecisionByTemplate(businessId: string): Map<string, HiringDecisionRecord> {
  const out = new Map<string, HiringDecisionRecord>();
  for (const d of getHiringDecisions(businessId, 500)) {
    if (!out.has(d.template_id)) out.set(d.template_id, d);
  }
  return out;
}

// ─── Goals / signals evidence (#48) ──────────────────────────────────────────

export function getActiveGoals(businessId: string): Array<{ id: string; title: string; metric_name: string | null; metric_baseline: number | null; metric_target: number | null; metric_current: number | null }> {
  assertBusiness(businessId);
  return db.prepare(`
    SELECT id, title, metric_name, metric_baseline, metric_target, metric_current
      FROM goals WHERE business_id = ? AND status = 'active'
     ORDER BY updated_at DESC LIMIT 50
  `).all(businessId) as Array<{ id: string; title: string; metric_name: string | null; metric_baseline: number | null; metric_target: number | null; metric_current: number | null }>;
}

export function getRecentMaterialSignals(
  businessId: string,
  withinHours: number,
): Array<{ id: string; type: string; severity: string; title: string; connector_id: string | null; created_at: string }> {
  assertBusiness(businessId);
  return db.prepare(`
    SELECT s.id, s.type, s.severity, s.title, s.connector_id, s.created_at
      FROM signals s
     WHERE s.business_id = ?
       AND s.status IN ('new', 'open', 'acknowledged', 'investigating')
       AND s.created_at >= datetime('now', '-' || ? || ' hours')
     ORDER BY s.created_at DESC LIMIT 100
  `).all(businessId, withinHours) as Array<{ id: string; type: string; severity: string; title: string; connector_id: string | null; created_at: string }>;
}

// ─── Analysis runs (#52, #53, #54) ───────────────────────────────────────────

export interface StartRunInput {
  businessId: string;
  triggerSource: string;
  triggerRef?: string | null;
  triggerReason?: string | null;
  idempotencyKey?: string | null;
  mode: HiringMode;
  inputSnapshot?: unknown;
}

export function startAnalysisRun(input: StartRunInput): string {
  assertBusiness(input.businessId);
  const id = generateId();
  db.prepare(`
    INSERT INTO hiring_analysis_runs (
      id, business_id, contract_version, trigger_source, trigger_ref, trigger_reason,
      idempotency_key, mode, status, input_snapshot, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, CURRENT_TIMESTAMP)
  `).run(
    id, input.businessId, CONTRACT_VERSION, input.triggerSource,
    input.triggerRef ?? null, input.triggerReason ?? null,
    input.idempotencyKey ?? null, input.mode,
    JSON.stringify(input.inputSnapshot ?? {}),
  );
  return id;
}

export interface FinishRunInput {
  status: HiringRunStatus;
  terminalReason: string;
  degraded?: boolean;
  fallbackMode?: string | null;
  provider?: string | null;
  model?: string | null;
  providerStatus?: string | null;
  providerHttpStatus?: number | null;
  providerRetryable?: boolean | null;
  providerAttempts?: number;
  error?: string | null;
  candidatesConsidered?: number;
  candidatesGated?: number;
  suppressedCount?: number;
  recommendationsCount?: number;
  proposalsCreated?: number;
  proposalIds?: string[];
  coalescedInto?: string | null;
  costUsd?: number;
  diagnostics?: unknown;
  inputSnapshot?: unknown;
}

export function finishAnalysisRun(businessId: string, analysisId: string, input: FinishRunInput): void {
  assertBusiness(businessId);
  db.prepare(`
    UPDATE hiring_analysis_runs SET
      status = ?, terminal_reason = ?, degraded = ?, fallback_mode = ?,
      provider = COALESCE(?, provider), model = COALESCE(?, model),
      provider_status = COALESCE(?, provider_status),
      provider_http_status = COALESCE(?, provider_http_status),
      provider_retryable = COALESCE(?, provider_retryable),
      provider_attempts = ?, error = ?,
      candidates_considered = ?, candidates_gated = ?, suppressed_count = ?,
      recommendations_count = ?, proposals_created = ?, proposal_ids = ?,
      coalesced_into = ?, cost_usd = ?, diagnostics = ?,
      input_snapshot = COALESCE(?, input_snapshot),
      completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND business_id = ?
  `).run(
    input.status, input.terminalReason, input.degraded ? 1 : 0, input.fallbackMode ?? null,
    input.provider ?? null, input.model ?? null, input.providerStatus ?? null,
    input.providerHttpStatus ?? null,
    input.providerRetryable == null ? null : (input.providerRetryable ? 1 : 0),
    input.providerAttempts ?? 0, input.error ?? null,
    input.candidatesConsidered ?? 0, input.candidatesGated ?? 0, input.suppressedCount ?? 0,
    input.recommendationsCount ?? 0, input.proposalsCreated ?? 0,
    JSON.stringify(input.proposalIds ?? []),
    input.coalescedInto ?? null, input.costUsd ?? 0,
    JSON.stringify(input.diagnostics ?? {}),
    input.inputSnapshot === undefined ? null : JSON.stringify(input.inputSnapshot),
    analysisId, businessId,
  );
}

export function incrementCoalescedCallers(businessId: string, analysisId: string): void {
  db.prepare(`
    UPDATE hiring_analysis_runs SET coalesced_callers = coalesced_callers + 1
     WHERE id = ? AND business_id = ?
  `).run(analysisId, businessId);
}

export function getAnalysisRun(businessId: string, analysisId: string): HiringAnalysisRunRecord | null {
  assertBusiness(businessId);
  return db.prepare('SELECT * FROM hiring_analysis_runs WHERE id = ? AND business_id = ?')
    .get(analysisId, businessId) as HiringAnalysisRunRecord | null;
}

export function findRunByIdempotencyKey(businessId: string, key: string): HiringAnalysisRunRecord | null {
  assertBusiness(businessId);
  return db.prepare('SELECT * FROM hiring_analysis_runs WHERE business_id = ? AND idempotency_key = ?')
    .get(businessId, key) as HiringAnalysisRunRecord | null;
}

export function listAnalysisRuns(businessId: string, limit = 25): HiringAnalysisRunRecord[] {
  assertBusiness(businessId);
  return db.prepare(`
    SELECT * FROM hiring_analysis_runs WHERE business_id = ?
     ORDER BY started_at DESC, rowid DESC LIMIT ?
  `).all(businessId, limit) as HiringAnalysisRunRecord[];
}

/**
 * Reconcile analyses abandoned in `running` (#52). The predicate is
 * deliberately narrow — status='running' AND completed_at IS NULL AND older
 * than the timeout — so a healthy in-flight analysis is never clobbered.
 * Returns the ids it closed out.
 */
export function reconcileStaleAnalysisRuns(timeoutMinutes: number, businessId?: string): string[] {
  const params: Array<string | number> = [timeoutMinutes];
  let scope = '';
  if (businessId) { assertBusiness(businessId); scope = ' AND business_id = ?'; params.push(businessId); }
  const stale = db.prepare(`
    SELECT id, business_id FROM hiring_analysis_runs
     WHERE status = 'running' AND completed_at IS NULL
       AND started_at < datetime('now', '-' || ? || ' minutes')${scope}
  `).all(...params) as Array<{ id: string; business_id: string }>;
  if (stale.length === 0) return [];
  const upd = db.prepare(`
    UPDATE hiring_analysis_runs SET
      status = 'failed', terminal_reason = 'stale_run_reconciled',
      error = 'Hiring analysis exceeded the maximum duration and was reconciled as failed.',
      completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running' AND completed_at IS NULL
  `);
  const closed: string[] = [];
  for (const row of stale) {
    const r = upd.run(row.id);
    if (r.changes) closed.push(row.id);
  }
  return closed;
}

// ─── Proposal idempotency keys (#45) ─────────────────────────────────────────

/**
 * Claim the right to create one proposal for (business, template, window).
 * Backed by a PRIMARY KEY, so two concurrent analyses racing on the same
 * template cannot both win — the loser gets `false` and creates nothing.
 */
export function claimProposalSlot(
  businessId: string, templateId: string, windowKey: string, analysisId: string,
): boolean {
  assertBusiness(businessId);
  try {
    const r = db.prepare(`
      INSERT INTO hiring_proposal_keys (business_id, template_id, window_key, analysis_id, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(business_id, template_id, window_key) DO NOTHING
    `).run(businessId, templateId, windowKey, analysisId);
    return r.changes > 0;
  } catch {
    return false;
  }
}

export function attachTaskToProposalSlot(
  businessId: string, templateId: string, windowKey: string, taskId: string,
): void {
  db.prepare(`
    UPDATE hiring_proposal_keys SET task_id = ?
     WHERE business_id = ? AND template_id = ? AND window_key = ?
  `).run(taskId, businessId, templateId, windowKey);
}

/** Release a claimed-but-unused slot so a later analysis can retry cleanly. */
export function releaseProposalSlot(businessId: string, templateId: string, windowKey: string): void {
  db.prepare(`
    DELETE FROM hiring_proposal_keys
     WHERE business_id = ? AND template_id = ? AND window_key = ? AND task_id IS NULL
  `).run(businessId, templateId, windowKey);
}

/**
 * Free the slot held by a proposal that has reached a terminal state.
 *
 * The window key exists to stop CONCURRENT analyses duplicating a proposal —
 * it is not a second, weaker suppression mechanism. Once a proposal has been
 * rejected or cancelled, whether the role may be proposed again is governed
 * by hiring_decisions (#44/#50), so the slot is released here.
 */
export function releaseProposalSlotForTask(businessId: string, taskId: string): void {
  db.prepare('DELETE FROM hiring_proposal_keys WHERE business_id = ? AND task_id = ?')
    .run(businessId, taskId);
}

// ─── Trials + measured outcomes (#51, #56) ───────────────────────────────────

export function createTrial(
  businessId: string, templateId: string, plan: TrialPlan,
  opts: { taskId?: string | null; analysisId?: string | null; confidence?: number | null },
): string {
  assertBusiness(businessId);
  const id = generateId();
  db.prepare(`
    INSERT INTO hiring_trials (
      id, business_id, template_id, task_id, analysis_id, goal_id, signal_id,
      target_metric, baseline_value, target_value, measurement_window_days,
      evidence_deliverable, status, confidence_at_hire, measure_after, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?,
      datetime('now', '+' || ? || ' days'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id, businessId, templateId, opts.taskId ?? null, opts.analysisId ?? null,
    plan.goal_id, plan.signal_id, plan.target_metric,
    plan.baseline_value, plan.target_value, plan.measurement_window_days,
    plan.evidence_deliverable, opts.confidence ?? null, plan.measurement_window_days,
  );
  return id;
}

export function activateTrialForTask(businessId: string, taskId: string): void {
  assertBusiness(businessId);
  db.prepare(`
    UPDATE hiring_trials SET status = 'active', started_at = CURRENT_TIMESTAMP,
      measure_after = datetime('now', '+' || measurement_window_days || ' days'),
      updated_at = CURRENT_TIMESTAMP
    WHERE business_id = ? AND task_id = ? AND status = 'planned'
  `).run(businessId, taskId);
}

export function abandonTrialForTask(businessId: string, taskId: string, reason: string): void {
  assertBusiness(businessId);
  db.prepare(`
    UPDATE hiring_trials SET status = 'abandoned', verdict = 'insufficient_data',
      verdict_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE business_id = ? AND task_id = ? AND status IN ('planned', 'active')
  `).run(reason.slice(0, 300), businessId, taskId);
}

export interface RecordOutcomeInput {
  actualValue?: number | null;
  verdict: TrialVerdict;
  verdictReason?: string | null;
  costUsd?: number;
  effortNotes?: string | null;
  calibrationError?: number | null;
}

export function recordTrialOutcome(businessId: string, trialId: string, input: RecordOutcomeInput): void {
  assertBusiness(businessId);
  db.prepare(`
    UPDATE hiring_trials SET
      status = 'measured', actual_value = ?, verdict = ?, verdict_reason = ?,
      cost_usd = ?, effort_notes = ?, calibration_error = ?,
      measured_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND business_id = ?
  `).run(
    input.actualValue ?? null, input.verdict, input.verdictReason ?? null,
    input.costUsd ?? 0, input.effortNotes ?? null, input.calibrationError ?? null,
    trialId, businessId,
  );
}

export interface TrialRow {
  id: string;
  business_id: string;
  template_id: string;
  task_id: string | null;
  goal_id: string | null;
  target_metric: string | null;
  baseline_value: number | null;
  target_value: number | null;
  actual_value: number | null;
  measurement_window_days: number;
  status: string;
  verdict: TrialVerdict | null;
  verdict_reason: string | null;
  confidence_at_hire: number | null;
  calibration_error: number | null;
  cost_usd: number;
  evidence_deliverable: string | null;
  measure_after: string | null;
  measured_at: string | null;
  created_at: string;
}

export function getTrials(businessId: string, templateId?: string): TrialRow[] {
  assertBusiness(businessId);
  if (templateId) {
    return db.prepare(`
      SELECT * FROM hiring_trials WHERE business_id = ? AND template_id = ?
       ORDER BY created_at DESC LIMIT 50
    `).all(businessId, templateId) as TrialRow[];
  }
  return db.prepare(`
    SELECT * FROM hiring_trials WHERE business_id = ? ORDER BY created_at DESC LIMIT 200
  `).all(businessId) as TrialRow[];
}

export interface OutcomeHistory {
  total: number;
  successful: number;
  neutral: number;
  unsuccessful: number;
  insufficient_data: number;
  open: number;
  last_verdict: TrialVerdict | null;
  last_verdict_reason: string | null;
  mean_calibration_error: number | null;
  total_cost_usd: number;
}

/** Business-scoped outcome history per template — the learning loop's input (#56). */
export function getOutcomeHistory(businessId: string, templateId: string): OutcomeHistory {
  const trials = getTrials(businessId, templateId);
  const measured = trials.filter((t) => t.status === 'measured');
  const calib = measured.map((t) => t.calibration_error).filter((v): v is number => typeof v === 'number');
  return {
    total: trials.length,
    successful: measured.filter((t) => t.verdict === 'successful').length,
    neutral: measured.filter((t) => t.verdict === 'neutral').length,
    unsuccessful: measured.filter((t) => t.verdict === 'unsuccessful').length,
    insufficient_data: trials.filter((t) => t.verdict === 'insufficient_data').length,
    open: trials.filter((t) => t.status === 'planned' || t.status === 'active').length,
    last_verdict: measured[0]?.verdict ?? null,
    last_verdict_reason: measured[0]?.verdict_reason ?? null,
    mean_calibration_error: calib.length ? calib.reduce((a, b) => a + b, 0) / calib.length : null,
    total_cost_usd: trials.reduce((a, t) => a + (t.cost_usd ?? 0), 0),
  };
}

// ─── Coordination state (#45, #46) ───────────────────────────────────────────

export interface CoordinationRow {
  business_id: string;
  lease_holder: string | null;
  lease_expires_at: string | null;
  last_analysis_id: string | null;
  last_analysis_at: string | null;
  last_trigger_source: string | null;
  last_trigger_reason: string | null;
  last_input_fingerprint: string | null;
  next_eligible_at: string | null;
  skipped_count: number;
  coalesced_count: number;
  consecutive_failures: number;
  updated_at: string;
}

export function getCoordination(businessId: string): CoordinationRow | null {
  assertBusiness(businessId);
  return db.prepare('SELECT * FROM hiring_coordination WHERE business_id = ?')
    .get(businessId) as CoordinationRow | null;
}

export function ensureCoordination(businessId: string): CoordinationRow {
  assertBusiness(businessId);
  db.prepare(`INSERT INTO hiring_coordination (business_id) VALUES (?) ON CONFLICT(business_id) DO NOTHING`)
    .run(businessId);
  return getCoordination(businessId)!;
}

/**
 * Atomically take the per-business lease. The UPDATE's WHERE clause is the
 * mutual exclusion: it only matches when no live lease exists, so two
 * concurrent callers cannot both observe `changes > 0`.
 */
export function acquireLease(businessId: string, holder: string, ttlSeconds: number): boolean {
  ensureCoordination(businessId);
  const r = db.prepare(`
    UPDATE hiring_coordination
       SET lease_holder = ?, lease_expires_at = datetime('now', '+' || ? || ' seconds'),
           updated_at = CURRENT_TIMESTAMP
     WHERE business_id = ?
       AND (lease_holder IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= datetime('now'))
  `).run(holder, ttlSeconds, businessId);
  return r.changes > 0;
}

export function releaseLease(businessId: string, holder: string): void {
  db.prepare(`
    UPDATE hiring_coordination SET lease_holder = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND lease_holder = ?
  `).run(businessId, holder);
}

export function recordAnalysisPacing(
  businessId: string,
  opts: {
    analysisId: string; triggerSource: string; triggerReason: string | null;
    fingerprint: string | null; cooldownMinutes: number; failed?: boolean;
  },
): void {
  ensureCoordination(businessId);
  db.prepare(`
    UPDATE hiring_coordination SET
      last_analysis_id = ?, last_analysis_at = CURRENT_TIMESTAMP,
      last_trigger_source = ?, last_trigger_reason = ?,
      last_input_fingerprint = COALESCE(?, last_input_fingerprint),
      next_eligible_at = datetime('now', '+' || ? || ' minutes'),
      consecutive_failures = CASE WHEN ? = 1 THEN consecutive_failures + 1 ELSE 0 END,
      updated_at = CURRENT_TIMESTAMP
    WHERE business_id = ?
  `).run(
    opts.analysisId, opts.triggerSource, opts.triggerReason, opts.fingerprint,
    opts.cooldownMinutes, opts.failed ? 1 : 0, businessId,
  );
}

export function bumpSkipped(businessId: string, kind: 'skipped' | 'coalesced'): void {
  ensureCoordination(businessId);
  const col = kind === 'skipped' ? 'skipped_count' : 'coalesced_count';
  db.prepare(`UPDATE hiring_coordination SET ${col} = ${col} + 1, updated_at = CURRENT_TIMESTAMP WHERE business_id = ?`)
    .run(businessId);
}
