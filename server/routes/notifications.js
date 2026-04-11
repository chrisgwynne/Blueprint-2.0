import { Router } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

/**
 * GET /api/notifications
 * Query: businessId, read (true|false|all), page, limit
 */
router.get('/', (req, res) => {
  try {
    const { businessId, read, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, parseInt(limit, 10) || 50);
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];

    if (businessId) {
      conditions.push('(business_id = ? OR business_id IS NULL)');
      params.push(businessId);
    }

    if (read === 'true') {
      conditions.push('read_at IS NOT NULL');
    } else if (read === 'false') {
      conditions.push('read_at IS NULL');
    }
    // 'all' or undefined: no filter

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM notifications ${where}`).get(...params)?.cnt ?? 0;
    const rows = db.prepare(`
      SELECT * FROM notifications ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    return res.json({
      data: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('[notifications] List error:', err);
    return res.status(500).json({ error: 'Failed to list notifications.' });
  }
});

/**
 * PATCH /api/notifications/:id/read
 */
router.patch('/:id/read', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Notification not found.' });

    if (existing.read_at) {
      return res.json({ ok: true, already_read: true, notification: existing });
    }

    db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    const updated = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);

    return res.json({ ok: true, notification: updated });
  } catch (err) {
    console.error('[notifications] Mark read error:', err);
    return res.status(500).json({ error: 'Failed to mark notification as read.' });
  }
});

export default router;
