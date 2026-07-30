/**
 * TDD tests for per-business social publishing policy.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../../db/db.js';
import {
  getPolicy,
  setPolicy,
  checkPostAllowed,
  PolicyViolationError,
  type SocialPolicy,
} from './policy.js';

const BIZ = 'biz_policy_test';
const OTHER_BIZ = 'biz_policy_other';
// Separate connector ID that is never touched by setPolicy tests — ensures the
// 'returns default policy when none configured' test is deterministic regardless
// of describe-block execution order.
const CONN_DEFAULT_ONLY = 'conn_policy_default_only';

beforeAll(() => {
  db.prepare(`INSERT OR IGNORE INTO businesses (id, name, slug) VALUES (?, 'Policy Test', 'policy-test')`).run(BIZ);
  db.prepare(`INSERT OR IGNORE INTO businesses (id, name, slug) VALUES (?, 'Policy Other', 'policy-other')`).run(OTHER_BIZ);
  db.prepare(`
    INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
    VALUES ('conn_policy', ?, 'social', 'FB & IG', '{}', 'connected', '{}')
  `).run(BIZ);
  db.prepare(`
    INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
    VALUES (?, ?, 'social', 'FB & IG Default Only', '{}', 'connected', '{}')
  `).run(CONN_DEFAULT_ONLY, BIZ);
});

describe('getPolicy', () => {
  test('returns default policy when none configured', async () => {
    const policy = await getPolicy(BIZ, CONN_DEFAULT_ONLY);
    expect(policy.mode).toBe('approval_required');
    expect(policy.allowedPlatforms).toContain('facebook');
    expect(policy.allowedPlatforms).toContain('instagram');
  });
});

describe('setPolicy + getPolicy', () => {
  test('persists and retrieves a custom policy', async () => {
    const custom: Partial<SocialPolicy> = {
      mode: 'drafts_only',
      allowedPlatforms: ['facebook'],
      maxDailyPosts: 3,
    };
    await setPolicy(BIZ, 'conn_policy', custom);
    const policy = await getPolicy(BIZ, 'conn_policy');
    expect(policy.mode).toBe('drafts_only');
    expect(policy.allowedPlatforms).toEqual(['facebook']);
    expect(policy.maxDailyPosts).toBe(3);
  });

  test('policy updates are scoped to the connector, not global', async () => {
    await setPolicy(BIZ, 'conn_policy', { mode: 'immediate' });
    // A different connector should still return the default
    const defaultPolicy = await getPolicy(BIZ, 'conn_other_policy');
    expect(defaultPolicy.mode).toBe('approval_required');
  });
});

describe('checkPostAllowed', () => {
  test('drafts_only mode blocks publishing immediately', async () => {
    await setPolicy(BIZ, 'conn_policy', { mode: 'drafts_only' });
    await expect(checkPostAllowed(BIZ, 'conn_policy', {
      platform: 'facebook',
      publishNow: true,
    })).rejects.toBeInstanceOf(PolicyViolationError);
  });

  test('approval_required mode blocks publishing without approval', async () => {
    await setPolicy(BIZ, 'conn_policy', { mode: 'approval_required' });
    await expect(checkPostAllowed(BIZ, 'conn_policy', {
      platform: 'facebook',
      publishNow: true,
      hasApproval: false,
    })).rejects.toBeInstanceOf(PolicyViolationError);
  });

  test('approval_required mode allows publishing with approval', async () => {
    await setPolicy(BIZ, 'conn_policy', { mode: 'approval_required' });
    await expect(checkPostAllowed(BIZ, 'conn_policy', {
      platform: 'facebook',
      publishNow: true,
      hasApproval: true,
    })).resolves.toBeUndefined(); // No error
  });

  test('immediate mode allows publishing without approval', async () => {
    await setPolicy(BIZ, 'conn_policy', { mode: 'immediate' });
    await expect(checkPostAllowed(BIZ, 'conn_policy', {
      platform: 'facebook',
      publishNow: true,
    })).resolves.toBeUndefined();
  });

  test('platform restriction blocks disallowed platform', async () => {
    await setPolicy(BIZ, 'conn_policy', {
      mode: 'immediate',
      allowedPlatforms: ['facebook'],
    });
    await expect(checkPostAllowed(BIZ, 'conn_policy', {
      platform: 'instagram',
      publishNow: false,
    })).rejects.toBeInstanceOf(PolicyViolationError);
  });
});
