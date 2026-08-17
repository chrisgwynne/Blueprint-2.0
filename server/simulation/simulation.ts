/**
 * Safe simulation / preview mode — the shared primitive (issue #67).
 *
 * ── One concept, learned once ─────────────────────────────────────────────
 *
 * Blueprint had four previews before this: hiring's dry-run (#57),
 * previewPolicyChange() (#68), comparison mode (#66) and playbook
 * simulation (#74). Each was correct and each was shaped differently, so
 * "what would this do?" was a different question with a different answer
 * format depending on what you happened to be looking at.
 *
 * This module is the general form. Every preview in Blueprint — including
 * the four that already existed — is now expressed as a Simulation: run an
 * evaluator inside the side-effect guard, and return the SAME envelope:
 *
 *   planned_changes         what would actually change, if executed
 *   skipped_work            what would NOT happen, and the reason for each
 *   data_freshness          every input, when it was last true, how old
 *   assumptions             what the preview took for granted
 *   unsupported_operations  what this preview genuinely cannot tell you
 *   blocked_side_effects    anything the guard had to stop (expected: none)
 *   snapshot                fingerprint of the inputs, for staleness checks
 *   expires_at              when this preview stops being trustworthy
 *
 * The four negative fields matter as much as the positive one. A preview
 * that lists only what WOULD happen invites the reader to assume everything
 * else is fine; issue #67 asks for skipped work with reasons, freshness,
 * assumptions and unsupported operations precisely so a preview cannot
 * imply more confidence than it has.
 *
 * ── How the guarantee is enforced ─────────────────────────────────────────
 *
 * Not here, and not by each evaluator being careful. runSimulation() opens
 * a scope from simulation-context.ts; the enforcement lives in db.prepare()
 * and in the named side-effecting entry points (createTask, approveTask,
 * enqueueExecutionJob, installAgent, safeFetch, the webhook / notification /
 * agent-event dispatchers). An evaluator that tries to write throws, no
 * matter how deep the call or which module issued it. See
 * simulation-context.ts for why that is the shape.
 *
 * ── What is deliberately NOT unified ──────────────────────────────────────
 *
 * The four existing previews keep their own rich, domain-specific result
 * types, carried through verbatim on `detail`. Flattening a policy diff, a
 * playbook step table and a candidate comparison into one lowest-common-
 * denominator shape would lose exactly the detail that makes each useful.
 * The envelope unifies the QUESTIONS every preview must answer; the payload
 * stays domain-shaped. The adapters in ./evaluators/ are thin: they call
 * the existing function unchanged and map its output onto the envelope.
 */
import { audit } from '../db/db.js';
import {
  newSimulationScope, runInSimulationScope,
  type BlockedSideEffect, type NeutralWrite, type SimulationScope,
} from './simulation-context.js';
import {
  captureSnapshot, savePreview, DEFAULT_PREVIEW_TTL_SECONDS,
  type SimulationSnapshot, type SnapshotSourceSpec, type StoredPreview,
} from './simulation-store.js';

/** The action/workflow types that support preview. */
export type SimulationKind =
  /** "What would approving this task actually do?" (#67, new) */
  | 'task_approval'
  /** previewPolicyChange() — what an operating-policy edit would change (#68). */
  | 'policy_change'
  /** simulatePlaybook() — which steps would run, and where it would pause (#74). */
  | 'playbook_run'
  /** Comparison mode's read-only candidate evaluation (#66). */
  | 'recommendation_comparison'
  /** Whether autonomous hiring would act, and under which gates (#57). */
  | 'hiring_analysis';

export const SIMULATION_KINDS: SimulationKind[] = [
  'task_approval', 'policy_change', 'playbook_run', 'recommendation_comparison', 'hiring_analysis',
];

/** Something that WOULD change if this were executed for real. */
export interface PlannedChange {
  /** Coarse class, e.g. 'task.approve', 'execution_job.enqueue', 'policy.activate'. */
  kind: string;
  /** What it acts on, in the operator's terms. */
  target: string;
  /** One line an operator can read without knowing the schema. */
  summary: string;
  /** True when the change reaches outside Blueprint and cannot be undone by us. */
  external: boolean;
  /** Whether a person must approve before this specific change happens. */
  requires_approval: boolean;
  detail?: unknown;
}

/** Work that would NOT happen, and why. Never an empty gesture — reason is required. */
export interface SkippedWork {
  kind: string;
  target: string;
  reason: string;
}

/** One input the preview depended on, and how current it is. */
export interface FreshnessEntry {
  source: string;
  label: string;
  as_of: string | null;
  age_seconds: number | null;
  stale: boolean;
  note: string;
}

/** Something this preview cannot answer, stated rather than silently omitted. */
export interface UnsupportedOperation {
  operation: string;
  reason: string;
}

/** The standard envelope every Blueprint preview returns. */
export interface SimulationResult<T = unknown> {
  simulation_id: string;
  kind: SimulationKind;
  business_id: string | null;
  actor: string;
  created_at: string;

  planned_changes: PlannedChange[];
  skipped_work: SkippedWork[];
  data_freshness: FreshnessEntry[];
  assumptions: string[];
  unsupported_operations: UnsupportedOperation[];

  /**
   * Side effects the guard actually had to stop. Expected to be empty; a
   * non-empty list means an evaluator attempted a real write and is a bug,
   * surfaced rather than swallowed.
   */
  blocked_side_effects: BlockedSideEffect[];
  /** Writes explicitly permitted as simulation-neutral, with their reasons. */
  neutral_writes: NeutralWrite[];
  /** Constant. Stated so an API consumer can show it, not merely trust it. */
  side_effects_performed: 'none';

