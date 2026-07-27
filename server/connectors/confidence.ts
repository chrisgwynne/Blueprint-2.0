/**
 * Connector Confidence & Identity Verification.
 *
 * Connector health (connected/error/stale — see freshness.ts) is not
 * enough: a connector can be "healthy" and still be pointed at the wrong
 * business's website, Shopify store, or GitHub repo. This module scores
 * nine independent dimensions per connector and rolls them into an
 * overall confidence score + status, persisted in `connector_confidence`.
 *
 * This is a passive, DB-state scorer — it does not make live API calls
 * (no re-implementation of each connector's healthCheck()). Connectivity/
 * auth/authorisation are inferred from the stored connector.status/
 * last_error; freshness reuses the existing freshness.ts computation so
 * the two never drift. Historical-consistency and data-completeness are
 * intentionally lightweight "have we seen enough / does the last sync
 * look non-empty" checks rather than full anomaly detection — a
 * documented scoping simplification, not a full statistical model.
 */
import db, { generateId } from '../db/db.js';
import type { Connector } from '../types/db.js';
import { computeFreshness } from './freshness.js';
import { getBusinessProfile } from '../business/business-profile.js';

export type ConfidenceStatus = 'healthy' | 'warning' | 'degraded' | 'broken' | 'unknown';

