/**
 * Brain — Decision Memory (Phase 3).
 *
 * Every consequential decision Blueprint (or a human, or an external BAP
 * agent) makes becomes a durable, evidence-carrying row here — not
 * reconstructed after the fact from scattered audit_log/task/goal state,
 * and not answered by an LLM guessing from context. "Why did we decide X
 * six months ago" should always be answerable by reading this table.
 *
 * This module is the single place decisions are written; every call site
 * (task-queue.ts's approve/reject, goal-reasoner.ts's strategy selection,
 * conflict-engine.ts's resolve/dismiss, goal-suggester.ts's accept/dismiss)
 * calls recordDecision() rather than writing its own ad-hoc log entry.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { resolveOperatingPolicy } from '../policy/operating-policy.js';

export type DecisionType =
  | 'task_approval' | 'task_rejection' | 'task_cancellation'
  | 'strategy_selection' | 'goal_creation' | 'goal_status_change'
  | 'conflict_resolution' | 'conflict_dismissal'
  | 'opportunity_accepted' | 'opportunity_dismissed'
  // Recommendation comparison (#66). A selection states a PREFERENCE
  // between compared candidates; it does not approve or execute the
  // winner, which stays the separate existing approval step.
  | 'comparison_selection' | 'comparison_deferral'
  | 'manual';

export interface RecordDecisionInput {
  business_id: string;
  decision_type: DecisionType;
  title: string;
  decision: string;
  reasoning?: string | null;
  evidence?: unknown[];
  confidence?: number | null;
  alternatives_rejected?: unknown[];
  author: string;
  related_goal_id?: string | null;
  related_task_id?: string | null;
  related_signal_id?: string | null;
  related_outcome_id?: string | null;
  related_conflict_id?: string | null;
  /**
   * Operating policy in force when the decision was made (#68). Callers
   * that already resolved the policy pass it so the record cites the exact
   * version their gating used; everyone else leaves it undefined and it is
   * resolved here, so EVERY decision row carries a policy citation and a
   * business scope without every call site having to remember.
   */
  effective_policy_id?: string | null;
  effective_policy_version?: number | null;
  effective_policy_scope?: string | null;
}

export function recordDecision(input: RecordDecisionInput): string {
  const id = crypto.randomUUID();

  let policyId = input.effective_policy_id ?? null;
  let policyVersion = input.effective_policy_version ?? null;
  let policyScope = input.effective_policy_scope ?? null;
  if (policyVersion == null) {
    try {
      const resolved = resolveOperatingPolicy(input.business_id);
      policyId = resolved.policy_id;
      policyVersion = resolved.policy_version;
      policyScope = resolved.policy_scope;
    } catch {
      // A decision must never fail to be recorded because policy
      // resolution did — the citation degrades, the memory does not.
      policyVersion = policyVersion ?? null;
    }
  }

  db.prepare(`
    INSERT INTO decisions (
      id, business_id, decision_type, title, decision, reasoning, evidence,
      confidence, alternatives_rejected, author,
      related_goal_id, related_task_id, related_signal_id, related_outcome_id, related_conflict_id,
      effective_policy_id, effective_policy_version, effective_policy_scope,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, input.business_id, input.decision_type, input.title, input.decision,
    input.reasoning ?? null, JSON.stringify(input.evidence ?? []),
    input.confidence ?? null, JSON.stringify(input.alternatives_rejected ?? []),
    input.author,
    input.related_goal_id ?? null, input.related_task_id ?? null,
    input.related_signal_id ?? null, input.related_outcome_id ?? null,
    input.related_conflict_id ?? null,
    policyId, policyVersion, policyScope,
  );
  import('../bap/webhook-dispatcher.js').then((m: any) =>
    m.dispatchWebhookEvent('decision.created', {
      decision_id: id, business_id: input.business_id,
      decision_type: input.decision_type, title: input.title,
      confidence: input.confidence ?? null,
    })
  ).catch(() => {});
  return id;
}

function parseDecisionRow(row: Record<string, unknown>): Record<string, unknown> {
  let evidence: unknown[] = [];
  let alternatives: unknown[] = [];
  try { evidence = JSON.parse((row.evidence as string) || '[]'); } catch {}
  try { alternatives = JSON.parse((row.alternatives_rejected as string) || '[]'); } catch {}
  return { ...row, evidence, alternatives_rejected: alternatives };
}

export interface RecallDecisionsFilters {
  q?: string;
  decision_type?: string;
  related_goal_id?: string;
  related_task_id?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

/**
 * "Why did we decide this?" The general-purpose recall query — searches
 * title/decision/reasoning text and/or filters by related entity, so a
 * caller can ask "why did we decide anything about goal X" without
 * knowing decision IDs in advance.
 */
export function recallDecisions(businessId: string, filters: RecallDecisionsFilters = {}): { decisions: Record<string, unknown>[]; total: number } {
  const conditions = ['business_id = ?'];
  const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any

  if (filters.q) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR decision LIKE ? ESCAPE '\\' OR reasoning LIKE ? ESCAPE '\\')");
    const term = `%${filters.q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    params.push(term, term, term);
  }
  if (filters.decision_type) { conditions.push('decision_type = ?'); params.push(filters.decision_type); }
  if (filters.related_goal_id) { conditions.push('related_goal_id = ?'); params.push(filters.related_goal_id); }
  if (filters.related_task_id) { conditions.push('related_task_id = ?'); params.push(filters.related_task_id); }
  if (filters.date_from) { conditions.push('created_at >= ?'); params.push(filters.date_from); }
  if (filters.date_to) { conditions.push('created_at <= ?'); params.push(filters.date_to); }

  const where = conditions.join(' AND ');
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const page = Math.max(1, filters.page ?? 1);
  const offset = (page - 1) * limit;

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db.prepare(
    `SELECT * FROM decisions WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Array<Record<string, unknown>>;

  return { decisions: rows.map(parseDecisionRow), total };
}

export function getDecision(id: string, businessId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM decisions WHERE id = ? AND business_id = ?').get(id, businessId) as Record<string, unknown> | null;
  return row ? parseDecisionRow(row) : null;
}
