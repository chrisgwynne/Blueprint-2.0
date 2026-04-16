// ─── Database row types ───────────────────────────────────────────────────────
// One interface per table in server/db/schema.sql (36 tables).
// JSON columns are typed as their parsed shapes; bun:sqlite returns them as strings
// at runtime — use parseJson<T>() from shared.ts at every read site.

import type { ActionType } from './action-payloads.js';

// ── Core entities ─────────────────────────────────────────────────────────────

export interface Business {
  id: string;
  name: string;
  slug: string;
  type: string | null;
  description: string | null;
  settings: Record<string, unknown>;         // JSON
  created_at: string;
  updated_at: string;
}

export interface Connector {
  id: string;
  business_id: string;
  type: string;
  name: string;
  credentials: Record<string, unknown>;     // JSON — encrypted service credentials
  status: 'disconnected' | 'connected' | 'error' | 'syncing' | string;
  last_sync: string | null;
  last_error: string | null;
  config: Record<string, unknown>;           // JSON — service-specific config
  created_at: string;
}

export type SignalSeverity = 'info' | 'warning' | 'critical';
export type SignalStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed' | 'snoozed';

export interface Signal {
  id: string;
  business_id: string;
  connector_id: string | null;
  rule_id: string;
  type: string;
  severity: SignalSeverity;
  title: string;
  description: string | null;
  data: Record<string, unknown>;             // JSON — connector-specific, varies by rule_id
  status: SignalStatus;
  snoozed_until: string | null;
  agent_id: string | null;
  confidence: number | null;
  created_at: string;
  resolved_at: string | null;
}

export interface Mission {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  goal: string | null;
  status: 'active' | 'completed' | 'paused' | 'cancelled' | string;
  owner: string | null;
  success_metrics: Array<{ metric: string; target: number; unit?: string }>;  // JSON
  deadline: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskStatus =
  | 'proposed'
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'rolled_back'
  | 'blocked';

export type TrustTier = 'green' | 'yellow' | 'red';
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

export interface Task {
  id: string;
  business_id: string;
  signal_id: string | null;
  mission_id: string | null;
  title: string;
  description: string | null;
  proposed_by: string;
  assigned_to: string | null;
  action_type: ActionType | string;
  action_payload: Record<string, unknown>;  // JSON — discriminated on action_type
  status: TaskStatus;
  trust_tier: TrustTier;
  priority: Priority;
  confidence: number | null;
  estimated_impact: string | null;
  rollback_data: Record<string, unknown> | null;  // JSON
  approval_mode: 'auto' | 'requires_approval' | string;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  outcome: string | null;
  outcome_data: Record<string, unknown> | null;   // JSON
  created_at: string;
  updated_at: string;
}

// ── Agents ────────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  profile_path: string;
  name: string;
  status: 'active' | 'paused' | 'retired' | string;
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  total_cost_usd: number;
  acceptance_rate: number | null;
  settings_override: Record<string, unknown>;     // JSON
  created_at: string;
}

export interface AgentRun {
  id: string;
  agent_id: string;
  business_id: string;
  trigger: string;
  trigger_id: string | null;
  status: 'running' | 'completed' | 'failed' | 'timeout' | string;
  reasoning: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  signals_detected: number;
  tasks_proposed: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface Metric {
  id: string;
  business_id: string;
  connector_id: string;
  metric_name: string;
  metric_value: number | null;
  metric_data: Record<string, unknown> | null;    // JSON — connector-specific
  period_start: string | null;
  period_end: string | null;
  recorded_at: string;
}

// ── Audit & events ────────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;
  business_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  before_state: Record<string, unknown> | null;   // JSON
  after_state: Record<string, unknown> | null;    // JSON
  metadata: Record<string, unknown> | null;       // JSON
  created_at: string;
}

export interface Notification {
  id: string;
  business_id: string | null;
  channel: string;
  severity: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  event_type: string;
  actor: string;
  content: string | null;
  metadata: Record<string, unknown>;              // JSON
  created_at: string;
}

// ── Knowledge base ────────────────────────────────────────────────────────────

