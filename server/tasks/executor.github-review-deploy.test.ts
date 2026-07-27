/**
 * Regression coverage for issue #22: Blueprint approved github_review_deploy
 * tasks that the execution worker could not run — executor.ts had no
 * EXECUTABLE_ACTION_TYPES entry / executeTask() case for it. That code path
 * exists now (draft-PR-or-review-issue only, never a blind deploy), but the
 * action_type was never registered in action_registry, so full-enforcement
 * validateAction() (task-queue.ts's approveTask()) still blocked every such
 * task with 'unknown_action_type' before it ever reached the executor. Both
 * halves are exercised here: registry registration + the executor's own
 * decision logic (mirrors executor.external-write-safety.test.ts's approach
 * — the GitHub connector module is mocked; what's under test is executor.ts).
 */
import { describe, test, expect, beforeAll, afterEach, mock } from 'bun:test';
import nodeCrypto from 'crypto';

process.env.ENCRYPTION_KEY ||= nodeCrypto.randomBytes(32).toString('hex');

const createIssue = mock(async (..._args: unknown[]) => ({ number: 501, html_url: 'https://github.com/acme/widgets/issues/501', state: 'open' }));
const createPR = mock(async (..._args: unknown[]) => ({ number: 502, html_url: 'https://github.com/acme/widgets/pull/502', state: 'open', draft: true, head: { ref: 'hermes/fix' }, base: { ref: 'main' } }));
const searchByMarker = mock(async (..._args: unknown[]) => null as { number: number; html_url: string; state: string } | null);

mock.module('../connectors/github/index.js', () => ({
  default: { createIssue, createPR, searchByMarker },
}));

const { default: db, generateId } = await import('../db/db.js');
const { encrypt } = await import('../crypto.js');
const { executeTask, isExecutable } = await import('./executor.js');
const { createTask } = await import('./task-queue.js');
const { enqueueExecutionJob, getExecutionJob } = await import('./execution-jobs.js');
const { getActionRegistryEntry } = await import('./action-registry.js');
const { DANGEROUS_ACTION_TYPES } = await import('./approval.js');
const { classifyAction } = await import('./execution-safety.js');

const BIZ = 'biz_grd_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'GRD Test', 'grd-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  db.prepare(`DELETE FROM connectors WHERE business_id = ? AND type = 'github'`).run(BIZ);
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, config, status, created_at)
    VALUES (?, ?, 'github', 'GitHub', ?, ?, 'connected', CURRENT_TIMESTAMP)
  `).run(generateId(), BIZ, encrypt(JSON.stringify({ owner: 'acme' })), JSON.stringify({ repos: 'acme/widgets' }));
});

afterEach(() => {
  createIssue.mockClear();
  createPR.mockClear();
  searchByMarker.mockClear();
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

function approvedTask(payload: Record<string, unknown>): { taskId: string; jobId: string; version: number } {
  const task = createTask({
    business_id: BIZ, title: 'Review and deploy the LCP fix', proposed_by: 'test',
    action_type: 'github_review_deploy', action_payload: payload,
    approval_mode: 'requires_approval',
  })!;
  const version = (task.version ?? 1) + 1;
  db.prepare(`UPDATE tasks SET status = 'approved', version = ? WHERE id = ?`).run(version, task.id);
  const job = enqueueExecutionJob({ ...task, status: 'approved', version } as any);
  return { taskId: task.id, jobId: job.id, version };
}

describe('github_review_deploy — registration (issue #22)', () => {
  test('is registered in action_registry, not just the executor', () => {
    const entry = getActionRegistryEntry('github_review_deploy');
    expect(entry).not.toBeNull();
    expect(entry!.required_connector_types).toEqual(['github']);
    expect(entry!.dispatched_by_executor).toBe(true);
  });

  test('is recognised as executable', () => {
    expect(isExecutable('github_review_deploy')).toBe(true);
  });

  test('is classified as a dangerous action — never auto-approved', () => {
    expect(DANGEROUS_ACTION_TYPES.has('github_review_deploy')).toBe(true);
  });

  test('is classified external_verifiable (idempotency-marker safe, not blind-retry safe)', () => {
    expect(classifyAction('github_review_deploy')).toBe('external_verifiable');
  });
});

describe('executeGithubReviewDeploy — safe review-only semantics', () => {
  test('a branch (head) present creates a draft PR, never a merge', async () => {
    const { taskId, jobId } = approvedTask({ repository: 'acme/widgets', head: 'hermes/fix', base: 'main' });
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(createPR).toHaveBeenCalledTimes(1);
    expect(createIssue).not.toHaveBeenCalled();
    const prCall = createPR.mock.calls[0]!;
    expect((prCall[3] as any).draft).toBe(true); // Blueprint never merges — draft is unconditional
    expect(result.outcome_data?.pr_number).toBe(502);
  });

  test('local_branch with no pushed head creates a review issue, not a doomed PR from an unpushed branch', async () => {
    const { taskId, jobId } = approvedTask({ repository: 'acme/widgets', local_branch: 'hermes/lcp-fix', base_branch: 'master' });
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createPR).not.toHaveBeenCalled();
    expect(result.outcome_data?.issue_number).toBe(501);
  });

  test('a retry where the job already has a recorded PR reference never calls the provider again', async () => {
    const { taskId, jobId } = approvedTask({ repository: 'acme/widgets', head: 'hermes/fix' });
    db.prepare(`UPDATE execution_jobs SET external_reference = ? WHERE id = ?`)
      .run(JSON.stringify({ pr_number: 42, pr_url: 'https://github.com/acme/widgets/pull/42', repo: 'acme/widgets' }), jobId);

    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(createPR).not.toHaveBeenCalled();
    expect(searchByMarker).not.toHaveBeenCalled();
    expect(result.outcome_data?.pr_number).toBe(42);
  });

  test('a retry with no local reference, but the provider already has a PR bearing the marker, adopts it instead of creating a duplicate', async () => {
    const { taskId, jobId } = approvedTask({ repository: 'acme/widgets', head: 'hermes/fix' });
    searchByMarker.mockImplementationOnce(async (..._args: unknown[]) =>
      ({ number: 88, html_url: 'https://github.com/acme/widgets/pull/88', state: 'open' })
    );

    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(createPR).not.toHaveBeenCalled();
    expect(result.outcome_data?.pr_number).toBe(88);
  });

  test('a missing github connector fails with a clear, actionable error rather than a cryptic one', async () => {
    db.prepare(`DELETE FROM connectors WHERE business_id = ? AND type = 'github'`).run(BIZ);
    const { taskId, jobId } = approvedTask({ head: 'hermes/fix' });

    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/github connector/i);

    // restore for any subsequent test in this file
    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, credentials, config, status, created_at)
      VALUES (?, ?, 'github', 'GitHub', ?, ?, 'connected', CURRENT_TIMESTAMP)
    `).run(generateId(), BIZ, encrypt(JSON.stringify({ owner: 'acme' })), JSON.stringify({ repos: 'acme/widgets' }));
  });
});
