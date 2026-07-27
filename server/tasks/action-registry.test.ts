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
    ];
    for (const actionType of known) {
      expect(getActionRegistryEntry(actionType), `missing registry entry for ${actionType}`).not.toBeNull();
    }
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
  test('a null action_type always passes with no issues (manual to-do exemption)', () => {
    const result = validateAction({ actionType: null, payload: {}, businessProfile: null, connectors: [] });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('an unregistered action_type is a blocking issue', () => {
    const result = validateAction({ actionType: 'totally_made_up_action_xyz', payload: {}, businessProfile: null, connectors: [] });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.code).toBe('unknown_action_type');
  });

  test('an ecommerce-only action on a service business is a blocking issue', () => {
    const profile = { business_type: 'service' } as any;
    const result = validateAction({ actionType: 'shopify_product_update', payload: {}, businessProfile: profile, connectors: [] });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.code).toBe('business_type_incompatible');
  });

  test('an ecommerce-only action on an ecommerce business passes', () => {
    const profile = { business_type: 'ecommerce' } as any;
    const result = validateAction({ actionType: 'shopify_product_update', payload: {}, businessProfile: profile, connectors: [] });
    expect(result.valid).toBe(true);
  });

  test('missing a required connector is a warning, not a blocker', () => {
    const result = validateAction({ actionType: 'github_issue', payload: {}, businessProfile: null, connectors: [] });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === 'missing_connector')).toBe(true);
  });

  test('a required connector present clears the missing_connector warning', () => {
    const result = validateAction({
      actionType: 'github_issue', payload: {}, businessProfile: null,
      connectors: [{ id: 'c1', business_id: 'b1', type: 'github', name: 'GH', credentials: {}, status: 'connected', last_sync: null, last_error: null, config: {}, created_at: '' }],
    });
    expect(result.warnings.some((w) => w.code === 'missing_connector')).toBe(false);
  });
});
