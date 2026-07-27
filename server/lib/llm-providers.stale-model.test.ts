/**
 * Regression coverage for issue #26: conductor/agent runs failed against
 * retired or malformed Gemini model names (`gemini-2.5-pro`, no longer
 * available; `g`, a malformed/truncated config value) with a raw provider
 * 404 on every single run, repeatedly, until a human noticed and fixed
 * Settings. resolveProfileLLM() now validates the resolved model against
 * each catalogued provider's current KNOWN_MODELS list and falls back to
 * a current default instead of blindly calling the API with a stale
 * config value.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import { resolveProfileLLM } from './llm-providers.js';

beforeAll(() => {
  process.env['GOOGLE_API_KEY'] = 'test-key';
  process.env['ANTHROPIC_API_KEY'] = 'test-key';
});

afterEach(() => {
  delete process.env['OLLAMA_API_KEY'];
});

describe('resolveProfileLLM — stale/malformed model fallback (issue #26)', () => {
  test('a retired Google model falls back to the current default, not a raw provider 404', () => {
    const resolved = resolveProfileLLM({ provider: 'google', model: 'gemini-2.5-pro' });
    expect(resolved.providerId).toBe('google');
    expect(resolved.model).not.toBe('gemini-2.5-pro');
    expect(resolved.model).toBe('gemini-3.6-flash'); // KNOWN_MODELS[0] — current default
  });

  test('a malformed/truncated model value falls back the same way', () => {
    const resolved = resolveProfileLLM({ provider: 'google', model: 'g' });
    expect(resolved.model).toBe('gemini-3.6-flash');
  });

  test('a current, known model passes through unchanged', () => {
    const resolved = resolveProfileLLM({ provider: 'google', model: 'gemini-3.5-flash' });
    expect(resolved.model).toBe('gemini-3.5-flash');
  });

  test('an unrecognised Anthropic model also falls back (catalogued provider, not just Google)', () => {
    const resolved = resolveProfileLLM({ provider: 'anthropic', model: 'claude-1-ancient' });
    expect(resolved.model).not.toBe('claude-1-ancient');
  });

  test('a local/BYO provider (ollama) is never overridden — no catalog to validate against', () => {
    const resolved = resolveProfileLLM({ provider: 'ollama', model: 'my-custom-local-model' });
    expect(resolved.model).toBe('my-custom-local-model');
  });
});
