/**
 * Per-business Operating Policy (#68).
 *
 * The durable governance layer for "how does THIS business want to be
 * operated": risk thresholds, who must approve what, autonomy limits,
 * priority weighting and connector applicability. Global settings and ad
 * hoc prompts cannot express those differences safely — a £50 price change
 * is routine for one business and a board-level decision for another.
 *
 * Design follows server/agents/hiring/policy.ts (#57) for shape — a typed,
 * business-scoped policy document read by the services that make decisions,
 * with defaults filled in — and extends it with the durability this issue
 * needs and the hiring control plane does not have:
 *
 *   - versioning:   every save writes a NEW row; nothing is ever mutated in
 *                   place and nothing is ever deleted.
 *   - effective_at: a version may be scheduled to take effect in the future.
 *                   Activation is lazy (on the next resolve) so it needs no
 *                   scheduler wiring and can never be "missed".
 *   - inheritance:  system defaults <- portfolio policy <- business policy.
 *                   A business belongs to at most ONE policy portfolio, so
 *                   inheritance is never ambiguous (enforced on write).
 *   - audit:        operating_policy_events records who changed which fields
 *                   from what to what, when and why — including rejected
 *                   edits, so a blocked unsafe change leaves a trace.
 *   - rollback:     re-activating version N writes it forward as a new
 *                   version rather than rewinding the sequence.
 *
 * Cross-business isolation is structural: every query is keyed on
 * (scope, scope_key) and there is no code path that reads a policy without
 * one. Portfolio scope is opt-in and explicit — a policy never silently
 * spans businesses.
 *
 * ─── Integration status ─────────────────────────────────────────────────────
 *
 * WIRED (the policy genuinely decides, and the decision cites the version):
 *   1. tasks/task-queue.ts approveTask() — the autonomy gate: master switch,
 *      dry-run, always-require-human action types, the auto-approval tier
 *      ceiling, connector applicability, and the daily cap (taking the
 *      stricter of this policy and the pre-#68 business-profile setting).
 *      This is the single most consequential gate in the system.
 *   2. trust/trust-engine.ts calculateApprovalTier() — risk thresholds are
 *      read from the effective policy instead of hardcoded constants, and
 *      the resulting evidence (persisted on tasks.approval_risk_evidence)
 *      names the policy version that produced the tier.
 *   3. brain/decision-memory.ts recordDecision() — EVERY decision row now
 *      carries effective_policy_id / _version / _scope, resolved centrally
 *      so no call site can forget. Task approval passes the version its own
 *      gating actually used rather than re-resolving.
 *
 * DEFERRED (deliberately, to keep this change reviewable):
 *   - tasks/executor.ts and execution-worker.ts do not yet consult
 *     connectors.max_data_age_hours or autonomy.max_autonomous_spend_gbp_per_day
 *     at execution time; both are stored, validated and previewable but
 *     only advisory until the executor reads them.
 *   - priorities.objective_weights and priorities.max_open_tasks are stored
 *     and validated but not yet read by the ranking/WIP logic in
 *     brain/recommendation-engine.ts.
 *   - approvals.second_reviewer_at_or_above is stored and validated but no
 *     two-person approval flow exists to enforce it yet.
 *   - agents/hiring/policy.ts (#57) keeps its own control plane; folding it
 *     into this document is a separate migration, not a drive-by rewrite.
 */

import db, { audit, generateId } from '../db/db.js';
import { allowSimulationWrite } from '../simulation/simulation-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ApprovalTier = 'green' | 'yellow' | 'orange' | 'red';
/** 'none' means "no tier qualifies" — used by ceiling-style fields. */
export type TierCeiling = ApprovalTier | 'none';

export const TIER_ORDER: readonly ApprovalTier[] = ['green', 'yellow', 'orange', 'red'];

/** -1 for 'none', so a 'none' ceiling is below every real tier. */
export function tierRank(tier: TierCeiling | null | undefined): number {
  if (tier == null || tier === 'none') return -1;
  return TIER_ORDER.indexOf(tier);
}

export interface OperatingPolicyThresholds {
  /**
   * Financial exposure (GBP) at or above which an action is escalated to
   * the 'orange' review tier. "At or above" (>=), matching the operator
   * that has always been used in calculateApprovalTier().
   */
  financial_exposure_review_gbp: number;
  /** Financial exposure (GBP) at or above which an action becomes 'red'. */
  financial_exposure_block_gbp: number;
  /** Record count ABOVE which (>) an action is escalated to 'orange'. */
  affected_records_review: number;
  /** Record count ABOVE which (>) an action becomes 'red'. */
  affected_records_block: number;
  /** Agent confidence below which an action is escalated to 'orange'. 0..1. */
  min_agent_confidence: number;
}

export interface OperatingPolicyApprovals {
  /**
   * Highest tier that may be approved without a human.
   *   null   — not enforced by policy (the default; approval mode and the
   *            executor's own gates decide, exactly as they did before #68).
   *   'none' — nothing may be approved without a human.
   *   a tier — that tier and below may be auto-approved.
   * Defaulting to null rather than a real tier is deliberate: switching on
   * a hard approval ceiling for every existing business the day this
   * feature ships would be a silent behaviour change, not governance.
   */
  auto_approve_max_tier: TierCeiling | null;
  /** Lowest tier that always needs an explicit human approval. */
  require_human_approval_at_or_above: ApprovalTier;
  /** Lowest tier needing a second reviewer. 'none' = never. */
  second_reviewer_at_or_above: TierCeiling;
  /** Action types that always need a human, whatever tier they compute to. */
  always_require_human_action_types: string[];
}

export interface OperatingPolicyAutonomy {
  /** Master switch. false = nothing is approved without a human, ever. */
  allow_autonomous_execution: boolean;
  /** Evaluate and record, but take no autonomous action. */
  dry_run: boolean;
  /** Cap on non-human approvals per calendar day. null = uncapped. */
  max_autonomous_tasks_per_day: number | null;
  /** Cap on autonomously-committed spend per calendar day. null = uncapped. */
  max_autonomous_spend_gbp_per_day: number | null;
}

export interface OperatingPolicyPriorities {
  /** Named objectives and their relative weight. Must sum to 1 when set. */
  objective_weights: Record<string, number>;
  /** WIP cap on simultaneously open tasks. null = uncapped. */
  max_open_tasks: number | null;
}

export interface OperatingPolicyConnectors {
  /** Connector types this business may act through. [] = no restriction. */
  allowed_connector_types: string[];
  /** Connector types this business must never act through. */
  blocked_connector_types: string[];
  /** Connector types that must be present for autonomous action. */
  required_connector_types: string[];
  /** Connector data older than this is too stale to act on. */
  max_data_age_hours: number;
}

export interface OperatingPolicyDocument {
  thresholds: OperatingPolicyThresholds;
  approvals: OperatingPolicyApprovals;
  autonomy: OperatingPolicyAutonomy;
  priorities: OperatingPolicyPriorities;
  connectors: OperatingPolicyConnectors;
  /**
   * Validation codes an operator has explicitly accepted. Only codes marked
   * waivable can be listed here; an unsafe combination that is never
   * waivable stays rejected no matter what appears in this array.
   */
  acknowledged_risks: string[];
  /** Free text explaining the operating stance, surfaced in the editor. */
  notes: string | null;
}

export const DEFAULT_OPERATING_POLICY: OperatingPolicyDocument = {
  thresholds: {
    financial_exposure_review_gbp: 100,
    financial_exposure_block_gbp: 500,
    affected_records_review: 100,
    affected_records_block: 1000,
    min_agent_confidence: 0.55,
  },
  approvals: {
    auto_approve_max_tier: null,
    require_human_approval_at_or_above: 'yellow',
    second_reviewer_at_or_above: 'none',
    always_require_human_action_types: [],
  },
  autonomy: {
    allow_autonomous_execution: true,
    dry_run: false,
    max_autonomous_tasks_per_day: null,
    max_autonomous_spend_gbp_per_day: null,
  },
  priorities: {
    objective_weights: {},
    max_open_tasks: null,
  },
  connectors: {
    allowed_connector_types: [],
    blocked_connector_types: [],
    required_connector_types: [],
    max_data_age_hours: 72,
  },
  acknowledged_risks: [],
  notes: null,
};

export type PolicyScope = 'business' | 'portfolio';
export type PolicyState = 'scheduled' | 'active' | 'superseded';

export interface OperatingPolicyVersion {
  id: string;
  scope: PolicyScope;
  scope_key: string;
  business_id: string | null;
  portfolio_id: string | null;
  version: number;
  state: PolicyState;
  /**
   * The resolved document AT THIS SCOPE: system defaults with this scope's
   * overrides applied. Stored (rather than derived on read) so that "what
   * did the policy say in March" is answerable even after the defaults
   * themselves change.
   */
  document: OperatingPolicyDocument;
  /**
   * ONLY the fields explicitly set at this scope. This is what inheritance
   * merges — a business that never set `priorities.max_open_tasks` must
   * keep inheriting its portfolio's value, which is impossible if the
   * business version is treated as a full document.
   */
  overrides: OperatingPolicyPatch;
  effective_at: string;
  activated_at: string | null;
  superseded_at: string | null;
  superseded_by_id: string | null;
  source: 'edit' | 'rollback' | 'seed';
  rolled_back_from_version: number | null;
  change_reason: string | null;
  created_by: string;
  created_at: string;
}

