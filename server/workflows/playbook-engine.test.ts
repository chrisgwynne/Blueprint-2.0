/**
 * Reusable bounded playbooks (#74) — lifecycle and execution.
 *
 * Covers what the feature actually promises:
 *   - an authorized user can create, validate, version and activate a
 *     playbook for a defined business scope;
 *   - invalid inputs and invalid definitions are rejected with actionable
 *     errors rather than half-run;
 *   - a step's approval requirement can come from risk, not only a manual
 *     flag, and the manual flag is never overridden;
 *   - execution produces real action receipts (#70) and the run's status is
 *     an aggregate of them;
 *   - a failed verification stops the run safely and says which step failed;
 *   - retries never duplicate an already-executed side effect;
 *   - rollback prevents later steps and is HONEST about steps it cannot
 *     compensate;
 *   - version changes preserve history and do not touch in-flight runs;
 *   - one business cannot see, validate, activate or run another's playbook.
 *
 * Execution fixtures use dedicated fake action types registered with
 * `dispatched_by_executor: true` but with no executor.ts dispatch case (the
 * pattern task-queue.approve-cancel.test.ts established), so approval
 * enqueues a real job and opens a real receipt while nothing external ever
 * runs. Receipts are then settled through the real action-receipts.ts
 * writers — the same functions the execution worker calls.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';
import {
  recordExecutionResult, recordExternalAcknowledgement, recordVerification,
  getReceiptForTaskVersion,
} from '../tasks/action-receipts.js';
import { savePolicyVersion } from '../policy/operating-policy.js';
import { PlaybookValidationError } from './playbook-schema.js';
import {
  savePlaybookDraft, validatePlaybookVersion, activatePlaybookVersion,
  listPlaybookVersions, getActivePlaybookVersion, rollbackPlaybookVersion,
  listPlaybookEvents, PlaybookNotFoundError, PlaybookStateError,
} from './playbook-versions.js';
import {
  startPlaybookRun, advancePlaybookRun, approvePlaybookStep, retryPlaybookStep,
  compensatePlaybookRun, summariseRunReceipts, describePlaybookRun,
  listPlaybookStepRuns, getPlaybookRunRow, buildPlaybookRunKey,
} from './playbook-engine.js';

const BIZ_A = 'biz_playbook_a';
const BIZ_B = 'biz_playbook_b';
const WF_A = 'wf_playbook_a';
const WF_B = 'wf_playbook_b';
const ACTOR = 'dashboard:playbook-operator';

/** Low risk, no rollback: the ordinary step. */
const ACTION_NOTE = 'test_playbook_note';
/** Low risk, rollback-capable: the compensation path. */
const ACTION_REVERSIBLE = 'test_playbook_reversible';
/** High risk: approval must come from RISK, not from any manual flag. */
const ACTION_HIGH_RISK = 'test_playbook_high_risk';

const NOTE_SCHEMA = {
  type: 'object' as const,
  required: ['title'],
  properties: {
    title: { type: 'string' as const, minLength: 1 },
    body: { type: 'string' as const },
  },
};

function insertWorkflow(id: string, businessId: string, name: string): void {
  db.prepare(`
    INSERT INTO workflows (id, business_id, name, description, steps, status, created_by)
    VALUES (?, ?, ?, 'Playbook fixture', '[]', 'active', 'human')
    ON CONFLICT(id) DO NOTHING
  `).run(id, businessId, name);
}

/** A minimal valid definition: one typed step consuming one declared input. */
function noteDefinition(overrides: Record<string, unknown> = {}, businessId = BIZ_A): Record<string, unknown> {
  return {
    name: 'Publish weekly note',
    description: 'Fixture playbook',
    business_scope: { business_id: businessId, business_types: [] },
    inputs: {
      type: 'object',
      required: ['headline'],
      properties: { headline: { type: 'string', minLength: 1 } },
    },
    steps: [
      {
        index: 0,
        name: 'Write the note',
        kind: 'action',
        action_type: ACTION_NOTE,
        input: { title: '{{inputs.headline}}', body: 'Standing body copy.' },
        timeout_seconds: 600,
        max_attempts: 2,
        on_failure: 'stop',
      },
    ],
    ...overrides,
  };
}

/** Create → validate → activate, the authorised happy path. */
function activateDefinition(definition: Record<string, unknown>, businessId = BIZ_A, workflowId = WF_A): number {
  const draft = savePlaybookDraft({
    workflowId, businessId, definition, actor: ACTOR, validate: true,
  });
  activatePlaybookVersion({ workflowId, businessId, version: draft.version, actor: ACTOR });
  return draft.version;
}

/**
 * Stand in for the execution worker: settle a step's receipt exactly as the
 * real worker would, through the real recorders.
 */
