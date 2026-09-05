import db, { generateId } from '../db/db.js';
import { listPendingDecisions, type PendingDecision } from '../decisions/decision-queue.js';
import { DANGEROUS_ACTION_TYPES } from './approval.js';
import { approveTask, rejectTask, updateTaskStatus } from './task-queue.js';
import { getActionRegistryEntry } from './action-registry.js';
import { matchAgent } from '../agents/agentMatcher.js';
import { deliverAgentBrief } from '../agents/agent-inbox.js';
import { ROLE_SPECS } from '../agents/agentActivationRules.js';
import { LIVE_STATES } from '../agents/agentLifecycle.js';

export interface AutonomousProgressionResult {
  considered: number;
  approved: number;
  assigned: number;
  skipped: Array<{ task_id: string; reason: string }>;
  errors: Array<{ task_id: string; error: string }>;
}

const DEFAULT_LIMIT = 10;

const HUMAN_ONLY_ACTION_TYPES = new Set<string>([
  ...DANGEROUS_ACTION_TYPES,
  'hire_agent',
  'connect_connector',
  'github_issue',
  'github_pr',
  'github_review_deploy',
  'gbp_post',
  'gbp_update',
  'klaviyo_flow_update',
  'meta_ads_update',
  'meta-ads-change',
  'scheduled_workflow',
  'config_change',
  'deployment_hardening',
]);

const HUMAN_ONLY_TEXT = [
  'payment', 'refund', 'charge', 'invoice', 'stripe',
  'legal', 'contract', 'terms', 'privacy policy',
  'delete', 'remove', 'destructive', 'irreversible',
  'publish', 'send', 'email', 'sms', 'customer', 'public outreach',
  'hire', 'candidate', 'access', 'permission', 'identity', 'credential',
  'manual step', 'human step', 'provider must', 'provider-human',
];

const AGENT_OWNED_ACTION_TYPES = new Set<string>([
  'content_brief',
  'page_optimisation',
  'product_suggestion',
  'strategic_review',
  'notification',
]);

const PREFERRED_AGENT_BY_ACTION_TYPE: Record<string, string> = {
  content_brief: 'quill',
  page_optimisation: 'seo-sentinel',
  product_suggestion: 'merchant',
  strategic_review: 'reporter',
  notification: 'reporter',
};

function textFor(item: PendingDecision): string {
  return [
    item.title,
    item.description ?? '',
    item.required_action.action_type ?? '',
    JSON.stringify(item.required_action.payload ?? {}),
  ].join(' ').toLowerCase();
}

export function autonomousSkipReason(item: PendingDecision): string | null {
  if (item.status !== 'proposed') return `status '${item.status}' is not autonomously approvable`;
  if (!item.required_action.action_type) return 'manual task has no executable action_type';

  const actionType = item.required_action.action_type;
  if (HUMAN_ONLY_ACTION_TYPES.has(actionType)) return `action_type '${actionType}' is human-only for autonomous progression`;

  const entry = getActionRegistryEntry(actionType);
  if (!entry) return `action_type '${actionType}' is not registered`;
  const agentOwned = AGENT_OWNED_ACTION_TYPES.has(actionType);
  if (!entry.dispatched_by_executor && !agentOwned) return `action_type '${actionType}' has no Blueprint executor or agent handoff`;
  if (entry.dispatched_by_executor !== Boolean(item.required_action.executable)) {
    return `action_type '${actionType}' executor registry mismatch`;
  }
  if (entry.required_permissions.length > 0) return `action_type '${actionType}' requires explicit permissions`;
  if (entry.side_effect_classification !== 'internal_idempotent') {
    return `action_type '${actionType}' is not internal/idempotent`;
  }

  const text = textFor(item);
  const riskyText = HUMAN_ONLY_TEXT.find((word) => text.includes(word));
  if (riskyText) return `contains human-only marker '${riskyText}'`;

  return null;
}

