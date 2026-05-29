/**
 * Structured agent lifecycle state machine.
 *
 * Replaces the old free-text `agents.status` model (where a hired agent went
 * straight to 'active' and immediately ran) with explicit, audited states and
 * enforced transitions — modelled on task-queue's VALID_TRANSITIONS.
 *
 * The model:
 *
 *   candidate ──► proposed ──► approved ──► hired ──► standby
 *                    │                                   │
 *                    └────────── rejected                ├─► triggered ──► assigned ──► working
 *                                                        │                                │
 *      archived ◄── (retire from any non-terminal) ──────┘        ┌── blocked ◄───────────┤
 *                                                                 │                        │
 *                                                                 │   awaiting_approval ◄──┤
 *                                                                 │        │               │
 *                                                                 └────────┴──► completed ─► verified ─► standby
 *
 * CRITICAL invariants enforced here (the core complaint fix):
 *   - Hiring does NOT auto-activate work. A newly hired agent lands in `standby`.
 *   - `proposed` agents require an explicit human `approve` before `hired`.
 *   - Only an activation (signal/schedule/manual/workflow/escalation) moves an
 *     agent out of `standby` into `triggered`. `standby → working` is illegal.
 *
 * The structured lifecycle_state runs in PARALLEL with the legacy `status`
 * column so existing run-gates (conductor/readiness/agent-runner read
 * `status === 'active'`) keep working. setLifecycleState keeps `status` in sync.
 */

import db, { generateId } from '../db/db.js';

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

export const AGENT_LIFECYCLE_STATES: readonly AgentLifecycleState[] = [
  'candidate', 'proposed', 'approved', 'hired', 'standby', 'triggered',
  'assigned', 'working', 'blocked', 'awaiting_approval', 'completed',
  'verified', 'archived',
] as const;

/**
 * Allowed transitions. A transition not listed here is rejected by
 * transitionAgent() with a descriptive error (same contract as task-queue).
 */
export const VALID_AGENT_TRANSITIONS: Record<AgentLifecycleState, AgentLifecycleState[]> = {
  // A suggested agent must be explicitly proposed (or dropped → archived).
  candidate: ['proposed', 'archived'],
  // A proposal requires explicit human approval before hire (or rejection).
  proposed: ['approved', 'archived'],
  // Approval is the human gate; hiring is the mechanical install step.
  approved: ['hired', 'archived'],
  // Hiring NEVER auto-activates work — a hired agent rests in standby.
  hired: ['standby', 'archived'],
  // Standby is the resting state. Only an activation moves it to triggered.
  standby: ['triggered', 'archived'],
  // Triggered = an activation fired; the matcher then assigns concrete work.
  triggered: ['assigned', 'standby', 'archived'],
  // Assigned = a task is bound to this agent; it then starts working.
  assigned: ['working', 'blocked', 'standby', 'archived'],
  // Working = the agent is actively running its task.
  working: ['awaiting_approval', 'completed', 'blocked', 'standby', 'archived'],
  // Blocked = stuck (missing connector, failure, escalation). Cools down then
  // returns to standby, or is escalated/archived. NEVER loops back to working
  // directly — it must re-enter via standby → triggered (re-activation).
  blocked: ['standby', 'archived'],
  // Awaiting approval = a dangerous action is gated on a human.
  awaiting_approval: ['working', 'completed', 'blocked', 'standby', 'archived'],
  // Completed = work done; awaits verification.
  completed: ['verified', 'standby', 'archived'],
  // Verified = outcome confirmed; agent returns to standby for next cycle.
  verified: ['standby', 'archived'],
  // Terminal.
  archived: [],
};

/**
 * States in which an agent is considered "live" (installed and part of the
 * working roster) vs. pre-hire (candidate/proposed/approved) or terminal.
 */
export const LIVE_STATES: readonly AgentLifecycleState[] = [
  'hired', 'standby', 'triggered', 'assigned', 'working',
  'blocked', 'awaiting_approval', 'completed', 'verified',
] as const;

/** States in which an agent is actively occupied with in-flight work. */
export const BUSY_STATES: readonly AgentLifecycleState[] = [
  'triggered', 'assigned', 'working', 'awaiting_approval',
] as const;

/**
 * Map a structured lifecycle_state onto the legacy free-text `status` column so
 * the existing run-gates (status === 'active' / 'pending' / 'paused' /
 * 'retired') continue to behave. This is the bridge that keeps the redesign
 * additive.
 */
export function lifecycleToLegacyStatus(state: AgentLifecycleState): string {
  switch (state) {
    case 'candidate':
    case 'proposed':
    case 'approved':
      return 'pending';   // not yet runnable
    case 'archived':
      return 'retired';
    case 'blocked':
      return 'paused';    // blocked agents must not be run by the conductor
    default:
      // hired / standby / triggered / assigned / working / awaiting_approval /
      // completed / verified are all part of the active roster.
      return 'active';
  }
}

