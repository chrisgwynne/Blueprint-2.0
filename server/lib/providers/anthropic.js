import Anthropic from '@anthropic-ai/sdk';

export const KNOWN_MODELS = [
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
];

// Per-million-token pricing (USD)
const PRICING = {
  'claude-opus-4-20250514':       { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514':     { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5-20251001':    { input: 0.8,  output: 4.0  },
  'claude-3-5-sonnet-20241022':   { input: 3.0,  output: 15.0 },
  'claude-3-5-haiku-20241022':    { input: 0.8,  output: 4.0  },
};

export function estimateCost(model, inputTokens, outputTokens) {
  const p = PRICING[model] ?? { input: 3.0, output: 15.0 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function complete({ apiKey, model, messages, system, temperature = 0.7, max_tokens = 4096 }) {
  const client = new Anthropic({ apiKey });

  const params = {
    model: model || 'claude-sonnet-4-20250514',
    max_tokens,
    messages,
  };
  if (system) params.system = system;
  if (temperature !== undefined) params.temperature = temperature;

  const response = await client.messages.create(params);

  return {
    content: response.content[0]?.text ?? '',
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

export async function listModels() {
  return KNOWN_MODELS;
}

export async function validateApiKey({ apiKey }) {
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
