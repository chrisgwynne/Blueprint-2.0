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

CREATE INDEX IF NOT EXISTS idx_bap_agents_prefix ON bap_agents(api_key_prefix, status);
CREATE INDEX IF NOT EXISTS idx_bap_audit_agent_created ON bap_audit(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bap_webhook_status ON bap_webhook_deliveries(delivery_status, next_retry);
