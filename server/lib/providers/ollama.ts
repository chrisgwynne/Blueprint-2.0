import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

export function estimateCost(): number {
  return 0; // Local model — no API cost
}

export async function complete({ baseUrl, model, messages, system, temperature = 0.7, max_tokens = 4096 }: CompleteOptions): Promise<CompleteResult> {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const allMessages: Array<{ role: string; content: string }> = [];
  if (system) allMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    allMessages.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join(''),
    });
  }

  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'llama3.2',
      messages: allMessages,
      stream: false,
      options: {
        temperature,
        num_predict: max_tokens,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  return {
    content: data.message?.content ?? '',
    usage: {
      input_tokens: data.prompt_eval_count ?? 0,
      output_tokens: data.eval_count ?? 0,
    },
  };
}

export async function listModels({ baseUrl }: ProviderCredentials = {}): Promise<string[]> {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const response = await fetch(`${base}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).map(m => m.name);
  } catch {
    return [];
  }
}

export async function validateApiKey({ baseUrl }: ProviderCredentials = {}): Promise<boolean> {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const response = await fetch(`${base}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}
