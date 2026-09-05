import { describe, test, expect, beforeAll, afterEach, mock } from 'bun:test';

mock.module('../jobs/scheduler.js', () => ({ runExecutionWorkerTickNow: () => {} }));
mock.module('../agents/self-healer.js', () => ({ healAgentError: mock(async () => undefined) }));
mock.module('../bap/webhook-dispatcher.js', () => ({ dispatchWebhookEvent: mock(() => undefined) }));
const deliveredBriefs: Array<Record<string, unknown>> = [];
mock.module('../agents/agent-inbox.js', () => ({
  deliverAgentBrief: async (input: Record<string, unknown>) => {
    deliveredBriefs.push(input);
    return { delivered: true, triggered: false };
  },
}));
mock.module('../agents/agentActivationService.js', () => ({
  runWithActivation: mock(async () => ({ runId: null, tasksProposed: 0, signalsDetected: 0, skipped: true })),
}));

const { default: db } = await import('../db/db.js');
const { createTask, getTask, updateTaskStatus } = await import('./task-queue.js');
const { getActiveJobForTask } = await import('./execution-jobs.js');
const { upsertActionRegistryEntry } = await import('./action-registry.js');
const { progressRoutineProposedTasks, recoverAutonomousProgressionHolds } = await import('./autonomous-progression.js');
const { listPendingDecisions } = await import('../decisions/decision-queue.js');

const BIZ = 'biz_autonomous_progression_test';
const ACTION = 'test_autonomous_progression_action';
const EXTERNAL_ACTION = 'test_autonomous_external_action';
const PERMISSIONED_ACTION = 'test_autonomous_permissioned_action';
const AGENT_ID = 'autonomy-content-agent';
const originalFetch = globalThis.fetch;

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Autonomous Progression Test', 'autonomous-progression-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  upsertActionRegistryEntry(ACTION, {
    description: 'Safe internal maintenance action',
    side_effect_classification: 'internal_idempotent',
    risk_level: 'low',
    requires_approval: true,
    dispatched_by_executor: true,
  });
  upsertActionRegistryEntry(EXTERNAL_ACTION, {
    description: 'External create action',
    side_effect_classification: 'external_verifiable',
    risk_level: 'low',
    requires_approval: true,
    dispatched_by_executor: true,
  });
  upsertActionRegistryEntry(PERMISSIONED_ACTION, {
    description: 'Permissioned internal action',
    side_effect_classification: 'internal_idempotent',
    risk_level: 'low',
    required_permissions: ['tasks:approve'],
    dispatched_by_executor: true,
  });
});

afterEach(() => {
  deliveredBriefs.length = 0;
  db.prepare(`DELETE FROM agent_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM agent_run_events WHERE run_id NOT IN (SELECT id FROM agent_runs)`).run();
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM action_receipts WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM cost_daily WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM decisions WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM audit_log WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(AGENT_ID);
  db.prepare("DELETE FROM settings WHERE key IN ('llm_default_provider','llm_default_model','provider_credentials_google','cost_monthly_budget_usd')").run();
  globalThis.fetch = originalFetch;
});

function propose(actionType: string | null, patch: Record<string, unknown> = {}) {
  return createTask({
    business_id: BIZ,
    title: 'Routine maintenance task',
    description: 'Apply a bounded internal maintenance update.',
    proposed_by: 'test',
    action_type: actionType,
    action_payload: {},
    trust_tier: 'yellow',
    approval_mode: 'requires_approval',
    ...patch,
  })!;
}

