import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { computeConnectorConfidence, refreshConnectorConfidence, getConnectorConfidence, listConnectorConfidence, isLowConfidence } from './confidence.js';
import { updateBusinessProfile } from '../business/business-profile.js';
import type { Connector } from '../types/db.js';

const BIZ = 'biz_confidence_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Confidence Test', 'confidence-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM connector_confidence WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM connectors WHERE business_id = ?`).run(BIZ);
});

function makeConnector(overrides: Partial<Connector> = {}): Connector {
  const id = generateId();
  const type = overrides.type ?? 'gsc';
  const status = overrides.status ?? 'connected';
  const config = overrides.config ?? {};
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, status, last_sync, last_error, config, created_at)
    VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, BIZ, type, `${type} connector`, status, overrides.last_sync ?? new Date().toISOString(), overrides.last_error ?? null, JSON.stringify(config));
  return { id, business_id: BIZ, type, name: `${type} connector`, credentials: {}, status, last_sync: overrides.last_sync ?? new Date().toISOString(), last_error: overrides.last_error ?? null, config, created_at: '' };
}

describe('computeConnectorConfidence', () => {
  test('a healthy, freshly-synced connector scores well', () => {
    const c = makeConnector({ status: 'connected' });
    const result = computeConnectorConfidence(c);
    expect(result.connectivity_status).toBe('healthy');
    expect(result.freshness_status).toBe('healthy');
    expect(result.overall_confidence).toBeGreaterThan(0.5);
  });

  test('a disconnected/errored connector scores as broken', () => {
    const c = makeConnector({ status: 'error', last_error: 'Invalid token — unauthorized' });
    const result = computeConnectorConfidence(c);
    expect(result.connectivity_status).toBe('broken');
    expect(result.authentication_status).toBe('broken');
    expect(result.overall_status === 'degraded' || result.overall_status === 'broken').toBe(true);
  });

  test('identity is unknown when the business has no primary_domain to check against', () => {
    const c = makeConnector({ type: 'ga4', config: { siteUrl: 'https://example.com' } });
    const result = computeConnectorConfidence(c);
    expect(result.business_identity_status).toBe('unknown');
  });

  test('identity matches when the connector domain matches the profile primary_domain', () => {
    updateBusinessProfile(BIZ, { primary_domain: 'example.com' });
    const c = makeConnector({ type: 'ga4', config: { siteUrl: 'https://example.com/path' } });
    const result = computeConnectorConfidence(c);
    expect(result.business_identity_status).toBe('healthy');
    expect(result.website_verification_status).toBe('healthy');
  });

  test('identity is flagged degraded when the connector domain does not match', () => {
    updateBusinessProfile(BIZ, { primary_domain: 'example.com' });
    const c = makeConnector({ type: 'ga4', config: { siteUrl: 'https://totally-different-site.com' } });
    const result = computeConnectorConfidence(c);
    expect(result.business_identity_status).toBe('degraded');
  });

  test('Merchant Center on a non-ecommerce business is flagged degraded', () => {
    updateBusinessProfile(BIZ, { business_type: 'service' });
    const c = makeConnector({ type: 'google-merchant', config: { domain: 'example.com' } });
    const result = computeConnectorConfidence(c);
    expect(result.business_identity_status).toBe('degraded');
  });

  test('a connector type with no identity relationship (e.g. stripe) is left unknown, not penalised', () => {
    const c = makeConnector({ type: 'stripe' });
    const result = computeConnectorConfidence(c);
    expect(result.business_identity_status).toBe('unknown');
  });
});

describe('refreshConnectorConfidence / getConnectorConfidence / listConnectorConfidence', () => {
  test('persists and is retrievable', () => {
    const c = makeConnector({ status: 'connected' });
    refreshConnectorConfidence(c);
    const stored = getConnectorConfidence(c.id);
    expect(stored).not.toBeNull();
    expect(stored!.connector_id).toBe(c.id);
  });

  test('re-running updates the same row rather than duplicating it', () => {
    const c = makeConnector({ status: 'connected' });
    refreshConnectorConfidence(c);
    refreshConnectorConfidence(c);
    const rows = db.prepare('SELECT COUNT(*) as n FROM connector_confidence WHERE connector_id = ?').get(c.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  test('listConnectorConfidence returns all rows for a business', () => {
    const list = listConnectorConfidence(BIZ);
    expect(list.length).toBeGreaterThan(0);
  });
});

describe('isLowConfidence', () => {
  test('null (never verified) is treated as low confidence', () => {
    expect(isLowConfidence(null)).toBe(true);
  });
  test('degraded/broken overall_status is low confidence', () => {
    expect(isLowConfidence({ overall_status: 'degraded' } as any)).toBe(true);
    expect(isLowConfidence({ overall_status: 'broken' } as any)).toBe(true);
  });
  test('healthy/warning overall_status is not low confidence', () => {
    expect(isLowConfidence({ overall_status: 'healthy' } as any)).toBe(false);
    expect(isLowConfidence({ overall_status: 'warning' } as any)).toBe(false);
  });
});
