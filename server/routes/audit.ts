import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

function parseRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    ...row,
    before_state: row['before_state'] ? JSON.parse(row['before_state'] as string) : null,
    after_state: row['after_state'] ? JSON.parse(row['after_state'] as string) : null,
    metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) : null,
  };
}

/**
 * GET /api/audit/:businessId
 * Query: page, limit, entity_type, actor, dateFrom, dateTo
 */
router.get('/:businessId', (req: Request, res: Response) => {
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

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(200, parseInt(String(limit), 10) || 50);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['(business_id = ? OR business_id IS NULL)'];
    const params: any[] = [businessId];

    if (entity_type) { conditions.push('entity_type = ?'); params.push(entity_type); }
    if (actor) { conditions.push('actor = ?'); params.push(actor); }
    if (dateFrom) { conditions.push('created_at >= ?'); params.push(dateFrom); }
    if (dateTo) { conditions.push('created_at <= ?'); params.push(dateTo); }

    const where = conditions.join(' AND ');

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM audit_log WHERE ${where}`).get(...params) as any)?.cnt ?? 0;
    const rows = db.prepare(`
      SELECT * FROM audit_log WHERE ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset) as Record<string, unknown>[];

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