describe('progressRoutineProposedTasks', () => {
  test('reproduces the live gap: routine human_required proposals now progress through approval and job creation', async () => {
    const task = propose(ACTION);
    const decision = listPendingDecisions(BIZ).decisions.find((item) => item.task_id === task.id)!;
    expect(decision.lane).toBe('routine');
    expect(decision.policy_recommendation).toBe('human_required');

    const result = await progressRoutineProposedTasks(BIZ, { limit: 5 });

    expect(result.approved).toBe(1);
    expect(result.assigned).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(getTask(task.id)!.status).toBe('approved');
    const approved = db.prepare(`SELECT approved_by FROM tasks WHERE id = ?`).get(task.id) as { approved_by: string };
    expect(approved.approved_by).toBe('system:autonomous-progression');
    expect(getActiveJobForTask(task.id)?.status).toBe('queued');
  });

  test('approves an applicability-unknown orange investigation and enqueues execution', async () => {
    const task = propose('investigation', {
      title: 'Investigate unexplained conversion variance',
      description: 'Read-only investigation of an internal metric; do not change external systems.',
    });
    db.prepare("UPDATE tasks SET applicability_status = 'unknown', trust_tier = 'orange' WHERE id = ?").run(task.id);

    const result = await progressRoutineProposedTasks(BIZ, { limit: 5 });

    expect(result.approved).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(getTask(task.id)!.status).toBe('approved');
    expect(getActiveJobForTask(task.id)?.status).toBe('queued');
  });

  test('explicitly rejects unsafe proposals with persisted reason and audit evidence', async () => {
    const task = propose(EXTERNAL_ACTION, { title: 'Create external customer record' });

    const result = await progressRoutineProposedTasks(BIZ, { limit: 5 });
    const row = getTask(task.id)!;
    const auditRow = db.prepare("SELECT action, metadata FROM audit_log WHERE entity_type = 'task' AND entity_id = ? ORDER BY rowid DESC LIMIT 1").get(task.id) as { action: string; metadata: string };

    expect(result.errors).toHaveLength(0);
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toContain('not internal/idempotent');
    expect(auditRow.action).toBe('reject');
    expect(auditRow.metadata).toContain('not internal/idempotent');
  });

  test('recovers only prior autonomous holds and leaves genuine outcome reviews untouched', async () => {
    const stranded = propose(ACTION, { title: 'Previously held investigation' });
    const genuine = propose(ACTION, { title: 'Execution outcome needs confirmation' });
    db.prepare('UPDATE tasks SET rejection_reason = ? WHERE id = ?').run("Held for human/policy review: risk tier 'orange' requires a human", stranded.id);
    updateTaskStatus(stranded.id, 'manual_review', 'system:old-sweep', { reason: 'legacy hold' });
    updateTaskStatus(genuine.id, 'manual_review', 'system:worker', { reason: 'external outcome is unknown' });

    expect(recoverAutonomousProgressionHolds(BIZ)).toBe(1);
    expect(getTask(stranded.id)!.status).toBe('proposed');
    expect(getTask(genuine.id)!.status).toBe('manual_review');
  });

  test('reaches recovery from the progression sweep before classifying proposals', async () => {
    const stranded = propose(ACTION, { title: 'Previously stranded routine task' });
    db.prepare('UPDATE tasks SET rejection_reason = ? WHERE id = ?').run('Held for human/policy review: prior default-limit hold', stranded.id);
    updateTaskStatus(stranded.id, 'manual_review', 'system:old-sweep', { reason: 'legacy hold' });

    const result = await progressRoutineProposedTasks(BIZ, { limit: 5 });

    expect(result.approved).toBe(1);
    expect(getTask(stranded.id)!.status).toBe('approved');
    expect(getActiveJobForTask(stranded.id)?.status).toBe('queued');
  });

  test('assigns routine agent-owned actions instead of routing them to manual_review', async () => {
    db.prepare(`
      INSERT INTO agents (id, profile_path, name, status, lifecycle_state, kb_scope, data_sources_allowed, task_types_allowed)
      VALUES (?, 'test/autonomy-content-agent.md', 'Autonomy Content Agent', 'active', 'standby', ?, '[]', ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        lifecycle_state = excluded.lifecycle_state,
        kb_scope = excluded.kb_scope,
        data_sources_allowed = excluded.data_sources_allowed,
        task_types_allowed = excluded.task_types_allowed
    `).run(AGENT_ID, JSON.stringify(['content', 'writing']), JSON.stringify(['content_brief']));

    const task = propose('content_brief', {
      title: 'Prepare product page content brief',
      description: 'Create a content brief for a routine product page update.',
      action_payload: { target_keyword: 'personalised gifts', intent: 'commercial' },
    });

    const result = await progressRoutineProposedTasks(BIZ, { limit: 5 });

    expect(result.approved).toBe(1);
    expect(result.assigned).toBe(1);
    expect(result.errors).toHaveLength(0);
    const row = getTask(task.id)!;
    expect(row.status).toBe('approved');
    expect(row.assigned_to).toBe(AGENT_ID);
    expect(getActiveJobForTask(task.id)).toBeNull();
    expect(deliveredBriefs).toHaveLength(1);
    expect(deliveredBriefs[0]!.to).toBe(AGENT_ID);
    expect(String(deliveredBriefs[0]!.brief)).toContain(`Task ID: ${task.id}`);
  });

  test('does not approve manual, non-agent-owned, external-verifiable, permissioned, or red-tier work', async () => {
    const manual = propose(null, { title: 'Manual operator checklist' });
    const nonExecutable = propose('deployment_hardening', { title: 'Prepare deployment hardening' });
    const external = propose(EXTERNAL_ACTION, { title: 'Create external record' });
    const permissioned = propose(PERMISSIONED_ACTION, { title: 'Permissioned internal update' });
    const red = propose(ACTION, {
      title: 'High exposure action',
      action_payload: { financial_exposure_gbp: 100000 },
    });

    const result = await progressRoutineProposedTasks(BIZ, { limit: 10 });

    expect(result.approved).toBe(0);
    expect(result.assigned).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(getTask(manual.id)!.status).toBe('rejected');
    expect(getTask(nonExecutable.id)!.status).toBe('rejected');
    expect(getTask(external.id)!.status).toBe('rejected');
    expect(getTask(permissioned.id)!.status).toBe('rejected');
    expect(getTask(red.id)!.status).toBe('rejected');
    expect(getActiveJobForTask(manual.id)).toBeNull();
    expect(getActiveJobForTask(nonExecutable.id)).toBeNull();
    expect(getActiveJobForTask(external.id)).toBeNull();
    expect(getActiveJobForTask(permissioned.id)).toBeNull();
    expect(getActiveJobForTask(red.id)).toBeNull();
  });

  test('keeps human-only categories gated even when they otherwise look routine and executable', async () => {
    const hire = propose('hire_agent', {
      title: 'Hire an agent',
      action_payload: { template_id: 'merchant' },
    });

    const result = await progressRoutineProposedTasks(BIZ);

    expect(result.approved).toBe(0);
    expect(result.skipped.some((item) => item.task_id === hire.id && item.reason.includes('human-only'))).toBe(true);
    expect(getTask(hire.id)!.status).toBe('rejected');
  });

  test('enforces the default sweep limit without approving held overflow tasks', async () => {
    for (let i = 0; i < 11; i += 1) {
      propose(ACTION, { title: `Default limit task ${String(i).padStart(2, '0')}` });
    }

    const result = await progressRoutineProposedTasks(BIZ);
    const counts = db.prepare(`
      SELECT status, COUNT(*) AS n
      FROM tasks
      WHERE business_id = ?
      GROUP BY status
    `).all(BIZ) as Array<{ status: string; n: number }>;
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.n]));

    expect(result.approved).toBe(10);
    expect(result.skipped.some((entry) => entry.reason.includes('autonomous approval limit (10) reached'))).toBe(true);
    expect(byStatus.approved).toBe(10);
    expect(byStatus.proposed).toBe(1);
  });

  test('leaves no proposed task unclassified: unsafe work is held and unsupported work is rejected', async () => {
    const safe = propose(ACTION);
    const outreach = propose(ACTION, { title: 'Send customer outreach email' });
    const unsupported = propose('deployment_hardening', { title: 'Unsupported deployment hardening' });

    const result = await progressRoutineProposedTasks(BIZ, { limit: 10 });

    expect(result.errors).toHaveLength(0);
    expect(getTask(safe.id)!.status).toBe('approved');
    expect(getTask(outreach.id)!.status).toBe('rejected');
    expect(getTask(unsupported.id)!.status).toBe('rejected');
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE business_id = ? AND status = 'proposed'").get(BIZ) as { n: number };
    expect(remaining.n).toBe(0);
    expect(result.skipped.some((entry) => entry.task_id === outreach.id && entry.reason.includes('Rejected'))).toBe(true);
  });

  test('runConductor reaches the canonical autonomous progression sweep once per conductor cycle', async () => {
    const task = propose(ACTION);
    db.prepare(`
      INSERT INTO agents (id, profile_path, name, status)
      VALUES (?, 'server/agents/profiles/autonomy-content-agent.yaml', 'Autonomy Content Agent', 'active')
      ON CONFLICT(id) DO UPDATE SET
        profile_path = excluded.profile_path,
        name = excluded.name,
        status = excluded.status
    `).run(AGENT_ID);

    const { runConductor } = await import('../agents/conductor.js');
    const result = await runConductor(BIZ);

    expect(result.errors).toHaveLength(0);
    expect(getTask(task.id)!.status).toBe('approved');
    const approved = db.prepare(`SELECT approved_by FROM tasks WHERE id = ?`).get(task.id) as { approved_by: string };
    expect(approved.approved_by).toBe('system:autonomous-progression');
    const sweeps = db.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE business_id = ? AND action = 'routine_progression_sweep'
    `).get(BIZ) as { count: number };
    expect(sweeps.count).toBe(1);
  });
});
