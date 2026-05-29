/**
 * Pure-logic tests for the matcher's requirement derivation and scoring. These
 * don't touch the DB (matchAgent/isScopeInFlight are tested separately in the
 * DB-backed suite).
 */
import { test, expect, describe } from 'bun:test';
import {
  deriveRequirements,
  scoreAgentForRequirements,
  buildAssignmentReason,
} from './agentMatcher.js';
import { ROLE_SPECS } from './agentActivationRules.js';

describe('deriveRequirements', () => {
  test('dangerous action_type forces high risk + requires approval', () => {
    const req = deriveRequirements({ action_type: 'github_pr' });
    expect(req.risk).toBe('high');
    expect(req.requires_approval).toBe(true);
  });

  test('critical severity is high urgency', () => {
    const req = deriveRequirements({ severity: 'critical', connector_type: 'gsc' });
    expect(req.urgency).toBe('critical');
    expect(req.areas).toContain('gsc');
  });

  test('all derived tasks require approval (server-owned floor never weakened)', () => {
    const req = deriveRequirements({ action_type: 'meta_update', severity: 'info' });
    expect(req.requires_approval).toBe(true);
  });
});

describe('scoreAgentForRequirements — best-match selection', () => {
  test('the owning specialist outscores an unrelated agent for a GSC signal', () => {
    const req = deriveRequirements({ connector_type: 'gsc', rule_id: 'gsc:ranking_drop', action_type: 'meta_update' });
    const seo = scoreAgentForRequirements('seo-sentinel', ROLE_SPECS['seo-sentinel']!, req);
    const merchant = scoreAgentForRequirements('merchant', ROLE_SPECS.merchant!, req);
    expect(seo.score).toBeGreaterThan(merchant.score);
    expect(seo.owns_task_type).toBe(true);
    expect(seo.matched_areas).toContain('gsc');
  });

  test('owning the exact action_type is decisive', () => {
    const req = deriveRequirements({ connector_type: 'shopify', action_type: 'shopify_product_update' });
    const merchant = scoreAgentForRequirements('merchant', ROLE_SPECS.merchant!, req);
    expect(merchant.owns_task_type).toBe(true);
    expect(merchant.score).toBeGreaterThanOrEqual(25);
  });

  test('an agent with no overlap scores zero', () => {
    const req = deriveRequirements({ connector_type: 'stripe', rule_id: 'stripe:refund_spike' });
    const seo = scoreAgentForRequirements('seo-sentinel', ROLE_SPECS['seo-sentinel']!, req);
    expect(seo.score).toBe(0);
  });
});

describe('buildAssignmentReason', () => {
  test('produces a human-readable, specific reason', () => {
    const req = deriveRequirements({ connector_type: 'gsc', rule_id: 'gsc:indexing', action_type: 'meta_update' });
    const score = scoreAgentForRequirements('seo-sentinel', ROLE_SPECS['seo-sentinel']!, req);
    const reason = buildAssignmentReason('seo-sentinel', req, score);
    expect(reason).toContain('seo-sentinel');
    expect(reason.toLowerCase()).toContain('gsc');
    expect(reason).toMatch(/because/i);
  });
});
