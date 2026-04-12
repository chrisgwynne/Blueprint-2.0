/**
 * Business-scoped KB routes — Karpathy LLM Wiki pattern.
 *
 * All routes are scoped to /api/kb/:businessId/...
 *
 * The KB lives at:
 *   - native mode:   {KB_ROOT}/{business-slug}/
 *   - obsidian mode: {vault-path}/blueprint/
 */
import { Router } from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { isAuthenticated } from '../middleware/auth.js';
import db from '../db/db.js';
import { KBEngine } from '../kb/kb-engine.js';
import { KBAgent } from '../kb/kb-agent.js';
import {
  KB_ROOT, getKBConfig, saveKBConfig, touchKBConfig as touchConfig, getKBForBusiness,
} from '../kb/kb-config.js';

const router = Router({ mergeParams: true });
router.use(isAuthenticated);

/**
 * Resolve the engine for a request — wraps getKBForBusiness with a 404.
 */
async function getEngine(businessId) {
  const result = await getKBForBusiness(businessId);
  if (!result) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  return result;
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * GET /api/kb/:businessId/settings
 */
router.get('/:businessId/settings', async (req, res) => {
  try {
    const { businessId } = req.params;
    const business = db.prepare('SELECT id, name, slug FROM businesses WHERE id = ?').get(businessId);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    let config = getKBConfig(businessId);
    if (!config) {
      config = {
        mode: 'native',
        root: join(KB_ROOT, business.slug),
        initialized: false,
      };
    }
    return res.json({ business, config });
  } catch (err) {
    console.error('[kb] Settings get error:', err);
    return res.status(500).json({ error: 'Failed to load KB settings.' });
  }
});

/**
 * POST /api/kb/:businessId/settings
 * Body: { mode: 'native'|'obsidian', obsidian_vault_path?, obsidian_write_folders? }
 */
router.post('/:businessId/settings', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { mode, obsidian_vault_path, obsidian_write_folders } = req.body;

    const business = db.prepare('SELECT id, name, slug FROM businesses WHERE id = ?').get(businessId);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    if (mode && !['native', 'obsidian'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "native" or "obsidian".' });
    }

    let root;
    if (mode === 'obsidian') {
      if (!obsidian_vault_path) {
        return res.status(400).json({ error: 'obsidian_vault_path is required for obsidian mode.' });
      }
      if (!existsSync(obsidian_vault_path)) {
        return res.status(400).json({ error: `Obsidian vault path does not exist: ${obsidian_vault_path}` });
      }
      // Confirm it's an Obsidian vault by checking for .obsidian/ folder
      if (!existsSync(join(obsidian_vault_path, '.obsidian'))) {
        return res.status(400).json({
          error: 'Path is not an Obsidian vault (no .obsidian/ directory found).',
        });
      }
      root = join(obsidian_vault_path, 'blueprint');
    } else {
      root = join(KB_ROOT, business.slug);
    }

    const existing = getKBConfig(businessId) ?? {};
    const newConfig = {
      ...existing,
      mode: mode ?? existing.mode ?? 'native',
      root,
      obsidian_vault_path: obsidian_vault_path ?? null,
      obsidian_write_folders: obsidian_write_folders ?? ['blueprint/'],
      initialized: false, // re-init on next access
    };
    saveKBConfig(businessId, newConfig);

    // Init the new location immediately
    const engine = new KBEngine(root, business.slug);
    await engine.init(business.name);

    saveKBConfig(businessId, {
      ...newConfig,
      initialized: true,
      initialized_at: new Date().toISOString(),
    });

    return res.json({ ok: true, config: getKBConfig(businessId) });
  } catch (err) {
    console.error('[kb] Settings save error:', err);
    return res.status(500).json({ error: err.message ?? 'Failed to save KB settings.' });
  }
});

/**
 * POST /api/kb/:businessId/init
 * Force-initialize (idempotent — safe to re-call).
 */
