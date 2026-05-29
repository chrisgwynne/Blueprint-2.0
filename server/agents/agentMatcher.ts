/**
 * Task / signal → agent matcher (section 3) + activation guardrails (section 4).
 *
 * Given a task or signal, this derives the required capability, tools, risk
 * level, business area, data source, urgency and approval requirement, then
 * deterministically selects a best-match agent + backup, and decides whether
 * the work should be handled manually instead. Every assignment carries a
 * human-readable reason string.
 *
 * Guardrails enforced here:
 *   - exactly one active owner per task (claimTaskOwnership uses a guarded UPDATE)
 *   - no duplicate agent for the same in-flight scope (isScopeInFlight)
 *   - cooldown after failed execution (delegated to agentLifecycle.isInCooldown)
 *   - max-active-agents cap (countBusyAgents / MAX_ACTIVE_AGENTS)
 *   - escalation path when blocked
 *
 * The selection logic (scoreAgentForAreas, buildAssignmentReason) is pure so it
 * is unit-testable without the DB.
 */

import db, { generateId } from '../db/db.js';
import {
  ROLE_SPECS,
  deriveSignalKnowledgeAreas,
  intersectAreas,
  type KnowledgeArea,
} from './agentActivationRules.js';
import { DANGEROUS_ACTION_TYPES } from '../tasks/approval.js';
import {
  BUSY_STATES,
  LIVE_STATES,
  getLifecycleState,
  isInCooldown,
  type AgentLifecycleState,
} from './agentLifecycle.js';

export const MAX_ACTIVE_AGENTS = 4;

export type RiskLevel = 'low' | 'medium' | 'high';
export type Urgency = 'low' | 'normal' | 'high' | 'critical';

export interface MatchInput {
  /** action_type of the task, if matching a task. */
  action_type?: string | null;
  /** rule_id of the signal, if matching a signal. */
  rule_id?: string | null;
  /** connector type behind the trigger. */
  connector_type?: string | null;
  /** signal/task type label. */
  type?: string | null;
  severity?: string | null;
  priority?: string | null;
  title?: string | null;
}

export interface MatchRequirements {
  areas: KnowledgeArea[];
  required_task_type: string | null;
  data_source: string | null;
  risk: RiskLevel;
  urgency: Urgency;
  requires_approval: boolean;
}

export interface AgentCandidateScore {
  agent_id: string;
  score: number;
  matched_areas: string[];
  owns_task_type: boolean;
  owns_data_source: boolean;
  reason: string;
}

export interface MatchResult {
  requirements: MatchRequirements;
  best: AgentCandidateScore | null;
  backup: AgentCandidateScore | null;
  should_be_manual: boolean;
  manual_reason: string | null;
  assignment_reason: string;
}

interface AgentRosterRow {
  id: string;
  lifecycle_state: string | null;
  status: string | null;
  kb_scope: unknown;
  data_sources_allowed: unknown;
  task_types_allowed: unknown;
}

function parseScopeArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    try { const p: unknown = JSON.parse(raw); return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []; }
    catch { return []; }
  }
  return [];
}

/**
 * Effective scope for an agent: the DB-granted scope (seeded from ROLE_SPECS at
 * install, editable thereafter), falling back to ROLE_SPECS when the columns
 * are empty (e.g. legacy rows that predate the redesign).
 */
function effectiveScope(row: AgentRosterRow): { kb_scope: string[]; data_sources: string[]; task_types: string[] } {
  const spec = ROLE_SPECS[row.id];
  const kb = parseScopeArray(row.kb_scope);
  const ds = parseScopeArray(row.data_sources_allowed);
  const tt = parseScopeArray(row.task_types_allowed);
  return {
    kb_scope: kb.length ? kb : (spec?.kb_scope ?? []),
    data_sources: ds.length ? ds : (spec?.data_sources ?? []),
    task_types: tt.length ? tt : (spec?.task_types ?? []),
  };
}

// ─── Requirement derivation (pure) ─────────────────────────────────────────────

function deriveRisk(input: MatchInput): RiskLevel {
  if (input.action_type && DANGEROUS_ACTION_TYPES.has(input.action_type)) return 'high';
  const sev = (input.severity ?? '').toLowerCase();
  if (sev === 'critical' || sev === 'security_risk') return 'high';
  if (sev === 'alert' || sev === 'warning') return 'medium';
  return 'low';
}

