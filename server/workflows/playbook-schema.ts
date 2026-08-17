/**
 * Playbook definition schema, validation and input binding (issue #74).
 *
 * A playbook is the versioned, bounded form of the workflows that
 * workflow-engine.ts has always run. The engine's own step shape is a
 * free-text `task_template` handed to an agent; that is preserved here as
 * the deliberately-labelled `kind: 'manual'` fallback. What this module
 * adds is the *typed* alternative: `kind: 'action'` steps that name a real
 * action_type from the Typed Action Registry (server/tasks/action-registry
 * .ts) and are therefore bound by that registry's `payload_schema`,
 * `side_effect_classification`, `risk_level`, `requires_approval`,
 * `supports_rollback` and `timeout_ms`.
 *
 * Nothing in this file writes. It is pure schema + validation + binding, so
 * simulation (playbook-simulation.ts) and execution (playbook-engine.ts)
 * validate identically — a preview that says "valid" is a promise the run
 * will keep, the same contract operating-policy.ts's previewPolicyChange()
 * makes.
 *
 * ── Why references are a first-class concept ──────────────────────────────
 *
 * Steps consume each other's output. A free-text template could smuggle
 * anything into the next prompt; a typed step may only reference values
 * that provably exist: `{{inputs.<name>}}` declared in the playbook's own
 * input schema, or `{{steps.<n>.output(.path)}}` where n is an EARLIER
 * step. Both are checked at authoring time, so an unresolvable reference is
 * a validation error on a draft rather than a surprise mid-run.
 */
import type { JsonSchemaLite, ValidationIssue } from '../types/action-registry.js';
import { getActionRegistryEntry, validatePayloadAgainstSchema } from '../tasks/action-registry.js';

/** A step either names a typed registry action, or is honest about being free text. */
export type PlaybookStepKind = 'action' | 'manual';

/**
 * What the run does when this step fails (after its attempts are spent).
 *
 *   stop      — halt the run; later steps are marked not_run. The default,
 *               because a bounded playbook must not carry on past an
 *               unverified step.
 *   continue  — record the failure and proceed. Only legitimate for steps
 *               whose side effects are `internal_idempotent` or none.
 *   rollback  — halt AND attempt compensation of the steps already run
 *               (see compensatePlaybookRun in playbook-engine.ts, which is
 *               explicit that compensation is only possible where the
 *               registry says supports_rollback).
 */
export type StepFailurePolicy = 'stop' | 'continue' | 'rollback';

export interface PlaybookStepDefinition {
  index: number;
  name: string;
  kind: PlaybookStepKind;
  /** Required for kind 'action', forbidden for kind 'manual'. */
  action_type: string | null;
  /** Typed input template for an action step — literals plus {{...}} references. */
  input: Record<string, unknown>;
  /** The step's declared output contract, checked against what the step actually produced. */
  output_schema: JsonSchemaLite | null;
  /** Manual steps only: which agent runs the free-text template. */
  agent_id: string | null;
  /** Manual steps only: the free-text instruction (the pre-#74 `task_template`). */
  task_template: string | null;
  /** The pre-existing manual approval gate. Risk may ADD a gate; it never removes this one. */
  approval_gate: boolean;
  approval_message: string | null;
  timeout_seconds: number;
  /** Total attempts for this step, including the first. Retries never duplicate side effects (see playbook-engine.ts). */
  max_attempts: number;
  on_failure: StepFailurePolicy;
}

export interface PlaybookBusinessScope {
  /** The one business this playbook may run for. Cross-business runs are rejected, never silently re-scoped. */
  business_id: string;
  /** Optional business-type restriction, checked against the business profile. */
  business_types: string[];
}

export interface PlaybookDefinition {
  name: string;
  description: string | null;
  business_scope: PlaybookBusinessScope;
  /** JSON-Schema-lite object schema for the inputs a run must supply. */
  inputs: JsonSchemaLite;
  steps: PlaybookStepDefinition[];
}

