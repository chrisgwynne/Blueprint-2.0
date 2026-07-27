/**
 * Typed Action & Executor Registry gate inside approveTask() (Phase 2-INT).
 * Covers the two hard-blocking checks (unregistered action_type,
 * business-type incompatibility) and the non-blocking system_issues
 * warning path, without touching the CAS/concurrency behaviour already
 * covered by task-queue.approve-cancel.test.ts.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db from '../db/db.js';
import { createTask, approveTask } from './task-queue.js';
import { updateBusinessProfile } from '../business/business-profile.js';
import { listSystemIssues } from '../system/system-issues.js';

const BIZ = 'biz_registry_gate_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Registry Gate Test', 'registry-gate-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterEach(() => {
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

function propose(actionType: string | null) {
  return createTask({
    business_id: BIZ,
    title: 'Registry gate fixture task',
    proposed_by: 'test',
    action_type: actionType,
    action_payload: {},
    approval_mode: 'requires_approval',
  })!;
}

describe('approveTask — Typed Action Registry gate', () => {
  test('a task with no action_type (manual to-do) is never blocked', () => {
    const task = propose(null);
    const after = approveTask(task.id, 'tester');
    expect(after!.status).toBe('approved');
  });

  test('an unregistered action_type blocks approval and files a system issue', () => {
    const task = propose('this_action_type_does_not_exist_anywhere');
    expect(() => approveTask(task.id, 'tester')).toThrow(/not registered in the Typed Action Registry/);

    const stillProposed = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(stillProposed.status).toBe('proposed');

    const issues = listSystemIssues({ business_id: BIZ, issue_type: 'action_validation_failure' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.related_task_id).toBe(task.id);
  });

  // product_suggestion (like the shopify_* family) is ecommerce-only, but —
  // unlike shopify_* — it is NOT in executor.ts's EXECUTABLE_ACTION_TYPES,
  // so approving it never triggers a real (async, fire-and-forget)
  // execution attempt. Keeps this test deterministic and free of the
  // executor's own side effects.
  test('an ecommerce-only action_type on a service business blocks approval', () => {
    updateBusinessProfile(BIZ, { business_type: 'service' });
    const task = propose('product_suggestion');
    expect(() => approveTask(task.id, 'tester')).toThrow(/business_type_incompatible|supports business types/);
  });

  test('the same action_type succeeds once the business profile is ecommerce', () => {
    updateBusinessProfile(BIZ, { business_type: 'ecommerce' });
    const task = propose('product_suggestion');
    const after = approveTask(task.id, 'tester');
    expect(after!.status).toBe('approved');
  });

  // gbp_post requires a 'gbp' connector but — unlike gbp_update — is not in
  // executor.ts's EXECUTABLE_ACTION_TYPES, for the same determinism reason.
  test('a registered action_type with no configured connector approves with a non-blocking warning', () => {
    updateBusinessProfile(BIZ, { business_type: 'other' });
    const task = propose('gbp_post'); // requires a 'gbp' connector — none configured for BIZ
    const after = approveTask(task.id, 'tester');
    expect(after!.status).toBe('approved');

    const warnings = listSystemIssues({ business_id: BIZ, issue_type: 'action_validation_warning:missing_connector' });
    expect(warnings.length).toBeGreaterThan(0);
  });
});
