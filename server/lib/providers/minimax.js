/**
 * MiniMax adapter.
 *
 * MiniMax exposes an OpenAI-compatible Chat Completions API at
 *   https://api.minimaxi.chat/v1
 * so we just thin-wrap the OpenAI adapter with that base URL.
 */
import * as openai from './openai.js';

const MINIMAX_BASE = 'https://api.minimaxi.chat/v1';

export const KNOWN_MODELS = [
  'MiniMax-M2',
  'MiniMax-M1',
  'abab7-chat-preview',
  'abab6.5s-chat',
  'abab6.5g-chat',
  'abab6.5t-chat',
];

// MiniMax pricing per million tokens (USD-ish). Exact values change; these
// are sane defaults so cost tracking isn't zero.
const PRICING = {
  'MiniMax-M2':            { input: 0.30, output: 1.20 },
  'MiniMax-M1':            { input: 0.40, output: 2.20 },
  'abab7-chat-preview':    { input: 1.20, output: 4.80 },
  'abab6.5s-chat':         { input: 0.20, output: 0.20 },
  'abab6.5g-chat':         { input: 0.30, output: 0.60 },
  'abab6.5t-chat':         { input: 0.10, output: 0.10 },
};

export function estimateCost(model, inputTokens, outputTokens) {
  const p = PRICING[model] ?? { input: 0.30, output: 1.20 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function complete(opts) {
  return openai.complete({
    ...opts,
    baseUrl: opts.baseUrl || MINIMAX_BASE,
    model: opts.model || 'MiniMax-M2',
  });
}

export async function listModels(creds) {
  try {
    return await openai.listModels({ ...creds, baseUrl: creds?.baseUrl || MINIMAX_BASE });
  } catch {
    return KNOWN_MODELS;
  }
}

export async function validateApiKey(creds) {
  return openai.validateApiKey({ ...creds, baseUrl: creds?.baseUrl || MINIMAX_BASE });
}
