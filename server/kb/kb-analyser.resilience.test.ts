import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import db from '../db/db.js';

type FakeFile = { path: string };

const llmCalls: string[] = [];
let outcomes: Array<unknown> = [];
let releaseCurrent: (() => void) | null = null;
const originalFetch = globalThis.fetch;

function installFetchMock() {
  globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = String(init?.body ?? '');
    llmCalls.push(body);
    const next = outcomes.shift();
    if (next === 'hold') {
      await new Promise<void>((resolve) => { releaseCurrent = resolve; });
    }
    if (next instanceof Error) {
      const status = (next as { status?: number }).status ?? 500;
      const headers: Record<string, string> = {};
      const retryAfterMs = (next as { retryAfterMs?: number }).retryAfterMs;
      if (retryAfterMs) headers['retry-after'] = String(Math.ceil(retryAfterMs / 1000));
      return new Response('provider body should not matter', { status, headers });
    }
    return new Response(JSON.stringify(next ?? {
      candidates: [{ content: { parts: [{ text: JSON.stringify({ signals: [], tasks: [], connector_gaps: [], contradictions: [], compounding_insights: [] }) }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

/*
 * Keep this helper for constructing test outcomes. The analyser uses the real
 * LLM registry and Google adapter; the fake fetch converts these outcomes into
 * HTTP responses so module mocks do not leak into unrelated provider tests.
 */
function successResponse() {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ signals: [], tasks: [], connector_gaps: [], contradictions: [], compounding_insights: [] }) }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
}

const engines = new Map<string, FakeKBEngine>();

class FakeKBEngine {
  constructor(readonly businessId: string) {}
  async getRecentlyModified(): Promise<FakeFile[]> {
    return [{ path: 'notes/a.md' }, { path: 'notes/b.md' }];
  }
  async readFile(path: string) {
    return { content: `content for ${path}`, frontmatter: { tags: ['test'] } };
  }
  async writeFile() {
    return { path: 'research/out.md' };
  }
  async appendLog() {}
}

mock.module('./kb-config.js', () => ({
  getKBForBusiness: mock(async (businessId: string) => ({
    engine: engines.get(businessId) ?? new FakeKBEngine(businessId),
    business: { id: businessId, name: `Business ${businessId}`, slug: businessId },
    config: {},
  })),
}));

mock.module('../signals/signal-helpers.js', () => ({
  createSignalIfNotDuplicate: mock(() => null),
}));

mock.module('../lib/connector-gap-handler.js', () => ({
  surfaceConnectorGap: mock(async () => null),
}));

mock.module('../lib/intelligence-events.js', () => ({
  logIntelligenceEvent: mock(() => undefined),
}));

mock.module('../tasks/task-queue.js', () => ({
  createTask: mock(() => null),
}));

function providerError(status: number, retryAfterMs?: number): Error {
  const err = new Error(`provider google http_${status} ${status === 429 || status === 503 ? 'retryable' : 'non_retryable'}`);
  Object.assign(err, {
    provider: 'google',
    status,
    retryable: status === 429 || status === 503,
    retryAfterMs,
  });
  return err;
}

beforeEach(() => {
  llmCalls.length = 0;
  outcomes = [];
  releaseCurrent = null;
  engines.clear();
  installFetchMock();
  db.prepare("DELETE FROM settings WHERE key IN ('llm_default_provider','llm_default_model','provider_credentials_google')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_provider', ?)").run(JSON.stringify({ provider: 'google' }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_default_model', ?)").run(JSON.stringify('gemini-3.5-flash-lite'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('provider_credentials_google', ?)").run(JSON.stringify({ apiKey: 'AIzaSyKB_TEST_ONLY' }));
  for (const id of ['biz_a', 'biz_b', 'biz_c']) {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, `Business ${id}`, id);
    engines.set(id, new FakeKBEngine(id));
  }
});

afterEach(() => {
  releaseCurrent?.();
  globalThis.fetch = originalFetch;
  db.prepare("DELETE FROM settings WHERE key IN ('llm_default_provider','llm_default_model','provider_credentials_google')").run();
  db.prepare("DELETE FROM businesses WHERE id IN ('biz_a','biz_b','biz_c')").run();
});

describe('KB analyser resilience', () => {
  test('retryable 429 and 503 failures use bounded attempts and then report honest failure', async () => {
    outcomes = [providerError(429), providerError(503), providerError(429)];
    const { analyseKBForSignals, resetKBAnalysisStateForTests } = await import('./kb-analyser.js');
    resetKBAnalysisStateForTests();

    const result = await analyseKBForSignals('biz_a', { force: true });

    expect(llmCalls).toHaveLength(3);
    expect(result?.errors).toHaveLength(1);
    expect(result?.errors[0]).toContain('provider google http_429 retryable');
    expect(result?.skipped).toBeUndefined();
  });

  test('non-retryable failures fail once', async () => {
    outcomes = [providerError(400)];
    const { analyseKBForSignals, resetKBAnalysisStateForTests } = await import('./kb-analyser.js');
    resetKBAnalysisStateForTests();

    const result = await analyseKBForSignals('biz_a', { force: true });

    expect(llmCalls).toHaveLength(1);
    expect(result?.errors[0]).toContain('provider google http_400 non_retryable');
  });

  test('overlapping calls for the same business coalesce onto the in-flight analysis', async () => {
    outcomes = ['hold'];
    const { analyseKBForSignals, resetKBAnalysisStateForTests } = await import('./kb-analyser.js');
    resetKBAnalysisStateForTests();

    const first = analyseKBForSignals('biz_a', { force: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = analyseKBForSignals('biz_a', { force: true });

    expect(llmCalls).toHaveLength(1);
    releaseCurrent?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(llmCalls).toHaveLength(1);
  });

  test('all-business runner sequences businesses and recovers after one business fails', async () => {
    outcomes = [
      providerError(400),
      successResponse(),
      successResponse(),
    ];
    const { analyseKBForAllBusinesses, resetKBAnalysisStateForTests } = await import('./kb-analyser.js');
    resetKBAnalysisStateForTests();

    const results = await analyseKBForAllBusinesses(['biz_a', 'biz_b', 'biz_c'], { force: true });

    expect(llmCalls).toHaveLength(3);
    expect(results.map((r) => r.businessId)).toEqual(['biz_a', 'biz_b', 'biz_c']);
    expect(results[0]?.result?.errors).toHaveLength(1);
    expect(results[1]?.result?.errors).toEqual([]);
    expect(results[2]?.result?.errors).toEqual([]);
  });
});
