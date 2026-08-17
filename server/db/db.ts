import { Database } from 'bun:sqlite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { mkdirSync, readFileSync } from 'fs';
import { resolveDbPath, isMemoryDbPath } from './resolve-db-path.js';

const __dbdir = dirname(fileURLToPath(import.meta.url));
// Stable base for resolving a relative DATABASE_PATH — the repo root, NOT
// process.cwd(). Using process.cwd() meant the same inherited env value
// (e.g. DATABASE_PATH=./data/blueprint.db) silently opened a different
// "shadow" database depending on where a standalone Bun command was
// launched from (repo root vs. server/). See resolve-db-path.ts and
// https://github.com/chrisgwynne/Blueprint-2.0/issues/41. Matches the
// PROJECT_ROOT convention already used by server/db/init.ts.
const __repoRoot = resolve(__dbdir, '../..');

// ':memory:' (and bun:sqlite's other in-memory sentinels, e.g.
// 'file::memory:?cache=shared') must be passed through to Database()
// verbatim â€” resolve()ing it turns the special string into a literal
// relative-path file (e.g. "<cwd>/:memory:"), silently defeating the
// "ephemeral, never touches disk" guarantee test-setup.ts relies on and
// leaving a real, ever-growing file that persists across every process
// invocation instead of the intended fresh-per-process database.
const _envPath = process.env['DATABASE_PATH'];
const _isMemory = isMemoryDbPath(_envPath);

// Exported so any other module that needs to report/inspect the database's
// on-disk location (e.g. health endpoints) reads the SAME resolved path the
// DB module actually opened, rather than independently re-resolving
// DATABASE_PATH (and risking drift, including the process.cwd() bug above).
export const DB_PATH = resolveDbPath(_envPath, __repoRoot);

if (!_isMemory) {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  } catch (_) {}
}

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
  console.log('[db] Fresh database â€” base schema applied automatically.');
}

