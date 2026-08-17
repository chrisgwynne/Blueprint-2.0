import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { updateBusinessProfile } from '../business/business-profile.js';
import {
  deriveConnectorHealthState,
  isPermissionIssue,
  getLatestCoverageComplete,
  explainConnectorHealth,
} from './health.js';
import type { Connector } from '../types/db.js';

const BIZ_A = 'biz_health_explainer_a';
const BIZ_B = 'biz_health_explainer_b';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Health Explainer A', 'health-explainer-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Health Explainer B', 'health-explainer-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);
});

afterAll(() => {
  db.prepare(`DELETE FROM metrics WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM connector_confidence WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM connectors WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
  db.prepare(`DELETE FROM business_profiles WHERE business_id IN (?, ?)`).run(BIZ_A, BIZ_B);
});

function makeConnector(businessId: string, overrides: Partial<Connector> = {}): Connector {
  const id = overrides.id ?? generateId();
  const type = overrides.type ?? 'gsc';
  const status = overrides.status ?? 'connected';
  const config = overrides.config ?? {};
  const lastSync = overrides.last_sync === undefined ? new Date().toISOString() : overrides.last_sync;
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, status, last_sync, last_error, config, created_at)
    VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, businessId, type, overrides.name ?? `${type} connector`, status, lastSync, overrides.last_error ?? null, JSON.stringify(config));
  return {
    id, business_id: businessId, type, name: overrides.name ?? `${type} connector`,
    credentials: {}, status, last_sync: lastSync, last_error: overrides.last_error ?? null,
    config, created_at: '',
  };
}

function writeCoverageMetric(businessId: string, connector: Connector, complete: boolean): void {
  db.prepare(`
    INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, metric_data, period_start, period_end, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(generateId(), businessId, connector.id, `${connector.type}.coverage_complete`, complete ? 1 : 0, null, new Date().toISOString(), new Date().toISOString());
}

describe('deriveConnectorHealthState precedence', () => {
  const base = {
    applicable: true,
    freshnessStatus: 'live',
    authorisationStatus: 'healthy' as const,
    authenticationStatus: 'healthy' as const,
    connectivityStatus: 'healthy' as const,
    coverageComplete: null as boolean | null,
  };

  test('not_applicable wins over everything else', () => {
    expect(deriveConnectorHealthState({ ...base, applicable: false, freshnessStatus: 'error' })).toBe('not_applicable');
  });

  test('permission_required is derived from authorisation_status=degraded alone', () => {
    expect(deriveConnectorHealthState({ ...base, authorisationStatus: 'degraded' })).toBe('permission_required');
  });

  test('permission_required takes precedence over a merely-stale freshness', () => {
    expect(deriveConnectorHealthState({ ...base, authorisationStatus: 'degraded', freshnessStatus: 'stale' })).toBe('permission_required');
  });

  test('freshness error/disconnected is failing', () => {
    expect(deriveConnectorHealthState({ ...base, freshnessStatus: 'error' })).toBe('failing');
    expect(deriveConnectorHealthState({ ...base, freshnessStatus: 'disconnected' })).toBe('failing');
  });

  test('broken authentication or connectivity is failing even if freshness looks live', () => {
    expect(deriveConnectorHealthState({ ...base, authenticationStatus: 'broken' })).toBe('failing');
    expect(deriveConnectorHealthState({ ...base, connectivityStatus: 'broken' })).toBe('failing');
  });

  test('coverageComplete === false is partial, distinct from stale/healthy', () => {
    expect(deriveConnectorHealthState({ ...base, coverageComplete: false })).toBe('partial');
  });

  test('failing takes precedence over partial', () => {
    expect(deriveConnectorHealthState({ ...base, freshnessStatus: 'error', coverageComplete: false })).toBe('failing');
  });

  test('stale freshness with complete (or unreported) coverage is stale', () => {
    expect(deriveConnectorHealthState({ ...base, freshnessStatus: 'stale' })).toBe('stale');
    expect(deriveConnectorHealthState({ ...base, freshnessStatus: 'stale', coverageComplete: true })).toBe('stale');
  });

  test('live freshness, no coverage problem, applicable => healthy', () => {
    expect(deriveConnectorHealthState(base)).toBe('healthy');
  });
});

describe('isPermissionIssue', () => {
  test('true only for authorisation_status=degraded', () => {
    expect(isPermissionIssue('degraded')).toBe(true);
    expect(isPermissionIssue('healthy')).toBe(false);
    expect(isPermissionIssue('broken')).toBe(false);
    expect(isPermissionIssue('warning')).toBe(false);
    expect(isPermissionIssue('unknown')).toBe(false);
  });
});

describe('getLatestCoverageComplete', () => {
  test('null when the connector type has never reported a coverage metric', () => {
    const c = makeConnector(BIZ_A, { type: 'gsc' });
    expect(getLatestCoverageComplete(c.id, c.type)).toBeNull();
  });

  test('reflects the most recently written value, not the first', () => {
    const c = makeConnector(BIZ_A, { type: 'google-merchant' });
    writeCoverageMetric(BIZ_A, c, true);
    writeCoverageMetric(BIZ_A, c, false);
    expect(getLatestCoverageComplete(c.id, c.type)).toBe(false);
  });
});

describe('explainConnectorHealth — stale data', () => {
  test('a connector past its stale threshold is reported stale, never healthy, with last success and a next step', () => {
    const staleTime = new Date(Date.now() - 100 * 3600000).toISOString(); // gsc threshold is 24h
    const c = makeConnector(BIZ_A, { type: 'gsc', status: 'connected', last_sync: staleTime });
    const result = explainConnectorHealth(c);
    expect(result.state).toBe('stale');
    expect(result.last_success).toBe(staleTime);
    expect(result.impact).toBeTruthy();
    expect(result.impact).not.toMatch(/\bhealthy\b/i);
    expect(result.next_step).toBeTruthy();
  });
});

describe('explainConnectorHealth — partial sync never claims freshness', () => {
  test('coverage_complete=false is reported as partial with honest, non-fresh-claiming impact text', () => {
    const c = makeConnector(BIZ_A, { type: 'google-merchant', status: 'connected', last_sync: new Date().toISOString() });
    writeCoverageMetric(BIZ_A, c, false);
    const result = explainConnectorHealth(c);
    expect(result.state).toBe('partial');
    expect(result.coverage_complete).toBe(false);
    // Even though freshness would otherwise read "live" (just synced), the
    // health explanation must not describe the data as complete/fresh.
    expect(result.summary).toMatch(/incomplete|partial/i);
    expect(result.impact).toMatch(/lower bound|incomplete/i);
    expect(result.next_step).toBeTruthy();
  });

  test('coverage_complete=true does not force a partial state', () => {
    const c = makeConnector(BIZ_A, { type: 'google-merchant', status: 'connected', last_sync: new Date().toISOString() });
    writeCoverageMetric(BIZ_A, c, true);
    const result = explainConnectorHealth(c);
    expect(result.state).toBe('healthy');
    expect(result.coverage_complete).toBe(true);
  });
});

describe('explainConnectorHealth — failing connector', () => {
  test('a disconnected/errored connector is reported failing with impact + next step', () => {
    const c = makeConnector(BIZ_A, { type: 'shopify', status: 'error', last_error: 'Request timed out' });
    const result = explainConnectorHealth(c);
    expect(result.state).toBe('failing');
    expect(result.impact).toBeTruthy();
    expect(result.next_step).toBeTruthy();
  });

  test('a connector that has never completed a successful sync says so rather than implying stale data exists', () => {
    const c = makeConnector(BIZ_A, { type: 'shopify', status: 'disconnected', last_sync: null });
    const result = explainConnectorHealth(c);
    expect(result.state).toBe('failing');
    expect(result.last_success).toBeNull();
    expect(result.impact).toMatch(/never successfully synced|no data/i);
  });
});

describe('explainConnectorHealth — permission_required is distinct from generic degraded/failing', () => {
  test('a forbidden/scope error yields permission_required, not failing', () => {
    const c = makeConnector(BIZ_A, {
      type: 'gsc', status: 'error',
      last_error: 'Google API error: 403 Forbidden — insufficient permission/scope for this property',
    });
    const result = explainConnectorHealth(c);
    expect(result.state).toBe('permission_required');
    expect(result.next_step).toMatch(/reconnect/i);
    expect(result.next_step).toMatch(/permission|scope/i);
  });

  test('a 401/unauthorized error yields failing, not permission_required (transient auth failure, different fix)', () => {
    const c = makeConnector(BIZ_A, {
      type: 'gsc', status: 'error',
      last_error: 'Invalid token — unauthorized (401)',
    });
    const result = explainConnectorHealth(c);
    expect(result.state).toBe('failing');
  });
});

describe('explainConnectorHealth — not-applicable / irrelevant connector', () => {
  test('a never-synced google-merchant connector on a non-ecommerce business is not_applicable, with no impact/next-step noise', () => {
    updateBusinessProfile(BIZ_A, { business_type: 'service' });
    const c = makeConnector(BIZ_A, { type: 'google-merchant', status: 'disconnected', last_sync: null });
    const result = explainConnectorHealth(c);
    expect(result.state).toBe('not_applicable');
    expect(result.impact).toBeNull();
    expect(result.next_step).toBeNull();
  });
});

describe('explainConnectorHealth — cross-business isolation', () => {
  test('identical connector type/config in two businesses can resolve to different health states independently', () => {
    updateBusinessProfile(BIZ_A, { business_type: 'service' });
    updateBusinessProfile(BIZ_B, { business_type: 'ecommerce' });

    const connA = makeConnector(BIZ_A, { type: 'google-merchant', status: 'disconnected', last_sync: null });
    const connB = makeConnector(BIZ_B, { type: 'google-merchant', status: 'disconnected', last_sync: null });

    expect(explainConnectorHealth(connA).state).toBe('not_applicable');
    expect(explainConnectorHealth(connB).state).toBe('failing'); // applicable here, never synced -> disconnected -> failing
  });

  test('a coverage_complete metric written for one business/connector never leaks into another business\'s connector of the same type', () => {
    const connA = makeConnector(BIZ_A, { type: 'google-merchant', status: 'connected' });
    const connB = makeConnector(BIZ_B, { type: 'google-merchant', status: 'connected' });
    updateBusinessProfile(BIZ_B, { business_type: 'ecommerce' });

    writeCoverageMetric(BIZ_A, connA, false);

    expect(getLatestCoverageComplete(connA.id, 'google-merchant')).toBe(false);
    expect(getLatestCoverageComplete(connB.id, 'google-merchant')).toBeNull();
    expect(explainConnectorHealth(connB).state).not.toBe('partial');
  });
});
