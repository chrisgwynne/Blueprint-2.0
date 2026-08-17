/**
 * Verified action receipts (issue #70) — end-to-end through the real
 * approval/execution path, not against the receipt module in isolation.
 *
 * What's mocked is only the outside world (GitHub/Shopify connectors and
 * the scheduler wake-up); every receipt under test is written by
 * task-queue.ts's approveTask(), executor.ts's executeTask() and
 * execution-worker.ts's recovery/failure handling exactly as they run in
 * production.
 */
import { describe, test, expect, beforeAll, afterEach, mock } from 'bun:test';
import nodeCrypto from 'crypto';

process.env.ENCRYPTION_KEY ||= nodeCrypto.randomBytes(32).toString('hex');

const createIssue = mock(async () => ({
  number: 999, html_url: 'https://github.com/acme/widgets/issues/999', state: 'open',
}));
const searchByMarker = mock(async (..._args: unknown[]) => null as { number: number; html_url: string; state: string } | null);
mock.module('../connectors/github/index.js', () => ({ default: { createIssue, searchByMarker } }));

const fetchProduct = mock(async () => ({ id: '5001', title: 'Door topper', body_html: '<p>old</p>' }));
const updateProduct = mock(async () => ({ product: { id: '5001' } }));
const findProductByHandle = mock(async () => ({ id: 5001 }));
mock.module('../connectors/shopify/index.js', () => ({
  default: { fetchProduct, updateProduct, findProductByHandle },
}));

// approveTask() wakes the execution worker immediately for latency. Every
// test here drives execution explicitly, so the wake-up is stubbed out to
// keep ordering deterministic rather than racing a background tick.
mock.module('../jobs/scheduler.js', () => ({ runExecutionWorkerTickNow: () => {} }));

const { default: db, generateId } = await import('../db/db.js');
const { encrypt } = await import('../crypto.js');
const { createTask, approveTask, rejectTask, cancelTask } = await import('./task-queue.js');
const { executeTask } = await import('./executor.js');
const { getActiveJobForTask, getExecutionJob } = await import('./execution-jobs.js');
const { recoverStuckJobs, runExecutionWorkerTick } = await import('./execution-worker.js');
const { checkTaskOutcome } = await import('./outcomes.js');
const { updateBusinessProfile } = await import('../business/business-profile.js');
const { buildIdempotencyMarker } = await import('./execution-safety.js');
const {
  getReceiptForTaskVersion, getLatestReceiptForTask, listReceiptsForTask,
  listReceipts, toReceiptView, recordExternalAcknowledgement, RECEIPT_SCHEMA_VERSION,
} = await import('./action-receipts.js');

const BIZ = 'biz_receipts_test';
const OTHER_BIZ = 'biz_receipts_other';
let githubConnectorId = '';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Receipts Test', 'receipts-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Receipts Other', 'receipts-other') ON CONFLICT(id) DO NOTHING`).run(OTHER_BIZ);
  updateBusinessProfile(BIZ, { business_type: 'ecommerce' });

  githubConnectorId = addConnector('github', { owner: 'acme' }, { repos: 'acme/widgets' });
  addConnector('shopify', { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_supersecretshopifytoken' }, {});
});

function addConnector(type: string, credentials: Record<string, string>, config: Record<string, unknown>): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, credentials, config, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'connected', CURRENT_TIMESTAMP)
  `).run(id, BIZ, type, `${type} connector`, encrypt(JSON.stringify(credentials)), JSON.stringify(config));
  db.prepare(`
    INSERT INTO connector_confidence (id, connector_id, business_id, overall_confidence, overall_status, created_at, updated_at)
    VALUES (?, ?, ?, 0.95, 'healthy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(generateId(), id, BIZ);
  return id;
}