export interface PlaybookViolation {
  code: string;
  /** Where the problem is, e.g. `steps[2].input.title`. Actionable, not just a message. */
  field: string;
  message: string;
}

export class PlaybookValidationError extends Error {
  readonly violations: PlaybookViolation[];
  readonly statusCode = 400;
  constructor(violations: PlaybookViolation[]) {
    super(
      `Playbook rejected — ${violations.length} problem(s): ` +
      violations.map((v) => `[${v.code}] ${v.field}: ${v.message}`).join(' '),
    );
    this.name = 'PlaybookValidationError';
    this.violations = violations;
  }
}

// ─── Defaults / parsing ──────────────────────────────────────────────────────

export const DEFAULT_STEP_TIMEOUT_SECONDS = 900;        // 15 min
export const MAX_STEP_TIMEOUT_SECONDS = 6 * 60 * 60;    // 6 h ceiling — bounded by definition
export const MAX_STEP_ATTEMPTS = 5;
export const MAX_STEPS = 25;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string | null = null): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Coerce arbitrary JSON into the definition shape without judging it —
 * validatePlaybookDefinition() does the judging, so a malformed draft
 * produces a list of actionable violations rather than a parse crash.
 */
export function parsePlaybookDefinition(raw: unknown, fallbackBusinessId: string): PlaybookDefinition {
  const source = isPlainObject(raw) ? raw : {};
  const scopeRaw = isPlainObject(source.business_scope) ? source.business_scope : {};
  const stepsRaw = Array.isArray(source.steps) ? source.steps : [];

  return {
    name: asString(source.name, '') ?? '',
    description: asString(source.description),
    business_scope: {
      business_id: asString(scopeRaw.business_id, fallbackBusinessId) ?? fallbackBusinessId,
      business_types: Array.isArray(scopeRaw.business_types)
        ? scopeRaw.business_types.filter((t): t is string => typeof t === 'string')
        : [],
    },
    inputs: isPlainObject(source.inputs) ? (source.inputs as JsonSchemaLite) : { type: 'object', properties: {}, required: [] },
    steps: stepsRaw.map((step, i) => parseStep(step, i)),
  };
}

function parseStep(raw: unknown, position: number): PlaybookStepDefinition {
  const source = isPlainObject(raw) ? raw : {};
  const declaredKind = asString(source.kind);
  // A step that names an action_type is an action step even if `kind` was
  // omitted — the authoring surface should not need to say it twice.
  const kind: PlaybookStepKind =
    declaredKind === 'action' || declaredKind === 'manual'
      ? declaredKind
      : (asString(source.action_type) ? 'action' : 'manual');

  return {
    index: Number.isInteger(source.index) ? Number(source.index) : position,
    name: asString(source.name, `Step ${position + 1}`) ?? `Step ${position + 1}`,
    kind,
    action_type: asString(source.action_type),
    input: isPlainObject(source.input) ? source.input : {},
    output_schema: isPlainObject(source.output_schema) ? (source.output_schema as JsonSchemaLite) : null,
    agent_id: asString(source.agent_id),
    task_template: asString(source.task_template),
    approval_gate: source.approval_gate === true || source.approval_gate === 1,
    approval_message: asString(source.approval_message),
    timeout_seconds: Number.isFinite(source.timeout_seconds)
      ? Number(source.timeout_seconds)
      // The pre-#74 step shape carried timeout_minutes; honour it rather
      // than silently resetting an existing workflow's timeout.
      : (Number.isFinite(source.timeout_minutes) ? Number(source.timeout_minutes) * 60 : DEFAULT_STEP_TIMEOUT_SECONDS),
    max_attempts: Number.isFinite(source.max_attempts) ? Number(source.max_attempts) : 1,
    on_failure: ((): StepFailurePolicy => {
      const value = asString(source.on_failure);
      return value === 'continue' || value === 'rollback' || value === 'stop' ? value : 'stop';
    })(),
  };
}

