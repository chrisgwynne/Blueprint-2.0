// Generic OpenAI-compatible provider — user-supplied base URL
import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';

export function estimateCost(): number {
  return 0;
}

export async function complete({ baseUrl, apiKey, model, messages, system, temperature = 0.7, max_tokens = 4096 }: CompleteOptions): Promise<CompleteResult> {
  if (!baseUrl) throw new Error('Custom provider requires a baseUrl.');
  const base = baseUrl.replace(/\/$/, '');
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
      model: model || 'default',
      messages: allMessages,
      max_tokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Custom provider error ${response.status}: ${err}`);
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

export async function listModels({ baseUrl, apiKey }: ProviderCredentials = {}): Promise<string[]> {
  if (!baseUrl) return [];
  try {
    const base = baseUrl.replace(/\/$/, '');
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
  if (!baseUrl) return false;
  try {
    const base = baseUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const response = await fetch(`${base}/models`, { headers });
    return response.ok;
  } catch {
    return false;
  }
}
