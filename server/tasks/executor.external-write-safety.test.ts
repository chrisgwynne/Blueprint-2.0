/**
 * executor.ts's external-write pre-flight safety (execution-safety.ts +
 * executeGithubIssue) — the mechanism behind Phase 1 exit criterion
 * "a provider request times out after the provider actually accepted it;
 * retrying the task does not create a duplicate object". The real GitHub
 * API isn't reachable from this environment, so the connector module
 * itself is mocked — what's under test is executor.ts's own decision
 * logic (check the job's own record, then ask the provider, only then
 * create), not the GitHub connector's HTTP behaviour.
 */
import { describe, test, expect, beforeAll, afterEach, mock } from 'bun:test';
import nodeCrypto from 'crypto';

// crypto.ts's encrypt()/decrypt() (used below to seed a fake connector's
// credentials) require ENCRYPTION_KEY at call time; CI/dev only set it via
// a real (gitignored) .env, which doesn't exist in a test run. A random
// key generated fresh per test run is fine — this never encrypts anything
// beyond this file's own throwaway fixture data.
process.env.ENCRYPTION_KEY ||= nodeCrypto.randomBytes(32).toString('hex');

const createIssue = mock(async () => ({ number: 999, html_url: 'https://github.com/acme/widgets/issues/999', state: 'open' }));
const searchByMarker = mock(async (..._args: unknown[]) => null as { number: number; html_url: string; state: string } | null);

mock.module('../connectors/github/index.js', () => ({
  default: { createIssue, searchByMarker },
}));

const { default: db, generateId } = await import('../db/db.js');
const { encrypt } = await import('../crypto.js');
const { executeTask } = await import('./executor.js');
const { createTask } = await import('./task-queue.js');
const { enqueueExecutionJob, getExecutionJob } = await import('./execution-jobs.js');
const { buildIdempotencyMarker } = await import('./execution-safety.js');

const BIZ = 'biz_ews_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'EWS Test', 'ews-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  db.prepare(`DELETE FROM signal_lifecycle_events WHERE signal_id IN (SELECT id FROM signals WHERE business_id = ? AND connector_id IN (SELECT id FROM connectors WHERE business_id = ? AND type = 'github'))`).run(BIZ, BIZ);
  db.prepare(`DELETE FROM signals WHERE business_id = ? AND connector_id IN (SELECT id FROM connectors WHERE business_id = ? AND type = 'github')`).run(BIZ, BIZ);
  db.prepare(`DELETE FROM metrics WHERE business_id = ? AND connector_id IN (SELECT id FROM connectors WHERE business_id = ? AND type = 'github')`).run(BIZ, BIZ);
  db.prepare(`DELETE FROM connector_syncs WHERE connector_id IN (SELECT id FROM connectors WHERE business_id = ? AND type = 'github')`).run(BIZ);
  db.prepare(`DELETE FROM connector_confidence WHERE business_id = ? AND connector_id IN (SELECT id FROM connectors WHERE business_id = ? AND type = 'github')`).run(BIZ, BIZ);
  db.prepare(`UPDATE business_capabilities SET connector_id = NULL WHERE business_id = ? AND connector_id IN (SELECT id FROM connectors WHERE business_id = ? AND type = 'github')`).run(BIZ, BIZ);
  db.prepare(`DELETE FROM connectors WHERE business_id = ? AND type = 'github'`).run(BIZ);
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, config, status, created_at)
    VALUES (?, ?, 'github', 'GitHub', ?, ?, 'connected', CURRENT_TIMESTAMP)
  `).run(generateId(), BIZ, encrypt(JSON.stringify({ owner: 'acme' })), JSON.stringify({ repos: 'acme/widgets' }));
});

afterEach(() => {
  createIssue.mockClear();
  searchByMarker.mockClear();
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM outcome_measurement_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

function approvedGithubIssueTask(): { taskId: string; jobId: string; version: number } {
  const task = createTask({
    business_id: BIZ, title: 'File a GitHub issue', proposed_by: 'test',
    action_type: 'github_issue', action_payload: { repo: 'widgets' },
    approval_mode: 'requires_approval',
  })!;
  const version = (task.version ?? 1) + 1;
  db.prepare(`UPDATE tasks SET status = 'approved', version = ? WHERE id = ?`).run(version, task.id);
  const job = enqueueExecutionJob({ ...task, status: 'approved', version } as any);
  return { taskId: task.id, jobId: job.id, version };
}

describe('executeGithubIssue — external-write pre-flight safety', () => {
  test('a fresh job with no prior reference creates the issue exactly once', async () => {
    const { taskId, jobId } = approvedGithubIssueTask();
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(searchByMarker).toHaveBeenCalledTimes(1); // checked the provider first
    expect(result.outcome_data?.issue_number).toBe(999);

    // executeTask() itself persists the reference before completing.
    expect(getExecutionJob(jobId)?.external_reference?.issue_number).toBe(999);
  });

  test('a retry where the job already has a recorded reference never calls the provider again', async () => {
    const { taskId, jobId } = approvedGithubIssueTask();
    db.prepare(`UPDATE execution_jobs SET external_reference = ? WHERE id = ?`)
      .run(JSON.stringify({ issue_number: 42, issue_url: 'https://github.com/acme/widgets/issues/42', repo: 'acme/widgets' }), jobId);
    // executeTask() itself requires status='approved' — the recovery path
    // (execution-worker.ts) is what would normally re-run it after moving
    // the task back to 'approved'; this test exercises executor.ts's own
    // decision logic directly, independent of that recovery flow.

    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(createIssue).not.toHaveBeenCalled();
    expect(searchByMarker).not.toHaveBeenCalled(); // job's own record was enough — no need to even ask
    expect(result.outcome_data?.issue_number).toBe(42);
  });

  test('a retry with no local reference, but the provider already has an object bearing the marker, adopts it instead of creating a duplicate', async () => {
    const { taskId, jobId, version } = approvedGithubIssueTask();
    const marker = buildIdempotencyMarker(taskId, version);
    searchByMarker.mockImplementationOnce(async (..._args: unknown[]) => {
      expect(_args[3]).toBe(marker); // the exact marker this task/version pair produces
      return { number: 77, html_url: 'https://github.com/acme/widgets/issues/77', state: 'open' };
    });

    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(createIssue).not.toHaveBeenCalled(); // never re-created — this IS the "timeout after provider accepted" case
    expect(result.outcome_data?.issue_number).toBe(77);
  });
});