// ─── References ──────────────────────────────────────────────────────────────

const REFERENCE_PATTERN = /\{\{\s*([a-zA-Z0-9_.$-]+)\s*\}\}/g;

export interface PlaybookReference {
  /** Full token as written, e.g. `{{inputs.page_id}}`. */
  token: string;
  /** `inputs` or `steps`. */
  root: string;
  /** Dotted path after the root, e.g. `page_id` or `1.output.url`. */
  path: string;
}

export function extractReferences(value: unknown): PlaybookReference[] {
  const out: PlaybookReference[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(REFERENCE_PATTERN)) {
        const expr = match[1]!;
        const dot = expr.indexOf('.');
        out.push({
          token: match[0],
          root: dot === -1 ? expr : expr.slice(0, dot),
          path: dot === -1 ? '' : expr.slice(dot + 1),
        });
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (isPlainObject(node)) { Object.values(node).forEach(walk); }
  };
  walk(value);
  return out;
}

export function containsReference(value: unknown): boolean {
  return extractReferences(value).length > 0;
}

function readPath(source: unknown, path: string): { found: boolean; value: unknown } {
  if (path === '') return { found: source !== undefined, value: source };
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (Array.isArray(cursor)) {
      const i = Number(segment);
      if (!Number.isInteger(i) || i < 0 || i >= cursor.length) return { found: false, value: undefined };
      cursor = cursor[i];
      continue;
    }
    if (!isPlainObject(cursor) || !(segment in cursor)) return { found: false, value: undefined };
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

export interface BindingContext {
  inputs: Record<string, unknown>;
  /** Completed step outputs keyed by step index. */
  steps: Record<number, { output: unknown }>;
}

export interface BindingResult {
  value: unknown;
  /** References that could not be resolved from the context supplied. */
  unresolved: string[];
}

/**
 * Substitute references into a template.
 *
 * A whole-string reference (`"{{inputs.count}}"`) yields the referenced
 * value with its type intact — an integer stays an integer, so a typed
 * payload schema still matches. An embedded reference interpolates as
 * text, which is the only sane meaning inside a sentence.
 *
 * Unresolved references are REPORTED, never blanked: a payload that
 * silently lost a field would fail schema validation with a misleading
 * "required field missing" instead of "step 3's output is not available".
 */
export function bindTemplate(template: unknown, context: BindingContext): BindingResult {
  const unresolved: string[] = [];

  const lookup = (ref: PlaybookReference): { found: boolean; value: unknown } => {
    if (ref.root === 'inputs') return readPath(context.inputs, ref.path);
    if (ref.root === 'steps') {
      const dot = ref.path.indexOf('.');
      const indexPart = dot === -1 ? ref.path : ref.path.slice(0, dot);
      const rest = dot === -1 ? '' : ref.path.slice(dot + 1);
      const stepIndex = Number(indexPart);
      const step = context.steps[stepIndex];
      if (!Number.isInteger(stepIndex) || !step) return { found: false, value: undefined };
      // `steps.N.output.x` — the leading `output` segment is part of the path.
      if (rest === 'output') return { found: true, value: step.output };
      if (rest.startsWith('output.')) return readPath(step.output, rest.slice('output.'.length));
      return { found: false, value: undefined };
    }
    return { found: false, value: undefined };
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const refs = extractReferences(node);
      if (refs.length === 0) return node;
      const whole = refs.length === 1 && refs[0]!.token === node.trim();
      if (whole) {
        const resolved = lookup(refs[0]!);
        if (!resolved.found) { unresolved.push(refs[0]!.token); return node; }
        return resolved.value;
      }
      let out = node;
      for (const ref of refs) {
        const resolved = lookup(ref);
        if (!resolved.found) { unresolved.push(ref.token); continue; }
        out = out.split(ref.token).join(
          typeof resolved.value === 'string' ? resolved.value : JSON.stringify(resolved.value ?? null),
        );
      }
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) out[key] = walk(value);
      return out;
    }
    return node;
  };

  return { value: walk(template), unresolved: Array.from(new Set(unresolved)) };
}

