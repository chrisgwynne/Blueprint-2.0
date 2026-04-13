import { Router } from 'express';
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
router.get('/default', (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'llm_default_provider'").get();
    let provider = null;
    try { provider = row?.value ? JSON.parse(row.value).provider ?? null : null; } catch {}
    res.json({ provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/llm/default
 * Body: { provider: string }
 * Sets the default LLM provider used as fallback when an agent profile
 * doesn't specify one (or specifies one with no credentials).
 */
router.put('/default', (req, res) => {
  try {
    const { provider } = req.body ?? {};
    if (!provider) return res.status(400).json({ error: 'provider required' });
    if (!PROVIDERS_CATALOG.find((p) => p.id === provider)) {
      return res.status(404).json({ error: `Unknown provider '${provider}'` });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('llm_default_provider', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify({ provider }));
    res.json({ ok: true, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/llm/providers
 * List all LLM providers and their configuration status
 */
router.get('/providers', (req, res) => {
  try {
    res.json(listProviders());
  } catch (err) {
    console.error('[llm] list providers error:', err);
    res.status(500).json({ error: 'Failed to list providers.' });
  }
});

/**
 * GET /api/llm/providers/:id
 * Get a single provider's details
 */
router.get('/providers/:id', (req, res) => {
  try {
    const providers = listProviders();
    const provider = providers.find(p => p.id === req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found.' });
    res.json(provider);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get provider.' });
  }
});

/**
 * GET /api/llm/providers/:id/models
 * List available models for a provider
 */
router.get('/providers/:id/models', async (req, res) => {
  try {
    const catalog = PROVIDERS_CATALOG.find(p => p.id === req.params.id);
    if (!catalog) return res.status(404).json({ error: 'Provider not found.' });

    const models = await listModels(req.params.id);
    res.json({ models });
  } catch (err) {
    console.error('[llm] list models error:', err);
    res.status(500).json({ error: 'Failed to list models.' });
  }
});

/**
 * PUT /api/llm/providers/:id/credentials
 * Save credentials for a provider
 * Body: { apiKey?, baseUrl? }
 */
router.put('/providers/:id/credentials', (req, res) => {
  try {
    const catalog = PROVIDERS_CATALOG.find(p => p.id === req.params.id);
    if (!catalog) return res.status(404).json({ error: 'Provider not found.' });

    const { apiKey, baseUrl, model } = req.body;
    const existing = getProviderCredentials(req.params.id);
    const updated = { ...existing };

    if (apiKey !== undefined) updated.apiKey = apiKey;
    if (baseUrl !== undefined) updated.baseUrl = baseUrl;
    if (model !== undefined) updated.model = model;

    saveProviderCredentials(req.params.id, updated);
    res.json({ ok: true, message: `Credentials saved for ${catalog.name}.` });
  } catch (err) {
    console.error('[llm] save credentials error:', err);
    res.status(500).json({ error: 'Failed to save credentials.' });
  }
});

/**
 * POST /api/llm/providers/:id/test
 * Test credentials for a provider
 * Body: { apiKey?, baseUrl? }
 */
router.post('/providers/:id/test', async (req, res) => {
  try {
    const catalog = PROVIDERS_CATALOG.find(p => p.id === req.params.id);
    if (!catalog) return res.status(404).json({ error: 'Provider not found.' });

    const { apiKey, baseUrl } = req.body;

    // Use provided credentials for test (don't need to save first)
    const testCreds = {};
    if (apiKey) testCreds.apiKey = apiKey;
    if (baseUrl) testCreds.baseUrl = baseUrl;

    // Fall back to stored credentials
    const stored = getProviderCredentials(req.params.id);
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
    } catch (probeErr) {
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
  } catch (err) {
    console.error('[llm] test credentials error:', err);
    res.status(422).json({ ok: false, error: err.message || 'Connection failed.' });
  }
});

export default router;
