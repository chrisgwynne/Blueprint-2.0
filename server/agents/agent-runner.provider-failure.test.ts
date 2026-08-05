import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import db from '../db/db.js';

const PROVIDER_BODY_MARKER = 'RAW_GOOGLE_BODY_SHOULD_NOT_ESCAPE';
const SECRET_MARKER = 'AIzaSySECRET_SHOULD_NOT_ESCAPE';

mock.module('./self-healer.js', () => ({
  healAgentError: mock(async () => undefined),
}));

const BIZ = 'biz_provider_failure_test';
const originalFetch = globalThis.fetch;
let completionCalls = 0;

function cleanup() {
  db.prepare('DELETE FROM agent_runs WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM signals WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BIZ);
  db.prepare("DELETE FROM agents WHERE id = 'conductor'").run();
  db.prepare("DELETE FROM settings WHERE key IN ('llm_default_provider','llm_default_model','provider_credentials_google','llm_fallback_provider','llm_fallback_model')").run();
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
  globalThis.fetch = originalFetch;
  completionCalls = 0;
}

beforeAll(() => {
  cleanup();
});

beforeEach(() => {
  cleanup();
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Provider Failure Test', 'provider-failure-test')").run(BIZ);
  db.prepare("INSERT INTO agents (id, profile_path, name, status) VALUES ('conductor', 'server/agents/profiles/conductor.yaml', 'Conductor', 'active')").run();
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
    completionCalls += 1;
    const body = String(init?.body ?? '');
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

    await expect(runAgent('conductor', BIZ, 'manual', null, { bypass_work_check: true }))
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
});
