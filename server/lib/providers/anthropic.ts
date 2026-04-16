import Anthropic from '@anthropic-ai/sdk';
import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';

export const KNOWN_MODELS: string[] = [
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
];

// Per-million-token pricing (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-20250514':     { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514':   { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5-20251001':  { input: 0.8,  output: 4.0  },
  'claude-3-5-sonnet-20241022': { input: 3.0,  output: 15.0 },
  'claude-3-5-haiku-20241022':  { input: 0.8,  output: 4.0  },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 3.0, output: 15.0 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function complete({ apiKey, model, messages, system, temperature = 0.7, max_tokens = 4096 }: CompleteOptions): Promise<CompleteResult> {
  const client = new Anthropic({ apiKey });

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: model || 'claude-sonnet-4-20250514',
    max_tokens,
    messages: messages as Anthropic.MessageParam[],
  };
  if (system) params.system = system;
  if (temperature !== undefined) params.temperature = temperature;

  const response = await client.messages.create(params);

  return {
    content: response.content[0]?.type === 'text' ? response.content[0].text : '',
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

export async function listModels(_creds?: ProviderCredentials): Promise<string[]> {
  return KNOWN_MODELS;
}

export async function validateApiKey({ apiKey }: ProviderCredentials = {}): Promise<boolean> {
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return true;
  } catch {
    return false;
  }
}
