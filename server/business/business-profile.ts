/**
 * Business Truth Layer.
 *
 * `business_profiles` is the single source of truth for what a business is
 * (type, model, brand, domain) and what it is allowed to do (connectors,
 * agents, action types, policies). Every subsystem that needs to reason
 * about business identity or capability — the task queue, the executor
 * registry, agent matching, recommendations — reads this profile rather
 * than inferring identity from connector rows or free-text fields.
 *
 * Profiles are auto-created (with inferred defaults, clearly marked) the
 * first time they're requested for a business that doesn't have one yet —
 * see the one-off backfill migration in db.ts for existing businesses at
 * startup, and getOrCreateBusinessProfile() for any business created after.
 */
import db, { generateId } from '../db/db.js';
import type { BusinessProfile, BusinessType } from '../types/business-profile.js';
import { BUSINESS_PROFILE_JSON_COLUMNS, BUSINESS_TYPES } from '../types/business-profile.js';

const JSON_DEFAULTS: Record<string, unknown> = {
  products_services: [],
  supported_platforms: [],
  enabled_connector_types: [],
  disabled_connector_types: [],
  allowed_agent_types: [],
  allowed_action_types: [],
  strategic_goals: [],
  kpis: [],
  operating_constraints: {},
  approval_policy: {},
  automation_policy: {},
  risk_policy: {},
  deployment_policy: {},
  seo_policy: {},
  ecommerce_policy: {},
  lead_gen_policy: {},
  communication_preferences: {},
  inferred_fields: [],
};

/**
 * Infer a BusinessType from the free-text `businesses.type` column.
 * Deliberately conservative: falls back to 'service' (the narrowest,
 * safest default — a service business profile never unlocks ecommerce-only
 * action types) when no keyword matches.
 */
export function inferBusinessType(freeText: string | null | undefined): BusinessType {
  const t = (freeText ?? '').toLowerCase();
  if (/shop|commerce|store|retail|apparel|merch/.test(t)) return 'ecommerce';
  if (/agency|marketing firm|consultanc/.test(t)) return 'agency';
  if (/saas|software|platform|app\b/.test(t)) return 'saas';
  if (/content|media|publish|blog/.test(t)) return 'content';
  if (!t) return 'other';
  return 'service';
}

function parseRow(row: Record<string, unknown>): BusinessProfile {
  const out: Record<string, unknown> = { ...row };
  for (const col of BUSINESS_PROFILE_JSON_COLUMNS) {
    try {
      out[col] = row[col] ? JSON.parse(row[col] as string) : JSON_DEFAULTS[col];
    } catch {
      out[col] = JSON_DEFAULTS[col];
    }
  }
  out.confirmed_by_human = Boolean(row['confirmed_by_human']);
  return out as unknown as BusinessProfile;
}

export function getBusinessProfile(businessId: string): BusinessProfile | null {
  const row = db.prepare('SELECT * FROM business_profiles WHERE business_id = ?').get(businessId) as Record<string, unknown> | null;
  return row ? parseRow(row) : null;
}

/**
 * Auto-populate a default profile for a business that doesn't have one yet,
 * inferring business_type from the legacy free-text `businesses.type`
 * column and marking it in `inferred_fields` per the migration spec's
 * "clearly marking inferred values" requirement.
 */
export function getOrCreateBusinessProfile(businessId: string): BusinessProfile | null {
  const existing = getBusinessProfile(businessId);
  if (existing) return existing;

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Record<string, unknown> | null;
  if (!business) return null;

  const id = generateId();
  const businessType = inferBusinessType(business['type'] as string | null);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO business_profiles (
      id, business_id, business_type, operating_model, primary_domain, primary_brand,
      products_services, supported_platforms, enabled_connector_types, disabled_connector_types,
      allowed_agent_types, allowed_action_types, strategic_goals, kpis, operating_constraints,
      approval_policy, automation_policy, risk_policy, deployment_policy, seo_policy,
      ecommerce_policy, lead_gen_policy, communication_preferences, inferred_fields,
      confirmed_by_human, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, businessId, businessType, null, null, (business['name'] as string) ?? null,
    JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
    JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify({}),
    JSON.stringify({}), JSON.stringify({}), JSON.stringify({}), JSON.stringify({}), JSON.stringify({}),
    JSON.stringify({}), JSON.stringify({}), JSON.stringify({}), JSON.stringify(['business_type']),
    0, now, now,
  );

  return getBusinessProfile(businessId);
}