  snapshot: SimulationSnapshot;
  expires_at: string;
  ttl_seconds: number;
  /** Set when the preview was persisted; required to authorise execution. */
  preview_id: string | null;
  /** Whether this kind can be executed straight from its preview. */
  executable: boolean;

  /** The domain-specific result, unchanged from the underlying engine. */
  detail: T;
  summary: string;
}

/**
 * What an evaluator returns. Everything except `detail` and `summary` is
 * optional, but an evaluator that returns no freshness, no assumptions and
 * no unsupported operations is almost certainly not being honest — the
 * tests for #67 assert these are genuinely populated, not merely present.
 */
export interface EvaluatorOutput<T> {
  detail: T;
  summary: string;
  planned_changes?: PlannedChange[];
  skipped_work?: SkippedWork[];
  assumptions?: string[];
  unsupported_operations?: UnsupportedOperation[];
  /** Extra freshness entries the snapshot cannot express (e.g. a computed window). */
  extra_freshness?: FreshnessEntry[];
}

export interface SimulationSpec<T> {
  kind: SimulationKind;
  businessId: string | null;
  actor: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Inputs to fingerprint, so drift can be detected at execution time. */
  snapshotSources: SnapshotSourceSpec[];
  ttlSeconds?: number;
  /** Whether the result should be stored so it can authorise a later execution. */
  persist?: boolean;
  executable?: boolean;
  /** The read-only computation. Runs inside the side-effect guard. */
  evaluate: () => EvaluatorOutput<T>;
}

function freshnessFrom(snapshot: SimulationSnapshot): FreshnessEntry[] {
  return snapshot.sources.map((s) => ({
    source: s.key,
    label: s.label,
    as_of: s.as_of,
    age_seconds: s.age_seconds,
    stale: s.stale,
    note: s.note,
  }));
}

/**
 * Run a preview.
 *
 * The order here is deliberate. The snapshot is captured and the evaluator
 * runs INSIDE the guard; the audit row and the stored preview are written
 * strictly AFTER it closes. A simulation genuinely writes nothing while it
 * is reasoning — the only rows it produces are the record that it happened
 * and, optionally, the preview others will have to re-validate against.
 */
export function runSimulation<T>(spec: SimulationSpec<T>): SimulationResult<T> {
  const scope: SimulationScope = newSimulationScope({
    kind: spec.kind,
    businessId: spec.businessId,
    actor: spec.actor,
  });

  const ttl = Math.max(30, spec.ttlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS);

  const { snapshot, output } = runInSimulationScope(scope, () => {
    const captured = captureSnapshot(spec.snapshotSources);
    return { snapshot: captured, output: spec.evaluate() };
  });

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const result: SimulationResult<T> = {
    simulation_id: scope.simulation_id,
    kind: spec.kind,
    business_id: spec.businessId,
    actor: spec.actor,
    created_at: createdAt,

    planned_changes: output.planned_changes ?? [],
    skipped_work: output.skipped_work ?? [],
    data_freshness: [...freshnessFrom(snapshot), ...(output.extra_freshness ?? [])],
    assumptions: output.assumptions ?? [],
    unsupported_operations: output.unsupported_operations ?? [],

    blocked_side_effects: scope.blocked,
    neutral_writes: scope.neutral_writes,
    side_effects_performed: 'none',

    snapshot,
    expires_at: expiresAt,
    ttl_seconds: ttl,
    preview_id: null,
    executable: spec.executable ?? false,

    detail: output.detail,
    summary: output.summary,
  };

  // ── Outside the guard from here: these writes are the record OF the
  //    simulation, never a side effect performed BY it.
  let stored: StoredPreview | null = null;
  if (spec.persist !== false) {
    stored = savePreview({
      businessId: spec.businessId,
      kind: spec.kind,
      actor: spec.actor,
      targetType: spec.targetType ?? null,
      targetId: spec.targetId ?? null,
      snapshot,
      result,
      ttlSeconds: ttl,
    });
    result.preview_id = stored.id;
    result.expires_at = stored.expires_at;
  }

  // Audit every simulation run: who ran it, against what snapshot, what it
  // showed. Uses the same audit() every other durable decision in Blueprint
  // is recorded through, so previews appear in the #72 audit search
  // alongside the executions they preceded.
  audit(
    spec.businessId, 'simulation', stored?.id ?? scope.simulation_id, 'simulation.run',
    spec.actor, null, null,
    {
      kind: spec.kind,
      target_type: spec.targetType ?? null,
      target_id: spec.targetId ?? null,
      snapshot_hash: snapshot.hash,
      snapshot_sources: snapshot.sources.map((s) => s.key),
      planned_changes: result.planned_changes.length,
      skipped_work: result.skipped_work.length,
      unsupported_operations: result.unsupported_operations.length,
      stale_inputs: result.data_freshness.filter((f) => f.stale).map((f) => f.source),
      blocked_side_effects: result.blocked_side_effects.length,
      expires_at: result.expires_at,
      summary: result.summary,
    },
  );

  return result;
}

export {
  authorizeFromPreview, checkPreviewCurrency, getPreview, listPreviews,
  purgeExpiredPreviews, DEFAULT_PREVIEW_TTL_SECONDS,
  type AuthorizationResult, type SnapshotDrift, type StoredPreview,
} from './simulation-store.js';
export {
  SimulationSideEffectError, isSimulating, allowSimulationWrite,
  type BlockedSideEffect,
} from './simulation-context.js';
