/**
 * Simulation context and side-effect guard (issue #67).
 *
 * ── The problem this solves ───────────────────────────────────────────────
 *
 * Blueprint grew four independent "preview" mechanisms — hiring's dry-run
 * (#57), previewPolicyChange() (#68), comparison mode (#66) and playbook
 * simulation (#74). Each guarantees "no side effects" by DISCIPLINE: the
 * module is careful about what it imports, and a test asserts the import
 * list. That is a good guarantee, but it is a per-module one. It has to be
 * re-earned by every new preview, it cannot see through a call three
 * frames deep into shared code, and it is invisible to the shared
 * execution paths themselves — which is exactly what issue #67's
 * "enforce safeguards in shared execution paths, not only in the UI"
 * asks for.
 *
 * This module is the general version. It provides ONE runtime scope that
 * marks "everything under here is a simulation", and the enforcement lives
 * in the shared write paths rather than in each caller's good manners:
 *
 *   1. THE DATABASE ITSELF. server/db/db.ts wraps db.prepare() and calls
 *      assertSimulationSafeSql() on every statement. Inside a simulation
 *      scope any INSERT/UPDATE/DELETE/REPLACE/DDL throws
 *      SimulationSideEffectError — whatever module issued it, however deep,
 *      whether or not anyone remembered this file exists. db.prepare() is a
 *      genuine chokepoint: every one of the ~2,700 write sites in the
 *      server goes through it, and db.exec() is used only by the migration
 *      block at load time.
 *
 *   2. THE NAMED SIDE-EFFECTING ENTRY POINTS. A DB guard cannot see an
 *      outbound HTTP call, and "no rows written" is a weaker promise than
 *      "no task was created". So the specific operations issue #67 names
 *      — creating a task, approving one, enqueueing an execution job,
 *      dispatching a webhook or notification or agent event, installing
 *      (hiring) an agent, and any outbound fetch — call
 *      guardSimulationSideEffect() directly. Those are unconditional:
 *      unlike a raw DB write they can NEVER be permitted (see below).
 *
 * ── Why there is an escape hatch at all ───────────────────────────────────
 *
 * Some reads in this codebase legitimately settle housekeeping on the way
 * past — the documented example is operating-policy.ts's lazy activation of
 * a version whose effective_at has already passed, which every policy read
 * in the system performs and which playbook-simulation.ts's module comment
 * already discloses. Blocking it would mean a preview could not read a
 * policy at all; silently allowing it would make "zero writes" a lie.
 *
 * allowSimulationWrite(reason, fn) is the third option: the write proceeds,
 * and it is RECORDED on the scope as a neutral write, so the simulation's
 * result can disclose it as an assumption instead of hiding it. It applies
 * only to raw DB writes, is never granted implicitly, and every use of it
 * in the codebase is expected to be justified at its call site.
 *
 * ── Nothing here writes ───────────────────────────────────────────────────
 *
 * This module imports node:async_hooks and node:crypto and nothing else —
 * deliberately, so that db.ts can import it without a cycle and so that the
 * guard can never itself become the thing that needs guarding.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** A side effect a simulation tried to perform and was stopped from performing. */
export interface BlockedSideEffect {
  /** Coarse class, e.g. 'db.write', 'task.create', 'http.outbound'. */
  operation: string;
  /** What it would have acted on: a table, an action type, a URL host. */
  target: string | null;
  /** Human-readable explanation, safe to show an operator. */
  detail: string;
  at: string;
}

/** A write that was explicitly permitted, and the reason it was permitted. */
export interface NeutralWrite {
  operation: string;
  target: string | null;
  reason: string;
  at: string;
}

/**
 * The active simulation. Created by runInSimulationScope() and readable
 * anywhere beneath it, including across `await` boundaries.
 */
export interface SimulationScope {
  simulation_id: string;
  kind: string;
  business_id: string | null;
  actor: string;
  started_at: string;
  /** Everything the guard stopped. Empty is the expected state. */
  blocked: BlockedSideEffect[];
  /** Writes allowed through allowSimulationWrite(), with their reasons. */
  neutral_writes: NeutralWrite[];
  /** Depth of allowSimulationWrite() nesting; > 0 means raw DB writes pass. */
  permit_depth: number;
  /** Reason of the innermost active permit, recorded onto neutral writes. */
  permit_reason: string | null;
}

/**
 * Thrown when code beneath a simulation scope attempts a real side effect.
 * Deliberately NOT a subclass anyone is likely to catch by accident: a
 * simulation that tries to write is a bug in the evaluator, and it should
 * be loud.
 */
export class SimulationSideEffectError extends Error {
  readonly operation: string;
  readonly target: string | null;
  readonly simulation_id: string;
  readonly kind: string;

  constructor(scope: SimulationScope, operation: string, target: string | null, detail: string) {
    super(
      `Blocked by simulation guard: ${detail}. Simulation '${scope.kind}' (${scope.simulation_id}) ` +
      'must not perform real side effects — this is enforced in the shared execution path, not by convention.',
    );
    this.name = 'SimulationSideEffectError';
    this.operation = operation;
    this.target = target;
    this.simulation_id = scope.simulation_id;
    this.kind = scope.kind;
  }
}

const storage = new AsyncLocalStorage<SimulationScope>();

/**
 * How many simulation scopes are live anywhere in the process. Purely a
 * fast path: db.prepare() is on the hot path of the entire server, and
 * checking an integer is very much cheaper than an AsyncLocalStorage
 * lookup plus a regex on every statement. When this is 0 — which is the
 * case for all normal operation — the guard costs one integer comparison.
 *
 * It is a coarse signal, never an authority: a non-zero count only means
 * "some async context somewhere is simulating". Whether THIS caller is
 * inside that scope is decided by the AsyncLocalStorage store, so a
 * concurrent real request running alongside a simulation is unaffected.
 */
