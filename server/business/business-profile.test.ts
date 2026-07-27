import { describe, test, expect, beforeAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  inferBusinessType, getBusinessProfile, getOrCreateBusinessProfile,
  updateBusinessProfile, isBusinessTypeCompatible, isAgentTypeAllowed,
} from './business-profile.js';

describe('inferBusinessType', () => {
  test('infers ecommerce from shop/commerce/store keywords', () => {
    expect(inferBusinessType('Shopify ecommerce store')).toBe('ecommerce');
    expect(inferBusinessType('apparel retailer')).toBe('ecommerce');
  });
  test('infers agency', () => {
    expect(inferBusinessType('Digital marketing agency')).toBe('agency');
  });
  test('infers saas', () => {
    expect(inferBusinessType('B2B SaaS platform')).toBe('saas');
  });
  test('infers content', () => {
    expect(inferBusinessType('content and media publisher')).toBe('content');
  });
  test('falls back to service for anything else (safe default)', () => {
    expect(inferBusinessType('Local plumbing service')).toBe('service');
  });
  test('falls back to other for empty/null', () => {
    expect(inferBusinessType(null)).toBe('other');
    expect(inferBusinessType('')).toBe('other');
  });
});

describe('getOrCreateBusinessProfile', () => {
  const BIZ = 'biz_profile_test';

  beforeAll(() => {
    db.prepare(`INSERT INTO businesses (id, name, slug, type) VALUES (?, 'Profile Test Shop', 'profile-test-shop', 'Shopify ecommerce store') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  });

  test('auto-creates a profile with inferred business_type, marked as inferred', () => {
    const profile = getOrCreateBusinessProfile(BIZ);
    expect(profile).not.toBeNull();
    expect(profile!.business_type).toBe('ecommerce');
    expect(profile!.inferred_fields).toContain('business_type');
    expect(profile!.confirmed_by_human).toBe(false);
  });

  test('returns the same profile on subsequent calls (does not duplicate)', () => {
    const first = getOrCreateBusinessProfile(BIZ);
    const second = getOrCreateBusinessProfile(BIZ);
    expect(second!.id).toBe(first!.id);
  });

  test('returns null for a non-existent business', () => {
    expect(getOrCreateBusinessProfile('does-not-exist')).toBeNull();
  });
});

describe('updateBusinessProfile', () => {
  const BIZ = 'biz_profile_update_test';

  beforeAll(() => {
    db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Update Test', 'update-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  });

  test('explicit update clears inferred_fields for touched fields and flips confirmed_by_human', () => {
    getOrCreateBusinessProfile(BIZ); // seed with inferred business_type
    const updated = updateBusinessProfile(BIZ, { business_type: 'agency' });
    expect(updated!.business_type).toBe('agency');
    expect(updated!.inferred_fields).not.toContain('business_type');
    expect(updated!.confirmed_by_human).toBe(true);
  });

  test('rejects an invalid business_type', () => {
    expect(() => updateBusinessProfile(BIZ, { business_type: 'not-a-real-type' as any })).toThrow(/Invalid business_type/);
  });

  test('updates allowed_agent_types and allowed_action_types as arrays', () => {
    const updated = updateBusinessProfile(BIZ, { allowed_agent_types: ['seo-sentinel'], allowed_action_types: ['meta_update'] });
    expect(updated!.allowed_agent_types).toEqual(['seo-sentinel']);
    expect(updated!.allowed_action_types).toEqual(['meta_update']);
  });

  test('returns null for a non-existent business', () => {
    expect(updateBusinessProfile('does-not-exist', { business_type: 'service' })).toBeNull();
  });
});

describe('isBusinessTypeCompatible', () => {
  test('empty/missing list means no restriction', () => {
    expect(isBusinessTypeCompatible([], 'service')).toBe(true);
    expect(isBusinessTypeCompatible(undefined, 'ecommerce')).toBe(true);
  });
  test('a populated list restricts to its members', () => {
    expect(isBusinessTypeCompatible(['ecommerce'], 'ecommerce')).toBe(true);
    expect(isBusinessTypeCompatible(['ecommerce'], 'service')).toBe(false);
  });
});

describe('isAgentTypeAllowed', () => {
  test('null profile = no restriction', () => {
    expect(isAgentTypeAllowed(null, 'merchant')).toBe(true);
  });
  test('empty allowed_agent_types = no restriction', () => {
    const profile = getOrCreateBusinessProfile('biz_profile_test');
    expect(isAgentTypeAllowed(profile, 'anything')).toBe(true);
  });
});
