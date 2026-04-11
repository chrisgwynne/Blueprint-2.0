import { Router } from 'express';
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

    const { apiKey, baseUrl } = req.body;
    const existing = getProviderCredentials(req.params.id);
    const updated = { ...existing };

    if (apiKey !== undefined) updated.apiKey = apiKey;
    if (baseUrl !== undefined) updated.baseUrl = baseUrl;

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
      res.json({ ok: true, message: 'Credentials are valid.' });
    } else {
      res.status(422).json({ ok: false, error: 'Credentials validation failed.' });
    }
  } catch (err) {
    console.error('[llm] test credentials error:', err);
    res.status(422).json({ ok: false, error: err.message || 'Connection failed.' });
  }
});

export default router;
