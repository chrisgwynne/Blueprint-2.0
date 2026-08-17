/**
 * Playbook definition schema, binding and validation (#74).
 *
 * These are the pure units the lifecycle and the engine both depend on:
 * if a reference binds to the wrong type, or a forward reference is
 * accepted, every downstream guarantee is built on sand.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../db/db.js';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';
import {
  parsePlaybookDefinition, validatePlaybookDefinition, validateRunInputs,
  bindTemplate, extractReferences, validateTemplateAgainstSchema,
  MAX_STEP_TIMEOUT_SECONDS, MAX_STEP_ATTEMPTS,
} from './playbook-schema.js';

const BIZ = 'biz_playbook_schema';
const ACTION = 'test_playbook_schema_action';
const ACTION_EXTERNAL = 'test_playbook_schema_external';

function def(steps: unknown[], extra: Record<string, unknown> = {}) {
  return parsePlaybookDefinition({
    name: 'Schema fixture',
    business_scope: { business_id: BIZ, business_types: [] },
    inputs: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' }, size: { type: 'number' } } },
    steps,
    ...extra,
  }, BIZ);
}

function codes(steps: unknown[], extra: Record<string, unknown> = {}): string[] {
  return validatePlaybookDefinition(def(steps, extra), { businessId: BIZ }).map((v) => v.code);
}

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Schema Biz', 'schema-biz') ON CONFLICT(id) DO NOTHING").run(BIZ);
  upsertActionRegistryEntry(ACTION, {
    description: 'Schema fixture action.',
    payload_schema: {
      type: 'object', required: ['title'],
      properties: { title: { type: 'string', minLength: 1 }, count: { type: 'number', minimum: 0 } },
    },
    side_effect_classification: 'internal_idempotent', risk_level: 'low', requires_approval: false,
  });
  upsertActionRegistryEntry(ACTION_EXTERNAL, {
    description: 'Schema fixture action with external side effects.',
    payload_schema: { type: 'object', properties: { title: { type: 'string' } } },
    side_effect_classification: 'external_verifiable', risk_level: 'medium', requires_approval: true,
  });
});

// ─── Reference binding ──────────────────────────────────────────────────────

describe('bindTemplate', () => {
  test('a whole-string reference preserves the referenced value\'s type', () => {
    const bound = bindTemplate(
      { count: '{{inputs.size}}', flag: '{{inputs.on}}' },
      { inputs: { size: 12, on: true }, steps: {} },
    );
    expect(bound.value).toEqual({ count: 12, flag: true });
    expect(bound.unresolved).toEqual([]);
  });

  test('an embedded reference interpolates as text', () => {
    const bound = bindTemplate(
      { title: 'Report on {{inputs.topic}} (#{{inputs.size}})' },
      { inputs: { topic: 'pricing', size: 3 }, steps: {} },
    );
    expect(bound.value).toEqual({ title: 'Report on pricing (#3)' });
  });

  test('step outputs bind by index and path', () => {
    const bound = bindTemplate(
      { title: '{{steps.0.output.external_id}}', whole: '{{steps.0.output}}' },
      { inputs: {}, steps: { 0: { output: { external_id: 'ext-9' } } } },
    );
    expect(bound.value).toEqual({ title: 'ext-9', whole: { external_id: 'ext-9' } });
  });

  test('an unresolvable reference is REPORTED, never silently blanked', () => {
    const bound = bindTemplate({ title: '{{steps.3.output.url}}' }, { inputs: {}, steps: {} });
    expect(bound.unresolved).toEqual(['{{steps.3.output.url}}']);
    // The original token survives, so a downstream schema check fails
    // loudly instead of seeing a plausible-looking empty string.
    expect(bound.value).toEqual({ title: '{{steps.3.output.url}}' });
  });

  test('nested objects and arrays are bound throughout', () => {
    const bound = bindTemplate(
      { outer: { list: ['{{inputs.topic}}', { deep: '{{inputs.size}}' }] } },
      { inputs: { topic: 'x', size: 1 }, steps: {} },
    );
    expect(bound.value).toEqual({ outer: { list: ['x', { deep: 1 }] } });
  });

  test('extractReferences finds every token across a nested structure', () => {
    const refs = extractReferences({ a: '{{inputs.topic}}', b: ['{{steps.1.output.url}}'] });
    expect(refs.map((r) => r.token).sort()).toEqual(['{{inputs.topic}}', '{{steps.1.output.url}}']);
    expect(refs.find((r) => r.root === 'steps')!.path).toBe('1.output.url');
  });
});

// ─── Template-aware schema validation ───────────────────────────────────────

describe('validateTemplateAgainstSchema', () => {
  const schema = {
    type: 'object' as const, required: ['title'],
    properties: { title: { type: 'string' as const }, count: { type: 'number' as const } },
  };

  test('defers a leaf that still carries a reference', () => {
    expect(validateTemplateAgainstSchema(schema, { title: '{{inputs.topic}}', count: '{{inputs.size}}' })).toEqual([]);
  });

  test('still requires the key to be present at all', () => {
    const issues = validateTemplateAgainstSchema(schema, { count: 1 });
    expect(issues.map((i) => i.code)).toEqual(['required']);
  });

  test('validates concrete values normally', () => {
    const issues = validateTemplateAgainstSchema(schema, { title: 'ok', count: 'not a number' });
    expect(issues.map((i) => i.code)).toEqual(['type_mismatch']);
  });
});

// ─── Definition validation ──────────────────────────────────────────────────

describe('validatePlaybookDefinition', () => {
  test('accepts a well-formed typed playbook', () => {
    expect(codes([{
      index: 0, name: 'Do it', kind: 'action', action_type: ACTION,
      input: { title: '{{inputs.topic}}', count: 1 },
    }])).toEqual([]);
  });

  test('rejects a forward reference to a later step', () => {
    expect(codes([
      { index: 0, name: 'First', kind: 'action', action_type: ACTION, input: { title: '{{steps.1.output.x}}' } },
      { index: 1, name: 'Second', kind: 'action', action_type: ACTION, input: { title: 'ok' } },
    ])).toContain('reference_forward');
  });

  test('rejects a self-reference', () => {
    expect(codes([{
      index: 0, name: 'Ouroboros', kind: 'action', action_type: ACTION, input: { title: '{{steps.0.output.x}}' },
    }])).toContain('reference_forward');
  });

  test('rejects a reference to an input the playbook never declares', () => {
    expect(codes([{
      index: 0, name: 'Do it', kind: 'action', action_type: ACTION, input: { title: '{{inputs.nope}}' },
    }])).toContain('reference_unknown_input');
  });

  test('rejects a reference to an output the producing step does not declare', () => {
    expect(codes([
      {
        index: 0, name: 'First', kind: 'action', action_type: ACTION, input: { title: 'a' },
        output_schema: { type: 'object', properties: { external_id: { type: 'string' } } },
      },
      { index: 1, name: 'Second', kind: 'action', action_type: ACTION, input: { title: '{{steps.0.output.nonsense}}' } },
    ])).toContain('reference_unknown_output');
  });

  test('rejects a payload that cannot satisfy the registry schema', () => {
    expect(codes([{
      index: 0, name: 'Do it', kind: 'action', action_type: ACTION, input: { count: -1 },
    }])).toContain('step_input_schema_mismatch');
  });

  test('rejects an action step with no action_type, and a manual step with one', () => {
    expect(codes([{ index: 0, name: 'x', kind: 'action', input: {} }])).toContain('step_action_type_required');
    expect(codes([{
      index: 0, name: 'x', kind: 'manual', action_type: ACTION, agent_id: 'conductor', task_template: 'do',
    }])).toContain('step_manual_has_action_type');
  });

  test('a manual step must actually say what to do, and who does it', () => {
    const found = codes([{ index: 0, name: 'x', kind: 'manual' }]);
    expect(found).toContain('step_task_template_required');
    expect(found).toContain('step_agent_required');
  });

  test('an action step cannot smuggle in a free-text template', () => {
    expect(codes([{
      index: 0, name: 'x', kind: 'action', action_type: ACTION,
      input: { title: 'a' }, task_template: 'also do this',
    }])).toContain('step_action_has_task_template');
  });

  test('timeouts and attempts are bounded', () => {
    expect(codes([{
      index: 0, name: 'x', kind: 'action', action_type: ACTION, input: { title: 'a' },
      timeout_seconds: MAX_STEP_TIMEOUT_SECONDS + 1,
    }])).toContain('step_timeout_too_long');
    expect(codes([{
      index: 0, name: 'x', kind: 'action', action_type: ACTION, input: { title: 'a' }, timeout_seconds: 0,
    }])).toContain('step_timeout_invalid');
    expect(codes([{
      index: 0, name: 'x', kind: 'action', action_type: ACTION, input: { title: 'a' },
      max_attempts: MAX_STEP_ATTEMPTS + 1,
    }])).toContain('step_attempts_invalid');
  });

  test("a failed external write may not be walked past with on_failure 'continue'", () => {
    expect(codes([{
      index: 0, name: 'x', kind: 'action', action_type: ACTION_EXTERNAL,
      input: { title: 'a' }, on_failure: 'continue',
    }])).toContain('step_continue_on_external_side_effect');
    // The same policy is fine for a purely internal, idempotent action.
    expect(codes([{
      index: 0, name: 'x', kind: 'action', action_type: ACTION, input: { title: 'a' }, on_failure: 'continue',
    }])).toEqual([]);
  });

  test('step indexes must be contiguous and unique', () => {
    expect(codes([
      { index: 0, name: 'a', kind: 'action', action_type: ACTION, input: { title: 'a' } },
      { index: 5, name: 'b', kind: 'action', action_type: ACTION, input: { title: 'b' } },
    ])).toContain('step_index_out_of_order');
  });

  test('an empty playbook and a nameless playbook are rejected', () => {
    const found = validatePlaybookDefinition(
      parsePlaybookDefinition({ business_scope: { business_id: BIZ }, steps: [] }, BIZ),
      { businessId: BIZ },
    ).map((v) => v.code);
    expect(found).toContain('name_required');
    expect(found).toContain('steps_required');
  });

  test('a playbook scoped to another business is rejected', () => {
    const found = validatePlaybookDefinition(
      def([{ index: 0, name: 'x', kind: 'action', action_type: ACTION, input: { title: 'a' } }],
        { business_scope: { business_id: 'some_other_business' } }),
      { businessId: BIZ },
    ).map((v) => v.code);
    expect(found).toContain('scope_mismatch');
  });

  test('a business-type restriction is checked against the business', () => {
    const found = validatePlaybookDefinition(
      def([{ index: 0, name: 'x', kind: 'action', action_type: ACTION, input: { title: 'a' } }],
        { business_scope: { business_id: BIZ, business_types: ['ecommerce'] } }),
      { businessId: BIZ, businessType: 'services' },
    ).map((v) => v.code);
    expect(found).toContain('scope_business_type_mismatch');
  });
});

// ─── Run inputs ─────────────────────────────────────────────────────────────

describe('validateRunInputs', () => {
  const definition = def([{ index: 0, name: 'x', kind: 'action', action_type: ACTION, input: { title: 'a' } }]);

  test('accepts inputs that satisfy the declared schema', () => {
    expect(validateRunInputs(definition, { topic: 'pricing' })).toEqual([]);
  });

  test('names the missing field', () => {
    const violations = validateRunInputs(definition, {});
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('topic');
    expect(violations[0]!.code).toBe('input_required');
  });

  test('names the mistyped field', () => {
    const violations = validateRunInputs(definition, { topic: 'ok', size: 'not a number' });
    expect(violations[0]!.message).toContain('size');
    expect(violations[0]!.code).toBe('input_type_mismatch');
  });
});

// ─── Backwards compatibility with pre-#74 steps ─────────────────────────────

describe('parsePlaybookDefinition', () => {
  test('an existing free-text workflow step parses as a manual step with its timeout preserved', () => {
    const parsed = parsePlaybookDefinition({
      name: 'Legacy workflow',
      steps: [{
        index: 0, name: 'Old step', agent_id: 'quill',
        task_template: 'Write something', approval_gate: true, timeout_minutes: 20,
      }],
    }, BIZ);

    expect(parsed.steps[0]!.kind).toBe('manual');
    expect(parsed.steps[0]!.task_template).toBe('Write something');
    expect(parsed.steps[0]!.approval_gate).toBe(true);
    expect(parsed.steps[0]!.timeout_seconds).toBe(1200);
    expect(parsed.business_scope.business_id).toBe(BIZ);
  });

  test('a step that names an action_type is inferred as typed even without an explicit kind', () => {
    const parsed = parsePlaybookDefinition({
      name: 'x', steps: [{ index: 0, name: 'y', action_type: ACTION, input: { title: 'a' } }],
    }, BIZ);
    expect(parsed.steps[0]!.kind).toBe('action');
  });

  test('malformed JSON does not crash the parser — validation reports it instead', () => {
    const parsed = parsePlaybookDefinition('not an object at all', BIZ);
    expect(parsed.steps).toEqual([]);
    expect(validatePlaybookDefinition(parsed, { businessId: BIZ }).map((v) => v.code)).toContain('steps_required');
  });
});
