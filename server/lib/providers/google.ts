import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';
import { ProviderHttpError } from '../provider-errors.js';

const DEFAULT_API_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const KNOWN_MODELS: string[] = [
  // Gemini 3.x — GA (newest first)
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
];

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    'gemini-3.6-flash':      { input: 0.1,   output: 0.4  },
    'gemini-3.5-flash':      { input: 0.075, output: 0.3  },
    'gemini-3.5-flash-lite': { input: 0.019, output: 0.075 },
    'gemini-3.1-flash-lite': { input: 0.019, output: 0.075 },
    'gemini-3.1-pro-preview':{ input: 1.25,  output: 10.0 },
  };
  const p = pricing[model] ?? { input: 1.0, output: 4.0 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function complete({ apiKey, baseUrl, model, messages, system, temperature = 0.7, max_tokens = 4096 }: CompleteOptions): Promise<CompleteResult> {
  const root = baseUrl || DEFAULT_API_URL;
  const modelId = model || 'gemini-3.5-flash';
  const url = `${root}/models/${modelId}:generateContent?key=${apiKey}`;

  // Convert Anthropic-style messages to Gemini format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('') }],
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: max_tokens,
    },
  };
  if (system) {
    body['systemInstruction'] = { parts: [{ text: system }] };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await response.text().catch(() => '');
    const retryAfterSec = Number(response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.min(retryAfterSec, 60) * 1000
      : undefined;
    throw new ProviderHttpError('google', response.status, response.status === 429 || response.status === 503 || response.status >= 500, retryAfterMs);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';

  return {
    content: text,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

export async function listModels({ apiKey, baseUrl }: ProviderCredentials = {}): Promise<string[]> {
  const root = baseUrl || DEFAULT_API_URL;
  try {
    const response = await fetch(`${root}/models?key=${apiKey}`);
    if (!response.ok) return KNOWN_MODELS;
    const data = await response.json() as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => (m.name ?? '').replace('models/', ''))
      .sort();
  } catch {
    return KNOWN_MODELS;
  }
}

export async function validateApiKey({ apiKey, baseUrl }: ProviderCredentials = {}): Promise<boolean> {
  const root = baseUrl || DEFAULT_API_URL;
  try {
    const response = await fetch(`${root}/models?key=${apiKey}`);
    return response.ok;
  } catch {
    return false;
  }
}
