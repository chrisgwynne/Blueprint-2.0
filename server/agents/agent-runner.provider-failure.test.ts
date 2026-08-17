import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROVIDER_BODY_MARKER = 'RAW_GOOGLE_BODY_SHOULD_NOT_ESCAPE';
const SECRET_MARKER = 'AIzaSySECRET_SHOULD_NOT_ESCAPE';
const RAW_CUSTOM_MARKER = 'sk-RAW_CUSTOM_PROVIDER_BODY_SHOULD_NOT_ESCAPE';
const CUSTOM_BASE_URL = 'https://custom-provider-failure.test';

const healAgentError = mock(async () => undefined);

mock.module('./self-healer.js', () => ({
  healAgentError,
}));

const BIZ = 'biz_provider_failure_test';
const AGENT_ID = 'provider-failure-test';
// CWD-independent, matching agent-runner.ts's own AGENTS_DIR resolution
// (issue #41's pattern) — this file lives in server/agents/, so its own
// dirname already points at the real agents directory regardless of
// whether the test runner's cwd is the repo root or server/.
const AGENT_DIR = resolve(__dirname, AGENT_ID);
const PROFILE_PATH = resolve(AGENT_DIR, 'profile.yaml');
const originalFetch = globalThis.fetch;
let completionCalls = 0;

function cleanup() {
  db.prepare('DELETE FROM agent_runs WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agent_run_events WHERE run_id NOT IN (SELECT id FROM agent_runs)').run();
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM signals WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agents WHERE id = ?').run(AGENT_ID);
  db.prepare("DELETE FROM settings WHERE key IN ('llm_default_provider','llm_default_model','provider_credentials_google','provider_credentials_custom','llm_fallback_provider','llm_fallback_model')").run();
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
  if (existsSync(AGENT_DIR)) rmSync(AGENT_DIR, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  healAgentError.mockClear();
  completionCalls = 0;
}

beforeAll(() => {
  cleanup();
});

beforeEach(() => {
  cleanup();
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(PROFILE_PATH, [
    `id: ${AGENT_ID}`,
    'name: Provider Failure Test',
    'description: Test agent',
    'system_prompt: Test system prompt',
    'llm:',
    '  temperature: 0.2',
    '  max_tokens: 256',
    '',
  ].join('\n'));
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Provider Failure Test', 'provider-failure-test')").run(BIZ);
  db.prepare('INSERT INTO agents (id, profile_path, name, status) VALUES (?, ?, ?, ?)').run(
    AGENT_ID,
    PROFILE_PATH,
    'Provider Failure Test',
    'active',
  );
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_provider', ?)").run(JSON.stringify({ provider: 'google' }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_model', ?)").run(JSON.stringify('gemini-3.5-flash-lite'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('provider_credentials_google', ?)").run(JSON.stringify({ apiKey: SECRET_MARKER }));
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/models?')) {
      return new Response(JSON.stringify({
        models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }],
      }), { status: 200 });
    }
    if (url === `${CUSTOM_BASE_URL}/models`) {
      return new Response(JSON.stringify({ data: [{ id: 'custom-provider-failure-model' }] }), { status: 200 });
    }
    completionCalls += 1;
    const body = String(init?.body ?? '');
    if (url === `${CUSTOM_BASE_URL}/chat/completions` && body.includes('Reply with exactly: ok')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    if (url === `${CUSTOM_BASE_URL}/chat/completions`) {
      return new Response(`custom body marker ${RAW_CUSTOM_MARKER}`, { status: 500 });
    }
    if (body.includes('Reply with exactly: ok')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200 });
    }
    return new Response(`${PROVIDER_BODY_MARKER} key=${SECRET_MARKER}`, { status: 429 });
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

describe('runAgent provider failure handling', () => {
  test('provider failure marks the run failed without SQLite bind mismatch or unsafe error text', async () => {
    const { runAgent } = await import('./agent-runner.js');

    await expect(runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true }))
      .rejects.toThrow(/provider.*google.*429/i);

    const rows = db.prepare(
      'SELECT status, error, terminal_reason, completed_at FROM agent_runs WHERE business_id = ?'
    ).all(BIZ) as Array<{ status: string; error: string | null; terminal_reason: string | null; completed_at: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.completed_at).not.toBeNull();
    expect(rows[0]?.terminal_reason).toBe('provider_retryable_http_429');
    expect(rows[0]?.error).toContain('provider google http_429 retryable');
    expect(rows[0]?.error).not.toContain(PROVIDER_BODY_MARKER);
    expect(rows[0]?.error).not.toContain(SECRET_MARKER);
    expect(completionCalls).toBe(2);

    const running = db.prepare(
      "SELECT COUNT(*) AS n FROM agent_runs WHERE business_id = ? AND status = 'running'"
    ).get(BIZ) as { n: number };
    expect(running.n).toBe(0);
  });

  test('passes only a sanitized stored error to self-healer for raw non-Google provider errors', async () => {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'llm_default_provider'").run(JSON.stringify({ provider: 'custom' }));
    db.prepare("UPDATE settings SET value = ? WHERE key = 'llm_default_model'").run(JSON.stringify('custom-provider-failure-model'));
    db.prepare("INSERT INTO settings (key, value) VALUES ('provider_credentials_custom', ?)").run(JSON.stringify({
      baseUrl: CUSTOM_BASE_URL,
      apiKey: 'custom-provider-failure-key',
    }));
    const { runAgent } = await import('./agent-runner.js');

    await expect(runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true }))
      .rejects.toThrow(/provider custom http_500 retryable/i);

    for (let i = 0; i < 10 && healAgentError.mock.calls.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    expect(healAgentError).toHaveBeenCalledTimes(1);
    const healedError = (healAgentError.mock.calls as unknown as Array<[Error]>)[0]?.[0];
    expect(healedError).toBeDefined();
    if (!healedError) throw new Error('Expected healAgentError to receive an error.');
    expect(healedError).toBeInstanceOf(Error);
    expect(healedError.message).toContain('provider custom http_500 retryable');
    expect(healedError.message).not.toContain(RAW_CUSTOM_MARKER);
  });
});
