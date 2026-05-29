/**
 * Presentation helpers for the agent sidebar: clear human language + calm
 * status colours for every lifecycle state, plus grouping logic. Kept separate
 * from components so the labels are testable and reused across the card,
 * drawer, and timeline.
 */
import type {
  AgentLifecycleState,
  AgentRosterEntry,
  AgentSidebarGroup,
  AgentRiskLevel,
} from '../../types/index.js';

export interface StatusStyle {
  label: string;
  /** CSS colour token for the badge text/dot. */
  color: string;
  /** Soft background tint for the badge. */
  tint: string;
  /** Whether the dot should pulse (active work). */
  pulse: boolean;
}

// Clear, employee-like language — never raw enum values. Calm palette drawn
// from Blueprint's existing accent tokens so it stays on-theme + themeable.
export const STATUS_STYLES: Record<AgentLifecycleState, StatusStyle> = {
  candidate:         { label: 'Candidate',           color: 'var(--bp-text-3)', tint: 'rgba(77,122,150,0.12)',  pulse: false },
  proposed:          { label: 'Proposed',            color: 'var(--bp-purple)', tint: 'rgba(157,122,255,0.14)', pulse: false },
  approved:          { label: 'Approved',            color: 'var(--bp-blue)',   tint: 'rgba(77,166,255,0.14)',  pulse: false },
  hired:             { label: 'Hired',               color: 'var(--bp-green)',  tint: 'rgba(0,201,167,0.12)',   pulse: false },
  standby:           { label: 'Standby',             color: 'var(--bp-text-2)', tint: 'rgba(122,175,201,0.10)', pulse: false },
  triggered:         { label: 'Triggered',           color: 'var(--bp-cyan)',   tint: 'rgba(77,166,255,0.16)',  pulse: true },
  assigned:          { label: 'Assigned',            color: 'var(--bp-cyan)',   tint: 'rgba(77,166,255,0.16)',  pulse: true },
  working:           { label: 'Working',             color: 'var(--bp-green)',  tint: 'rgba(0,201,167,0.16)',   pulse: true },
  awaiting_approval: { label: 'Waiting for approval', color: 'var(--bp-amber)', tint: 'rgba(245,158,11,0.16)',  pulse: false },
  blocked:           { label: 'Blocked',             color: 'var(--bp-red)',    tint: 'rgba(255,82,82,0.14)',   pulse: false },
  completed:         { label: 'Completed',           color: 'var(--bp-green)',  tint: 'rgba(0,201,167,0.12)',   pulse: false },
  verified:          { label: 'Verified',            color: 'var(--bp-green)',  tint: 'rgba(0,201,167,0.12)',   pulse: false },
  archived:          { label: 'Archived',            color: 'var(--bp-text-3)', tint: 'rgba(77,122,150,0.10)',  pulse: false },
};

/** "Investigating" / "Verifying" / "Cooling down" nuance for the busy states. */
export function statusStyleFor(agent: Pick<AgentRosterEntry, 'lifecycle_state' | 'cooldown_until' | 'trigger_source'>): StatusStyle {
  const base = STATUS_STYLES[agent.lifecycle_state] ?? STATUS_STYLES.standby;
  // A standby agent still cooling down after a failure reads as "Cooling down".
  if (agent.lifecycle_state === 'standby' && agent.cooldown_until && new Date(coerceUtc(agent.cooldown_until)).getTime() > Date.now()) {
    return { ...base, label: 'Cooling down', color: 'var(--bp-amber)', tint: 'rgba(245,158,11,0.12)' };
  }
  // A working agent triggered by a deep investigation reads as "Investigating".
  if (agent.lifecycle_state === 'working' && agent.trigger_source === 'escalation') {
    return { ...base, label: 'Investigating' };
  }
  return base;
}

export const GROUP_LABELS: Record<AgentSidebarGroup, string> = {
  working: 'Working',
  awaiting_approval: 'Awaiting approval',
  triggered: 'Triggered',
  blocked: 'Blocked',
  standby: 'Standby',
  completed: 'Recently completed',
};

// Display order of the groups in the sidebar (most-active first).
export const GROUP_ORDER: AgentSidebarGroup[] = [
  'working', 'awaiting_approval', 'triggered', 'blocked', 'completed', 'standby',
];

/** Map a lifecycle state to its sidebar group bucket. */
export function groupForState(state: AgentLifecycleState): AgentSidebarGroup {
  switch (state) {
    case 'working':
    case 'assigned':
      return 'working';
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'triggered':
      return 'triggered';
    case 'blocked':
      return 'blocked';
    case 'completed':
    case 'verified':
      return 'completed';
    default:
      // candidate/proposed/approved/hired/standby/archived all rest under
      // Standby in the sidebar (pre-hire/idle roster).
      return 'standby';
  }
}

/** Group a roster into the sidebar buckets, preserving order. */
export function groupRoster(agents: AgentRosterEntry[]): Record<AgentSidebarGroup, AgentRosterEntry[]> {
  const groups: Record<AgentSidebarGroup, AgentRosterEntry[]> = {
    working: [], awaiting_approval: [], triggered: [], blocked: [], standby: [], completed: [],
  };
  for (const a of agents) {
    // Archived agents are hidden from the working sidebar entirely.
    if (a.lifecycle_state === 'archived') continue;
    groups[groupForState(a.lifecycle_state)].push(a);
  }
  return groups;
}

export const RISK_STYLES: Record<AgentRiskLevel, { label: string; color: string }> = {
  low:    { label: 'Low risk',    color: 'var(--bp-green)' },
  medium: { label: 'Medium risk', color: 'var(--bp-amber)' },
  high:   { label: 'High risk',   color: 'var(--bp-red)' },
};

/** Channel → human label for "what triggered them". */
export function channelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case 'signal': return 'Signal';
    case 'schedule': return 'Schedule';
    case 'manual': return 'Manual';
    case 'workflow': return 'Workflow';
    case 'escalation': return 'Escalation';
    default: return channel ? channel : '—';
  }
}

/** SQLite timestamps are naive UTC — coerce so Date parses them correctly. */
export function coerceUtc(isoLike: string): string {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(isoLike)) return isoLike;
  return isoLike.replace(' ', 'T') + 'Z';
}

export function formatConfidence(c: number | null | undefined): string | null {
  if (c == null) return null;
  return `${Math.round(c * 100)}%`;
}
