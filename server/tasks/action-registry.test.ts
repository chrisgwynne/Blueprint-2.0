import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../db/db.js';
import {
  getActionRegistryEntry, listActionRegistryEntries, upsertActionRegistryEntry,
  validatePayloadAgainstSchema, validateAction,
} from './action-registry.js';

describe('seeded registry', () => {
  test('contains every action_type currently in production use', () => {
    const known = [
      'github_issue', 'github_pr', 'investigation', 'deep_investigation', 'content_draft',
      'meta_update', 'shopify_product_create', 'shopify_product_update', 'shopify_description_update',
      'shopify_page_create', 'shopify_page_update', 'shopify_blog_post_create', 'shopify_meta_update',
      'shopify_collection_update', 'shopify_tag_update', 'shopify_theme_edit', 'hire_agent',
      'wix_seo_update', 'server_file_write', 'server_file_rollback', 'gbp_update', 'klaviyo_flow_update',
      'meta_ads_update', 'connect_connector', 'research_connector', 'notification', 'strategic_review',
      'product_suggestion', 'content_brief', 'page_optimisation', 'gbp_post',
      // Issue #90: conductor was proposing these but they were missing from the registry,
      // causing action_validation_failure system issues to accumulate unboundedly.
      'config_change', 'deployment_hardening',
    ];
    for (const actionType of known) {
      expect(getActionRegistryEntry(actionType), `missing registry entry for ${actionType}`).not.toBeNull();
    }
  });

  test('config_change is registered as medium risk, human-review-only (no executor)', () => {
    const entry = getActionRegistryEntry('config_change')!;
    expect(entry).not.toBeNull();
    expect(entry.risk_level).toBe('medium');
    expect(entry.requires_approval).toBe(true);
    expect(entry.dispatched_by_executor).toBe(false);
    expect(entry.active).toBe(true);
  });

  test('deployment_hardening is registered as medium risk, human-review-only (no executor)', () => {
    const entry = getActionRegistryEntry('deployment_hardening')!;
    expect(entry).not.toBeNull();
    expect(entry.risk_level).toBe('medium');
    expect(entry.requires_approval).toBe(true);
    expect(entry.dispatched_by_executor).toBe(false);
    expect(entry.active).toBe(true);
  });

  test('shopify_* actions are restricted to ecommerce businesses', () => {
    const entry = getActionRegistryEntry('shopify_product_update')!;
    expect(entry.supported_business_types).toEqual(['ecommerce']);
  });

  test('github_issue is classified external_verifiable (matches execution-safety.ts)', () => {
    expect(getActionRegistryEntry('github_issue')!.side_effect_classification).toBe('external_verifiable');
  });

  test('listActionRegistryEntries returns entries sorted by action_type', () => {
    const entries = listActionRegistryEntries();
    const names = entries.map((e) => e.action_type);
    const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(names).toEqual(sorted);
  });
});

describe('upsertActionRegistryEntry', () => {
  beforeAll(() => {
    db.prepare(`DELETE FROM action_registry WHERE action_type IN ('test_custom_action', 'test_custom_action_2')`).run();
  });

  test('creates a new entry with sensible defaults', () => {
    const entry = upsertActionRegistryEntry('test_custom_action', { description: 'A test action', risk_level: 'low' });
    expect(entry.action_type).toBe('test_custom_action');
    expect(entry.version).toBe(1);
    expect(entry.description).toBe('A test action');
    expect(entry.active).toBe(true);
  });

  test('updating an existing entry bumps version and only touches provided fields', () => {
    db.prepare(`DELETE FROM action_registry WHERE action_type = 'test_custom_action_2'`).run();
    upsertActionRegistryEntry('test_custom_action_2', { description: 'v1', risk_level: 'low' });
    const updated = upsertActionRegistryEntry('test_custom_action_2', { risk_level: 'high' });
    expect(updated.version).toBe(2);
    expect(updated.risk_level).toBe('high');
    expect(updated.description).toBe('v1'); // untouched
  });

  test('a 3-element measurement_window_days writes through to action_windows (consolidation)', () => {
    db.prepare(`DELETE FROM action_windows WHERE action_type = 'test_windows_sync_action'`).run();
    upsertActionRegistryEntry('test_windows_sync_action', {
      measurement_window_days: [5, 10, 20],
      success_metrics: ['some.metric'],
      display_name: 'Test Windows Sync',
      measurement_notes: 'test notes',
      volatility: 'low',
    });
    const row = db.prepare('SELECT * FROM action_windows WHERE action_type = ?').get('test_windows_sync_action') as any;
    expect(row).not.toBeNull();
    expect(row.display_name).toBe('Test Windows Sync');
    expect(row.min_days).toBe(5);
    expect(row.expected_days).toBe(10);
    expect(row.max_days).toBe(20);
    expect(JSON.parse(row.metric_types)).toEqual(['some.metric']);
    expect(row.volatility).toBe('low');
  });

  test('editing an existing action_type updates its action_windows row in place, not a duplicate', () => {
    db.prepare(`DELETE FROM action_windows WHERE action_type = 'test_windows_sync_action_2'`).run();
    upsertActionRegistryEntry('test_windows_sync_action_2', {
      measurement_window_days: [1, 2, 3], display_name: 'v1', volatility: 'low',
    });
    upsertActionRegistryEntry('test_windows_sync_action_2', {
      measurement_window_days: [4, 5, 6], display_name: 'v2', volatility: 'high',
    });
    const rows = db.prepare('SELECT * FROM action_windows WHERE action_type = ?').all('test_windows_sync_action_2') as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].display_name).toBe('v2');
    expect(rows[0].min_days).toBe(4);
    expect(rows[0].volatility).toBe('high');
  });
});

