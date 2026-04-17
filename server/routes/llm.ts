import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  listProviders,
  listModels,
  getProviderCredentials,
  saveProviderCredentials,
  PROVIDERS_CATALOG,
} from '../lib/llm-providers.js';

const router = Router();
router.use(isAuthenticated);

/**
 * GET /api/llm/default
 * Returns the currently-default provider id (used when an agent profile
 * doesn't pin a specific provider).
 */
router.get('/default', (req: Request, res: Response) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'llm_default_provider'").get() as Record<string, unknown> | undefined;
    let provider = null;
    try { provider = row?.value ? (JSON.parse(row.value as string) as any).provider ?? null : null; } catch {}
    res.json({ provider });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/llm/default
 * Body: { provider: string }
 * Sets the default LLM provider used as fallback when an agent profile
 * doesn't specify one (or specifies one with no credentials).
 */
router.put('/default', (req: Request, res: Response) => {
  try {
    const { provider } = req.body ?? {};
    if (!provider) return res.status(400).json({ error: 'provider required' });
    if (!PROVIDERS_CATALOG.find((p: any) => p.id === provider)) {
      return res.status(404).json({ error: `Unknown provider '${provider}'` });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('llm_default_provider', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify({ provider }));
    res.json({ ok: true, provider });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tiered LLM configuration ────────────────────────────────────────────
// The agent runtime resolves provider+model by tier:
//   - default tier   — every run that doesn't ask for something cheaper
//   - triage tier    — optional: fast/cheap model for event-driven and
//                      poll-driven routing work (Conductor, chat summaries,
//                      intent extraction, causal/attribution quickhits)
//   - fallback tier  — optional: the model to try when the primary fails
//
// Each tier is stored as two settings keys: llm_<tier>_provider and
// llm_<tier>_model. If a tier isn't configured it falls back to default.
// If default isn't configured, resolveProfileLLM throws — no hidden
// hardcoded model is ever used.

const VALID_TIERS = ['default', 'triage', 'fallback'];

function readTier(tier: string): { provider: string | null; model: string | null } {
  const providerRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(`llm_${tier}_provider`) as Record<string, unknown> | undefined;
  const modelRow    = db.prepare('SELECT value FROM settings WHERE key = ?').get(`llm_${tier}_model`) as Record<string, unknown> | undefined;
  let provider: string | null = null, model: string | null = null;
  try {
    if (providerRow?.value) {
      const p = JSON.parse(providerRow.value as string);
      provider = typeof p === 'string' ? p : (p?.provider ?? null);
    }
  } catch {}
  try {
    if (modelRow?.value) {
      const m = JSON.parse(modelRow.value as string);
      model = typeof m === 'string' ? m : (m?.model ?? null);
    }
  } catch {}
  return { provider, model };
}

/**
 * GET /api/llm/tiers
 * Returns the configured provider+model for each tier plus the list of
 * valid tier names. Used by the Settings UI to render the three sections.
 */
router.get('/tiers', (req: Request, res: Response) => {
  try {
    const out: { tiers: Record<string, unknown>; valid_tiers: string[] } = { tiers: {}, valid_tiers: VALID_TIERS };
    for (const tier of VALID_TIERS) out.tiers[tier] = readTier(tier);
    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/llm/tiers/:tier
 * Body: { provider: string, model: string }
 * Sets both provider and model for a tier atomically. Either can be null
 * to clear one value and keep the other. Both null = unconfigure the tier
 * (it'll then fall back to the default tier).
 */
router.put('/tiers/:tier', (req: Request, res: Response) => {
  try {
    const tier = req.params.tier as string;
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({ error: `Invalid tier '${tier}'. Must be one of: ${VALID_TIERS.join(', ')}` });
    }
    const { provider, model } = req.body ?? {};
    if (provider != null && !PROVIDERS_CATALOG.find((p: any) => p.id === provider)) {
      return res.status(404).json({ error: `Unknown provider '${provider}'` });
    }

    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    if (provider !== undefined) upsert.run(`llm_${tier}_provider`, JSON.stringify(provider));
    if (model    !== undefined) upsert.run(`llm_${tier}_model`,    JSON.stringify(model));

    res.json({ ok: true, tier, ...readTier(tier) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/llm/tiers/:tier
 * Unconfigures a tier — subsequent resolution falls back to the default.
 * Cannot delete the default tier (something has to be configured).
 */
router.delete('/tiers/:tier', (req: Request, res: Response) => {
  try {
    const tier = req.params.tier as string;
    if (tier === 'default') {
      return res.status(400).json({ error: 'Cannot delete the default tier. Set a provider instead.' });
    }
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({ error: `Invalid tier '${tier}'` });
    }
    db.prepare('DELETE FROM settings WHERE key = ?').run(`llm_${tier}_provider`);
    db.prepare('DELETE FROM settings WHERE key = ?').run(`llm_${tier}_model`);
    res.json({ ok: true, tier, provider: null, model: null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/llm/providers
 * List all LLM providers and their configuration status
 */
router.get('/providers', (req: Request, res: Response) => {
  try {
    res.json(listProviders());
  } catch (err: any) {
    console.error('[llm] list providers error:', err);
    res.status(500).json({ error: 'Failed to list providers.' });
  }
});

/**
 * GET /api/llm/providers/:id
 * Get a single provider's details
 */
router.get('/providers/:id', (req: Request, res: Response) => {
  try {
    const providers = listProviders();
    const provider = providers.find((p: any) => p.id === req.params.id as string);
    if (!provider) return res.status(404).json({ error: 'Provider not found.' });
    res.json(provider);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get provider.' });
  }
});

/**
 * GET /api/llm/providers/:id/models
 * List available models for a provider
 */
router.get('/providers/:id/models', async (req: Request, res: Response) => {
  try {
    const catalog = PROVIDERS_CATALOG.find((p: any) => p.id === req.params.id as string);
    if (!catalog) return res.status(404).json({ error: 'Provider not found.' });

    const models = await listModels(req.params.id as string);
    res.json({ models });
  } catch (err: any) {
    console.error('[llm] list models error:', err);
    res.status(500).json({ error: 'Failed to list models.' });
  }
});

/**
 * PUT /api/llm/providers/:id/credentials
 * Save credentials for a provider
 * Body: { apiKey?, baseUrl? }
 */
router.put('/providers/:id/credentials', (req: Request, res: Response) => {
  try {
    const catalog = PROVIDERS_CATALOG.find((p: any) => p.id === req.params.id as string);
    if (!catalog) return res.status(404).json({ error: 'Provider not found.' });

    const { apiKey, baseUrl, model } = req.body;
    const existing = getProviderCredentials(req.params.id as string);
    const updated: any = { ...existing };

    if (apiKey !== undefined) updated.apiKey = apiKey;
    if (baseUrl !== undefined) updated.baseUrl = baseUrl;
    if (model !== undefined) updated.model = model;

    saveProviderCredentials(req.params.id as string, updated);
    res.json({ ok: true, message: `Credentials saved for ${(catalog as any).name}.` });
  } catch (err: any) {
    console.error('[llm] save credentials error:', err);
    res.status(500).json({ error: 'Failed to save credentials.' });
  }
});

/**
 * POST /api/llm/providers/:id/test
 * Test credentials for a provider
 * Body: { apiKey?, baseUrl? }
 */
router.post('/providers/:id/test', async (req: Request, res: Response) => {
  try {
    const catalog = PROVIDERS_CATALOG.find((p: any) => p.id === req.params.id as string) as any;
    if (!catalog) return res.status(404).json({ error: 'Provider not found.' });

    const { apiKey, baseUrl } = req.body;

    // Use provided credentials for test (don't need to save first)
    const testCreds: any = {};
    if (apiKey) testCreds.apiKey = apiKey;
    if (baseUrl) testCreds.baseUrl = baseUrl;

    // Fall back to stored credentials
    const stored = getProviderCredentials(req.params.id as string);
    const creds = { ...stored, ...testCreds };

    const valid = await catalog.adapter.validateApiKey(creds);

    if (valid) {
      return res.json({ ok: true, message: 'Credentials are valid.' });
    }

    // Fall-through: validateApiKey returned false. Do one more real LLM
    // call ourselves so we can surface the actual server response — the
    // opaque "Credentials validation failed" is useless for diagnosis
    // (wrong endpoint? wrong plan? quota? revoked key?).
    try {
      await catalog.adapter.complete({
        ...creds,
        model: catalog.default_models?.[0],
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        temperature: 0,
      });
      // Shouldn't reach here — complete succeeded but validateApiKey
      // rejected. Treat as valid.
      return res.json({ ok: true, message: 'Credentials are valid (via chat).' });
    } catch (probeErr: any) {
      const msg = probeErr?.message || 'Credentials validation failed.';
      // Add a helpful note for the common MiniMax mistake.
      const extraHint = (catalog.id === 'minimax' && /401|403|invalid|unauthori[sz]ed/i.test(msg))
        ? ' Tip: MiniMax has TWO separate platforms. International/token-plan keys use https://api.minimax.io/v1 (Blueprint default). Mainland/CNY keys use https://api.minimaxi.chat/v1 — override via Base URL.'
        : '';
      return res.status(422).json({
        ok: false,
        error: msg + extraHint,
      });
    }
  } catch (err: any) {
    console.error('[llm] test credentials error:', err);
    res.status(422).json({ ok: false, error: err.message || 'Connection failed.' });
  }
});

export default router;