export interface PolicyViolation {
  code: string;
  field: string;
  message: string;
  /** true when the operator can accept it via acknowledged_risks. */
  waivable: boolean;
}

export class PolicyValidationError extends Error {
  readonly violations: PolicyViolation[];
  constructor(violations: PolicyViolation[]) {
    super(
      `Policy rejected — ${violations.length} problem(s): ` +
      violations.map((v) => `[${v.code}] ${v.message}`).join(' '),
    );
    this.name = 'PolicyValidationError';
    this.violations = violations;
  }
}

// ─── Parsing / merging ───────────────────────────────────────────────────────

const SECTION_KEYS = ['thresholds', 'approvals', 'autonomy', 'priorities', 'connectors'] as const;
const TOP_LEVEL_KEYS: readonly string[] = [...SECTION_KEYS, 'acknowledged_risks', 'notes'];

/** A partial edit: any subset of sections, any subset of fields within them. */
export interface OperatingPolicyPatch {
  thresholds?: Partial<OperatingPolicyThresholds>;
  approvals?: Partial<OperatingPolicyApprovals>;
  autonomy?: Partial<OperatingPolicyAutonomy>;
  priorities?: Partial<OperatingPolicyPriorities>;
  connectors?: Partial<OperatingPolicyConnectors>;
  acknowledged_risks?: string[];
  notes?: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge a patch over a base document. Sections merge field-by-field;
 * arrays and scalars replace wholesale (there is no sane "merge" for
 * blocked_connector_types — an operator removing an entry must see it go).
 */
export function mergePolicyDocument(
  base: OperatingPolicyDocument,
  patch: OperatingPolicyPatch | null | undefined,
): OperatingPolicyDocument {
  const next: OperatingPolicyDocument = {
    thresholds: { ...base.thresholds },
    approvals: { ...base.approvals, always_require_human_action_types: [...base.approvals.always_require_human_action_types] },
    autonomy: { ...base.autonomy },
    priorities: { ...base.priorities, objective_weights: { ...base.priorities.objective_weights } },
    connectors: {
      allowed_connector_types: [...base.connectors.allowed_connector_types],
      blocked_connector_types: [...base.connectors.blocked_connector_types],
      required_connector_types: [...base.connectors.required_connector_types],
      max_data_age_hours: base.connectors.max_data_age_hours,
    },
    acknowledged_risks: [...base.acknowledged_risks],
    notes: base.notes,
  };
  if (!isPlainObject(patch)) return next;

  for (const section of SECTION_KEYS) {
    const sectionPatch = (patch as Record<string, unknown>)[section];
    if (sectionPatch === undefined) continue;
    if (!isPlainObject(sectionPatch)) continue; // shape errors are reported by validation
    Object.assign(next[section] as unknown as Record<string, unknown>, sectionPatch);
  }
  if (patch.acknowledged_risks !== undefined) {
    next.acknowledged_risks = patch.acknowledged_risks as string[];
  }
  if (patch.notes !== undefined) {
    next.notes = patch.notes as string | null;
  }
  return next;
}

/**
 * Sparse merge of one patch over another, producing a patch — not a full
 * document. Used to accumulate a scope's overrides across successive edits
 * so that fields the operator never touched stay absent, and therefore
 * stay inherited.
 */
export function mergeOverrides(
  base: OperatingPolicyPatch,
  patch: OperatingPolicyPatch | null | undefined,
): OperatingPolicyPatch {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base ?? {})) {
    next[k] = isPlainObject(v) ? { ...v } : v;
  }
  if (!isPlainObject(patch)) return next as OperatingPolicyPatch;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(next[k])) {
      next[k] = { ...(next[k] as Record<string, unknown>), ...v };
    } else {
      next[k] = isPlainObject(v) ? { ...v } : v;
    }
  }
  return next as OperatingPolicyPatch;
}

function parsePatch(raw: unknown): OperatingPolicyPatch {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  }
  return isPlainObject(parsed) ? parsed as OperatingPolicyPatch : {};
}

function parseDocument(raw: unknown): OperatingPolicyDocument {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  }
  return mergePolicyDocument(DEFAULT_OPERATING_POLICY, isPlainObject(parsed) ? parsed as OperatingPolicyPatch : {});
}