export interface AgentLifecycleRow {
  id: string;
  name: string | null;
  status: string | null;
  lifecycle_state: AgentLifecycleState | null;
  role: string | null;
  purpose: string | null;
  last_activation_reason: string | null;
  confidence: number | null;
  requires_approval: number | null;
  success_count: number | null;
  failure_count: number | null;
  cooldown_until: string | null;
  kb_scope: unknown;
  tools_allowed: unknown;
  data_sources_allowed: unknown;
  task_types_allowed: unknown;
  current_task_id: string | null;
  lifecycle_updated_at: string | null;
  [key: string]: unknown;
}

export interface TransitionOptions {
  reason?: string;
  metadata?: Record<string, unknown>;
  businessId?: string | null;
  /** Patch additional agent columns atomically with the transition. */
  patch?: Partial<{
    last_activation_reason: string | null;
    confidence: number | null;
    current_task_id: string | null;
    cooldown_until: string | null;
  }>;
}

export interface TransitionResult {
  ok: boolean;
  agentId: string;
  from: AgentLifecycleState | null;
  to: AgentLifecycleState;
  error?: string;
}

/** Type guard: is this string a known lifecycle state? */
export function isLifecycleState(value: unknown): value is AgentLifecycleState {
  return typeof value === 'string' && (AGENT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** Is `to` reachable from `from` in one step? */
export function canTransition(from: AgentLifecycleState, to: AgentLifecycleState): boolean {
  return (VALID_AGENT_TRANSITIONS[from] ?? []).includes(to);
}

function safeParseArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Read an agent's full lifecycle row (or null). */
export function getAgentLifecycle(agentId: string): AgentLifecycleRow | null {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentLifecycleRow | null;
  return row ?? null;
}

/** Resolve the current lifecycle_state, falling back to the legacy mapping. */
export function getLifecycleState(agentId: string): AgentLifecycleState | null {
  const row = getAgentLifecycle(agentId);
  if (!row) return null;
  if (isLifecycleState(row.lifecycle_state)) return row.lifecycle_state;
  // Backfill on read for rows predating the column.
  const legacy = row.status ?? 'active';
  const fallback: AgentLifecycleState =
    legacy === 'pending' ? 'candidate'
    : legacy === 'retired' || legacy === 'disabled' ? 'archived'
    : legacy === 'paused' ? 'standby'
    : 'standby';
  return fallback;
}

/** Parse the JSON scope columns into typed string arrays. */
export function getAgentScope(agentId: string): {
  kb_scope: string[];
  tools_allowed: string[];
  data_sources_allowed: string[];
  task_types_allowed: string[];
} {
  const row = getAgentLifecycle(agentId);
  return {
    kb_scope: safeParseArray(row?.kb_scope),
    tools_allowed: safeParseArray(row?.tools_allowed),
    data_sources_allowed: safeParseArray(row?.data_sources_allowed),
    task_types_allowed: safeParseArray(row?.task_types_allowed),
  };
}

/**
 * Record a lifecycle transition event for audit/timeline reconstruction.
 */
function recordLifecycleEvent(
  agentId: string,
  from: AgentLifecycleState | null,
  to: AgentLifecycleState,
  actor: string,
  opts: TransitionOptions,
): void {
  try {
    db.prepare(`
      INSERT INTO agent_lifecycle_events (id, agent_id, business_id, from_state, to_state, actor, reason, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      generateId(), agentId, opts.businessId ?? null, from, to, actor,
      opts.reason ?? null, JSON.stringify(opts.metadata ?? {}),
    );
  } catch (err) {
    console.warn('[lifecycle] event insert failed (non-fatal):', (err as Error).message);
  }
  // Mirror into the central audit_log too so it shows up in existing audit views.
  try {
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      generateId(), opts.businessId ?? null, agentId,
      `lifecycle:${from ?? 'none'}->${to}`, actor,
      JSON.stringify({ reason: opts.reason ?? null, ...(opts.metadata ?? {}) }),
    );
  } catch { /* audit is best-effort */ }
}

/**
 * Set an agent's lifecycle_state directly (with the legacy status bridge and a
 * patch of related columns). Does NOT validate the transition — callers that
 * want enforcement use transitionAgent(). Used by the installer for the initial
 * candidate/hired/standby seeding.
 */
export function setLifecycleState(
  agentId: string,
  to: AgentLifecycleState,
  actor: string,
  opts: TransitionOptions = {},
): void {
  const from = getLifecycleState(agentId);
  const legacyStatus = lifecycleToLegacyStatus(to);

  const sets: string[] = ['lifecycle_state = ?', 'status = ?', 'lifecycle_updated_at = CURRENT_TIMESTAMP'];
  const vals: Array<string | number | null> = [to, legacyStatus];

  if (opts.patch) {
    if ('last_activation_reason' in opts.patch) { sets.push('last_activation_reason = ?'); vals.push(opts.patch.last_activation_reason ?? null); }
    if ('confidence' in opts.patch) { sets.push('confidence = ?'); vals.push(opts.patch.confidence ?? null); }
    if ('current_task_id' in opts.patch) { sets.push('current_task_id = ?'); vals.push(opts.patch.current_task_id ?? null); }
    if ('cooldown_until' in opts.patch) { sets.push('cooldown_until = ?'); vals.push(opts.patch.cooldown_until ?? null); }
  }
  vals.push(agentId);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  recordLifecycleEvent(agentId, from, to, actor, opts);
}

/**
 * Transition an agent to a new lifecycle state, ENFORCING VALID_AGENT_TRANSITIONS.
 * Throws on an illegal transition (parallel to task-queue.updateTaskStatus).
 *
 * Returns the structured result rather than throwing for the "unknown agent"
 * case so activation code can branch cleanly.
 */
export function transitionAgent(
  agentId: string,
  to: AgentLifecycleState,
  actor: string,
  opts: TransitionOptions = {},
): TransitionResult {
  const from = getLifecycleState(agentId);
  if (from == null) {
    return { ok: false, agentId, from: null, to, error: `Agent '${agentId}' not found.` };
  }
  if (from === to) {
    // Idempotent no-op transition still patches columns + records the event so
    // re-entrant working/blocked states refresh their reason/cooldown.
    setLifecycleState(agentId, to, actor, opts);
    return { ok: true, agentId, from, to };
  }
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal agent transition '${from}' → '${to}' for '${agentId}'. ` +
      `Allowed: ${(VALID_AGENT_TRANSITIONS[from] ?? []).join(', ') || 'none'}.`,
    );
  }
  setLifecycleState(agentId, to, actor, opts);
  return { ok: true, agentId, from, to };
}

/**
 * Is the agent currently cooling down after a failure? Blocked agents set
 * cooldown_until; until it passes they must not be re-activated.
 */
export function isInCooldown(agentId: string, now: Date = new Date()): boolean {
  const row = getAgentLifecycle(agentId);
  if (!row?.cooldown_until) return false;
  const raw = row.cooldown_until;
  const iso = /[zZ]|[+-]\d{2}/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t > now.getTime();
}

/** Exponential-ish cooldown based on consecutive failures (capped at 6h). */
export function computeCooldownUntil(failureCount: number, now: Date = new Date()): string {
  const base = 15 * 60 * 1000; // 15 min
  const mult = Math.min(2 ** Math.max(0, failureCount - 1), 24); // cap multiplier
  const ms = Math.min(base * mult, 6 * 60 * 60 * 1000);
  return new Date(now.getTime() + ms).toISOString();
}

/**
 * Move an agent into `blocked`, record a failure, and set a cooldown so it does
 * not retry endlessly. Safe to call from a non-busy state (will no-op the
 * transition guard by routing through standby first when needed).
 */
export function blockAgent(
  agentId: string,
  actor: string,
  reason: string,
  opts: { businessId?: string | null; escalateTo?: string | null } = {},
): TransitionResult {
  const row = getAgentLifecycle(agentId);
  const failureCount = (row?.failure_count ?? 0) + 1;
  const cooldownUntil = computeCooldownUntil(failureCount);

  try {
    db.prepare('UPDATE agents SET failure_count = failure_count + 1 WHERE id = ?').run(agentId);
  } catch { /* best-effort */ }

  const from = getLifecycleState(agentId);
  // If we're not in a state that can reach 'blocked', the failure is still
  // recorded; we just persist the cooldown without an illegal transition.
  if (from && !canTransition(from, 'blocked') && from !== 'blocked') {
    setLifecycleState(agentId, from, actor, {
      reason: `failure recorded (no transition): ${reason}`,
      businessId: opts.businessId,
      metadata: { escalate_to: opts.escalateTo ?? null, failure_count: failureCount },
      patch: { cooldown_until: cooldownUntil },
    });
    return { ok: true, agentId, from, to: from };
  }

  return transitionAgent(agentId, 'blocked', actor, {
    reason,
    businessId: opts.businessId,
    metadata: { escalate_to: opts.escalateTo ?? null, failure_count: failureCount },
    patch: { cooldown_until: cooldownUntil, last_activation_reason: reason },
  });
}

/** Record a successful completion (increments success_count, clears cooldown). */
export function recordAgentSuccess(agentId: string): void {
  try {
    db.prepare(
      'UPDATE agents SET success_count = success_count + 1, cooldown_until = NULL WHERE id = ?'
    ).run(agentId);
  } catch { /* best-effort */ }
}

/** Reliability summary for the sidebar. */
export function getAgentReliability(agentId: string): {
  success_count: number;
  failure_count: number;
  success_rate: number | null;
} {
  const row = getAgentLifecycle(agentId);
  const s = row?.success_count ?? 0;
  const f = row?.failure_count ?? 0;
  const total = s + f;
  return { success_count: s, failure_count: f, success_rate: total > 0 ? s / total : null };
}
