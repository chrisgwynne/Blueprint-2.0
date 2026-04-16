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
import type { Request, Response } from 'express';
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
async function getEngine(businessId: string): Promise<any> {
  const result = await getKBForBusiness(businessId);
  if (!result) {
    const err: any = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  return result;
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * GET /api/kb/:businessId/settings
 */
router.get('/:businessId/settings', async (req: Request, res: Response) => {
  try {
    const businessId = req.params.businessId as string;
    const business = db.prepare('SELECT id, name, slug FROM businesses WHERE id = ?').get(businessId);
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    let config = getKBConfig(businessId);
    if (!config) {
      config = {
        mode: 'native',
        root: join(KB_ROOT, (business as any).slug),
        initialized: false,
      };
    }
    return res.json({ business, config });
  } catch (err: any) {
    console.error('[kb] Settings get error:', err);
    return res.status(500).json({ error: 'Failed to load KB settings.' });
  }
});

/**
 * POST /api/kb/:businessId/settings
 * Body: { mode: 'native'|'obsidian', obsidian_vault_path?, obsidian_write_folders? }
 */
router.post('/:businessId/settings', async (req: Request, res: Response) => {
  try {
    const businessId = req.params.businessId as string;
    const { mode, obsidian_vault_path, obsidian_write_folders } = req.body;

    const business = db.prepare('SELECT id, name, slug FROM businesses WHERE id = ?').get(businessId) as Record<string, unknown> | undefined;
    if (!business) return res.status(404).json({ error: 'Business not found.' });

    if (mode && !['native', 'obsidian'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "native" or "obsidian".' });
    }

    let root: string;
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
      root = join(KB_ROOT, business.slug as string);
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
    const engine = new KBEngine(root, business.slug as string);
    await engine.init(business.name as string);

    saveKBConfig(businessId, {
      ...newConfig,
      initialized: true,
      initialized_at: new Date().toISOString(),
    });

    return res.json({ ok: true, config: getKBConfig(businessId) });
  } catch (err: any) {
    console.error('[kb] Settings save error:', err);
    return res.status(500).json({ error: err.message ?? 'Failed to save KB settings.' });
  }
});

/**
 * POST /api/kb/:businessId/init
 * Force-initialize (idempotent — safe to re-call).
 */
router.post('/:businessId/init', async (req: Request, res: Response) => {
  try {
    const { engine, business, config } = await getEngine(req.params.businessId as string);
    const stats = await engine.stats();
    return res.json({ ok: true, root: config.root, business, stats });
  } catch (err: any) {
    console.error('[kb] Init error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─── Read operations ────────────────────────────────────────────────────────

/**
 * GET /api/kb/:businessId/tree
 */
router.get('/:businessId/tree', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const tree = await engine.getTree();
    const stats = await engine.stats();
    return res.json({ tree, stats });
  } catch (err: any) {
    console.error('[kb] Tree error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/log
 */
router.get('/:businessId/log', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const limit = Math.min(parseInt(String(req.query.limit ?? ''), 10) || 50, 200);
    const log = await engine.readLog(limit);
    return res.json({ entries: log });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/search?q=...
 */
router.get('/:businessId/search', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const results = await engine.search(String(q), 30);
    return res.json({ results, query: q });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/file/*  — read a file
 *
 * The asterisk captures a multi-segment path like 'entities/foo.md'.
 */
router.get('/:businessId/file/*', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const filePath = (req.params as any)[0] as string;
    const file = await engine.readFile(filePath);
    return res.json(file);
  } catch (err: any) {
    if (String(err.message ?? '').includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/backlinks/* — pages that link here
 */
router.get('/:businessId/backlinks/*', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const filePath = (req.params as any)[0] as string;
    const backlinks = await engine.getBacklinks(filePath);
    return res.json({ backlinks });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/history/* — git log for a file
 */
router.get('/:businessId/history/*', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const filePath = (req.params as any)[0] as string;
    const history = await engine.getHistory(filePath);
    return res.json({ history });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/diff/:hash/* — file content at a commit
 */
router.get('/:businessId/diff/:hash/*', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const filePath = (req.params as any)[0] as string;
    const content = await engine.getFileAtCommit(filePath, req.params.hash);
    return res.json({ path: filePath, hash: req.params.hash, content });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─── Write operations ──────────────────────────────────────────────────────

/**
 * POST /api/kb/:businessId/file/* — write a file (auto-commit)
 * Body: { content, frontmatter?, message? }
 */
router.post('/:businessId/file/*', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const filePath = (req.params as any)[0] as string;
    const { content, frontmatter, message } = req.body;
    if (content === undefined) {
      return res.status(400).json({ error: 'content is required.' });
    }
    const result = await engine.writeFile(filePath, content, frontmatter ?? null, message);
    return res.json(result);
  } catch (err: any) {
    console.error('[kb] Write error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * DELETE /api/kb/:businessId/file/* — archive (not delete)
 */
router.delete('/:businessId/file/*', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const filePath = (req.params as any)[0] as string;
    const result = await engine.archiveFile(filePath);
    return res.json(result);
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/restore
 * Body: { path, hash }
 */
router.post('/:businessId/restore', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const { path: filePath, hash } = req.body;
    if (!filePath || !hash) return res.status(400).json({ error: 'path and hash are required.' });
    const result = await engine.restoreVersion(filePath, hash);
    return res.json(result);
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/upload-raw
 * Body: { filename, content }  (content as text)
 */
router.post('/:businessId/upload-raw', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const { filename, content } = req.body;
    if (!filename || content === undefined) {
      return res.status(400).json({ error: 'filename and content are required.' });
    }
    const result = await engine.uploadRaw(filename, content);
    return res.json(result);
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─── Agent operations (LLM-powered) ─────────────────────────────────────────

/**
 * POST /api/kb/:businessId/ingest
 * Body: { rawPath, sourceTitle, sourceType? }
 */
router.post('/:businessId/ingest', async (req: Request, res: Response) => {
  try {
    const { engine, business } = await getEngine(req.params.businessId as string);
    const { rawPath, sourceTitle, sourceType = 'article' } = req.body;
    if (!rawPath || !sourceTitle) {
      return res.status(400).json({ error: 'rawPath and sourceTitle are required.' });
    }

    const agent = new KBAgent(engine);
    const result = await agent.ingest(rawPath, sourceTitle, sourceType);

    touchConfig(req.params.businessId as string, { last_ingest: new Date().toISOString() });

    return res.json(result);
  } catch (err: any) {
    console.error('[kb] Ingest error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/query
 * Body: { question, fileResult? }
 */
router.post('/:businessId/query', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const { question, fileResult = false } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required.' });

    const agent = new KBAgent(engine);
    const result = await agent.query(question, { fileResult });
    return res.json(result);
  } catch (err: any) {
    console.error('[kb] Query error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/lint
 */
router.post('/:businessId/lint', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const agent = new KBAgent(engine);
    const result = await agent.runLint();
    touchConfig(req.params.businessId as string, { last_lint: new Date().toISOString() });
    return res.json(result);
  } catch (err: any) {
    console.error('[kb] Lint error:', err);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─── Recent changes ──────────────────────────────────────────────────────────

/**
 * GET /api/kb/:businessId/recent-changes?limit=20
 * Recent git commits across all KB files.
 */
router.get('/:businessId/recent-changes', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const limit = Math.min(parseInt(String(req.query.limit ?? ''), 10) || 20, 100);

    // Use isomorphic-git log on the whole repo (no filepath filter = all files)
    const git = ((await import('isomorphic-git')) as any).default;
    const fs = ((await import('fs')) as any).default;

    let commits: any[] = [];
    try {
      commits = await git.log({ fs, dir: engine.root, depth: limit });
    } catch {}

    const changes = commits.map((c: any) => {
      const msg = c.commit.message.trim();
      let type = 'human';
      if (msg.startsWith('ingest:')) type = 'ingest';
      else if (msg.startsWith('signal:')) type = 'signal';
      else if (msg.startsWith('agent')) type = 'agent';
      else if (msg.startsWith('query:')) type = 'query';
      else if (msg.startsWith('lint:') || msg.startsWith('log:')) type = 'lint';
      else if (msg.startsWith('init:')) type = 'init';
      else if (msg.startsWith('update:')) type = 'human';

      return {
        hash: c.oid.slice(0, 7),
        message: msg,
        author: c.commit.author.name,
        date: new Date(c.commit.author.timestamp * 1000).toISOString(),
        type,
      };
    });

    return res.json({ changes });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ─── Review queue ────────────────────────────────────────────────────────────

/**
 * GET /api/kb/:businessId/review-queue
 * Pages written by agents that need human review.
 */
router.get('/:businessId/review-queue', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const files = await engine.listFiles();
    const pending: any[] = [];

    for (const f of files) {
      try {
        const file = await engine.readFile(f);
        if (file.frontmatter?.review_status === 'pending_review') {
          pending.push({
            path: f,
            title: file.frontmatter.title ?? f,
            written_by: file.frontmatter.written_by ?? 'unknown',
            written_at: file.frontmatter.written_at ?? null,
            confidence: file.frontmatter.confidence ?? null,
          });
        }
      } catch {}
    }

    pending.sort((a, b) => (b.written_at ?? '').localeCompare(a.written_at ?? ''));
    return res.json({ pending, count: pending.length });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/review/:path(*)/approve
 */
router.post('/:businessId/review/*/approve', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const filePath = (req.params as any)[0] as string;
    const file = await engine.readFile(filePath);
    await engine.writeFile(filePath, file.content, {
      ...file.frontmatter,
      review_status: 'human_verified',
      verified_by: (req as any).session?.userId ?? 'human',
      verified_at: new Date().toISOString().split('T')[0],
    }, `review: verified ${filePath}`);
    return res.json({ ok: true, path: filePath, review_status: 'human_verified' });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/kb/:businessId/review/:path(*)/flag
 * Body: { reason }
 */
router.post('/:businessId/review/*/flag', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const filePath = (req.params as any)[0] as string;
    const file = await engine.readFile(filePath);
    await engine.writeFile(filePath, file.content, {
      ...file.frontmatter,
      review_status: 'flagged',
      flag_reason: req.body.reason ?? 'Flagged for review',
      flagged_by: (req as any).session?.userId ?? 'human',
      flagged_at: new Date().toISOString().split('T')[0],
    }, `review: flagged ${filePath}`);
    return res.json({ ok: true, path: filePath, review_status: 'flagged' });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * GET /api/kb/:businessId/health
 * KB health summary.
 */
router.get('/:businessId/health', async (req: Request, res: Response) => {
  try {
    const { engine } = await getEngine(req.params.businessId as string);
    const files = await engine.listFiles();
    const lint = await engine.lint();

    let agentWritten = 0, humanVerified = 0, pendingReview = 0, flagged = 0;
    let totalConfidence = 0, confidenceCount = 0;

    for (const f of files) {
      try {
        const file = await engine.readFile(f);
        const fm = file.frontmatter ?? {};
        if (fm.written_by === 'agent' || fm.written_by === 'llm') agentWritten++;
        if (fm.review_status === 'human_verified') humanVerified++;
        else if (fm.review_status === 'pending_review') pendingReview++;
        else if (fm.review_status === 'flagged') flagged++;
        if (fm.confidence != null) {
          totalConfidence += fm.confidence;
          confidenceCount++;
        }
      } catch {}
    }

    const avgConfidence = confidenceCount > 0 ? Math.round((totalConfidence / confidenceCount) * 100) / 100 : null;
    const healthScore = Math.max(0, Math.min(100,
      100 - (lint.dead_links.length * 2) - (lint.orphans.length * 3) - (flagged * 10) - (pendingReview > 10 ? 10 : 0)
    ));

    return res.json({
      total_pages: files.length,
      agent_written: agentWritten,
      human_verified: humanVerified,
      pending_review: pendingReview,
      flagged,
      contradictions_open: lint.contradictions.length,
      orphan_pages: lint.orphans.length,
      dead_links: lint.dead_links.length,
      avg_confidence: avgConfidence,
      health_score: healthScore,
    });
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