function parseVersionRow(row: Record<string, unknown> | null | undefined): OperatingPolicyVersion | null {
  if (!row) return null;
  return {
    id: String(row.id),
    scope: String(row.scope) as PolicyScope,
    scope_key: String(row.scope_key),
    business_id: row.business_id == null ? null : String(row.business_id),
    portfolio_id: row.portfolio_id == null ? null : String(row.portfolio_id),
    version: Number(row.version),
    state: String(row.state) as PolicyState,
    document: parseDocument(row.document),
    overrides: parsePatch(row.overrides),
    effective_at: String(row.effective_at),
    activated_at: row.activated_at == null ? null : String(row.activated_at),
    superseded_at: row.superseded_at == null ? null : String(row.superseded_at),
    superseded_by_id: row.superseded_by_id == null ? null : String(row.superseded_by_id),
    source: String(row.source ?? 'edit') as OperatingPolicyVersion['source'],
    rolled_back_from_version: row.rolled_back_from_version == null ? null : Number(row.rolled_back_from_version),
    change_reason: row.change_reason == null ? null : String(row.change_reason),
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateNonNegativeNumber(
  out: PolicyViolation[], section: string, key: string, value: unknown,
): boolean {
  const field = `${section}.${key}`;
  if (!isFiniteNumber(value)) {
    out.push({
      code: 'field_not_a_number', field, waivable: false,
      message: `${field} must be a finite number, but got ${JSON.stringify(value)}. Enter a numeric value.`,
    });
    return false;
  }
  if (value < 0) {
    out.push({
      code: 'threshold_negative', field, waivable: false,
      message: `${field} must be zero or greater, but is ${value}. A negative threshold can never be crossed, so the rule it guards would never fire.`,
    });
    return false;
  }
  return true;
}

function knownActionTypes(): Set<string> | null {
  try {
    const rows = db.prepare('SELECT action_type FROM action_registry').all() as Array<{ action_type: string }>;
    if (rows.length === 0) return null; // registry not seeded — do not invent errors
    return new Set(rows.map((r) => r.action_type));
  } catch {
    return null;
  }
}

/**
 * Reject invalid, conflicting and unsafe policy documents with a specific,
 * actionable message per problem — never a bare "invalid policy".
 *
 * Three families of problem, all reported together so an operator fixes
 * them in one pass rather than one round-trip per mistake:
 *   invalid    — a field is the wrong type, negative, or out of range.
 *   conflicting— two fields are individually fine but contradict each other
 *                (e.g. a tier that is both auto-approvable and human-gated).
 *   unsafe     — the combination is legal but dangerous given this
 *                codebase's risk-tier conventions (red = irreversible /
 *                customer-facing / financial). Some are waivable by naming
 *                the code in acknowledged_risks; the worst are not.
 */
export function validatePolicyDocument(
  doc: OperatingPolicyDocument,
  rawPatch?: unknown,
): PolicyViolation[] {
  const out: PolicyViolation[] = [];

  // ── Unknown fields ────────────────────────────────────────────────────────
  if (isPlainObject(rawPatch)) {
    for (const key of Object.keys(rawPatch)) {
      if (!TOP_LEVEL_KEYS.includes(key)) {
        out.push({
          code: 'unknown_field', field: key, waivable: false,
          message: `'${key}' is not a policy field. Valid sections are: ${TOP_LEVEL_KEYS.join(', ')}.`,
        });
      }
    }
    for (const section of SECTION_KEYS) {
      const patchSection = (rawPatch as Record<string, unknown>)[section];
      if (patchSection === undefined) continue;
      if (!isPlainObject(patchSection)) {
        out.push({
          code: 'section_not_an_object', field: section, waivable: false,
          message: `'${section}' must be an object of policy fields, but got ${Array.isArray(patchSection) ? 'an array' : typeof patchSection}.`,
        });
        continue;
      }
      const valid = Object.keys(DEFAULT_OPERATING_POLICY[section] as unknown as Record<string, unknown>);
      for (const key of Object.keys(patchSection)) {
        if (!valid.includes(key)) {
          out.push({
            code: 'unknown_field', field: `${section}.${key}`, waivable: false,
            message: `'${section}.${key}' is not a policy field. Valid fields in '${section}' are: ${valid.join(', ')}.`,
          });
        }
      }
    }
  }

  // ── Thresholds: individually valid ────────────────────────────────────────
  const t = doc.thresholds;
  const reviewGbpOk = validateNonNegativeNumber(out, 'thresholds', 'financial_exposure_review_gbp', t.financial_exposure_review_gbp);
  const blockGbpOk = validateNonNegativeNumber(out, 'thresholds', 'financial_exposure_block_gbp', t.financial_exposure_block_gbp);
  const reviewRecOk = validateNonNegativeNumber(out, 'thresholds', 'affected_records_review', t.affected_records_review);
  const blockRecOk = validateNonNegativeNumber(out, 'thresholds', 'affected_records_block', t.affected_records_block);

  if (!isFiniteNumber(t.min_agent_confidence) || t.min_agent_confidence < 0 || t.min_agent_confidence > 1) {
    out.push({
      code: 'confidence_out_of_range', field: 'thresholds.min_agent_confidence', waivable: false,
      message: `thresholds.min_agent_confidence must be between 0 and 1 inclusive, but is ${JSON.stringify(t.min_agent_confidence)}. Agent confidence is a probability, not a percentage — use 0.55, not 55.`,
    });
  }

  // ── Thresholds: ordering conflicts ────────────────────────────────────────
  if (reviewGbpOk && blockGbpOk && t.financial_exposure_review_gbp >= t.financial_exposure_block_gbp) {
    out.push({
      code: 'threshold_order_conflict', field: 'thresholds.financial_exposure_review_gbp', waivable: false,
      message: `thresholds.financial_exposure_review_gbp (${t.financial_exposure_review_gbp}) must be strictly below thresholds.financial_exposure_block_gbp (${t.financial_exposure_block_gbp}). As written, every action expensive enough to need review is already blocked, so the review tier can never be reached — lower the review threshold or raise the block threshold.`,
    });
  }
  if (reviewRecOk && blockRecOk && t.affected_records_review >= t.affected_records_block) {
    out.push({
      code: 'threshold_order_conflict', field: 'thresholds.affected_records_review', waivable: false,
      message: `thresholds.affected_records_review (${t.affected_records_review}) must be strictly below thresholds.affected_records_block (${t.affected_records_block}). As written, no action is ever merely reviewed for scope — lower the review threshold or raise the block threshold.`,
    });
  }

  // ── Approvals: tier values ────────────────────────────────────────────────
  const a = doc.approvals;
  const checkTier = (key: keyof OperatingPolicyApprovals, value: unknown, allowNone: boolean, allowNull = false): boolean => {
    if (allowNull && value === null) return true;
    const allowed = allowNone ? [...TIER_ORDER, 'none'] : [...TIER_ORDER];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      out.push({
        code: 'tier_invalid', field: `approvals.${String(key)}`, waivable: false,
        message: `approvals.${String(key)} must be one of ${allowed.map((x) => `'${x}'`).join(', ')}${allowNull ? ' or null (not enforced)' : ''}, but is ${JSON.stringify(value)}.`,
      });
      return false;
    }
    return true;
  };
  // `enforcesCeiling` distinguishes "the operator set a ceiling" from
  // "no ceiling is enforced" — only the former can contradict anything.
  const autoOk = checkTier('auto_approve_max_tier', a.auto_approve_max_tier, true, true);
  const enforcesCeiling = autoOk && a.auto_approve_max_tier !== null;
  const humanOk = checkTier('require_human_approval_at_or_above', a.require_human_approval_at_or_above, false);
  const secondOk = checkTier('second_reviewer_at_or_above', a.second_reviewer_at_or_above, true);

  if (!Array.isArray(a.always_require_human_action_types)) {
    out.push({
      code: 'field_not_an_array', field: 'approvals.always_require_human_action_types', waivable: false,
      message: 'approvals.always_require_human_action_types must be an array of action_type strings.',
    });
  } else {
    const registry = knownActionTypes();
    for (const at of a.always_require_human_action_types) {
      if (typeof at !== 'string' || at.trim() === '') {
        out.push({
          code: 'action_type_invalid', field: 'approvals.always_require_human_action_types', waivable: false,
          message: `approvals.always_require_human_action_types contains ${JSON.stringify(at)}, which is not a non-empty action_type string.`,
        });
      } else if (registry && !registry.has(at)) {
        out.push({
          code: 'unknown_action_type', field: 'approvals.always_require_human_action_types', waivable: false,
          message: `approvals.always_require_human_action_types names '${at}', which is not registered in the Typed Action Registry. A rule about an action type that cannot be proposed would silently never apply — register the action type first, or remove it from this list.`,
        });
      }
    }
  }

  // ── Approvals vs approvals: contradiction ─────────────────────────────────
  if (enforcesCeiling && humanOk && tierRank(a.auto_approve_max_tier) >= tierRank(a.require_human_approval_at_or_above)) {
    out.push({
      code: 'approval_contradiction', field: 'approvals.auto_approve_max_tier', waivable: false,
      message: `approvals.auto_approve_max_tier ('${a.auto_approve_max_tier}') is at or above approvals.require_human_approval_at_or_above ('${a.require_human_approval_at_or_above}'), so tier '${a.require_human_approval_at_or_above}' would be both auto-approvable and human-gated. Set auto_approve_max_tier to a tier strictly below '${a.require_human_approval_at_or_above}' (or to 'none').`,
    });
  }
  if (enforcesCeiling && secondOk && a.second_reviewer_at_or_above !== 'none' &&
      tierRank(a.second_reviewer_at_or_above) <= tierRank(a.auto_approve_max_tier)) {
    out.push({
      code: 'approval_contradiction', field: 'approvals.second_reviewer_at_or_above', waivable: false,
      message: `approvals.second_reviewer_at_or_above ('${a.second_reviewer_at_or_above}') is at or below approvals.auto_approve_max_tier ('${a.auto_approve_max_tier}'), so a tier requiring two human reviewers would also qualify for approval with none. Raise second_reviewer_at_or_above above '${a.auto_approve_max_tier}'.`,
    });
  }

  // ── Approvals: unsafe ceilings ────────────────────────────────────────────
  // 'red' is this codebase's tier for irreversible, customer-facing,
  // financial or destructive actions (see trust-engine.calculateApprovalTier:
  // publish, merge, price, payment, delete, budget). Auto-approving it is
  // never acceptable and is deliberately NOT waivable.
  if (enforcesCeiling && a.auto_approve_max_tier === 'red') {
    out.push({
      code: 'unsafe_auto_approve_red', field: 'approvals.auto_approve_max_tier', waivable: false,
      message: "approvals.auto_approve_max_tier cannot be 'red'. Red is reserved for irreversible, customer-facing, financial or destructive actions (publishing, merging, price and inventory changes, payments, deletions) — those always require a human. The highest auto-approvable tier is 'orange', and that itself must be acknowledged.",
    });
  }
  if (enforcesCeiling && a.auto_approve_max_tier === 'orange' && !doc.acknowledged_risks.includes('unsafe_auto_approve_orange')) {
    out.push({
      code: 'unsafe_auto_approve_orange', field: 'approvals.auto_approve_max_tier', waivable: true,
      message: "approvals.auto_approve_max_tier is 'orange', which auto-approves actions flagged for review (large scope, material financial exposure, or low agent confidence). If that is intended, add 'unsafe_auto_approve_orange' to acknowledged_risks to record that an operator accepted it.",
    });
  }

  // ── Autonomy ──────────────────────────────────────────────────────────────
  const au = doc.autonomy;
  if (typeof au.allow_autonomous_execution !== 'boolean') {
    out.push({
      code: 'field_not_a_boolean', field: 'autonomy.allow_autonomous_execution', waivable: false,
      message: `autonomy.allow_autonomous_execution must be true or false, but is ${JSON.stringify(au.allow_autonomous_execution)}.`,
    });
  }
  if (typeof au.dry_run !== 'boolean') {
    out.push({
      code: 'field_not_a_boolean', field: 'autonomy.dry_run', waivable: false,
      message: `autonomy.dry_run must be true or false, but is ${JSON.stringify(au.dry_run)}.`,
    });
  }
  const checkCap = (key: 'max_autonomous_tasks_per_day' | 'max_autonomous_spend_gbp_per_day'): boolean => {
    const value = au[key];
    if (value === null) return true;
    if (!isFiniteNumber(value)) {
      out.push({
        code: 'field_not_a_number', field: `autonomy.${key}`, waivable: false,
        message: `autonomy.${key} must be a number or null (meaning uncapped), but is ${JSON.stringify(value)}.`,
      });
      return false;
    }
    if (value < 0) {
      out.push({
        code: 'autonomy_limit_negative', field: `autonomy.${key}`, waivable: false,
        message: `autonomy.${key} must be zero or greater, but is ${value}. Use null for "uncapped" and 0 with autonomy.allow_autonomous_execution=false to stop autonomous work entirely.`,
      });
      return false;
    }
    return true;
  };
  const taskCapOk = checkCap('max_autonomous_tasks_per_day');
  checkCap('max_autonomous_spend_gbp_per_day');

  if (taskCapOk && au.allow_autonomous_execution === true && au.max_autonomous_tasks_per_day === 0) {
    out.push({
      code: 'autonomy_contradiction', field: 'autonomy.max_autonomous_tasks_per_day', waivable: false,
      message: 'autonomy.max_autonomous_tasks_per_day is 0 while autonomy.allow_autonomous_execution is true — autonomy is nominally on but nothing can ever be approved by it. Either set allow_autonomous_execution to false (the honest way to switch autonomy off) or raise the cap to at least 1.',
    });
  }
  if (au.allow_autonomous_execution === false && enforcesCeiling && a.auto_approve_max_tier !== 'none') {
    out.push({
      code: 'autonomy_contradiction', field: 'autonomy.allow_autonomous_execution', waivable: false,
      message: `autonomy.allow_autonomous_execution is false but approvals.auto_approve_max_tier is '${a.auto_approve_max_tier}', which claims tier '${a.auto_approve_max_tier}' may be approved without a human. Set approvals.auto_approve_max_tier to 'none' to match, or re-enable autonomous execution.`,
    });
  }

  // ── Priorities ────────────────────────────────────────────────────────────
  const p = doc.priorities;
  if (!isPlainObject(p.objective_weights)) {
    out.push({
      code: 'field_not_an_object', field: 'priorities.objective_weights', waivable: false,
      message: 'priorities.objective_weights must be an object mapping objective names to weights, e.g. { "revenue": 0.6, "risk_reduction": 0.4 }.',
    });
  } else {
    const entries = Object.entries(p.objective_weights);
    let weightsValid = true;
    for (const [name, weight] of entries) {
      if (!isFiniteNumber(weight) || weight < 0 || weight > 1) {
        weightsValid = false;
        out.push({
          code: 'weight_out_of_range', field: `priorities.objective_weights.${name}`, waivable: false,
          message: `priorities.objective_weights.${name} must be between 0 and 1 inclusive, but is ${JSON.stringify(weight)}. Weights are relative shares, not percentages.`,
        });
      }
    }
    if (weightsValid && entries.length > 0) {
      const sum = entries.reduce((s, [, w]) => s + Number(w), 0);
      if (Math.abs(sum - 1) > 0.01) {
        out.push({
          code: 'weights_sum_invalid', field: 'priorities.objective_weights', waivable: false,
          message: `priorities.objective_weights must sum to 1.0 (±0.01) when any weight is set, but ${entries.length} weight(s) sum to ${sum.toFixed(3)}. Rebalance them, or clear the object to fall back to default ranking.`,
        });
      }
    }
  }
  if (p.max_open_tasks !== null) {
    if (!isFiniteNumber(p.max_open_tasks) || !Number.isInteger(p.max_open_tasks) || p.max_open_tasks < 1) {
      out.push({
        code: 'max_open_tasks_invalid', field: 'priorities.max_open_tasks', waivable: false,
        message: `priorities.max_open_tasks must be a whole number of 1 or more, or null for uncapped, but is ${JSON.stringify(p.max_open_tasks)}. A cap of 0 would leave the business unable to hold any open work.`,
      });
    }
  }

  // ── Connectors ────────────────────────────────────────────────────────────
  const c = doc.connectors;
  const listOk = (key: keyof OperatingPolicyConnectors): boolean => {
    const value = c[key];
    if (!Array.isArray(value) || value.some((x) => typeof x !== 'string' || x.trim() === '')) {
      out.push({
        code: 'field_not_an_array', field: `connectors.${String(key)}`, waivable: false,
        message: `connectors.${String(key)} must be an array of connector type strings (e.g. ["shopify", "stripe"]).`,
      });
      return false;
    }
    return true;
  };
  const allowedOk = listOk('allowed_connector_types');
  const blockedOk = listOk('blocked_connector_types');
  const requiredOk = listOk('required_connector_types');

  if (allowedOk && blockedOk) {
    const both = c.allowed_connector_types.filter((x) => c.blocked_connector_types.includes(x));
    if (both.length > 0) {
      out.push({
        code: 'connector_allow_block_conflict', field: 'connectors.blocked_connector_types', waivable: false,
        message: `Connector type(s) ${both.map((x) => `'${x}'`).join(', ')} appear in both connectors.allowed_connector_types and connectors.blocked_connector_types. A connector cannot be simultaneously permitted and forbidden — remove each one from whichever list is wrong.`,
      });
    }
  }
  if (requiredOk && blockedOk) {
    const blockedRequired = c.required_connector_types.filter((x) => c.blocked_connector_types.includes(x));
    if (blockedRequired.length > 0) {
      out.push({
        code: 'connector_required_blocked', field: 'connectors.required_connector_types', waivable: false,
        message: `Connector type(s) ${blockedRequired.map((x) => `'${x}'`).join(', ')} are required for autonomous action but are also blocked, so autonomous action could never proceed. Remove them from connectors.blocked_connector_types or from connectors.required_connector_types.`,
      });
    }
  }
  if (requiredOk && allowedOk && c.allowed_connector_types.length > 0) {
    const notAllowed = c.required_connector_types.filter((x) => !c.allowed_connector_types.includes(x));
    if (notAllowed.length > 0) {
      out.push({
        code: 'connector_required_not_allowed', field: 'connectors.required_connector_types', waivable: false,
        message: `Connector type(s) ${notAllowed.map((x) => `'${x}'`).join(', ')} are required but missing from connectors.allowed_connector_types, which is restricted to ${c.allowed_connector_types.map((x) => `'${x}'`).join(', ')}. Add them to the allowed list or drop the requirement.`,
      });
    }
  }
  if (!isFiniteNumber(c.max_data_age_hours) || c.max_data_age_hours <= 0) {
    out.push({
      code: 'data_age_invalid', field: 'connectors.max_data_age_hours', waivable: false,
      message: `connectors.max_data_age_hours must be greater than 0, but is ${JSON.stringify(c.max_data_age_hours)}. A window of 0 or less makes every observation stale, blocking all connector-driven work.`,
    });
  } else if (c.max_data_age_hours > 336 && au.allow_autonomous_execution === true &&
             !doc.acknowledged_risks.includes('unsafe_stale_data_window')) {
    out.push({
      code: 'unsafe_stale_data_window', field: 'connectors.max_data_age_hours', waivable: true,
      message: `connectors.max_data_age_hours is ${c.max_data_age_hours} (over two weeks) while autonomous execution is enabled, so agents may act on evidence that is a fortnight out of date. Lower it to 336 or less, or add 'unsafe_stale_data_window' to acknowledged_risks.`,
    });
  }

  // ── acknowledged_risks hygiene ────────────────────────────────────────────
  if (!Array.isArray(doc.acknowledged_risks)) {
    out.push({
      code: 'field_not_an_array', field: 'acknowledged_risks', waivable: false,
      message: 'acknowledged_risks must be an array of validation codes an operator has accepted.',
    });
  } else {
    const WAIVABLE_CODES = ['unsafe_auto_approve_orange', 'unsafe_stale_data_window'];
    for (const code of doc.acknowledged_risks) {
      if (!WAIVABLE_CODES.includes(String(code))) {
        out.push({
          code: 'unknown_acknowledged_risk', field: 'acknowledged_risks', waivable: false,
          message: `acknowledged_risks contains '${code}', which is not a waivable validation code. Waivable codes are: ${WAIVABLE_CODES.join(', ')}. Acknowledging a code that does not exist would hide nothing and mislead the next reviewer.`,
        });
      }
    }
  }

  if (doc.notes !== null && typeof doc.notes !== 'string') {
    out.push({
      code: 'field_not_a_string', field: 'notes', waivable: false,
      message: `notes must be a string or null, but is ${typeof doc.notes}.`,
    });
  }

  return out;
}

/** Throwing wrapper — used by every write path. */
export function assertPolicyValid(doc: OperatingPolicyDocument, rawPatch?: unknown): void {
  const violations = validatePolicyDocument(doc, rawPatch);
  if (violations.length > 0) throw new PolicyValidationError(violations);
}

// ─── Portfolios ──────────────────────────────────────────────────────────────

export interface PolicyPortfolio {
  id: string;
  name: string;
  business_ids: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

function parsePortfolio(row: Record<string, unknown> | null | undefined): PolicyPortfolio | null {
  if (!row) return null;
  let ids: string[] = [];
  try { ids = JSON.parse(String(row.business_ids ?? '[]')) as string[]; } catch { ids = []; }
  return {
    id: String(row.id), name: String(row.name), business_ids: Array.isArray(ids) ? ids : [],
    created_by: String(row.created_by), created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

export function listPolicyPortfolios(): PolicyPortfolio[] {
  return (db.prepare('SELECT * FROM operating_policy_portfolios ORDER BY name').all() as Array<Record<string, unknown>>)
    .map((r) => parsePortfolio(r)!)
    .filter(Boolean);
}

export function getPolicyPortfolio(id: string): PolicyPortfolio | null {
  return parsePortfolio(db.prepare('SELECT * FROM operating_policy_portfolios WHERE id = ?').get(id) as Record<string, unknown> | null);
}

/** The (at most one) portfolio a business belongs to. */
export function getPortfolioForBusiness(businessId: string): PolicyPortfolio | null {
  return listPolicyPortfolios().find((p) => p.business_ids.includes(businessId)) ?? null;
}

/**
 * Create or replace a portfolio. A business may belong to at most one
 * portfolio — overlapping membership would make inheritance ambiguous
 * ("which portfolio's threshold wins?"), so it is rejected here rather
 * than resolved by an arbitrary tie-break at read time.
 */
export function upsertPolicyPortfolio(input: {
  id?: string; name: string; business_ids: string[]; actor: string;
}): PolicyPortfolio {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Portfolio name is required.');
  const ids = Array.from(new Set((input.business_ids ?? []).map((x) => String(x))));
  if (ids.length === 0) {
    throw new Error('A policy portfolio must explicitly select at least one business — an empty portfolio would silently apply to nothing.');
  }
  const placeholders = ids.map(() => '?').join(',');
  const found = new Set((db.prepare(`SELECT id FROM businesses WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string }>).map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`Unknown business id(s) in portfolio: ${missing.join(', ')}.`);

  const id = input.id ?? generateId();
  for (const other of listPolicyPortfolios()) {
    if (other.id === id) continue;
    const overlap = other.business_ids.filter((b) => ids.includes(b));
    if (overlap.length > 0) {
      throw new Error(
        `Business ${overlap.join(', ')} already belongs to portfolio '${other.name}' (${other.id}). ` +
        'A business may belong to at most one policy portfolio, otherwise inheritance would be ambiguous. ' +
        'Remove it from the other portfolio first.',
      );
    }
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO operating_policy_portfolios (id, name, business_ids, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, business_ids = excluded.business_ids, updated_at = excluded.updated_at
  `).run(id, name, JSON.stringify(ids), input.actor, now, now);
  return getPolicyPortfolio(id)!;
}

// ─── Scope helpers ───────────────────────────────────────────────────────────

export interface PolicyScopeRef {
  scope: PolicyScope;
  /** business_id for 'business' scope, portfolio id for 'portfolio' scope. */
  key: string;
}

export function assertScopeExists(ref: PolicyScopeRef): void {
  if (ref.scope === 'business') {
    const row = db.prepare('SELECT id FROM businesses WHERE id = ?').get(ref.key);
    if (!row) throw new Error(`Business '${ref.key}' not found.`);
    return;
  }
  if (ref.scope === 'portfolio') {
    if (!getPolicyPortfolio(ref.key)) throw new Error(`Policy portfolio '${ref.key}' not found.`);
    return;
  }
  throw new Error(`Invalid policy scope '${String((ref as PolicyScopeRef).scope)}'. Must be 'business' or 'portfolio'.`);
}

// ─── Audit trail ─────────────────────────────────────────────────────────────

export interface PolicyFieldChange { field: string; from: unknown; to: unknown }

/** Field-level diff over the flattened document — what actually changed. */
export function diffPolicyDocuments(
  before: OperatingPolicyDocument | null,
  after: OperatingPolicyDocument,
): PolicyFieldChange[] {
  const flatten = (doc: OperatingPolicyDocument | null): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!doc) return out;
    for (const section of SECTION_KEYS) {
      for (const [k, v] of Object.entries(doc[section] as unknown as Record<string, unknown>)) {
        out[`${section}.${k}`] = v;
      }
    }
    out['acknowledged_risks'] = doc.acknowledged_risks;
    out['notes'] = doc.notes;
    return out;
  };
  const a = flatten(before);
  const b = flatten(after);
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  const changes: PolicyFieldChange[] = [];
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changes.push({ field: key, from: before ? a[key] ?? null : null, to: b[key] ?? null });
    }
  }
  return changes.sort((x, y) => x.field.localeCompare(y.field));
}

export type PolicyEventType =
  | 'created' | 'scheduled' | 'activated' | 'superseded'
  | 'rolled_back' | 'rejected' | 'schedule_cancelled' | 'previewed';

function recordPolicyEvent(input: {
  policyId: string | null; ref: PolicyScopeRef; businessId: string | null; version: number;
  eventType: PolicyEventType; actor: string; reason?: string | null;
  changes?: PolicyFieldChange[]; before?: OperatingPolicyDocument | null; after?: OperatingPolicyDocument | null;
  metadata?: unknown;
}): void {
  db.prepare(`
    INSERT INTO operating_policy_events (
      id, policy_id, scope, scope_key, business_id, version, event_type,
      actor, reason, changed_fields, before_document, after_document, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    generateId(), input.policyId, input.ref.scope, input.ref.key, input.businessId,
    input.version, input.eventType, input.actor, input.reason ?? null,
    JSON.stringify(input.changes ?? []),
    input.before ? JSON.stringify(input.before) : null,
    input.after ? JSON.stringify(input.after) : null,
    JSON.stringify(input.metadata ?? {}),
  );
}

export function listPolicyEvents(ref: PolicyScopeRef, limit = 200): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT * FROM operating_policy_events
     WHERE scope = ? AND scope_key = ?
     ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(ref.scope, ref.key, Math.min(500, Math.max(1, limit))) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...r,
    changed_fields: safeParse(r.changed_fields, []),
    before_document: r.before_document ? safeParse(r.before_document, null) : null,
    after_document: r.after_document ? safeParse(r.after_document, null) : null,
    metadata: safeParse(r.metadata, {}),
  }));
}

function safeParse<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listPolicyVersions(ref: PolicyScopeRef): OperatingPolicyVersion[] {
  return (db.prepare(
    'SELECT * FROM operating_policies WHERE scope = ? AND scope_key = ? ORDER BY version DESC',
  ).all(ref.scope, ref.key) as Array<Record<string, unknown>>).map((r) => parseVersionRow(r)!);
}

export function getPolicyVersion(ref: PolicyScopeRef, version: number): OperatingPolicyVersion | null {
  return parseVersionRow(db.prepare(
    'SELECT * FROM operating_policies WHERE scope = ? AND scope_key = ? AND version = ?',
  ).get(ref.scope, ref.key, version) as Record<string, unknown> | null);
}

function maxVersion(ref: PolicyScopeRef): number {
  const row = db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM operating_policies WHERE scope = ? AND scope_key = ?',
  ).get(ref.scope, ref.key) as { v: number };
  return Number(row.v ?? 0);
}

/**
 * Flip every scheduled version whose effective_at has arrived to 'active',
 * superseding the version it replaces. Lazy activation (called from every
 * resolve) rather than a scheduler job: a policy scheduled for 09:00 takes
 * effect at the first decision after 09:00 whether or not any background
 * worker is alive, and the transition is recorded exactly once.
 */
export function activateDuePolicies(ref?: PolicyScopeRef): number {
  const params: Array<string> = [];
  let where = "state = 'scheduled' AND effective_at <= ?";
  params.push(new Date().toISOString());
  if (ref) { where += ' AND scope = ? AND scope_key = ?'; params.push(ref.scope, ref.key); }

  const due = db.prepare(
    `SELECT * FROM operating_policies WHERE ${where} ORDER BY effective_at ASC, version ASC`,
  ).all(...params) as Array<Record<string, unknown>>;
  if (due.length === 0) return 0;

  let activated = 0;
  const run = db.transaction(() => {
    for (const raw of due) {
      const version = parseVersionRow(raw)!;
      const scopeRef: PolicyScopeRef = { scope: version.scope, key: version.scope_key };
      // Re-read under the transaction: a concurrent activation may have
      // already moved this row on.
      const current = db.prepare('SELECT state FROM operating_policies WHERE id = ?').get(version.id) as { state: string } | null;
      if (!current || current.state !== 'scheduled') continue;

      const previous = parseVersionRow(db.prepare(
        "SELECT * FROM operating_policies WHERE scope = ? AND scope_key = ? AND state = 'active'",
      ).get(version.scope, version.scope_key) as Record<string, unknown> | null);

      if (previous) {
        db.prepare(
          "UPDATE operating_policies SET state = 'superseded', superseded_at = CURRENT_TIMESTAMP, superseded_by_id = ? WHERE id = ? AND state = 'active'",
        ).run(version.id, previous.id);
        recordPolicyEvent({
          policyId: previous.id, ref: scopeRef, businessId: previous.business_id, version: previous.version,
          eventType: 'superseded', actor: 'system:policy-activation',
          reason: `Superseded by version ${version.version}.`,
        });
      }
      db.prepare(
        "UPDATE operating_policies SET state = 'active', activated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).run(version.id);
      recordPolicyEvent({
        policyId: version.id, ref: scopeRef, businessId: version.business_id, version: version.version,
        eventType: 'activated', actor: 'system:policy-activation',
        reason: `Scheduled effective_at ${version.effective_at} reached.`,
        changes: diffPolicyDocuments(previous?.document ?? null, version.document),
        before: previous?.document ?? null, after: version.document,
      });
      activated++;
    }
  });
  // #67: a policy READ settles any activation whose effective_at has already
  // passed. That is housekeeping the clock caused, not work the caller
  // initiated â€” but it is still a write, and a simulation reading a policy
  // would otherwise be blocked by the shared side-effect guard. Declaring it
  // simulation-neutral lets a preview read the real policy while RECORDING
  // that it settled an already-due activation, so the simulation result
  // discloses it rather than hiding it. This is the only such declaration in
  // the codebase; see server/simulation/simulation-context.ts.
  allowSimulationWrite('settling an operating-policy activation that was already due', run);
  return activated;
}

/** The currently active version at a scope, after settling due activations. */
export function getActivePolicyVersion(ref: PolicyScopeRef): OperatingPolicyVersion | null {
  activateDuePolicies(ref);
  return parseVersionRow(db.prepare(
    "SELECT * FROM operating_policies WHERE scope = ? AND scope_key = ? AND state = 'active'",
  ).get(ref.scope, ref.key) as Record<string, unknown> | null);
}

// ─── Resolution (inheritance) ────────────────────────────────────────────────

export interface ResolvedOperatingPolicy {
  business_id: string;
  document: OperatingPolicyDocument;
  /** Most specific source that contributed — what a decision cites. */
  policy_id: string | null;
  policy_version: number;
  /** 'business' | 'portfolio' | 'system_default'. */
  policy_scope: 'business' | 'portfolio' | 'system_default';
  business_policy_id: string | null;
  business_policy_version: number | null;
  portfolio_id: string | null;
  portfolio_policy_id: string | null;
  portfolio_policy_version: number | null;
  /** One-line, human-readable provenance for logs and error messages. */
  citation: string;
}

/**
 * The effective policy for one business: system defaults, then its
 * portfolio's active policy (if it belongs to one), then its own.
 *
 * `policy_version` is 0 when nothing has ever been authored — "system
 * defaults" is a real, citable answer rather than a null hole in the
 * decision record.
 */
export function resolveOperatingPolicy(businessId: string): ResolvedOperatingPolicy {
  const portfolio = getPortfolioForBusiness(businessId);
  const portfolioVersion = portfolio ? getActivePolicyVersion({ scope: 'portfolio', key: portfolio.id }) : null;
  const businessVersion = getActivePolicyVersion({ scope: 'business', key: businessId });

  // Merge the OVERRIDES, not the resolved documents: a business version
  // resolves to a full document, so merging documents would silently
  // reset every portfolio value the business never touched back to the
  // system default.
  let document = DEFAULT_OPERATING_POLICY;
  if (portfolioVersion) document = mergePolicyDocument(document, portfolioVersion.overrides);
  if (businessVersion) document = mergePolicyDocument(document, businessVersion.overrides);

  const mostSpecific = businessVersion ?? portfolioVersion;
  const policyScope: ResolvedOperatingPolicy['policy_scope'] =
    businessVersion ? 'business' : portfolioVersion ? 'portfolio' : 'system_default';

  const citation = mostSpecific
    ? `${policyScope} policy v${mostSpecific.version} (${mostSpecific.id})` +
      (policyScope === 'business' && portfolioVersion ? ` inheriting portfolio '${portfolio!.name}' v${portfolioVersion.version}` : '')
    : 'system default operating policy (v0 — no policy authored for this business)';

  return {
    business_id: businessId,
    document,
    policy_id: mostSpecific?.id ?? null,
    policy_version: mostSpecific?.version ?? 0,
    policy_scope: policyScope,
    business_policy_id: businessVersion?.id ?? null,
    business_policy_version: businessVersion?.version ?? null,
    portfolio_id: portfolio?.id ?? null,
    portfolio_policy_id: portfolioVersion?.id ?? null,
    portfolio_policy_version: portfolioVersion?.version ?? null,
    citation,
  };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface SavePolicyInput {
  scope?: PolicyScope;
  /** business_id or portfolio id, depending on scope. */
  key: string;
  /** Partial document merged over the current version at this scope. */
  patch: OperatingPolicyPatch;
  /** ISO timestamp. Future = scheduled activation; past/now = immediate. */
  effective_at?: string | null;
  change_reason?: string | null;
  actor: string;
  /**
   * Optimistic concurrency: the version the editor was looking at. If the
   * scope has moved on since, the save is rejected rather than silently
   * overwriting someone else's edit.
   */
  base_version?: number | null;
  source?: 'edit' | 'rollback' | 'seed';
  rolled_back_from_version?: number | null;
  /**
   * Replace this scope's overrides wholesale instead of merging the patch
   * into them. Rollback uses it: restoring version N must also drop
   * overrides that versions N+1.. added, not merge on top of them.
   */
  replace_overrides?: boolean;
}

function normaliseEffectiveAt(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`effective_at '${value}' is not a valid ISO-8601 timestamp (e.g. 2026-09-01T09:00:00.000Z).`);
  }
  return parsed.toISOString();
}

/**
 * Write a new policy version. Never mutates an existing row: an edit,
 * a schedule and a rollback are all "version N+1 with a different source".
 */
export function savePolicyVersion(input: SavePolicyInput): OperatingPolicyVersion {
  const ref: PolicyScopeRef = { scope: input.scope ?? 'business', key: String(input.key) };
  if (ref.scope !== 'business' && ref.scope !== 'portfolio') {
    throw new Error(`Invalid policy scope '${String(ref.scope)}'. Must be 'business' or 'portfolio'.`);
  }
  assertScopeExists(ref);
  activateDuePolicies(ref);

  const effectiveAt = normaliseEffectiveAt(input.effective_at);
  const latest = listPolicyVersions(ref)[0] ?? null;
  const current = getActivePolicyVersion(ref);
  const base = current ?? latest;

  if (input.base_version != null && base && base.version !== input.base_version) {
    throw new Error(
      `Policy has changed since this edit began: you are editing from version ${input.base_version} ` +
      `but the current version is ${base.version}. Reload the policy and re-apply your change.`,
    );
  }

  const nextOverrides = input.replace_overrides
    ? mergeOverrides({}, input.patch)
    : mergeOverrides(base?.overrides ?? {}, input.patch);
  const nextDocument = mergePolicyDocument(DEFAULT_OPERATING_POLICY, nextOverrides);
  const violations = validatePolicyDocument(nextDocument, input.patch);
  if (violations.length > 0) {
    // A rejected edit is still evidence — record the attempt so the audit
    // history shows what someone tried to do and why it was refused.
    recordPolicyEvent({
      policyId: null, ref, businessId: ref.scope === 'business' ? ref.key : null,
      version: (base?.version ?? 0) + 1, eventType: 'rejected', actor: input.actor,
      reason: input.change_reason ?? null, metadata: { violations, patch: input.patch },
    });
    throw new PolicyValidationError(violations);
  }

  const version = maxVersion(ref) + 1;
  const id = generateId();
  const isImmediate = new Date(effectiveAt).getTime() <= Date.now();
  const state: PolicyState = isImmediate ? 'active' : 'scheduled';
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    if (isImmediate && current) {
      db.prepare(
        "UPDATE operating_policies SET state = 'superseded', superseded_at = ?, superseded_by_id = ? WHERE id = ? AND state = 'active'",
      ).run(now, id, current.id);
      recordPolicyEvent({
        policyId: current.id, ref, businessId: current.business_id, version: current.version,
        eventType: 'superseded', actor: input.actor,
        reason: `Superseded by version ${version}.`,
      });
    }
    db.prepare(`
      INSERT INTO operating_policies (
        id, scope, scope_key, business_id, portfolio_id, version, state, document, overrides,
        effective_at, activated_at, source, rolled_back_from_version, change_reason, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, ref.scope, ref.key,
      ref.scope === 'business' ? ref.key : null,
      ref.scope === 'portfolio' ? ref.key : null,
      version, state, JSON.stringify(nextDocument), JSON.stringify(nextOverrides),
      effectiveAt, isImmediate ? now : null,
      input.source ?? 'edit', input.rolled_back_from_version ?? null,
      input.change_reason ?? null, input.actor, now,
    );
    recordPolicyEvent({
      policyId: id, ref, businessId: ref.scope === 'business' ? ref.key : null, version,
      eventType: isImmediate ? 'created' : 'scheduled', actor: input.actor,
      reason: input.change_reason ?? null,
      changes: diffPolicyDocuments(base?.document ?? null, nextDocument),
      before: base?.document ?? null, after: nextDocument,
      metadata: { effective_at: effectiveAt, source: input.source ?? 'edit' },
    });
    if (isImmediate) {
      recordPolicyEvent({
        policyId: id, ref, businessId: ref.scope === 'business' ? ref.key : null, version,
        eventType: 'activated', actor: input.actor, reason: 'Effective immediately.',
      });
    }
  });
  run();

  const saved = getPolicyVersion(ref, version)!;
  audit(
    ref.scope === 'business' ? ref.key : null,
    'operating_policy', id, isImmediate ? 'activate' : 'schedule', input.actor,
    base?.document ?? null, nextDocument,
    { scope: ref.scope, scope_key: ref.key, version, effective_at: effectiveAt, reason: input.change_reason ?? null },
  );
  return saved;
}

/**
 * Roll back to a prior version by writing it forward as a new version.
 * History is never rewound or deleted — "we went back to v3" is itself a
 * change worth a version number and an audit row.
 */
export function rollbackPolicy(input: {
  scope?: PolicyScope; key: string; to_version: number; actor: string; change_reason?: string | null;
}): OperatingPolicyVersion {
  const ref: PolicyScopeRef = { scope: input.scope ?? 'business', key: String(input.key) };
  assertScopeExists(ref);
  const target = getPolicyVersion(ref, input.to_version);
  if (!target) {
    const available = listPolicyVersions(ref).map((v) => v.version);
    throw new Error(
      `Version ${input.to_version} does not exist for ${ref.scope} '${ref.key}'. ` +
      (available.length ? `Available versions: ${available.join(', ')}.` : 'No policy versions have been authored yet.'),
    );
  }
  const current = getActivePolicyVersion(ref);
  if (current && current.version === input.to_version) {
    throw new Error(`Version ${input.to_version} is already the active policy — there is nothing to roll back to.`);
  }

  const saved = savePolicyVersion({
    scope: ref.scope, key: ref.key,
    // The target version's overrides, replacing rather than merging: a
    // rollback must also drop overrides that later versions introduced,
    // and must not freeze inherited values it never set.
    patch: target.overrides,
    replace_overrides: true,
    effective_at: new Date().toISOString(),
    change_reason: input.change_reason ?? `Rolled back to version ${input.to_version}.`,
    actor: input.actor,
    source: 'rollback',
    rolled_back_from_version: input.to_version,
  });
  recordPolicyEvent({
    policyId: saved.id, ref, businessId: saved.business_id, version: saved.version,
    eventType: 'rolled_back', actor: input.actor,
    reason: input.change_reason ?? `Restored version ${input.to_version} as version ${saved.version}.`,
    metadata: { rolled_back_from_version: input.to_version, replaced_version: current?.version ?? null },
  });
  return saved;
}

/** Cancel a not-yet-effective scheduled version. History is retained. */
export function cancelScheduledPolicy(input: {
  scope?: PolicyScope; key: string; version: number; actor: string; reason?: string | null;
}): OperatingPolicyVersion {
  const ref: PolicyScopeRef = { scope: input.scope ?? 'business', key: String(input.key) };
  assertScopeExists(ref);
  const target = getPolicyVersion(ref, input.version);
  if (!target) throw new Error(`Version ${input.version} does not exist for ${ref.scope} '${ref.key}'.`);
  if (target.state !== 'scheduled') {
    throw new Error(`Version ${input.version} is '${target.state}', not 'scheduled' — only a version that has not taken effect yet can be cancelled.`);
  }
  db.prepare(
    "UPDATE operating_policies SET state = 'superseded', superseded_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'scheduled'",
  ).run(target.id);
  recordPolicyEvent({
    policyId: target.id, ref, businessId: target.business_id, version: target.version,
    eventType: 'schedule_cancelled', actor: input.actor, reason: input.reason ?? null,
  });
  return getPolicyVersion(ref, input.version)!;
}

// ─── Preview ─────────────────────────────────────────────────────────────────

export interface PolicyPreviewImpact {
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface PolicyPreview {
  valid: boolean;
  violations: PolicyViolation[];
  current_version: number;
  next_version: number;
  would_activate_immediately: boolean;
  effective_at: string;
  current_document: OperatingPolicyDocument;
  next_document: OperatingPolicyDocument;
  changes: PolicyFieldChange[];
  impacts: PolicyPreviewImpact[];
}

/**
 * Validate a proposed change and compute what it would do — with no writes
 * of any kind. Deliberately does NOT record an event: a preview is a
 * question, not a change, and cluttering the audit trail with every
 * keystroke would devalue it.
 */
export function previewPolicyChange(input: {
  scope?: PolicyScope; key: string; patch: OperatingPolicyPatch; effective_at?: string | null;
}): PolicyPreview {
  const ref: PolicyScopeRef = { scope: input.scope ?? 'business', key: String(input.key) };
  assertScopeExists(ref);

  const current = getActivePolicyVersion(ref) ?? listPolicyVersions(ref)[0] ?? null;
  const nextOverrides = mergeOverrides(current?.overrides ?? {}, input.patch);

  // Validate exactly what savePolicyVersion() would validate, so a preview
  // that says "valid" is a promise the save will keep.
  const violations = validatePolicyDocument(
    mergePolicyDocument(DEFAULT_OPERATING_POLICY, nextOverrides), input.patch,
  );

  // Show the EFFECTIVE documents (inheritance applied), because that is
  // what an operator is actually changing the behaviour of.
  const inherited = ref.scope === 'business'
    ? (() => {
        const portfolio = getPortfolioForBusiness(ref.key);
        const pv = portfolio ? getActivePolicyVersion({ scope: 'portfolio', key: portfolio.id }) : null;
        return pv ? mergePolicyDocument(DEFAULT_OPERATING_POLICY, pv.overrides) : DEFAULT_OPERATING_POLICY;
      })()
    : DEFAULT_OPERATING_POLICY;
  const currentDocument = mergePolicyDocument(inherited, current?.overrides ?? {});
  const nextDocument = mergePolicyDocument(inherited, nextOverrides);
  const effectiveAt = normaliseEffectiveAt(input.effective_at);
  const immediate = new Date(effectiveAt).getTime() <= Date.now();
  const changes = diffPolicyDocuments(currentDocument, nextDocument);

  const impacts: PolicyPreviewImpact[] = [];
  const businessIds = ref.scope === 'business'
    ? [ref.key]
    : (getPolicyPortfolio(ref.key)?.business_ids ?? []);

  if (ref.scope === 'portfolio') {
    impacts.push({
      kind: 'scope',
      summary: `Applies to ${businessIds.length} business/businesses in this portfolio; each business's own policy still overrides it.`,
      detail: { business_ids: businessIds },
    });
  }

  for (const businessId of businessIds) {
    // Autonomy cap — how much headroom is left today under the new cap.
    const beforeCap = currentDocument.autonomy.max_autonomous_tasks_per_day;
    const afterCap = nextDocument.autonomy.max_autonomous_tasks_per_day;
    if (beforeCap !== afterCap || currentDocument.autonomy.allow_autonomous_execution !== nextDocument.autonomy.allow_autonomous_execution) {
      const approvedToday = (db.prepare(`
        SELECT COUNT(*) AS n FROM tasks
         WHERE business_id = ? AND approved_by IS NOT NULL AND approved_by NOT LIKE 'dashboard:%'
           AND approved_at >= datetime('now', 'start of day')
      `).get(businessId) as { n: number } | undefined)?.n ?? 0;
      impacts.push({
        kind: 'autonomy_cap',
        summary: nextDocument.autonomy.allow_autonomous_execution === false
          ? `Autonomous approvals switch OFF for ${businessId}; ${approvedToday} already approved autonomously today are unaffected.`
          : `Daily autonomous approval cap changes from ${beforeCap ?? 'uncapped'} to ${afterCap ?? 'uncapped'}; ${approvedToday} autonomous approval(s) already recorded today${afterCap != null && approvedToday >= afterCap ? ' — the new cap is already exhausted, so further autonomous approvals would be blocked immediately.' : '.'}`,
        detail: { business_id: businessId, before: beforeCap, after: afterCap, approved_today: approvedToday },
      });
    }

    // Threshold changes — which currently-open tasks would re-tier.
    if (changes.some((c) => c.field.startsWith('thresholds.'))) {
      const openTasks = db.prepare(`
        SELECT id, title, action_type, action_payload, trust_tier, confidence, applicability_status
          FROM tasks WHERE business_id = ? AND status IN ('proposed', 'manual_review')
         LIMIT 200
      `).all(businessId) as Array<Record<string, unknown>>;
      const retiered: Array<Record<string, unknown>> = [];
      for (const task of openTasks) {
        const payload = safeParse<Record<string, unknown>>(task.action_payload, {});
        const before = computeTierUnderPolicy(currentDocument, {
          actionType: task.action_type as string | null, payload,
          baseTier: task.trust_tier as string | null,
          agentConfidence: task.confidence as number | null,
          applicabilityStatus: task.applicability_status as string | null,
        });
        const after = computeTierUnderPolicy(nextDocument, {
          actionType: task.action_type as string | null, payload,
          baseTier: task.trust_tier as string | null,
          agentConfidence: task.confidence as number | null,
          applicabilityStatus: task.applicability_status as string | null,
        });
        if (before !== after) retiered.push({ task_id: task.id, title: task.title, from: before, to: after });
      }
      impacts.push({
        kind: 'task_retiering',
        summary: retiered.length === 0
          ? `No currently-open task in ${businessId} changes approval tier under the new thresholds.`
          : `${retiered.length} currently-open task(s) in ${businessId} would change approval tier.`,
        detail: { business_id: businessId, tasks: retiered },
      });
    }

    // Connector applicability — which live connectors the change forbids.
    const newlyBlocked = nextDocument.connectors.blocked_connector_types
      .filter((t) => !currentDocument.connectors.blocked_connector_types.includes(t));
    const narrowedAllow = nextDocument.connectors.allowed_connector_types.length > 0
      && JSON.stringify(nextDocument.connectors.allowed_connector_types) !== JSON.stringify(currentDocument.connectors.allowed_connector_types);
    if (newlyBlocked.length > 0 || narrowedAllow) {
      const connectors = db.prepare('SELECT id, type, name, status FROM connectors WHERE business_id = ?')
        .all(businessId) as Array<{ id: string; type: string; name: string; status: string }>;
      const affected = connectors.filter((c) =>
        nextDocument.connectors.blocked_connector_types.includes(c.type)
        || (nextDocument.connectors.allowed_connector_types.length > 0 && !nextDocument.connectors.allowed_connector_types.includes(c.type)));
      impacts.push({
        kind: 'connector_applicability',
        summary: affected.length === 0
          ? `No connected connector in ${businessId} is affected by the new connector rules.`
          : `${affected.length} connected connector(s) in ${businessId} would no longer be usable for policy-gated actions: ${affected.map((c) => c.type).join(', ')}.`,
        detail: { business_id: businessId, newly_blocked: newlyBlocked, affected_connectors: affected },
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    current_version: current?.version ?? 0,
    next_version: maxVersion(ref) + 1,
    would_activate_immediately: immediate,
    effective_at: effectiveAt,
    current_document: currentDocument,
    next_document: nextDocument,
    changes,
    impacts,
  };
}

// ─── Tier computation under a policy ─────────────────────────────────────────

export interface TierInput {
  actionType?: string | null;
  payload?: Record<string, unknown> | null;
  baseTier?: string | null;
  agentConfidence?: number | null;
  applicabilityStatus?: string | null;
}

const ALWAYS_RED_WORDS = ['publish', 'merge', 'live', 'price', 'inventory', 'send', 'customer', 'payment', 'auth', 'delete', 'unpublish', 'budget'];
const ALWAYS_ORANGE_WORDS = ['github_pr', 'shopify_theme_edit', 'draft', 'branch', 'prepare'];

/**
 * The tier calculation, parameterised by policy thresholds. The keyword
 * escalations are NOT policy-configurable on purpose: "this action
 * publishes to customers" is a property of the action, not an opinion a
 * business gets to hold about it.
 *
 * With DEFAULT_OPERATING_POLICY this is byte-for-byte the behaviour
 * calculateApprovalTier() has always had.
 */
export function computeTierUnderPolicy(policy: OperatingPolicyDocument, input: TierInput): ApprovalTier {
  const action = input.actionType ?? '';
  const payload = input.payload ?? {};
  let rank = input.baseTier === 'red' ? 3 : input.baseTier === 'orange' ? 2 : input.baseTier === 'green' ? 0 : 1;
  const text = `${action} ${JSON.stringify(payload)}`.toLowerCase();
  if (ALWAYS_RED_WORDS.some((w) => text.includes(w))) rank = Math.max(rank, 3);
  if (ALWAYS_ORANGE_WORDS.some((w) => text.includes(w))) rank = Math.max(rank, 2);

  const t = policy.thresholds;
  const affected = Number(payload.affected_records ?? payload.count ?? 0);
  const exposure = Number(payload.financial_exposure_gbp ?? payload.spend_gbp ?? payload.budget_gbp ?? 0);
  if (affected > t.affected_records_review || exposure >= t.financial_exposure_review_gbp || input.applicabilityStatus === 'unknown') rank = Math.max(rank, 2);
  if (affected > t.affected_records_block || exposure >= t.financial_exposure_block_gbp || input.applicabilityStatus === 'not_applicable') rank = Math.max(rank, 3);
  if (typeof input.agentConfidence === 'number' && input.agentConfidence < t.min_agent_confidence) rank = Math.max(rank, 2);

  // An action type the business always wants a human on cannot sit below
  // the human-approval floor, whatever the numbers say.
  if (action && policy.approvals.always_require_human_action_types.includes(action)) {
    rank = Math.max(rank, tierRank(policy.approvals.require_human_approval_at_or_above));
  }
  return TIER_ORDER[rank] as ApprovalTier;
}

// ─── Autonomy gate ───────────────────────────────────────────────────────────

export interface AutonomyDecision {
  allowed: boolean;
  /** Machine-readable reason when blocked. */
  code: string | null;
  /** Operator-facing explanation, already citing the policy version. */
  reason: string | null;
  policy: ResolvedOperatingPolicy;
}

export interface AutonomyGateInput {
  actionType?: string | null;
  tier?: ApprovalTier | null;
  /** Connector types the action needs, from the Typed Action Registry. */
  requiredConnectorTypes?: string[];
}

/**
 * The autonomy-gate branches, over an explicit document rather than a
 * resolved business scope. Factored out of evaluateAutonomyGate() so a
 * hypothetical document — a policy backtest replaying history against a
 * draft patch (see policy-backtest.ts) — is evaluated through EXACTLY these
 * branches, never a parallel reimplementation that could silently drift
 * from what approveTask() actually enforces. evaluateAutonomyGate() below
 * is now a thin wrapper: resolve the real policy, handle the human bypass,
 * delegate here.
 */
export function autonomyDecisionForDocument(
  doc: OperatingPolicyDocument,
  cite: string,
  input: AutonomyGateInput,
): { allowed: boolean; code: string | null; reason: string | null } {
  if (doc.autonomy.allow_autonomous_execution === false) {
    return {
      allowed: false, code: 'autonomy_disabled',
      reason: `This business's operating policy has autonomy.allow_autonomous_execution set to false, so nothing may be approved without a human. A human can still approve this task via the dashboard. ${cite}`,
    };
  }
  if (doc.autonomy.dry_run === true) {
    return {
      allowed: false, code: 'autonomy_dry_run',
      reason: `This business's operating policy is in dry-run mode (autonomy.dry_run = true): proposals are evaluated and recorded but nothing is approved autonomously. A human can still approve this task via the dashboard. ${cite}`,
    };
  }
  if (input.actionType && doc.approvals.always_require_human_action_types.includes(input.actionType)) {
    return {
      allowed: false, code: 'action_type_requires_human',
      reason: `Action type '${input.actionType}' is listed in approvals.always_require_human_action_types, so it always needs an explicit human approval. ${cite}`,
    };
  }
  if (input.tier && doc.approvals.auto_approve_max_tier !== null
      && tierRank(input.tier) > tierRank(doc.approvals.auto_approve_max_tier)) {
    return {
      allowed: false, code: 'tier_above_auto_approve_ceiling',
      reason: `This task's approval tier is '${input.tier}', above this business's approvals.auto_approve_max_tier of '${doc.approvals.auto_approve_max_tier}'. A human must approve it. ${cite}`,
    };
  }
  const blocked = (input.requiredConnectorTypes ?? []).filter((t) => doc.connectors.blocked_connector_types.includes(t));
  if (blocked.length > 0) {
    return {
      allowed: false, code: 'connector_blocked_by_policy',
      reason: `This action needs connector type(s) ${blocked.map((t) => `'${t}'`).join(', ')}, which this business's operating policy lists in connectors.blocked_connector_types. ${cite}`,
    };
  }
  const allowList = doc.connectors.allowed_connector_types;
  if (allowList.length > 0) {
    const notAllowed = (input.requiredConnectorTypes ?? []).filter((t) => !allowList.includes(t));
    if (notAllowed.length > 0) {
      return {
        allowed: false, code: 'connector_not_in_allow_list',
        reason: `This action needs connector type(s) ${notAllowed.map((t) => `'${t}'`).join(', ')}, which are outside this business's connectors.allowed_connector_types (${allowList.join(', ')}). ${cite}`,
      };
    }
  }
  return { allowed: true, code: null, reason: null };
}

/**
 * May `approvedBy` approve this task autonomously right now? Human
 * dashboard approvals are never gated here — the policy governs what
 * Blueprint does on its own, not what a person chooses to do.
 */
export function evaluateAutonomyGate(input: AutonomyGateInput & {
  businessId: string;
  approvedBy: string;
}): AutonomyDecision {
  const policy = resolveOperatingPolicy(input.businessId);
  const isHuman = input.approvedBy.startsWith('dashboard:');
  if (isHuman) return { allowed: true, code: null, reason: null, policy };

  const cite = `(effective ${policy.citation})`;
  const decision = autonomyDecisionForDocument(policy.document, cite, input);
  return { ...decision, policy };
}

/**
 * The daily autonomous-approval cap. Kept separate from the gate above so
 * the caller can count today's approvals in the same transaction it makes
 * its decision.
 *
 * `profileCap` is business_profiles.automation_policy.max_autonomous_tasks_per_day
 * — the pre-#68 setting. Both are honoured and the STRICTER wins, so an
 * operating policy can never quietly loosen a cap an operator already set
 * on the business profile.
 */
export function effectiveDailyTaskCap(
  policy: ResolvedOperatingPolicy,
  profileCap: number | null | undefined,
): { cap: number | null; source: 'operating_policy' | 'business_profile' | 'none' } {
  const policyCap = policy.document.autonomy.max_autonomous_tasks_per_day;
  const profile = typeof profileCap === 'number' && Number.isFinite(profileCap) ? profileCap : null;
  if (policyCap == null && profile == null) return { cap: null, source: 'none' };
  if (policyCap == null) return { cap: profile, source: 'business_profile' };
  if (profile == null) return { cap: policyCap, source: 'operating_policy' };
  return profile <= policyCap
    ? { cap: profile, source: 'business_profile' }
    : { cap: policyCap, source: 'operating_policy' };
}
