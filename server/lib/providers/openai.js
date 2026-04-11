const API_URL = 'https://api.openai.com/v1';

export const KNOWN_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1-preview',
  'o1-mini',
];

export function estimateCost(model, inputTokens, outputTokens) {
  const pricing = {
    'gpt-4o':       { input: 5.0,  output: 15.0 },
    'gpt-4o-mini':  { input: 0.15, output: 0.6  },
    'gpt-4-turbo':  { input: 10.0, output: 30.0 },
    'gpt-4':        { input: 30.0, output: 60.0 },
    'gpt-3.5-turbo':{ input: 0.5,  output: 1.5  },
  };
  const p = pricing[model] ?? { input: 5.0, output: 15.0 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function complete({ apiKey, model, messages, system, temperature = 0.7, max_tokens = 4096 }) {
  const allMessages = [];
  if (system) allMessages.push({ role: 'system', content: system });
  allMessages.push(...messages);

  const response = await fetch(`${API_URL}/chat/completions`, {
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
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

export async function listModels({ apiKey }) {
  try {
    const response = await fetch(`${API_URL}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!response.ok) return KNOWN_MODELS;
    const data = await response.json();
    return (data.data ?? [])
      .filter(m => /^(gpt|o1|o3)/.test(m.id))
      .map(m => m.id)
      .sort();
  } catch {
    return KNOWN_MODELS;
  }
}

export async function validateApiKey({ apiKey }) {
  try {
    const response = await fetch(`${API_URL}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}
