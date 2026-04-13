-- Blueprint Database Schema

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  type TEXT,
  description TEXT,
  settings JSON DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  credentials JSON DEFAULT '{}',
  status TEXT DEFAULT 'disconnected',
  last_sync DATETIME,
  last_error TEXT,
  config JSON DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  connector_id TEXT REFERENCES connectors(id),
  rule_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  data JSON DEFAULT '{}',
  status TEXT DEFAULT 'open',
  snoozed_until DATETIME,
  agent_id TEXT,
  confidence REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  title TEXT NOT NULL,
  description TEXT,
  goal TEXT,
  status TEXT DEFAULT 'active',
  owner TEXT,
  success_metrics JSON DEFAULT '[]',
  deadline DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  signal_id TEXT REFERENCES signals(id),
  mission_id TEXT REFERENCES missions(id),
  title TEXT NOT NULL,
  description TEXT,
  proposed_by TEXT NOT NULL,
  assigned_to TEXT,
  action_type TEXT,
  action_payload JSON DEFAULT '{}',
  status TEXT DEFAULT 'proposed',
  trust_tier TEXT DEFAULT 'yellow',
  priority TEXT DEFAULT 'p2',
  confidence REAL,
  estimated_impact TEXT,
  rollback_data JSON,
  approval_mode TEXT DEFAULT 'requires_approval',
  approved_by TEXT,
  approved_at DATETIME,
  rejection_reason TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  outcome TEXT,
  outcome_data JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  profile_path TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  last_run DATETIME,
  next_run DATETIME,
  run_count INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  acceptance_rate REAL,
  settings_override JSON DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  trigger TEXT NOT NULL,
  trigger_id TEXT,
  status TEXT DEFAULT 'running',
  reasoning TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  signals_detected INTEGER DEFAULT 0,
  tasks_proposed INTEGER DEFAULT 0,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  error TEXT
);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  metric_name TEXT NOT NULL,
  metric_value REAL,
  metric_data JSON,
  period_start DATETIME,
  period_end DATETIME,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  business_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  before_state JSON,
  after_state JSON,
  metadata JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id),
  channel TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT,
  entity_id TEXT,
  sent_at DATETIME,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kb_docs (
  id TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id),
  path TEXT NOT NULL UNIQUE,
  title TEXT,
  tags JSON DEFAULT '[]',
  frontmatter JSON DEFAULT '{}',
  word_count INTEGER,
  last_git_commit TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSON NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess JSON NOT NULL,
  expired DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  content TEXT,
  metadata JSON DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  status TEXT DEFAULT 'running',
  connectors_analysed JSON DEFAULT '[]',
  insights_count INTEGER DEFAULT 0,
  tasks_created INTEGER DEFAULT 0,
  health_score INTEGER,
  summary TEXT,
  model_used TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS connector_syncs (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  status TEXT DEFAULT 'running',
  records_fetched INTEGER DEFAULT 0,
  metrics_stored INTEGER DEFAULT 0,
  error TEXT,
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_signals_business_status ON signals(business_id, status);
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_business_status ON tasks(business_id, status);
CREATE INDEX IF NOT EXISTS idx_metrics_business_name_recorded ON metrics(business_id, metric_name, recorded_at);
CREATE INDEX IF NOT EXISTS idx_audit_business_entity_created ON audit_log(business_id, entity_type, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_business ON analysis_runs(business_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_business_id ON agent_runs(business_id);
-- idx_cost_daily_date moved below cost_daily CREATE TABLE definition

-- ─── Blueprint Agent Protocol (BAP) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bap_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner TEXT,
  api_key_hash TEXT NOT NULL,
  api_key_prefix TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  permissions JSON DEFAULT '[]',
  business_access JSON DEFAULT '[]',
  default_trust_tier TEXT DEFAULT 'yellow',
  webhook_url TEXT,
  webhook_secret TEXT,
  webhook_events JSON DEFAULT '[]',
  last_seen DATETIME,
  total_calls INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bap_audit (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES bap_agents(id),
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  business_id TEXT,
  status_code INTEGER,
  request_body JSON,
  response_summary TEXT,
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bap_webhook_deliveries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES bap_agents(id),
  event_type TEXT NOT NULL,
  payload JSON NOT NULL,
  delivery_status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_attempt DATETIME,
  next_retry DATETIME,
  response_code INTEGER,
  response_body TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─── Public API Keys ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  scopes JSON DEFAULT '["read"]',
  rate_limit INTEGER DEFAULT 1000,
  last_used DATETIME,
  expires_at DATETIME,
  total_calls INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

-- ─── Cost tracking ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cost_daily (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  agent_id TEXT,
  business_id TEXT,
  provider TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  run_count INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_daily_unique
  ON cost_daily(date, agent_id, business_id, provider);
CREATE INDEX IF NOT EXISTS idx_cost_daily_date ON cost_daily(date);

-- ─── Signal clusters (Feature 2) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_clusters (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
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
);
CREATE INDEX IF NOT EXISTS idx_signal_clusters_business_status ON signal_clusters(business_id, status);

-- ─── Chat (Feature 3) ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  title TEXT,
  type TEXT DEFAULT 'human',
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  archived_at DATETIME
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  business_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  mentions JSON DEFAULT '[]',
  attachments JSON DEFAULT '[]',
  metadata JSON DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS chat_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  reactor_id TEXT NOT NULL,
  reaction TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─── Outcome attribution ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_outcomes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  check_date DATETIME NOT NULL,
  weeks_after INTEGER NOT NULL,
  metric_value REAL,
  baseline_value REAL,
  change_pct REAL,
  verdict TEXT,
  verdict_detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_outcomes_task ON task_outcomes(task_id);

-- ─── Job queue ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_queue (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSON NOT NULL,
  priority INTEGER DEFAULT 5,
  business_id TEXT,
  status TEXT DEFAULT 'pending',
  run_after DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status, type, run_after);

CREATE INDEX IF NOT EXISTS idx_bap_agents_prefix ON bap_agents(api_key_prefix, status);
CREATE INDEX IF NOT EXISTS idx_bap_audit_agent_created ON bap_audit(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bap_webhook_status ON bap_webhook_deliveries(delivery_status, next_retry);

-- ─── Intelligence Layer (9 features) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
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
);
CREATE INDEX IF NOT EXISTS idx_scenarios_business_created ON scenarios(business_id, created_at);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
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
);
CREATE INDEX IF NOT EXISTS idx_conflicts_business_status ON conflicts(business_id, status);

CREATE TABLE IF NOT EXISTS retrospectives (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
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
);
CREATE INDEX IF NOT EXISTS idx_retrospectives_business ON retrospectives(business_id, created_at);

CREATE TABLE IF NOT EXISTS agent_calibration (
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
);
CREATE INDEX IF NOT EXISTS idx_agent_calibration_agent ON agent_calibration(agent_id, period_end);

CREATE TABLE IF NOT EXISTS goal_suggestions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
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
);
CREATE INDEX IF NOT EXISTS idx_goal_suggestions_business_status ON goal_suggestions(business_id, status);

CREATE TABLE IF NOT EXISTS scheduler_log (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  business_id TEXT,
  decision TEXT NOT NULL,
  was_scheduled_for DATETIME,
  delayed_to DATETIME,
  reason TEXT,
  constraints_json JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scheduler_log_job ON scheduler_log(job_name, created_at);

CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
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
);
CREATE INDEX IF NOT EXISTS idx_investigations_biz_metric ON investigations(business_id, metric_name, created_at);
