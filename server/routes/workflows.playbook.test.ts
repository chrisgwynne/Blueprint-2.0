/**
 * Playbook API surface (#74) — the HTTP boundary of server/routes/workflows.ts.
 *
 * Checks the properties that only exist at this layer: an unauthenticated
 * caller gets nothing, every route is scoped to the business in the path,
 * a validation failure comes back as an actionable 400 with its violations
 * rather than a 500, simulation over HTTP still writes nothing, and an
 * Idempotency-Key header cannot start the same run twice.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db from '../db/db.js';
import workflowsRouter from './workflows.ts';
import { upsertActionRegistryEntry } from '../tasks/action-registry.ts';
import { savePolicyVersion } from '../policy/operating-policy.ts';

const BIZ_A = 'biz_pb_route_a';
const BIZ_B = 'biz_pb_route_b';
const WF_A = 'wf_pb_route_a';
const ACTION = 'test_playbook_route_action';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

interface TestResponse { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST', path: string,
  options: { body?: unknown; authed?: boolean; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  const { body, authed = true, headers = {} } = options;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authed ? { 'X-Test-User': 'owner' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Route fixture playbook',
    business_scope: { business_id: BIZ_A, business_types: [] },
    inputs: { type: 'object', required: ['headline'], properties: { headline: { type: 'string' } } },
    steps: [{
      index: 0, name: 'Do the thing', kind: 'action', action_type: ACTION,
      input: { title: '{{inputs.headline}}' },
    }],
    ...overrides,
  };
}

beforeAll(async () => {
  for (const [id, name, slug] of [[BIZ_A, 'PB Route A', 'pb-route-a'], [BIZ_B, 'PB Route B', 'pb-route-b']] as const) {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, name, slug);
  }
  db.prepare(`
    INSERT INTO workflows (id, business_id, name, steps, status, created_by)
    VALUES (?, ?, 'Route fixture workflow', '[]', 'active', 'human')
    ON CONFLICT(id) DO NOTHING
  `).run(WF_A, BIZ_A);

  // `external_verifiable` with no executor dispatch case: approval opens a
  // real receipt and authorises the action, but Blueprint queues no job and
  // the execution worker never touches it — so these HTTP tests exercise the
  // route layer without racing a background tick between requests.
  upsertActionRegistryEntry(ACTION, {
    description: 'Playbook route fixture action (externally executed, no Blueprint executor).',
    payload_schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 } } },
    dispatched_by_executor: false, side_effect_classification: 'external_verifiable',
    risk_level: 'low', requires_approval: false,
  });
  savePolicyVersion({
    key: BIZ_A, actor: 'test:setup',
    patch: { approvals: { require_human_approval_at_or_above: 'red' } },
  });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) (req.session as unknown as Record<string, unknown>).userId = String(req.headers['x-test-user']);
    next();
  });
  app.use('/api/workflows', workflowsRouter);
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
});

describe('authentication and scope', () => {
  test('every playbook route requires a session', async () => {
    for (const [method, path] of [
      ['GET', `/api/workflows/${BIZ_A}/${WF_A}/playbook/versions`],
      ['POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/simulate`],
      ['POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/runs`],
    ] as const) {
      const { status } = await call(method, path, { authed: false, body: method === 'POST' ? {} : undefined });
      expect(status).toBe(401);
    }
  });

  test("another business's workflow is invisible, not merely unauthorised", async () => {
    const { status, body } = await call('GET', `/api/workflows/${BIZ_B}/${WF_A}/playbook/versions`);
    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });
});

describe('version lifecycle over HTTP', () => {
  test('an invalid definition returns its violations, and activation is a 400 not a 500', async () => {
    const created = await call('POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/versions`, {
      body: {
        definition: definition({
          steps: [{ index: 0, name: 'Broken', kind: 'action', action_type: 'nope_not_registered', input: {} }],
        }),
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.version.validation_state).toBe('invalid');
    expect(created.body.version.validation_violations.map((v: any) => v.code)).toContain('step_action_type_unknown');

    const activated = await call(
      'POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/versions/${created.body.version.version}/activate`, { body: {} },
    );
    expect(activated.status).toBe(400);
    expect(activated.body.violations.length).toBeGreaterThan(0);
  });

  test('create → validate → activate → run, and a bad input is a 400 with the field named', async () => {
    const created = await call('POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/versions`, {
      body: { definition: definition(), change_reason: 'First real version' },
    });
    expect(created.status).toBe(201);
    const version = created.body.version.version as number;

    const validated = await call('POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/versions/${version}/validate`, { body: {} });
    expect(validated.status).toBe(200);
    expect(validated.body.valid).toBe(true);

    const activated = await call('POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/versions/${version}/activate`, { body: {} });
    expect(activated.status).toBe(200);
    expect(activated.body.version.state).toBe('active');

    const bad = await call('POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/runs`, { body: { inputs: {} } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.violations)).toContain('headline');

    const started = await call('POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/runs`, {
      body: { inputs: { headline: 'From the API' } },
      headers: { 'Idempotency-Key': 'route-test-key' },
    });
    expect(started.status).toBe(202);
    expect(started.body.reused).toBe(false);

    // The same key and inputs rejoin the run rather than starting a second.
    const again = await call('POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/runs`, {
      body: { inputs: { headline: 'From the API' } },
      headers: { 'Idempotency-Key': 'route-test-key' },
    });
    expect(again.status).toBe(200);
    expect(again.body.reused).toBe(true);
    expect(again.body.run_id).toBe(started.body.run_id);

    const described = await call('GET', `/api/workflows/${BIZ_A}/playbook-runs/${started.body.run_id}`);
    expect(described.status).toBe(200);
    expect(described.body.steps[0].receipt.verdict).toBe('pending');

    // ...and business B cannot read that run.
    const leaked = await call('GET', `/api/workflows/${BIZ_B}/playbook-runs/${started.body.run_id}`);
    expect(leaked.status).toBe(404);
  });
});

describe('simulate over HTTP', () => {
  test('previews an unsaved draft and writes nothing', async () => {
    const before = (db.prepare(
      'SELECT (SELECT COUNT(*) FROM tasks WHERE business_id = ?) AS t, (SELECT COUNT(*) FROM playbook_versions WHERE business_id = ?) AS v',
    ).get(BIZ_A, BIZ_A) as { t: number; v: number });

    const { status, body } = await call('POST', `/api/workflows/${BIZ_A}/${WF_A}/playbook/simulate`, {
      body: { definition: definition(), inputs: { headline: 'Preview only' } },
    });

    expect(status).toBe(200);
    expect(body.side_effects_performed).toBe('none');
    expect(body.definition_valid).toBe(true);
    expect(body.steps[0].resolved_input.title).toBe('Preview only');

    const after = (db.prepare(
      'SELECT (SELECT COUNT(*) FROM tasks WHERE business_id = ?) AS t, (SELECT COUNT(*) FROM playbook_versions WHERE business_id = ?) AS v',
    ).get(BIZ_A, BIZ_A) as { t: number; v: number });
    expect(after).toEqual(before);
  });
});
