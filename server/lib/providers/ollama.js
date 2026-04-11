const DEFAULT_BASE_URL = 'http://localhost:11434';

export function estimateCost() {
  return 0; // Local model — no API cost
}

export async function complete({ baseUrl, model, messages, system, temperature = 0.7, max_tokens = 4096 }) {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const allMessages = [];
  if (system) allMessages.push({ role: 'system', content: system });
  allMessages.push(...messages);

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

  const data = await response.json();
  return {
    content: data.message?.content ?? '',
    usage: {
      input_tokens: data.prompt_eval_count ?? 0,
      output_tokens: data.eval_count ?? 0,
    },
  };
}

export async function listModels({ baseUrl } = {}) {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const response = await fetch(`${base}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models ?? []).map(m => m.name);
  } catch {
    return [];
  }
}

export async function validateApiKey({ baseUrl } = {}) {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const response = await fetch(`${base}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}
