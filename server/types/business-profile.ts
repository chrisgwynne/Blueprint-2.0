/**
 * Business Truth Layer — canonical types.
 *
 * A BusinessProfile is the single source of truth for what a business *is*
 * and what it is allowed to do. Nothing else (connectors, agents, the task
 * queue, the executor) should infer business identity or capability from
 * connector data — they consult this profile instead.
 */

export type BusinessType = 'service' | 'agency' | 'ecommerce' | 'saas' | 'content' | 'other';

export interface ApprovalPolicy {
  /** Action types (or '*') that always require human approval regardless of trust tier. */
  always_require_approval?: string[];
  /** Action types that may be auto-approved when trust tier allows it. */
  allow_auto_approve?: string[];
  default_mode?: 'auto' | 'manual';
}

export interface AutomationPolicy {
  max_autonomous_tasks_per_day?: number;
  allowed_activation_channels?: string[]; // signal|schedule|manual|workflow|escalation
}

export interface RiskPolicy {
  max_risk_level?: 'low' | 'medium' | 'high';
  budget_ceiling_usd?: number;
}

export interface DeploymentPolicy {
  allow_server_file_write?: boolean;
  allow_auto_deploy?: boolean;
}

export interface SeoPolicy {
  enabled?: boolean;
  primary_keywords?: string[];
}

export interface EcommercePolicy {
  enabled?: boolean;
  platform?: string; // e.g. 'shopify'
  uses_merchant_center?: boolean;
}

export interface LeadGenPolicy {
  enabled?: boolean;
  primary_channels?: string[];
}

export interface CommunicationPreferences {
  digest_frequency?: 'daily' | 'weekly' | 'monthly' | 'never';
  channels?: string[]; // e.g. ['dashboard', 'telegram', 'email']
}

export interface BusinessProfile {
  id: string;
  business_id: string;
  business_type: BusinessType;
  operating_model: string | null;
  primary_domain: string | null;
  primary_brand: string | null;
  products_services: string[];
  supported_platforms: string[];
  enabled_connector_types: string[];
  disabled_connector_types: string[];
  /** Empty array = no restriction (all agent types allowed). */
  allowed_agent_types: string[];
  /** Empty array = no restriction (all action types allowed, subject to the registry's own supported_business_types). */
  allowed_action_types: string[];
  strategic_goals: string[];
  kpis: string[];
  operating_constraints: Record<string, unknown>;
  approval_policy: ApprovalPolicy;
  automation_policy: AutomationPolicy;
  risk_policy: RiskPolicy;
  deployment_policy: DeploymentPolicy;
  seo_policy: SeoPolicy;
  ecommerce_policy: EcommercePolicy;
  lead_gen_policy: LeadGenPolicy;
  communication_preferences: CommunicationPreferences;
  /** Field names whose current value was auto-inferred rather than human-confirmed. */
  inferred_fields: string[];
  confirmed_by_human: boolean;
  created_at: string;
  updated_at: string;
}

export const BUSINESS_PROFILE_JSON_COLUMNS = [
  'products_services', 'supported_platforms', 'enabled_connector_types', 'disabled_connector_types',
  'allowed_agent_types', 'allowed_action_types', 'strategic_goals', 'kpis', 'operating_constraints',
  'approval_policy', 'automation_policy', 'risk_policy', 'deployment_policy', 'seo_policy',
  'ecommerce_policy', 'lead_gen_policy', 'communication_preferences', 'inferred_fields',
] as const;

export const BUSINESS_TYPES: readonly BusinessType[] = ['service', 'agency', 'ecommerce', 'saas', 'content', 'other'];