export interface ConnectorConfidence {
  id: string;
  connector_id: string;
  business_id: string;
  connectivity_status: ConfidenceStatus;
  authentication_status: ConfidenceStatus;
  authorisation_status: ConfidenceStatus;
  resource_mapping_status: ConfidenceStatus;
  business_identity_status: ConfidenceStatus;
  website_verification_status: ConfidenceStatus;
  freshness_status: ConfidenceStatus;
  historical_consistency_status: ConfidenceStatus;
  data_completeness_status: ConfidenceStatus;
  overall_confidence: number;
  overall_status: ConfidenceStatus;
  verification_details: Record<string, unknown>;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_WEIGHT: Record<ConfidenceStatus, number> = {
  healthy: 1, warning: 0.6, degraded: 0.3, broken: 0, unknown: 0.5,
};

// Config keys, tried in order, that plausibly carry a domain/URL for a
// given connector type. Best-effort — connectors that don't store one
// (e.g. github's repo identity, todoist) fall through to 'unknown'.
const DOMAIN_CONFIG_KEYS = ['siteUrl', 'site_url', 'domain', 'website', 'url', 'shopDomain', 'shop_domain', 'storeUrl'];

// Connector types whose identity is meaningfully checkable against the
// business's declared primary domain/brand at all. Others (e.g. stripe,
// todoist, brave-search) have no natural "belongs to this business's
// website" relationship and are left 'unknown' rather than penalized.
const IDENTITY_CHECKABLE_TYPES = new Set([
  'gbp', 'ga4', 'gsc', 'pagespeed', 'shopify', 'wordpress', 'wix', 'google-merchant', 'github',
]);

// bun:sqlite returns JSON columns as raw strings at the driver level even
// though the TS row types claim they're already parsed — every other
// reader in this codebase re-parses defensively (see e.g.
// server/routes/connectors.ts), so this module does too rather than
// assuming its caller already did.
function parseConfig(connector: Connector): Record<string, unknown> {
  const raw = connector.config as unknown;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.length > 0) {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}

function normalizeDomain(value: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function extractConfiguredDomain(connector: Connector): string | null {
  const config = parseConfig(connector);
  for (const key of DOMAIN_CONFIG_KEYS) {
    const val = (config as Record<string, unknown>)[key];
    if (typeof val === 'string' && val.length > 0) {
      const normalized = normalizeDomain(val);
      if (normalized) return normalized;
    }
  }
  // GitHub has no domain — use owner/repo as its "identity" string instead.
  if (connector.type === 'github') {
    const owner = (config as Record<string, unknown>)['owner'];
    const repo = (config as Record<string, unknown>)['repo'];
    if (typeof owner === 'string' && owner) return `github:${owner}/${repo ?? ''}`;
  }
  return null;
}

function connectivityFromStatus(connector: Connector): ConfidenceStatus {
  if (connector.status === 'connected' || connector.status === 'syncing') return 'healthy';
  if (connector.status === 'error') return 'broken';
  if (connector.status === 'disconnected') return 'broken';
  if (connector.status === 'stale') return 'warning';
  return 'unknown';
}

function authFromError(connector: Connector): { auth: ConfidenceStatus; authz: ConfidenceStatus } {
  const err = (connector.last_error ?? '').toLowerCase();
  if (!err) return { auth: connectivityFromStatus(connector) === 'broken' ? 'unknown' : 'healthy', authz: 'healthy' };
  if (/unauthoriz|invalid.?token|expired.?token|401|auth/i.test(err)) return { auth: 'broken', authz: 'unknown' };
  if (/forbidden|permission|scope|403/i.test(err)) return { auth: 'healthy', authz: 'degraded' };
  return { auth: 'warning', authz: 'warning' };
}

function freshnessToConfidence(status: string): ConfidenceStatus {
  if (status === 'live') return 'healthy';
  if (status === 'stale') return 'warning';
  if (status === 'disconnected' || status === 'error') return 'broken';
  return 'unknown';
}

export interface ComputedConfidence {
  connectivity_status: ConfidenceStatus;
  authentication_status: ConfidenceStatus;
  authorisation_status: ConfidenceStatus;
  resource_mapping_status: ConfidenceStatus;
  business_identity_status: ConfidenceStatus;
  website_verification_status: ConfidenceStatus;
  freshness_status: ConfidenceStatus;
  historical_consistency_status: ConfidenceStatus;
  data_completeness_status: ConfidenceStatus;
  overall_confidence: number;
  overall_status: ConfidenceStatus;
  verification_details: Record<string, unknown>;
}

export function computeConnectorConfidence(connector: Connector): ComputedConfidence {
  const connectivity_status = connectivityFromStatus(connector);
  const { auth: authentication_status, authz: authorisation_status } = authFromError(connector);

  const config = parseConfig(connector);
  const resource_mapping_status: ConfidenceStatus = Object.keys(config).length > 0 ? 'healthy' : 'warning';

  const freshness = computeFreshness(connector as unknown as Record<string, unknown>);
  const freshness_status = freshnessToConfidence(freshness.status);

  const details: Record<string, unknown> = { freshness };

  let business_identity_status: ConfidenceStatus = 'unknown';
  let website_verification_status: ConfidenceStatus = 'unknown';

  if (IDENTITY_CHECKABLE_TYPES.has(connector.type)) {
    const profile = getBusinessProfile(connector.business_id);
    const configuredDomain = extractConfiguredDomain(connector);
    details.configured_identity = configuredDomain;

    if (!configuredDomain) {
      business_identity_status = 'unknown';
      website_verification_status = 'unknown';
    } else if (connector.type === 'github') {
      // No cross-check target for repo ownership today beyond "it's configured at all".
      business_identity_status = 'healthy';
      website_verification_status = 'unknown';
    } else if (connector.type === 'google-merchant') {
      // Merchant Center only makes business sense for an ecommerce business.
      business_identity_status = profile?.business_type === 'ecommerce' ? 'healthy' : 'degraded';
      website_verification_status = profile?.primary_domain
        ? (normalizeDomain(profile.primary_domain) === configuredDomain ? 'healthy' : 'degraded')
        : 'unknown';
    } else if (profile?.primary_domain) {
      const expected = normalizeDomain(profile.primary_domain);
      const matches = expected && expected === configuredDomain;
      business_identity_status = matches ? 'healthy' : 'degraded';
      website_verification_status = matches ? 'healthy' : 'degraded';
      details.expected_domain = expected;
    } else {
      // No primary_domain recorded on the profile yet to check against —
      // can't verify either way, not a failure.
      business_identity_status = 'unknown';
      website_verification_status = 'unknown';
    }
  }

  let historical_consistency_status: ConfidenceStatus = 'unknown';
  let data_completeness_status: ConfidenceStatus = 'unknown';
  try {
    const metricsCount = (db.prepare('SELECT COUNT(*) as n FROM metrics WHERE connector_id = ?').get(connector.id) as { n: number } | undefined)?.n ?? 0;
    historical_consistency_status = metricsCount >= 2 ? 'healthy' : (metricsCount === 1 ? 'warning' : 'unknown');
    data_completeness_status = connector.last_sync && !connector.last_error ? 'healthy' : (connector.last_sync ? 'warning' : 'unknown');
  } catch {
    // metrics table shape varies by connector type in some deployments — leave 'unknown'.
  }

  const dims: ConfidenceStatus[] = [
    connectivity_status, authentication_status, authorisation_status, resource_mapping_status,
    business_identity_status, website_verification_status, freshness_status,
    historical_consistency_status, data_completeness_status,
  ];
  const overall_confidence = Math.round((dims.reduce((sum, d) => sum + STATUS_WEIGHT[d], 0) / dims.length) * 100) / 100;
  const overall_status: ConfidenceStatus =
    overall_confidence >= 0.8 ? 'healthy' :
    overall_confidence >= 0.55 ? 'warning' :
    overall_confidence >= 0.3 ? 'degraded' : 'broken';

  return {
    connectivity_status, authentication_status, authorisation_status, resource_mapping_status,
    business_identity_status, website_verification_status, freshness_status,
    historical_consistency_status, data_completeness_status,
    overall_confidence, overall_status, verification_details: details,
  };
}

function parseRow(row: Record<string, unknown>): ConnectorConfidence {
  return {
    ...row,
    verification_details: row['verification_details'] ? JSON.parse(row['verification_details'] as string) : {},
  } as unknown as ConnectorConfidence;
}

/** Recompute and persist confidence for one connector. */
export function refreshConnectorConfidence(connector: Connector): ConnectorConfidence {
  const computed = computeConnectorConfidence(connector);
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM connector_confidence WHERE connector_id = ?').get(connector.id) as { id: string } | null;

  if (existing) {
    db.prepare(`
      UPDATE connector_confidence SET
        connectivity_status = ?, authentication_status = ?, authorisation_status = ?,
        resource_mapping_status = ?, business_identity_status = ?, website_verification_status = ?,
        freshness_status = ?, historical_consistency_status = ?, data_completeness_status = ?,
        overall_confidence = ?, overall_status = ?, verification_details = ?,
        last_verified_at = ?, updated_at = ?
      WHERE connector_id = ?
    `).run(
      computed.connectivity_status, computed.authentication_status, computed.authorisation_status,
      computed.resource_mapping_status, computed.business_identity_status, computed.website_verification_status,
      computed.freshness_status, computed.historical_consistency_status, computed.data_completeness_status,
      computed.overall_confidence, computed.overall_status, JSON.stringify(computed.verification_details),
      now, now, connector.id,
    );
  } else {
    db.prepare(`
      INSERT INTO connector_confidence (
        id, connector_id, business_id, connectivity_status, authentication_status, authorisation_status,
        resource_mapping_status, business_identity_status, website_verification_status,
        freshness_status, historical_consistency_status, data_completeness_status,
        overall_confidence, overall_status, verification_details, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(), connector.id, connector.business_id,
      computed.connectivity_status, computed.authentication_status, computed.authorisation_status,
      computed.resource_mapping_status, computed.business_identity_status, computed.website_verification_status,
      computed.freshness_status, computed.historical_consistency_status, computed.data_completeness_status,
      computed.overall_confidence, computed.overall_status, JSON.stringify(computed.verification_details),
      now, now, now,
    );
  }

  return getConnectorConfidence(connector.id) as ConnectorConfidence;
}

export function getConnectorConfidence(connectorId: string): ConnectorConfidence | null {
  const row = db.prepare('SELECT * FROM connector_confidence WHERE connector_id = ?').get(connectorId) as Record<string, unknown> | null;
  return row ? parseRow(row) : null;
}

export function listConnectorConfidence(businessId: string): ConnectorConfidence[] {
  const rows = db.prepare('SELECT * FROM connector_confidence WHERE business_id = ? ORDER BY overall_confidence ASC').all(businessId) as Record<string, unknown>[];
  return rows.map(parseRow);
}

/** Low-confidence connectors must not generate autonomous recommendations. */
export function isLowConfidence(confidence: ConnectorConfidence | null): boolean {
  if (!confidence) return true; // never verified = treat as low-confidence, not trusted
  return confidence.overall_status === 'degraded' || confidence.overall_status === 'broken';
}
