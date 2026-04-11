import { Router } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    before_state: row.before_state ? JSON.parse(row.before_state) : null,
    after_state: row.after_state ? JSON.parse(row.after_state) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

/**
 * GET /api/audit/:businessId
 * Query: page, limit, entity_type, actor, dateFrom, dateTo
 */
router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const {
      page = 1,
      limit = 50,
      entity_type,
      actor,
      dateFrom,
      dateTo,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, parseInt(limit, 10) || 50);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['(business_id = ? OR business_id IS NULL)'];
    const params = [businessId];

    if (entity_type) { conditions.push('entity_type = ?'); params.push(entity_type); }
    if (actor) { conditions.push('actor = ?'); params.push(actor); }
    if (dateFrom) { conditions.push('created_at >= ?'); params.push(dateFrom); }
    if (dateTo) { conditions.push('created_at <= ?'); params.push(dateTo); }

    const where = conditions.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM audit_log WHERE ${where}`).get(...params)?.cnt ?? 0;
    const rows = db.prepare(`
      SELECT * FROM audit_log WHERE ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    return res.json({
      data: rows.map(parseRow),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('[audit] List error:', err);
    return res.status(500).json({ error: 'Failed to load audit log.' });
  }
});

export default router;
