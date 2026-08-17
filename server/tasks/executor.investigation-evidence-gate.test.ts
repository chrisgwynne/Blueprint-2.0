/**
 * Regression coverage for issue #43: the `investigation` task executor
 * could mark a task `complete` with high causal confidence (the reported
 * case: 0.85, in ~3 seconds) even though the task's own required evidence
 * (exact landing-page URL, HTTP status/redirect chain, canonical
 * consistency, product availability, Merchant Center/Shopify mapping) was
 * never collected — and even though the LLM's own recommendation was
 * `investigate_further`, which on its face means "not done".
 *
 * These tests drive the real executeTask()/executeInvestigation() path
 * against a local HTTP server standing in for the LLM (same technique as
 * executor.research-connector.test.ts), so the wiring in
 * server/tasks/executor.ts is exercised, not just the gate module in
 * isolation (see server/tasks/investigation/evidence-gate.test.ts for that).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
import nodeCrypto from 'crypto';

process.env.ENCRYPTION_KEY ||= nodeCrypto.randomBytes(32).toString('hex');

const getKBForBusinessMock = mock(async (..._args: unknown[]) => null as { engine: unknown } | null);
mock.module('../kb/kb-config.js', () => ({ getKBForBusiness: getKBForBusinessMock }));

const { default: db, generateId } = await import('../db/db.js');
const { executeTask } = await import('./executor.js');
const { createTask } = await import('./task-queue.js');
const { enqueueExecutionJob, getExecutionJob } = await import('./execution-jobs.js');
const { saveProviderCredentials } = await import('../lib/llm-providers.js');

const BIZ = 'biz_investigation_evidence_gate_test';

// Evidence categories the description below deliberately demands — must
// stay in sync with EVIDENCE_CATEGORIES in investigation/evidence-gate.ts.
const EVIDENCE_HEAVY_DESCRIPTION =
  'A key product page dropped out of Google Shopping. Before concluding anything, confirm the exact ' +
  'landing-page URL that is currently live, check the HTTP status code and redirect chain, verify ' +
  'canonical consistency, confirm product availability, and confirm the Merchant Center / Shopify ' +
  'product mapping is correct.';

let llmContent = '';
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Investigation Evidence Gate Test', 'investigation-evidence-gate-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);

  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === '/chat/completions') {
        return Response.json({ choices: [{ message: { content: llmContent } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  saveProviderCredentials('custom', { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: 'test' });
  db.prepare(`INSERT INTO settings (key, value) VALUES ('llm_default_provider', '"custom"') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('llm_default_model', '"test-model"') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
});

afterAll(() => {
  server.stop();
  db.prepare(`DELETE FROM settings WHERE key IN ('llm_default_provider', 'llm_default_model', 'provider_credentials_custom')`).run();
});

afterEach(() => {
  getKBForBusinessMock.mockClear();
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM outcome_measurement_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM metrics WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM connectors WHERE business_id = ?`).run(BIZ);
});

function approvedInvestigationTask(description: string): { taskId: string; jobId: string } {
  const task = createTask({
    business_id: BIZ, title: 'Why did the product page drop from Shopping results?', proposed_by: 'test',
    action_type: 'investigation', action_payload: {}, description,
    approval_mode: 'requires_approval',
  })!;
  const version = (task.version ?? 1) + 1;
  db.prepare(`UPDATE tasks SET status = 'approved', version = ? WHERE id = ?`).run(version, task.id);
  const job = enqueueExecutionJob({ ...task, status: 'approved', version } as any);
  return { taskId: task.id, jobId: job.id };
}

function connectShopify(): void {
  const connectorId = generateId() as string;
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, credentials)
    VALUES (?, ?, 'shopify', 'Shopify', 'connected', '{}')
  `).run(connectorId, BIZ);
  db.prepare(`
    INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, recorded_at)
    VALUES (?, ?, ?, 'product_availability', 1, datetime('now'))
  `).run(generateId() as string, BIZ, connectorId);
}

describe('investigation executor — evidence-vs-confidence gate (issue #43)', () => {
  test('no external evidence gathered + investigate_further recommendation: cannot complete with high confidence', async () => {
    llmContent = JSON.stringify({
      summary: 'The page appears delisted but this needs deeper verification.',
      primary_cause: 'Possible canonical mismatch',
      confidence: 0.85,
      evidence: ['Impressions dropped in the dashboard'],
      explanation: 'Not enough was checked yet to be sure.',
      alternatives: [],
      recommendation: 'investigate_further',
      recommendation_reason: 'Need to check the live URL directly.',
      action_tasks: [],
      do_not_do: [],
      measurement_plan: { primary_metric: 'gsc.clicks', check_at_days: 14 },
    });

    const { taskId, jobId } = approvedInvestigationTask(EVIDENCE_HEAVY_DESCRIPTION);
    const result = await executeTask(taskId, getExecutionJob(jobId));

    // The execution itself succeeds (the LLM call worked) — what must NOT
    // happen is the task silently landing on 'complete' at confidence 0.85.
    expect(result.ok).toBe(true);
    expect(result.status).not.toBe('complete');
    expect(result.status).toBeDefined();
    expect(['blocked', 'manual_review']).toContain(result.status!);

    const row = db.prepare('SELECT status, outcome_data FROM tasks WHERE id = ?').get(taskId) as { status: string; outcome_data: string };
    expect(row.status).not.toBe('complete');
    expect(['blocked', 'manual_review']).toContain(row.status);

    const outcomeData = JSON.parse(row.outcome_data);
    expect(outcomeData.evidence_gate_blocked).toBe(true);
    // Well below the reported 0.85 — evidence coverage was zero.
    expect(outcomeData.primary_confidence == null || outcomeData.primary_confidence < 0.5).toBe(true);
    expect(outcomeData.confidence_capped).toBe(true);
    expect(outcomeData.evidence_checks.length).toBeGreaterThan(0);
    expect(outcomeData.evidence_checks.every((c: { verified: boolean }) => c.verified === false)).toBe(true);
  });

  test('investigate_further with zero spawned tasks does not silently complete — a follow-up task exists and the parent is non-terminal', async () => {
    llmContent = JSON.stringify({
      summary: 'Needs more digging.',
      primary_cause: 'Unclear',
      confidence: 0.85,
      evidence: [],
      explanation: 'Insufficient evidence so far.',
      alternatives: [],
      recommendation: 'investigate_further',
      recommendation_reason: 'More checks required.',
      action_tasks: [], // zero follow-on action tasks proposed
      do_not_do: [],
      measurement_plan: {},
    });

    const { taskId, jobId } = approvedInvestigationTask(EVIDENCE_HEAVY_DESCRIPTION);
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    const outcomeData = result.outcome_data as Record<string, unknown>;
    expect(outcomeData.spawned_tasks).toBe(0); // confirms the act_now spawner produced nothing

    // The parent must remain non-terminal ...
    const parent = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    expect(['complete', 'verified']).not.toContain(parent.status);

    // ... AND (per the fix) an explicit child task was created to close the gap.
    const child = db.prepare('SELECT id, action_type, status FROM tasks WHERE parent_task_id = ?').get(taskId) as
      { id: string; action_type: string; status: string } | null;
    expect(child).not.toBeNull();
    expect(child!.status).toBe('proposed');
  });

  test('verified evidence provided: completion IS allowed and confidence is not capped', async () => {
    connectShopify();

    llmContent = JSON.stringify({
      summary: 'Product availability was confirmed live; the issue was a stale cache, now resolved.',
      primary_cause: 'Stale cache on the storefront',
      confidence: 0.8,
      evidence: ['Shopify product_availability metric confirms the product is in stock and mapped correctly'],
      explanation: 'Verified directly against connector data.',
      alternatives: [],
      recommendation: 'wait',
      recommendation_reason: 'Re-check impressions in a few days once the cache clears.',
      action_tasks: [],
      do_not_do: [],
      measurement_plan: { primary_metric: 'gsc.impressions', check_at_days: 7 },
    });

    const { taskId, jobId } = approvedInvestigationTask(
      'Confirm product availability and the Merchant Center / Shopify product mapping before concluding.'
    );
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(result.status).toBe('complete');

    const row = db.prepare('SELECT status, outcome_data FROM tasks WHERE id = ?').get(taskId) as { status: string; outcome_data: string };
    expect(row.status).toBe('complete');

    const outcomeData = JSON.parse(row.outcome_data);
    expect(outcomeData.confidence_capped).toBe(false);
    expect(outcomeData.primary_confidence).toBe(0.8);
    expect(outcomeData.evidence_checks.every((c: { verified: boolean }) => c.verified === true)).toBe(true);
  });

  test('sensitive URL query parameters are sanitised before outcome_data persistence', async () => {
    connectShopify();
    llmContent = JSON.stringify({
      summary: 'Fixed.',
      primary_cause: 'Redirect loop',
      confidence: 0.5,
      evidence: ['https://shop.example.com/products/widget?variant=99&session_token=SECRET123abc was redirecting'],
      explanation: 'Checked the redirect.',
      alternatives: [],
      recommendation: 'wait',
      recommendation_reason: 'Monitor.',
      action_tasks: [],
      do_not_do: [],
      measurement_plan: {},
    });

    const { taskId, jobId } = approvedInvestigationTask('Confirm product availability.');
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    const row = db.prepare('SELECT outcome_data FROM tasks WHERE id = ?').get(taskId) as { outcome_data: string };
    const raw = row.outcome_data;
    expect(raw).not.toMatch(/session_token/);
    expect(raw).not.toMatch(/SECRET123abc/);
    expect(raw).toMatch(/https:\/\/shop\.example\.com\/products\/widget/);
  });
});
