/**
 * Operating Policy backtest (#68 extension).
 *
 * previewPolicyChange() (operating-policy.ts) answers "under the new policy,
 * how much of TODAY's autonomy headroom is left, and which currently-OPEN
 * tasks would re-tier" — a snapshot, not a replay. This module answers the
 * different, retrospective question an operator actually needs before they
 * flip a lever that controls how much autonomy their agents get: "if this
 * draft had been active for the last N days, which of the tasks that
 * ACTUALLY got auto-approved would instead have required manual review, and
 * which of the tasks that actually required manual review would now sail
 * through?"
 *
 * Every gate decision here is produced by calling the same functions the
 * real approval path (tasks/task-queue.ts approveTask()) calls — never a
 * parallel reimplementation:
 *   - computeTierUnderPolicy()       — the exact tier calculation
 *     trust-engine.calculateApprovalTier() uses.
 *   - autonomyDecisionForDocument()  — the exact branches
 *     evaluateAutonomyGate() uses, factored out so both a live approval and
 *     a hypothetical document run through identical code.
 *   - mergePolicyDocument()/mergeOverrides() — the exact inheritance merge
 *     resolveOperatingPolicy() uses.
 * This file adds no new gating rule of its own; it only replays history
 * through the rules that already exist.
 *
 * Read-only, always. Nothing here writes to `operating_policies`,
 * `operating_policy_events` or `tasks` — it is SELECT statements plus pure
 * evaluation. There is deliberately no `db.transaction`, no `INSERT`, no
 * `UPDATE` anywhere below.
 *
 * The daily autonomy cap (autonomy.max_autonomous_tasks_per_day) is
 * inherently stateful — a live approval consumes a slot in the order
 * requests actually arrive. History does not record "the order requests
 * would have arrived in" for tasks that were never autonomously attempted,
 * so this backtest orders same-business, same-day candidates by
 * `created_at` (the one ordering signal every task has) and applies the cap
 * sequentially against that order. This is a documented approximation, not
 * a byte-for-byte replay of concurrent request timing — disclosed in
 * `methodology_notes` on every result rather than presented as exact.
 */
import db from '../db/db.js';
import { getActionRegistryEntry } from '../tasks/action-registry.js';
import { getBusinessProfile } from '../business/business-profile.js';
import {
  DEFAULT_OPERATING_POLICY, assertScopeExists, autonomyDecisionForDocument, computeTierUnderPolicy,
  effectiveDailyTaskCap, getActivePolicyVersion, getPolicyPortfolio, getPortfolioForBusiness,
  mergeOverrides, mergePolicyDocument, validatePolicyDocument,
  type ApprovalTier, type OperatingPolicyDocument, type OperatingPolicyPatch, type PolicyScope,
  type PolicyScopeRef, type PolicyViolation, type ResolvedOperatingPolicy,
} from './operating-policy.js';

const MAX_LOOKBACK_DAYS = 90;
const DEFAULT_LOOKBACK_DAYS = 30;

// A task is judged "actually auto-approved" the same way previewPolicyChange
// and the daily-cap query in operating-policy.ts already do:
// approved_by set and not a 'dashboard:' actor.
const AUTO_APPROVED_STATUSES = ['approved', 'executing', 'complete', 'verified', 'failed'] as const;

export type PolicyBacktestOutcome = 'auto_approved' | 'required_human' | 'undetermined';
export type PolicyBacktestTransition = 'now_requires_review' | 'now_auto_approves' | 'unchanged';

export interface PolicyBacktestTaskEvidence {
  task_id: string;
  business_id: string;
  title: string;
  action_type: string | null;
  status: string;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  /** What actually happened to this task, classified the same way the headline counts are. */
  actual_outcome: PolicyBacktestOutcome;
  current_tier: ApprovalTier;
  candidate_tier: ApprovalTier;
  current_would_auto_approve: boolean;
  current_block_code: string | null;
  candidate_would_auto_approve: boolean;
  candidate_block_code: string | null;
  transition: PolicyBacktestTransition;
}

export interface PolicyBacktestBreakdown {
  count: number;
  by_action_type: Record<string, number>;
  by_risk_tier: Record<string, number>;
  task_ids: string[];
}

export interface PolicyBacktestResult {
  scope: PolicyScope;
  key: string;
  business_ids: string[];
  days: number;
  window_start: string;
  window_end: string;
  candidate_valid: boolean;
  candidate_violations: PolicyViolation[];
  tasks_in_window: number;
  empty_window: boolean;
  /** Actually auto-approved, would now require manual review under the candidate. */
  would_now_require_review: PolicyBacktestBreakdown;
  /** Actually required a human, would now auto-approve under the candidate. */
  would_now_auto_approve: PolicyBacktestBreakdown;
  unchanged_auto_approved_count: number;
  unchanged_required_human_count: number;
  /** Tasks with no resolved actual outcome yet (still proposed, rejected, cancelled, deferred...) — shown for completeness, excluded from the headline transition counts because there is no real outcome to compare against. */
  undetermined_count: number;
  evidence: PolicyBacktestTaskEvidence[];
  methodology_notes: string[];
}

