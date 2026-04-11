const API_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const KNOWN_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-pro-latest',
  'gemini-1.5-flash-latest',
];

export function estimateCost(model, inputTokens, outputTokens) {
  // Gemini pricing (approximate)
  const pricing = {
    'gemini-1.5-pro-latest':  { input: 3.5, output: 10.5 },
    'gemini-1.5-flash-latest':{ input: 0.075, output: 0.3 },
    'gemini-2.0-flash':       { input: 0.1, output: 0.4   },
    'gemini-2.0-flash-lite':  { input: 0.075, output: 0.3 },
  };
  const p = pricing[model] ?? { input: 1.0, output: 4.0 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function complete({ apiKey, model, messages, system, temperature = 0.7, max_tokens = 4096 }) {
  const modelId = model || 'gemini-1.5-flash-latest';
  const url = `${API_URL}/models/${modelId}:generateContent?key=${apiKey}`;

  // Convert Anthropic-style messages to Gemini format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: max_tokens,
    },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';

  return {
    content: text,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

export async function listModels({ apiKey }) {
  try {
    const response = await fetch(`${API_URL}/models?key=${apiKey}`);
    if (!response.ok) return KNOWN_MODELS;
    const data = await response.json();
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .sort();
  } catch {
    return KNOWN_MODELS;
  }
}

export async function validateApiKey({ apiKey }) {
  try {
    const response = await fetch(`${API_URL}/models?key=${apiKey}`);
    return response.ok;
  } catch {
    return false;
  }
}
