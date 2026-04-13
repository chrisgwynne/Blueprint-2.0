/**
 * LLM Provider Registry
 *
 * Manages multiple LLM backends (Anthropic, OpenAI, Google, Ollama, LM Studio, Custom).
 * Credentials are stored in the settings table under key `provider_credentials_{id}`.
 */

import db from '../db/db.js';
import * as anthropicProvider from './providers/anthropic.js';
import * as openaiProvider from './providers/openai.js';
import * as googleProvider from './providers/google.js';
import * as ollamaProvider from './providers/ollama.js';
import * as lmstudioProvider from './providers/lmstudio.js';
import * as customProvider from './providers/custom.js';
import * as claudeCliProvider from './providers/claude-cli.js';

// ─── Provider Catalog ─────────────────────────────────────────────────────────

export const PROVIDERS_CATALOG = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models — Opus, Sonnet, Haiku',
    requires_key: true,
    requires_base_url: false,
    default_models: anthropicProvider.KNOWN_MODELS,
    adapter: anthropicProvider,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-4o, GPT-4o-mini, o1, and others',
    requires_key: true,
    requires_base_url: false,
    default_models: openaiProvider.KNOWN_MODELS,
    adapter: openaiProvider,
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    description: 'Gemini 2.0 Flash, 1.5 Pro, and others',
    requires_key: true,
    requires_base_url: false,
    default_models: googleProvider.KNOWN_MODELS,
    adapter: googleProvider,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Run any model locally via Ollama',
    requires_key: false,
    requires_base_url: false,
    base_url_label: 'Ollama URL (default: http://localhost:11434)',
    default_models: [],
    adapter: ollamaProvider,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    description: 'Run models locally via LM Studio',
    requires_key: false,
    requires_base_url: false,
    base_url_label: 'LM Studio URL (default: http://localhost:1234/v1)',
    default_models: [],
    adapter: lmstudioProvider,
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    description: 'Any OpenAI-compatible API endpoint',
    requires_key: false,
    requires_base_url: true,
    base_url_label: 'API Base URL',
    default_models: [],
    adapter: customProvider,
  },
  {
    id: 'claude-cli',
    name: 'Claude CLI (Claude Code)',
    description: 'Use the locally installed Claude Code CLI — no API key needed',
    requires_key: false,
    requires_base_url: false,
    default_models: claudeCliProvider.KNOWN_MODELS,
    adapter: claudeCliProvider,
  },
];

const PROVIDER_MAP = Object.fromEntries(PROVIDERS_CATALOG.map(p => [p.id, p]));

// ─── Credentials ──────────────────────────────────────────────────────────────

export function getProviderCredentials(providerId) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(`provider_credentials_${providerId}`);
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

export function saveProviderCredentials(providerId, credentials) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(`provider_credentials_${providerId}`, JSON.stringify(credentials));
}

// ─── Core runLLM function ─────────────────────────────────────────────────────

/**
 * Run an LLM completion against any provider.
 *
 * @param {string} providerId - 'anthropic' | 'openai' | 'google' | 'ollama' | 'lmstudio' | 'custom'
 * @param {string} model - model identifier
 * @param {{ messages, system, temperature, max_tokens }} opts
 * @returns {Promise<{ content: string, usage: { input_tokens, output_tokens }, cost_usd: number }>}
 */
export async function runLLM(providerId, model, { messages, system, temperature, max_tokens }) {
  const entry = PROVIDER_MAP[providerId];
  if (!entry) throw new Error(`Unknown LLM provider: ${providerId}`);

  const creds = getProviderCredentials(providerId);

  const result = await entry.adapter.complete({
    ...creds,
    model,
    messages,
    system,
    temperature,
    max_tokens,
  });

  // Use provider-reported cost if available (claude-cli reports actual cost), else estimate
  const costUsd = result.cost_usd != null
    ? result.cost_usd
    : (entry.adapter.estimateCost
        ? entry.adapter.estimateCost(model, result.usage.input_tokens, result.usage.output_tokens)
        : 0);

  return { ...result, cost_usd: costUsd };
}

// ─── Model listing ────────────────────────────────────────────────────────────

export async function listModels(providerId) {
  const entry = PROVIDER_MAP[providerId];
  if (!entry) throw new Error(`Unknown provider: ${providerId}`);
  const creds = getProviderCredentials(providerId);
  try {
    return await entry.adapter.listModels(creds);
  } catch {
    return entry.default_models;
  }
}