export interface BusinessProfileUpdate {
  business_type?: BusinessType;
  operating_model?: string | null;
  primary_domain?: string | null;
  primary_brand?: string | null;
  products_services?: string[];
  supported_platforms?: string[];
  enabled_connector_types?: string[];
  disabled_connector_types?: string[];
  allowed_agent_types?: string[];
  allowed_action_types?: string[];
  strategic_goals?: string[];
  kpis?: string[];
  operating_constraints?: Record<string, unknown>;
  approval_policy?: Record<string, unknown>;
  automation_policy?: Record<string, unknown>;
  risk_policy?: Record<string, unknown>;
  deployment_policy?: Record<string, unknown>;
  seo_policy?: Record<string, unknown>;
  ecommerce_policy?: Record<string, unknown>;
  lead_gen_policy?: Record<string, unknown>;
  communication_preferences?: Record<string, unknown>;
}

const SCALAR_FIELDS = ['business_type', 'operating_model', 'primary_domain', 'primary_brand'] as const;

/**
 * Apply an explicit human/API update. Any field set here is removed from
 * inferred_fields (it's now human-confirmed) and confirmed_by_human flips
 * true, since a real edit implies the operator has reviewed the profile.
 */
export function updateBusinessProfile(businessId: string, patch: BusinessProfileUpdate): BusinessProfile | null {
  const existing = getOrCreateBusinessProfile(businessId);
  if (!existing) return null;

  if (patch.business_type !== undefined && !BUSINESS_TYPES.includes(patch.business_type)) {
    throw new Error(`Invalid business_type: ${patch.business_type}. Must be one of ${BUSINESS_TYPES.join(', ')}.`);
  }

  const updates: string[] = [];
  const values: any[] = [];
  const touchedFields: string[] = [];

  for (const field of SCALAR_FIELDS) {
    if (patch[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(patch[field]);
      touchedFields.push(field);
    }
  }
  for (const col of BUSINESS_PROFILE_JSON_COLUMNS) {
    if (col === 'inferred_fields') continue;
    const val = (patch as Record<string, unknown>)[col];
    if (val !== undefined) {
      updates.push(`${col} = ?`);
      values.push(JSON.stringify(val));
      touchedFields.push(col);
    }
  }

  if (updates.length === 0) return existing;

  const nextInferred = existing.inferred_fields.filter((f) => !touchedFields.includes(f));
  updates.push('inferred_fields = ?');
  values.push(JSON.stringify(nextInferred));
  updates.push('confirmed_by_human = 1');
  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(businessId);

  db.prepare(`UPDATE business_profiles SET ${updates.join(', ')} WHERE business_id = ?`).run(...values);
  return getBusinessProfile(businessId);
}

/**
 * Is the given business_type compatible with an action's supported list?
 * An empty/missing supported_business_types list means "no restriction".
 */
export function isBusinessTypeCompatible(supportedBusinessTypes: string[] | null | undefined, businessType: string): boolean {
  if (!supportedBusinessTypes || supportedBusinessTypes.length === 0) return true;
  return supportedBusinessTypes.includes(businessType);
}

export function isAgentTypeAllowed(profile: BusinessProfile | null, agentRole: string): boolean {
  if (!profile) return true; // no profile yet = no restriction (safe default, not a hard block)
  if (!profile.allowed_agent_types || profile.allowed_agent_types.length === 0) return true;
  return profile.allowed_agent_types.includes(agentRole);
}
