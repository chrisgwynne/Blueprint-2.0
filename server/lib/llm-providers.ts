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

export interface ProviderPreflightRequirements {
  toolCalling?: boolean;
  structuredOutput?: boolean;
  minContextTokens?: number;
  timeoutMs?: number;
}

export interface ProviderPreflightResult {
  provider: string;
  model: string;
  status: 'passed' | 'failed' | 'blocked';
  temporary: boolean;
  evidence: Record<string, unknown>;
}

const PROVIDER_CAPABILITIES: Record<string, {
  tool_calling: boolean | 'unknown';
  structured_output: boolean | 'unknown';
  vision: boolean | 'unknown';
  max_context_tokens: number | 'unknown';
  locality: 'local' | 'cloud' | 'cli' | 'unknown';
  cost_class: 'free_local' | 'low' | 'medium' | 'high' | 'unknown';
}> = {
  anthropic: { tool_calling: true, structured_output: true, vision: true, max_context_tokens: 200000, locality: 'cloud', cost_class: 'high' },
  openai: { tool_calling: true, structured_output: true, vision: true, max_context_tokens: 128000, locality: 'cloud', cost_class: 'medium' },
  google: { tool_calling: true, structured_output: true, vision: true, max_context_tokens: 1000000, locality: 'cloud', cost_class: 'medium' },
  minimax: { tool_calling: true, structured_output: true, vision: false, max_context_tokens: 200000, locality: 'cloud', cost_class: 'medium' },
  ollama: { tool_calling: 'unknown', structured_output: 'unknown', vision: 'unknown', max_context_tokens: 'unknown', locality: 'local', cost_class: 'free_local' },
  lmstudio: { tool_calling: 'unknown', structured_output: 'unknown', vision: 'unknown', max_context_tokens: 'unknown', locality: 'local', cost_class: 'free_local' },
  custom: { tool_calling: 'unknown', structured_output: 'unknown', vision: 'unknown', max_context_tokens: 'unknown', locality: 'unknown', cost_class: 'unknown' },
  'claude-cli': { tool_calling: false, structured_output: false, vision: 'unknown', max_context_tokens: 200000, locality: 'cli', cost_class: 'unknown' },
};

function safeDiagnostic(err: unknown): string {
  return String((err as Error)?.message ?? err ?? 'Unknown provider preflight failure.')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/gi, 'sk-[redacted]')
    .slice(0, 500);
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

