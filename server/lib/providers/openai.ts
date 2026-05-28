import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';

const DEFAULT_API_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 60_000;

export const KNOWN_MODELS: string[] = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1-preview',
  'o1-mini',
];

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    'gpt-4o':        { input: 5.0,  output: 15.0 },
    'gpt-4o-mini':   { input: 0.15, output: 0.6  },
    'gpt-4-turbo':   { input: 10.0, output: 30.0 },
    'gpt-4':         { input: 30.0, output: 60.0 },
    'gpt-3.5-turbo': { input: 0.5,  output: 1.5  },
  };
  const p = pricing[model] ?? { input: 5.0, output: 15.0 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// All three call sites accept a baseUrl override so OpenAI-compatible
// providers (MiniMax, Kimi, custom) can reuse this adapter without
// duplicating the fetch/parse logic.
export async function complete({ apiKey, baseUrl, model, messages, system, temperature = 0.7, max_tokens = 8192 }: CompleteOptions): Promise<CompleteResult> {
  const root = baseUrl || DEFAULT_API_URL;
  const allMessages: Array<{ role: string; content: string }> = [];
  if (system) allMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    allMessages.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join(''),
    });
  }

  const response = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      messages: allMessages,
      max_tokens,
      temperature,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(err => {
    if (err.name === 'TimeoutError') {
      throw new Error(`OpenAI API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Check network and provider status.`);
    }
    throw err;
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI-compatible API error ${response.status}: ${err.substring(0, 300)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

export async function listModels({ apiKey, baseUrl }: ProviderCredentials = {}): Promise<string[]> {
  const root = baseUrl || DEFAULT_API_URL;
  try {
    const response = await fetch(`${root}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return KNOWN_MODELS;
    const data = await response.json() as { data?: Array<{ id: string }> };
    return (data.data ?? []).map(m => m.id).sort();
  } catch {
    return KNOWN_MODELS;
  }
}

export async function validateApiKey({ apiKey, baseUrl, ...rest }: ProviderCredentials & { validationModel?: string } = {}): Promise<boolean> {
  const root = baseUrl || DEFAULT_API_URL;
  try {
    const modelsRes = await fetch(`${root}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (modelsRes.ok) return true;

    // Fall back: some OpenAI-compatible providers (e.g. MiniMax) lock down
    // /models behind a different scope or auth header but accept chat
    // completions on the same key. Try a single-token chat as a probe.
    const validationModel = (rest as { validationModel?: string }).validationModel;
    if (!validationModel) return false;
    const chatRes = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: validationModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return chatRes.ok;
  } catch {
    return false;
  }
}
