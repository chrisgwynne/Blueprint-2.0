/**
 * Typed Action & Executor Registry.
 *
 * `action_registry` is the single source of truth for what an action_type
 * is, what it needs to run (connectors, permissions), what business types
 * it's valid for, and how its outcome should be measured (Outcome
 * Learning Engine fields). It is seeded at startup (server/db/db.ts) with
 * every action_type currently in real use, and is deliberately additive —
 * an action_type missing from the registry is a real gap to fix, not
 * silently tolerated.
 */
import db from '../db/db.js';
import type { Connector } from '../types/db.js';
import type { BusinessProfile } from '../types/business-profile.js';
import { isBusinessTypeCompatible } from '../business/business-profile.js';
import type {
  ActionRegistryEntry, ActionValidationResult, JsonSchemaLite, ValidationIssue,
} from '../types/action-registry.js';
import { ACTION_REGISTRY_JSON_COLUMNS } from '../types/action-registry.js';

const JSON_DEFAULTS: Record<string, unknown> = {
  payload_schema: {},
  required_connector_types: [],
  supported_business_types: [],
  required_permissions: [],
  retry_policy: {},
  measurement_window_days: [7, 14, 28],
  success_metrics: [],
  confidence_adjustment_rules: {},
  follow_up_schedule: [],
};

function parseRow(row: Record<string, unknown>): ActionRegistryEntry {
  const out: Record<string, unknown> = { ...row };
  for (const col of ACTION_REGISTRY_JSON_COLUMNS) {
    try {
      out[col] = row[col] ? JSON.parse(row[col] as string) : JSON_DEFAULTS[col];
    } catch {
      out[col] = JSON_DEFAULTS[col];
    }
  }
  out.supports_rollback = Boolean(row['supports_rollback']);
  out.requires_approval = Boolean(row['requires_approval']);
  out.active = Boolean(row['active']);
  return out as unknown as ActionRegistryEntry;
}

export function getActionRegistryEntry(actionType: string): ActionRegistryEntry | null {
  const row = db.prepare('SELECT * FROM action_registry WHERE action_type = ?').get(actionType) as Record<string, unknown> | null;
  return row ? parseRow(row) : null;
}

export function listActionRegistryEntries(): ActionRegistryEntry[] {
  const rows = db.prepare('SELECT * FROM action_registry ORDER BY action_type ASC').all() as Record<string, unknown>[];
  return rows.map(parseRow);
}

export interface ActionRegistryUpsert {
  description?: string | null;
  payload_schema?: JsonSchemaLite;
  required_connector_types?: string[];
  supported_business_types?: string[];
  required_permissions?: string[];
  supports_rollback?: boolean;
  verification_routine?: string | null;
  retry_policy?: Record<string, unknown>;
  timeout_ms?: number | null;
  side_effect_classification?: string;
  requires_approval?: boolean;
  risk_level?: string;
  measurement_window_days?: number[];
  success_metrics?: string[];
  expected_impact?: string | null;
  acceptable_variance?: number | null;
  confidence_adjustment_rules?: Record<string, unknown>;
  follow_up_schedule?: number[];
  active?: boolean;
}

