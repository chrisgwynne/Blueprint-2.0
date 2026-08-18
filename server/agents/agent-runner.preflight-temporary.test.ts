import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

mock.module('./self-healer.js', () => ({
  healAgentError: mock(async () => undefined),
}));

const BIZ = 'biz_preflight_temporary_test';
const AGENT_ID = 'preflight-temporary-test';
const AGENT_DIR = resolve(__dirname, AGENT_ID);
const PROFILE_PATH = resolve(AGENT_DIR, 'profile.yaml');
const CUSTOM_BASE_URL = 'https://preflight-temporary-test.example';
const originalFetch = globalThis.fetch;

function cleanup() {
  db.prepare('DELETE FROM agent_runs WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agent_run_events WHERE run_id NOT IN (SELECT id FROM agent_runs)').run();
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM signals WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agents WHERE id = ?').run(AGENT_ID);
  db.prepare("DELETE FROM settings WHERE key IN ('llm_default_provider','llm_default_model','provider_credentials_custom')").run();
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
  db.prepare("DELETE FROM provider_preflight_cache WHERE provider = 'custom' AND model = 'preflight-tmp-model'").run();
  if (existsSync(AGENT_DIR)) rmSync(AGENT_DIR, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
}

function seedDb() {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Preflight Tmp Test', 'preflight-tmp-test')").run(BIZ);
  db.prepare('INSERT INTO agents (id, profile_path, name, status) VALUES (?, ?, ?, ?)').run(
    AGENT_ID, PROFILE_PATH, 'Preflight Tmp Test', 'active',
  );
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_provider', ?)").run(JSON.stringify({ provider: 'custom' }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_model', ?)").run(JSON.stringify('preflight-tmp-model'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('provider_credentials_custom', ?)").run(JSON.stringify({
    baseUrl: CUSTOM_BASE_URL,
    apiKey: 'test-key',
  }));
}

beforeAll(() => { cleanup(); });

beforeEach(() => {
  cleanup();
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(PROFILE_PATH, [
    `id: ${AGENT_ID}`,
    'name: Preflight Temporary Test',
    'description: Test agent for preflight temporary-failure handling',
    'system_prompt: Test system prompt',
    'llm:',
    '  temperature: 0.2',
    '  max_tokens: 256',
    '',
  ].join('\n'));
  seedDb();
});

afterEach(cleanup);

describe('preflight temporary failure handling', () => {
  test('probe 429 → run status is failed (not blocked), terminal_reason is provider_preflight_temporary', async () => {
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'preflight-tmp-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Probe (chat/completions) returns 429 — transient rate limit
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    const { runAgent } = await import('./agent-runner.js');
    const result = await runAgent(AGENT_ID, BIZ, 'scheduled', null, { bypass_work_check: true });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('provider_preflight_temporary');

    const rows = db.prepare(
      'SELECT status, error, terminal_reason, completed_at FROM agent_runs WHERE business_id = ?'
    ).all(BIZ) as Array<{ status: string; error: string | null; terminal_reason: string | null; completed_at: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.terminal_reason).toBe('provider_preflight_temporary');
    expect(rows[0]?.error).toContain('transiently');
    expect(rows[0]?.completed_at).not.toBeNull();
  });

  test('probe 429 → preflight cache records temporary flag', async () => {
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'preflight-tmp-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    const { runAgent } = await import('./agent-runner.js');
    await runAgent(AGENT_ID, BIZ, 'scheduled', null, { bypass_work_check: true });

    const cache = db.prepare(
      "SELECT status, evidence FROM provider_preflight_cache WHERE provider = 'custom' AND model = 'preflight-tmp-model'"
    ).get() as { status: string; evidence: string } | undefined;

    expect(cache).toBeDefined();
    expect(cache?.status).toBe('failed');
    const ev = JSON.parse(cache?.evidence ?? '{}') as Record<string, unknown>;
    expect(ev['temporary']).toBe(true);
  });

  test('placeholder probe response → run stays blocked (permanent failure unchanged)', async () => {
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'preflight-tmp-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Probe returns a placeholder response — permanent failure
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'mock placeholder response' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const { runAgent } = await import('./agent-runner.js');
    const result = await runAgent(AGENT_ID, BIZ, 'scheduled', null, { bypass_work_check: true });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('provider_preflight_failed');

    const rows = db.prepare(
      'SELECT status, terminal_reason, completed_at FROM agent_runs WHERE business_id = ?'
    ).all(BIZ) as Array<{ status: string; terminal_reason: string | null; completed_at: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('blocked');
    expect(rows[0]?.completed_at).not.toBeNull();
    // terminal_reason is JSON evidence for permanent failures (existing behaviour)
    const tr = JSON.parse(rows[0]?.terminal_reason ?? '{}') as Record<string, unknown>;
    expect(tr['status']).toBe('failed');
    expect(tr['evidence']).toBeDefined();
  });

  test('missing model in provider listing → run stays blocked (permanent failure unchanged)', async () => {
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/models')) {
        // Returns a different model — 'preflight-tmp-model' is absent
        return new Response(JSON.stringify({ data: [{ id: 'some-other-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('should not reach chat/completions', { status: 500 });
    }) as unknown as typeof fetch;

    const { runAgent } = await import('./agent-runner.js');
    const result = await runAgent(AGENT_ID, BIZ, 'scheduled', null, { bypass_work_check: true });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('provider_preflight_failed');

    const rows = db.prepare(
      'SELECT status, completed_at FROM agent_runs WHERE business_id = ?'
    ).all(BIZ) as Array<{ status: string; completed_at: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('blocked');
    expect(rows[0]?.completed_at).not.toBeNull();
  });
});