export async function performProviderPreflight(
  providerId: string,
  model: string,
  requirements: ProviderPreflightRequirements = {},
): Promise<ProviderPreflightResult> {
  const entry = PROVIDER_MAP[providerId];
  const caps = PROVIDER_CAPABILITIES[providerId] ?? {
    tool_calling: 'unknown', structured_output: 'unknown', vision: 'unknown', max_context_tokens: 'unknown', locality: 'unknown', cost_class: 'unknown',
  };
  const evidence: Record<string, unknown> = {
    provider_reachable: 'unknown',
    authentication: 'unknown',
    model_exists: 'unknown',
    model_enabled: 'unknown',
    tool_calling: caps.tool_calling,
    structured_output: caps.structured_output,
    vision: caps.vision,
    context_window: caps.max_context_tokens,
    expected_latency: caps.locality === 'local' ? 'local-runtime-dependent' : 'network-dependent',
    locality: caps.locality,
    cost_class: caps.cost_class,
    timeout_configuration: requirements.timeoutMs && requirements.timeoutMs > 0 ? 'verified' : 'default',
    rate_limit_state: 'unknown',
    budget_policy: 'unknown',
    placeholder_response: 'unknown',
  };

  if (!entry) {
    evidence.diagnostic = `Unknown LLM provider: ${providerId}`;
    return { provider: providerId, model, status: 'blocked', temporary: false, evidence };
  }
  if (!providerId || !model || /unavailable|missing|disabled|mock|placeholder/i.test(`${providerId} ${model}`)) {
    evidence.model_exists = false;
    evidence.model_enabled = false;
    evidence.diagnostic = 'Provider/model is missing, disabled, placeholder, or explicitly unavailable before the run began.';
    return { provider: providerId || 'unknown', model: model || 'unknown', status: 'blocked', temporary: false, evidence };
  }
  if (requirements.toolCalling && caps.tool_calling !== true) {
    evidence.diagnostic = 'Selected provider/model has no verified tool-calling support for this run.';
    return { provider: providerId, model, status: 'blocked', temporary: false, evidence };
  }
  if (requirements.structuredOutput && caps.structured_output !== true) {
    evidence.diagnostic = 'Selected provider/model has no verified structured-output support for this run.';
    return { provider: providerId, model, status: 'blocked', temporary: false, evidence };
  }
  if (requirements.minContextTokens && typeof caps.max_context_tokens === 'number' && caps.max_context_tokens < requirements.minContextTokens) {
    evidence.diagnostic = `Selected provider/model context window ${caps.max_context_tokens} is below required ${requirements.minContextTokens}.`;
    return { provider: providerId, model, status: 'blocked', temporary: false, evidence };
  }

  const creds = getProviderCredentials(providerId);
  try {
    const authOk = await entry.adapter.validateApiKey({ ...creds, validationModel: model } as ProviderCredentials & { validationModel?: string });
    evidence.provider_reachable = authOk ? 'observed' : 'failed';
    evidence.authentication = authOk ? 'verified' : 'failed';
    if (!authOk) {
      evidence.diagnostic = 'Provider credential validation failed before the run began.';
      return { provider: providerId, model, status: 'failed', temporary: true, evidence };
    }
  } catch (err) {
    evidence.provider_reachable = 'failed';
    evidence.authentication = 'failed';
    evidence.diagnostic = safeDiagnostic(err);
    return { provider: providerId, model, status: 'failed', temporary: true, evidence };
  }

  try {
    const models = await entry.adapter.listModels(creds);
    evidence.available_model_count = models.length;
    if (models.length > 0) {
      evidence.model_exists = models.includes(model);
      if (!models.includes(model)) {
        evidence.model_enabled = false;
        evidence.diagnostic = `Selected model '${model}' was not returned by provider model listing.`;
        return { provider: providerId, model, status: 'blocked', temporary: false, evidence };
      }
    }
  } catch (err) {
    evidence.model_exists = 'unknown';
    evidence.model_listing_error = safeDiagnostic(err);
  }

  try {
    const probe = await entry.adapter.complete({
      ...creds,
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      temperature: 0,
      // Reasoning-capable models can consume a small token budget internally and
      // return an empty content part even when the provider/model is healthy.
      // Keep this probe bounded, but large enough to surface the requested text.
      max_tokens: 128,
    });
    const content = String(probe.content ?? '').trim();
    const placeholder = !content || /mock|placeholder|lorem ipsum|not implemented/i.test(content);
    evidence.provider_reachable = 'verified';
    evidence.authentication = 'verified';
    evidence.model_exists = evidence.model_exists === 'unknown' ? 'observed' : evidence.model_exists;
    evidence.model_enabled = true;
    evidence.placeholder_response = placeholder ? 'failed' : 'verified';
    evidence.probe_usage = probe.usage ?? null;
    if (placeholder) {
      evidence.diagnostic = 'Provider probe returned an empty, mocked, or placeholder response.';
      return { provider: providerId, model, status: 'failed', temporary: false, evidence };
    }
  } catch (err) {
    evidence.model_enabled = false;
    evidence.diagnostic = safeDiagnostic(err);
    return { provider: providerId, model, status: 'failed', temporary: true, evidence };
  }

  evidence.diagnostic = 'Provider authentication, selected model, and a minimal completion probe passed before request dispatch.';
  return { provider: providerId, model, status: 'passed', temporary: false, evidence };
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
 * Providers Blueprint maintains a curated, current model catalog for.
 * Local/BYO providers (ollama, lmstudio, custom, claude-cli) are
 * deliberately excluded — their model names are whatever the operator's
 * local install supports, and Blueprint has no way to enumerate or
 * validate them.
 */
const CATALOGUED_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'minimax']);

/**
 * Issue #26: a saved model setting can go stale in two ways — the
 * provider retires it out from under Blueprint (e.g. Google removing
 * `gemini-2.5-pro`), or the stored value itself is malformed/truncated
 * (observed: a lone `g`). Either way the provider's API call fails with a
 * raw error on every single conductor/agent run until a human notices and
 * fixes Settings. For providers with a maintained model catalog, silently
 * retrying the same broken model is never useful — fall back to the
 * catalog's current default and warn, so autonomous runs keep working
 * instead of failing forever on stale config. Providers without a
 * catalog (local/BYO) are left untouched; there's nothing to validate
 * against.
 */
function validateOrFallbackModel(providerId: string, model: string): string {
  if (!CATALOGUED_PROVIDERS.has(providerId)) return model;
  const known = PROVIDER_MAP[providerId]?.default_models ?? [];
  if (known.length === 0 || known.includes(model)) return model;
  const replacement = known[0]!;
  console.warn(
    `[llm-providers] Configured model '${model}' for provider '${providerId}' is not in the current known-model ` +
    `list (likely retired, or a stale/malformed config value) — falling back to '${replacement}' for this run. ` +
    `Update Settings → LLM Providers to clear this warning.`
  );
  return replacement;
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

  return { providerId, model: validateOrFallbackModel(providerId, model), temperature, max_tokens };
}
