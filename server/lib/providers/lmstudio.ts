// LM Studio uses an OpenAI-compatible REST API
import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';

export function estimateCost(): number {
  return 0; // Local model — no API cost
}

async function openAICompatibleComplete({ baseUrl, apiKey, model, messages, system, temperature = 0.7, max_tokens = 4096 }: CompleteOptions): Promise<CompleteResult> {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const allMessages: Array<{ role: string; content: string }> = [];
  if (system) allMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    allMessages.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join(''),
    });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'local-model',
      messages: allMessages,
      max_tokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LM Studio error ${response.status}: ${err}`);
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

export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  return openAICompatibleComplete({ ...opts, baseUrl: opts.baseUrl || DEFAULT_BASE_URL });
}

export async function listModels({ baseUrl, apiKey }: ProviderCredentials = {}): Promise<string[]> {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const response = await fetch(`${base}/models`, { headers });
    if (!response.ok) return [];
    const data = await response.json() as { data?: Array<{ id: string }> };
    return (data.data ?? []).map(m => m.id);
  } catch {
    return [];
  }
}

export async function validateApiKey({ baseUrl, apiKey }: ProviderCredentials = {}): Promise<boolean> {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const response = await fetch(`${base}/models`, { headers });
    return response.ok;
  } catch {
    return false;
  }
}
