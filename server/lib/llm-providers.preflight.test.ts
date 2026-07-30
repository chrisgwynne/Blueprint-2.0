import { afterEach, describe, expect, test } from 'bun:test';
import db from '../db/db.js';
import { performProviderPreflight, saveProviderCredentials } from './llm-providers.js';

let server: ReturnType<typeof Bun.serve> | null = null;
let lastProbeMaxTokens: number | null = null;

function startProvider(opts: { models?: string[]; chatContent?: string; modelsStatus?: number } = {}): string {
  server?.stop(true);
  const models = opts.models ?? ['test-model'];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/models') {
        return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
          status: opts.modelsStatus ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/chat/completions') {
        const body = await req.json() as { max_tokens?: number };
        lastProbeMaxTokens = body.max_tokens ?? null;
        return new Response(JSON.stringify({
          choices: [{ message: { content: opts.chatContent ?? 'ok' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return String(server.url).replace(/\/$/, '');
}

afterEach(() => {
  server?.stop(true);
  server = null;
  lastProbeMaxTokens = null;
  db.prepare("DELETE FROM settings WHERE key = 'provider_credentials_custom'").run();
});

describe('performProviderPreflight', () => {
  test('passes only after credential validation, model listing and completion probe succeed', async () => {
    const baseUrl = startProvider({ models: ['test-model'] });
    saveProviderCredentials('custom', { baseUrl, model: 'test-model' });

    const result = await performProviderPreflight('custom', 'test-model');

    expect(result.status).toBe('passed');
    expect(result.evidence.provider_reachable).toBe('verified');
    expect(result.evidence.authentication).toBe('verified');
    expect(result.evidence.model_exists).toBe(true);
    expect(result.evidence.model_enabled).toBe(true);
    expect(result.evidence.placeholder_response).toBe('verified');
    expect(lastProbeMaxTokens).toBe(128);
  });

  test('blocks when the selected model is absent from provider model listing', async () => {
    const baseUrl = startProvider({ models: ['other-model'] });
    saveProviderCredentials('custom', { baseUrl, model: 'absent-model' });

    const result = await performProviderPreflight('custom', 'absent-model');

    expect(result.status).toBe('blocked');
    expect(result.temporary).toBe(false);
    expect(result.evidence.model_exists).toBe(false);
    expect(String(result.evidence.diagnostic)).toContain('was not returned');
  });

  test('fails when the provider responds with placeholder output', async () => {
    const baseUrl = startProvider({ models: ['test-model'], chatContent: 'mock placeholder response' });
    saveProviderCredentials('custom', { baseUrl, model: 'test-model' });

    const result = await performProviderPreflight('custom', 'test-model');

    expect(result.status).toBe('failed');
    expect(result.evidence.placeholder_response).toBe('failed');
    expect(String(result.evidence.diagnostic)).toContain('placeholder');
  });
});