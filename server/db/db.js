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
];
for (const sql of STARTUP_MIGRATIONS) {
  try { db.exec(sql); }
  catch (err) {
    if (!/duplicate column|already exists/i.test(err.message)) {
      console.warn('[db] startup migration warning:', err.message);
    }
  }
}

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