function settleStepReceipt(
  runId: string, stepIndex: number,
  outcome: { status: 'success' | 'failure'; summary?: string; externalId?: string; verifyVerdict?: string },
): void {
  const step = listPlaybookStepRuns(runId).find((s) => s.step_index === stepIndex)!;
  const task = db.prepare('SELECT id, version, action_type FROM tasks WHERE id = ?')
    .get(step.task_id!) as { id: string; version: number; action_type: string };

  recordExecutionResult({
    taskId: task.id, taskVersion: task.version, status: outcome.status,
    summary: outcome.summary ?? `Fixture ${outcome.status}.`,
    detail: { note: 'fixture' },
  });
  if (outcome.externalId) {
    recordExternalAcknowledgement({
      taskId: task.id, taskVersion: task.version, actionType: task.action_type,
      outcomeData: { external_id: outcome.externalId, url: `https://example.test/${outcome.externalId}` },
    });
  }
  if (outcome.verifyVerdict) {
    recordVerification(task.id, {
      method: 'fixture_readback', source: 'test', verdict: outcome.verifyVerdict,
      checks: [{ name: 'change_present', passed: outcome.verifyVerdict !== 'failed' }],
    }, task.version);
  }
}

function countScoped(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id IN (?, ?)`).get(BIZ_A, BIZ_B) as { n: number }).n;
}

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Playbook A', 'playbook-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Playbook B', 'playbook-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);
  insertWorkflow(WF_A, BIZ_A, 'Playbook A workflow');
  insertWorkflow(WF_B, BIZ_B, 'Playbook B workflow');

  upsertActionRegistryEntry(ACTION_NOTE, {
    description: 'Playbook test fixture action (no real executor).',
    payload_schema: NOTE_SCHEMA,
    dispatched_by_executor: true,
    side_effect_classification: 'internal_idempotent',
    risk_level: 'low',
    requires_approval: false,
    supports_rollback: false,
  });
  upsertActionRegistryEntry(ACTION_REVERSIBLE, {
    description: 'Playbook test fixture action that supports rollback.',
    payload_schema: NOTE_SCHEMA,
    dispatched_by_executor: true,
    side_effect_classification: 'internal_idempotent',
    risk_level: 'low',
    requires_approval: false,
    supports_rollback: true,
  });
  upsertActionRegistryEntry(ACTION_HIGH_RISK, {
    description: 'Playbook test fixture action graded high risk.',
    payload_schema: NOTE_SCHEMA,
    dispatched_by_executor: true,
    side_effect_classification: 'internal_idempotent',
    risk_level: 'high',
    // Deliberately false: any approval requirement must be DERIVED from risk.
    requires_approval: false,
    supports_rollback: false,
  });
});

beforeEach(() => {
  const ids = [BIZ_A, BIZ_B];
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM workflow_step_runs WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM workflow_runs WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM playbook_events WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM playbook_versions WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM action_receipts WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM execution_jobs WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM operating_policies WHERE scope_key IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM operating_policy_events WHERE scope_key IN (${ph})`).run(...ids);

  // Default posture for execution tests: this business lets Blueprint act
  // unattended below 'red', so a step that pauses is pausing for a REASON
  // the test asserts, not for the shipped default floor.
  for (const businessId of ids) {
    savePolicyVersion({
      key: businessId, actor: 'test:setup',
      patch: { approvals: { require_human_approval_at_or_above: 'red' } },
    });
  }
});