// ─── Provider status (are credentials configured?) ───────────────────────────

export function listProviders() {
  return PROVIDERS_CATALOG.map(p => {
    const creds = getProviderCredentials(p.id);
    const configured = p.id === 'anthropic'
      ? !!(creds?.apiKey || process.env.ANTHROPIC_API_KEY)
      : p.id === 'ollama' || p.id === 'lmstudio' || p.id === 'claude-cli'
        ? true // local, always potentially available
        : !!(creds?.apiKey || creds?.baseUrl);

    return {
      id: p.id,
      name: p.name,
      description: p.description,
      requires_key: p.requires_key,
      requires_base_url: p.requires_base_url,
      base_url_label: p.base_url_label ?? null,
      default_models: p.default_models,
      configured,
    };
  });
}

// ─── Resolve provider + model from profile ────────────────────────────────────

/**
 * Returns true if the given provider has usable credentials (either in DB or
 * environment, or is a keyless local provider like ollama/claude-cli).
 */
function isProviderConfigured(providerId) {
  if (providerId === 'ollama' || providerId === 'lmstudio' || providerId === 'claude-cli') {
    return true; // local / CLI — no key required
  }
  const creds = getProviderCredentials(providerId);
  if (creds?.apiKey || creds?.baseUrl) return true;
  if (providerId === 'anthropic' && process.env.ANTHROPIC_API_KEY) return true;
  if (providerId === 'openai' && process.env.OPENAI_API_KEY) return true;
  if (providerId === 'google' && process.env.GOOGLE_API_KEY) return true;
  return false;
}

/**
 * Pick a provider that IS configured. Honours 'llm_default_provider' setting
 * first, then falls back to the first provider with credentials. Never returns
 * 'anthropic' unless it actually has a key.
 */
function pickConfiguredProvider() {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'llm_default_provider'").get();
  if (stored?.value) {
    try {
      const { provider } = JSON.parse(stored.value);
      if (provider && isProviderConfigured(provider)) return provider;
    } catch {}
  }
  if (process.env.LLM_DEFAULT_PROVIDER && isProviderConfigured(process.env.LLM_DEFAULT_PROVIDER)) {
    return process.env.LLM_DEFAULT_PROVIDER;
  }
  for (const p of PROVIDERS_CATALOG) {
    if (isProviderConfigured(p.id)) return p.id;
  }
  return null;
}

const DEFAULT_MODEL_BY_PROVIDER = {
  anthropic: 'claude-sonnet-4-20250514',
  'claude-cli': 'claude-sonnet-4-20250514',
  openai: 'gpt-4o-mini',
  google: 'gemini-1.5-flash',
  ollama: 'llama3',
  lmstudio: 'local-model',
  custom: 'custom',
};

/**
 * Given a profile's llm config, return { providerId, model, temperature, max_tokens }.
 * Falls back to ANY configured provider if the requested one has no credentials.
 */
export function resolveProfileLLM(profileLLM) {
  let providerId = profileLLM?.provider ?? 'anthropic';
  let model = profileLLM?.model ?? DEFAULT_MODEL_BY_PROVIDER[providerId] ?? 'claude-sonnet-4-20250514';
  const temperature = profileLLM?.temperature ?? 0.7;
  const max_tokens = profileLLM?.max_tokens ?? 4096;

  // Inject ANTHROPIC_API_KEY from env into DB if anthropic was requested
  if (providerId === 'anthropic') {
    const creds = getProviderCredentials('anthropic');
    if (!creds?.apiKey && process.env.ANTHROPIC_API_KEY) {
      saveProviderCredentials('anthropic', { apiKey: process.env.ANTHROPIC_API_KEY });
    }
  }

  // If the requested provider is not configured, fall back to one that is.
  if (!isProviderConfigured(providerId)) {
    const fallback = pickConfiguredProvider();
    if (fallback && fallback !== providerId) {
      console.warn(`[llm] Requested provider '${providerId}' has no credentials — falling back to '${fallback}'.`);
      providerId = fallback;
      // If the caller pinned a model that only makes sense for the original
      // provider, swap to a sensible default for the fallback provider.
      if (!profileLLM?.model || profileLLM.provider !== providerId) {
        model = DEFAULT_MODEL_BY_PROVIDER[providerId] ?? model;
      }
    }
  }

  return { providerId, model, temperature, max_tokens };
}