function rejectReason(item: PendingDecision): string | null {
  const reason = autonomousSkipReason(item);
  if (reason) return reason;

  // Applicability uncertainty is a risk signal, not a safety prohibition.
  // It is safe to investigate when the action itself is read-only/idempotent
  // and no independent exposure/scope/confidence signal escalated it.
  if (item.risk_tier === 'red') return "risk tier 'red' is never autonomously approvable";
  if (item.risk_tier === 'orange') {
    const evidence = item.risk_evidence;
    const thresholds = (evidence.thresholds_applied ?? {}) as Record<string, unknown>;
    const affected = Number(evidence.affected_records ?? 0);
    const exposure = Number(evidence.financial_exposure_gbp ?? 0);
    const confidence = evidence.agent_confidence == null ? null : Number(evidence.agent_confidence);
    const lowConfidence = confidence != null && confidence < Number(thresholds.min_agent_confidence ?? 0);
    const applicabilityOnly = item.applicability_status === 'unknown'
      && affected <= Number(thresholds.affected_records_review ?? Infinity)
      && exposure < Number(thresholds.financial_exposure_review_gbp ?? Infinity)
      && !lowConfidence;
    if (!applicabilityOnly) return "risk tier 'orange' has an independent escalation beyond applicability uncertainty";
  }
  if (item.lane === 'policy_gated') {
    return `operating policy hold: ${item.lane_reason}`;
  }
  return null;
}

type ProposedDisposition = 'approve' | 'reject' | 'hold';

function classifyProposedTask(item: PendingDecision): { disposition: ProposedDisposition; reason: string } {
  const reason = rejectReason(item);
  return reason
    ? { disposition: 'reject', reason: `Rejected by autonomous progression: ${reason}` }
    : { disposition: 'approve', reason: 'Safe routine work.' };
}

const RECOVERABLE_HOLD_PREFIX = 'Held for human/policy review:';

/** Requeue only proposals stranded by the previous classifier. */
export function recoverAutonomousProgressionHolds(businessId: string, actor = 'system:autonomous-progression'): number {
  const rows = db.prepare(`
      SELECT id FROM tasks
      WHERE business_id = ?
        AND status = 'manual_review'
        AND substr(rejection_reason, 1, length(?)) = ?
    `).all(businessId, RECOVERABLE_HOLD_PREFIX, RECOVERABLE_HOLD_PREFIX) as Array<{ id: string }>;
  for (const row of rows) {
    db.prepare("UPDATE tasks SET rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'manual_review'").run(row.id);
    updateTaskStatus(row.id, 'proposed', actor, { reason: 'Recovered from prior autonomous-progression hold marker.' });
  }
  return rows.length;
}


function buildAgentBrief(item: PendingDecision, agentId: string): string {
  const payload = JSON.stringify(item.required_action.payload ?? {}, null, 2);
  return [
    `Routine task approved and assigned to you: ${item.title}`,
    `Task ID: ${item.task_id}`,
    `Action type: ${item.required_action.action_type ?? 'none'}`,
    item.description ? `Description: ${item.description}` : null,
    item.estimated_impact ? `Estimated impact: ${item.estimated_impact}` : null,
    `Priority: ${item.priority}`,
    `Confidence: ${item.confidence ?? 'unknown'}`,
    `Assigned agent: ${agentId}`,
    payload && payload !== '{}' ? `Payload:\n${payload}` : null,
    'Produce the requested internal work product in your normal output/KB flow. Do not publish or mutate external systems unless a separate executor-backed approved task exists.',
  ].filter((line): line is string => Boolean(line)).join('\n\n');
}

