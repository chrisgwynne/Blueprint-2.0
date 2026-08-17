/**
 * BAP playbooks (issue #85) — server/routes/bap-playbooks.ts, exercised
 * against a real Express instance mounting the actual router.
 *
 * Three properties carry the weight here:
 *
 *   1. Read/simulate/list behave like every other BAP surface: permission
 *      denial, business-access denial, not-found for an unknown playbook.
 *   2. Simulate is genuinely zero-side-effect, same as the dashboard route.
 *   3. Triggering a run does NOT bypass approval: a step whose action_type
 *      is registry-gated ends up `awaiting_approval` with no task created,
 *      exactly as it would starting from the dashboard — and an auto-
 *      eligible step still goes through the real createTask()+approveTask()
 *      pipeline rather than some BAP-only shortcut.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix, bapAuth, GRANTABLE_BAP_PERMISSIONS } from '../bap/auth.ts';
import { bapRequestContext } from '../bap/route-helpers.ts';
import { bapRateLimit } from '../bap/rate-limiter.ts';
import bapPlaybooksRouter from './bap-playbooks.ts';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';
import { savePolicyVersion } from '../policy/operating-policy.js';
import { savePlaybookDraft, activatePlaybookVersion } from '../workflows/playbook-versions.js';

const BIZ_A = 'biz_bap_pb_a';
const BIZ_B = 'biz_bap_pb_b';
const WF_AUTO = 'wf_bap_pb_auto';       // auto-run step, low risk, no approval required
const WF_GATED = 'wf_bap_pb_gated';     // registry requires_approval: true
const WF_LEGACY = 'wf_bap_pb_legacy';   // pre-#74 workflow, never versioned
const WF_B = 'wf_bap_pb_b';             // lives in BIZ_B

const ACTION_AUTO = 'bap_pb_test_auto';
const ACTION_GATED = 'bap_pb_test_gated';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let keyRead: string;      // BIZ_A, playbooks:read only
let keyTrigger: string;   // BIZ_A, playbooks:read + playbooks:trigger
let keyNoGrant: string;   // BIZ_A, tasks:read only
let keyOtherBiz: string;  // BIZ_B only, playbooks:read + playbooks:trigger

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function definition(actionType: string, businessId: string) {
  return {
    name: `Fixture playbook (${actionType})`,
    business_scope: { business_id: businessId, business_types: [] },
    inputs: { type: 'object', required: ['headline'], properties: { headline: { type: 'string' } } },
    steps: [{
      index: 0, name: 'Do the thing', kind: 'action', action_type: actionType,
      input: { title: '{{inputs.headline}}' },
    }],
  };
}

function seedActivePlaybook(workflowId: string, businessId: string, actionType: string): void {
  db.prepare(`
    INSERT INTO workflows (id, business_id, name, steps, status, created_by)
    VALUES (?, ?, ?, '[]', 'active', 'human') ON CONFLICT(id) DO NOTHING
  `).run(workflowId, businessId, `Fixture workflow ${workflowId}`);
  const draft = savePlaybookDraft({
    workflowId, businessId, definition: definition(actionType, businessId), actor: 'test:setup', validate: true,
  });
  activatePlaybookVersion({ workflowId, businessId, version: draft.version, actor: 'test:setup' });
}

beforeAll(async () => {
  for (const [id, name, slug] of [[BIZ_A, 'BAP PB A', 'bap-pb-a'], [BIZ_B, 'BAP PB B', 'bap-pb-b']] as const) {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, name, slug);
  }

  // Auto-eligible: low risk, no explicit approval, no Blueprint executor
  // dispatch (so these HTTP tests don't race a background worker tick).
  upsertActionRegistryEntry(ACTION_AUTO, {
    description: 'BAP playbook fixture — auto-eligible action.',
    payload_schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 } } },
    dispatched_by_executor: false, side_effect_classification: 'external_verifiable',
    risk_level: 'low', requires_approval: false,
  });
  // Registry-gated: requires_approval forces resolveStepApproval() to pause
  // the step BEFORE dispatchStep ever runs, regardless of risk tier or
  // operating policy ceiling.
  upsertActionRegistryEntry(ACTION_GATED, {
    description: 'BAP playbook fixture — registry-gated action.',
    payload_schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 } } },
    dispatched_by_executor: false, side_effect_classification: 'external_verifiable',
    risk_level: 'low', requires_approval: true,
  });
  // A generous human-approval floor so ACTION_AUTO's low/green tier does not
  // ALSO get gated by the policy ceiling — isolates the registry-level gate
  // as the only thing under test for ACTION_GATED.
  savePolicyVersion({ key: BIZ_A, actor: 'test:setup', patch: { approvals: { require_human_approval_at_or_above: 'red' } } });

  seedActivePlaybook(WF_AUTO, BIZ_A, ACTION_AUTO);
  seedActivePlaybook(WF_GATED, BIZ_A, ACTION_GATED);
  seedActivePlaybook(WF_B, BIZ_B, ACTION_AUTO);

  // Legacy (pre-#74) workflow: never given a playbook_versions row, so it
  // must never appear in the BAP playbooks list.
  db.prepare(`
    INSERT INTO workflows (id, business_id, name, steps, status, created_by)
    VALUES (?, ?, 'Legacy free-text workflow', '[]', 'active', 'human') ON CONFLICT(id) DO NOTHING
  `).run(WF_LEGACY, BIZ_A);

  const AGENT_IDS = ['agt_pb_read', 'agt_pb_trigger', 'agt_pb_nogrant', 'agt_pb_otherbiz'];
  for (const id of AGENT_IDS) db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);

  keyRead = generateApiKey();
  keyTrigger = generateApiKey();
  keyNoGrant = generateApiKey();
  keyOtherBiz = generateApiKey();
  const insertAgent = db.prepare(`
    INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `);
  insertAgent.run('agt_pb_read', 'PB Read Agent', await hashApiKey(keyRead), keyPrefix(keyRead),
    JSON.stringify(['playbooks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_pb_trigger', 'PB Trigger Agent', await hashApiKey(keyTrigger), keyPrefix(keyTrigger),
    JSON.stringify(['playbooks:read', 'playbooks:trigger']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_pb_nogrant', 'No Grant Agent', await hashApiKey(keyNoGrant), keyPrefix(keyNoGrant),
    JSON.stringify(['tasks:read']), JSON.stringify([BIZ_A]));
  insertAgent.run('agt_pb_otherbiz', 'Other Business Agent', await hashApiKey(keyOtherBiz), keyPrefix(keyOtherBiz),
    JSON.stringify(['playbooks:read', 'playbooks:trigger']), JSON.stringify([BIZ_B]));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/bap/v1', bapRequestContext, bapAuth, bapRateLimit('default'), bapPlaybooksRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  const ids = [BIZ_A, BIZ_B];
  db.prepare('DELETE FROM workflow_step_runs WHERE business_id IN (?, ?)').run(...ids);
  db.prepare('DELETE FROM workflow_runs WHERE business_id IN (?, ?)').run(...ids);
  db.prepare('DELETE FROM playbook_versions WHERE business_id IN (?, ?)').run(...ids);
  db.prepare('DELETE FROM playbook_events WHERE business_id IN (?, ?)').run(...ids);
  db.prepare('DELETE FROM action_receipts WHERE business_id IN (?, ?)').run(...ids);
  db.prepare('DELETE FROM execution_jobs WHERE business_id IN (?, ?)').run(...ids);
  db.prepare('DELETE FROM tasks WHERE business_id IN (?, ?)').run(...ids);
  db.prepare('DELETE FROM operating_policies WHERE scope_key IN (?, ?)').run(...ids);
  db.prepare(`DELETE FROM action_registry WHERE action_type IN (?, ?)`).run(ACTION_AUTO, ACTION_GATED);
  const agentIds = ['agt_pb_read', 'agt_pb_trigger', 'agt_pb_nogrant', 'agt_pb_otherbiz'];
  db.prepare(`DELETE FROM idempotency_keys WHERE agent_id IN (${agentIds.map(() => '?').join(',')})`).run(...agentIds);
  db.prepare(`DELETE FROM bap_audit WHERE agent_id IN (${agentIds.map(() => '?').join(',')})`).run(...agentIds);
  db.prepare(`DELETE FROM bap_agents WHERE id IN (${agentIds.map(() => '?').join(',')})`).run(...agentIds);
});

// ─── The grants ───────────────────────────────────────────────────────────────

describe('playbooks:read / playbooks:trigger grants', () => {
  test('are offered, and are genuinely separate grants', () => {
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('playbooks:read');
    expect(GRANTABLE_BAP_PERMISSIONS).toContain('playbooks:trigger');
  });
});

// ─── List ────────────────────────────────────────────────────────────────────

describe('GET /businesses/:id/playbooks', () => {
  test('lists only versioned playbooks, never the legacy free-text workflow', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    const ids = body.playbooks.map((p: any) => p.workflow_id); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ids).toContain(WF_AUTO);
    expect(ids).toContain(WF_GATED);
    expect(ids).not.toContain(WF_LEGACY);
    expect(ids).not.toContain(WF_B);

    const auto = body.playbooks.find((p: any) => p.workflow_id === WF_AUTO); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(auto.active_version.version).toBe(1);
    expect(auto.active_version.step_count).toBe(1);
  });

  test('permission denial: an agent without playbooks:read gets 403', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks`, { 'BAP-Key': keyNoGrant });
    expect(status).toBe(403);
  });

  test('business-access denial: a grant scoped to a different business gets 403', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks`, { 'BAP-Key': keyOtherBiz });
    expect(status).toBe(403);
  });

  test('unauthenticated request is rejected outright', async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks`);
    expect(status).toBe(401);
  });
});

// ─── Detail ──────────────────────────────────────────────────────────────────

describe('GET /businesses/:id/playbooks/:playbookId', () => {
  test('returns the active version definition and version history', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}`, { 'BAP-Key': keyRead });
    expect(status).toBe(200);
    expect(body.active_version.definition.steps[0].action_type).toBe(ACTION_AUTO);
    expect(body.versions.length).toBe(1);
    expect(body.versions[0].state).toBe('active');
  });

  test('not-found for an unknown playbook id', async () => {
    const { status, body } = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks/does-not-exist`, { 'BAP-Key': keyRead });
    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  test("another business's playbook is not found, not merely unauthorized, from a grant that DOES cover this business", async () => {
    const { status } = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_B}`, { 'BAP-Key': keyRead });
    expect(status).toBe(404);
  });
});

// ─── Simulate ────────────────────────────────────────────────────────────────

describe('POST /businesses/:id/playbooks/:playbookId/simulate', () => {
  test('previews with zero side effects', async () => {
    const before = (db.prepare(
      'SELECT (SELECT COUNT(*) FROM tasks WHERE business_id = ?) AS t, (SELECT COUNT(*) FROM workflow_runs WHERE business_id = ?) AS r',
    ).get(BIZ_A, BIZ_A) as { t: number; r: number });

    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/simulate`,
      { inputs: { headline: 'Preview only' } },
      { 'BAP-Key': keyRead },
    );

    expect(status).toBe(200);
    expect(body.side_effects_performed).toBe('none');
    expect(body.would_complete_without_human).toBe(true);
    expect(body.steps[0].resolved_input.title).toBe('Preview only');

    const after = (db.prepare(
      'SELECT (SELECT COUNT(*) FROM tasks WHERE business_id = ?) AS t, (SELECT COUNT(*) FROM workflow_runs WHERE business_id = ?) AS r',
    ).get(BIZ_A, BIZ_A) as { t: number; r: number });
    expect(after).toEqual(before);
  });

  test('a registry-gated step simulates as requiring approval', async () => {
    const { body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_GATED}/simulate`,
      { inputs: { headline: 'Preview only' } },
      { 'BAP-Key': keyRead },
    );
    expect(body.would_complete_without_human).toBe(false);
    expect(body.steps[0].requires_approval).toBe(true);
    expect(body.steps[0].approval_sources).toContain('registry_requires_approval');
  });

  test('simulate is granted by playbooks:read alone (no separate simulate grant)', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/simulate`,
      { inputs: { headline: 'x' } },
      { 'BAP-Key': keyRead },
    );
    expect(status).toBe(200);
  });

  test('not-found for an unknown playbook id', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/does-not-exist/simulate`, {}, { 'BAP-Key': keyRead },
    );
    expect(status).toBe(404);
  });
});

// ─── Trigger a run ───────────────────────────────────────────────────────────

describe('POST /businesses/:id/playbooks/:playbookId/run', () => {
  test('permission denial: playbooks:read alone cannot trigger a run', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/run`,
      { inputs: { headline: 'nope' } },
      { 'BAP-Key': keyRead, 'Idempotency-Key': generateId() },
    );
    expect(status).toBe(403);
  });

  test('requires an Idempotency-Key header', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/run`,
      { inputs: { headline: 'nope' } },
      { 'BAP-Key': keyTrigger },
    );
    expect(status).toBe(400);
  });

  test('not-found for an unknown playbook id', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/does-not-exist/run`,
      {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() },
    );
    expect(status).toBe(404);
  });

  test('business-access denial: a grant scoped to a different business gets 403', async () => {
    const { status } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/run`,
      { inputs: { headline: 'nope' } },
      { 'BAP-Key': keyOtherBiz, 'Idempotency-Key': generateId() },
    );
    expect(status).toBe(403);
  });

  test('an auto-eligible step runs through the real createTask()+approveTask() pipeline, attributed bap:<agent id>', async () => {
    const key = generateId();
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/run`,
      { inputs: { headline: 'Triggered via BAP' } },
      { 'BAP-Key': keyTrigger, 'Idempotency-Key': key },
    );
    expect(status).toBe(202);
    expect(body.reused).toBe(false);
    expect(['awaiting_execution', 'running', 'complete']).toContain(body.status);

    const stepRun = db.prepare(
      'SELECT * FROM workflow_step_runs WHERE run_id = ? AND step_index = 0',
    ).get(body.run_id) as Record<string, unknown>;
    expect(stepRun.status).not.toBe('awaiting_approval');
    expect(stepRun.task_id).toBeTruthy();

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(stepRun.task_id as string) as Record<string, unknown>;
    expect(task.proposed_by).toBe(`playbook:${WF_AUTO}`);
    expect(task.status).not.toBe('proposed'); // approveTask() actually ran

    const run = db.prepare('SELECT triggered_by FROM workflow_runs WHERE id = ?').get(body.run_id) as { triggered_by: string };
    expect(run.triggered_by).toBe(`bap:agt_pb_trigger`);

    // Retrying with the SAME Idempotency-Key + same body replays the exact
    // original response (the BAP-level idempotency layer) rather than
    // re-invoking startPlaybookRun — so it does not start a second run.
    const again = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/run`,
      { inputs: { headline: 'Triggered via BAP' } },
      { 'BAP-Key': keyTrigger, 'Idempotency-Key': key },
    );
    expect(again.status).toBe(status);
    expect(again.body).toEqual(body);
    const runCount = (db.prepare('SELECT COUNT(*) as n FROM workflow_runs WHERE id = ?').get(body.run_id) as { n: number }).n;
    expect(runCount).toBe(1);

    // The run is visible on the read surface, receipt-backed status included.
    const detail = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/runs/${body.run_id}`, { 'BAP-Key': keyRead });
    expect(detail.status).toBe(200);
    expect(detail.body.steps[0].receipt).toBeTruthy();

    const list = await get(`/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/runs`, { 'BAP-Key': keyRead });
    expect(list.status).toBe(200);
    expect(list.body.runs.some((r: any) => r.id === body.run_id)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  test('a registry-gated step pauses at awaiting_approval and creates NO task — triggering a run does not bypass approval', async () => {
    const { status, body } = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_GATED}/run`,
      { inputs: { headline: 'Triggered via BAP' } },
      { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() },
    );
    expect(status).toBe(202);
    expect(body.status).toBe('paused');

    const stepRun = db.prepare(
      'SELECT * FROM workflow_step_runs WHERE run_id = ? AND step_index = 0',
    ).get(body.run_id) as Record<string, unknown>;
    expect(stepRun.status).toBe('awaiting_approval');
    expect(stepRun.approval_required).toBe(1);
    // The deciding proof: no task was ever created for this step, so there
    // is nothing left for a BAP agent to "approve on its own protocol" even
    // if it wanted to — the only path forward is the dashboard.
    expect(stepRun.task_id).toBeNull();
  });

  test('there is no BAP endpoint to approve, reject, retry, roll back or cancel a run or step', async () => {
    for (const path of ['approve', 'reject', 'retry', 'rollback', 'cancel']) {
      const { status } = await post(
        `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_GATED}/runs/whatever/steps/0/${path}`,
        {}, { 'BAP-Key': keyTrigger, 'Idempotency-Key': generateId() },
      );
      expect(status).toBe(404); // Express: no such route, not a permission/not-found from a handler
    }
  });

  test('a run for one playbook is not visible under a different playbook path', async () => {
    const key = generateId();
    const triggered = await post(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_AUTO}/run`,
      { inputs: { headline: 'Cross-playbook check' } },
      { 'BAP-Key': keyTrigger, 'Idempotency-Key': key },
    );
    expect(triggered.status).toBe(202);

    const wrongPath = await get(
      `/api/bap/v1/businesses/${BIZ_A}/playbooks/${WF_GATED}/runs/${triggered.body.run_id}`,
      { 'BAP-Key': keyRead },
    );
    expect(wrongPath.status).toBe(404);
  });
});
