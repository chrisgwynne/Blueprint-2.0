/**
 * Chat API routes (Feature 3).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { processMessage } from '../chat/chat-engine.js';

const router = Router();
router.use(isAuthenticated);

function parseRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    ...row,
    mentions: row['mentions'] ? JSON.parse(row['mentions'] as string) : [],
    attachments: row['attachments'] ? JSON.parse(row['attachments'] as string) : [],
    metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) : {},
  };
}

// ─── List conversations ───────────────────────────────────────────────────────

router.get('/:businessId/conversations', (req: Request, res: Response) => {
  try {
    const businessId = req.params['businessId'] as string;
    const rows = db.prepare(`
      SELECT * FROM chat_conversations
      WHERE business_id = ? AND archived_at IS NULL
      ORDER BY updated_at DESC LIMIT 100
    `).all(businessId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Create conversation ──────────────────────────────────────────────────────

router.post('/:businessId/conversations', (req: Request, res: Response) => {
  try {
    const businessId = req.params['businessId'] as string;
    const { title } = (req.body ?? {}) as { title?: string };
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO chat_conversations
      (id, business_id, title, type, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'human', 'human', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, businessId, title ?? null);
    const row = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Get conversation + messages ──────────────────────────────────────────────

router.get('/:businessId/conversations/:id', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const businessId = req.params['businessId'] as string;
    const conversation = db.prepare(
      'SELECT * FROM chat_conversations WHERE id = ? AND business_id = ?'
    ).get(id, businessId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

    const messages = (db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500'
    ).all(id) as Record<string, unknown>[]).map(parseRow);

    res.json({ conversation, messages });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Archive ─────────────────────────────────────────────────────────────────

router.delete('/:businessId/conversations/:id', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const businessId = req.params['businessId'] as string;
    db.prepare(
      'UPDATE chat_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?'
    ).run(id, businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Get messages (paginated) ─────────────────────────────────────────────────

router.get('/:businessId/conversations/:id/messages', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const limit = Math.min(500, parseInt(String(req.query['limit'] ?? ''), 10) || 100);
    const rows = (db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?'
    ).all(id, limit) as Record<string, unknown>[]).map(parseRow);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Send a message ──────────────────────────────────────────────────────────

router.post('/:businessId/conversations/:id/messages', async (req: Request, res: Response) => {
  try {
    const businessId = req.params['businessId'] as string;
    const id = req.params['id'] as string;
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'content is required.' });
    }

    const conv = db.prepare(
      'SELECT id FROM chat_conversations WHERE id = ? AND business_id = ?'
    ).get(id, businessId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

    const responses = await processMessage({ content }, id, businessId);

    import('../bap/webhook-dispatcher.js').then((m: any) =>
      m.dispatchWebhookEvent('chat.message', { conversation_id: id, business_id: businessId, content, responses })
    ).catch(() => {});

    res.json({ ok: true, responses });
  } catch (err) {
    console.error('[chat] send error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
