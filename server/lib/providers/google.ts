import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';

const DEFAULT_API_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const KNOWN_MODELS: string[] = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-pro-latest',
  'gemini-1.5-flash-latest',
];

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    'gemini-1.5-pro-latest':   { input: 3.5,   output: 10.5 },
    'gemini-1.5-flash-latest': { input: 0.075, output: 0.3  },
    'gemini-2.0-flash':        { input: 0.1,   output: 0.4  },
    'gemini-2.0-flash-lite':   { input: 0.075, output: 0.3  },
  };
  const p = pricing[model] ?? { input: 1.0, output: 4.0 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function complete({ apiKey, baseUrl, model, messages, system, temperature = 0.7, max_tokens = 4096 }: CompleteOptions): Promise<CompleteResult> {
  const root = baseUrl || DEFAULT_API_URL;
  const modelId = model || 'gemini-1.5-flash-latest';
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
    const err = await response.text();
    throw new Error(`Google API error ${response.status}: ${err.substring(0, 300)}`);
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