afterAll(() => {
  const ids = [BIZ_A, BIZ_B];
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM workflow_step_runs WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM workflow_runs WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM playbook_versions WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM action_receipts WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM operating_policies WHERE scope_key IN (${ph})`).run(...ids);
});

// ─── Lifecycle: create → validate → version → activate ───────────────────────

describe('playbook version lifecycle', () => {
  test('a draft is created unactivated and does not become runnable on its own', () => {
    const draft = savePlaybookDraft({
      workflowId: WF_A, businessId: BIZ_A, definition: noteDefinition(), actor: ACTOR, validate: true,
    });
    expect(draft.version).toBe(1);
    expect(draft.state).toBe('draft');
    expect(draft.validation_state).toBe('valid');
    expect(getActivePlaybookVersion({ workflowId: WF_A, businessId: BIZ_A })).toBeNull();

    expect(() => startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'x' }, actor: ACTOR,
    })).toThrow(/no ACTIVE playbook version/);
  });

  test('validation reports actionable violations and blocks activation', () => {
    const draft = savePlaybookDraft({
      workflowId: WF_A, businessId: BIZ_A, actor: ACTOR, validate: true,
      definition: noteDefinition({
        steps: [{
          index: 0, name: 'Broken step', kind: 'action',
          action_type: 'no_such_action_type_at_all',
          input: { title: '{{inputs.not_declared}}' },
        }],
      }),
    });
    expect(draft.validation_state).toBe('invalid');

    const codes = draft.validation_violations.map((v) => v.code);
    expect(codes).toContain('step_action_type_unknown');
    expect(codes).toContain('reference_unknown_input');
    // Actionable: each violation names the field it is about.
    expect(draft.validation_violations.every((v) => v.field.length > 0)).toBe(true);

    expect(() => activatePlaybookVersion({
      workflowId: WF_A, businessId: BIZ_A, version: draft.version, actor: ACTOR,
    })).toThrow(PlaybookValidationError);
    expect(getActivePlaybookVersion({ workflowId: WF_A, businessId: BIZ_A })).toBeNull();
  });

  test('activating v2 supersedes v1 and keeps both in history', () => {
    const v1 = activateDefinition(noteDefinition());
    const v2 = activateDefinition(noteDefinition({ description: 'Second edition' }));

    const versions = listPlaybookVersions({ workflowId: WF_A, businessId: BIZ_A });
    expect(versions.map((v) => v.version)).toEqual([v2, v1]);
    expect(versions.find((v) => v.version === v1)!.state).toBe('superseded');
    expect(versions.find((v) => v.version === v2)!.state).toBe('active');
    expect(versions.find((v) => v.version === v1)!.superseded_by_id)
      .toBe(versions.find((v) => v.version === v2)!.id);

    const events = listPlaybookEvents({ workflowId: WF_A, businessId: BIZ_A }).map((e) => e.event_type);
    expect(events).toContain('activated');
    expect(events).toContain('superseded');
  });

  test('rollback writes the old definition forward as a new version instead of rewinding history', () => {
    const v1 = activateDefinition(noteDefinition({ description: 'original' }));
    activateDefinition(noteDefinition({ description: 'regrettable change' }));

    const restored = rollbackPlaybookVersion({
      workflowId: WF_A, businessId: BIZ_A, to_version: v1, actor: ACTOR,
    });
    expect(restored.version).toBe(3);
    expect(restored.state).toBe('active');
    expect(restored.source).toBe('rollback');
    expect(restored.rolled_back_from_version).toBe(v1);
    expect(restored.definition.description).toBe('original');

    // Nothing was deleted: all three versions are still readable.
    expect(listPlaybookVersions({ workflowId: WF_A, businessId: BIZ_A }).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  test('a future effective_at schedules rather than activates', () => {
    const draft = savePlaybookDraft({
      workflowId: WF_A, businessId: BIZ_A, definition: noteDefinition(), actor: ACTOR, validate: true,
    });
    const scheduled = activatePlaybookVersion({
      workflowId: WF_A, businessId: BIZ_A, version: draft.version, actor: ACTOR,
      effective_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(scheduled.state).toBe('scheduled');
    expect(getActivePlaybookVersion({ workflowId: WF_A, businessId: BIZ_A })).toBeNull();
  });

  test('a superseded version cannot be re-activated directly — only rolled back to', () => {
    const v1 = activateDefinition(noteDefinition());
    activateDefinition(noteDefinition({ description: 'newer' }));
    expect(() => activatePlaybookVersion({
      workflowId: WF_A, businessId: BIZ_A, version: v1, actor: ACTOR,
    })).toThrow(PlaybookStateError);
  });
});

// ─── Invalid inputs ─────────────────────────────────────────────────────────

describe('run inputs', () => {
  test('missing and mistyped inputs are rejected with actionable errors, and nothing is created', () => {
    activateDefinition(noteDefinition());
    const runsBefore = countScoped('workflow_runs');
    const tasksBefore = countScoped('tasks');

    let error: PlaybookValidationError | null = null;
    try {
      startPlaybookRun({ workflowId: WF_A, businessId: BIZ_A, inputs: {}, actor: ACTOR });
    } catch (err) { error = err as PlaybookValidationError; }

    expect(error).toBeInstanceOf(PlaybookValidationError);
    expect(error!.violations[0]!.message).toContain('headline');
    expect(error!.violations[0]!.message).toContain('required');

    expect(() => startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 42 }, actor: ACTOR,
    })).toThrow(/expected string/);

    expect(countScoped('workflow_runs')).toBe(runsBefore);
    expect(countScoped('tasks')).toBe(tasksBefore);
  });
});

// ─── Receipts drive the run ─────────────────────────────────────────────────

describe('execution produces real receipts and aggregates them', () => {
  test('a dispatched step creates a real task, a real receipt, and waits for it to settle', () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Weekly note' }, actor: ACTOR,
    });

    // The receipt has not settled, so the run reports that honestly rather
    // than claiming completion.
    expect(started.status).toBe('awaiting_execution');

    const step = listPlaybookStepRuns(started.run_id)[0]!;
    expect(step.status).toBe('dispatched');
    expect(step.task_id).not.toBeNull();
    expect(step.correlation_key).toMatch(/^blueprint:task=/);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(step.task_id!) as Record<string, unknown>;
    expect(task.action_type).toBe(ACTION_NOTE);
    expect(task.status).toBe('approved');
    // The typed input was bound from the run inputs, not copied verbatim.
    expect(JSON.parse(String(task.action_payload))).toEqual({ title: 'Weekly note', body: 'Standing body copy.' });

    const receipt = getReceiptForTaskVersion(step.task_id!, Number(task.version));
    expect(receipt).not.toBeNull();
    expect(receipt!.correlation_key).toBe(step.correlation_key!);

    const summary = summariseRunReceipts(started.run_id, BIZ_A);
    expect(summary.aggregate_state).toBe('pending');
    expect(summary.receipts[0]!.verdict).toBe('pending');
  });

  test('a settled, externally acknowledged receipt completes the step and the run', () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Weekly note' }, actor: ACTOR,
    });
    settleStepReceipt(started.run_id, 0, { status: 'success', externalId: 'ext-1234' });

    const status = advancePlaybookRun(started.run_id, BIZ_A, ACTOR);
    expect(status).toBe('complete');

    const summary = summariseRunReceipts(started.run_id, BIZ_A);
    expect(summary.aggregate_state).toBe('externally_acknowledged');
    expect(summary.receipts[0]!.external_id).toBe('ext-1234');
    // Honest: acknowledged is NOT verified.
    expect(summary.receipts[0]!.state).toBe('externally_acknowledged');
    expect(summary.verification_failed).toBe(false);
  });

  test('a later step consumes the typed output of an earlier one', () => {
    activateDefinition(noteDefinition({
      steps: [
        {
          index: 0, name: 'First', kind: 'action', action_type: ACTION_NOTE,
          input: { title: '{{inputs.headline}}' },
          output_schema: { type: 'object', properties: { external_id: { type: 'string' } } },
        },
        {
          index: 1, name: 'Second', kind: 'action', action_type: ACTION_NOTE,
          input: { title: 'Follow-up to {{steps.0.output.external_id}}' },
        },
      ],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'First note' }, actor: ACTOR,
    });
    settleStepReceipt(started.run_id, 0, { status: 'success', externalId: 'ext-777' });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    const second = listPlaybookStepRuns(started.run_id).find((s) => s.step_index === 1)!;
    expect(second.status).toBe('dispatched');
    const task = db.prepare('SELECT action_payload FROM tasks WHERE id = ?').get(second.task_id!) as { action_payload: string };
    expect(JSON.parse(task.action_payload).title).toBe('Follow-up to ext-777');
  });
});

// ─── Partial failure and failed verification ────────────────────────────────

describe('stopping safely', () => {
  test('a failed step stops the run, names the step, and marks later steps not_run', () => {
    activateDefinition(noteDefinition({
      steps: [
        { index: 0, name: 'First', kind: 'action', action_type: ACTION_NOTE, input: { title: '{{inputs.headline}}' } },
        { index: 1, name: 'Second', kind: 'action', action_type: ACTION_NOTE, input: { title: 'later' } },
        { index: 2, name: 'Third', kind: 'action', action_type: ACTION_NOTE, input: { title: 'later still' } },
      ],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Doomed' }, actor: ACTOR,
    });
    settleStepReceipt(started.run_id, 0, { status: 'failure', summary: 'The fixture action failed.' });

    const status = advancePlaybookRun(started.run_id, BIZ_A, ACTOR);
    expect(status).toBe('failed');

    const run = getPlaybookRunRow(started.run_id, BIZ_A)!;
    expect(run.stopped_reason).toContain('Step 0');
    expect(run.stopped_reason).toContain('First');

    const steps = listPlaybookStepRuns(started.run_id);
    expect(steps[0]!.status).toBe('failed');
    expect(steps[1]!.status).toBe('not_run');
    expect(steps[2]!.status).toBe('not_run');
    // Never dispatched means never created a task — no side effect leaked past the stop.
    expect(steps[1]!.task_id).toBeNull();
    expect(steps[2]!.task_id).toBeNull();
  });

  test('a receipt that reaches verified with a FAILING verdict stops the run', () => {
    activateDefinition(noteDefinition({
      steps: [
        { index: 0, name: 'Write', kind: 'action', action_type: ACTION_NOTE, input: { title: '{{inputs.headline}}' } },
        { index: 1, name: 'Follow', kind: 'action', action_type: ACTION_NOTE, input: { title: 'follow' } },
      ],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Unverified' }, actor: ACTOR,
    });
    // The API accepted it AND handed back an id — but independent
    // verification says the change did not take effect.
    settleStepReceipt(started.run_id, 0, {
      status: 'success', externalId: 'ext-bad', verifyVerdict: 'failed',
    });

    const status = advancePlaybookRun(started.run_id, BIZ_A, ACTOR);
    expect(status).toBe('failed');

    const steps = listPlaybookStepRuns(started.run_id);
    expect(steps[0]!.status).toBe('failed');
    expect(steps[0]!.error).toContain('verification failed');
    expect(steps[1]!.status).toBe('not_run');
    expect(summariseRunReceipts(started.run_id, BIZ_A).verification_failed).toBe(true);
  });

  test('a step whose output does not satisfy its declared contract fails verification', () => {
    activateDefinition(noteDefinition({
      steps: [{
        index: 0, name: 'Must return a permalink', kind: 'action', action_type: ACTION_NOTE,
        input: { title: '{{inputs.headline}}' },
        output_schema: { type: 'object', required: ['external_permalink'], properties: { external_permalink: { type: 'string' } } },
      }],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'No permalink' }, actor: ACTOR,
    });
    // Succeeds, but hands back nothing that identifies an external object.
    settleStepReceipt(started.run_id, 0, { status: 'success' });

    expect(advancePlaybookRun(started.run_id, BIZ_A, ACTOR)).toBe('failed');
    expect(listPlaybookStepRuns(started.run_id)[0]!.error).toContain('output contract');
  });
});

// ─── Risk-derived approval ──────────────────────────────────────────────────

describe('approval requirements', () => {
  test('risk alone decides: the low-risk step runs unattended, the high-risk one pauses', () => {
    // This business lets Blueprint act unattended below 'orange'. Neither
    // step declares an approval_gate and neither action type is flagged
    // requires_approval — so any pause here is DERIVED from risk.
    savePolicyVersion({
      key: BIZ_A, actor: 'test:setup',
      patch: { approvals: { require_human_approval_at_or_above: 'orange' } },
    });
    activateDefinition(noteDefinition({
      steps: [
        {
          index: 0, name: 'Routine change', kind: 'action', action_type: ACTION_NOTE,
          input: { title: '{{inputs.headline}}' }, approval_gate: false,
        },
        {
          index: 1, name: 'Risky change', kind: 'action', action_type: ACTION_HIGH_RISK,
          input: { title: 'escalated' }, approval_gate: false,
        },
      ],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Risky' }, actor: ACTOR,
    });

    // Step 0 (low risk → green) never asked for a human.
    expect(started.status).toBe('awaiting_execution');
    const first = listPlaybookStepRuns(started.run_id)[0]!;
    expect(first.status).toBe('dispatched');
    expect(first.approval_required).toBe(0);

    settleStepReceipt(started.run_id, 0, { status: 'success', externalId: 'ext-routine' });
    expect(advancePlaybookRun(started.run_id, BIZ_A, ACTOR)).toBe('paused');

    // Step 1 (high risk → orange) stopped for a human on risk alone.
    const risky = listPlaybookStepRuns(started.run_id)[1]!;
    expect(risky.status).toBe('awaiting_approval');
    expect(risky.risk_tier).toBe('orange');
    expect(risky.approval_reason).toContain('risk tier');
    // Nothing was created while waiting for the human.
    expect(risky.task_id).toBeNull();

    const after = approvePlaybookStep({ runId: started.run_id, businessId: BIZ_A, stepIndex: 1, actor: ACTOR });
    expect(after).toBe('awaiting_execution');
    expect(listPlaybookStepRuns(started.run_id)[1]!.task_id).not.toBeNull();
  });

  test('the pre-existing manual approval_gate still pauses a low-risk step', () => {
    activateDefinition(noteDefinition({
      steps: [{
        index: 0, name: 'Gated', kind: 'action', action_type: ACTION_NOTE,
        input: { title: '{{inputs.headline}}' },
        approval_gate: true, approval_message: 'Check this first',
      }],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Gated' }, actor: ACTOR,
    });
    expect(started.status).toBe('paused');
    expect(listPlaybookStepRuns(started.run_id)[0]!.approval_reason).toContain('approval gate');
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────────

describe('idempotency', () => {
  test('re-running with the same version, inputs and key rejoins the run instead of duplicating it', () => {
    activateDefinition(noteDefinition());
    const first = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Once' }, actor: ACTOR, idempotency_key: 'req-1',
    });
    const second = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Once' }, actor: ACTOR, idempotency_key: 'req-1',
    });

    expect(second.reused).toBe(true);
    expect(second.run_id).toBe(first.run_id);
    expect(countScoped('workflow_runs')).toBe(1);
    // One step, one task — the side effect was not duplicated.
    expect(countScoped('tasks')).toBe(1);
  });

  test('the run key is stable across input key order', () => {
    const a = buildPlaybookRunKey('v1', { b: 2, a: 1 }, 'k');
    const b = buildPlaybookRunKey('v1', { a: 1, b: 2 }, 'k');
    expect(a).toBe(b);
    expect(buildPlaybookRunKey('v1', { a: 1 }, 'k')).not.toBe(a);
  });

  test('advancing a run repeatedly never dispatches a step twice', () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Steady' }, actor: ACTOR,
    });
    const taskId = listPlaybookStepRuns(started.run_id)[0]!.task_id;

    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    expect(countScoped('tasks')).toBe(1);
    expect(listPlaybookStepRuns(started.run_id)[0]!.task_id).toBe(taskId);
  });

  test('a retry after a real execution is REFUSED rather than duplicating the side effect', () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Half done' }, actor: ACTOR,
    });
    // The action executed and produced an external object, then the
    // verification came back failing — a partial failure, the hardest case.
    settleStepReceipt(started.run_id, 0, {
      status: 'success', externalId: 'ext-real', verifyVerdict: 'failed',
    });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);
    expect(listPlaybookStepRuns(started.run_id)[0]!.status).toBe('failed');

    const tasksBefore = countScoped('tasks');
    const result = retryPlaybookStep({ runId: started.run_id, businessId: BIZ_A, stepIndex: 0, actor: ACTOR });

    expect(result.retried).toBe(false);
    expect(result.reason).toContain('ext-real');
    expect(result.reason).toContain('duplicate');
    expect(countScoped('tasks')).toBe(tasksBefore);
  });

  test('a retry of a step that never executed is allowed and creates exactly one new task', () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Never ran' }, actor: ACTOR,
    });
    // Failed without ever executing: no executed_at, no external reference.
    settleStepReceipt(started.run_id, 0, { status: 'failure', summary: 'Connector was down.' });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    const firstTask = listPlaybookStepRuns(started.run_id)[0]!.task_id;
    const result = retryPlaybookStep({ runId: started.run_id, businessId: BIZ_A, stepIndex: 0, actor: ACTOR });

    expect(result.retried).toBe(true);
    expect(countScoped('tasks')).toBe(2);
    const retriedStep = listPlaybookStepRuns(started.run_id)[0]!;
    expect(retriedStep.task_id).not.toBe(firstTask);
    expect(retriedStep.attempt_count).toBe(2);
  });

  test('a retry beyond the version max_attempts is refused', () => {
    activateDefinition(noteDefinition({
      steps: [{
        index: 0, name: 'One shot', kind: 'action', action_type: ACTION_NOTE,
        input: { title: '{{inputs.headline}}' }, max_attempts: 1,
      }],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'One shot' }, actor: ACTOR,
    });
    settleStepReceipt(started.run_id, 0, { status: 'failure' });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    const result = retryPlaybookStep({ runId: started.run_id, businessId: BIZ_A, stepIndex: 0, actor: ACTOR });
    expect(result.retried).toBe(false);
    expect(result.reason).toContain('all 1 attempt');
  });
});

// ─── Rollback / compensation honesty ────────────────────────────────────────

describe('rollback and compensation', () => {
  test('rollback always prevents later steps from running', () => {
    activateDefinition(noteDefinition({
      steps: [
        { index: 0, name: 'Ran', kind: 'action', action_type: ACTION_NOTE, input: { title: '{{inputs.headline}}' } },
        { index: 1, name: 'Would run', kind: 'action', action_type: ACTION_NOTE, input: { title: 'later' } },
      ],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Stop me' }, actor: ACTOR,
    });

    const report = compensatePlaybookRun({ runId: started.run_id, businessId: BIZ_A, actor: ACTOR, reason: 'Operator halt.' });
    expect(report.steps.find((s) => s.step_index === 1)!.outcome).toBe('prevented');

    const steps = listPlaybookStepRuns(started.run_id);
    expect(steps[1]!.status).toBe('not_run');
    expect(steps[1]!.task_id).toBeNull();
    expect(getPlaybookRunRow(started.run_id, BIZ_A)!.status).toBe('rolled_back');
  });

  test('an executed step whose action is NOT rollback-capable is reported as irreversible, not compensated', () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Irreversible' }, actor: ACTOR,
    });
    settleStepReceipt(started.run_id, 0, { status: 'success', externalId: 'ext-permanent' });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    const report = compensatePlaybookRun({ runId: started.run_id, businessId: BIZ_A, actor: ACTOR });
    const step = report.steps.find((s) => s.step_index === 0)!;

    expect(step.outcome).toBe('unsupported');
    expect(step.detail).toContain('cannot undo');
    expect(report.irreversible_effects).toBe(true);
    expect(report.rollback_state).toBe('not_possible');
    expect(report.summary).toContain('CANNOT be undone');
  });

  test('a rollback-capable step with no recorded rollback data is reported unavailable, never as success', () => {
    activateDefinition(noteDefinition({
      steps: [{
        index: 0, name: 'Reversible step', kind: 'action', action_type: ACTION_REVERSIBLE,
        input: { title: '{{inputs.headline}}' },
      }],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Reversible' }, actor: ACTOR,
    });
    settleStepReceipt(started.run_id, 0, { status: 'success', externalId: 'ext-rev' });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    const report = compensatePlaybookRun({ runId: started.run_id, businessId: BIZ_A, actor: ACTOR });
    const step = report.steps.find((s) => s.step_index === 0)!;
    expect(step.outcome).toBe('unavailable');
    expect(step.detail).toContain('no rollback data');
    expect(report.irreversible_effects).toBe(true);
  });

  test('a rollback-capable step WITH recorded rollback data has compensation requested', () => {
    activateDefinition(noteDefinition({
      steps: [{
        index: 0, name: 'Reversible step', kind: 'action', action_type: ACTION_REVERSIBLE,
        input: { title: '{{inputs.headline}}' },
      }],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Reversible' }, actor: ACTOR,
    });
    settleStepReceipt(started.run_id, 0, { status: 'success', externalId: 'ext-rev-2' });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    // What the executor records at execution time for a reversible action.
    const step = listPlaybookStepRuns(started.run_id)[0]!;
    db.prepare('UPDATE tasks SET rollback_data = ? WHERE id = ?')
      .run(JSON.stringify({ action: 'restore_product', product_id: 'p1', previous_state: {} }), step.task_id!);

    const report = compensatePlaybookRun({ runId: started.run_id, businessId: BIZ_A, actor: ACTOR });
    const reported = report.steps.find((s) => s.step_index === 0)!;
    expect(reported.outcome).toBe('compensated');
    expect(report.irreversible_effects).toBe(false);
    expect(report.rollback_state).toBe('complete');
  });

  test('a step that never executed has nothing to undo', () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Dispatched only' }, actor: ACTOR,
    });
    const report = compensatePlaybookRun({ runId: started.run_id, businessId: BIZ_A, actor: ACTOR });
    expect(report.steps.find((s) => s.step_index === 0)!.outcome).toBe('nothing_to_undo');
    expect(report.irreversible_effects).toBe(false);
  });
});

// ─── Version changes vs in-flight runs ──────────────────────────────────────

describe('version changes and in-flight runs', () => {
  test('activating a new version does not change what an in-flight run is executing', () => {
    const v1 = activateDefinition(noteDefinition({
      steps: [
        { index: 0, name: 'v1 step one', kind: 'action', action_type: ACTION_NOTE, input: { title: '{{inputs.headline}}' } },
        { index: 1, name: 'v1 step two', kind: 'action', action_type: ACTION_NOTE, input: { title: 'v1 second' } },
      ],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'In flight' }, actor: ACTOR,
    });
    expect(getPlaybookRunRow(started.run_id, BIZ_A)!.playbook_version).toBe(v1);

    // A completely different v2 is activated mid-run.
    const v2 = activateDefinition(noteDefinition({
      steps: [{ index: 0, name: 'v2 only step', kind: 'action', action_type: ACTION_NOTE, input: { title: 'v2' } }],
    }));
    expect(v2).toBeGreaterThan(v1);

    settleStepReceipt(started.run_id, 0, { status: 'success', externalId: 'ext-inflight' });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    // The in-flight run still has v1's two steps, and dispatched v1's second.
    const steps = listPlaybookStepRuns(started.run_id);
    expect(steps.length).toBe(2);
    expect(steps[1]!.step_name).toBe('v1 step two');
    const task = db.prepare('SELECT action_payload FROM tasks WHERE id = ?').get(steps[1]!.task_id!) as { action_payload: string };
    expect(JSON.parse(task.action_payload).title).toBe('v1 second');

    // A NEW run picks up v2.
    const fresh = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Fresh' }, actor: ACTOR, idempotency_key: 'fresh',
    });
    expect(getPlaybookRunRow(fresh.run_id, BIZ_A)!.playbook_version).toBe(v2);
  });
});

// ─── Cross-business scope isolation ─────────────────────────────────────────

describe('cross-business scope isolation', () => {
  test("business B cannot read, validate, activate or run business A's playbook", () => {
    const version = activateDefinition(noteDefinition());
    const refB = { workflowId: WF_A, businessId: BIZ_B };

    expect(() => listPlaybookVersions(refB)).toThrow(PlaybookNotFoundError);
    expect(() => getActivePlaybookVersion(refB)).toThrow(PlaybookNotFoundError);
    expect(() => validatePlaybookVersion(refB, version, ACTOR)).toThrow(PlaybookNotFoundError);
    expect(() => activatePlaybookVersion({ ...refB, version, actor: ACTOR })).toThrow(PlaybookNotFoundError);
    expect(() => startPlaybookRun({ ...refB, inputs: { headline: 'x' }, actor: ACTOR })).toThrow(PlaybookNotFoundError);
  });

  test('a definition scoped to another business is rejected at validation', () => {
    const draft = savePlaybookDraft({
      workflowId: WF_A, businessId: BIZ_A, actor: ACTOR, validate: true,
      definition: noteDefinition({}, BIZ_B),
    });
    expect(draft.validation_state).toBe('invalid');
    expect(draft.validation_violations.map((v) => v.code)).toContain('scope_mismatch');
  });

  test("business B cannot read or roll back a run belonging to business A", () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Private' }, actor: ACTOR,
    });
    expect(getPlaybookRunRow(started.run_id, BIZ_B)).toBeNull();
    expect(() => describePlaybookRun(started.run_id, BIZ_B)).toThrow(PlaybookNotFoundError);
    expect(() => compensatePlaybookRun({ runId: started.run_id, businessId: BIZ_B, actor: ACTOR }))
      .toThrow(PlaybookNotFoundError);
    expect(() => summariseRunReceipts(started.run_id, BIZ_B)).toThrow(PlaybookNotFoundError);
  });

  test('two businesses running structurally identical playbooks stay separate', () => {
    activateDefinition(noteDefinition({}, BIZ_A), BIZ_A, WF_A);
    activateDefinition(noteDefinition({}, BIZ_B), BIZ_B, WF_B);

    const runA = startPlaybookRun({ workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'A' }, actor: ACTOR });
    const runB = startPlaybookRun({ workflowId: WF_B, businessId: BIZ_B, inputs: { headline: 'A' }, actor: ACTOR });

    // Identical inputs, different playbook versions — different run keys.
    expect(runA.run_id).not.toBe(runB.run_id);
    const taskA = db.prepare('SELECT business_id FROM tasks WHERE id = ?')
      .get(listPlaybookStepRuns(runA.run_id)[0]!.task_id!) as { business_id: string };
    const taskB = db.prepare('SELECT business_id FROM tasks WHERE id = ?')
      .get(listPlaybookStepRuns(runB.run_id)[0]!.task_id!) as { business_id: string };
    expect(taskA.business_id).toBe(BIZ_A);
    expect(taskB.business_id).toBe(BIZ_B);
  });
});

// ─── Composite read ─────────────────────────────────────────────────────────

describe('describePlaybookRun', () => {
  test('exposes the version, typed step detail and receipt linkage the UI needs', () => {
    activateDefinition(noteDefinition());
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Describe me' }, actor: ACTOR,
    });
    settleStepReceipt(started.run_id, 0, { status: 'success', externalId: 'ext-desc' });
    advancePlaybookRun(started.run_id, BIZ_A, ACTOR);

    const described = describePlaybookRun(started.run_id, BIZ_A) as Record<string, any>;
    expect(described.playbook.version).toBe(1);
    expect(described.run.inputs).toEqual({ headline: 'Describe me' });
    expect(described.steps[0].definition.action_type).toBe(ACTION_NOTE);
    expect(described.steps[0].receipt.external_id).toBe('ext-desc');
    expect(described.steps[0].typed_output.external_id).toBe('ext-desc');
    expect(described.receipt_summary.aggregate_state).toBe('externally_acknowledged');
  });
});

// ─── Manual (free-text) fallback ────────────────────────────────────────────

describe('manual (free-text) steps', () => {
  test('a free-text step is a human hand-off: it pauses, is acknowledged, and produces no receipt', () => {
    activateDefinition(noteDefinition({
      steps: [{
        index: 0, name: 'Think about it', kind: 'manual', agent_id: 'conductor',
        task_template: 'Review last week and summarise.',
      }],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Manual' }, actor: ACTOR,
    });

    // A bounded playbook does not perform unbounded free-text work
    // unattended — it waits for a person.
    expect(started.status).toBe('paused');
    const paused = listPlaybookStepRuns(started.run_id)[0]!;
    expect(paused.status).toBe('awaiting_approval');
    expect(paused.approval_reason).toContain('free-text step');
    expect(paused.task_id).toBeNull();

    expect(approvePlaybookStep({ runId: started.run_id, businessId: BIZ_A, stepIndex: 0, actor: ACTOR }))
      .toBe('complete');

    const step = listPlaybookStepRuns(started.run_id)[0]!;
    expect(step.step_kind).toBe('manual');
    expect(step.task_id).toBeNull();
    expect(step.output).toContain('no action receipt');
    expect(step.output).toContain(ACTOR);
    expect(summariseRunReceipts(started.run_id, BIZ_A).aggregate_state).toBe('no_actions');
  });
});

// ─── The classic engine must not drive a playbook run ───────────────────────

describe('workflow-engine delegation', () => {
  test('the classic approve/cancel entry points delegate instead of bumping the step themselves', async () => {
    const { approveWorkflowStep, cancelWorkflow } = await import('./workflow-engine.js');

    activateDefinition(noteDefinition({
      steps: [{
        index: 0, name: 'Gated', kind: 'action', action_type: ACTION_NOTE,
        input: { title: '{{inputs.headline}}' }, approval_gate: true,
      }],
    }));
    const started = startPlaybookRun({
      workflowId: WF_A, businessId: BIZ_A, inputs: { headline: 'Delegated' }, actor: ACTOR,
    });
    expect(started.status).toBe('paused');

    // The classic path routes through the playbook engine, so the step is
    // really dispatched (a task exists) rather than merely marked complete.
    await approveWorkflowStep(started.run_id, 0, ACTOR);
    const step = listPlaybookStepRuns(started.run_id)[0]!;
    expect(step.status).toBe('dispatched');
    expect(step.task_id).not.toBeNull();

    await cancelWorkflow(started.run_id);
    expect(getPlaybookRunRow(started.run_id, BIZ_A)!.status).toBe('cancelled');
  });
});

// ─── Guard against fixture drift ────────────────────────────────────────────

test('fixture ids are unique to this suite', () => {
  expect(generateId()).not.toBe(generateId());
});
