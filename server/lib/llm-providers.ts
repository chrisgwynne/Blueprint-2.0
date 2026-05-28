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
import * as minimaxProvider from './providers/minimax.js';
import type { ProviderAdapter, ProviderCredentials } from './providers/types.js';

// ─── Provider Catalog ─────────────────────────────────────────────────────────

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  requires_key: boolean;
  requires_base_url: boolean;
  base_url_label?: string;
  default_models: string[];
  adapter: ProviderAdapter;
}

export const PROVIDERS_CATALOG: CatalogEntry[] = [
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
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax-M2, M1, abab models (OpenAI-compatible endpoint)',
    requires_key: true,
    requires_base_url: false,
    default_models: minimaxProvider.KNOWN_MODELS,
    adapter: minimaxProvider,
  },
];

const PROVIDER_MAP: Record<string, CatalogEntry> = Object.fromEntries(
  PROVIDERS_CATALOG.map(p => [p.id, p])
);

// ─── Credentials ──────────────────────────────────────────────────────────────

export function getProviderCredentials(providerId: string): ProviderCredentials {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(`provider_credentials_${providerId}`) as { value: string } | null;
  if (!row) return {};
  try { return JSON.parse(row.value) as ProviderCredentials; } catch { return {}; }
}

export function saveProviderCredentials(providerId: string, credentials: ProviderCredentials): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(`provider_credentials_${providerId}`, JSON.stringify(credentials));
}

// ─── Core runLLM function ─────────────────────────────────────────────────────