let liveScopes = 0;

export function simulationScopesActive(): boolean {
  return liveScopes > 0;
}

/** The simulation this code is running inside, if any. */
export function currentSimulationScope(): SimulationScope | undefined {
  if (liveScopes === 0) return undefined;
  return storage.getStore();
}

/** Convenience predicate for callers that want to describe rather than throw. */
export function isSimulating(): boolean {
  return currentSimulationScope() !== undefined;
}

export function newSimulationScope(input: {
  kind: string;
  businessId?: string | null;
  actor: string;
  simulationId?: string;
}): SimulationScope {
  return {
    simulation_id: input.simulationId ?? `sim_${randomUUID()}`,
    kind: input.kind,
    business_id: input.businessId ?? null,
    actor: input.actor,
    started_at: new Date().toISOString(),
    blocked: [],
    neutral_writes: [],
    permit_depth: 0,
    permit_reason: null,
  };
}

/**
 * Run `fn` inside `scope`. Works for sync and async `fn` alike: the live
 * count is only released when an async result actually settles, so the
 * guard stays armed for the whole of an awaited evaluator rather than
 * disarming the moment the synchronous prefix returns.
 */
export function runInSimulationScope<T>(scope: SimulationScope, fn: () => T): T {
  liveScopes++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    liveScopes--;
  };

  try {
    const result = storage.run(scope, fn);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (value) => { release(); return value; },
        (err) => { release(); throw err; },
      ) as unknown as T;
    }
    release();
    return result;
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Permit raw DB writes beneath `fn`, recording them as neutral rather than
 * hiding them. See the module comment for why this exists and how narrow
 * it is meant to stay. It does NOT unlock the named side-effecting entry
 * points — creating a task or calling out to the internet stays blocked
 * inside a permit.
 */
export function allowSimulationWrite<T>(reason: string, fn: () => T): T {
  const scope = currentSimulationScope();
  if (!scope) return fn();

  const previousReason = scope.permit_reason;
  scope.permit_depth++;
  scope.permit_reason = reason;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    scope.permit_depth--;
    scope.permit_reason = previousReason;
  };

  try {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (value) => { release(); return value; },
        (err) => { release(); throw err; },
      ) as unknown as T;
    }
    release();
    return result;
  } catch (err) {
    release();
    throw err;
  }
}

// ─── The named chokepoint guard ──────────────────────────────────────────────

/**
 * Called from the shared side-effecting entry points. Inside a simulation
 * this ALWAYS records and throws — there is no permit for creating a task,
 * enqueueing a job, hiring an agent or calling an external system, because
 * no preview has a legitimate reason to do any of those.
 *
 * Outside a simulation it is a no-op costing one integer comparison, which
 * is why it is safe to place on genuinely hot paths.
 */
export function guardSimulationSideEffect(
  operation: string,
  target: string | null,
  detail: string,
): void {
  const scope = currentSimulationScope();
  if (!scope) return;

  const blocked: BlockedSideEffect = {
    operation,
    target,
    detail,
    at: new Date().toISOString(),
  };
  scope.blocked.push(blocked);
  throw new SimulationSideEffectError(scope, operation, target, detail);
}

// ─── The database chokepoint ─────────────────────────────────────────────────

/**
 * Statements that change data. `WITH ... INSERT/UPDATE/DELETE` is matched
 * too — a CTE prefix is the obvious way to accidentally slip a write past a
 * naive "starts with SELECT" check.
 */
const WRITE_STATEMENT =
  /^\s*(?:WITH\b[\s\S]*?\)\s*)?(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|VACUUM|REINDEX)\b/i;

const TABLE_PATTERNS: Array<RegExp> = [
  /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`]?(\w+)/i,
  /\bREPLACE\s+INTO\s+["'`]?(\w+)/i,
  /\bUPDATE\s+(?:OR\s+\w+\s+)?["'`]?(\w+)/i,
  /\bDELETE\s+FROM\s+["'`]?(\w+)/i,
  /\b(?:CREATE|DROP|ALTER)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`]?(\w+)/i,
];

/** Best-effort table name, for the blocked-effect record and error text. */
export function sqlWriteTarget(sql: string): string | null {
  for (const pattern of TABLE_PATTERNS) {
    const match = pattern.exec(sql);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function isWriteStatement(sql: string): boolean {
  return WRITE_STATEMENT.test(sql);
}

/**
 * The database-level guard, called by db.ts for every prepared statement.
 *
 * A write inside a simulation either throws (the normal case) or, if the
 * call site wrapped itself in allowSimulationWrite(), is recorded as a
 * disclosed neutral write and allowed through.
 */
export function assertSimulationSafeSql(sql: string): void {
  const scope = currentSimulationScope();
  if (!scope) return;
  if (!isWriteStatement(sql)) return;

  const target = sqlWriteTarget(sql);
  const verb = /^\s*(?:WITH\b[\s\S]*?\)\s*)?(\w+)/i.exec(sql)?.[1]?.toUpperCase() ?? 'WRITE';

  if (scope.permit_depth > 0) {
    scope.neutral_writes.push({
      operation: 'db.write',
      target,
      reason: scope.permit_reason ?? 'permitted',
      at: new Date().toISOString(),
    });
    return;
  }

  const detail = target
    ? `a ${verb} against '${target}' was attempted`
    : `a ${verb} statement was attempted`;
  scope.blocked.push({ operation: 'db.write', target, detail, at: new Date().toISOString() });
  throw new SimulationSideEffectError(scope, 'db.write', target, detail);
}
