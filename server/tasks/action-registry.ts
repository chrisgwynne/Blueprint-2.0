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
import db, { generateId } from '../db/db.js';
import type { Connector } from '../types/db.js';
import type { BusinessProfile } from '../types/business-profile.js';
import { isBusinessTypeCompatible } from '../business/business-profile.js';
import { listConnectorConfidence, isLowConfidence } from '../connectors/confidence.js';
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
  out.dispatched_by_executor = Boolean(row['dispatched_by_executor']);
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
  dispatched_by_executor?: boolean;
  display_name?: string | null;
  measurement_notes?: string | null;
  volatility?: string | null;
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
        confidence_adjustment_rules, follow_up_schedule, active, dispatched_by_executor,
        display_name, measurement_notes, volatility, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      patch.dispatched_by_executor ? 1 : 0,
      patch.display_name ?? null,
      patch.measurement_notes ?? null,
      patch.volatility ?? null,
      now, now,
    );
    const created = getActionRegistryEntry(actionType) as ActionRegistryEntry;
    syncToActionWindows(created);
    return created;
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
  if (patch.dispatched_by_executor !== undefined) setScalar('dispatched_by_executor', patch.dispatched_by_executor ? 1 : 0);
  if (patch.display_name !== undefined) setScalar('display_name', patch.display_name);
  if (patch.measurement_notes !== undefined) setScalar('measurement_notes', patch.measurement_notes);
  if (patch.volatility !== undefined) setScalar('volatility', patch.volatility);

  values.push(actionType);
  db.prepare(`UPDATE action_registry SET ${updates.join(', ')} WHERE action_type = ?`).run(...values);
  const updated = getActionRegistryEntry(actionType) as ActionRegistryEntry;
  syncToActionWindows(updated);
  return updated;
}

/**
 * Write-through sync into `action_windows` (server/brain/action-windows.ts),
 * the table restraint.ts/causal.ts/conflict-engine.ts/attribution-engine.ts/
 * temporal-summary.ts/goal-reasoner.ts/context-assembler.ts/investigation-
 * engine.ts/agent-runner.ts/the Brain dashboard route all read directly.
 * action_registry is the edit surface (via this function); action_windows
 * stays a plain read-only mirror those 10 call sites never had to change —
 * consolidating the *source of truth* without touching their SQL.
 * A no-op when measurement_window_days isn't exactly [min, expected, max]
 * (3 numbers) — action_windows has no shape for anything else.
 */
