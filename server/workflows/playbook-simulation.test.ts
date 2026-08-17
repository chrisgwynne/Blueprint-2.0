/**
 * Playbook simulation / preview (#74).
 *
 * The acceptance criterion is "playbooks support preview/simulation" — and
 * a preview is only worth anything if it provably changes nothing. That is
 * asserted two independent ways here, following the #66 comparison engine:
 *
 *   - BEHAVIOURALLY: real row counts across every table a run would write
 *     to are identical before and after repeated simulation.
 *   - STRUCTURALLY: the module's own import list cannot reach anything that
 *     creates, approves, executes or receipts an action — the easiest way
 *     to break the property by accident.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import db from '../db/db.js';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';
import { savePolicyVersion } from '../policy/operating-policy.js';
import { parsePlaybookDefinition } from './playbook-schema.js';
import { simulatePlaybook } from './playbook-simulation.js';

const BIZ = 'biz_playbook_sim';
const ACTION_SIM = 'test_playbook_sim_note';
const ACTION_SIM_RISKY = 'test_playbook_sim_risky';
const ACTION_SIM_CONNECTED = 'test_playbook_sim_connected';

const SCHEMA = {
  type: 'object' as const,
  required: ['title'],
  properties: { title: { type: 'string' as const, minLength: 1 }, count: { type: 'number' as const } },
};

function definition(overrides: Record<string, unknown> = {}) {
  return parsePlaybookDefinition({
    name: 'Simulated playbook',
    business_scope: { business_id: BIZ, business_types: [] },
    inputs: { type: 'object', required: ['headline'], properties: { headline: { type: 'string' } } },
    steps: [
      {
        index: 0, name: 'Create', kind: 'action', action_type: ACTION_SIM,
        input: { title: '{{inputs.headline}}' },
        output_schema: { type: 'object', properties: { external_id: { type: 'string' } } },
      },
      {
        index: 1, name: 'Follow up', kind: 'action', action_type: ACTION_SIM,
        input: { title: 'Re: {{steps.0.output.external_id}}' },
      },
    ],
    ...overrides,
  }, BIZ);
}

/** Every table a real run would touch. Scoped so other suites cannot skew it. */
const WRITE_TABLES = [
  'tasks', 'execution_jobs', 'action_receipts', 'workflow_runs',
  'workflow_step_runs', 'playbook_versions', 'playbook_events', 'audit_log',
];

function snapshotCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of WRITE_TABLES) {
    out[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id = ?`).get(BIZ) as { n: number }).n;
  }
  return out;
}

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Sim Biz', 'sim-biz') ON CONFLICT(id) DO NOTHING").run(BIZ);
  upsertActionRegistryEntry(ACTION_SIM, {
    description: 'Simulation fixture action.',
    payload_schema: SCHEMA, dispatched_by_executor: true,
    side_effect_classification: 'internal_idempotent', risk_level: 'low',
    requires_approval: false, supports_rollback: false,
  });
  upsertActionRegistryEntry(ACTION_SIM_RISKY, {
    description: 'Simulation fixture action, high risk and rollback-capable.',
    payload_schema: SCHEMA, dispatched_by_executor: true,
    side_effect_classification: 'external_verifiable', risk_level: 'high',
    requires_approval: false, supports_rollback: true,
  });
  upsertActionRegistryEntry(ACTION_SIM_CONNECTED, {
    description: 'Simulation fixture action needing a connector nobody configured.',
    payload_schema: SCHEMA, dispatched_by_executor: true,
    required_connector_types: ['no_such_connector_type'],
    side_effect_classification: 'internal_idempotent', risk_level: 'low',
    requires_approval: false,
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(BIZ);
  db.prepare('DELETE FROM operating_policy_events WHERE scope_key = ?').run(BIZ);
  savePolicyVersion({
    key: BIZ, actor: 'test:setup',
    patch: { approvals: { require_human_approval_at_or_above: 'orange' } },
  });
});

afterAll(() => {
  db.prepare('DELETE FROM operating_policies WHERE scope_key = ?').run(BIZ);
});

// ─── Zero side effects ──────────────────────────────────────────────────────

describe('simulation performs zero side effects', () => {
  test('repeated simulation creates no task, job, receipt, run, step, version, event or audit row', () => {
    const before = snapshotCounts();

    simulatePlaybook({ businessId: BIZ, definition: definition(), inputs: { headline: 'Preview me' } });
    simulatePlaybook({ businessId: BIZ, definition: definition(), inputs: { headline: 'Preview me' } });
    simulatePlaybook({ businessId: BIZ, definition: definition(), inputs: {} });
    simulatePlaybook({
      businessId: BIZ,
      definition: definition({
        steps: [{ index: 0, name: 'Risky', kind: 'action', action_type: ACTION_SIM_RISKY, input: { title: 'x' } }],
      }),
      inputs: { headline: 'x' },
    });

    expect(snapshotCounts()).toEqual(before);
    // Belt and braces: the counts genuinely are zero, so an accidental
    // "unchanged because both are wrong" cannot pass this.
    expect(before.tasks).toBe(0);
    expect(before.workflow_runs).toBe(0);
    expect(before.action_receipts).toBe(0);
  });

  test('the result says so explicitly, so an API consumer need not infer it', () => {
    const sim = simulatePlaybook({ businessId: BIZ, definition: definition(), inputs: { headline: 'x' } });
    expect(sim.side_effects_performed).toBe('none');
  });

  test('the simulation module imports nothing that could create, approve or execute an action', async () => {
    // A structural guard: the zero-side-effect property is easiest to break
    // by importing a writer "just to read one field".
    const source = await Bun.file(new URL('./playbook-simulation.ts', import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    const forbidden = imports.filter((spec) =>
      /executor|execution-worker|task-queue|approval|dispatch|playbook-engine|playbook-versions/i.test(spec));
    expect(forbidden).toEqual([]);
  });
});

// ─── What a preview tells you ───────────────────────────────────────────────

describe('simulation output', () => {
  test('resolves what it can from inputs and reports what only a run can resolve', () => {
    const sim = simulatePlaybook({ businessId: BIZ, definition: definition(), inputs: { headline: 'Launch day' } });

    expect(sim.definition_valid).toBe(true);
    expect(sim.input_violations).toEqual([]);
    expect((sim.steps[0]!.resolved_input as Record<string, unknown>).title).toBe('Launch day');
    expect(sim.steps[0]!.deferred_references).toEqual([]);

    // Step 1 depends on step 0's real output, which does not exist yet.
    expect(sim.steps[1]!.deferred_references).toEqual(['{{steps.0.output.external_id}}']);
    // ...and that is NOT reported as an input error.
    expect(sim.steps[1]!.input_valid).toBe(true);
  });

  test('reports per-step risk, approval requirement, timeout, receipts and rollback capability', () => {
    const sim = simulatePlaybook({
      businessId: BIZ,
      definition: definition({
        steps: [{
          index: 0, name: 'Risky', kind: 'action', action_type: ACTION_SIM_RISKY,
          input: { title: '{{inputs.headline}}' }, timeout_seconds: 120, max_attempts: 2,
        }],
      }),
      inputs: { headline: 'Careful now' },
    });

    const step = sim.steps[0]!;
    expect(step.risk_level).toBe('high');
    expect(step.risk_tier).toBe('orange');
    expect(step.requires_approval).toBe(true);
    expect(step.approval_sources).toContain('risk_tier_requires_human');
    expect(step.approval_explanation).toContain('risk tier');
    expect(step.timeout_seconds).toBe(120);
    expect(step.max_attempts).toBe(2);
    expect(step.supports_rollback).toBe(true);
    expect(step.produces_receipt).toBe(true);
    expect(step.side_effect_classification).toBe('external_verifiable');
    expect(sim.approval_points).toEqual([0]);
    expect(sim.would_complete_without_human).toBe(false);
  });

  test('a step whose action is not rollback-capable says so plainly in its note', () => {
    const sim = simulatePlaybook({ businessId: BIZ, definition: definition(), inputs: { headline: 'x' } });
    expect(sim.steps[0]!.supports_rollback).toBe(false);
    expect(sim.steps[0]!.rollback_note).toContain('CANNOT undo it');
  });

  test('missing inputs are reported without throwing, so a draft can be previewed', () => {
    const sim = simulatePlaybook({ businessId: BIZ, definition: definition(), inputs: {} });
    expect(sim.input_violations.length).toBeGreaterThan(0);
    expect(sim.input_violations[0]!.message).toContain('headline');
    expect(sim.would_complete_without_human).toBe(false);
  });

  test('a missing required connector is a blocking issue, and later steps are shown as not running', () => {
    const sim = simulatePlaybook({
      businessId: BIZ,
      definition: definition({
        steps: [
          { index: 0, name: 'Needs connector', kind: 'action', action_type: ACTION_SIM_CONNECTED, input: { title: 'x' } },
          { index: 1, name: 'Never reached', kind: 'action', action_type: ACTION_SIM, input: { title: 'y' } },
        ],
      }),
      inputs: { headline: 'x' },
    });

    expect(sim.steps[0]!.missing_connector_types).toEqual(['no_such_connector_type']);
    expect(sim.blocking_issues[0]!.step_index).toBe(0);
    expect(sim.steps[1]!.would_run).toBe(false);
    expect(sim.steps[1]!.would_not_run_reason).toContain('Step 0 would stop the run first');
  });

  test('an unregistered action type is surfaced as a blocking issue, not a silent pass', () => {
    const sim = simulatePlaybook({
      businessId: BIZ,
      definition: definition({
        steps: [{ index: 0, name: 'Bogus', kind: 'action', action_type: 'not_a_real_action', input: {} }],
      }),
      inputs: { headline: 'x' },
    });
    expect(sim.definition_valid).toBe(false);
    expect(sim.steps[0]!.blocking_issues.join(' ')).toContain('not registered');
    expect(sim.steps[0]!.produces_receipt).toBe(false);
  });

  test('a manual step is labelled as producing no receipt', () => {
    const sim = simulatePlaybook({
      businessId: BIZ,
      definition: definition({
        steps: [{
          index: 0, name: 'Think', kind: 'manual', agent_id: 'conductor',
          task_template: 'Have a think about {{inputs.headline}}.',
        }],
      }),
      inputs: { headline: 'strategy' },
    });
    expect(sim.steps[0]!.produces_receipt).toBe(false);
    expect(sim.steps[0]!.execution_route).toContain('no action receipt');
    expect(sim.summary.manual_steps).toBe(1);
    // A bounded playbook will not do free-text work unattended, and the
    // preview says so before anyone runs it.
    expect(sim.steps[0]!.requires_approval).toBe(true);
    expect(sim.steps[0]!.approval_sources).toContain('manual_step_acknowledgement');
  });

  test('summary counts describe the whole playbook at a glance', () => {
    const sim = simulatePlaybook({ businessId: BIZ, definition: definition(), inputs: { headline: 'x' } });
    expect(sim.summary).toMatchObject({
      total_steps: 2, action_steps: 2, manual_steps: 0,
      steps_that_would_run: 2, approval_points: 0, rollback_capable_steps: 0,
    });
  });
});
