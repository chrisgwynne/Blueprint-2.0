/**
 * Typed Action & Executor Registry gate inside approveTask() (Phase 2-INT,
 * full-enforcement pass). Every check the spec lists is now a hard block —
 * action exists, business type supports action, required connectors
 * exist, connector confidence is acceptable, payload matches schema,
 * permissions exist, executor exists/is healthy. Doesn't touch the
 * CAS/concurrency behaviour already covered by task-queue.approve-cancel.test.ts.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { createTask, approveTask } from './task-queue.js';
import { updateBusinessProfile } from '../business/business-profile.js';
import { listSystemIssues } from '../system/system-issues.js';
import { upsertActionRegistryEntry } from './action-registry.js';
import { isExecutable } from './executor.js';

const BIZ = 'biz_registry_gate_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Registry Gate Test', 'registry-gate-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterEach(() => {
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM connector_confidence WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM connectors WHERE business_id = ?`).run(BIZ);
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

function addHealthyConnector(type: string): string {
  const id = generateId();
  db.prepare(`INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at) VALUES (?, ?, ?, ?, '{}', 'connected', '{}', CURRENT_TIMESTAMP)`)
    .run(id, BIZ, type, `${type} connector`);
  db.prepare(`
    INSERT INTO connector_confidence (id, connector_id, business_id, overall_confidence, overall_status, created_at, updated_at)
    VALUES (?, ?, ?, 0.95, 'healthy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(generateId(), id, BIZ);
  return id;
}

describe('approveTask — Typed Action Registry gate (full enforcement)', () => {
  test('a task with no action_type (manual to-do) is never blocked', () => {
    const task = propose(null);
    const after = approveTask(task.id, 'tester');
    expect(after!.status).toBe('approved');
  });

  test('an unregistered action_type blocks proposal and files a system issue', () => {
    expect(() => propose('this_action_type_does_not_exist_anywhere')).toThrow(/not registered in the Typed Action Registry/);

    const tasks = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE business_id = ?').get(BIZ) as { count: number };
    expect(tasks.count).toBe(0);

    const issues = listSystemIssues({ business_id: BIZ, issue_type: 'action_validation_failure' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.related_action_type).toBe('this_action_type_does_not_exist_anywhere');
    expect((issues[0]!.metadata as any)?.stage).toBe('proposal');
    expect((issues[0]!.metadata as any)?.issues?.[0]?.code).toBe('unknown_action_type');
  });

  // product_suggestion (like the shopify_* family) is ecommerce-only, but —
  // unlike shopify_* — it is NOT in executor.ts's EXECUTABLE_ACTION_TYPES
  // and has no required connectors, so approving it never triggers a real
  // (async, fire-and-forget) execution attempt or a connector check. Keeps
  // this test isolated to the one thing it's checking.
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
  test('a registered action_type with no configured connector now BLOCKS approval', () => {
    updateBusinessProfile(BIZ, { business_type: 'other' });
    const task = propose('gbp_post'); // requires a 'gbp' connector — none configured for BIZ
    expect(() => approveTask(task.id, 'tester')).toThrow(/requires connector type/);

    const issues = listSystemIssues({ business_id: BIZ, issue_type: 'action_validation_failure' });
    expect(issues.some((i) => (i.metadata as any)?.issues?.some((iss: any) => iss.code === 'missing_connector'))).toBe(true);
  });

  test('a connected but never-confidence-scored connector still blocks approval', () => {
    updateBusinessProfile(BIZ, { business_type: 'other' });
    const id = generateId();
    db.prepare(`INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at) VALUES (?, ?, 'gbp', 'GBP', '{}', 'connected', '{}', CURRENT_TIMESTAMP)`).run(id, BIZ);
    const task = propose('gbp_post');
    expect(() => approveTask(task.id, 'tester')).toThrow(/confidence/);
  });

  test('a connected, confidence-scored-healthy connector clears both checks', () => {
    updateBusinessProfile(BIZ, { business_type: 'other' });
    addHealthyConnector('gbp');
    const task = propose('gbp_post');
    const after = approveTask(task.id, 'tester');
    expect(after!.status).toBe('approved');
  });

  test('a BAP agent missing a required permission is blocked', () => {
    upsertActionRegistryEntry('test_perm_action', { required_permissions: ['tasks:approve'], side_effect_classification: 'internal_idempotent' });
    const agentId = generateId();
    db.prepare(`
      INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, permissions, business_access)
      VALUES (?, 'No-Perm Agent', 'x', 'bap_noperm', '[]', '["*"]')
    `).run(agentId);
    const task = propose('test_perm_action');
    expect(() => approveTask(task.id, `bap:${agentId}`)).toThrow(/requires permission/);
  });

  test('a BAP agent holding the required permission is not blocked by the permission check', () => {
    upsertActionRegistryEntry('test_perm_action_2', { required_permissions: ['tasks:approve'], side_effect_classification: 'internal_idempotent' });
    const agentId = generateId();
    db.prepare(`
      INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, permissions, business_access)
      VALUES (?, 'Has-Perm Agent', 'x', 'bap_hasperm', '["tasks:approve"]', '["*"]')
    `).run(agentId);
    const task = propose('test_perm_action_2');
    const after = approveTask(task.id, `bap:${agentId}`);
    expect(after!.status).toBe('approved');
  });

  test('a dashboard/telegram approver is never subject to the permission check', () => {
    upsertActionRegistryEntry('test_perm_action_3', { required_permissions: ['some:permission-nobody-has'], side_effect_classification: 'internal_idempotent' });
    const task = propose('test_perm_action_3');
    const after = approveTask(task.id, 'dashboard:admin');
    expect(after!.status).toBe('approved');
  });

  test('an action_type whose last 3 executions all dead-lettered is blocked as an unhealthy executor', () => {
    // A dedicated, never-reused action_type — execution_jobs health is
    // checked system-wide by action_type (not scoped to this test's
    // business), so a shared name like 'investigation' would be
    // order-dependent on whatever else the full suite does with it.
    upsertActionRegistryEntry('test_unhealthy_executor_action', { dispatched_by_executor: true, side_effect_classification: 'internal_idempotent' });
    for (let i = 0; i < 3; i++) {
      const taskId = generateId();
      db.prepare(`INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, version, created_at, updated_at)
                  VALUES (?, ?, 'dead task', 'test', 'failed', 'yellow', 'requires_approval', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(taskId, BIZ);
      db.prepare(`INSERT INTO execution_jobs (id, task_id, business_id, action_type, status, created_at, updated_at)
                  VALUES (?, ?, ?, 'test_unhealthy_executor_action', 'dead_letter', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(generateId(), taskId, BIZ);
    }
    const task = propose('test_unhealthy_executor_action');
    expect(() => approveTask(task.id, 'tester')).toThrow(/unhealthy/i);
  });

  test('risk_policy.max_risk_level blocks a higher-risk action_type', () => {
    updateBusinessProfile(BIZ, { business_type: 'other', risk_policy: { max_risk_level: 'low' } });
    const task = propose('shopify_theme_edit'); // seeded as risk_level 'high'
    expect(() => approveTask(task.id, 'tester')).toThrow(/risk_policy|risk level/i);
  });

  test('risk_policy.max_risk_level allows an action_type at or below the ceiling', () => {
    updateBusinessProfile(BIZ, { business_type: 'other', risk_policy: { max_risk_level: 'high' } });
    const task = propose('test_unhealthy_executor_action'); // risk_level defaults to 'medium'
    const after = approveTask(task.id, 'tester');
    expect(after!.status).toBe('approved');
  });

  test('automation_policy.max_autonomous_tasks_per_day blocks further non-dashboard approvals once the cap is hit', () => {
    updateBusinessProfile(BIZ, { business_type: 'other', risk_policy: {}, automation_policy: { max_autonomous_tasks_per_day: 1 } });
    const first = propose(null);
    approveTask(first.id, 'bap:some-agent');

    const second = propose(null);
    expect(() => approveTask(second.id, 'bap:some-agent')).toThrow(/automation_policy|daily/i);
  });

  test('automation_policy daily cap does not block a human dashboard approval', () => {
    updateBusinessProfile(BIZ, { business_type: 'other', automation_policy: { max_autonomous_tasks_per_day: 1 } });
    const first = propose(null);
    approveTask(first.id, 'bap:some-agent');

    const second = propose(null);
    const after = approveTask(second.id, 'dashboard:human');
    expect(after!.status).toBe('approved');
  });
});

// Issue #37: recurring/non-destructive operational automation (nightly
// jobs, cron-backed workflows, folder watchers, monitoring, scheduled
// connector checks) proposed by an external agent (e.g. Hermes) that owns
// and runs its own cron — Blueprint only tracks/logs the task.
describe('scheduled_workflow — Issue #37 (external recurring automation)', () => {
  test('scheduled_workflow is registered in the Typed Action Registry', () => {
    const task = createTask({
      business_id: BIZ,
      title: 'Nightly social folder automation',
      proposed_by: 'bap:hermes-agent',
      action_type: 'scheduled_workflow',
      action_payload: {
        schedule: '30 2 * * *',
        cron_job_id: '4bba7540a4ce',
        target_system: 'Hermes cron',
        target_resource: '/mnt/nas/Businesses/The Quirky Gift Co/Social',
        side_effects: ['create files'],
        publication: 'none',
        verification: ['file count', 'manifest', 'readability/decode check'],
        constraints: ['no prices', 'no fake reviews', 'no fake buyer photos'],
      },
      approval_mode: 'requires_approval',
    })!;
    expect(task.status).toBe('proposed');
    expect(task.action_type).toBe('scheduled_workflow');
  });

  test('a scheduled_workflow payload missing the required schedule is rejected at proposal', () => {
    expect(() => createTask({
      business_id: BIZ,
      title: 'Automation with no schedule',
      proposed_by: 'bap:hermes-agent',
      action_type: 'scheduled_workflow',
      action_payload: { target_system: 'Hermes cron' },
      approval_mode: 'requires_approval',
    })).toThrow(/cannot be proposed/);

    const issues = listSystemIssues({ business_id: BIZ, issue_type: 'action_validation_failure' });
    expect(issues.some((i) => (i.metadata as any)?.issues?.[0]?.code === 'payload_schema_mismatch')).toBe(true);
  });

  test('a scheduled_workflow payload missing the required target_system is rejected at proposal', () => {
    expect(() => createTask({
      business_id: BIZ,
      title: 'Automation with no target system',
      proposed_by: 'bap:hermes-agent',
      action_type: 'scheduled_workflow',
      action_payload: { schedule: '30 2 * * *' },
      approval_mode: 'requires_approval',
    })).toThrow(/cannot be proposed/);
  });

  test('scheduled_workflow is deliberately NOT in executor.ts\'s auto-executable set', () => {
    // Blueprint only tracks/logs this action type — the external system
    // (e.g. Hermes cron) owns execution, so it must never be auto-dispatched.
    // (executor.ts's own isExecutable() gate re-confirms this even if
    // something enqueues a job for it — see executeTask()'s guard.)
    expect(isExecutable('scheduled_workflow')).toBe(false);
  });

  test('a valid scheduled_workflow task clears the approval gate (registered, no connectors required)', () => {
    const task = createTask({
      business_id: BIZ,
      title: 'Approve scheduled_workflow',
      proposed_by: 'bap:hermes-agent',
      action_type: 'scheduled_workflow',
      action_payload: { schedule: '0 3 * * *', target_system: 'Hermes cron' },
      approval_mode: 'requires_approval',
    })!;
    const after = approveTask(task.id, 'dashboard:human');
    expect(after!.status).toBe('approved');
  });
});
