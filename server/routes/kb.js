import { Router } from 'express';
import crypto from 'crypto';
import { isAuthenticated } from '../middleware/auth.js';
import { listDocs, getDoc, saveDoc, deleteDoc, getHistory } from '../kb/kb.js';
import { search, buildIndex } from '../kb/search.js';
import db from '../db/db.js';
import { resolve } from 'path';

const router = Router();
router.use(isAuthenticated);

const KB_PATH = process.env.KB_PATH || resolve(process.cwd(), '../kb');

/**
 * GET /api/kb?q=search&businessId=xxx
 */
router.get('/', async (req, res) => {
  try {
    const { q, businessId } = req.query;
    const docs = await listDocs(KB_PATH, businessId ?? null);

    if (q && q.trim()) {
      const results = search(q.trim(), 20);
      const pathSet = new Set(results);
      const filtered = docs.filter(d => pathSet.has(d.path) || d.title?.toLowerCase().includes(q.toLowerCase()));
      return res.json(filtered);
    }

    return res.json(docs);
  } catch (err) {
    console.error('[kb] List error:', err);
    return res.status(500).json({ error: 'Failed to list KB docs.' });
  }
});

/**
 * GET /api/kb/:path(*)
 */
router.get('/:docPath(*)', async (req, res) => {
  try {
    const docPath = req.params.docPath;
    const doc = await getDoc(KB_PATH, docPath);

    if (doc === null) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const history = await getHistory(KB_PATH, docPath).catch(() => []);

    return res.json({ path: docPath, content: doc, history });
  } catch (err) {
    console.error('[kb] Get error:', err);
    return res.status(500).json({ error: 'Failed to get KB doc.' });
  }
});

/**
 * POST /api/kb/:path(*)
 * Body: { content, message?, businessId?, title?, tags? }
 */
router.post('/:docPath(*)', async (req, res) => {
  try {
    const docPath = req.params.docPath;
    const { content, message, businessId, title, tags } = req.body;

    if (content === undefined) return res.status(400).json({ error: 'content is required.' });

    await saveDoc(KB_PATH, docPath, content, message ?? `Update ${docPath}`);

    // Update DB record
    const words = content.trim().split(/\s+/).length;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO kb_docs (id, business_id, path, title, tags, word_count, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        tags = excluded.tags,
        word_count = excluded.word_count,
        updated_at = excluded.updated_at
    `).run(
      crypto.randomUUID(),
      businessId ?? null,
      docPath,
      title ?? extractTitle(content),
      JSON.stringify(tags ?? []),
      words,
      now,
      now
    );

    // Rebuild search index
    const docs = await listDocs(KB_PATH, null);
    buildIndex(docs);

    return res.json({ ok: true, path: docPath });
  } catch (err) {
    console.error('[kb] Save error:', err);
    return res.status(500).json({ error: 'Failed to save KB doc.' });
  }
});

/**
 * DELETE /api/kb/:path(*)
 */
router.delete('/:docPath(*)', async (req, res) => {
  try {
    const docPath = req.params.docPath;
    await deleteDoc(KB_PATH, docPath);
    db.prepare('DELETE FROM kb_docs WHERE path = ?').run(docPath);

    const docs = await listDocs(KB_PATH, null);
    buildIndex(docs);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[kb] Delete error:', err);
    return res.status(500).json({ error: 'Failed to delete KB doc.' });
  }
});

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : null;
}

export default router;
