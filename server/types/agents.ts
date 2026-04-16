// ─── Agent system types ───────────────────────────────────────────────────────

import type { ActionType } from './action-payloads.js';
import type { SignalSeverity, TrustTier, Priority, KBFrontmatter } from './db.js';

// ── Profile (loaded from YAML via js-yaml) ────────────────────────────────────

export interface AgentProfile {
  id: string;
  name: string;
  type: string;
  description: string;
  version?: string;
  capabilities?: string[];
  signal_subscriptions?: string[];
  tools?: string[];
  polling_interval_minutes?: number;
  trust_tier?: TrustTier;
  max_tasks_per_run?: number;
  connectors_required?: string[];
  connectors_preferred?: string[];
  prompt_overrides?: Record<string, string>;
  memory_keys?: string[];
  [key: string]: unknown;
}

// ── Run output (parsed from LLM response JSON in agent-runner.js) ─────────────

export interface AgentRunOutput {
  reasoning?: string;
  tasks?: AgentProposedTask[];
  signals_detected?: AgentSignalDetected[];
  summary?: string;
  search_queries?: string[];
  data_gaps?: DataGap[];
  connector_wishlist?: string[];
  kb_entries?: KBEntryProposal[];
  agent_briefs?: AgentBrief[];
  signals_to_create?: SignalToCreate[];
  learnings?: string[];
}

export interface AgentProposedTask {
  title: string;
  description: string;
  action_type: ActionType;
  action_payload: Record<string, unknown>;
  priority: Priority;
  trust_tier: TrustTier;
  approval_mode?: 'auto' | 'requires_approval';
  rationale?: string;
  estimated_impact?: string;
  confidence?: number;
  signal_id?: string;
  mission_id?: string;
}

export interface AgentSignalDetected {
  signal_id?: string;
  rule_id?: string;
  type?: string;
  title: string;
  summary: string;
  severity: SignalSeverity;
  confidence?: number;
  data?: Record<string, unknown>;
}

export interface SignalToCreate {
  type: string;
  rule_id?: string;
  title: string;
  description?: string;
  severity: SignalSeverity;
  data: Record<string, unknown>;
  source_connector_id?: string;
  confidence?: number;
}

export interface DataGap {
  connector_type: string;
  reason: string;
  priority?: 'low' | 'medium' | 'high';
  impact?: string;
}

export interface KBEntryProposal {
  title: string;
  content: string;
  tags?: string[];
  frontmatter?: KBFrontmatter;
  path?: string;
}

export interface AgentBrief {
  agent_type: string;
  topic: string;
  context: string;
  priority?: 'low' | 'medium' | 'high';
  signal_ids?: string[];
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface AgentMemoryEntry {
  key: string;
  value: unknown;
  recorded_at: string;
  context?: string;
  expires_at?: string;
}

export interface AgentMemory {
  agent_id: string;
  business_id: string;
  entries: AgentMemoryEntry[];
  last_updated: string;
}

// ── Inbox ─────────────────────────────────────────────────────────────────────

export interface AgentInboxEntry {
  id: string;
  to_agent_id: string;
  from_agent_id?: string;
  from_agent_name?: string;
  subject: string;
  body: string;
  priority: 'low' | 'medium' | 'high';
  read: boolean;
  task_id?: string;
  signal_id?: string;
  created_at: string;
}

// ── Readiness & calibration ───────────────────────────────────────────────────

export interface AgentReadinessCheck {
  ready: boolean;
  reasons?: string[];
  missing_connectors?: string[];
  last_run?: string | null;
}

export interface AgentCalibrationOverride {
  confidence_offset: number;
  trust_tier_override?: TrustTier;
  notes?: string;
}

// ── Run record (what agent-runner persists after a run) ───────────────────────

export interface AgentRunRecord {
  agent_id: string;
  business_id: string;
  trigger: string;
  trigger_id?: string;
  output: AgentRunOutput;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  signals_detected: number;
  tasks_proposed: number;
  reasoning?: string;
  error?: string;
}

// ── Template ──────────────────────────────────────────────────────────────────

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  profile_template: Partial<AgentProfile>;
  tags?: string[];
  category?: string;
}
