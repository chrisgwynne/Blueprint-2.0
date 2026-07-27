/**
 * Typed Action & Executor Registry — canonical types.
 *
 * Consolidates what used to be 3 independently hand-maintained lists
 * (executor.ts EXECUTABLE_ACTION_TYPES, action-payloads.ts ActionType
 * union, execution-safety.ts EXTERNAL_VERIFIABLE_ACTIONS) into one
 * queryable table (`action_registry`). This module does not replace
 * executor.ts's switch-based dispatch — it adds a metadata/validation
 * layer in front of it.
 */

export type SideEffectClassification = 'internal_idempotent' | 'external_verifiable';
export type RiskLevel = 'low' | 'medium' | 'high';

/** Minimal, hand-rolled JSON-Schema-lite shape — no ajv dependency needed. */
export interface JsonSchemaLite {
  type?: 'object' | 'string' | 'number' | 'boolean' | 'array';
  required?: string[];
  properties?: Record<string, JsonSchemaLite>;
  items?: JsonSchemaLite;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ActionRegistryEntry {
  action_type: string;
  version: number;
  description: string | null;
  payload_schema: JsonSchemaLite;
  required_connector_types: string[];
  supported_business_types: string[];
  required_permissions: string[];
  supports_rollback: boolean;
  verification_routine: string | null;
  retry_policy: Record<string, unknown>;
  timeout_ms: number | null;
  side_effect_classification: SideEffectClassification;
  requires_approval: boolean;
  risk_level: RiskLevel;
  measurement_window_days: number[];
  success_metrics: string[];
  expected_impact: string | null;
  acceptable_variance: number | null;
  confidence_adjustment_rules: Record<string, unknown>;
  follow_up_schedule: number[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export const ACTION_REGISTRY_JSON_COLUMNS = [
  'payload_schema', 'required_connector_types', 'supported_business_types', 'required_permissions',
  'retry_policy', 'measurement_window_days', 'success_metrics', 'confidence_adjustment_rules',
  'follow_up_schedule',
] as const;

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ActionValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  entry: ActionRegistryEntry | null;
}
