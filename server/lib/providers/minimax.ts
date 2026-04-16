/**
 * MiniMax adapter.
 *
 * MiniMax ships two separate API gateways:
 *   - International (token plan, USD billing)   → https://api.minimax.io/v1
 *   - Mainland China (CNY billing)              → https://api.minimaxi.chat/v1
 *
 * They are NOT cross-compatible — a key from one is rejected by the other.
 * Default to the international endpoint because that's what most users who
 * set it up via the Settings UI are on; override with baseUrl if you're
 * on the mainland plan.
 *
 * The API is OpenAI chat-completions compatible, so we thin-wrap the
 * OpenAI adapter.
 */
import * as openai from './openai.js';
import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';

// International endpoint (token plan). User can override via baseUrl if on
// the mainland plan (api.minimaxi.chat).
const MINIMAX_BASE = 'https://api.minimax.io/v1';

export const KNOWN_MODELS: string[] = [
  'MiniMax-M2',
  'MiniMax-M1',
  'MiniMax-Text-01',
  'abab7-chat-preview',
  'abab6.5s-chat',
  'abab6.5g-chat',
  'abab6.5t-chat',
];

// Approximate pricing per million tokens. MiniMax's public rate card
// changes; these are sane defaults so cost tracking isn't zero.
const PRICING: Record<string, { input: number; output: number }> = {
  'MiniMax-M2':         { input: 0.30, output: 1.20 },
  'MiniMax-M1':         { input: 0.40, output: 2.20 },
  'MiniMax-Text-01':    { input: 0.20, output: 1.10 },
  'abab7-chat-preview': { input: 1.20, output: 4.80 },
  'abab6.5s-chat':      { input: 0.20, output: 0.20 },
  'abab6.5g-chat':      { input: 0.30, output: 0.60 },
  'abab6.5t-chat':      { input: 0.10, output: 0.10 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 0.30, output: 1.20 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  return openai.complete({
    ...opts,
    baseUrl: opts.baseUrl || MINIMAX_BASE,
    model: opts.model || 'MiniMax-M2',
  });
}

export async function listModels(creds?: ProviderCredentials): Promise<string[]> {
  try {
    return await openai.listModels({ ...creds, baseUrl: creds?.baseUrl || MINIMAX_BASE });
  } catch {
    return KNOWN_MODELS;
  }
}

export async function validateApiKey(creds?: ProviderCredentials): Promise<boolean> {
  // MiniMax's /models endpoint returns 401 for valid keys on some plan
  // tiers, so validation falls back to a single-token chat completion.
  // MiniMax-M2 is their flagship and accepts both endpoints.
  return openai.validateApiKey({
    ...creds,
    baseUrl: creds?.baseUrl || MINIMAX_BASE,
    validationModel: 'MiniMax-M2',
  } as ProviderCredentials & { validationModel?: string });
}
