import { Database } from 'bun:sqlite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { mkdirSync, readFileSync } from 'fs';

// Resolve DB path relative to THIS FILE (server/db/db.js → ../../data/blueprint.db)
// so it is stable regardless of cwd. Never derive from process.cwd().
const __dbdir = dirname(fileURLToPath(import.meta.url));
const _defaultPath = resolve(__dbdir, '../../data/blueprint.db');

const DB_PATH = process.env.DATABASE_PATH
  ? resolve(process.env.DATABASE_PATH)
  : _defaultPath;

const _root = dirname(DB_PATH);

// Ensure data directory exists
try {
  mkdirSync(_root, { recursive: true });
} catch (_) {}

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// Auto-apply base schema on first boot (no separate db:init needed).
// Check for any core table; if missing, the db is fresh and needs schema.sql.
const needsSchema = !db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
).get();
if (needsSchema) {
  const schema = readFileSync(resolve(__dbdir, 'schema.sql'), 'utf8');
  db.exec(schema);
  console.log('[db] Fresh database — base schema applied automatically.');
}

// ─── Idempotent additive migrations (safe on every startup) ──────────────────
// Silently applies columns/tables added after initial schema.sql deployment.
const STARTUP_MIGRATIONS = [
  // Signal clustering (Feature 2)
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
  // Outcome attribution (Feature 4)
  `ALTER TABLE tasks ADD COLUMN target_metric TEXT`,
  `ALTER TABLE tasks ADD COLUMN target_metric_baseline REAL`,
  // Chat (Feature 3)
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
  // Workflows (Prompt 1)
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
  // Goals (Prompt 2)
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
  // Projects (Prompt 3)
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
  // Brain — temporal knowledge
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

  // Agent lifecycle — degraded-data flag for tasks proposed with stale or
  // missing preferred connector data. These are capped at confidence ≤ 0.3
  // and trust_tier='red' by agent-runner.js output validation.
  `ALTER TABLE tasks ADD COLUMN degraded_data INTEGER DEFAULT 0`,

  // KB pollution review — flag entries written before required connector
  // data was available, and track which agent wrote each entry so later
  // audits can trace speculation back to source.
  `ALTER TABLE kb_docs ADD COLUMN review_status TEXT DEFAULT 'ok'`,
  `ALTER TABLE kb_docs ADD COLUMN review_reason TEXT`,
  `ALTER TABLE kb_docs ADD COLUMN created_by TEXT`,

  // Server-access connector — every file write backs up the previous
  // version so Blueprint can roll back without needing server access.
  // server_file_cache stores content hashes so we can detect unexpected
  // external changes between syncs.
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

  // ─── Intelligence layer (9 features) ────────────────────────────────────
  // Feature 1 — Scenarios
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

  // Feature 2 — Conflicts
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

  // Feature 3 — Retrospectives
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

  // Feature 4 — Attribution on signals
  `ALTER TABLE signals ADD COLUMN attribution_analysis JSON`,
  `ALTER TABLE signals ADD COLUMN attribution_recommendation TEXT`,
  `ALTER TABLE signals ADD COLUMN attribution_primary_cause TEXT`,
  `ALTER TABLE signals ADD COLUMN attribution_primary_confidence REAL`,
  `ALTER TABLE signals ADD COLUMN do_not_act_until DATETIME`,

  // Feature 5 — Agent calibration
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

  // Feature 6 — Goal suggestions
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

  // Feature 8 — Constraint scheduling log
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

  // Feature 9 — Investigations
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

  // Investigation → action loop: link follow-on tasks to their parent investigation task
  `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)`,
  // Measurement window for follow-on tasks (days to check metric after execution)
  `ALTER TABLE tasks ADD COLUMN measurement_window_days INTEGER`,

  // Agent web search usage log (Brave Search / Tavily)
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

  // Connector wishlist / data gap requests from agents
  `ALTER TABLE tasks ADD COLUMN wishlist_connector_type TEXT`,

  // Blueprint system GitHub settings (separate from business GitHub connectors).
  // Owner/repo are hardcoded in code to chrisgwynne/Blueprint — only the token
  // and the enabled toggle are persisted here. Old owner/repo rows are left
  // in place for backwards compat but are no longer read.
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('blueprint_github_token',   '""',   CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('blueprint_github_enabled', 'true', CURRENT_TIMESTAMP)`,

  // ─── Self-heal log ───────────────────────────────────────────────────────
  // One row per unique error fingerprint. Counter increments on repeat
  // occurrences so we don't spam GitHub or notifications with duplicates.
  // See server/agents/self-healer.js for the fingerprinting rules.
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

  // ─── Intelligence mesh ───────────────────────────────────────────────────
  // Cross-component event log: every time one part of the system produces
  // output that another part consumes (KB → signal, signal → task, agent →
  // agent brief, chat → connector gap, etc.) a row is written here.
  // Powers the Timeline UI and lets Conductor see what's flowing.
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

  // Unified connector-gap tracker. KB analyser, signals, agents, chat, task
  // outcomes all call surfaceConnectorGap() when they notice a missing data
  // source. Dedup is enforced by the unique (business_id, connector_name)
  // index — repeat surfacings bump times_surfaced instead of spawning new
  // tasks. See server/lib/connector-gap-handler.js.
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

  // ─── Work-check columns on agent_runs ────────────────────────────────────
  // trigger_type: categorical bucket derived from the freeform `trigger`
  //   string — 'event' | 'poll' | 'schedule' | 'manual' | 'unknown'.
  //   Lets the UI show "X event-triggered, Y poll-triggered, Z skipped".
  // work_reasons: JSON array of strings from hasWorkToDo(). Populated on
  //   non-skipped runs to explain WHY the agent was allowed to spend tokens
  //   (populated on skipped runs too, as an empty array, for clarity).
  `ALTER TABLE agent_runs ADD COLUMN trigger_type TEXT`,
  `ALTER TABLE agent_runs ADD COLUMN work_reasons TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_trigger_type ON agent_runs(trigger_type, started_at DESC)`,

  // ─── ROI measurement system ──────────────────────────────────────────────
  //
  // Blueprint tracks its own value honestly — including the parts that
  // didn't work. Four tables support this:
  //
  //   baselines: immutable "before" snapshot. Populated on first connector
  //     sync per (business_id, metric_name). Ever-after comparisons happen
  //     against this value. If a baseline looks wrong, add a note — never
  //     overwrite the original.
  //
  //   roi_snapshots: a full ROI calculation captured weekly. Lets us show
  //     how Blueprint's estimated contribution has evolved over time and
  //     how our confidence in the estimate has grown.
  //
  //   counterfactual_estimates: at task proposal time, record the estimated
  //     cost of NOT doing the task. Later, compare to actual outcome —
  //     proof that the counterfactual model is (or isn't) calibrated.
  //
  //   attribution_records: links a measured task outcome to a share of the
  //     overall metric improvement. The core table behind "£X of this
  //     month's gain is attributable to Blueprint".

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
    business_id TEXT NOT NULL,
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

  // ─── Prompt-injection defence ────────────────────────────────────────────
  // Every outbound HTTP call from an agent-driven code path is logged here.
  // See server/lib/safe-fetch.js + server/lib/outbound-allowlist.js.
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

  // Enforcement toggle (default on). See server/lib/outbound-allowlist.js.
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_outbound_enforcement', 'true', CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_outbound_allowlist',   '[]',   CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_sanitisation_enabled', 'true', CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_kb_scan_enabled',      'true', CURRENT_TIMESTAMP)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('security_output_monitor_enabled', 'true', CURRENT_TIMESTAMP)`,
];
for (const sql of STARTUP_MIGRATIONS) {
  try { db.exec(sql); }
  catch (err) {
    if (!/duplicate column|already exists/i.test(err.message)) {
      console.warn('[db] startup migration warning:', err.message);
    }
  }
}

// ─── One-off data migration: agent lifecycle redesign ───────────────────────
// Marks non-conductor agents as 'pending' if their required connectors have
// never successfully synced, so they don't keep running against absent data
// and polluting the KB. Idempotent via a marker in settings.
(function applyAgentLifecycleMigration() {
  try {
    const marker = db.prepare(
      "SELECT value FROM settings WHERE key = 'migration_agent_lifecycle_v1'"
    ).get();
    if (marker) return;

    const nonConductor = db.prepare(
      "SELECT id FROM agents WHERE id != 'conductor' AND status = 'active'"
    ).all();

    let reset = 0;
    for (const row of nonConductor) {
      // Has this agent's agent_runs ever produced tasks or signals? If yes
      // we preserve 'active' — it has presumably been running productively.
      // If it has only produced zeros, reset to 'pending' so the new
      // readiness gate controls whether it runs.
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
    console.warn('[db] agent lifecycle migration skipped:', err.message);
  }
})();

export function generateId() {
  return crypto.randomUUID();
}

/**
 * Write an audit log entry.
 */
export function audit(
  businessId,
  entityType,
  entityId,
  action,
  actor,
  beforeState = null,
  afterState = null,
  metadata = null
) {
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
    metadata !== null ? JSON.stringify(metadata) : null
  );
}

export default db;