// ─── Template-aware schema validation ────────────────────────────────────────

/**
 * Validate a step's input TEMPLATE against the registry payload schema at
 * authoring time. Values still carrying a reference are deferred (their
 * real value is unknown until the run supplies it) and re-validated in
 * full by validatePayloadAgainstSchema once bound — plus a third time by
 * createTask()'s own registry gate. Deferring here is what makes the
 * difference between "this playbook is wrong" and "this playbook is
 * parameterised".
 */
export function validateTemplateAgainstSchema(
  schema: JsonSchemaLite | null | undefined,
  template: unknown,
  path = '$',
): ValidationIssue[] {
  if (!schema || Object.keys(schema).length === 0) return [];
  if (containsReference(template)) return [];

  if (schema.type === 'object' && isPlainObject(template)) {
    const issues: ValidationIssue[] = [];
    for (const key of schema.required ?? []) {
      const present = key in template && template[key] !== undefined && template[key] !== null;
      if (!present) issues.push({ code: 'required', message: `${path}.${key}: required field missing` });
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in template && template[key] !== undefined) {
        issues.push(...validateTemplateAgainstSchema(propSchema, template[key], `${path}.${key}`));
      }
    }
    return issues;
  }

  if (schema.type === 'array' && Array.isArray(template)) {
    const issues: ValidationIssue[] = [];
    template.forEach((item, i) => {
      issues.push(...validateTemplateAgainstSchema(schema.items ?? null, item, `${path}[${i}]`));
    });
    return issues;
  }

  return validatePayloadAgainstSchema(schema, template, path);
}

/** Validate concrete run inputs against the playbook's declared input schema. */
export function validateRunInputs(definition: PlaybookDefinition, inputs: unknown): PlaybookViolation[] {
  const value = isPlainObject(inputs) ? inputs : {};
  const schema: JsonSchemaLite = { type: 'object', ...(definition.inputs ?? {}) };
  return validatePayloadAgainstSchema(schema, value, 'inputs').map((issue) => ({
    code: `input_${issue.code}`,
    field: issue.message.split(':')[0] ?? 'inputs',
    message: issue.message,
  }));
}

// ─── Definition validation ───────────────────────────────────────────────────

export interface ValidateDefinitionOptions {
  /** The business the playbook is being authored for — must match business_scope. */
  businessId: string;
  /** The business's declared type, when known; used for registry compatibility checks. */
  businessType?: string | null;
}

/**
 * Full structural + registry validation of a definition. Returns every
 * problem it finds rather than throwing on the first, so an author fixes
 * one draft instead of playing whack-a-mole.
 */