afterEach(() => {
  createIssue.mockClear();
  searchByMarker.mockClear();
  fetchProduct.mockClear();
  updateProduct.mockClear();
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM outcome_measurement_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM metrics WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
  // action_receipts cascade off tasks (see db.ts) — deleting the task is
  // enough, and proves the cascade works while we're at it.
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

function proposeGithubIssue(overrides: Record<string, unknown> = {}) {
  return createTask({
    business_id: BIZ, title: 'File a GitHub issue', proposed_by: 'agent:seo-sentinel',
    action_type: 'github_issue', action_payload: { repo: 'widgets' },
    approval_mode: 'requires_approval', ...overrides,
  })!;
}

function proposeShopifyUpdate() {
  return createTask({
    business_id: BIZ, title: 'Rewrite a product description', proposed_by: 'agent:merchandiser',
    action_type: 'shopify_product_update',
    action_payload: { product_id: '5001', proposed_description: '<p>new</p>' },
    approval_mode: 'requires_approval',
  })!;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('action receipts — state progression', () => {
  test('a successful external-write action produces one receipt separating requested, authorized, executed and externally acknowledged', async () => {
    const task = proposeGithubIssue();
    const approved = approveTask(task.id, 'dashboard:owner')!;

    // Authorized, recorded in the same transaction as the approval itself.
    const authorized = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(authorized).toBeTruthy();
    expect(authorized.state).toBe('authorized');
    expect(authorized.result_status).toBe('pending');
    expect(authorized.authorized_by).toBe('dashboard:owner');
    expect(authorized.requested_at).toBeTruthy();
    expect(authorized.requested_by).toBe('agent:seo-sentinel');
    expect(authorized.executed_at).toBeNull();
    expect(authorized.externally_acknowledged_at).toBeNull();
    expect(authorized.verified_at).toBeNull();
    expect(authorized.receipt_version).toBe(RECEIPT_SCHEMA_VERSION);
    // Correlation identity is the existing external idempotency marker —
    // not a parallel scheme invented for receipts.
    expect(authorized.correlation_key).toBe(buildIdempotencyMarker(task.id, approved.version));
    expect(authorized.execution_job_id).toBe(getActiveJobForTask(task.id)!.id);

    const job = getActiveJobForTask(task.id)!;
    const result = await executeTask(task.id, job);
    expect(result.ok).toBe(true);

    const executed = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(executed.id).toBe(authorized.id); // same receipt, advanced — never a second row
    expect(executed.state).toBe('externally_acknowledged');
    expect(executed.result_status).toBe('success');
    expect(executed.executed_at).toBeTruthy();
    expect(executed.externally_acknowledged_at).toBeTruthy();
    expect(executed.external_system).toBe('github');
    expect(executed.external_id).toBe('999');
    expect(executed.external_permalink).toBe('https://github.com/acme/widgets/issues/999');
    // An acknowledgement is NOT verification.
    expect(executed.verified_at).toBeNull();
    expect(toReceiptView(executed).states.verified.reached).toBe(false);
    expect(toReceiptView(executed).states.externally_acknowledged.reached).toBe(true);

    expect(listReceiptsForTask(task.id).length).toBe(1);
  });

  test('verification is a separate, later state carrying structured evidence linked to the measurement rows', async () => {
    const task = proposeGithubIssue();
    const approved = approveTask(task.id, 'dashboard:owner')!;
    await executeTask(task.id, getActiveJobForTask(task.id));

    // A real outcome check weeks later — the only thing that sets 'verified'.
    db.prepare('UPDATE tasks SET target_metric = ?, target_metric_baseline = ? WHERE id = ?')
      .run('gsc.total_clicks', 100, task.id);
    db.prepare(`INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, recorded_at) VALUES (?, ?, ?, 'gsc.total_clicks', 140, CURRENT_TIMESTAMP)`)
      .run(generateId(), BIZ, githubConnectorId);

    const outcome = checkTaskOutcome(task.id, 2);
    expect(outcome?.verdict).toBe('improved');

    const verified = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(verified.state).toBe('verified');
    expect(verified.verified_at).toBeTruthy();
    // Still the same single receipt, and the earlier states are intact.
    expect(listReceiptsForTask(task.id).length).toBe(1);
    expect(verified.externally_acknowledged_at).toBeTruthy();

    const evidence = verified.verification_evidence!;
    expect(evidence.method).toBe('metric_delta');
    expect(evidence.source).toBe('task_outcomes');
    expect(evidence.metric).toBe('gsc.total_clicks');
    expect(evidence.baseline_value).toBe(100);
    expect(evidence.observed_value).toBe(140);
    expect(evidence.verdict).toBe('improved');
    expect(Array.isArray(evidence.checks)).toBe(true);
    expect(evidence.checks!.length).toBeGreaterThan(0);
    expect(evidence.task_outcome_ids!.length).toBe(1);
  });

  test('a manual task with no action type still gets a receipt for the authorization', () => {
    const task = createTask({ business_id: BIZ, title: 'Ring the supplier', proposed_by: 'human' })!;
    const approved = approveTask(task.id, 'dashboard:owner')!;
    const receipt = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(receipt.state).toBe('authorized');
    expect(receipt.authorized_by).toBe('dashboard:owner');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('action receipts — explicit pre-execution rejection records', () => {
  test('a validation-gate rejection produces a rejection record, not an absent receipt', () => {
    // gbp_update requires a 'gbp' connector; none is configured for BIZ.
    const task = createTask({
      business_id: BIZ, title: 'Update the Google listing', proposed_by: 'agent:local',
      action_type: 'gbp_update', action_payload: {},
    })!;

    expect(() => approveTask(task.id, 'dashboard:owner')).toThrow(/requires connector type|cannot be approved/);

    const receipt = getReceiptForTaskVersion(task.id, task.version ?? 1)!;
    expect(receipt).toBeTruthy();
    expect(receipt.state).toBe('rejected_pre_execution');
    expect(receipt.result_status).toBe('rejected');
    expect(receipt.rejection_stage).toBe('action_validation');
    expect(receipt.rejected_by).toBe('dashboard:owner');
    expect(receipt.rejection_reason).toMatch(/connector/i);
    // Nothing ran, and the receipt says so unambiguously.
    expect(receipt.execution_started_at).toBeNull();
    expect(receipt.executed_at).toBeNull();
    expect(receipt.externally_acknowledged_at).toBeNull();
  });

  test('repeated rejected approval attempts update one record rather than piling up conflicting ones', () => {
    const task = createTask({
      business_id: BIZ, title: 'Update the Google listing', proposed_by: 'agent:local',
      action_type: 'gbp_update', action_payload: {},
    })!;
    expect(() => approveTask(task.id, 'dashboard:owner')).toThrow();
    expect(() => approveTask(task.id, 'dashboard:owner')).toThrow();
    expect(listReceiptsForTask(task.id).length).toBe(1);
  });

  test('a human rejection is recorded as an explicit pre-execution rejection', () => {
    const task = proposeGithubIssue();
    rejectTask(task.id, 'dashboard:owner', 'Not worth doing this quarter.');

    const receipt = getLatestReceiptForTask(task.id)!;
    expect(receipt.state).toBe('rejected_pre_execution');
    expect(receipt.rejection_stage).toBe('human_rejection');
    expect(receipt.rejection_reason).toBe('Not worth doing this quarter.');
    expect(receipt.executed_at).toBeNull();
  });

  test('an approved-then-cancelled action settles its existing receipt as cancelled', () => {
    const task = proposeGithubIssue();
    const approved = approveTask(task.id, 'dashboard:owner')!;
    cancelTask(task.id, 'dashboard:owner', 'Changed our minds.');

    const receipt = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(receipt.state).toBe('cancelled');
    expect(receipt.executed_at).toBeNull();
    expect(listReceiptsForTask(task.id).length).toBe(1);
  });

  test('an action type with no executor is rejected pre-execution rather than left dangling', () => {
    // product_suggestion is registered and valid for an ecommerce business
    // but has no executor.ts dispatch case (issue #39).
    const task = createTask({
      business_id: BIZ, title: 'Suggest a product', proposed_by: 'agent:merchandiser',
      action_type: 'product_suggestion', action_payload: {},
    })!;
    const after = approveTask(task.id, 'dashboard:owner')!;
    expect(after.status).toBe('manual_review');

    const receipt = getLatestReceiptForTask(task.id)!;
    expect(receipt.state).toBe('rejected_pre_execution');
    expect(receipt.rejection_stage).toBe('no_executor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('action receipts — retry and duplicate-delivery correlation', () => {
  test('a crash mid-execution whose external reference was already recorded resolves onto the same receipt', async () => {
    const task = proposeGithubIssue();
    const approved = approveTask(task.id, 'dashboard:owner')!;
    const job = getActiveJobForTask(task.id)!;

    // Simulate: the create call succeeded and the reference was persisted
    // (executor.ts writes it before the status transition), then the worker
    // died mid-flight and its lease expired.
    db.prepare(`UPDATE tasks SET status = 'executing' WHERE id = ?`).run(task.id);
    db.prepare(`
      UPDATE execution_jobs SET status = 'executing', lease_owner = 'dead-worker',
        lease_expires_at = datetime('now', '-10 minutes'), external_reference = ?
      WHERE id = ?
    `).run(JSON.stringify({ issue_number: 4242, issue_url: 'https://github.com/acme/widgets/issues/4242', repo: 'acme/widgets' }), job.id);

    const stats = await recoverStuckJobs();
    expect(stats.recovered).toBe(1);
    expect(createIssue).not.toHaveBeenCalled(); // nothing re-executed

    const receipts = listReceiptsForTask(task.id);
    expect(receipts.length).toBe(1); // one action, one receipt — crash and recovery are one story
    const receipt = receipts[0]!;
    expect(receipt.correlation_key).toBe(buildIdempotencyMarker(task.id, approved.version));
    expect(receipt.state).toBe('externally_acknowledged');
    expect(receipt.external_id).toBe('4242');
    expect(receipt.result_status).toBe('success');
    expect(receipt.result_summary).toMatch(/Recovered/i);
  });

  test('a crash mid-external-write with no reference produces one ambiguous receipt, never two conflicting ones', async () => {
    const task = proposeGithubIssue();
    const approved = approveTask(task.id, 'dashboard:owner')!;
    const job = getActiveJobForTask(task.id)!;

    db.prepare(`UPDATE tasks SET status = 'executing' WHERE id = ?`).run(task.id);
    db.prepare(`
      UPDATE execution_jobs SET status = 'executing', lease_owner = 'dead-worker',
        lease_expires_at = datetime('now', '-10 minutes')
      WHERE id = ?
    `).run(job.id);

    const stats = await recoverStuckJobs();
    expect(stats.manualReview).toBe(1);
    expect(getExecutionJob(job.id)!.status).toBe('manual_review');

    const receipts = listReceiptsForTask(task.id);
    expect(receipts.length).toBe(1);
    const receipt = receipts[0]!;
    expect(receipt.correlation_key).toBe(buildIdempotencyMarker(task.id, approved.version));
    expect(receipt.state).toBe('ambiguous');
    expect(receipt.result_status).toBe('unknown');
    // The receipt never claims success or failure it cannot support.
    expect(receipt.executed_at).toBeNull();
    expect(receipt.verified_at).toBeNull();
    expect(receipt.anomalies!.length).toBe(1);
    expect(receipt.anomalies![0]!.type).toBe('ambiguous_outcome');
  });

  test('a crash-recovery requeue and the successful re-run land on one receipt with both attempts recorded', async () => {
    const task = proposeShopifyUpdate();
    const approved = approveTask(task.id, 'dashboard:owner')!;
    const job = getActiveJobForTask(task.id)!;

    // An internal/idempotent action interrupted mid-run: recovery is
    // allowed to retry it from scratch (execution-safety.ts).
    db.prepare(`UPDATE tasks SET status = 'executing' WHERE id = ?`).run(task.id);
    db.prepare(`
      UPDATE execution_jobs SET status = 'executing', lease_owner = 'dead-worker',
        lease_expires_at = datetime('now', '-10 minutes'), attempt_count = 1
      WHERE id = ?
    `).run(job.id);

    const stats = await recoverStuckJobs();
    expect(stats.requeued).toBe(1);

    const afterRequeue = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(afterRequeue.state).toBe('authorized'); // pending another attempt
    expect(afterRequeue.attempt_history!.some((a) => a.status === 'retry_scheduled')).toBe(true);

    const tick = await runExecutionWorkerTick();
    expect(tick.claimed).toBe(1);
    expect(updateProduct).toHaveBeenCalledTimes(1); // executed exactly once overall

    const receipts = listReceiptsForTask(task.id);
    expect(receipts.length).toBe(1);
    const receipt = receipts[0]!;
    expect(receipt.id).toBe(afterRequeue.id);
    expect(receipt.result_status).toBe('success');
    expect(receipt.executed_at).toBeTruthy();
    expect(receipt.external_id).toBe('5001');
    expect(receipt.attempt_count).toBeGreaterThanOrEqual(1);
    expect(receipt.attempt_history!.length).toBeGreaterThanOrEqual(2);
  });

  test('a duplicate external acknowledgement is a no-op; a conflicting one keeps the first reference and flags the receipt ambiguous', async () => {
    const task = proposeGithubIssue();
    const approved = approveTask(task.id, 'dashboard:owner')!;
    await executeTask(task.id, getActiveJobForTask(task.id));

    const first = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(first.external_id).toBe('999');

    // Same identity redelivered — nothing changes, including the timestamp.
    recordExternalAcknowledgement({
      taskId: task.id, taskVersion: approved.version, actionType: 'github_issue',
      outcomeData: { issue_number: 999, issue_url: 'https://github.com/acme/widgets/issues/999' },
    });
    const afterDuplicate = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(afterDuplicate.external_id).toBe('999');
    expect(afterDuplicate.externally_acknowledged_at).toBe(first.externally_acknowledged_at);
    expect(afterDuplicate.state).toBe('externally_acknowledged');
    expect(afterDuplicate.anomalies ?? []).toEqual([]);

    // A DIFFERENT external ID for the same authorized action is exactly the
    // duplicate-object risk the safety layer exists to prevent — never
    // silently overwritten.
    recordExternalAcknowledgement({
      taskId: task.id, taskVersion: approved.version, actionType: 'github_issue',
      outcomeData: { issue_number: 1000, issue_url: 'https://github.com/acme/widgets/issues/1000' },
    });
    const conflicted = getReceiptForTaskVersion(task.id, approved.version)!;
    expect(conflicted.external_id).toBe('999'); // first reference retained
    expect(conflicted.state).toBe('ambiguous');
    expect(conflicted.result_status).toBe('unknown');
    expect(conflicted.anomalies!.some((a) => a.type === 'external_reference_conflict')).toBe(true);
    expect(listReceiptsForTask(task.id).length).toBe(1);
  });

  test('re-approving after a rejection creates a distinct receipt for the new version, not a conflicting overwrite', () => {
    const task = proposeGithubIssue();
    rejectTask(task.id, 'dashboard:owner', 'Not now.');
    db.prepare(`UPDATE tasks SET status = 'proposed' WHERE id = ?`).run(task.id);
    const approved = approveTask(task.id, 'dashboard:owner')!;

    const receipts = listReceiptsForTask(task.id);
    expect(receipts.length).toBe(2);
    const rejected = receipts.find((r) => r.state === 'rejected_pre_execution')!;
    const authorized = receipts.find((r) => r.state === 'authorized')!;
    expect(rejected.task_version).toBeLessThan(authorized.task_version);
    expect(authorized.task_version).toBe(approved.version);
    expect(rejected.correlation_key).not.toBe(authorized.correlation_key);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('action receipts — redaction', () => {
  test('secrets are redacted in storage and again at readback, and raw provider bodies are never persisted', async () => {
    const task = proposeShopifyUpdate();
    const approved = approveTask(task.id, 'dashboard:owner')!;

    // A handler returning credential-shaped data — the case a receipt must
    // never persist verbatim.
    fetchProduct.mockImplementationOnce(async () => ({
      id: '5001',
      title: 'Door topper',
      body_html: '<p>a very long raw provider body that should never be mirrored into a receipt</p>',
      access_token: 'shpat_supersecretshopifytoken',
      credentials: { api_key: 'sk-livesecretkey1234567890' },
      debug_headers: 'Authorization: Bearer abcdef1234567890abcdef',
    }));

    await executeTask(task.id, getActiveJobForTask(task.id));

    const stored = db.prepare('SELECT * FROM action_receipts WHERE task_id = ?').get(task.id) as Record<string, unknown>;
    const rawRow = JSON.stringify(stored);
    expect(rawRow).not.toContain('shpat_supersecretshopifytoken');
    expect(rawRow).not.toContain('sk-livesecretkey1234567890');
    expect(rawRow).not.toContain('Bearer abcdef1234567890abcdef');

    const view = JSON.stringify(toReceiptView(getReceiptForTaskVersion(task.id, approved.version)!));
    expect(view).not.toContain('shpat_supersecretshopifytoken');
    expect(view).not.toContain('sk-livesecretkey1234567890');
    expect(view).not.toContain('Bearer abcdef1234567890abcdef');

    // The useful, non-secret parts survive — redaction is targeted, not a
    // blanket erasure that would make receipts useless.
    expect(view).toContain('5001');
  });

  test('a secret embedded in a failure message is scrubbed from the persisted receipt', async () => {
    const task = proposeShopifyUpdate();
    approveTask(task.id, 'dashboard:owner');
    fetchProduct.mockImplementationOnce(async () => {
      throw new Error('Shopify rejected the call for token shpat_leakedtokenvalue123 at https://acme.myshopify.com/admin?api_key=abcdef123456');
    });

    await executeTask(task.id, getActiveJobForTask(task.id));

    const stored = JSON.stringify(db.prepare('SELECT * FROM action_receipts WHERE task_id = ?').get(task.id));
    expect(stored).not.toContain('shpat_leakedtokenvalue123');
    expect(stored).not.toContain('api_key=abcdef123456');
    expect(stored).toContain('Shopify rejected the call');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('action receipts — business scoping of reads', () => {
  test('listReceipts only ever returns the requested business\'s receipts', () => {
    const task = proposeGithubIssue();
    approveTask(task.id, 'dashboard:owner');

    expect(listReceipts(BIZ).receipts.length).toBeGreaterThan(0);
    expect(listReceipts(OTHER_BIZ).receipts.length).toBe(0);
  });
});
