// ─── Blueprint client types ───────────────────────────────────────────────────
// Mirror of key server types for use in React components.
// Keep in sync with server/types/ — do not diverge field names.

// ── Core entities (mirrors server/types/db.ts) ────────────────────────────────

export type SignalSeverity = 'info' | 'warning' | 'critical';
export type SignalStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed' | 'snoozed';
export type TrustTier = 'green' | 'yellow' | 'red';
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';
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

export interface Business {
  id: string;
  name: string;
  slug: string;
  type: string | null;
  description: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Connector {
  id: string;
  business_id: string;
  type: string;
  name: string;
  status: string;
  last_sync: string | null;
  last_error: string | null;
  config: Record<string, unknown>;
  created_at: string;
}

export interface Signal {
  id: string;
  business_id: string;
  connector_id: string | null;
  rule_id: string;
  type: string;
  severity: SignalSeverity;
  title: string;
  description: string | null;
  data: Record<string, unknown>;
  status: SignalStatus;
  snoozed_until: string | null;
  agent_id: string | null;
  confidence: number | null;
  created_at: string;
  resolved_at: string | null;
}

export interface Task {
  id: string;
  business_id: string;
  signal_id: string | null;
  mission_id: string | null;
  title: string;
  description: string | null;
  proposed_by: string;
  assigned_to: string | null;
  action_type: string;
  action_payload: Record<string, unknown>;
  status: TaskStatus;
  trust_tier: TrustTier;
  priority: Priority;
  confidence: number | null;
  estimated_impact: string | null;
  rollback_data: Record<string, unknown> | null;
  approval_mode: string;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  outcome: string | null;
  outcome_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  profile_path: string;
  name: string;
  status: string;
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  total_cost_usd: number;
  acceptance_rate: number | null;
  settings_override: Record<string, unknown>;
  created_at: string;
}

export interface AgentRun {
  id: string;
  agent_id: string;
  business_id: string;
  trigger: string;
  trigger_id: string | null;
  status: string;
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

export interface Metric {
  id: string;
  business_id: string;
  connector_id: string;
  metric_name: string;
  metric_value: number | null;
  metric_data: Record<string, unknown> | null;
  period_start: string | null;
  period_end: string | null;
  recorded_at: string;
}

export interface KBDoc {
  id: string;
  business_id: string | null;
  path: string;
  title: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  word_count: number | null;
  last_git_commit: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignalCluster {
  id: string;
  business_id: string;
  title: string;
  summary: string;
  likely_cause: string | null;
  recommendation: string | null;
  severity: SignalSeverity;
  confidence: number;
  status: string;
  signal_ids: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ChatConversation {
  id: string;
  business_id: string;
  title: string | null;
  type: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  business_id: string;
  sender_type: string;
  sender_id: string;
  sender_name: string;
  content: string;
  mentions: string[];
  attachments: Array<{ type: string; url?: string; data?: unknown }>;
  metadata: Record<string, unknown>;
  created_at: string;
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
  suggested_agents: string[];
  confidence: number | null;
  status: string;
  required_effort?: string | null;
  related_goal_ids?: string[];
  related_risks?: string[];
  why_it_matters?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conflict {
  id: string;
  business_id: string;
  conflict_type: string;
  category?: string;
  severity: string;
  entity_a_type: string;
  entity_a_id: string;
  entity_a_title: string | null;
  entity_b_type: string;
  entity_b_id: string;
  entity_b_title: string | null;
  description: string;
  recommendation: string | null;
  status: string;
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
  what_worked: string[];
  what_didnt: string[];
  learnings: string[];
  agent_assessments: Array<{ agent_id: string; score?: number; notes?: string }>;
  open_windows: string[];
  recommendations: string[];
  operating_changes: string[];
  calibration_notes: string[];
  full_report_json: Record<string, unknown> | null;
  created_at: string;
}

export interface Scenario {
  id: string;
  business_id: string;
  question: string;
  context: string | null;
  scenarios_json: Array<{
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
  decision_criteria: Record<string, unknown> | null;
  next_step: string | null;
  created_by: string;
  created_at: string;
}

export interface Investigation {
  id: string;
  business_id: string;
  metric_name: string | null;
  signal_id: string | null;
  question: string | null;
  triggered_by: string;
  report_json: Record<string, unknown>;
  plain_english: string | null;
  primary_cause: string | null;
  primary_confidence: number | null;
  recommendation: string | null;
  recommended_action: string | null;
  created_at: string;
}

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

// ── API response wrappers ─────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

// ── ROI types ─────────────────────────────────────────────────────────────────

export interface ROIMetric {
  task_id: string;
  task_title: string;
  action_type: string;
  estimated_value: number;
  confidence: number;
  attribution_type: string;
  period: string;
}

// ── Connector data display types ──────────────────────────────────────────────

export interface ConnectorDataPoint {
  label: string;
  value: number | string | null;
  unit?: string;
  change?: number;
  change_pct?: number;
  period?: string;
}

// ── Agent lifecycle + sidebar types (mirror server/agents/agentLifecycle.ts) ──

export type AgentLifecycleState =
  | 'candidate'
  | 'proposed'
  | 'approved'
  | 'hired'
  | 'standby'
  | 'triggered'
  | 'assigned'
  | 'working'
  | 'blocked'
  | 'awaiting_approval'
  | 'completed'
  | 'verified'
  | 'archived';

export type ActivationChannel = 'signal' | 'schedule' | 'manual' | 'workflow' | 'escalation';

export type AgentRiskLevel = 'low' | 'medium' | 'high';

/** A single agent as returned by GET /api/agents-status/roster. */
export interface AgentRosterEntry {
  id: string;
  name: string;
  avatar: string;
  lifecycle_state: AgentLifecycleState;
  role: string | null;
  purpose: string | null;
  current_task: { id: string; title: string; status: string } | null;
  trigger_reason: string | null;
  trigger_source: ActivationChannel | string | null;
  matched_areas: string[];
  confidence: number | null;
  requires_approval: boolean;
  kb_scope: string[];
  tools_allowed: string[];
  data_sources_allowed: string[];
  task_types_allowed: string[];
  evidence_count: number;
  last_run_at: string | null;
  last_run_status: string | null;
  last_action: string | null;
  last_error: string | null;
  cooldown_until: string | null;
  next_check_minutes: number;
  success_count: number;
  failure_count: number;
  success_rate: number | null;
  busy: boolean;
}

export interface AgentRosterResponse {
  business_id: string | null;
  agents: AgentRosterEntry[];
}

/** One row of an agent's activity timeline (GET /agents-status/:id/timeline). */
export interface AgentActivationRecord {
  id: string;
  trigger_source: string;
  selection_reason: string | null;
  matched_areas: string;
  confidence: number | null;
  task_id: string | null;
  evidence: string;
  run_id: string | null;
  created_at: string;
}

export interface AgentLifecycleEventRecord {
  id: string;
  from_state: string | null;
  to_state: string;
  actor: string;
  reason: string | null;
  created_at: string;
}

export interface AgentRunRecord {
  id: string;
  trigger: string | null;
  trigger_type: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  tasks_proposed: number | null;
  signals_detected: number | null;
  cost_usd: number | null;
  error: string | null;
}

export interface AgentTimelineResponse {
  agent_id: string;
  activations: AgentActivationRecord[];
  lifecycle_events: AgentLifecycleEventRecord[];
  runs: AgentRunRecord[];
}

/** A suggested (not-yet-hired) agent — GET /api/agents/proposals. */
export interface ProposedAgent {
  task_id: string;
  template_id: string | null;
  title: string;
  why_needed: string | null;
  gap_filled: string | null;
  role: string | null;
  can_access: string[];
  can_do: string[];
  kb_scope: string[];
  risk_level: AgentRiskLevel;
  confidence: number | null;
  priority: string | null;
  estimated_impact: string | null;
  requires_approval: boolean;
  created_at: string;
}

export interface ProposedAgentsResponse {
  business_id: string;
  proposals: ProposedAgent[];
}

/**
 * UI grouping for the sidebar roster. Drives the section headers
 * (Working / Standby / Triggered / Blocked / Awaiting approval / Recently completed).
 */
export type AgentSidebarGroup =
  | 'working'
  | 'awaiting_approval'
  | 'triggered'
  | 'blocked'
  | 'standby'
  | 'completed';