describe('validatePayloadAgainstSchema', () => {
  test('empty schema always passes', () => {
    expect(validatePayloadAgainstSchema({}, { anything: true })).toEqual([]);
  });

  test('detects a type mismatch', () => {
    const issues = validatePayloadAgainstSchema({ type: 'object' }, 'not an object');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.code).toBe('type_mismatch');
  });

  test('detects a missing required field', () => {
    const issues = validatePayloadAgainstSchema({ type: 'object', required: ['url'] }, {});
    expect(issues.some((i) => i.code === 'required')).toBe(true);
  });

  test('validates nested properties and array items', () => {
    const schema = {
      type: 'object' as const,
      required: ['title'],
      properties: {
        title: { type: 'string' as const, minLength: 3 },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
      },
    };
    expect(validatePayloadAgainstSchema(schema, { title: 'okay', tags: ['a', 'b'] })).toEqual([]);
    const issues = validatePayloadAgainstSchema(schema, { title: 'ab' });
    expect(issues.some((i) => i.code === 'min_length')).toBe(true);
  });

  test('enum mismatch is reported', () => {
    const issues = validatePayloadAgainstSchema({ enum: ['a', 'b'] }, 'c');
    expect(issues.some((i) => i.code === 'enum_mismatch')).toBe(true);
  });
});

describe('validateAction', () => {
  const BIZ = 'biz_validate_action_test';

  beforeAll(() => {
    db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Validate Action Test', 'validate-action-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  });

  test('a null action_type always passes with no issues (manual to-do exemption)', () => {
    const result = validateAction({ actionType: null, payload: {}, businessId: BIZ, businessProfile: null, connectors: [] });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('an unregistered action_type is a blocking issue', () => {
    const result = validateAction({ actionType: 'totally_made_up_action_xyz', payload: {}, businessId: BIZ, businessProfile: null, connectors: [] });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.code).toBe('unknown_action_type');
  });

  test('an ecommerce-only action on a service business is a blocking issue', () => {
    const profile = { business_type: 'service' } as any;
    const result = validateAction({ actionType: 'shopify_product_update', payload: {}, businessId: BIZ, businessProfile: profile, connectors: [] });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'business_type_incompatible')).toBe(true);
  });

  test('an ecommerce-only action with no required connectors passes on an ecommerce business', () => {
    const profile = { business_type: 'ecommerce' } as any;
    const result = validateAction({ actionType: 'product_suggestion', payload: {}, businessId: BIZ, businessProfile: profile, connectors: [] });
    expect(result.valid).toBe(true);
  });

  test('a required connector missing entirely is a blocking issue', () => {
    const result = validateAction({ actionType: 'github_issue', payload: {}, businessId: BIZ, businessProfile: null, connectors: [] });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'missing_connector')).toBe(true);
  });

  test('a required connector present but never confidence-scored is still blocking (fail-closed)', () => {
    const result = validateAction({
      actionType: 'github_issue', payload: {}, businessId: BIZ, businessProfile: null,
      connectors: [{ id: 'c-unscored', business_id: BIZ, type: 'github', name: 'GH', credentials: {}, status: 'connected', last_sync: null, last_error: null, config: {}, created_at: '' }],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'connector_confidence_low')).toBe(true);
    expect(result.issues.some((i) => i.code === 'missing_connector')).toBe(false);
  });

  test('a required connector present AND confidence-scored healthy passes both checks', () => {
    const connectorId = 'c-healthy';
    db.prepare(`INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at) VALUES (?, ?, 'github', 'GH', '{}', 'connected', '{}', CURRENT_TIMESTAMP) ON CONFLICT(id) DO NOTHING`).run(connectorId, BIZ);
    db.prepare(`
      INSERT INTO connector_confidence (id, connector_id, business_id, overall_confidence, overall_status, created_at, updated_at)
      VALUES ('cc-healthy', ?, ?, 0.95, 'healthy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO NOTHING
    `).run(connectorId, BIZ);
    const result = validateAction({
      actionType: 'github_issue', payload: {}, businessId: BIZ, businessProfile: null,
      connectors: [{ id: connectorId, business_id: BIZ, type: 'github', name: 'GH', credentials: {}, status: 'connected', last_sync: null, last_error: null, config: {}, created_at: '' }],
    });
    expect(result.issues.some((i) => i.code === 'missing_connector')).toBe(false);
    expect(result.issues.some((i) => i.code === 'connector_confidence_low')).toBe(false);
  });
});
