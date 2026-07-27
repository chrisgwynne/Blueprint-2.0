import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../db/db.js';
import { shouldAutoApprove, DANGEROUS_ACTION_TYPES, type TaskRow } from './approval.js';
import { updateBusinessProfile } from '../business/business-profile.js';

const BIZ = 'biz_approval_policy_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Approval Policy Test', 'approval-policy-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'fixture', business_id: BIZ, title: 'Fixture', description: null,
    status: 'proposed', trust_tier: 'yellow', priority: 'p2', proposed_by: 'test',
    action_type: 'meta_update', action_payload: {}, confidence: 0.8,
    created_at: '', updated_at: '', approval_mode: 'requires_approval',
    ...overrides,
  };
}

describe('shouldAutoApprove — Business Profile approval_policy precedence', () => {
  test('a DANGEROUS_ACTION_TYPES member is never auto-approved regardless of business policy', () => {
    const dangerous = [...DANGEROUS_ACTION_TYPES][0]!;
    updateBusinessProfile(BIZ, { approval_policy: { allow_auto_approve: [dangerous] } });
    expect(shouldAutoApprove(makeTask({ action_type: dangerous }))).toBe(false);
  });

  test('always_require_approval overrides everything else, including a permissive default_mode', () => {
    updateBusinessProfile(BIZ, { approval_policy: { always_require_approval: ['meta_update'], default_mode: 'auto' } });
    expect(shouldAutoApprove(makeTask({ action_type: 'meta_update' }))).toBe(false);
  });

  test('allow_auto_approve grants auto-approval for a listed action_type', () => {
    updateBusinessProfile(BIZ, { approval_policy: { allow_auto_approve: ['meta_update'], always_require_approval: [] } });
    expect(shouldAutoApprove(makeTask({ action_type: 'meta_update' }))).toBe(true);
  });

  test('default_mode applies when the action_type is in neither list', () => {
    updateBusinessProfile(BIZ, { approval_policy: { allow_auto_approve: [], always_require_approval: [], default_mode: 'auto' } });
    expect(shouldAutoApprove(makeTask({ action_type: 'content_draft' }))).toBe(true);

    updateBusinessProfile(BIZ, { approval_policy: { default_mode: 'manual' } });
    expect(shouldAutoApprove(makeTask({ action_type: 'content_draft' }))).toBe(false);
  });

  test('falls through to the legacy trust_tier/approval_mode behaviour when no Business Profile policy applies', () => {
    updateBusinessProfile(BIZ, { approval_policy: {} });
    expect(shouldAutoApprove(makeTask({ action_type: 'content_draft', trust_tier: 'green', approval_mode: 'auto' }))).toBe(true);
    expect(shouldAutoApprove(makeTask({ action_type: 'content_draft', trust_tier: 'yellow', approval_mode: 'auto' }))).toBe(false);
  });
});