// â”€â”€â”€ Idempotent additive migrations (safe on every startup) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    icon TEXT DEFAULT 'ðŸ“',
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

  // â”€â”€â”€ Agent lifecycle redesign (structured hiring / activation model) â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€â”€ Autonomous execution reliability (idempotency, atomic queueing,
  // leases, crash recovery) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Generic BAP request-idempotency store. Scoped by (agent_id, scope,
  // idempotency_key) â€” the same key from two different agents, or reused
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

  // Durable execution jobs â€” the single record of "this approved task
  // needs to be executed" / "is being executed" / "was executed". Created
  // atomically with approval (task-queue.ts:approveTask), claimed by a
  // worker via a leased compare-and-swap, and the sole trigger for
  // executor.ts:executeTask() â€” see jobs/scheduler.ts's execution worker.
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
  // At most one *active* (non-terminal) job per task at a time â€” this is
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
  // later mutation of the live task row â€” if one were ever added â€” can
  // never change what an already-approved job executes).
  `ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tasks ADD COLUMN approved_payload_snapshot JSON`,

  // Single global renewable leader lease. Every scheduled job (cron
  // callback or the execution-job worker tick) checks this before doing
  // any work; only the current holder proceeds. TTL-based, so a crashed
  // holder's lease simply expires and another instance takes over â€” no
  // manual intervention needed. See jobs/scheduler-lock.ts.
  `CREATE TABLE IF NOT EXISTS scheduler_locks (
    lock_name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // â”€â”€â”€ Phase 2: BAP completeness (request/correlation IDs) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Every BAP call is tagged with a request_id (unique per call) and a
  // correlation_id (defaults to request_id, but a caller can supply its own
  // via X-Correlation-Id to tie a multi-call workflow together) â€” see
  // server/bap/route-helpers.ts. Persisting both onto the existing
  // per-call bap_audit row (rather than a new table) keeps one row per BAP
  // call as the source of truth for both timing/status and now traceability.
  `ALTER TABLE bap_audit ADD COLUMN request_id TEXT`,
  `ALTER TABLE bap_audit ADD COLUMN correlation_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_bap_audit_correlation ON bap_audit(correlation_id)`,

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Phase 3: Strategic Intelligence & Autonomous Business Reasoning
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // â”€â”€â”€ 3.1 Goal Engine â€” real foreign keys, replacing the project_id proxy â”€â”€
  // goals/tasks/signals previously only shared an optional project_id
  // column (see PHASE2.md). These are the real relationships Phase 2
  // documented as a gap. Additive: project_id is left in place (nothing
  // reads it exclusively after this), and every new column is nullable so
  // existing rows are unaffected until backfilled below.
  `ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id)`,
  `ALTER TABLE signals ADD COLUMN goal_id TEXT REFERENCES goals(id)`,
  `ALTER TABLE task_outcomes ADD COLUMN goal_id TEXT REFERENCES goals(id)`,
  `ALTER TABLE agent_runs ADD COLUMN goal_id TEXT REFERENCES goals(id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_goal ON signals(goal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_outcomes_goal ON task_outcomes(goal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_goal ON agent_runs(goal_id)`,
  // One-time-per-row backfill: only ever fills a NULL goal_id from the old
  // project_id proxy, so it is safe to re-run on every startup (a no-op
  // once a row has a goal_id) and a no-op on a fresh database.
  `UPDATE tasks SET goal_id = (
     SELECT g.id FROM goals g WHERE g.project_id = tasks.project_id AND g.business_id = tasks.business_id LIMIT 1
   ) WHERE goal_id IS NULL AND project_id IS NOT NULL`,
  `UPDATE signals SET goal_id = (
     SELECT g.id FROM goals g WHERE g.project_id = signals.project_id AND g.business_id = signals.business_id LIMIT 1
   ) WHERE goal_id IS NULL AND project_id IS NOT NULL`,

  // Goal model additions the spec calls for that had no column at all.
  // milestones/dependencies get real relational tables below instead of
  // joining the existing milestones/notes/tags JSON columns â€” those three
  // stay JSON (small, free-form, non-relational lists); milestones and
  // dependencies are the two that are genuinely relational (a growing,
  // independently-queried collection, and a goal-to-goal edge).
  `ALTER TABLE goals ADD COLUMN owner TEXT`,
  `ALTER TABLE goals ADD COLUMN confidence REAL`,
  `ALTER TABLE goals ADD COLUMN priority TEXT DEFAULT 'p2'`,

  `CREATE TABLE IF NOT EXISTS goal_milestones (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    title TEXT NOT NULL,
    target_pct REAL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    achieved_at DATETIME,
    source TEXT DEFAULT 'human',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goal_milestones_goal ON goal_milestones(goal_id)`,

  // goal_dependencies is deliberately goal-to-goal only (the spec's
  // "dependencies" field, e.g. "Goal B can't start until Goal A hits 50%").
  // Cross-entity dependency conflicts (a *task* depending on something)
  // are handled by the conflict engine, not this table.
  `CREATE TABLE IF NOT EXISTS goal_dependencies (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    depends_on_goal_id TEXT NOT NULL REFERENCES goals(id),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_dependencies_unique ON goal_dependencies(goal_id, depends_on_goal_id)`,

  // â”€â”€â”€ 3.2 Strategic Planning Engine â€” durable, versioned assessments â”€â”€â”€â”€â”€â”€â”€
  // One row per reasoning pass (goal-reasoner.ts), so "update it over time"
  // (the spec's words) means append, not overwrite â€” the goal's assessment
  // history is itself part of its timeline.
  `CREATE TABLE IF NOT EXISTS goal_assessments (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    feasibility_verdict TEXT,
    feasibility_confidence REAL,
    feasibility_reasoning TEXT,
    key_constraint TEXT,
    expected_impact TEXT,
    gap_analysis JSON,
    assumptions JSON DEFAULT '[]',
    risks JSON DEFAULT '[]',
    dependencies JSON DEFAULT '[]',
    measurement_plan JSON,
    success_criteria JSON DEFAULT '[]',
    recommended_strategy_id TEXT,
    created_by TEXT DEFAULT 'goal-reasoner',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goal_assessments_goal ON goal_assessments(goal_id, created_at)`,

  // â”€â”€â”€ 3.3 Multi-Strategy Planning â€” comparable candidate strategies â”€â”€â”€â”€â”€â”€â”€â”€
  // goal-reasoner.ts already asks the LLM for multiple "paths"; this table
  // is where each path becomes a durable, individually comparable object
  // (previously they only existed inside a JSON blob in the reasoning
  // response and a rendered KB markdown page â€” never queryable by BAP).
  `CREATE TABLE IF NOT EXISTS goal_strategies (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    assessment_id TEXT REFERENCES goal_assessments(id),
    name TEXT NOT NULL,
    summary TEXT,
    expected_impact_summary TEXT,
    confidence REAL,
    estimated_effort TEXT,
    estimated_cost REAL,
    estimated_cost_unit TEXT DEFAULT 'gbp',
    time_to_impact_days INTEGER,
    historical_success_rate REAL,
    historical_sample_size INTEGER DEFAULT 0,
    evidence JSON DEFAULT '[]',
    depends_on JSON DEFAULT '[]',
    is_recommended INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goal_strategies_goal ON goal_strategies(goal_id, status)`,

  // â”€â”€â”€ 3.4 Conflict Engine â€” a category dimension orthogonal to conflict_type â”€
  // conflict_type already distinguishes *which entities* are in conflict
  // (goal_vs_goal, task_vs_window, task_vs_goal, and the new types added in
  // conflict-engine.ts this phase). category distinguishes *what kind* of
  // conflict it is (direct/resource/timing/dependency), matching the
  // spec's explicit taxonomy, independent of which entity types collided.
  `ALTER TABLE conflicts ADD COLUMN category TEXT DEFAULT 'direct'`,
  `UPDATE conflicts SET category = 'timing' WHERE conflict_type = 'task_vs_window' AND category = 'direct'`,

  // â”€â”€â”€ 3.5 Decision Memory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Every "why did we decide X" question Hermes can ask should be
  // answerable from this table alone â€” evidence and reasoning captured at
  // decision time, not reconstructed later from scattered rows.
  // related_*_id columns are deliberately plain TEXT â€” NOT foreign keys â€”
  // same "soft reference" pattern as audit_log.entity_id. A decision is a
  // durable historical record; it must remain readable (and its FK-owning
  // row must remain deletable) even after the goal/task/signal/outcome/
  // conflict it references is gone. A hard FK here would mean deleting a
  // task could never fail loudly (good) but would then make deleting a
  // long-completed task impossible for as long as any decision ever
  // mentioned it (bad) â€” audit-log-style logs accept dangling references
  // for exactly this reason.
  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    decision_type TEXT NOT NULL,
    title TEXT NOT NULL,
    decision TEXT NOT NULL,
    reasoning TEXT,
    evidence JSON DEFAULT '[]',
    confidence REAL,
    alternatives_rejected JSON DEFAULT '[]',
    author TEXT NOT NULL,
    related_goal_id TEXT,
    related_task_id TEXT,
    related_signal_id TEXT,
    related_outcome_id TEXT,
    related_conflict_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_business_created ON decisions(business_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_goal ON decisions(related_goal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(related_task_id)`,

  // â”€â”€â”€ 3.6 Agent Calibration â€” proper calibration, not a single average â”€â”€â”€â”€â”€
  // Additive columns; existing rows default calibration_method to
  // 'simple_average' so old and new rows are honestly distinguishable in
  // the same table rather than silently reinterpreted.
  `ALTER TABLE agent_calibration ADD COLUMN false_positives INTEGER DEFAULT 0`,
  `ALTER TABLE agent_calibration ADD COLUMN false_negatives INTEGER DEFAULT 0`,
  `ALTER TABLE agent_calibration ADD COLUMN recommendations_accepted INTEGER DEFAULT 0`,
  `ALTER TABLE agent_calibration ADD COLUMN recommendations_rejected INTEGER DEFAULT 0`,
  `ALTER TABLE agent_calibration ADD COLUMN execution_success_rate REAL`,
  `ALTER TABLE agent_calibration ADD COLUMN long_term_success_rate REAL`,
  `ALTER TABLE agent_calibration ADD COLUMN calibration_method TEXT DEFAULT 'simple_average'`,
  `ALTER TABLE agent_calibration ADD COLUMN conservatism_factor REAL DEFAULT 1.0`,
  `ALTER TABLE agent_calibration ADD COLUMN bins JSON`,

  // â”€â”€â”€ 3.9 Knowledge Graph â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // business_id is nullable to allow shared/abstract nodes (e.g. a
  // cross-business "tactic" entity) that don't belong to one tenant â€”
  // everything tenant-scoped sets it. ref_table/ref_id link back to the
  // row this node represents (a task, goal, signal, decision, ...) so the
  // graph never duplicates data, only relationships.
  `CREATE TABLE IF NOT EXISTS kg_entities (
    id TEXT PRIMARY KEY,
    business_id TEXT REFERENCES businesses(id),
    entity_type TEXT NOT NULL,
    ref_table TEXT,
    ref_id TEXT,
    label TEXT NOT NULL,
    metadata JSON DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kg_entities_business_type ON kg_entities(business_id, entity_type)`,
  `CREATE INDEX IF NOT EXISTS idx_kg_entities_ref ON kg_entities(ref_table, ref_id)`,

  `CREATE TABLE IF NOT EXISTS kg_edges (
    id TEXT PRIMARY KEY,
    business_id TEXT REFERENCES businesses(id),
    from_entity_id TEXT NOT NULL REFERENCES kg_entities(id),
    to_entity_id TEXT NOT NULL REFERENCES kg_entities(id),
    edge_type TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    evidence TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_edges(from_entity_id, edge_type)`,
  `CREATE INDEX IF NOT EXISTS idx_kg_edges_to ON kg_edges(to_entity_id, edge_type)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_edges_unique ON kg_edges(from_entity_id, to_entity_id, edge_type)`,

  // â”€â”€â”€ 3.10 Opportunity Engine â€” extend goal_suggestions, don't fork it â”€â”€â”€â”€
  // goal_suggestions (Brain feature 6, server/brain/goal-suggester.ts) is
  // already exactly this: a quantified-opportunity scanner over connector
  // data. These columns add the remaining fields the spec asks an
  // "opportunity" to carry that goal_suggestions didn't yet have.
  `ALTER TABLE goal_suggestions ADD COLUMN required_effort TEXT`,
  `ALTER TABLE goal_suggestions ADD COLUMN related_goal_ids JSON DEFAULT '[]'`,
  `ALTER TABLE goal_suggestions ADD COLUMN related_risks JSON DEFAULT '[]'`,
  `ALTER TABLE goal_suggestions ADD COLUMN why_it_matters TEXT`,

  // â”€â”€â”€ 3.12 Cross-Business Learning â€” abstracted patterns, no business_id â”€â”€
  // Deliberately has no business_id, business name, URL, or any other
  // tenant-identifying column â€” enforced by omission, not by a redaction
  // pass. pattern_key is a stable abstract key (e.g.
  // "seo.meta_rewrite.low_ctr_high_impressions"), not a business-specific
  // string.
  `CREATE TABLE IF NOT EXISTS cross_business_patterns (
    id TEXT PRIMARY KEY,
    pattern_key TEXT NOT NULL,
    action_type TEXT,
    category TEXT,
    description TEXT NOT NULL,
    sample_size INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    success_rate REAL,
    applicable_business_types JSON DEFAULT '[]',
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_business_patterns_key ON cross_business_patterns(pattern_key)`,

  // â”€â”€â”€ 3.14 Constraint Engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // restraint.ts already enforces one constraint type (measurement
  // windows) implicitly via action_memory. This table generalizes to the
  // other types the spec lists (budgets, hours, resource limits, campaign
  // freezes, seasonality, manual constraints) as explicit, queryable,
  // operator-authored rows rather than inferred state.
  `CREATE TABLE IF NOT EXISTS constraints (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    constraint_type TEXT NOT NULL,
    scope JSON DEFAULT '{}',
    limit_value REAL,
    limit_unit TEXT,
    period TEXT,
    starts_at DATETIME,
    ends_at DATETIME,
    active INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    created_by TEXT DEFAULT 'human',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_constraints_business_active ON constraints(business_id, active)`,

  // â”€â”€â”€ Phase 2-INT.1 Business Truth Layer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Canonical per-business profile. Nothing should infer business identity
  // or capability (type, allowed connectors/agents/actions, policies) from
  // connector data or free-text fields â€” everything consults this row.
  `CREATE TABLE IF NOT EXISTS business_profiles (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL UNIQUE REFERENCES businesses(id),
    business_type TEXT NOT NULL DEFAULT 'other',
    operating_model TEXT,
    primary_domain TEXT,
    primary_brand TEXT,
    products_services JSON DEFAULT '[]',
    supported_platforms JSON DEFAULT '[]',
    enabled_connector_types JSON DEFAULT '[]',
    disabled_connector_types JSON DEFAULT '[]',
    allowed_agent_types JSON DEFAULT '[]',
    allowed_action_types JSON DEFAULT '[]',
    strategic_goals JSON DEFAULT '[]',
    kpis JSON DEFAULT '[]',
    operating_constraints JSON DEFAULT '{}',
    approval_policy JSON DEFAULT '{}',
    automation_policy JSON DEFAULT '{}',
    risk_policy JSON DEFAULT '{}',
    deployment_policy JSON DEFAULT '{}',
    seo_policy JSON DEFAULT '{}',
    ecommerce_policy JSON DEFAULT '{}',
    lead_gen_policy JSON DEFAULT '{}',
    communication_preferences JSON DEFAULT '{}',
    inferred_fields JSON DEFAULT '[]',
    confirmed_by_human INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_business_profiles_business ON business_profiles(business_id)`,

  // â”€â”€â”€ Phase 2-INT.2 Typed Action & Executor Registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Consolidates the 3 previously-drifting hand-maintained action-type
  // lists (executor.ts EXECUTABLE_ACTION_TYPES, action-payloads.ts
  // ActionType union, execution-safety.ts EXTERNAL_VERIFIABLE_ACTIONS) into
  // one queryable table. Also carries the Outcome Learning Engine's
  // per-action-type measurement configuration (measurement_window_days,
  // success_metrics, ...) so the two subsystems share one definition
  // instead of a second parallel table.
  `CREATE TABLE IF NOT EXISTS action_registry (
    action_type TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    payload_schema JSON DEFAULT '{}',
    required_connector_types JSON DEFAULT '[]',
    supported_business_types JSON DEFAULT '[]',
    required_permissions JSON DEFAULT '[]',
    supports_rollback INTEGER NOT NULL DEFAULT 0,
    verification_routine TEXT,
    retry_policy JSON DEFAULT '{}',
    timeout_ms INTEGER,
    side_effect_classification TEXT NOT NULL DEFAULT 'internal_idempotent',
    requires_approval INTEGER NOT NULL DEFAULT 1,
    risk_level TEXT NOT NULL DEFAULT 'medium',
    measurement_window_days JSON DEFAULT '[7,14,28]',
    success_metrics JSON DEFAULT '[]',
    expected_impact TEXT,
    acceptable_variance REAL DEFAULT 0.05,
    confidence_adjustment_rules JSON DEFAULT '{}',
    follow_up_schedule JSON DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // â”€â”€â”€ Phase 2-INT.3 Connector Confidence & Identity Verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  `CREATE TABLE IF NOT EXISTS connector_confidence (
    id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL UNIQUE REFERENCES connectors(id),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    connectivity_status TEXT NOT NULL DEFAULT 'unknown',
    authentication_status TEXT NOT NULL DEFAULT 'unknown',
    authorisation_status TEXT NOT NULL DEFAULT 'unknown',
    resource_mapping_status TEXT NOT NULL DEFAULT 'unknown',
    business_identity_status TEXT NOT NULL DEFAULT 'unknown',
    website_verification_status TEXT NOT NULL DEFAULT 'unknown',
    freshness_status TEXT NOT NULL DEFAULT 'unknown',
    historical_consistency_status TEXT NOT NULL DEFAULT 'unknown',
    data_completeness_status TEXT NOT NULL DEFAULT 'unknown',
    overall_confidence REAL NOT NULL DEFAULT 0,
    overall_status TEXT NOT NULL DEFAULT 'unknown',
    verification_details JSON DEFAULT '{}',
    last_verified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_connector_confidence_business ON connector_confidence(business_id)`,

  // â”€â”€â”€ Phase 2-INT.4 World Model â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Timestamped, attributable snapshots so reasoning can compare
  // before/after states. The "current" world model for a business is
  // simply its most recent snapshot row (ORDER BY created_at DESC LIMIT 1).
  `CREATE TABLE IF NOT EXISTS world_model_snapshots (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    snapshot JSON NOT NULL,
    trigger_source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_world_model_snapshots_business_time ON world_model_snapshots(business_id, created_at DESC)`,

  // â”€â”€â”€ Phase 2-INT â€” Blueprint System Issues â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Raised when validation fails (registry/business-type/connector checks)
  // instead of silently creating or executing a task. related_task_id /
  // related_connector_id are soft references (no REFERENCES clause) â€” a
  // system issue is a historical/audit record and must survive deletion of
  // the task or connector it references (same lesson learned the hard way
  // on the `decisions` table in Phase 3).
  `CREATE TABLE IF NOT EXISTS system_issues (
    id TEXT PRIMARY KEY,
    business_id TEXT REFERENCES businesses(id),
    issue_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    title TEXT NOT NULL,
    description TEXT,
    related_task_id TEXT,
    related_connector_id TEXT,
    related_action_type TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    metadata JSON DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  )`,
  `CREATE INDEX IF NOT EXISTS idx_system_issues_business_status ON system_issues(business_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_system_issues_related_task ON system_issues(related_task_id)`,

  // â”€â”€â”€ Phase 2-INT.2 (cont.) Seed the registry with every action_type in â”€â”€â”€â”€
  // real use today (executor.ts EXECUTABLE_ACTION_TYPES âˆª agentActivation-
  // Rules.ts ROLE_SPECS task_types). INSERT OR IGNORE so this never
  // clobbers an operator's own edits, and re-runs harmlessly on every
  // startup (safe to extend this list in a later deploy â€” new rows just
  // get inserted, existing ones are left alone). Without this seed,
  // turning on registry validation (task-queue.ts approveTask()) would
  // immediately block every action type currently in production use.
  `INSERT OR IGNORE INTO action_registry (action_type, description, required_connector_types, supported_business_types, side_effect_classification, risk_level, supports_rollback, requires_approval) VALUES
    ('github_issue', 'Create or update a GitHub issue.', '["github"]', '[]', 'external_verifiable', 'medium', 0, 1),
    ('github_pr', 'Create or update a GitHub pull request.', '["github"]', '[]', 'external_verifiable', 'medium', 0, 1),
    ('investigation', 'Run an LLM-driven investigation into a signal or question.', '[]', '[]', 'internal_idempotent', 'low', 0, 0),
    ('deep_investigation', 'Run a deeper, multi-step LLM investigation.', '[]', '[]', 'internal_idempotent', 'low', 0, 0),
    ('content_draft', 'Draft new content (blog post, page copy) for review.', '[]', '[]', 'internal_idempotent', 'low', 0, 1),
    ('meta_update', 'Update SEO metadata (title/description) on a page.', '[]', '[]', 'internal_idempotent', 'medium', 0, 1),
    ('shopify_product_create', 'Create a new Shopify product.', '["shopify"]', '["ecommerce"]', 'external_verifiable', 'medium', 0, 1),
    ('shopify_product_update', 'Update an existing Shopify product.', '["shopify"]', '["ecommerce"]', 'internal_idempotent', 'medium', 0, 1),
    ('shopify_description_update', 'Update a Shopify product description.', '["shopify"]', '["ecommerce"]', 'internal_idempotent', 'low', 0, 1),
    ('shopify_page_create', 'Create a new Shopify page.', '["shopify"]', '["ecommerce"]', 'external_verifiable', 'medium', 0, 1),
    ('shopify_page_update', 'Update an existing Shopify page.', '["shopify"]', '["ecommerce"]', 'internal_idempotent', 'low', 0, 1),
    ('shopify_blog_post_create', 'Create a new Shopify blog post.', '["shopify"]', '["ecommerce"]', 'external_verifiable', 'medium', 0, 1),
    ('shopify_meta_update', 'Update Shopify SEO metadata.', '["shopify"]', '["ecommerce"]', 'internal_idempotent', 'low', 0, 1),
    ('shopify_collection_update', 'Update a Shopify collection.', '["shopify"]', '["ecommerce"]', 'internal_idempotent', 'low', 0, 1),
    ('shopify_tag_update', 'Update Shopify product tags.', '["shopify"]', '["ecommerce"]', 'internal_idempotent', 'low', 0, 1),
    ('shopify_theme_edit', 'Edit Shopify theme files.', '["shopify"]', '["ecommerce"]', 'internal_idempotent', 'high', 0, 1),
    ('hire_agent', 'Hire (activate) a new agent for a business.', '[]', '[]', 'internal_idempotent', 'low', 0, 1),
    ('wix_seo_update', 'Update Wix page/blog-post SEO fields.', '["wix"]', '[]', 'internal_idempotent', 'low', 0, 1),
    ('server_file_write', 'Write a file on a connected server (backed up first).', '["server-access"]', '[]', 'internal_idempotent', 'high', 1, 1),
    ('server_file_rollback', 'Roll back a previous server_file_write.', '["server-access"]', '[]', 'internal_idempotent', 'medium', 0, 1),
    ('gbp_update', 'Update a Google Business Profile listing.', '["gbp"]', '[]', 'internal_idempotent', 'low', 0, 1),
    ('klaviyo_flow_update', 'Update a Klaviyo email flow.', '["klaviyo"]', '[]', 'internal_idempotent', 'low', 0, 1),
    ('meta_ads_update', 'Update a Meta Ads campaign.', '["meta-ads"]', '[]', 'internal_idempotent', 'medium', 0, 1),
    ('connect_connector', 'Prompt connecting a new connector.', '[]', '[]', 'internal_idempotent', 'low', 0, 1),
    ('research_connector', 'Research/evaluate a candidate connector.', '[]', '[]', 'internal_idempotent', 'low', 0, 0),
    ('notification', 'Send an informational notification â€” no external mutation.', '[]', '[]', 'internal_idempotent', 'low', 0, 0),
    ('strategic_review', 'Produce a strategic review/summary â€” no external mutation.', '[]', '[]', 'internal_idempotent', 'low', 0, 0),
    ('product_suggestion', 'Suggest a new product for an ecommerce catalog.', '[]', '["ecommerce"]', 'internal_idempotent', 'low', 0, 0),
    ('content_brief', 'Produce a content brief for later drafting.', '[]', '[]', 'internal_idempotent', 'low', 0, 0),
    ('page_optimisation', 'Recommend on-page optimisation changes.', '[]', '[]', 'internal_idempotent', 'low', 0, 1),
    ('gbp_post', 'Publish a Google Business Profile post.', '["gbp"]', '[]', 'internal_idempotent', 'low', 0, 1),
    ('meta-ads-change', 'Change a Meta Ads campaign (legacy alias â€” see server/brain/action-windows.ts).', '["meta-ads"]', '[]', 'internal_idempotent', 'medium', 0, 1)
  `,

  // â”€â”€â”€ Phase 2-INT.5 (cont.) Tie the registry to the existing per-action- â”€â”€
  // type measurement config in server/brain/action-windows.ts's
  // ACTION_WINDOWS (min/expected/max_days + metric_types) â€” a pre-existing
  // system this phase's research missed initially (it predates this phase
  // and already does exactly what the Outcome Learning Engine spec asks
  // for: "each action type should define a measurement window and success
  // metrics"). Rather than forking a second, competing set of numbers,
  // action_registry's fields are backfilled FROM action-windows.ts's data
  // here so the two agree; action-windows.ts itself remains the engine
  // restraint.ts/causal.ts/conductor actually read from â€” consolidating
  // them into one is a follow-up, not done in this phase (see PHASE2-INT.md).
  // Guarded on success_metrics = '[]' so an operator's own edit is never
  // silently overwritten by a later startup.
  `UPDATE action_registry SET measurement_window_days = '[7,21,42]', success_metrics = '["gsc.avg_ctr","gsc.total_clicks","ga4.sessions"]' WHERE action_type = 'meta_update' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[7,14,28]', success_metrics = '["shopify.conversion_rate","ga4.bounce_rate","ga4.sessions"]' WHERE action_type = 'shopify_description_update' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[21,56,112]', success_metrics = '["gsc.total_clicks","gsc.impressions","ga4.sessions"]' WHERE action_type = 'shopify_page_create' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[3,14]', success_metrics = '["pagespeed.mobile.performance_score","pagespeed.mobile.lcp_ms","ga4.bounce_rate","ga4.sessions"]' WHERE action_type = 'github_pr' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[28,56,120]', success_metrics = '["gsc.total_clicks","gsc.impressions","ga4.sessions"]' WHERE action_type = 'content_draft' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[3,7,21]', success_metrics = '["meta-ads.roas","meta-ads.ctr","meta-ads.cpm","meta-ads.cpc"]' WHERE action_type = 'meta-ads-change' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[7,21,42]', success_metrics = '["gsc.avg_ctr","gsc.total_clicks"]' WHERE action_type = 'shopify_meta_update' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[14,28,56]', success_metrics = '["gsc.total_clicks","shopify.revenue","shopify.conversion_rate"]' WHERE action_type = 'shopify_collection_update' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[1,7,28]', success_metrics = '["gbp.views_total","gbp.actions_website","gbp.actions_phone"]' WHERE action_type = 'gbp_post' AND success_metrics = '[]'`,
  `UPDATE action_registry SET measurement_window_days = '[7,21]', success_metrics = '["shopify.conversion_rate","ga4.bounce_rate","ga4.sessions","pagespeed.mobile.performance_score"]' WHERE action_type = 'shopify_theme_edit' AND success_metrics = '[]'`,

  // â”€â”€â”€ Full-enforcement follow-up: does a real executor.ts dispatch case â”€â”€
  // exist for this action_type? Static registry metadata instead of a
  // runtime cross-import of executor.ts (which would create a module
  // cycle: task-queue.ts â†’ action-registry.ts â†’ executor.ts â†’
  // task-queue.ts). Drives the "executor exists / is healthy" validation
  // check â€” an action_type with no real dispatch case is never blocked
  // for "unhealthy executor" (there's nothing to be unhealthy), but one
  // that IS dispatched and has recently failed repeatedly is.
  `ALTER TABLE action_registry ADD COLUMN dispatched_by_executor INTEGER NOT NULL DEFAULT 0`,
  `UPDATE action_registry SET dispatched_by_executor = 1 WHERE action_type IN (
    'github_issue', 'github_pr', 'investigation', 'deep_investigation', 'content_draft', 'meta_update',
    'shopify_product_create', 'shopify_product_update', 'shopify_description_update', 'shopify_page_create',
    'shopify_page_update', 'shopify_blog_post_create', 'shopify_meta_update', 'shopify_collection_update',
    'shopify_tag_update', 'shopify_theme_edit', 'hire_agent', 'wix_seo_update', 'server_file_write',
    'server_file_rollback', 'gbp_update', 'klaviyo_flow_update', 'meta_ads_update', 'connect_connector',
    'research_connector'
  )`,

  // â”€â”€â”€ Full-enforcement follow-up: consolidate action-windows.ts's â”€â”€â”€â”€â”€â”€â”€â”€
  // ACTION_WINDOWS into action_registry. These 3 columns are the only
  // fields action_windows carries that action_registry didn't already
  // have (min/expected/max_days already live in measurement_window_days,
  // metric_types already lives in success_metrics) â€” adding them makes
  // action_registry fully sufficient to seed+sync action_windows, so
  // seedActionWindows() (server/brain/action-windows.ts) now reads from
  // action_registry instead of its own hardcoded array, and
  // upsertActionRegistryEntry() (server/tasks/action-registry.ts)
  // writes through to action_windows on every edit â€” one edit surface,
  // two tables kept in agreement, instead of two independently-editable
  // copies of the same knowledge.
  `ALTER TABLE action_registry ADD COLUMN display_name TEXT`,
  `ALTER TABLE action_registry ADD COLUMN measurement_notes TEXT`,
  `ALTER TABLE action_registry ADD COLUMN volatility TEXT`,
  `UPDATE action_registry SET display_name = 'Meta title/description change', volatility = 'medium', measurement_notes = 'Google recrawls pages on its own schedule. CTR changes visible in GSC after recrawl and sufficient impression volume. Allow 3 weeks minimum, 6 weeks for low-traffic pages.' WHERE action_type = 'meta_update' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'Product description rewrite', volatility = 'high', measurement_notes = 'Conversion rate changes visible within 1-2 weeks with sufficient traffic. Requires minimum ~100 sessions to the page for statistical significance.' WHERE action_type = 'shopify_description_update' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'New landing page', volatility = 'low', measurement_notes = 'New pages take time to be discovered, crawled, indexed, and ranked. Expect 4-8 weeks before meaningful ranking signals, up to 16 weeks for competitive keywords.' WHERE action_type = 'shopify_page_create' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'Code change / deployment', volatility = 'low', measurement_notes = 'Code changes affect PageSpeed immediately. User behaviour metrics (bounce rate, sessions) need 1-2 weeks of data to show statistically significant change.' WHERE action_type = 'github_pr' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'New content / blog post', volatility = 'low', measurement_notes = 'Content SEO is slow. New posts typically take 3-6 months to reach peak rankings. Do not evaluate content performance before 4 weeks, and ideally measure at 3 months.' WHERE action_type = 'content_draft' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'Meta Ads campaign change', volatility = 'high', measurement_notes = 'Meta algorithm needs a learning period (typically 50 conversions or 7 days). Do not evaluate or change ads during the learning phase â€” it resets progress.' WHERE action_type = 'meta-ads-change' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'Shopify SEO title/description', volatility = 'medium', measurement_notes = 'Same as meta_update â€” depends on Googlebot recrawl schedule.' WHERE action_type = 'shopify_meta_update' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'Collection page update', volatility = 'medium', measurement_notes = 'Collection pages have SEO and UX components. SEO takes weeks, conversion rate impact visible sooner with sufficient traffic.' WHERE action_type = 'shopify_collection_update' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'Google Business Profile post', volatility = 'high', measurement_notes = 'GBP posts have immediate but short-lived visibility. Views peak in first week. Measure within 7-14 days.' WHERE action_type = 'gbp_post' AND display_name IS NULL`,
  `UPDATE action_registry SET display_name = 'Shopify theme file edit', volatility = 'medium', measurement_notes = 'Theme changes take effect immediately. Conversion and UX metric changes need 7-14 days of traffic for statistical significance.' WHERE action_type = 'shopify_theme_edit' AND display_name IS NULL`,

  // â”€â”€â”€ Issue #22 fix: register github_review_deploy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // executor.ts already implements this action type (draft-PR-or-review-issue
  // only, never a blind deploy â€” see executeGithubReviewDeploy) and
  // approval.ts/execution-safety.ts already classify it as dangerous/
  // external_verifiable. It was never added to action_registry's seed list,
  // so full-enforcement validateAction() (see the full-enforcement follow-up
  // above) blocked every such task at approval with 'unknown_action_type'
  // even though the executor could run it. This closes that gap.
  `INSERT OR IGNORE INTO action_registry (action_type, description, required_connector_types, supported_business_types, side_effect_classification, risk_level, supports_rollback, requires_approval) VALUES
    ('github_review_deploy', 'Review a code change and stage it for deployment â€” creates a draft PR or review issue only, never a blind merge/deploy.', '["github"]', '[]', 'external_verifiable', 'high', 0, 1)
  `,
  `UPDATE action_registry SET dispatched_by_executor = 1 WHERE action_type = 'github_review_deploy'`,

  // â”€â”€â”€ Issue #29 fix: research_connector requires action_payload.description â”€â”€
  // executor.ts's executeResearchConnector() already threw 'research_connector
  // requires action_payload.description' â€” but only at execution time, after
  // the task had already been approved and queued, turning an operator/agent
  // mistake into a dead-lettered execution job instead of a validation
  // rejection at approval. research_connector's payload_schema was seeded as
  // '{}' (matches-anything), so full-enforcement's payload-schema check (see
  // the full-enforcement follow-up above) never caught this. Guarded on the
  // schema still being the seed default so an operator's own edit is never
  // silently overwritten.
  `UPDATE action_registry SET payload_schema = '{"type":"object","required":["description"],"properties":{"description":{"type":"string","minLength":3}}}' WHERE action_type = 'research_connector' AND payload_schema = '{}'`,

  // ─── Issue #37 fix: register scheduled_workflow ─────────────────────────
  // External agents (e.g. Hermes) run recurring, non-destructive operational
  // automation — nightly jobs, cron-backed workflows, folder watchers,
  // monitoring, scheduled connector checks — on their own infrastructure and
  // propose a Blueprint task purely to record/track it. There was no
  // registered action_type for this, so every such proposal was rejected
  // with 'unknown_action_type', forcing agents to misuse unrelated action
  // types (e.g. content_draft) just to get the task recorded. This adds
  // 'scheduled_workflow': external_verifiable (the proposing system, not
  // Blueprint, performs and verifies the work — same category as
  // github_review_deploy/research_connector), requires_approval so a human
  // reviews the schedule/side-effects/constraints before it's trusted, and
  // deliberately NOT added to executor.ts's EXECUTABLE_ACTION_TYPES or given
  // dispatched_by_executor — Blueprint tracks/logs these, it never dispatches
  // or auto-executes them itself. payload_schema requires 'schedule' (a
  // cron-like string) and 'target_system' (who actually runs it); the rest
  // (cron_job_id, target_resource, side_effects, constraints, verification,
  // disable_path, publication) are optional structured detail matching the
  // issue's example payload.
  `INSERT OR IGNORE INTO action_registry (action_type, description, payload_schema, required_connector_types, supported_business_types, side_effect_classification, risk_level, supports_rollback, requires_approval) VALUES
    ('scheduled_workflow', 'Track a recurring, non-destructive operational automation (cron/scheduled job) that an external system owns and executes — nightly jobs, folder watchers, monitoring, scheduled connector checks.', '{"type":"object","required":["schedule","target_system"],"properties":{"schedule":{"type":"string","minLength":1},"cron_job_id":{"type":"string"},"target_system":{"type":"string","minLength":1},"target_resource":{"type":"string"},"side_effects":{"type":"array","items":{"type":"string"}},"publication":{"type":"string"},"verification":{"type":"array","items":{"type":"string"}},"constraints":{"type":"array","items":{"type":"string"}},"disable_path":{"type":"string"}}}', '[]', '[]', 'external_verifiable', 'low', 0, 1)
  `,
  // Social publishing tables (Issue #35)
  `CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    connector_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    target_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    caption TEXT NOT NULL,
    media_urls JSON NOT NULL DEFAULT '[]',
    media_alt_text TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    approval_mode TEXT NOT NULL DEFAULT 'requires_approval',
    approved_by TEXT,
    approved_at DATETIME,
    approved_caption TEXT,
    scheduled_at DATETIME,
    external_id TEXT,
    permalink TEXT,
    verified_at DATETIME,
    last_error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_business_status ON social_posts(business_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON social_posts(business_id, platform)`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_scheduled ON social_posts(status, scheduled_at)`,
  // OAuth nonces table for social connector state validation
  `CREATE TABLE IF NOT EXISTS oauth_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // Persistent staging metadata for restart-safe social media staging
  `CREATE TABLE IF NOT EXISTS social_media_staging (
    staging_token TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_social_media_staging_expires ON social_media_staging(expires_at)`,
  // #40 — quarantine flag for a bap_agents webhook that has failed
  // assertSafeWebhookUrl() (either at reconciliation or delivery time), so
  // the dispatcher can stop generating doomed deliveries for it without
  // touching the agent's `status` (see webhook-reconciliation.ts).
  `ALTER TABLE bap_agents ADD COLUMN webhook_disabled_at DATETIME`,
  `ALTER TABLE bap_agents ADD COLUMN webhook_disabled_reason TEXT`,

  // ─── Autonomous hiring engine (issues #44-#58) ──────────────────────────────
  // The `agents` table is an instance-wide roster keyed by template id — it has
  // no business dimension at all, which is exactly why conductor-hiring's
  // "already installed?" check leaked across businesses (#49). This table is
  // the authoritative per-business installation record: one row per
  // (business_id, agent_id) the business has actually hired.
  `CREATE TABLE IF NOT EXISTS agent_installations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'installed',
    installed_by TEXT NOT NULL DEFAULT 'human',
    lifecycle_state TEXT,
    installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    uninstalled_at DATETIME,
    metadata JSON DEFAULT '{}'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_installations_unique ON agent_installations(business_id, agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_installations_business ON agent_installations(business_id, status)`,

  // Durable negative-decision / suppression memory (#44, consumed by #50).
  // Written atomically with a hire_agent task rejection so a rejected role
  // stops being re-proposed on every subsequent analysis.
  `CREATE TABLE IF NOT EXISTS hiring_decisions (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'hard_suppression',
    actor TEXT NOT NULL,
    reason TEXT,
    task_id TEXT,
    analysis_id TEXT,
    evidence_fingerprint TEXT,
    reconsider_policy TEXT NOT NULL DEFAULT 'new_evidence',
    expires_at DATETIME,
    metadata JSON DEFAULT '{}',
    decided_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hiring_decisions_business_template ON hiring_decisions(business_id, template_id, decided_at)`,

  // Lifecycle / provenance / observability record for every hiring analysis
  // (#53 contract, #54 observability, #52 terminal failure state).
  `CREATE TABLE IF NOT EXISTS hiring_analysis_runs (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    contract_version TEXT NOT NULL DEFAULT 'hiring.analysis.v1',
    trigger_source TEXT NOT NULL,
    trigger_ref TEXT,
    trigger_reason TEXT,
    idempotency_key TEXT,
    mode TEXT NOT NULL DEFAULT 'live',
    status TEXT NOT NULL DEFAULT 'running',
    terminal_reason TEXT,
    degraded INTEGER NOT NULL DEFAULT 0,
    fallback_mode TEXT,
    provider TEXT,
    model TEXT,
    provider_status TEXT,
    provider_http_status INTEGER,
    provider_retryable INTEGER,
    provider_attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    input_snapshot JSON DEFAULT '{}',
    candidates_considered INTEGER NOT NULL DEFAULT 0,
    candidates_gated INTEGER NOT NULL DEFAULT 0,
    suppressed_count INTEGER NOT NULL DEFAULT 0,
    recommendations_count INTEGER NOT NULL DEFAULT 0,
    proposals_created INTEGER NOT NULL DEFAULT 0,
    proposal_ids JSON DEFAULT '[]',
    coalesced_into TEXT,
    coalesced_callers INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    diagnostics JSON DEFAULT '{}',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hiring_analysis_runs_business ON hiring_analysis_runs(business_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_hiring_analysis_runs_status ON hiring_analysis_runs(status, started_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_hiring_analysis_runs_idem ON hiring_analysis_runs(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,

  // Per-business coordination state: lease (mutual exclusion), debounce /
  // cooldown pacing, and material-change fingerprint (#45, #46).
  `CREATE TABLE IF NOT EXISTS hiring_coordination (
    business_id TEXT PRIMARY KEY,
    lease_holder TEXT,
    lease_expires_at DATETIME,
    last_analysis_id TEXT,
    last_analysis_at DATETIME,
    last_trigger_source TEXT,
    last_trigger_reason TEXT,
    last_input_fingerprint TEXT,
    next_eligible_at DATETIME,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    coalesced_count INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // Idempotency keys for proposal creation: DB-level uniqueness makes
  // "one proposal per (business, template, analysis window)" a constraint
  // rather than a race-prone read-then-write (#45).
  `CREATE TABLE IF NOT EXISTS hiring_proposal_keys (
    business_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    window_key TEXT NOT NULL,
    task_id TEXT,
    analysis_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (business_id, template_id, window_key)
  )`,

  // Bounded trial / activation plan attached to every hire proposal, plus the
  // measured outcome that feeds back into future decisions (#51, #56).
  `CREATE TABLE IF NOT EXISTS hiring_trials (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    task_id TEXT,
    analysis_id TEXT,
    goal_id TEXT,
    signal_id TEXT,
    target_metric TEXT,
    baseline_value REAL,
    target_value REAL,
    measurement_window_days INTEGER NOT NULL DEFAULT 14,
    evidence_deliverable TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    actual_value REAL,
    verdict TEXT,
    verdict_reason TEXT,
    confidence_at_hire REAL,
    calibration_error REAL,
    cost_usd REAL NOT NULL DEFAULT 0,
    effort_notes TEXT,
    started_at DATETIME,
    measure_after DATETIME,
    measured_at DATETIME,
    retired_at DATETIME,
    metadata JSON DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hiring_trials_business_template ON hiring_trials(business_id, template_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_hiring_trials_status ON hiring_trials(business_id, status)`,
];

for (const sql of STARTUP_MIGRATIONS) {
  try { db.exec(sql); }
  catch (err) {
    if (!/duplicate column|already exists/i.test((err as Error).message)) {
      console.warn('[db] startup migration warning:', (err as Error).message);
    }
  }
}

// Phase 4 trust/autonomy migrations.
const PHASE4_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS business_capabilities (id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), capability_key TEXT NOT NULL, display_name TEXT, status TEXT NOT NULL DEFAULT 'unknown', evidence_source TEXT, verified_at DATETIME, last_checked_at DATETIME, verification_method TEXT, connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL, limitations TEXT, allowed_actions JSON DEFAULT '[]', prohibited_actions JSON DEFAULT '[]', confidence REAL DEFAULT 0.5, corrected_by TEXT, correction_id TEXT, review_at DATETIME, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(business_id, capability_key))`,
  `CREATE INDEX IF NOT EXISTS idx_business_capabilities_business_status ON business_capabilities(business_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_business_capabilities_connector ON business_capabilities(connector_id)`,
  `CREATE TABLE IF NOT EXISTS applicability_suppressions (id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), source_type TEXT NOT NULL, source_id TEXT, candidate_type TEXT NOT NULL, candidate_key TEXT NOT NULL, capability_key TEXT, status TEXT NOT NULL DEFAULT 'active', reason TEXT NOT NULL, evidence_status TEXT NOT NULL DEFAULT 'observed', reconsider_after DATETIME, cleared_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_applicability_suppressions_business ON applicability_suppressions(business_id, status, candidate_type)`,
  `CREATE TABLE IF NOT EXISTS human_corrections (id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), correction_type TEXT NOT NULL, assertion_key TEXT NOT NULL, previous_value TEXT, corrected_value TEXT NOT NULL, explanation TEXT, evidence_source TEXT, corrected_by TEXT NOT NULL, effective_at DATETIME NOT NULL, confidence REAL DEFAULT 1.0, permanence TEXT NOT NULL DEFAULT 'review_required', review_at DATETIME, affected_capability_id TEXT, suppression_behavior TEXT DEFAULT 'suppress_until_changed', audit_ref TEXT, status TEXT NOT NULL DEFAULT 'confirmed', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_human_corrections_business ON human_corrections(business_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS correction_impacts (id TEXT PRIMARY KEY, correction_id TEXT NOT NULL REFERENCES human_corrections(id), business_id TEXT NOT NULL REFERENCES businesses(id), entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, previous_status TEXT, new_status TEXT NOT NULL, reason TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_correction_impacts_correction ON correction_impacts(correction_id)`,
  `CREATE TABLE IF NOT EXISTS revenue_paths (id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'secondary', business_model_type TEXT NOT NULL, sales_channel TEXT, target_customer TEXT, offer_category TEXT, acquisition_stage TEXT, conversion_mechanism TEXT, fulfilment_mechanism TEXT, retention_mechanism TEXT, primary_metric TEXT, leading_metrics JSON DEFAULT '[]', lagging_metrics JSON DEFAULT '[]', constraints TEXT, dependencies JSON DEFAULT '[]', verified_evidence TEXT, evidence_status TEXT NOT NULL DEFAULT 'unknown', active INTEGER DEFAULT 1, priority INTEGER DEFAULT 50, target_contribution REAL, time_horizon TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_revenue_paths_business ON revenue_paths(business_id, active, priority)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_paths_one_primary ON revenue_paths(business_id, role) WHERE role = 'primary' AND active = 1`,
  `ALTER TABLE tasks ADD COLUMN applicability_status TEXT DEFAULT 'unknown'`,
  `ALTER TABLE tasks ADD COLUMN applicability_reason TEXT`,
  `ALTER TABLE tasks ADD COLUMN approval_risk_evidence JSON`,
  `ALTER TABLE tasks ADD COLUMN external_baseline_snapshot JSON`,
  `ALTER TABLE tasks ADD COLUMN measurement_policy_id TEXT`,
  `ALTER TABLE tasks ADD COLUMN expected_outcome TEXT`,
  `ALTER TABLE signals ADD COLUMN lifecycle_status TEXT DEFAULT 'open'`,
  `ALTER TABLE signals ADD COLUMN lifecycle_reason TEXT`,
  `ALTER TABLE signals ADD COLUMN lifecycle_updated_at DATETIME`,
  `ALTER TABLE signals ADD COLUMN superseded_by_signal_id TEXT`,
  `ALTER TABLE signals ADD COLUMN invalidated_by_correction_id TEXT`,
  `CREATE TABLE IF NOT EXISTS signal_lifecycle_events (id TEXT PRIMARY KEY, signal_id TEXT NOT NULL REFERENCES signals(id), business_id TEXT NOT NULL REFERENCES businesses(id), from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL, evidence_status TEXT NOT NULL DEFAULT 'observed', related_signal_id TEXT, correction_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_signal_lifecycle_events_signal ON signal_lifecycle_events(signal_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS measurement_policies (id TEXT PRIMARY KEY, business_id TEXT REFERENCES businesses(id), action_type TEXT, goal_id TEXT, connector_type TEXT, metric_name TEXT, name TEXT NOT NULL, checkpoints_json JSON NOT NULL, final_day INTEGER, connector_freshness_hours INTEGER DEFAULT 24, minimum_data_volume INTEGER DEFAULT 1, minimum_meaningful_change REAL DEFAULT 0, confounding_policy TEXT DEFAULT 'mark_inconclusive', active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_measurement_policies_lookup ON measurement_policies(business_id, action_type, active)`,
  `CREATE TABLE IF NOT EXISTS outcome_measurement_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), business_id TEXT NOT NULL REFERENCES businesses(id), policy_id TEXT REFERENCES measurement_policies(id), checkpoint_at DATETIME NOT NULL, checkpoint_day INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending_measurement', baseline_value REAL, observed_value REAL, verdict TEXT, evidence_status TEXT DEFAULT 'unknown', diagnostic TEXT, job_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(task_id, checkpoint_day))`,
  `CREATE INDEX IF NOT EXISTS idx_outcome_measurement_due ON outcome_measurement_runs(state, checkpoint_at)`,
  `CREATE TABLE IF NOT EXISTS provider_preflight_cache (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, evidence JSON NOT NULL, checked_at DATETIME NOT NULL, expires_at DATETIME NOT NULL, UNIQUE(provider, model))`,
  `ALTER TABLE agent_runs ADD COLUMN queued_at DATETIME`,
  `ALTER TABLE agent_runs ADD COLUMN heartbeat_at DATETIME`,
  `ALTER TABLE agent_runs ADD COLUMN heartbeat_expires_at DATETIME`,
  `ALTER TABLE agent_runs ADD COLUMN timeout_at DATETIME`,
  `ALTER TABLE agent_runs ADD COLUMN cancellation_requested_at DATETIME`,
  `ALTER TABLE agent_runs ADD COLUMN cancellation_acknowledged_at DATETIME`,
  `ALTER TABLE agent_runs ADD COLUMN cancellation_completed_at DATETIME`,
  `ALTER TABLE agent_runs ADD COLUMN terminal_reason TEXT`,
  `ALTER TABLE agent_runs ADD COLUMN actual_provider TEXT`,
  `ALTER TABLE agent_runs ADD COLUMN actual_model TEXT`,
  `CREATE TABLE IF NOT EXISTS agent_run_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, business_id TEXT NOT NULL REFERENCES businesses(id), agent_id TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'observed', summary TEXT, request_id TEXT, correlation_id TEXT, related_resource_type TEXT, related_resource_id TEXT, duration_ms INTEGER, error_category TEXT, metadata JSON DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS agent_scorecard_snapshots (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, business_id TEXT, action_category TEXT NOT NULL DEFAULT 'all', period_start DATETIME NOT NULL, period_end DATETIME NOT NULL, metrics_json JSON NOT NULL, calibration_json JSON NOT NULL, uncertainty_json JSON NOT NULL, policy_effects_json JSON NOT NULL, calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(agent_id, business_id, action_category, period_start, period_end))`,
  `CREATE INDEX IF NOT EXISTS idx_agent_scorecards_lookup ON agent_scorecard_snapshots(agent_id, business_id, action_category, period_end)`,
  `INSERT OR IGNORE INTO measurement_policies (id, business_id, action_type, name, checkpoints_json, final_day, connector_freshness_hours, minimum_data_volume) VALUES ('policy_default_immediate_7_28_90', NULL, NULL, 'Default immediate, 7, 28 and 90 day checks', '[0,7,28,90]', 90, 24, 1)`
];
for (const sql of PHASE4_MIGRATIONS) {
  try { db.exec(sql); }
  catch (err) {
    if (!/duplicate column|already exists/i.test((err as Error).message)) {
      console.warn('[db] phase4 migration warning:', (err as Error).message);
    }
  }
}
try {
  const runEventFk = db.prepare("PRAGMA foreign_key_list('agent_run_events')").all() as Array<Record<string, unknown>>;
  const runFk = runEventFk.find((fk) => fk.table === 'agent_runs');
  if (runFk && runFk.on_delete !== 'CASCADE') {
    db.exec('ALTER TABLE agent_run_events RENAME TO agent_run_events_old');
    db.exec(`CREATE TABLE agent_run_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, business_id TEXT NOT NULL REFERENCES businesses(id), agent_id TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'observed', summary TEXT, request_id TEXT, correlation_id TEXT, related_resource_type TEXT, related_resource_id TEXT, duration_ms INTEGER, error_category TEXT, metadata JSON DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.exec(`INSERT INTO agent_run_events SELECT * FROM agent_run_events_old WHERE run_id IN (SELECT id FROM agent_runs)`);
    db.exec('DROP TABLE agent_run_events_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, created_at)');
  }
} catch (err) {
  console.warn('[db] agent_run_events FK migration warning:', (err as Error).message);
}
try {
  const capFk = db.prepare("PRAGMA foreign_key_list('business_capabilities')").all() as Array<Record<string, unknown>>;
  const connectorFk = capFk.find((fk) => fk.table === 'connectors');
  if (connectorFk && connectorFk.on_delete !== 'SET NULL') {
    db.exec('ALTER TABLE business_capabilities RENAME TO business_capabilities_old');
    db.exec(`CREATE TABLE business_capabilities (id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), capability_key TEXT NOT NULL, display_name TEXT, status TEXT NOT NULL DEFAULT 'unknown', evidence_source TEXT, verified_at DATETIME, last_checked_at DATETIME, verification_method TEXT, connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL, limitations TEXT, allowed_actions JSON DEFAULT '[]', prohibited_actions JSON DEFAULT '[]', confidence REAL DEFAULT 0.5, corrected_by TEXT, correction_id TEXT, review_at DATETIME, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(business_id, capability_key))`);
    db.exec(`INSERT INTO business_capabilities SELECT * FROM business_capabilities_old WHERE business_id IN (SELECT id FROM businesses) AND (connector_id IS NULL OR connector_id IN (SELECT id FROM connectors))`);
    db.exec('DROP TABLE business_capabilities_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_business_capabilities_business ON business_capabilities(business_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_business_capabilities_connector ON business_capabilities(connector_id)');
  }
} catch (err) {
  console.warn('[db] business_capabilities FK migration warning:', (err as Error).message);
}

// â”€â”€â”€ Verified action receipts (issue #70) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// One durable, versioned, human-readable receipt per approved task version
// â€” the record of what Blueprint was asked to do, who authorised it, what
// it actually executed, what the external system acknowledged, and what a
// later measurement verified. See server/tasks/action-receipts.ts.
//
// `correlation_key` is the SAME stable marker execution-safety.ts embeds
// in the external objects it creates (`blueprint:task=<id>:v<version>`),
// so Blueprint's receipt, its execution job (task_id + task_version) and
// the object in GitHub/Shopify all share one identity. The UNIQUE index on
// it is the "retries and duplicate deliveries never produce two
// conflicting receipts" guarantee at the DB level, not by convention: a
// retry of the same approved version can only ever update the one row.
const RECEIPT_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS action_receipts (
    id TEXT PRIMARY KEY,
    receipt_version INTEGER NOT NULL DEFAULT 1,
    business_id TEXT NOT NULL,
    -- ON DELETE CASCADE, following the agent_run_events precedent: a
    -- receipt describes one specific task and is meaningless without it,
    -- so it must never outlive its subject as a dangling record.
    -- Production never deletes tasks; this keeps fixtures/teardown honest.
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    task_version INTEGER NOT NULL DEFAULT 1,
    correlation_key TEXT NOT NULL,
    execution_job_id TEXT,
    action_type TEXT,
    title TEXT,
    state TEXT NOT NULL DEFAULT 'authorized',
    result_status TEXT NOT NULL DEFAULT 'pending',
    result_summary TEXT,
    result_detail JSON,
    requested_at DATETIME,
    requested_by TEXT,
    authorized_at DATETIME,
    authorized_by TEXT,
    execution_started_at DATETIME,
    executed_at DATETIME,
    externally_acknowledged_at DATETIME,
    verified_at DATETIME,
    rejected_at DATETIME,
    rejected_by TEXT,
    rejection_stage TEXT,
    rejection_reason TEXT,
    external_system TEXT,
    external_id TEXT,
    external_permalink TEXT,
    external_reference JSON,
    verification_evidence JSON,
    follow_up JSON,
    anomalies JSON,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    attempt_history JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_receipts_correlation ON action_receipts(correlation_key)`,
  `CREATE INDEX IF NOT EXISTS idx_action_receipts_business ON action_receipts(business_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_action_receipts_business_state ON action_receipts(business_id, state)`,
  `CREATE INDEX IF NOT EXISTS idx_action_receipts_task ON action_receipts(task_id, task_version)`,
];
for (const sql of RECEIPT_MIGRATIONS) {
  try { db.exec(sql); }
  catch (err) {
    if (!/duplicate column|already exists/i.test((err as Error).message)) {
      console.warn('[db] action receipt migration warning:', (err as Error).message);
    }
  }
}

// â”€â”€â”€ One-off data migration: agent lifecycle redesign â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Backfill structured lifecycle_state from legacy status (idempotent) â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ One-off data migration: strip legacy wildcard BAP grants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /register used to be open and granted whatever permissions/
// business_access a caller requested, including wildcards ('*:*',
// 'resource:*', business_access:['*']). The fix (bap/auth.ts,
// requireRegistrationAuth + filterGrantablePermissions/filterValidBusinessIds)
// only closes that door for *future* registrations â€” any bap_agents row
// created before the fix may still hold a wildcard grant from the old
// behaviour, and would otherwise keep working indefinitely. This strips
// wildcard entries (and only wildcard entries â€” concrete permissions like
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
        `These agents may now be under-permissioned for what they were actually doing â€” review them in ` +
        `Settings â†’ External Agents and re-grant specific (non-wildcard) permissions/business access as needed.`
      );
    }
  } catch (err) {
    console.warn('[db] BAP wildcard-grant migration skipped:', (err as Error).message);
  }
})();

// â”€â”€â”€ One-off data migration: backfill Business Profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Auto-populates a business_profiles row for every pre-existing business,
// inferring business_type from the legacy free-text `businesses.type`
// column via keyword matching and marking the field as inferred (not
// human-confirmed) â€” see server/business/business-profile.ts for the
// shared inference logic and the same auto-create path new businesses use.
(function backfillBusinessProfiles() {
  try {
    const businesses = db.prepare('SELECT id, name, type FROM businesses').all() as
      Array<{ id: string; name: string; type: string | null }>;
    if (businesses.length === 0) return;

    const existing = new Set(
      (db.prepare('SELECT business_id FROM business_profiles').all() as Array<{ business_id: string }>)
        .map((r) => r.business_id)
    );
    const missing = businesses.filter((b) => !existing.has(b.id));
    if (missing.length === 0) return;

    const inferType = (freeText: string | null): string => {
      const t = (freeText ?? '').toLowerCase();
      if (/shop|commerce|store|retail|apparel|merch/.test(t)) return 'ecommerce';
      if (/agency|marketing firm|consultanc/.test(t)) return 'agency';
      if (/saas|software|platform|app\b/.test(t)) return 'saas';
      if (/content|media|publish|blog/.test(t)) return 'content';
      if (!t) return 'other';
      return 'service';
    };

    const insert = db.prepare(`
      INSERT INTO business_profiles (
        id, business_id, business_type, primary_brand,
        products_services, supported_platforms, enabled_connector_types, disabled_connector_types,
        allowed_agent_types, allowed_action_types, strategic_goals, kpis, operating_constraints,
        approval_policy, automation_policy, risk_policy, deployment_policy, seo_policy,
        ecommerce_policy, lead_gen_policy, communication_preferences, inferred_fields,
        confirmed_by_human, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    for (const b of missing) {
      insert.run(
        generateId(), b.id, inferType(b.type), b.name,
        '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '{}',
        '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', JSON.stringify(['business_type']),
      );
    }
    console.log(`[db] Business Profile backfill: created ${missing.length} profile(s) with inferred business_type.`);
  } catch (err) {
    console.warn('[db] business profile backfill skipped:', (err as Error).message);
  }
})();

// ─── One-off data migration: backfill per-business agent installations ───────
// Issue #49/#55: hiring treated the instance-wide `agents` table as the
// installed-agent set, so an agent hired by business A was considered
// installed for every business. agent_installations is the new authoritative
// per-business record; the only historical evidence of *which* business hired
// an agent is the installer's audit_log row (entity_type='agent',
// action='install', business_id set), so seed from that. Where an agent row
// exists with no attributable install audit (pre-audit installs, seeded
// agents), the installation is attributed to every existing business —
// deliberately conservative: it can only suppress a duplicate re-hire
// proposal, never fabricate one.
(function backfillAgentInstallations() {
  try {
    const marker = db.prepare(
      "SELECT value FROM settings WHERE key = 'migration_agent_installations_v1'"
    ).get();
    if (marker) return;

    const insert = db.prepare(`
      INSERT INTO agent_installations (id, business_id, agent_id, status, installed_by, lifecycle_state, installed_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(business_id, agent_id) DO NOTHING
    `);

    const agentRows = db.prepare('SELECT id, status, lifecycle_state FROM agents').all() as
      Array<{ id: string; status: string | null; lifecycle_state: string | null }>;
    const agentById = new Map(agentRows.map((a) => [a.id, a]));

    const installAudits = db.prepare(`
      SELECT business_id, entity_id AS agent_id, actor, MIN(created_at) AS installed_at
        FROM audit_log
       WHERE entity_type = 'agent' AND action = 'install' AND business_id IS NOT NULL
       GROUP BY business_id, entity_id
    `).all() as Array<{ business_id: string; agent_id: string; actor: string | null; installed_at: string }>;

    const attributed = new Set<string>();
    let seeded = 0;
    for (const row of installAudits) {
      const agent = agentById.get(row.agent_id);
      if (!agent) continue;
      attributed.add(row.agent_id);
      insert.run(
        crypto.randomUUID(), row.business_id, row.agent_id,
        agent.status === 'retired' ? 'uninstalled' : 'installed',
        row.actor ?? 'unknown', agent.lifecycle_state ?? null, row.installed_at,
        JSON.stringify({ backfilled_from: 'audit_log' }),
      );
      seeded++;
    }

    const unattributed = agentRows.filter((a) => !attributed.has(a.id));
    if (unattributed.length > 0) {
      const businesses = db.prepare('SELECT id FROM businesses').all() as Array<{ id: string }>;
      for (const b of businesses) {
        for (const a of unattributed) {
          insert.run(
            crypto.randomUUID(), b.id, a.id,
            a.status === 'retired' ? 'uninstalled' : 'installed',
            'unknown', a.lifecycle_state ?? null, new Date().toISOString(),
            JSON.stringify({ backfilled_from: 'agents_table_no_audit' }),
          );
          seeded++;
        }
      }
    }

    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('migration_agent_installations_v1', ?, CURRENT_TIMESTAMP)`
    ).run(JSON.stringify({ ran_at: new Date().toISOString(), seeded }));
    if (seeded > 0) console.log(`[db] agent_installations backfill: seeded ${seeded} per-business installation record(s).`);
  } catch (err) {
    console.warn('[db] agent installation backfill skipped:', (err as Error).message);
  }
})();

// â”€â”€â”€ Exports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
