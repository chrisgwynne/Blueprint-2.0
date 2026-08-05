import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import db from '../db/db.js';

const BIZ = 'biz_search_fallback_test';
const AGENT_ID = 'search-fallback-test';
const AGENT_DIR = resolve(process.cwd(), 'server/agents', AGENT_ID);
const PROFILE_PATH = resolve(AGENT_DIR, 'profile.yaml');
const PROVIDER_BODY_MARKER = 'RAW_SEARCH_PHASE_PROVIDER_BODY_SHOULD_NOT_ESCAPE';
const SECRET_MARKER = 'AIzaSySEARCH_PHASE_SECRET_SHOULD_NOT_ESCAPE';

const llmCalls: Array<{ providerId: string; model: string; content: string }> = [];
const warnMessages: string[] = [];
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;

mock.module('./tools/search.js', () => ({
  agentSearch: mock(async () => ({
    available: true,
    answer: 'Search answer',
    results: [{ title: 'Retry handling', url: 'https://example.test/retry', content: 'Retry safely.' }],
  })),
}));

mock.module('./self-healer.js', () => ({
  healAgentError: mock(async () => undefined),
}));

function cleanup() {
  db.prepare('DELETE FROM agent_runs WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agent_run_events WHERE run_id NOT IN (SELECT id FROM agent_runs)').run();
  db.prepare('DELETE FROM cost_daily WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM signals WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(BIZ);
  const hasInbox = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_inbox'").get();
  if (hasInbox) db.prepare('DELETE FROM agent_inbox WHERE business_id = ?').run(BIZ);
  db.prepare('DELETE FROM agents WHERE id = ?').run(AGENT_ID);
  db.prepare("DELETE FROM settings WHERE key IN ('llm_default_provider','llm_default_model','llm_fallback_provider','llm_fallback_model','provider_credentials_google','provider_credentials_custom')").run();
  db.prepare('DELETE FROM businesses WHERE id = ?').run(BIZ);
  if (existsSync(AGENT_DIR)) rmSync(AGENT_DIR, { recursive: true, force: true });
  llmCalls.length = 0;
  warnMessages.length = 0;
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
}

beforeEach(() => {
  cleanup();
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(PROFILE_PATH, [
    `id: ${AGENT_ID}`,
    'name: Search Fallback Test',
    'description: Test agent',
    'system_prompt: Test system prompt',
    'llm:',
    '  temperature: 0.2',
    '  max_tokens: 256',
    '',
  ].join('\n'));
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Search Fallback Test', 'search-fallback-test')").run(BIZ);
  db.prepare('INSERT INTO agents (id, profile_path, name, status) VALUES (?, ?, ?, ?)').run(
    AGENT_ID,
    PROFILE_PATH,
    'Search Fallback Test',
    'active',
  );
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_provider', ?)").run(JSON.stringify({ provider: 'google' }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_model', ?)").run(JSON.stringify('gemini-3.5-flash-lite'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_fallback_provider', ?)").run(JSON.stringify({ provider: 'custom' }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_fallback_model', ?)").run(JSON.stringify('custom-fallback-test'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('provider_credentials_google', ?)").run(JSON.stringify({ apiKey: SECRET_MARKER }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('provider_credentials_custom', ?)").run(JSON.stringify({
    baseUrl: 'https://custom-provider.test',
    apiKey: 'custom-test-key',
  }));
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? '');

    if (url.includes('/models?')) {
      return new Response(JSON.stringify({
        models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }],
      }), { status: 200 });
    }
    if (url === 'https://custom-provider.test/models') {
      return new Response(JSON.stringify({ data: [{ id: 'custom-fallback-test' }] }), { status: 200 });
    }
    if (body.includes('Reply with exactly: ok')) {
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }

    if (url.includes('generativelanguage.googleapis.com')) {
      llmCalls.push({ providerId: 'google', model: 'gemini-3.5-flash-lite', content: body });
      return new Response(`${PROVIDER_BODY_MARKER} key=${SECRET_MARKER}`, { status: 429 });
    }

    const parsedBody = JSON.parse(body) as { model?: string; messages?: Array<{ content?: string }> };
    const content = parsedBody.messages?.map((m) => m.content ?? '').join('\n') ?? '';
    llmCalls.push({ providerId: 'custom', model: parsedBody.model ?? 'default', content });
    if (content.includes('## Web Search Results')) {
      return new Response(`${PROVIDER_BODY_MARKER} key=${SECRET_MARKER}`, { status: 429 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        tasks: [],
        reasoning: 'fallback needs current context',
        signals_detected: 0,
        search_queries: [{ query: 'rate limit handling', depth: 'basic' }],
      }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  console.warn = mock((...args: unknown[]) => {
    warnMessages.push(args.map(String).join(' '));
  }) as unknown as typeof console.warn;
});

afterEach(cleanup);

describe('runAgent search pass after provider fallback', () => {
  test('uses actual fallback provider/model for search-results pass and sanitizes search failure warnings', async () => {
    const { runAgent } = await import('./agent-runner.js');

    await runAgent(AGENT_ID, BIZ, 'manual', null, { bypass_work_check: true });

    expect(llmCalls.map(({ providerId, model }) => `${providerId}/${model}`)).toEqual([
      'google/gemini-3.5-flash-lite',
      'custom/custom-fallback-test',
      'custom/custom-fallback-test',
    ]);
    expect(warnMessages.join('\n')).not.toContain(PROVIDER_BODY_MARKER);
    expect(warnMessages.join('\n')).not.toContain(SECRET_MARKER);
  });
});
