/**
 * Chat API routes (Feature 3).
 */
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { processMessage } from '../chat/chat-engine.js';

const router = Router();
router.use(isAuthenticated);

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    mentions: row.mentions ? JSON.parse(row.mentions) : [],
    attachments: row.attachments ? JSON.parse(row.attachments) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  };
}

// ─── List conversations ───────────────────────────────────────────────────────

router.get('/:businessId/conversations', (req, res) => {
  try {
    const { businessId } = req.params;
    const rows = db.prepare(`
      SELECT * FROM chat_conversations
      WHERE business_id = ? AND archived_at IS NULL
      ORDER BY updated_at DESC LIMIT 100
    `).all(businessId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create conversation ──────────────────────────────────────────────────────

router.post('/:businessId/conversations', (req, res) => {
  try {
    const { businessId } = req.params;
    const { title } = req.body ?? {};
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO chat_conversations
      (id, business_id, title, type, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'human', 'human', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, businessId, title ?? null);
    const row = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get conversation + messages ──────────────────────────────────────────────

router.get('/:businessId/conversations/:id', (req, res) => {
  try {
    const conversation = db.prepare(
      'SELECT * FROM chat_conversations WHERE id = ? AND business_id = ?'
    ).get(req.params.id, req.params.businessId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

    const messages = db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500'
    ).all(req.params.id).map(parseRow);

    res.json({ conversation, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Archive ─────────────────────────────────────────────────────────────────

router.delete('/:businessId/conversations/:id', (req, res) => {
  try {
    const { id, businessId } = req.params;
    db.prepare(
      'UPDATE chat_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?'
    ).run(id, businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get messages (paginated) ─────────────────────────────────────────────────

router.get('/:businessId/conversations/:id/messages', (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const rows = db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?'
    ).all(id, limit).map(parseRow);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Send a message ──────────────────────────────────────────────────────────

router.post('/:businessId/conversations/:id/messages', async (req, res) => {
  try {
    const { businessId, id } = req.params;
    const { content } = req.body ?? {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'content is required.' });
    }

    const conv = db.prepare(
      'SELECT id FROM chat_conversations WHERE id = ? AND business_id = ?'
    ).get(id, businessId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

    const responses = await processMessage({ content }, id, businessId);

    res.json({ ok: true, responses });
  } catch (err) {
    console.error('[chat] send error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