export interface KBFrontmatter {
  title?: string;
  date?: string;
  author?: string;
  tags?: string[];
  status?: string;
  slug?: string;
  [key: string]: unknown;
}

export interface KBDoc {
  id: string;
  business_id: string | null;
  path: string;
  title: string | null;
  tags: string[];                               // JSON
  frontmatter: KBFrontmatter;                  // JSON
  word_count: number | null;
  last_git_commit: string | null;
  created_at: string;
  updated_at: string;
}

// ── Settings & sessions ───────────────────────────────────────────────────────

export interface Setting {
  key: string;
  value: unknown;                               // JSON — any scalar or object
  updated_at: string;
}

export interface Session {
  sid: string;
  sess: {                                       // JSON
    business_id?: string;
    userId?: string;
    [key: string]: unknown;
  };
  expired: string;
}

// ── Analysis ──────────────────────────────────────────────────────────────────

export interface AnalysisRun {
  id: string;
  business_id: string;
  status: 'running' | 'completed' | 'failed' | string;
  connectors_analysed: string[];                // JSON
  insights_count: number;
  tasks_created: number;
  health_score: number | null;
  summary: string | null;
  model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  started_at: string;
  completed_at: string | null;
}

export interface ConnectorSync {
  id: string;
  connector_id: string;
  status: 'running' | 'completed' | 'failed' | string;
  records_fetched: number;
  metrics_stored: number;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

// ── BAP (Blueprint Agent Protocol) ───────────────────────────────────────────

export interface BapAgent {
  id: string;
  name: string;
  description: string | null;
  owner: string | null;
  api_key_hash: string;
  api_key_prefix: string;
  status: 'active' | 'inactive' | string;
  permissions: string[];                        // JSON
  business_access: string[];                    // JSON — business IDs
  default_trust_tier: TrustTier;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_events: string[];                     // JSON
  last_seen: string | null;
  total_calls: number;
  created_at: string;
  updated_at: string;
}

export interface BapAudit {
  id: string;
  agent_id: string;
  method: string;
  endpoint: string;
  business_id: string | null;
  status_code: number | null;
  request_body: Record<string, unknown> | null; // JSON
  response_summary: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface BapWebhookDelivery {
  id: string;
  agent_id: string;
  event_type: string;
  payload: Record<string, unknown>;             // JSON
  delivery_status: 'pending' | 'delivered' | 'failed' | string;
  attempts: number;
  last_attempt: string | null;
  next_retry: string | null;
  response_code: number | null;
  response_body: string | null;
  created_at: string;
}

// ── API keys ──────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string[];                             // JSON
  rate_limit: number;
  last_used: string | null;
  expires_at: string | null;
  total_calls: number;
  created_at: string;
}

// ── Cost tracking ─────────────────────────────────────────────────────────────

export interface CostDaily {
  id: string;
  date: string;
  agent_id: string | null;
  business_id: string | null;
  provider: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  run_count: number;
}

// ── Signal clusters ───────────────────────────────────────────────────────────

export interface SignalCluster {
  id: string;
  business_id: string;
  title: string;
  summary: string;
  likely_cause: string | null;
  recommendation: string | null;
  severity: SignalSeverity;
  confidence: number;
  status: 'open' | 'resolved' | string;
  signal_ids: string[];                         // JSON
  created_by: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export interface ChatConversation {
  id: string;
  business_id: string;
  title: string | null;
  type: 'human' | 'agent' | 'system' | string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  business_id: string;
  sender_type: 'user' | 'agent' | 'system' | string;
  sender_id: string;
  sender_name: string;
  content: string;
  mentions: string[];                           // JSON — entity IDs
  attachments: Array<{ type: string; url?: string; data?: unknown }>; // JSON
  metadata: Record<string, unknown>;            // JSON
  created_at: string;
}

export interface ChatReaction {
  id: string;
  message_id: string;
  reactor_id: string;
  reaction: string;
  created_at: string;
}

// ── Outcome attribution ───────────────────────────────────────────────────────

export interface TaskOutcome {
  id: string;
  task_id: string;
  check_date: string;
  weeks_after: number;
  metric_value: number | null;
  baseline_value: number | null;
  change_pct: number | null;
  verdict: string | null;
  verdict_detail: string | null;
  created_at: string;
}

// ── Job queue ─────────────────────────────────────────────────────────────────

export interface JobQueue {
  id: string;
  type: string;
  payload: Record<string, unknown>;             // JSON — job-specific
  priority: number;
  business_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | string;
  run_after: string;
  started_at: string | null;
  completed_at: string | null;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
}

// ── Intelligence layer ────────────────────────────────────────────────────────

export interface Scenario {
  id: string;
  business_id: string;
  question: string;
  context: string | null;
  scenarios_json: Array<{                       // JSON
    id?: string;
    title: string;
    description: string;
    probability?: number;
    impact?: string;
    pros?: string[];
    cons?: string[];
    actions?: string[];
  }>;
  recommended: string | null;
  recommendation_reasoning: string | null;
  decision_criteria: Record<string, unknown> | null; // JSON
  next_step: string | null;
  created_by: string;
  kb_path: string | null;
  created_at: string;
}

export interface Conflict {
  id: string;
  business_id: string;
  conflict_type: string;
  severity: 'warning' | 'critical' | string;
  entity_a_type: string;
  entity_a_id: string;
  entity_a_title: string | null;
  entity_b_type: string;
  entity_b_id: string;
  entity_b_title: string | null;
  description: string;
  recommendation: string | null;
  resolution_kind: string | null;
  status: 'open' | 'resolved' | 'escalated' | string;
  resolution_note: string | null;
  detected_at: string;
  resolved_at: string | null;
}

export interface Retrospective {
  id: string;
  business_id: string;
  period_start: string;
  period_end: string;
  executive_summary: string | null;
  what_worked: string[];                        // JSON
  what_didnt: string[];                         // JSON
  learnings: string[];                          // JSON
  agent_assessments: Array<{ agent_id: string; score?: number; notes?: string }>; // JSON
  open_windows: string[];                       // JSON
  recommendations: string[];                    // JSON
  operating_changes: string[];                  // JSON
  calibration_notes: string[];                  // JSON
  full_report_json: Record<string, unknown> | null; // JSON
  kb_path: string | null;
  triggered_by: string;
  created_at: string;
}

export interface AgentCalibration {
  id: string;
  agent_id: string;
  business_id: string | null;
  period_start: string;
  period_end: string;
  tasks_with_outcomes: number;
  avg_stated_confidence: number | null;
  avg_actual_outcome_rate: number | null;
  calibration_error: number | null;
  calibration_score: number | null;
  calibration_offset: number;
  trend: string | null;
  notes: string | null;
  calculated_at: string;
}

export interface GoalSuggestion {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  opportunity_value: number | null;
  opportunity_unit: string;
  metric_name: string | null;
  current_value: number | null;
  target_value: number | null;
  barrier: string | null;
  suggested_deadline: string | null;
  suggested_agents: string[];                   // JSON
  suggested_workflow_id: string | null;
  confidence: number | null;
  connector_source: string | null;
  evidence: Record<string, unknown> | null;    // JSON
  status: 'pending' | 'accepted' | 'dismissed' | 'snoozed' | string;
  snoozed_until: string | null;
  dismissed_reason: string | null;
  accepted_goal_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SchedulerLog {
  id: string;
  job_name: string;
  business_id: string | null;
  decision: string;
  was_scheduled_for: string | null;
  delayed_to: string | null;
  reason: string | null;
  constraints_json: Record<string, unknown> | null; // JSON
  created_at: string;
}

export interface Investigation {
  id: string;
  business_id: string;
  metric_name: string | null;
  signal_id: string | null;
  question: string | null;
  triggered_by: string;
  report_json: Record<string, unknown>;         // JSON — InvestigationReport shape
  plain_english: string | null;
  primary_cause: string | null;
  primary_confidence: number | null;
  recommendation: string | null;
  recommended_action: string | null;
  kb_path: string | null;
  cache_until: string | null;
  created_at: string;
}

export interface SearchLog {
  id: string;
  business_id: string;
  connector_id: string;
  query: string;
  results_count: number;
  search_depth: string;
  agent_id: string | null;
  run_id: string | null;
  created_at: string;
}