router.post('/:businessId/init', async (req, res) => {
  try {
    const { engine, business, config } = await getEngine(req.params.businessId);
    const stats = await engine.stats();
    return res.json({ ok: true, root: config.root, business, stats });
  } catch (err) {
    console.error('[kb] Init error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─── Read operations ────────────────────────────────────────────────────────

/**
 * GET /api/kb/:businessId/tree
 */
router.get('/:businessId/tree', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const tree = await engine.getTree();
    const stats = await engine.stats();
    return res.json({ tree, stats });
  } catch (err) {
    console.error('[kb] Tree error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/log
 */
router.get('/:businessId/log', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const log = await engine.readLog(limit);
    return res.json({ entries: log });
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/search?q=...
 */
router.get('/:businessId/search', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const results = await engine.search(String(q), 30);
    return res.json({ results, query: q });
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/file/*  — read a file
 *
 * The asterisk captures a multi-segment path like 'entities/foo.md'.
 */
router.get('/:businessId/file/*', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const filePath = req.params[0];
    const file = await engine.readFile(filePath);
    return res.json(file);
  } catch (err) {
    if (String(err.message ?? '').includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/backlinks/* — pages that link here
 */
router.get('/:businessId/backlinks/*', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const filePath = req.params[0];
    const backlinks = await engine.getBacklinks(filePath);
    return res.json({ backlinks });
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/history/* — git log for a file
 */
router.get('/:businessId/history/*', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const filePath = req.params[0];
    const history = await engine.getHistory(filePath);
    return res.json({ history });
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/diff/:hash/* — file content at a commit
 */
router.get('/:businessId/diff/:hash/*', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const filePath = req.params[0];
    const content = await engine.getFileAtCommit(filePath, req.params.hash);
    return res.json({ path: filePath, hash: req.params.hash, content });
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─── Write operations ──────────────────────────────────────────────────────

/**
 * POST /api/kb/:businessId/file/* — write a file (auto-commit)
 * Body: { content, frontmatter?, message? }
 */
router.post('/:businessId/file/*', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const filePath = req.params[0];
    const { content, frontmatter, message } = req.body;
    if (content === undefined) {
      return res.status(400).json({ error: 'content is required.' });
    }
    const result = await engine.writeFile(filePath, content, frontmatter ?? null, message);
    return res.json(result);
  } catch (err) {
    console.error('[kb] Write error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * DELETE /api/kb/:businessId/file/* — archive (not delete)
 */
router.delete('/:businessId/file/*', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const filePath = req.params[0];
    const result = await engine.archiveFile(filePath);
    return res.json(result);
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/restore
 * Body: { path, hash }
 */
router.post('/:businessId/restore', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const { path: filePath, hash } = req.body;
    if (!filePath || !hash) return res.status(400).json({ error: 'path and hash are required.' });
    const result = await engine.restoreVersion(filePath, hash);
    return res.json(result);
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/upload-raw
 * Body: { filename, content }  (content as text)
 */
router.post('/:businessId/upload-raw', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const { filename, content } = req.body;
    if (!filename || content === undefined) {
      return res.status(400).json({ error: 'filename and content are required.' });
    }
    const result = await engine.uploadRaw(filename, content);
    return res.json(result);
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─── Agent operations (LLM-powered) ─────────────────────────────────────────

/**
 * POST /api/kb/:businessId/ingest
 * Body: { rawPath, sourceTitle, sourceType? }
 */
router.post('/:businessId/ingest', async (req, res) => {
  try {
    const { engine, business } = await getEngine(req.params.businessId);
    const { rawPath, sourceTitle, sourceType = 'article' } = req.body;
    if (!rawPath || !sourceTitle) {
      return res.status(400).json({ error: 'rawPath and sourceTitle are required.' });
    }

    const agent = new KBAgent(engine);
    const result = await agent.ingest(rawPath, sourceTitle, sourceType);

    touchConfig(req.params.businessId, { last_ingest: new Date().toISOString() });

    return res.json(result);
  } catch (err) {
    console.error('[kb] Ingest error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/query
 * Body: { question, fileResult? }
 */
router.post('/:businessId/query', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const { question, fileResult = false } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required.' });

    const agent = new KBAgent(engine);
    const result = await agent.query(question, { fileResult });
    return res.json(result);
  } catch (err) {
    console.error('[kb] Query error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/lint
 */
router.post('/:businessId/lint', async (req, res) => {
  try {
    const { engine } = await getEngine(req.params.businessId);
    const agent = new KBAgent(engine);
    const result = await agent.runLint();
    touchConfig(req.params.businessId, { last_lint: new Date().toISOString() });
    return res.json(result);
  } catch (err) {
    console.error('[kb] Lint error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
