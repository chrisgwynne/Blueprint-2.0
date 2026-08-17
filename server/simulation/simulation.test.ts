/**
 * Safe simulation / preview mode — the shared primitive (issue #67).
 *
 * Three things are proved here, in the order the acceptance criteria ask
 * for them:
 *
 *  1. SIDE-EFFECT SUPPRESSION ACROSS EVERY SUPPORTED TRIGGER PATH. All five
 *     preview kinds — task approval, policy change, playbook run,
 *     comparison, hiring readiness — are run repeatedly and row counts
 *     across every operational table are asserted unchanged. The only rows
 *     any of them may produce are the audit record OF the simulation and
 *     the stored preview, and that is asserted precisely rather than
 *     excluded from the count.
 *
 *  2. THE PREVIEW IS HONEST. Freshness, assumptions and unsupported
 *     operations are asserted to be genuinely populated with real content,
 *     not present-but-empty. A preview whose "what I cannot tell you"
 *     section is an empty array is worse than no preview.
 *
 *  3. STALE APPROVAL CANNOT BE REUSED SILENTLY. Drift, expiry and replay
 *     each refuse execution and say why.
 *
 * See simulation-guard.test.ts for the enforcement mechanism itself.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import db from '../db/db.js';
import { runSimulation, SIMULATION_KINDS } from './simulation.js';
import {
  authorizeFromPreview, getPreview, checkPreviewCurrency, savePreview, captureSnapshot,
} from './simulation-store.js';
import {
  evaluateTaskApproval, loadTaskForPreview, taskApprovalSnapshotSources,
} from './evaluators/task-approval.js';
import {
  evaluatePolicyChange, policyChangeSnapshotSources,
  evaluatePlaybookRun, playbookSnapshotSources,
  evaluateComparison, comparisonSnapshotSources,
  evaluateHiringReadiness, hiringSnapshotSources,
} from './evaluators/existing-previews.js';
import { createTask, approveTask } from '../tasks/task-queue.js';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';
import { savePolicyVersion } from '../policy/operating-policy.js';
import { parsePlaybookDefinition } from '../workflows/playbook-schema.js';

const BIZ = 'biz_sim_primitive';
const ACTION = 'test_sim_prim_action';
const ACTION_RISKY = 'test_sim_prim_risky';
const ACTOR = 'dashboard:tester';

/**
 * Every table a real approval, policy save, playbook run or hire would
 * write to. audit_log and simulation_previews are handled separately: they
 * are the record OF a simulation, and are asserted exactly rather than
 * waved through.
 */
const OPERATIONAL_TABLES = [
  'tasks', 'execution_jobs', 'action_receipts', 'workflow_runs', 'workflow_step_runs',
  'playbook_versions', 'playbook_events', 'notifications', 'hiring_decisions',
  'agent_installations', 'decisions', 'system_issues', 'hiring_analysis_runs',
  'operating_policies', 'operating_policy_events',
];

function operationalCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of OPERATIONAL_TABLES) {
    out[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id = ?`).get(BIZ) as { n: number }).n;
  }
  return out;
}

function auditCounts(): { simulationRuns: number; other: number } {
  const simulationRuns = (db.prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE business_id = ? AND action LIKE 'simulation.%'",
  ).get(BIZ) as { n: number }).n;
  const other = (db.prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE business_id = ? AND action NOT LIKE 'simulation.%'",
  ).get(BIZ) as { n: number }).n;
  return { simulationRuns, other };
}

function makeTask(title = 'Previewable task', actionType: string | null = ACTION) {
  return createTask({
    business_id: BIZ, title, proposed_by: 'test:sim',
    action_type: actionType, action_payload: { note: 'hello' },
  })!;
}

function previewTaskApproval(taskId: string, approvedBy = ACTOR) {
  const task = loadTaskForPreview(taskId)!;
  return runSimulation({
    kind: 'task_approval', businessId: BIZ, actor: ACTOR,
    targetType: 'task', targetId: taskId, executable: true,
    snapshotSources: taskApprovalSnapshotSources(taskId, BIZ, task.action_type),
    evaluate: () => evaluateTaskApproval({ task, approvedBy }),
  });
}

function playbookDefinition() {
  return parsePlaybookDefinition({
    name: 'Preview playbook',
    business_scope: { business_id: BIZ, business_types: [] },
    inputs: { type: 'object', required: ['headline'], properties: { headline: { type: 'string' } } },
    steps: [
      { index: 0, name: 'Note', kind: 'action', action_type: ACTION, input: { note: '{{inputs.headline}}' } },
      { index: 1, name: 'Risky', kind: 'action', action_type: ACTION_RISKY, input: { note: 'follow up' } },
    ],
  }, BIZ);
}

/** Run one of each supported kind. The list drives the coverage assertions. */
function runEveryKind(): Array<ReturnType<typeof runSimulation>> {
  // Deliberately reuses a fixture task rather than creating one: these
  // helpers feed the zero-row assertions, and a helper that writes would
  // measure the harness instead of the simulations.
  return [
    previewTaskApproval(sweepTaskId),
    runSimulation({
      kind: 'policy_change', businessId: BIZ, actor: ACTOR,
      targetType: 'operating_policy', targetId: BIZ,
      snapshotSources: policyChangeSnapshotSources('business', BIZ, { autonomy: { max_autonomous_tasks_per_day: 3 } }),
      evaluate: () => evaluatePolicyChange({
        scope: 'business', key: BIZ, patch: { autonomy: { max_autonomous_tasks_per_day: 3 } },
      }),
    }),
    runSimulation({
      kind: 'playbook_run', businessId: BIZ, actor: ACTOR,
      targetType: 'playbook', targetId: null,
      snapshotSources: playbookSnapshotSources({ businessId: BIZ, inputs: { headline: 'Launch' } }),
      evaluate: () => evaluatePlaybookRun({
        businessId: BIZ, definition: playbookDefinition(), inputs: { headline: 'Launch' },
      }),
    }),
    runSimulation({
      kind: 'recommendation_comparison', businessId: BIZ, actor: ACTOR,
      targetType: 'comparison', targetId: null,
      snapshotSources: comparisonSnapshotSources(BIZ, comparisonRefs()),
      evaluate: () => evaluateComparison({ businessId: BIZ, refs: comparisonRefs() }),
    }),
    runSimulation({
      kind: 'hiring_analysis', businessId: BIZ, actor: ACTOR,
      targetType: 'hiring', targetId: BIZ,
      snapshotSources: hiringSnapshotSources(BIZ),
      evaluate: () => evaluateHiringReadiness({ businessId: BIZ }),
    }),
  ];
}

let comparisonTaskIds: string[] = [];
let sweepTaskId = '';
function comparisonRefs() {
  return comparisonTaskIds.map((id) => ({ id, kind: 'task' as const }));
}

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Sim Primitive', 'sim-primitive') ON CONFLICT(id) DO NOTHING").run(BIZ);
  upsertActionRegistryEntry(ACTION, {
    description: 'Simulation primitive fixture.',
    payload_schema: { type: 'object', properties: { note: { type: 'string' } } },
    dispatched_by_executor: true, side_effect_classification: 'internal_idempotent',
    risk_level: 'low', requires_approval: false, supports_rollback: false,
  });
  upsertActionRegistryEntry(ACTION_RISKY, {
    description: 'Simulation primitive fixture, high risk.',
    payload_schema: { type: 'object', properties: { note: { type: 'string' } } },
    dispatched_by_executor: true, side_effect_classification: 'external_verifiable',
    risk_level: 'high', requires_approval: true, supports_rollback: false,
  });

  // Two real tasks for the comparison engine to compare.
  comparisonTaskIds = [makeTask('Comparison candidate A').id, makeTask('Comparison candidate B').id];
  sweepTaskId = makeTask('Kind sweep task').id;
});

beforeEach(() => {
  db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(BIZ);
  db.prepare('DELETE FROM operating_policy_events WHERE scope_key = ?').run(BIZ);
});

// ─── 1 · Side-effect suppression across every supported trigger path ────────

describe('side-effect suppression across every supported trigger path', () => {
  test('every supported kind is actually covered by this suite', () => {
    // Guards against a future kind being added without a regression test.
    const covered = new Set(runEveryKind().map((r) => r.kind));
    expect([...covered].sort()).toEqual([...SIMULATION_KINDS].sort());
  });

  test('repeated simulation of all five kinds creates zero operational rows', () => {
    const before = operationalCounts();

    runEveryKind();
    runEveryKind();

    expect(operationalCounts()).toEqual(before);
    // Belt and braces: an "unchanged because both are wrong" cannot pass.
    expect(before.execution_jobs).toBe(0);
    expect(before.action_receipts).toBe(0);
    expect(before.notifications).toBe(0);
    expect(before.hiring_decisions).toBe(0);
    expect(before.agent_installations).toBe(0);
    expect(before.operating_policies).toBe(0);
  });

  test('no simulation reports having blocked a side effect — none is even attempted', () => {
    for (const result of runEveryKind()) {
      expect(result.blocked_side_effects).toEqual([]);
      expect(result.side_effects_performed).toBe('none');
    }
  });

  test('the ONLY audit rows a simulation produces are its own run records', () => {
    const before = auditCounts();
    const results = runEveryKind();

    const after = auditCounts();
    expect(after.simulationRuns - before.simulationRuns).toBe(results.length);
    // Crucially: no `approve`, no `policy.activate`, no `hire` audit rows.
    expect(after.other).toBe(before.other);
  });

  test('a policy preview does not create, activate or supersede a policy version', () => {
    savePolicyVersion({ key: BIZ, actor: 'test:setup', patch: { autonomy: { max_autonomous_tasks_per_day: 10 } } });
    const versionsBefore = (db.prepare('SELECT COUNT(*) AS n FROM operating_policies WHERE scope_key = ?').get(BIZ) as { n: number }).n;

    runSimulation({
      kind: 'policy_change', businessId: BIZ, actor: ACTOR,
      snapshotSources: policyChangeSnapshotSources('business', BIZ, { autonomy: { allow_autonomous_execution: false } }),
      evaluate: () => evaluatePolicyChange({
        scope: 'business', key: BIZ, patch: { autonomy: { allow_autonomous_execution: false } },
      }),
    });

    const versionsAfter = (db.prepare('SELECT COUNT(*) AS n FROM operating_policies WHERE scope_key = ?').get(BIZ) as { n: number }).n;
    expect(versionsAfter).toBe(versionsBefore);
    // ...and the policy in force is untouched.
    const active = db.prepare("SELECT overrides FROM operating_policies WHERE scope_key = ? AND state = 'active'").get(BIZ) as { overrides: string };
    expect(active.overrides).toContain('max_autonomous_tasks_per_day');
    expect(active.overrides).not.toContain('allow_autonomous_execution');
  });

  test('a task-approval preview leaves the task exactly as it was', () => {
    const task = makeTask('Untouched by preview');
    const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    previewTaskApproval(task.id);
    previewTaskApproval(task.id);
    expect(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)).toEqual(before);
  });
});

// ─── Structural guards ──────────────────────────────────────────────────────

describe('structural: preview modules cannot reach the execution machinery', () => {
  test('the task-approval evaluator imports nothing that can approve or execute', async () => {
    // It reads the task with raw SQL rather than importing task-queue,
    // deliberately: the easiest way to break this property is to import a
    // writer "just to read one field".
    const source = await Bun.file(new URL('./evaluators/task-approval.ts', import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    const forbidden = imports.filter((spec) =>
      /executor|execution-worker|execution-jobs|task-queue|task-events|dispatcher|event-triggers|installer|action-receipts/i.test(spec));
    expect(forbidden).toEqual([]);
  });

  test('the existing-preview adapters import engines, never executors', async () => {
    const source = await Bun.file(new URL('./evaluators/existing-previews.ts', import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    const forbidden = imports.filter((spec) =>
      /executor|execution-worker|execution-jobs|task-queue|dispatcher|event-triggers|installer|playbook-engine/i.test(spec));
    expect(forbidden).toEqual([]);
  });

  test('the simulation primitive itself imports no side-effecting module', async () => {
    const source = await Bun.file(new URL('./simulation.ts', import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    const forbidden = imports.filter((spec) =>
      /executor|execution-worker|execution-jobs|task-queue|dispatcher|event-triggers|installer|safe-fetch/i.test(spec));
    expect(forbidden).toEqual([]);
  });

  test('the snapshot store imports only the database', async () => {
    const source = await Bun.file(new URL('./simulation-store.ts', import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.sort()).toEqual(['../db/db.js', 'crypto']);
  });
});

// ─── 2 · The preview is honest ──────────────────────────────────────────────

describe('the preview identifies freshness, assumptions and unsupported operations', () => {
  test('every kind reports all three, genuinely populated', () => {
    for (const result of runEveryKind()) {
      // Not merely present — non-empty, with real prose in each entry.
      expect(result.data_freshness.length).toBeGreaterThan(0);
      expect(result.assumptions.length).toBeGreaterThan(0);
      expect(result.unsupported_operations.length).toBeGreaterThan(0);

      for (const entry of result.data_freshness) {
        expect(entry.source.length).toBeGreaterThan(0);
        expect(entry.note.length).toBeGreaterThan(20);
      }
      for (const assumption of result.assumptions) {
        expect(assumption.length).toBeGreaterThan(20);
      }
      for (const unsupported of result.unsupported_operations) {
        expect(unsupported.operation.length).toBeGreaterThan(0);
        expect(unsupported.reason.length).toBeGreaterThan(20);
      }
      expect(result.summary.length).toBeGreaterThan(20);
    }
  });

  test('freshness names the real inputs, with connector sync age', () => {
    db.prepare(
      "INSERT INTO connectors (id, business_id, type, name, status, last_sync) VALUES (?, ?, 'shopify', 'Shop', 'connected', ?)",
    ).run('conn_sim_fresh', BIZ, new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString());

    const task = makeTask('Freshness probe');
    const result = previewTaskApproval(task.id);

    const connectors = result.data_freshness.find((f) => f.source === `connectors:${BIZ}`);
    expect(connectors).toBeDefined();
    // Three days old, past the 24h expectation — reported as stale, with age.
    expect(connectors!.stale).toBe(true);
    expect(connectors!.age_seconds).toBeGreaterThan(24 * 3600);
    expect(connectors!.note).toContain('as of then');

    expect(result.data_freshness.some((f) => f.source === `operating_policy:business:${BIZ}`)).toBe(true);
    expect(result.data_freshness.some((f) => f.source === `task:${task.id}`)).toBe(true);

    db.prepare('DELETE FROM connectors WHERE id = ?').run('conn_sim_fresh');
  });

  test('a task-approval preview says what would happen AND what would not', () => {
    const task = makeTask('Route probe');
    const result = previewTaskApproval(task.id);

    expect(result.detail.would_approve).toBe(true);
    expect(result.detail.execution_route).toBe('queued_for_execution');
    expect(result.planned_changes.map((c) => c.kind)).toContain('execution_job.enqueue');
    expect(result.planned_changes.map((c) => c.kind)).toContain('task.approve');
    // The outbound webhook is flagged as reaching outside Blueprint.
    expect(result.planned_changes.find((c) => c.kind === 'webhook.dispatch')!.external).toBe(true);
    // ...and it is honest that success cannot be previewed.
    expect(result.unsupported_operations.map((u) => u.operation)).toContain('execution_outcome');
  });

  test('an unregistered action type is surfaced as a blocker with a reason, not a silent pass', () => {
    const task = createTask({
      business_id: BIZ, title: 'Bogus action', proposed_by: 'test:sim', action_payload: {},
    })!;
    // Simulate an action_type that was deregistered after the task was made.
    db.prepare("UPDATE tasks SET action_type = 'not_a_real_action_type' WHERE id = ?").run(task.id);

    const result = previewTaskApproval(task.id);
    expect(result.detail.would_approve).toBe(false);
    expect(result.detail.execution_route).toBe('blocked');
    expect(result.detail.blockers.length).toBeGreaterThan(0);
    expect(result.skipped_work.length).toBeGreaterThan(0);
    expect(result.skipped_work[0]!.reason.length).toBeGreaterThan(20);
  });

  test('skipped work always carries a reason — never an empty gesture', () => {
    for (const result of runEveryKind()) {
      for (const skipped of result.skipped_work) {
        expect(skipped.reason.length).toBeGreaterThan(20);
        expect(skipped.target.length).toBeGreaterThan(0);
      }
    }
  });

  test('the hiring preview explains why hiring would not act, and refuses to run the analysis', () => {
    const result = runSimulation({
      kind: 'hiring_analysis', businessId: BIZ, actor: ACTOR,
      snapshotSources: hiringSnapshotSources(BIZ),
      evaluate: () => evaluateHiringReadiness({ businessId: BIZ }),
    });

    // No connector has ever synced for this business, so the evidence gate fails.
    expect(result.detail.passes_freshness_gate).toBe(false);
    expect(result.detail.would_propose_hires).toBe(false);
    expect(result.detail.blockers.length).toBeGreaterThan(0);
    // And it says plainly that running the real analysis is not on offer here.
    expect(result.unsupported_operations.map((u) => u.operation)).toContain('hiring_analysis_execution');
  });
});

// ─── 3 · Audit record per simulation run ────────────────────────────────────

describe('every simulation run is audited', () => {
  test('one audit row per run, recording who, what snapshot and what it showed', () => {
    const task = makeTask('Audited preview');
    const result = previewTaskApproval(task.id);

    const row = db.prepare(
      "SELECT * FROM audit_log WHERE business_id = ? AND action = 'simulation.run' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(BIZ) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.actor).toBe(ACTOR);
    expect(row.entity_type).toBe('simulation');
    expect(row.entity_id).toBe(result.preview_id);

    const metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
    expect(metadata.kind).toBe('task_approval');
    expect(metadata.target_id).toBe(task.id);
    expect(metadata.snapshot_hash).toBe(result.snapshot.hash);
    expect(Array.isArray(metadata.snapshot_sources)).toBe(true);
    expect(metadata.summary).toBe(result.summary);
    expect(metadata.expires_at).toBe(result.expires_at);
  });

  test('a refused stale authorisation is audited too', () => {
    const task = makeTask('Audited drift');
    const preview = previewTaskApproval(task.id);
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('moved on', task.id);

    authorizeFromPreview({ previewId: preview.preview_id!, actor: ACTOR, expectedKind: 'task_approval' });

    const row = db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'simulation.authorization_refused_stale' AND entity_id = ?",
    ).get(preview.preview_id) as { n: number };
    expect(row.n).toBe(1);
  });
});

// ─── 4 · Expiry, staleness and the separately-authorised execution step ─────

describe('a preview cannot be silently reused once it is stale', () => {
  test('a fresh preview authorises exactly one execution', () => {
    const task = makeTask('Fresh authorisation');
    const preview = previewTaskApproval(task.id);

    const approved = approveTask(task.id, ACTOR, { simulationPreviewId: preview.preview_id });
    expect(approved!.status).toBe('approved');

    // Single use: replaying the same authorisation is refused.
    expect(() => approveTask(task.id, ACTOR, { simulationPreviewId: preview.preview_id }))
      .toThrow(/already used to authorise|already consumed|consumed concurrently/i);
  });

  test('data drifting after the preview refuses execution and names what changed', () => {
    const task = makeTask('Drift detection');
    const preview = previewTaskApproval(task.id);

    // The world moves: someone edits the task.
    db.prepare('UPDATE tasks SET title = ?, version = version + 1 WHERE id = ?').run('Edited behind your back', task.id);

    let thrown: (Error & { code?: string; drift?: Array<{ key: string }> }) | null = null;
    try { approveTask(task.id, ACTOR, { simulationPreviewId: preview.preview_id }); }
    catch (err) { thrown = err as Error & { code?: string }; }

    expect(thrown).not.toBeNull();
    expect(thrown!.code).toBe('snapshot_drift');
    expect(thrown!.drift!.map((d) => d.key)).toContain(`task:${task.id}`);
    expect(thrown!.message).toContain('Re-run the preview');

    // And it genuinely did not approve.
    const after = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(after.status).toBe('proposed');
  });

  test('a policy change after the preview also counts as drift', () => {
    const task = makeTask('Policy drift');
    const preview = previewTaskApproval(task.id);

    // The task is untouched, but the RULES it was judged under changed.
    savePolicyVersion({ key: BIZ, actor: 'test:setup', patch: { autonomy: { max_autonomous_tasks_per_day: 7 } } });

    const authorization = authorizeFromPreview({
      previewId: preview.preview_id!, actor: ACTOR, expectedKind: 'task_approval',
    });
    expect(authorization.ok).toBe(false);
    expect(authorization.reason).toBe('snapshot_drift');
    expect(authorization.drift.map((d) => d.key)).toContain(`operating_policy:business:${BIZ}`);
  });

  test('an expired preview cannot authorise, even with nothing changed at all', () => {
    const task = makeTask('Expiry');
    const snapshot = captureSnapshot(taskApprovalSnapshotSources(task.id, BIZ, ACTION));
    const stored = savePreview({
      businessId: BIZ, kind: 'task_approval', actor: ACTOR,
      targetType: 'task', targetId: task.id,
      snapshot, result: {}, ttlSeconds: 30,
    });
    // Force it past its TTL without touching any of the underlying data.
    db.prepare('UPDATE simulation_previews SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), stored.id);

    const authorization = authorizeFromPreview({ previewId: stored.id, actor: ACTOR });
    expect(authorization.ok).toBe(false);
    expect(authorization.reason).toBe('expired');
    expect(authorization.message).toContain('no longer a trustworthy');
  });

  test('a preview for one task cannot authorise another', () => {
    const a = makeTask('Target A');
    const b = makeTask('Target B');
    const preview = previewTaskApproval(a.id);

    expect(() => approveTask(b.id, ACTOR, { simulationPreviewId: preview.preview_id }))
      .toThrow(/cannot be moved between targets|not '/);
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(b.id) as { status: string }).status).toBe('proposed');
  });

  test('a preview of the wrong kind cannot authorise a task approval', () => {
    const task = makeTask('Kind mismatch');
    const policyPreview = runSimulation({
      kind: 'policy_change', businessId: BIZ, actor: ACTOR,
      targetType: 'operating_policy', targetId: BIZ,
      snapshotSources: policyChangeSnapshotSources('business', BIZ, {}),
      evaluate: () => evaluatePolicyChange({ scope: 'business', key: BIZ, patch: {} }),
    });

    expect(() => approveTask(task.id, ACTOR, { simulationPreviewId: policyPreview.preview_id }))
      .toThrow(/cannot authorise a 'task_approval'|cannot be moved/);
  });

  test('an unknown preview id is refused rather than ignored', () => {
    const task = makeTask('Unknown preview');
    expect(() => approveTask(task.id, ACTOR, { simulationPreviewId: 'simprev_does_not_exist' }))
      .toThrow(/No preview/);
  });

  test('approving WITHOUT a preview still works — previewing is optional, not a new mandatory gate', () => {
    // #67 adds a safe way to look before you leap. It does not silently
    // break every existing approval path that never previewed at all.
    const task = makeTask('No preview needed');
    expect(approveTask(task.id, ACTOR)!.status).toBe('approved');
  });

  test('checkPreviewCurrency reports drift without consuming anything', () => {
    const task = makeTask('Read-only currency check');
    const preview = previewTaskApproval(task.id);

    const first = checkPreviewCurrency(getPreview(preview.preview_id!)!);
    expect(first.drift).toEqual([]);
    expect(first.expired).toBe(false);

    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('changed', task.id);
    const second = checkPreviewCurrency(getPreview(preview.preview_id!)!);
    expect(second.drift.length).toBe(1);
    expect(second.drift[0]!.change).toContain('has changed since this preview was generated');

    // Still unconsumed — checking is not using.
    expect(getPreview(preview.preview_id!)!.consumed_at).toBeNull();
  });

  test('the snapshot hash is order-independent, so ordering cannot cause false drift', () => {
    const task = makeTask('Order independence');
    const a = captureSnapshot([
      { type: 'task', id: task.id },
      { type: 'connectors', business_id: BIZ },
    ]);
    const b = captureSnapshot([
      { type: 'connectors', business_id: BIZ },
      { type: 'task', id: task.id },
    ]);
    expect(a.hash).toBe(b.hash);
  });
});

// ─── 5 · The envelope itself ────────────────────────────────────────────────

describe('the shared envelope', () => {
  test('every kind returns the same fields, with an expiry and a snapshot', () => {
    for (const result of runEveryKind()) {
      expect(result.simulation_id).toMatch(/^sim_/);
      expect(SIMULATION_KINDS).toContain(result.kind);
      expect(result.snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.snapshot.sources.length).toBeGreaterThan(0);
      expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
      expect(result.ttl_seconds).toBeGreaterThan(0);
      expect(result.preview_id).toMatch(/^simprev_/);
      expect(result.side_effects_performed).toBe('none');
      expect(Array.isArray(result.planned_changes)).toBe(true);
      expect(Array.isArray(result.skipped_work)).toBe(true);
    }
  });

  test('only task approval is offered as executable straight from its preview', () => {
    const results = runEveryKind();
    const executable = results.filter((r) => r.executable).map((r) => r.kind);
    expect(executable).toEqual(['task_approval']);
  });
});