function resolveAgentHandoff(item: PendingDecision): { agentId: string; reason: string } | null {
  const actionType = item.required_action.action_type;
  if (!actionType || !AGENT_OWNED_ACTION_TYPES.has(actionType)) return null;

  const preferred = PREFERRED_AGENT_BY_ACTION_TYPE[actionType];
  if (preferred && liveAgentOwnsAction(preferred, actionType)) {
    return {
      agentId: preferred,
      reason: `Assigned to ${preferred} because it is the preferred owner for routine '${actionType}' work.`,
    };
  }

  const match = matchAgent({
    action_type: actionType,
    priority: item.priority,
    title: item.title,
  }, item.business_id);
  if (!match.best || match.should_be_manual) return null;
  return { agentId: match.best.agent_id, reason: match.assignment_reason };
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function liveAgentOwnsAction(agentId: string, actionType: string): boolean {
  const row = db.prepare('SELECT status, lifecycle_state, task_types_allowed FROM agents WHERE id = ?')
    .get(agentId) as { status: string | null; lifecycle_state: string | null; task_types_allowed: unknown } | null;
  if (!row) return false;
  const live = row.lifecycle_state
    ? (LIVE_STATES as readonly string[]).includes(row.lifecycle_state)
    : row.status === 'active';
  if (!live) return false;

  const allowed = parseStringArray(row.task_types_allowed);
  const effective = allowed.length > 0 ? allowed : (ROLE_SPECS[agentId]?.task_types ?? []);
  return effective.includes(actionType);
}

/**
 * Progress existing proposed tasks that are already classified as routine and
 * executable. This deliberately reuses approveTask() for the actual state
 * transition, so policy, connector, payload, permission, receipt, and job
 * creation gates remain canonical.
 */
export async function progressRoutineProposedTasks(
  businessId: string,
  options: { actor?: string; limit?: number } = {},
): Promise<AutonomousProgressionResult> {
  const actor = options.actor ?? 'system:autonomous-progression';
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 50));
  recoverAutonomousProgressionHolds(businessId, actor);
  const queue = listPendingDecisions(businessId, { limit: 200 });
  const proposed = queue.decisions
    .filter((item) => item.status === 'proposed')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const result: AutonomousProgressionResult = { considered: proposed.length, approved: 0, assigned: 0, skipped: [], errors: [] };

  for (const item of proposed) {
    const classification = result.approved >= limit
      ? { disposition: 'hold' as const, reason: `Held for human/policy review: autonomous approval limit (${limit}) reached for this sweep.` }
      : classifyProposedTask(item);
    if (classification.disposition === 'reject') {
      try {
        rejectTask(item.task_id, actor, classification.reason);
        result.skipped.push({ task_id: item.task_id, reason: classification.reason });
      } catch (err) {
        result.errors.push({ task_id: item.task_id, error: (err as Error).message });
      }
      continue;
    }
    if (classification.disposition === 'hold') {
      result.skipped.push({ task_id: item.task_id, reason: classification.reason });
      continue;
    }

    try {
      const handoff = resolveAgentHandoff(item);
      if (AGENT_OWNED_ACTION_TYPES.has(item.required_action.action_type ?? '') && !handoff) {
        const reason = `Rejected by autonomous progression: no live agent owns action_type '${item.required_action.action_type}'`;
        rejectTask(item.task_id, actor, reason);
        result.skipped.push({ task_id: item.task_id, reason });
        continue;
      }

      approveTask(
        item.task_id,
        actor,
        handoff ? { agentAssignment: { agentId: handoff.agentId, reason: handoff.reason } } : {},
      );
      result.approved += 1;
      if (handoff) {
        result.assigned += 1;
        await deliverAgentBrief({
          from: actor,
          to: handoff.agentId,
          businessId,
          brief: buildAgentBrief(item, handoff.agentId),
          priority: 'immediate',
          metadata: {
            task_id: item.task_id,
            action_type: item.required_action.action_type,
            assignment_reason: handoff.reason,
          },
          source_label: `task:${item.task_id}`,
        });
      }
    } catch (err) {
      const error = (err as Error).message;
      result.errors.push({ task_id: item.task_id, error });
      try { rejectTask(item.task_id, actor, `Rejected after autonomous progression failure: ${error}`); } catch { /* preserve original error */ }
    }
  }

  db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (?, ?, 'autonomy', ?, 'routine_progression_sweep', ?, ?, CURRENT_TIMESTAMP)
    `).run(
      generateId(), businessId, businessId, actor,
      JSON.stringify({ considered: result.considered, approved: result.approved, assigned: result.assigned, skipped: result.skipped.length, errors: result.errors.length }),
    );

  return result;
}

/**
 * Canonical conductor sweep hook. Keep all conductor entry points calling this
 * wrapper so they share one logging path while progressRoutineProposedTasks()
 * remains the only place that selects and approves eligible routine work.
 */
export async function runConductorAutonomousProgressionSweep(
  businessId: string,
): Promise<AutonomousProgressionResult | null> {
  try {
    const progressed = await progressRoutineProposedTasks(businessId);
    if (progressed.approved > 0 || progressed.errors.length > 0) {
      console.log(
        `[conductor] Routine task progression: ${progressed.approved} approved, ${progressed.assigned} assigned, ` +
        `${progressed.skipped.length} skipped, ${progressed.errors.length} errors.`
      );
    }
    return progressed;
  } catch (err) {
    const error = (err as Error).message;
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (?, ?, 'autonomy', ?, 'routine_progression_failure', ?, ?, CURRENT_TIMESTAMP)
    `).run(generateId(), businessId, businessId, 'system:autonomous-progression', JSON.stringify({ error }));
    console.warn('[conductor] Routine task progression failed:', error);
    return null;
  }
}