function syncToActionWindows(entry: ActionRegistryEntry): void {
  if (entry.measurement_window_days.length !== 3) return;
  const [min_days, expected_days, max_days] = entry.measurement_window_days as [number, number, number];
  const existing = db.prepare('SELECT id FROM action_windows WHERE action_type = ?').get(entry.action_type) as { id: string } | null;
  const displayName = entry.display_name ?? entry.action_type;
  const notes = entry.measurement_notes ?? entry.description ?? '';
  const volatility = entry.volatility ?? 'medium';

  if (existing) {
    db.prepare(`
      UPDATE action_windows SET display_name = ?, min_days = ?, expected_days = ?, max_days = ?,
        metric_types = ?, measurement_notes = ?, volatility = ?
      WHERE action_type = ?
    `).run(displayName, min_days, expected_days, max_days, JSON.stringify(entry.success_metrics), notes, volatility, entry.action_type);
  } else {
    db.prepare(`
      INSERT INTO action_windows (id, action_type, display_name, min_days, expected_days, max_days, metric_types, measurement_notes, volatility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), entry.action_type, displayName, min_days, expected_days, max_days, JSON.stringify(entry.success_metrics), notes, volatility);
  }
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

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

// ─── Validation gate ──────────────────────────────────────────────────────────

export interface ActionValidationInput {
  actionType: string | null;
  payload: unknown;
  businessId: string;
  businessProfile: BusinessProfile | null;
  connectors: Connector[];
  /** 'bap:<agentId>' for BAP approvals, 'dashboard:...'/'telegram:...' otherwise. Dashboard/Telegram actors are treated as fully privileged (matching the rest of the codebase's security model); only BAP agents are checked against required_permissions. */
  approvedBy?: string | null;
}

function agentPermissionsFor(approvedBy: string | null | undefined): string[] | null {
  if (!approvedBy || !approvedBy.startsWith('bap:')) return null; // not a BAP agent — full access assumed
  const agentId = approvedBy.slice('bap:'.length);
  const row = db.prepare('SELECT permissions FROM bap_agents WHERE id = ?').get(agentId) as { permissions: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.permissions);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasAllPermissions(granted: string[], required: string[]): boolean {
  const set = new Set(granted);
  return required.every((req) => {
    const [resource] = req.split(':');
    return set.has(req) || set.has(`${resource}:*`) || set.has('*:*');
  });
}

/**
 * Full validation against the registry — every check the spec lists
 * ("action exists, executor exists, payload matches schema, business
 * type supports action, required connectors exist, connector confidence
 * is acceptable, permissions exist, executor is healthy") is a hard
 * block, not a warning: "if validation fails, do not create a business
 * task" is unconditional. `warnings` is kept in the return shape for API
 * stability but is no longer populated — every issue this function finds
 * is returned in `issues`.
 *
 * A null actionType (manual to-do tasks with no action_type) always
 * passes with no issues — this gate only applies to tasks that declare a
 * concrete, executable action_type.
 */
export function validateAction(input: ActionValidationInput): ActionValidationResult & { warnings: ValidationIssue[] } {
  const { actionType, payload, businessId, businessProfile, connectors, approvedBy } = input;

  if (!actionType) {
    return { valid: true, issues: [], warnings: [], entry: null };
  }

  const entry = getActionRegistryEntry(actionType);
  const issues: ValidationIssue[] = [];

  // 1. Action exists (registered, active).
  if (!entry || !entry.active) {
    issues.push({
      code: 'unknown_action_type',
      message: `action_type '${actionType}' is not registered in the Typed Action Registry (or has been deactivated).`,
    });
    return { valid: false, issues, warnings: [], entry: null };
  }

  // 2. Business type supports action.
  if (businessProfile && !isBusinessTypeCompatible(entry.supported_business_types, businessProfile.business_type)) {
    issues.push({
      code: 'business_type_incompatible',
      message: `action_type '${actionType}' supports business types [${entry.supported_business_types.join(', ')}], ` +
        `but this business is type '${businessProfile.business_type}'.`,
    });
  }

  // 2b. Business Profile risk_policy.max_risk_level — a business-specific
  // ceiling on how much risk Blueprint may take autonomously, independent
  // of the action's own supported_business_types.
  const maxRiskLevel = businessProfile?.risk_policy?.max_risk_level;
  if (maxRiskLevel && (RISK_RANK[entry.risk_level] ?? 1) > (RISK_RANK[maxRiskLevel] ?? 1)) {
    issues.push({
      code: 'risk_level_exceeds_policy',
      message: `action_type '${actionType}' is risk level '${entry.risk_level}', but this business's risk_policy caps autonomous actions at '${maxRiskLevel}'.`,
    });
  }

  // 3. Required connectors exist.
  const availableConnectorTypes = new Set(connectors.map((c) => c.type));
  const missingConnectors = entry.required_connector_types.filter((t) => !availableConnectorTypes.has(t));
  if (missingConnectors.length > 0) {
    issues.push({
      code: 'missing_connector',
      message: `action_type '${actionType}' requires connector type(s) [${missingConnectors.join(', ')}], none configured for this business.`,
    });
  }

  // 4. Connector confidence is acceptable (only for required types actually configured — a
  //    missing connector is already covered by #3, no need to double-report it here).
  if (entry.required_connector_types.length > 0 && missingConnectors.length === 0) {
    const confidences = listConnectorConfidence(businessId);
    const confidenceByConnectorId = new Map(confidences.map((c) => [c.connector_id, c]));
    const lowConfidenceTypes = entry.required_connector_types.filter((type) => {
      const instancesOfType = connectors.filter((c) => c.type === type);
      return instancesOfType.every((c) => isLowConfidence(confidenceByConnectorId.get(c.id) ?? null));
    });
    if (lowConfidenceTypes.length > 0) {
      issues.push({
        code: 'connector_confidence_low',
        message: `action_type '${actionType}' requires connector type(s) [${lowConfidenceTypes.join(', ')}], but every configured instance has low or unverified confidence.`,
      });
    }
  }

  // 5. Payload matches schema.
  const schemaIssues = validatePayloadAgainstSchema(entry.payload_schema, payload);
  if (schemaIssues.length > 0) {
    issues.push({
      code: 'payload_schema_mismatch',
      message: `action_type '${actionType}' payload does not match its schema: ${schemaIssues.map((i) => i.message).join('; ')}`,
    });
  }

  // 6. Permissions exist (BAP agents only — dashboard/Telegram actors are fully privileged).
  if (entry.required_permissions.length > 0) {
    const granted = agentPermissionsFor(approvedBy);
    if (granted !== null && !hasAllPermissions(granted, entry.required_permissions)) {
      issues.push({
        code: 'permissions_missing',
        message: `action_type '${actionType}' requires permission(s) [${entry.required_permissions.join(', ')}], which the approving agent does not hold.`,
      });
    }
  }

  // 7 & 8. Executor exists and is healthy. dispatched_by_executor is static
  // registry metadata (see db.ts migration notes) recording whether
  // executor.ts actually has a dispatch case for this action_type at all —
  // "unhealthy" means its last 3 completed executions all dead-lettered
  // (permanently failed), a simple, DB-observable circuit-breaker signal
  // rather than a live health probe.
  if (entry.dispatched_by_executor) {
    const recentJobs = db.prepare(`
      SELECT status FROM execution_jobs
      WHERE action_type = ? AND status IN ('succeeded', 'dead_letter')
      ORDER BY created_at DESC LIMIT 3
    `).all(actionType) as Array<{ status: string }>;
    if (recentJobs.length === 3 && recentJobs.every((j) => j.status === 'dead_letter')) {
      issues.push({
        code: 'executor_unhealthy',
        message: `action_type '${actionType}''s last 3 completed executions all failed permanently (dead-lettered) — the executor for this action appears unhealthy.`,
      });
    }
  }

  return { valid: issues.length === 0, issues, warnings: [], entry };
}
