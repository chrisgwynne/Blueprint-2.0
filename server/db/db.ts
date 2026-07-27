import { Database } from 'bun:sqlite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { mkdirSync, readFileSync } from 'fs';

const __dbdir = dirname(fileURLToPath(import.meta.url));
const _defaultPath = resolve(__dbdir, '../../data/blueprint.db');

const DB_PATH = process.env['DATABASE_PATH']
  ? resolve(process.env['DATABASE_PATH'])
  : _defaultPath;

const _root = dirname(DB_PATH);

try {
  mkdirSync(_root, { recursive: true });
} catch (_) {}

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const needsSchema = !db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
).get();
if (needsSchema) {
  const schema = readFileSync(resolve(__dbdir, 'schema.sql'), 'utf8');
  db.exec(schema);
  console.log('[db] Fresh database — base schema applied automatically.');
}

// ─── Idempotent additive migrations (safe on every startup) ──────────────────

const STARTUP_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS signal_clusters (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    likely_cause TEXT,
    recommendation TEXT,
    severity TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT DEFAULT 'open',
    signal_ids JSON NOT NULL,
    created_by TEXT DEFAULT 'conductor',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signal_clusters_business_status ON signal_clusters(business_id, status)`,
  `ALTER TABLE signals ADD COLUMN cluster_id TEXT`,
  `ALTER TABLE tasks ADD COLUMN target_metric TEXT`,
  `ALTER TABLE tasks ADD COLUMN target_metric_baseline REAL`,
  `CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    title TEXT,
    type TEXT DEFAULT 'human',
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived_at DATETIME
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    mentions JSON DEFAULT '[]',
    attachments JSON DEFAULT '[]',
    metadata JSON DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS chat_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    reactor_id TEXT NOT NULL,
    reaction TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    version INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    trigger_type TEXT DEFAULT 'manual',
    trigger_config JSON DEFAULT '{}',
    steps JSON NOT NULL,
    created_by TEXT DEFAULT 'human',
    tags JSON DEFAULT '[]',
    project_id TEXT,
    run_count INTEGER DEFAULT 0,
    last_run_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workflows_business_status ON workflows(business_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows(business_id, trigger_type, status)`,
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    status TEXT DEFAULT 'running',
    triggered_by TEXT NOT NULL,
    trigger_reason TEXT,
    current_step INTEGER DEFAULT 0,
    steps_total INTEGER NOT NULL,
    steps_completed INTEGER DEFAULT 0,
    context JSON DEFAULT '{}',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_business ON workflow_runs(business_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS workflow_step_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    step_name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    input TEXT,
    output TEXT,
    tasks_created JSON DEFAULT '[]',
    approval_required INTEGER DEFAULT 0,
    approved_by TEXT,
    approved_at DATETIME,
    rejection_reason TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_run ON workflow_step_runs(run_id, step_index)`,
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'active',
    created_by TEXT DEFAULT 'human',
    assigned_agents JSON DEFAULT '[]',
    deadline DATETIME,
    metric_name TEXT,
    metric_baseline REAL,
    metric_target REAL,
    metric_current REAL,
    metric_unit TEXT,
    progress_pct REAL DEFAULT 0,
    last_checked DATETIME,
    achieved_at DATETIME,
    strategy TEXT,
    milestones JSON DEFAULT '[]',
    notes JSON DEFAULT '[]',
    tags JSON DEFAULT '[]',
    project_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goals_business_status ON goals(business_id, status)`,
  `CREATE TABLE IF NOT EXISTS goal_checks (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    metric_value REAL,
    progress_pct REAL,
    status_change TEXT,
    agent_note TEXT,
    tasks_proposed INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goal_checks_goal ON goal_checks(goal_id, checked_at)`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'active',
    color TEXT DEFAULT '#3b82f6',
    icon TEXT DEFAULT '📁',
    created_by TEXT DEFAULT 'human',
    assigned_agents JSON DEFAULT '[]',
    goals JSON DEFAULT '[]',
    tags JSON DEFAULT '[]',
    start_date DATETIME,
    target_date DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_business_status ON projects(business_id, status)`,
  `ALTER TABLE tasks ADD COLUMN project_id TEXT`,
  `ALTER TABLE signals ADD COLUMN project_id TEXT`,
  `CREATE TABLE IF NOT EXISTS action_windows (
    id TEXT PRIMARY KEY,
    action_type TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    min_days INTEGER NOT NULL,
    expected_days INTEGER NOT NULL,
    max_days INTEGER NOT NULL,
    metric_types JSON NOT NULL,
    measurement_notes TEXT,
    volatility TEXT DEFAULT 'medium',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS action_memory (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    task_id TEXT,
    action_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    target_url TEXT,
    target_entity TEXT,
    metrics_expected JSON,
    measurement_window_start DATETIME NOT NULL,
    measurement_window_end DATETIME NOT NULL,
    measurement_ready INTEGER DEFAULT 0,
    do_not_touch_until DATETIME NOT NULL,
    outcome_measured INTEGER DEFAULT 0,
    outcome_summary TEXT,
    related_action_ids JSON DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_action_memory_biz_open ON action_memory(business_id, outcome_measured)`,
  `CREATE INDEX IF NOT EXISTS idx_action_memory_window ON action_memory(business_id, measurement_window_end)`,
  `CREATE TABLE IF NOT EXISTS seasonal_patterns (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    pattern_type TEXT NOT NULL,
    pattern_data JSON NOT NULL,
    confidence REAL DEFAULT 0.5,
    data_points INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_seasonal_unique ON seasonal_patterns(business_id, metric_name, pattern_type)`,
  `ALTER TABLE tasks ADD COLUMN deferred_until DATETIME`,
  `ALTER TABLE tasks ADD COLUMN deferred_reason TEXT`,
  `ALTER TABLE tasks ADD COLUMN degraded_data INTEGER DEFAULT 0`,
  `ALTER TABLE kb_docs ADD COLUMN review_status TEXT DEFAULT 'ok'`,
  `ALTER TABLE kb_docs ADD COLUMN review_reason TEXT`,
  `ALTER TABLE kb_docs ADD COLUMN created_by TEXT`,
  `CREATE TABLE IF NOT EXISTS file_backups (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    task_id TEXT,
    remote_path TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    backed_up_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_file_backups_connector_path ON file_backups(connector_id, remote_path, backed_up_at)`,
  `CREATE INDEX IF NOT EXISTS idx_file_backups_task ON file_backups(task_id)`,
  `CREATE TABLE IF NOT EXISTS server_file_cache (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    content TEXT,
    content_hash TEXT,
    file_size INTEGER,
    last_modified DATETIME,
    cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_server_file_cache_unique ON server_file_cache(connector_id, remote_path)`,
  `CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    question TEXT NOT NULL,
    context TEXT,
    scenarios_json JSON NOT NULL,
    recommended TEXT,
    recommendation_reasoning TEXT,
    decision_criteria JSON,
    next_step TEXT,
    created_by TEXT DEFAULT 'human',
    kb_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scenarios_business_created ON scenarios(business_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    entity_a_type TEXT NOT NULL,
    entity_a_id TEXT NOT NULL,
    entity_a_title TEXT,
    entity_b_type TEXT NOT NULL,
    entity_b_id TEXT NOT NULL,
    entity_b_title TEXT,
    description TEXT NOT NULL,
    recommendation TEXT,
    resolution_kind TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    resolution_note TEXT,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conflicts_business_status ON conflicts(business_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_conflicts_entity_a ON conflicts(entity_a_type, entity_a_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conflicts_entity_b ON conflicts(entity_b_type, entity_b_id)`,
  `CREATE TABLE IF NOT EXISTS retrospectives (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    period_start DATETIME NOT NULL,
    period_end DATETIME NOT NULL,
    executive_summary TEXT,
    what_worked JSON DEFAULT '[]',
    what_didnt JSON DEFAULT '[]',
    learnings JSON DEFAULT '[]',
    agent_assessments JSON DEFAULT '[]',
    open_windows JSON DEFAULT '[]',
    recommendations JSON DEFAULT '[]',
    operating_changes JSON DEFAULT '[]',
    calibration_notes JSON DEFAULT '[]',
    full_report_json JSON,
    kb_path TEXT,
    triggered_by TEXT DEFAULT 'scheduler',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_retrospectives_business ON retrospectives(business_id, created_at)`,
  `ALTER TABLE signals ADD COLUMN attribution_analysis JSON`,
  `ALTER TABLE signals ADD COLUMN attribution_recommendation TEXT`,
  `ALTER TABLE signals ADD COLUMN attribution_primary_cause TEXT`,
  `ALTER TABLE signals ADD COLUMN attribution_primary_confidence REAL`,
  `ALTER TABLE signals ADD COLUMN do_not_act_until DATETIME`,
  `CREATE TABLE IF NOT EXISTS agent_calibration (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    business_id TEXT,
    period_start DATETIME NOT NULL,
    period_end DATETIME NOT NULL,
    tasks_with_outcomes INTEGER DEFAULT 0,
    avg_stated_confidence REAL,
    avg_actual_outcome_rate REAL,
    calibration_error REAL,
    calibration_score REAL,
    calibration_offset REAL DEFAULT 0,
    trend TEXT,
    notes TEXT,
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_calibration_agent ON agent_calibration(agent_id, period_end)`,
  `ALTER TABLE agent_runs ADD COLUMN calibration_data JSON`,
  `CREATE TABLE IF NOT EXISTS goal_suggestions (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    opportunity_value REAL,
    opportunity_unit TEXT DEFAULT 'gbp_per_month',
    metric_name TEXT,
    current_value REAL,
    target_value REAL,
    barrier TEXT,
    suggested_deadline DATETIME,
    suggested_agents JSON DEFAULT '[]',
    suggested_workflow_id TEXT,
    confidence REAL,
    connector_source TEXT,
    evidence JSON,
    status TEXT NOT NULL DEFAULT 'pending',
    snoozed_until DATETIME,
    dismissed_reason TEXT,
    accepted_goal_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goal_suggestions_business_status ON goal_suggestions(business_id, status)`,
  `CREATE TABLE IF NOT EXISTS scheduler_log (
    id TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    business_id TEXT,
    decision TEXT NOT NULL,
    was_scheduled_for DATETIME,
    delayed_to DATETIME,
    reason TEXT,
    constraints_json JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduler_log_job ON scheduler_log(job_name, created_at)`,
  `CREATE TABLE IF NOT EXISTS investigations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    metric_name TEXT,
    signal_id TEXT,
    question TEXT,
    triggered_by TEXT DEFAULT 'human',
    report_json JSON NOT NULL,
    plain_english TEXT,
    primary_cause TEXT,
    primary_confidence REAL,
    recommendation TEXT,
    recommended_action TEXT,
    kb_path TEXT,
    cache_until DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_investigations_biz_metric ON investigations(business_id, metric_name, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_investigations_signal ON investigations(signal_id)`,
  `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)`,
  `ALTER TABLE tasks ADD COLUMN measurement_window_days INTEGER`,
  `CREATE TABLE IF NOT EXISTS search_log (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    query TEXT NOT NULL,
    results_count INTEGER DEFAULT 0,
    search_depth TEXT DEFAULT 'basic',
    agent_id TEXT,
    run_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_search_log_business ON search_log(business_id, created_at)`,
  `ALTER TABLE tasks ADD COLUMN wishlist_connector_type TEXT`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('blueprint_github_token',   '""',   CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('blueprint_github_enabled', 'true', CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS self_heal_log (
    fingerprint TEXT PRIMARY KEY,
    component TEXT NOT NULL,
    error_type TEXT,
    error_message TEXT,
    diagnosis TEXT,
    severity TEXT,
    confidence REAL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_notified_at DATETIME,
    github_issue_number INTEGER,
    github_issue_url TEXT,
    github_pr_number INTEGER,
    github_pr_url TEXT,
    env_context TEXT,
    last_business_id TEXT,
    last_run_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_self_heal_log_last_seen ON self_heal_log(last_seen_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_self_heal_log_component ON self_heal_log(component, last_seen_at DESC)`,
  `CREATE TABLE IF NOT EXISTS intelligence_events (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    event_type TEXT NOT NULL,
    description TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_intel_business ON intelligence_events(business_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_intel_source ON intelligence_events(source_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_intel_target ON intelligence_events(target_type, target_id)`,
  `CREATE TABLE IF NOT EXISTS connector_gaps (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    connector_name TEXT NOT NULL,
    is_built INTEGER DEFAULT 0,
    times_surfaced INTEGER DEFAULT 1,
    first_surfaced_by TEXT,
    last_surfaced_by TEXT,
    last_surfaced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    task_id TEXT,
    status TEXT DEFAULT 'task_created',
    description TEXT,
    last_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_gaps_unique ON connector_gaps(business_id, connector_name)`,
  `CREATE INDEX IF NOT EXISTS idx_connector_gaps_last_surfaced ON connector_gaps(business_id, last_surfaced_at DESC)`,
  `ALTER TABLE agent_runs ADD COLUMN trigger_type TEXT`,
  `ALTER TABLE agent_runs ADD COLUMN work_reasons TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_trigger_type ON agent_runs(trigger_type, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS baselines (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    baseline_value REAL NOT NULL,
    baseline_date DATETIME NOT NULL,
    source_connector TEXT,
    context TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_baselines_unique ON baselines(business_id, metric_name)`,
  `CREATE INDEX IF NOT EXISTS idx_baselines_business ON baselines(business_id, baseline_date DESC)`,
  `CREATE TABLE IF NOT EXISTS roi_snapshots (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    snapshot_date DATETIME NOT NULL,
    period_start DATETIME,
    period_end DATETIME,
    total_cost_usd REAL,
    attributed_value_usd REAL,
    unattributed_value_usd REAL,
    attributed_decline_usd REAL,
    confidence_level TEXT,
    metrics_count INTEGER,
    outcomes_count INTEGER,
    narrative TEXT,
    full_report TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_roi_snapshots_business_date ON roi_snapshots(business_id, snapshot_date DESC)`,
  `CREATE TABLE IF NOT EXISTS counterfactual_estimates (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    target_metric TEXT,
    baseline_value REAL,
    estimated_monthly_cost_of_inaction_usd REAL,
    confidence TEXT,
    assumptions TEXT,
    reasoning TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_counterfactual_task ON counterfactual_estimates(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_counterfactual_business ON counterfactual_estimates(business_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS attribution_records (
    id TEXT PRIMARY KEY,
    business_id TEXT,
    task_id TEXT,
    metric_name TEXT NOT NULL,
    change_pct REAL,
    change_absolute REAL,
    estimated_value_usd REAL,
    confidence TEXT,
    evidence TEXT,
    measurement_window_days INTEGER,
    verified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attribution_business ON attribution_records(business_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_attribution_task ON attribution_records(task_id)`,
  `CREATE TABLE IF NOT EXISTS outbound_log (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    hostname TEXT,
    method TEXT DEFAULT 'GET',
    context TEXT,
    allowed INTEGER NOT NULL,
    block_reason TEXT,
    status_code INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbound_log_created ON outbound_log(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_outbound_log_allowed ON outbound_log(allowed, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_outbound_log_host ON outbound_log(hostname, created_at)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_outbound_enforcement', 'true', CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_outbound_allowlist',   '[]',   CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_sanitisation_enabled', 'true', CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_kb_scan_enabled',      'true', CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_output_monitor_enabled', 'true', CURRENT_TIMESTAMP)`,

  // ─── Agent lifecycle redesign (structured hiring / activation model) ────────
  // Additive columns on `agents`. lifecycle_state is the structured source of
  // truth that runs in parallel with the legacy free-text `status` column
  // (which run-gates in conductor/readiness/agent-runner still read). See
  // server/agents/agentLifecycle.ts for the state machine.
  `ALTER TABLE agents ADD COLUMN lifecycle_state TEXT`,
  `ALTER TABLE agents ADD COLUMN role TEXT`,
  `ALTER TABLE agents ADD COLUMN purpose TEXT`,
  `ALTER TABLE agents ADD COLUMN last_activation_reason TEXT`,
  `ALTER TABLE agents ADD COLUMN confidence REAL`,
  `ALTER TABLE agents ADD COLUMN requires_approval INTEGER DEFAULT 1`,
  `ALTER TABLE agents ADD COLUMN success_count INTEGER DEFAULT 0`,
  `ALTER TABLE agents ADD COLUMN failure_count INTEGER DEFAULT 0`,
  `ALTER TABLE agents ADD COLUMN cooldown_until DATETIME`,
  `ALTER TABLE agents ADD COLUMN kb_scope JSON DEFAULT '[]'`,
  `ALTER TABLE agents ADD COLUMN tools_allowed JSON DEFAULT '[]'`,
  `ALTER TABLE agents ADD COLUMN data_sources_allowed JSON DEFAULT '[]'`,
  `ALTER TABLE agents ADD COLUMN task_types_allowed JSON DEFAULT '[]'`,
  `ALTER TABLE agents ADD COLUMN current_task_id TEXT`,
  `ALTER TABLE agents ADD COLUMN lifecycle_updated_at DATETIME`,
  // Per-activation audit trail: every time an agent is activated we record the
  // trigger source, matched knowledge areas, selection reasoning, alternatives,
  // confidence, the assigned task and the evidence used.
  `CREATE TABLE IF NOT EXISTS agent_activations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    trigger_source TEXT NOT NULL,
    trigger_ref TEXT,
    matched_areas JSON DEFAULT '[]',
    selection_reason TEXT,
    alternatives JSON DEFAULT '[]',
    confidence REAL,
    task_id TEXT,
    evidence JSON DEFAULT '[]',
    run_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_activations_agent ON agent_activations(agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_activations_business ON agent_activations(business_id, created_at DESC)`,
  // Transition audit trail for the lifecycle state machine.
  `CREATE TABLE IF NOT EXISTS agent_lifecycle_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    business_id TEXT,
    from_state TEXT,
    to_state TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    metadata JSON DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_events_agent ON agent_lifecycle_events(agent_id, created_at DESC)`,

  // ─── Autonomous execution reliability (idempotency, atomic queueing,
  // leases, crash recovery) ─────────────────────────────────────────────────

  // Generic BAP request-idempotency store. Scoped by (agent_id, scope,
  // idempotency_key) — the same key from two different agents, or reused
  // for two different operation types, are different claims.
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress',
    response_status INTEGER,
    response_body JSON,
    resource_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    expires_at DATETIME NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_claim ON idempotency_keys(agent_id, scope, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at)`,

  // Durable execution jobs — the single record of "this approved task
  // needs to be executed" / "is being executed" / "was executed". Created
  // atomically with approval (task-queue.ts:approveTask), claimed by a
  // worker via a leased compare-and-swap, and the sole trigger for
  // executor.ts:executeTask() — see jobs/scheduler.ts's execution worker.
  `CREATE TABLE IF NOT EXISTS execution_jobs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    task_version INTEGER NOT NULL DEFAULT 1,
    business_id TEXT NOT NULL,
    action_type TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    lease_owner TEXT,
    lease_expires_at DATETIME,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at DATETIME,
    external_reference JSON,
    last_error TEXT,
    result JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // At most one *active* (non-terminal) job per task at a time — this is
  // the "exactly one execution job per approved task/version" guarantee.
  // Terminal jobs (succeeded/failed/dead_letter/cancelled) are excluded so
  // history can accumulate (e.g. after a manual retry creates a fresh job).
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_jobs_one_active_per_task
     ON execution_jobs(task_id)
     WHERE status IN ('queued', 'leased', 'executing', 'manual_review')`,
  `CREATE INDEX IF NOT EXISTS idx_execution_jobs_business ON execution_jobs(business_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_jobs_claimable ON execution_jobs(status, next_attempt_at)`,

  // Task table additions: a monotonic version bumped on every approval (so
  // an execution job can be bound to the exact approval it came from), and
  // an immutable snapshot of action_payload taken at approval time (so a
  // later mutation of the live task row — if one were ever added — can
  // never change what an already-approved job executes).
  `ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tasks ADD COLUMN approved_payload_snapshot JSON`,

  // Single global renewable leader lease. Every scheduled job (cron
  // callback or the execution-job worker tick) checks this before doing
  // any work; only the current holder proceeds. TTL-based, so a crashed
  // holder's lease simply expires and another instance takes over — no
  // manual intervention needed. See jobs/scheduler-lock.ts.
  `CREATE TABLE IF NOT EXISTS scheduler_locks (
    lock_name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // ─── Phase 2: BAP completeness (request/correlation IDs) ──────────────────
  // Every BAP call is tagged with a request_id (unique per call) and a
  // correlation_id (defaults to request_id, but a caller can supply its own
  // via X-Correlation-Id to tie a multi-call workflow together) — see
  // server/bap/route-helpers.ts. Persisting both onto the existing
  // per-call bap_audit row (rather than a new table) keeps one row per BAP
  // call as the source of truth for both timing/status and now traceability.
  `ALTER TABLE bap_audit ADD COLUMN request_id TEXT`,
  `ALTER TABLE bap_audit ADD COLUMN correlation_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_bap_audit_correlation ON bap_audit(correlation_id)`,
];

for (const sql of STARTUP_MIGRATIONS) {
  try { db.exec(sql); }
  catch (err) {
    if (!/duplicate column|already exists/i.test((err as Error).message)) {
      console.warn('[db] startup migration warning:', (err as Error).message);
    }
  }
}

// ─── One-off data migration: agent lifecycle redesign ────────────────────────

(function applyAgentLifecycleMigration() {
  try {
    const marker = db.prepare(
      "SELECT value FROM settings WHERE key = 'migration_agent_lifecycle_v1'"
    ).get();
    if (marker) return;

    const nonConductor = db.prepare(
      "SELECT id FROM agents WHERE id != 'conductor' AND status = 'active'"
    ).all() as Array<{ id: string }>;

    let reset = 0;
    for (const row of nonConductor) {
      const productiveRun = db.prepare(
        `SELECT 1 FROM agent_runs
         WHERE agent_id = ? AND status = 'complete'
           AND (COALESCE(tasks_proposed, 0) > 0 OR COALESCE(signals_detected, 0) > 0)
         LIMIT 1`
      ).get(row.id);
      if (productiveRun) continue;

      db.prepare("UPDATE agents SET status = 'pending' WHERE id = ?").run(row.id);
      reset++;
    }

    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('migration_agent_lifecycle_v1', ?, CURRENT_TIMESTAMP)`
    ).run(JSON.stringify({ ran_at: new Date().toISOString(), non_conductor_reset: reset }));

    if (reset > 0) {
      console.log(`[db] Agent lifecycle migration: reset ${reset} unproductive agents to 'pending'.`);
    }
  } catch (err) {
    console.warn('[db] agent lifecycle migration skipped:', (err as Error).message);
  }
})();

// ─── Backfill structured lifecycle_state from legacy status (idempotent) ──────
// Maps the existing free-text `status` column onto the new structured
// lifecycle_state for any row that hasn't been backfilled yet. Run-gating still
// reads `status`; lifecycle_state is the structured view the new model owns.
(function backfillAgentLifecycleState() {
  try {
    const rows = db.prepare(
      "SELECT id, status, lifecycle_state FROM agents WHERE lifecycle_state IS NULL"
    ).all() as Array<{ id: string; status: string | null; lifecycle_state: string | null }>;
    if (rows.length === 0) return;
    const map: Record<string, string> = {
      active: 'standby',     // installed + ready, but not actively working until triggered
      pending: 'candidate',  // installed but not ready / not approved to work
      paused: 'standby',
      disabled: 'archived',
      retired: 'archived',
    };
    const stmt = db.prepare(
      "UPDATE agents SET lifecycle_state = ?, lifecycle_updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    for (const r of rows) {
      const next = map[r.status ?? 'active'] ?? 'standby';
      stmt.run(next, r.id);
    }
    console.log(`[db] Backfilled lifecycle_state for ${rows.length} agent(s).`);
  } catch (err) {
    console.warn('[db] lifecycle_state backfill skipped:', (err as Error).message);
  }
})();

// ─── One-off data migration: strip legacy wildcard BAP grants ────────────────
// POST /register used to be open and granted whatever permissions/
// business_access a caller requested, including wildcards ('*:*',
// 'resource:*', business_access:['*']). The fix (bap/auth.ts,
// requireRegistrationAuth + filterGrantablePermissions/filterValidBusinessIds)
// only closes that door for *future* registrations — any bap_agents row
// created before the fix may still hold a wildcard grant from the old
// behaviour, and would otherwise keep working indefinitely. This strips
// wildcard entries (and only wildcard entries — concrete permissions like
// 'signals:read' and concrete business IDs are left untouched) from every
// existing row, once. Not implemented as an import from bap/auth.ts to
// avoid a circular dependency (auth.ts imports db.ts); the "strip anything
// containing '*'" rule is intentionally simpler than and independent of
// that module's grantable-permission allow-list.
(function stripLegacyWildcardBapGrants() {
  try {
    const marker = db.prepare(
      "SELECT value FROM settings WHERE key = 'migration_bap_strip_wildcards_v1'"
    ).get();
    if (marker) return;

    const agents = db.prepare('SELECT id, name, permissions, business_access FROM bap_agents').all() as
      Array<{ id: string; name: string; permissions: string | null; business_access: string | null }>;

    const affected: Array<{ id: string; name: string; before: { permissions: unknown[]; business_access: unknown[] }; after: { permissions: unknown[]; business_access: unknown[] } }> = [];

    for (const agent of agents) {
      let perms: unknown[] = [];
      let access: unknown[] = [];
      try { const p = JSON.parse(agent.permissions ?? '[]'); if (Array.isArray(p)) perms = p; } catch {}
      try { const a = JSON.parse(agent.business_access ?? '[]'); if (Array.isArray(a)) access = a; } catch {}

      const strippedPerms = perms.filter((p) => !(typeof p === 'string' && p.includes('*')));
      const strippedAccess = access.filter((a) => a !== '*');

      const permsChanged = strippedPerms.length !== perms.length;
      const accessChanged = strippedAccess.length !== access.length;
      if (!permsChanged && !accessChanged) continue;

      db.prepare('UPDATE bap_agents SET permissions = ?, business_access = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(strippedPerms), JSON.stringify(strippedAccess), agent.id);

      affected.push({
        id: agent.id,
        name: agent.name,
        before: { permissions: perms, business_access: access },
        after: { permissions: strippedPerms, business_access: strippedAccess },
      });
    }

    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('migration_bap_strip_wildcards_v1', ?, CURRENT_TIMESTAMP)`
    ).run(JSON.stringify({ ran_at: new Date().toISOString(), affected }));

    if (affected.length > 0) {
      console.error(
        `[db] SECURITY MIGRATION: stripped wildcard BAP permissions/business_access from ${affected.length} ` +
        `pre-existing agent(s) issued before the registration fix: ${affected.map((a) => `${a.name} (${a.id})`).join(', ')}. ` +
        `These agents may now be under-permissioned for what they were actually doing — review them in ` +
        `Settings → External Agents and re-grant specific (non-wildcard) permissions/business access as needed.`
      );
    }
  } catch (err) {
    console.warn('[db] BAP wildcard-grant migration skipped:', (err as Error).message);
  }
})();

// ─── Exports ──────────────────────────────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID();
}

export function audit(
  businessId: string | null,
  entityType: string,
  entityId: string,
  action: string,
  actor: string,
  beforeState: unknown = null,
  afterState: unknown = null,
  metadata: unknown = null,
): void {
  db.prepare(`
    INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, before_state, after_state, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    generateId(),
    businessId ?? null,
    entityType,
    entityId,
    action,
    actor,
    beforeState !== null ? JSON.stringify(beforeState) : null,
    afterState !== null ? JSON.stringify(afterState) : null,
    metadata !== null ? JSON.stringify(metadata) : null,
  );
}

export default db;