function deriveUrgency(input: MatchInput): Urgency {
  const sev = (input.severity ?? '').toLowerCase();
  const pri = (input.priority ?? '').toLowerCase();
  if (sev === 'critical' || pri === 'p0') return 'critical';
  if (sev === 'alert' || pri === 'p1') return 'high';
  if (sev === 'warning' || pri === 'p2') return 'normal';
  return 'low';
}

/**
 * Derive the full requirement profile for a task/signal. Pure.
 */
export function deriveRequirements(input: MatchInput): MatchRequirements {
  const areas = deriveSignalKnowledgeAreas({
    rule_id: input.rule_id,
    connector_type: input.connector_type,
    type: input.type,
  });
  const risk = deriveRisk(input);
  return {
    areas,
    required_task_type: input.action_type ?? null,
    data_source: input.connector_type ?? null,
    risk,
    urgency: deriveUrgency(input),
    // High-risk / dangerous actions always require approval (mirrors the
    // server-owned DANGEROUS_ACTION_TYPES floor — never weakened here).
    requires_approval: risk === 'high' || (input.action_type ? DANGEROUS_ACTION_TYPES.has(input.action_type) : false) || true,
  };
}

/**
 * Score how well a role fits the requirements. Pure — operates on RoleSpec, not
 * the DB. Higher = better. 0 = not a fit.
 */
export function scoreAgentForRequirements(
  agentId: string,
  spec: { kb_scope: readonly string[]; data_sources: readonly string[]; task_types: readonly string[] },
  req: MatchRequirements,
): AgentCandidateScore {
  const matched = intersectAreas(spec.kb_scope, req.areas);
  const ownsTaskType = req.required_task_type != null && spec.task_types.includes(req.required_task_type);
  const ownsDataSource = req.data_source != null && spec.data_sources.includes(req.data_source);

  let score = 0;
  score += matched.length * 10;             // area overlap is the primary driver
  if (ownsTaskType) score += 25;            // owning the exact action_type is decisive
  if (ownsDataSource) score += 8;           // owning the data source is a strong hint

  const bits: string[] = [];
  if (matched.length) bits.push(`knowledge areas (${matched.join(', ')})`);
  if (ownsDataSource && req.data_source) bits.push(`reads ${req.data_source}`);
  if (ownsTaskType && req.required_task_type) bits.push(`owns the "${req.required_task_type}" capability`);

  return {
    agent_id: agentId,
    score,
    matched_areas: matched,
    owns_task_type: ownsTaskType,
    owns_data_source: ownsDataSource,
    reason: bits.join('; ') || 'no domain overlap',
  };
}

/**
 * Build the human-readable assignment reason string the sidebar shows, e.g.
 * "Assigned to SEO Sentinel because the signal came from GSC, affected indexed
 * product pages, and requires metadata/internal-linking expertise."
 */
export function buildAssignmentReason(
  agentId: string,
  req: MatchRequirements,
  score: AgentCandidateScore,
): string {
  const spec = ROLE_SPECS[agentId];
  const name = spec?.role ?? agentId;
  const parts: string[] = [];
  if (req.data_source) parts.push(`the trigger came from ${req.data_source}`);
  if (score.matched_areas.length) parts.push(`it touches ${score.matched_areas.join(', ')}`);
  if (score.owns_task_type && req.required_task_type) parts.push(`and "${req.required_task_type}" is within its remit`);
  const because = parts.length ? parts.join(', ') : 'it is the closest match on knowledge scope';
  return `Assigned to ${name} (${agentId}) because ${because}.`;
}

// ─── DB-aware matching + guardrails ─────────────────────────────────────────────

/** Roster of agents that are live (part of the working roster). */
function liveRoster(): AgentRosterRow[] {
  const rows = db.prepare('SELECT id, lifecycle_state, status, kb_scope, data_sources_allowed, task_types_allowed FROM agents').all() as AgentRosterRow[];
  return rows.filter((r) => {
    const state = (r.lifecycle_state ?? '') as AgentLifecycleState;
    if ((LIVE_STATES as readonly string[]).includes(state)) return true;
    // Fall back to legacy status for un-backfilled rows.
    return !r.lifecycle_state && r.status === 'active';
  });
}

/** How many agents are currently occupied with in-flight work. */
export function countBusyAgents(): number {
  const rows = db.prepare('SELECT lifecycle_state FROM agents').all() as Array<{ lifecycle_state: string | null }>;
  return rows.filter((r) => (BUSY_STATES as readonly string[]).includes(r.lifecycle_state ?? '')).length;
}