/** Operator/BAP edit of an existing (or brand-new) action_type's metadata. */
export function upsertActionRegistryEntry(actionType: string, patch: ActionRegistryUpsert): ActionRegistryEntry {
  const existing = getActionRegistryEntry(actionType);
  const now = new Date().toISOString();

  if (!existing) {
    db.prepare(`
      INSERT INTO action_registry (
        action_type, version, description, payload_schema, required_connector_types,
        supported_business_types, required_permissions, supports_rollback, verification_routine,
        retry_policy, timeout_ms, side_effect_classification, requires_approval, risk_level,
        measurement_window_days, success_metrics, expected_impact, acceptable_variance,
        confidence_adjustment_rules, follow_up_schedule, active, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actionType,
      patch.description ?? null,
      JSON.stringify(patch.payload_schema ?? {}),
      JSON.stringify(patch.required_connector_types ?? []),
      JSON.stringify(patch.supported_business_types ?? []),
      JSON.stringify(patch.required_permissions ?? []),
      patch.supports_rollback ? 1 : 0,
      patch.verification_routine ?? null,
      JSON.stringify(patch.retry_policy ?? {}),
      patch.timeout_ms ?? null,
      patch.side_effect_classification ?? 'internal_idempotent',
      patch.requires_approval === undefined ? 1 : (patch.requires_approval ? 1 : 0),
      patch.risk_level ?? 'medium',
      JSON.stringify(patch.measurement_window_days ?? [7, 14, 28]),
      JSON.stringify(patch.success_metrics ?? []),
      patch.expected_impact ?? null,
      patch.acceptable_variance ?? 0.05,
      JSON.stringify(patch.confidence_adjustment_rules ?? {}),
      JSON.stringify(patch.follow_up_schedule ?? []),
      patch.active === undefined ? 1 : (patch.active ? 1 : 0),
      now, now,
    );
    return getActionRegistryEntry(actionType) as ActionRegistryEntry;
  }

  const updates: string[] = ['version = version + 1', 'updated_at = ?'];
  const values: any[] = [now];
  const setJson = (col: string, val: unknown) => { updates.push(`${col} = ?`); values.push(JSON.stringify(val)); };
  const setScalar = (col: string, val: unknown) => { updates.push(`${col} = ?`); values.push(val); };

  if (patch.description !== undefined) setScalar('description', patch.description);
  if (patch.payload_schema !== undefined) setJson('payload_schema', patch.payload_schema);
  if (patch.required_connector_types !== undefined) setJson('required_connector_types', patch.required_connector_types);
  if (patch.supported_business_types !== undefined) setJson('supported_business_types', patch.supported_business_types);
  if (patch.required_permissions !== undefined) setJson('required_permissions', patch.required_permissions);
  if (patch.supports_rollback !== undefined) setScalar('supports_rollback', patch.supports_rollback ? 1 : 0);
  if (patch.verification_routine !== undefined) setScalar('verification_routine', patch.verification_routine);
  if (patch.retry_policy !== undefined) setJson('retry_policy', patch.retry_policy);
  if (patch.timeout_ms !== undefined) setScalar('timeout_ms', patch.timeout_ms);
  if (patch.side_effect_classification !== undefined) setScalar('side_effect_classification', patch.side_effect_classification);
  if (patch.requires_approval !== undefined) setScalar('requires_approval', patch.requires_approval ? 1 : 0);
  if (patch.risk_level !== undefined) setScalar('risk_level', patch.risk_level);
  if (patch.measurement_window_days !== undefined) setJson('measurement_window_days', patch.measurement_window_days);
  if (patch.success_metrics !== undefined) setJson('success_metrics', patch.success_metrics);
  if (patch.expected_impact !== undefined) setScalar('expected_impact', patch.expected_impact);
  if (patch.acceptable_variance !== undefined) setScalar('acceptable_variance', patch.acceptable_variance);
  if (patch.confidence_adjustment_rules !== undefined) setJson('confidence_adjustment_rules', patch.confidence_adjustment_rules);
  if (patch.follow_up_schedule !== undefined) setJson('follow_up_schedule', patch.follow_up_schedule);
  if (patch.active !== undefined) setScalar('active', patch.active ? 1 : 0);

  values.push(actionType);
  db.prepare(`UPDATE action_registry SET ${updates.join(', ')} WHERE action_type = ?`).run(...values);
  return getActionRegistryEntry(actionType) as ActionRegistryEntry;
}

// ─── Hand-rolled JSON-Schema-lite validator ──────────────────────────────────
// Supports the subset actually needed here (type/required/properties/enum/
// min/max/items/length bounds) — not a general-purpose ajv replacement.
// Deliberately no new npm dependency for this.

export function validatePayloadAgainstSchema(schema: JsonSchemaLite | null | undefined, value: unknown, path = '$'): ValidationIssue[] {
  if (!schema || Object.keys(schema).length === 0) return [];
  const issues: ValidationIssue[] = [];

  if (schema.type) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const expected = schema.type;
    const matches =
      (expected === 'array' && actual === 'array') ||
      (expected === 'object' && actual === 'object' && value !== null) ||
      (expected === actual);
    if (!matches) {
      issues.push({ code: 'type_mismatch', message: `${path}: expected ${expected}, got ${actual}` });
      return issues; // further checks are meaningless if the base type is wrong
    }
  }

  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    issues.push({ code: 'enum_mismatch', message: `${path}: value not in allowed enum` });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ code: 'min_length', message: `${path}: shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ code: 'max_length', message: `${path}: longer than maxLength ${schema.maxLength}` });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ code: 'minimum', message: `${path}: below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ code: 'maximum', message: `${path}: above maximum ${schema.maximum}` });
    }
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
        issues.push({ code: 'required', message: `${path}.${key}: required field missing` });
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) {
        issues.push(...validatePayloadAgainstSchema(propSchema, obj[key], `${path}.${key}`));
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => issues.push(...validatePayloadAgainstSchema(schema.items!, item, `${path}[${i}]`)));
  }

  return issues;
}

// ─── Validation gate ──────────────────────────────────────────────────────────

export interface ActionValidationInput {
  actionType: string | null;
  payload: unknown;
  businessProfile: BusinessProfile | null;
  connectors: Connector[];
}

/**
 * Full validation against the registry. Returns two buckets:
 *  - blocking: reasons severe enough to prevent a task becoming executable
 *    at all (action_type doesn't exist in the registry, or the business
 *    type is explicitly incompatible).
 *  - warnings: everything else the spec asks Blueprint to check (missing
 *    connectors, unmatched payload schema) — surfaced as non-blocking
 *    Blueprint System Issues rather than blocking approval outright, to
 *    avoid mass regression against the many existing tasks/tests that
 *    predate this registry.
 *
 * A null actionType (manual to-do tasks with no action_type) always
 * passes with no issues — this gate only applies to tasks that declare a
 * concrete, executable action_type.
 */
export function validateAction(input: ActionValidationInput): ActionValidationResult & { warnings: ValidationIssue[] } {
  const { actionType, payload, businessProfile, connectors } = input;

  if (!actionType) {
    return { valid: true, issues: [], warnings: [], entry: null };
  }

  const entry = getActionRegistryEntry(actionType);
  const blocking: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!entry || !entry.active) {
    blocking.push({
      code: 'unknown_action_type',
      message: `action_type '${actionType}' is not registered in the Typed Action Registry (or has been deactivated).`,
    });
    return { valid: false, issues: blocking, warnings, entry: null };
  }

  if (businessProfile && !isBusinessTypeCompatible(entry.supported_business_types, businessProfile.business_type)) {
    blocking.push({
      code: 'business_type_incompatible',
      message: `action_type '${actionType}' supports business types [${entry.supported_business_types.join(', ')}], ` +
        `but this business is type '${businessProfile.business_type}'.`,
    });
  }

  const availableConnectorTypes = new Set(connectors.map((c) => c.type));
  const missingConnectors = entry.required_connector_types.filter((t) => !availableConnectorTypes.has(t));
  if (missingConnectors.length > 0) {
    warnings.push({
      code: 'missing_connector',
      message: `action_type '${actionType}' requires connector type(s) [${missingConnectors.join(', ')}], none configured for this business.`,
    });
  }

  const schemaIssues = validatePayloadAgainstSchema(entry.payload_schema, payload);
  if (schemaIssues.length > 0) {
    warnings.push({
      code: 'payload_schema_mismatch',
      message: `action_type '${actionType}' payload does not match its schema: ${schemaIssues.map((i) => i.message).join('; ')}`,
    });
  }

  return { valid: blocking.length === 0, issues: blocking, warnings, entry };
}
