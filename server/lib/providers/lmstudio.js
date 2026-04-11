// LM Studio uses an OpenAI-compatible REST API
const DEFAULT_BASE_URL = 'http://localhost:1234/v1';

export function estimateCost() {
  return 0; // Local model — no API cost
}

async function openAICompatibleComplete({ baseUrl, apiKey, model, messages, system, temperature = 0.7, max_tokens = 4096 }) {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const allMessages = [];
  if (system) allMessages.push({ role: 'system', content: system });
  allMessages.push(...messages);

  const headers = { 'Content-Type': 'application/json' };
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

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

export async function complete(opts) {
  return openAICompatibleComplete({ ...opts, baseUrl: opts.baseUrl || DEFAULT_BASE_URL });
}

export async function listModels({ baseUrl, apiKey } = {}) {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const response = await fetch(`${base}/models`, { headers });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.data ?? []).map(m => m.id);
  } catch {
    return [];
  }
}

export async function validateApiKey({ baseUrl, apiKey } = {}) {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const response = await fetch(`${base}/models`, { headers });
    return response.ok;
  } catch {
    return false;
  }
}