export interface RunLLMOptions {
  messages: Array<{ role: string; content: string | Array<{ text?: string }> }>;
  system?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface RunLLMResult {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  cost_usd: number;
}

export async function runLLM(providerId: string, model: string, { messages, system, temperature, max_tokens }: RunLLMOptions): Promise<RunLLMResult> {
  const entry = PROVIDER_MAP[providerId];
  if (!entry) throw new Error(`Unknown LLM provider: ${providerId}`);

  const creds = getProviderCredentials(providerId);

  const result = await entry.adapter.complete({
    ...creds,
    model,
    messages: messages as Parameters<typeof entry.adapter.complete>[0]['messages'],
    system,
    temperature,
    max_tokens,
  });

  // Strip <think>...</think> reasoning blocks emitted by models like DeepSeek-R1 / QwQ
  const content = result.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Use provider-reported cost if available (claude-cli reports actual cost), else estimate
  const costUsd = result.cost_usd != null
    ? result.cost_usd
    : (entry.adapter.estimateCost
        ? entry.adapter.estimateCost(model, result.usage.input_tokens, result.usage.output_tokens)
        : 0);

  return { ...result, content, cost_usd: costUsd };
}

// ─── Model listing ────────────────────────────────────────────────────────────

export async function listModels(providerId: string): Promise<string[]> {
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

export function listProviders(): Array<{
  id: string;
  name: string;
  description: string;
  requires_key: boolean;
  requires_base_url: boolean;
  base_url_label: string | null;
  default_models: string[];
  configured: boolean;
  model: string | null;
  base_url: string | null;
}> {
  return PROVIDERS_CATALOG.map(p => {
    const creds = getProviderCredentials(p.id);
    const configured = p.id === 'anthropic'
      ? !!(creds?.apiKey || process.env['ANTHROPIC_API_KEY'])
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
      // Surface the saved preferred model so the Settings dropdown can
      // pre-select it. Never expose the api key.
      model: creds?.model ?? null,
      base_url: creds?.baseUrl ?? null,
    };
  });
}

// ─── Resolve provider + model from profile ────────────────────────────────────

/**
 * Returns true if the given provider has usable credentials (either in DB or
 * environment, or is a keyless local provider like ollama/claude-cli).
 */
function isProviderConfigured(providerId: string): boolean {
  if (providerId === 'ollama' || providerId === 'lmstudio' || providerId === 'claude-cli') {
    return true; // local / CLI — no key required
  }
  const creds = getProviderCredentials(providerId);
  if (creds?.apiKey || creds?.baseUrl) return true;
  if (providerId === 'anthropic' && process.env['ANTHROPIC_API_KEY']) return true;
  if (providerId === 'openai' && process.env['OPENAI_API_KEY']) return true;
  if (providerId === 'google' && process.env['GOOGLE_API_KEY']) return true;
  if (providerId === 'minimax' && process.env['MINIMAX_API_KEY']) return true;
  return false;
}

/**
 * Pick a provider that IS configured. Honours 'llm_default_provider' setting
 * first, then falls back to the first provider with credentials. Never returns
 * 'anthropic' unless it actually has a key.
 */
function pickConfiguredProvider(): string | null {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'llm_default_provider'").get() as
    | { value: string }
    | null;
  if (stored?.value) {
    try {
      const parsed = JSON.parse(stored.value) as { provider?: string } | string;
      const provider = typeof parsed === 'string' ? parsed : (parsed?.provider ?? null);
      if (provider && isProviderConfigured(provider)) return provider;
    } catch {}
  }
  if (process.env['LLM_DEFAULT_PROVIDER'] && isProviderConfigured(process.env['LLM_DEFAULT_PROVIDER'])) {
    return process.env['LLM_DEFAULT_PROVIDER'];
  }
  for (const p of PROVIDERS_CATALOG) {
    if (isProviderConfigured(p.id)) return p.id;
  }
  return null;
}

/**
 * Read tier-specific provider/model overrides from settings.
 *   - tier='triage'   → settings keys llm_triage_provider / llm_triage_model
 *   - tier='fallback' → settings keys llm_fallback_provider / llm_fallback_model
 *   - tier='default'  → settings keys llm_default_provider / llm_default_model
 * Returns { provider, model } with either field null when unset.
 */
function readTierSettings(tier: string): { provider: string | null; model: string | null } {
  let providerKey: string, modelKey: string;
  if (tier === 'triage') {
    providerKey = 'llm_triage_provider'; modelKey = 'llm_triage_model';
  } else if (tier === 'fallback') {
    providerKey = 'llm_fallback_provider'; modelKey = 'llm_fallback_model';
  } else {
    providerKey = 'llm_default_provider'; modelKey = 'llm_default_model';
  }
  let provider: string | null = null, model: string | null = null;
  try {
    const p = db.prepare('SELECT value FROM settings WHERE key = ?').get(providerKey) as { value: string } | null;
    if (p?.value) {
      const parsed = JSON.parse(p.value) as string | { provider?: string };
      // llm_default_provider historically stored as { provider } or bare string
      provider = typeof parsed === 'string' ? parsed : (parsed?.provider ?? null);
    }
  } catch {}
  try {
    const m = db.prepare('SELECT value FROM settings WHERE key = ?').get(modelKey) as { value: string } | null;
    if (m?.value) {
      const parsed = JSON.parse(m.value) as string | { model?: string };
      model = typeof parsed === 'string' ? parsed : (parsed?.model ?? null);
    }
  } catch {}
  return { provider, model };
}

/**
 * Get the user-configured fallback LLM config for agent-runner's retry path.
 * Returns { provider, model } if both are set in settings, else null.
 * If either is missing, there's no fallback — caller skips the retry.
 */
export function getFallbackLLM(): { provider: string; model: string } | null {
  const f = readTierSettings('fallback');
  if (!f.provider || !f.model) return null;
  if (!isProviderConfigured(f.provider)) return null;
  return { provider: f.provider, model: f.model };
}

export interface ProfileLLM {
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface ResolvedLLM {
  providerId: string;
  model: string;
  temperature: number;
  max_tokens: number;
}

/**
 * Given a profile's llm config, return { providerId, model, temperature, max_tokens }.
 *
 * Resolution order for provider:
 *   1. profileLLM.provider (explicit per-call override)
 *   2. tier-specific setting (llm_triage_provider for tier='triage')
 *   3. llm_default_provider setting
 *   4. first configured provider (pickConfiguredProvider)
 *   5. throw — no silent hardcoded fallback
 *
 * Resolution order for model:
 *   1. profileLLM.model (explicit per-call override)
 *   2. tier-specific setting (llm_triage_model for tier='triage')
 *   3. llm_default_model setting
 *   4. the model saved on the chosen provider's credentials
 *   5. throw — ask the user to pick one in Settings
 */
export function resolveProfileLLM(profileLLM: ProfileLLM | null, opts: { tier?: string } = {}): ResolvedLLM {
  const tier =
    opts.tier === 'triage'   ? 'triage' :
    opts.tier === 'fallback' ? 'fallback' : 'default';
  const tierSettings = readTierSettings(tier);
  const defaultSettings = tier === 'default' ? tierSettings : readTierSettings('default');

  // Provider resolution
  const providerId =
    profileLLM?.provider ??
    tierSettings.provider ??
    defaultSettings.provider ??
    pickConfiguredProvider();

  if (!providerId) {
    throw new Error(
      'No LLM provider is configured. ' +
      'Open Settings → LLM Providers and add credentials for at least one provider.'
    );
  }

  // Model resolution — each layer can be absent
  const savedModel = getProviderCredentials(providerId)?.model;
  const model =
    profileLLM?.model ??
    (tierSettings.provider === providerId ? tierSettings.model : null) ??
    (defaultSettings.provider === providerId ? defaultSettings.model : null) ??
    savedModel;

  if (!model) {
    throw new Error(
      `LLM provider '${providerId}' has no model selected. ` +
      `Open Settings → LLM Providers and choose a model for ${providerId}` +
      (tier === 'triage' ? ' (or configure a separate triage model).' : '.')
    );
  }

  const temperature = profileLLM?.temperature ?? 0.7;
  const max_tokens = profileLLM?.max_tokens ?? 4096;

  // Inject ANTHROPIC_API_KEY from env into DB if anthropic was requested
  if (providerId === 'anthropic') {
    const creds = getProviderCredentials('anthropic');
    if (!creds?.apiKey && process.env['ANTHROPIC_API_KEY']) {
      saveProviderCredentials('anthropic', { apiKey: process.env['ANTHROPIC_API_KEY'] });
    }
  }

  // If an explicit provider was named but isn't configured, fail clearly.
  if (profileLLM?.provider != null && !isProviderConfigured(providerId)) {
    throw new Error(
      `LLM provider '${providerId}' is not configured. ` +
      (providerId === 'anthropic'
        ? 'Add an API key in Settings → LLM Providers, or set the ANTHROPIC_API_KEY environment variable.'
        : `Add credentials in Settings → LLM Providers.`)
    );
  }

  return { providerId, model, temperature, max_tokens };
}