export interface PolicyBacktestOptions {
  scope?: PolicyScope;
  key: string;
  patch: OperatingPolicyPatch;
  days?: number;
}

interface TaskRow {
  id: string;
  business_id: string;
  title: string;
  action_type: string | null;
  action_payload: string | null;
  status: string;
  trust_tier: string | null;
  confidence: number | null;
  applicability_status: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function classifyActualOutcome(task: TaskRow): PolicyBacktestOutcome {
  const approvedBy = task.approved_by;
  if (approvedBy && !approvedBy.startsWith('dashboard:') && (AUTO_APPROVED_STATUSES as readonly string[]).includes(task.status)) {
    return 'auto_approved';
  }
  if (task.status === 'manual_review' || (approvedBy && approvedBy.startsWith('dashboard:'))) {
    return 'required_human';
  }
  return 'undetermined';
}

/**
 * The effective document for one business under a candidate override applied
 * AT ref's OWN scope, using exactly the merge primitives resolveOperatingPolicy()
 * uses — portfolio overrides first, business overrides on top — so a business
 * scope backtest never disturbs its portfolio's actual overrides, and a
 * portfolio scope backtest still respects each member business's own
 * overrides layered on top, same as production inheritance.
 */
function candidateDocumentForBusiness(
  businessId: string, ref: PolicyScopeRef, nextOverridesAtScope: OperatingPolicyPatch,
): OperatingPolicyDocument {
  const portfolio = getPortfolioForBusiness(businessId);
  const portfolioVersion = portfolio ? getActivePolicyVersion({ scope: 'portfolio', key: portfolio.id }) : null;
  const businessVersion = getActivePolicyVersion({ scope: 'business', key: businessId });

  const applyAtPortfolio = ref.scope === 'portfolio' && portfolio?.id === ref.key;
  const applyAtBusiness = ref.scope === 'business' && businessId === ref.key;

  const portfolioOverrides = applyAtPortfolio ? nextOverridesAtScope : (portfolioVersion?.overrides ?? {});
  const businessOverrides = applyAtBusiness ? nextOverridesAtScope : (businessVersion?.overrides ?? {});

  let doc = mergePolicyDocument(DEFAULT_OPERATING_POLICY, portfolioOverrides);
  doc = mergePolicyDocument(doc, businessOverrides);
  return doc;
}

function wrapDocumentAsResolvedPolicy(businessId: string, doc: OperatingPolicyDocument, label: string): ResolvedOperatingPolicy {
  return {
    business_id: businessId, document: doc,
    policy_id: null, policy_version: 0, policy_scope: 'system_default',
    business_policy_id: null, business_policy_version: null,
    portfolio_id: null, portfolio_policy_id: null, portfolio_policy_version: null,
    citation: label,
  };
}

interface PreCapDecision {
  allowed: boolean;
  code: string | null;
  tier: ApprovalTier;
}

function evaluatePreCap(doc: OperatingPolicyDocument, task: TaskRow, cite: string): PreCapDecision {
  const payload = safeParseJson<Record<string, unknown>>(task.action_payload, {});
  const tier = computeTierUnderPolicy(doc, {
    actionType: task.action_type, payload,
    baseTier: task.trust_tier, agentConfidence: task.confidence,
    applicabilityStatus: task.applicability_status,
  });
  const registryEntry = task.action_type ? getActionRegistryEntry(task.action_type) : null;
  const decision = autonomyDecisionForDocument(doc, cite, {
    actionType: task.action_type, tier,
    requiredConnectorTypes: registryEntry?.required_connector_types ?? [],
  });
  return { allowed: decision.allowed, code: decision.code, tier };
}

/**
 * Apply the daily autonomous-approval cap sequentially, per business per
 * calendar day (UTC date of created_at), over only the tasks that already
 * passed every other gate. Returns the task ids the cap alone would block.
 */
function applyDailyCap(
  candidates: Array<{ task: TaskRow; preCapAllowed: boolean }>,
  capForBusiness: (businessId: string) => number | null,
): Set<string> {
  const groups = new Map<string, TaskRow[]>();
  for (const c of candidates) {
    if (!c.preCapAllowed) continue;
    const day = c.task.created_at.slice(0, 10);
    const key = `${c.task.business_id}|${day}`;
    const list = groups.get(key) ?? [];
    list.push(c.task);
    groups.set(key, list);
  }
  const capBlocked = new Set<string>();
  for (const [key, list] of groups) {
    const businessId = key.split('|')[0]!;
    const cap = capForBusiness(businessId);
    if (cap == null) continue;
    const ordered = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    ordered.forEach((t, index) => { if (index >= cap) capBlocked.add(t.id); });
  }
  return capBlocked;
}

function emptyBreakdown(): PolicyBacktestBreakdown {
  return { count: 0, by_action_type: {}, by_risk_tier: {}, task_ids: [] };
}

function addToBreakdown(breakdown: PolicyBacktestBreakdown, task: TaskRow, tier: ApprovalTier): void {
  breakdown.count += 1;
  breakdown.task_ids.push(task.id);
  const actionType = task.action_type ?? '(no action_type — manual task)';
  breakdown.by_action_type[actionType] = (breakdown.by_action_type[actionType] ?? 0) + 1;
  breakdown.by_risk_tier[tier] = (breakdown.by_risk_tier[tier] ?? 0) + 1;
}

/**
 * Replay the last `days` of real tasks against the CURRENT active policy and
 * a CANDIDATE patch, using the real approval-gate logic for both, and report
 * where the two would have disagreed. Read-only: no version is written, no
 * task is touched, nothing is activated.
 */
export function backtestPolicyChange(input: PolicyBacktestOptions): PolicyBacktestResult {
  const ref: PolicyScopeRef = { scope: input.scope ?? 'business', key: String(input.key) };
  assertScopeExists(ref);

  const days = Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.round(input.days ?? DEFAULT_LOOKBACK_DAYS)));
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 86400000);

  const businessIds = ref.scope === 'business'
    ? [ref.key]
    : (getPolicyPortfolio(ref.key)?.business_ids ?? []);

  // Validate the candidate exactly the way savePolicyVersion()/previewPolicyChange()
  // do — merged over THIS scope's own current overrides onto DEFAULT, not onto
  // an inherited document, matching what an actual save would reject or accept.
  const currentAtScope = getActivePolicyVersion(ref);
  const nextOverridesAtScope = mergeOverrides(currentAtScope?.overrides ?? {}, input.patch);
  const candidateViolations = validatePolicyDocument(
    mergePolicyDocument(DEFAULT_OPERATING_POLICY, nextOverridesAtScope), input.patch,
  );

  const methodologyNotes: string[] = [
    '"Current" means the policy in force right now, not whatever was actually active on each historical date — this answers "what would today\'s rules have done to this history", not "replay each day under whatever was active that day".',
    'The daily autonomy cap is simulated by ordering same-business, same-day candidates by created_at and applying the cap in that order; this is an approximation of real approval-time ordering, not a replay of actual concurrent request timing.',
  ];

  const result: PolicyBacktestResult = {
    scope: ref.scope, key: ref.key, business_ids: businessIds, days,
    window_start: windowStart.toISOString(), window_end: windowEnd.toISOString(),
    candidate_valid: candidateViolations.length === 0,
    candidate_violations: candidateViolations,
    tasks_in_window: 0,
    empty_window: false,
    would_now_require_review: emptyBreakdown(),
    would_now_auto_approve: emptyBreakdown(),
    unchanged_auto_approved_count: 0,
    unchanged_required_human_count: 0,
    undetermined_count: 0,
    evidence: [],
    methodology_notes: methodologyNotes,
  };

  if (businessIds.length === 0) {
    result.empty_window = true;
    methodologyNotes.push(
      ref.scope === 'portfolio'
        ? `Policy portfolio '${ref.key}' has no member businesses, so there is no history to replay. This is NOT evidence the candidate policy is safe — it means nothing was tested.`
        : `No businesses in scope. This is NOT evidence the candidate policy is safe — it means nothing was tested.`,
    );
    return result;
  }

  const placeholders = businessIds.map(() => '?').join(',');
  const tasks = db.prepare(`
    SELECT id, business_id, title, action_type, action_payload, status, trust_tier, confidence,
           applicability_status, approved_by, approved_at, created_at
      FROM tasks
     WHERE business_id IN (${placeholders}) AND created_at >= ? AND created_at <= ?
     ORDER BY created_at ASC
  `).all(...businessIds, windowStart.toISOString(), windowEnd.toISOString()) as TaskRow[];

  result.tasks_in_window = tasks.length;

  if (tasks.length === 0) {
    result.empty_window = true;
    methodologyNotes.push(
      `No tasks were proposed for ${ref.scope} '${ref.key}' in the last ${days} day(s). ` +
      'An empty window means this backtest has nothing to say about the candidate policy — it is NOT evidence the candidate is safe, only that there is no history to check it against yet.',
    );
    return result;
  }

  // Business-profile automation cap, read once per business — the daily cap
  // must honour the stricter-of-two rule effectiveDailyTaskCap() already
  // encodes, exactly as approveTask() does.
  const profileCapByBusiness = new Map<string, number | null>();
  for (const businessId of businessIds) {
    const profile = getBusinessProfile(businessId);
    profileCapByBusiness.set(businessId, profile?.automation_policy?.max_autonomous_tasks_per_day ?? null);
  }

  // "Current" and "candidate" are both computed by the SAME merge helper —
  // candidateDocumentForBusiness() — differing only in which override value
  // is substituted at ref's scope: the unpatched current override for
  // "current" (equivalent to what resolveOperatingPolicy() would return
  // right now) versus the patched one for "candidate". One code path, two
  // inputs, so they can never silently diverge in how inheritance is applied.
  const currentDocByBusiness = new Map<string, OperatingPolicyDocument>();
  const candidateDocByBusiness = new Map<string, OperatingPolicyDocument>();
  for (const businessId of businessIds) {
    currentDocByBusiness.set(businessId, candidateDocumentForBusiness(businessId, ref, currentAtScope?.overrides ?? {}));
    candidateDocByBusiness.set(businessId, candidateDocumentForBusiness(businessId, ref, nextOverridesAtScope));
  }

  const currentPreCap = new Map<string, PreCapDecision>();
  const candidatePreCap = new Map<string, PreCapDecision>();
  for (const task of tasks) {
    const currentDoc = currentDocByBusiness.get(task.business_id)!;
    const candidateDoc = candidateDocByBusiness.get(task.business_id)!;
    currentPreCap.set(task.id, evaluatePreCap(currentDoc, task, '(backtest: current policy)'));
    candidatePreCap.set(task.id, evaluatePreCap(candidateDoc, task, '(backtest: candidate policy)'));
  }

  const currentCapBlocked = applyDailyCap(
    tasks.map((task) => ({ task, preCapAllowed: currentPreCap.get(task.id)!.allowed })),
    (businessId) => effectiveDailyTaskCap(
      wrapDocumentAsResolvedPolicy(businessId, currentDocByBusiness.get(businessId)!, 'backtest current'),
      profileCapByBusiness.get(businessId) ?? null,
    ).cap,
  );
  const candidateCapBlocked = applyDailyCap(
    tasks.map((task) => ({ task, preCapAllowed: candidatePreCap.get(task.id)!.allowed })),
    (businessId) => effectiveDailyTaskCap(
      wrapDocumentAsResolvedPolicy(businessId, candidateDocByBusiness.get(businessId)!, 'backtest candidate'),
      profileCapByBusiness.get(businessId) ?? null,
    ).cap,
  );

  for (const task of tasks) {
    const actualOutcome = classifyActualOutcome(task);
    const current = currentPreCap.get(task.id)!;
    const candidate = candidatePreCap.get(task.id)!;
    const currentAllowed = current.allowed && !currentCapBlocked.has(task.id);
    const candidateAllowed = candidate.allowed && !candidateCapBlocked.has(task.id);
    const currentCode = !current.allowed ? current.code : currentCapBlocked.has(task.id) ? 'daily_autonomy_cap_reached' : null;
    const candidateCode = !candidate.allowed ? candidate.code : candidateCapBlocked.has(task.id) ? 'daily_autonomy_cap_reached' : null;

    let transition: PolicyBacktestTransition = 'unchanged';
    if (actualOutcome === 'auto_approved' && !candidateAllowed) transition = 'now_requires_review';
    else if (actualOutcome === 'required_human' && candidateAllowed) transition = 'now_auto_approves';

    const evidence: PolicyBacktestTaskEvidence = {
      task_id: task.id, business_id: task.business_id, title: task.title,
      action_type: task.action_type, status: task.status,
      created_at: task.created_at, approved_at: task.approved_at, approved_by: task.approved_by,
      actual_outcome: actualOutcome,
      current_tier: current.tier, candidate_tier: candidate.tier,
      current_would_auto_approve: currentAllowed, current_block_code: currentCode,
      candidate_would_auto_approve: candidateAllowed, candidate_block_code: candidateCode,
      transition,
    };
    result.evidence.push(evidence);

    if (actualOutcome === 'undetermined') {
      result.undetermined_count += 1;
      continue;
    }
    if (transition === 'now_requires_review') addToBreakdown(result.would_now_require_review, task, candidate.tier);
    else if (transition === 'now_auto_approves') addToBreakdown(result.would_now_auto_approve, task, candidate.tier);
    else if (actualOutcome === 'auto_approved') result.unchanged_auto_approved_count += 1;
    else result.unchanged_required_human_count += 1;
  }

  return result;
}