export function validatePlaybookDefinition(
  definition: PlaybookDefinition,
  options: ValidateDefinitionOptions,
): PlaybookViolation[] {
  const violations: PlaybookViolation[] = [];
  const add = (code: string, field: string, message: string) => violations.push({ code, field, message });

  if (!definition.name) add('name_required', 'name', 'A playbook needs a name.');

  // ── Scope ──
  if (!definition.business_scope.business_id) {
    add('scope_required', 'business_scope.business_id', 'A playbook must declare the business it runs for.');
  } else if (definition.business_scope.business_id !== options.businessId) {
    add(
      'scope_mismatch', 'business_scope.business_id',
      `This playbook is scoped to business '${definition.business_scope.business_id}' but is being authored under ` +
      `'${options.businessId}'. A playbook belongs to exactly one business; create a separate playbook for the other.`,
    );
  }
  if (definition.business_scope.business_types.length > 0 && options.businessType
      && !definition.business_scope.business_types.includes(options.businessType)) {
    add(
      'scope_business_type_mismatch', 'business_scope.business_types',
      `This playbook declares business types [${definition.business_scope.business_types.join(', ')}], ` +
      `but business '${options.businessId}' is type '${options.businessType}'.`,
    );
  }

  // ── Inputs schema ──
  if (definition.inputs && definition.inputs.type && definition.inputs.type !== 'object') {
    add('inputs_not_object', 'inputs', `The playbook input schema must be an object schema, got '${definition.inputs.type}'.`);
  }
  const declaredInputs = new Set(Object.keys(definition.inputs?.properties ?? {}));

  // ── Steps ──
  if (definition.steps.length === 0) {
    add('steps_required', 'steps', 'A playbook needs at least one step.');
  }
  if (definition.steps.length > MAX_STEPS) {
    add('too_many_steps', 'steps', `A playbook is bounded at ${MAX_STEPS} steps; this one has ${definition.steps.length}.`);
  }

  const seenIndexes = new Set<number>();
  definition.steps.forEach((step, position) => {
    const field = `steps[${position}]`;

    if (step.index !== position) {
      add('step_index_out_of_order', `${field}.index`,
        `Step indexes must be contiguous and ordered from 0; step at position ${position} declares index ${step.index}.`);
    }
    if (seenIndexes.has(step.index)) {
      add('step_index_duplicate', `${field}.index`, `Two steps both declare index ${step.index}.`);
    }
    seenIndexes.add(step.index);

    if (!step.name) add('step_name_required', `${field}.name`, 'Every step needs a name.');

    if (!Number.isFinite(step.timeout_seconds) || step.timeout_seconds <= 0) {
      add('step_timeout_invalid', `${field}.timeout_seconds`, 'timeout_seconds must be a positive number of seconds.');
    } else if (step.timeout_seconds > MAX_STEP_TIMEOUT_SECONDS) {
      add('step_timeout_too_long', `${field}.timeout_seconds`,
        `timeout_seconds ${step.timeout_seconds} exceeds the ${MAX_STEP_TIMEOUT_SECONDS}s ceiling — a bounded step cannot run unbounded.`);
    }
    if (!Number.isInteger(step.max_attempts) || step.max_attempts < 1 || step.max_attempts > MAX_STEP_ATTEMPTS) {
      add('step_attempts_invalid', `${field}.max_attempts`,
        `max_attempts must be an integer between 1 and ${MAX_STEP_ATTEMPTS}.`);
    }

    // ── Typed action steps ──
    if (step.kind === 'action') {
      if (!step.action_type) {
        add('step_action_type_required', `${field}.action_type`,
          "An 'action' step must name an action_type from the Typed Action Registry. Use kind 'manual' for a free-text agent step.");
      } else {
        const entry = getActionRegistryEntry(step.action_type);
        if (!entry || entry.active === false) {
          add('step_action_type_unknown', `${field}.action_type`,
            `action_type '${step.action_type}' is not registered (or is deactivated) in the Typed Action Registry.`);
        } else {
          const schemaIssues = validateTemplateAgainstSchema(entry.payload_schema, step.input);
          for (const issue of schemaIssues) {
            add('step_input_schema_mismatch', `${field}.input`,
              `Input does not match the '${step.action_type}' payload schema — ${issue.message}.`);
          }
          if (options.businessType
              && entry.supported_business_types.length > 0
              && !entry.supported_business_types.includes(options.businessType)) {
            add('step_business_type_incompatible', `${field}.action_type`,
              `action_type '${step.action_type}' supports business types [${entry.supported_business_types.join(', ')}], ` +
              `but this business is type '${options.businessType}'.`);
          }
          if (entry.timeout_ms && step.timeout_seconds * 1000 < entry.timeout_ms) {
            add('step_timeout_below_action_minimum', `${field}.timeout_seconds`,
              `action_type '${step.action_type}' declares a ${entry.timeout_ms}ms timeout, longer than this step's ` +
              `${step.timeout_seconds}s budget — the step would time out before the action could finish.`);
          }
          if (step.on_failure === 'continue' && entry.side_effect_classification !== 'internal_idempotent') {
            add('step_continue_on_external_side_effect', `${field}.on_failure`,
              `Step uses on_failure 'continue', but action_type '${step.action_type}' is classified ` +
              `'${entry.side_effect_classification}' — a failed external write must not be walked past silently. ` +
              "Use 'stop' or 'rollback'.");
          }
        }
      }
      if (step.task_template) {
        add('step_action_has_task_template', `${field}.task_template`,
          "A typed 'action' step is defined by its action_type and input, not a free-text task_template. " +
          "Move the text into the input, or change the step to kind 'manual'.");
      }
    }

    // ── Manual (free-text) fallback steps ──
    if (step.kind === 'manual') {
      if (step.action_type) {
        add('step_manual_has_action_type', `${field}.action_type`,
          "A 'manual' step is free text handed to an agent and cannot carry an action_type. " +
          "Change kind to 'action' to make it typed.");
      }
      if (!step.task_template) {
        add('step_task_template_required', `${field}.task_template`,
          "A 'manual' step needs a task_template describing what the agent should do.");
      }
      if (!step.agent_id) {
        add('step_agent_required', `${field}.agent_id`, "A 'manual' step needs an agent_id to run it.");
      }
      if (Object.keys(step.input).length > 0) {
        add('step_manual_has_typed_input', `${field}.input`,
          "A 'manual' step has no typed payload schema to validate its input against; put the values in the " +
          'task_template, or make the step typed.');
      }
    }

    // ── References ──
    for (const ref of extractReferences([step.input, step.task_template, step.approval_message])) {
      if (ref.root === 'inputs') {
        const name = ref.path.split('.')[0] ?? '';
        if (!declaredInputs.has(name)) {
          add('reference_unknown_input', `${field}.input`,
            `References '${ref.token}', but '${name}' is not declared in the playbook's inputs schema.`);
        }
        continue;
      }
      if (ref.root === 'steps') {
        const parts = ref.path.split('.');
        const referenced = Number(parts[0]);
        if (!Number.isInteger(referenced)) {
          add('reference_malformed', `${field}.input`,
            `Reference '${ref.token}' is malformed — use {{steps.<index>.output.<field>}}.`);
        } else if (referenced >= step.index) {
          add('reference_forward', `${field}.input`,
            `References '${ref.token}', but step ${referenced} runs at or after this step (${step.index}). ` +
            'A step may only consume the output of an earlier step.');
        } else if (parts[1] !== 'output') {
          add('reference_malformed', `${field}.input`,
            `Reference '${ref.token}' must address a step's declared output, e.g. {{steps.${referenced}.output.url}}.`);
        } else {
          const producer = definition.steps.find((s) => s.index === referenced);
          const outputPath = parts.slice(2).join('.');
          if (producer?.output_schema && outputPath) {
            const known = Object.keys(producer.output_schema.properties ?? {});
            const head = outputPath.split('.')[0]!;
            if (known.length > 0 && !known.includes(head)) {
              add('reference_unknown_output', `${field}.input`,
                `References '${ref.token}', but step ${referenced} declares outputs [${known.join(', ')}].`);
            }
          }
        }
        continue;
      }
      add('reference_unknown_root', `${field}.input`,
        `Reference '${ref.token}' must start with 'inputs.' or 'steps.'.`);
    }
  });

  return violations;
}

/** Throwing form, for call sites where an invalid definition must not proceed. */
export function assertPlaybookValid(definition: PlaybookDefinition, options: ValidateDefinitionOptions): void {
  const violations = validatePlaybookDefinition(definition, options);
  if (violations.length > 0) throw new PlaybookValidationError(violations);
}