/**
 * Is another agent already working this scope/task in-flight? Prevents two
 * agents racing the same domain. We check open tasks assigned to a live agent
 * whose action_type or signal areas overlap the requirement.
 */
export function isScopeInFlight(req: MatchRequirements, businessId: string, excludeAgentId?: string): boolean {
  // 1. Another live agent currently busy whose scope overlaps the areas.
  const roster = liveRoster();
  for (const r of roster) {
    if (r.id === excludeAgentId) continue;
    const state = getLifecycleState(r.id);
    if (!state || !(BUSY_STATES as readonly string[]).includes(state)) continue;
    const scope = effectiveScope(r);
    if (intersectAreas(scope.kb_scope, req.areas).length > 0) return true;
  }
  // 2. An open task already assigned for the same action_type.
  if (req.required_task_type) {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM tasks
       WHERE business_id = ?
         AND action_type = ?
         AND assigned_to IS NOT NULL
         AND assigned_to != ''
         AND status IN ('approved', 'executing')
    `).get(businessId, req.required_task_type) as { n: number } | undefined;
    if ((row?.n ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Match a task/signal to the best agent. DB-aware: only considers live agents,
 * skips those in cooldown, and annotates whether the work should be manual.
 */
export function matchAgent(input: MatchInput, businessId: string): MatchResult {
  const req = deriveRequirements(input);
  const roster = liveRoster();

  const scored: AgentCandidateScore[] = [];
  for (const r of roster) {
    if (r.id === 'conductor') continue; // conductor never owns domain work
    if (isInCooldown(r.id)) continue;   // guardrail: skip cooling-down agents
    const scope = effectiveScope(r);
    // An agent with no granted scope at all cannot own work.
    if (scope.kb_scope.length === 0 && scope.task_types.length === 0) continue;
    const s = scoreAgentForRequirements(r.id, scope, req);
    if (s.score > 0) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0] ?? null;
  const backup = scored[1] ?? null;

  // Should this be manual instead?
  let shouldBeManual = false;
  let manualReason: string | null = null;
  if (!best) {
    shouldBeManual = true;
    manualReason = 'No specialist agent owns this knowledge area — route to a human.';
  } else if (req.risk === 'high' && best.score < 25) {
    shouldBeManual = true;
    manualReason = 'High-risk action with only a weak agent match — a human should decide.';
  }

  const assignmentReason = best
    ? buildAssignmentReason(best.agent_id, req, best)
    : (manualReason ?? 'No agent matched.');

  return { requirements: req, best, backup, should_be_manual: shouldBeManual, manual_reason: manualReason, assignment_reason: assignmentReason };
}

/**
 * Claim exclusive ownership of a task for an agent. Guarded UPDATE ensures
 * exactly one active owner — the claim only succeeds if the task is currently
 * unassigned (or already owned by this agent). Returns true if the claim won.
 */
export function claimTaskOwnership(taskId: string, agentId: string): boolean {
  const res = db.prepare(`
    UPDATE tasks SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (assigned_to IS NULL OR assigned_to = '' OR assigned_to = ?)
  `).run(agentId, taskId, agentId);
  return (res.changes ?? 0) > 0;
}

/**
 * Persist an activation record (the per-activation audit trail). Returns id.
 */
export function recordActivation(input: {
  agentId: string;
  businessId: string;
  triggerSource: string;
  triggerRef?: string | null;
  matchedAreas: string[];
  selectionReason: string;
  alternatives?: Array<{ agent_id: string; reason: string }>;
  confidence?: number | null;
  taskId?: string | null;
  evidence?: unknown[];
  runId?: string | null;
}): string {
  const id = generateId();
  try {
    db.prepare(`
      INSERT INTO agent_activations (
        id, agent_id, business_id, trigger_source, trigger_ref, matched_areas,
        selection_reason, alternatives, confidence, task_id, evidence, run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id, input.agentId, input.businessId, input.triggerSource, input.triggerRef ?? null,
      JSON.stringify(input.matchedAreas ?? []),
      input.selectionReason ?? null,
      JSON.stringify(input.alternatives ?? []),
      input.confidence ?? null,
      input.taskId ?? null,
      JSON.stringify(input.evidence ?? []),
      input.runId ?? null,
    );
  } catch (err) {
    console.warn('[matcher] recordActivation failed (non-fatal):', (err as Error).message);
  }
  return id;
}
