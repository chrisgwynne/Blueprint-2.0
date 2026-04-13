import { Database } from 'bun:sqlite';
import { resolve, dirname } from 'path';
import crypto from 'crypto';
import { mkdirSync } from 'fs';

// Resolve relative to cwd (project root when run via `bun server/...` or from server/)
const _root = process.env.DATABASE_PATH
  ? dirname(resolve(process.env.DATABASE_PATH))
  : resolve(process.cwd(), '../data');

const DB_PATH = process.env.DATABASE_PATH || resolve(process.cwd(), '../data/blueprint.db');

// Ensure data directory exists
try {
  mkdirSync(_root, { recursive: true });
} catch (_) {}

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

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
