import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();
router.use(isAuthenticated);

/**
 * GET /api/notifications
 * Query: businessId, read (true|false|all), page, limit
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const { businessId, read, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(200, parseInt(String(limit), 10) || 50);
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [];
    const params: any[] = [];

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

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM notifications ${where}`).get(...params) as Record<string, unknown>)?.cnt ?? 0;
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
        pages: Math.ceil((total as number) / limitNum),
      },
    });
  } catch (err: any) {
    console.error('[notifications] List error:', err);
    return res.status(500).json({ error: 'Failed to list notifications.' });
  }
});

/**
 * PATCH /api/notifications/:id/read
 */
router.patch('/:id/read', (req: Request, res: Response) => {
  try {
    const notifId = req.params.id as string;
    const existing = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notifId) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Notification not found.' });

    if (existing.read_at) {
      return res.json({ ok: true, already_read: true, notification: existing });
    }

    db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ?').run(notifId);
    const updated = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notifId);

    return res.json({ ok: true, notification: updated });
  } catch (err: any) {
    console.error('[notifications] Mark read error:', err);
    return res.status(500).json({ error: 'Failed to mark notification as read.' });
  }
});

// ─── Email settings (Feature 5) ──────────────────────────────────────────────

router.get('/email/settings', async (req: Request, res: Response) => {
  try {
    const { getEmailProvider, getEmailConfig, getEmailRecipient } = await import('../notifications/email.js') as unknown as {
      getEmailProvider: () => string;
      getEmailConfig: (provider: string) => any;
      getEmailRecipient: () => string;
    };
    const provider = getEmailProvider();
    const config = getEmailConfig(provider);
    // Never return passwords / api keys — mask them
    const masked: any = { ...config };
    if (masked.pass) masked.pass = '••••••••';
    if (masked.api_key) masked.api_key = '••••••••' + String(masked.api_key).slice(-4);
    res.json({
      provider,
      config: masked,
      recipient: getEmailRecipient(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/email/settings', async (req: Request, res: Response) => {
  try {
    const { saveEmailProvider, saveEmailConfig, saveEmailRecipient, getEmailConfig } = await import('../notifications/email.js') as unknown as {
      saveEmailProvider: (provider: string) => void;
      saveEmailConfig: (provider: string, config: any) => void;
      saveEmailRecipient: (recipient: string) => void;
      getEmailConfig: (provider: string) => any;
    };
    const { provider, config, recipient } = req.body ?? {};
    if (provider) saveEmailProvider(provider);
    if (recipient !== undefined) saveEmailRecipient(recipient);
    if (config && provider) {
      // Merge with existing so we don't wipe unchanged secrets if client sent the masked version
      const existing = getEmailConfig(provider);
      const merged: any = { ...existing, ...config };
      // Drop masked sentinel values
      if (merged.pass === '••••••••') merged.pass = existing.pass;
      if (typeof merged.api_key === 'string' && merged.api_key.startsWith('••••••••')) {
        merged.api_key = existing.api_key;
      }
      saveEmailConfig(provider, merged);
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/email/test', async (req: Request, res: Response) => {
  try {
    const { sendEmail, getEmailRecipient } = await import('../notifications/email.js') as unknown as {
      sendEmail: (opts: { to: string; subject: string; html: string }) => Promise<any>;
      getEmailRecipient: () => string;
    };
    const { renderWeeklyBriefingEmail } = await import('../notifications/email-renderer.js') as unknown as {
      renderWeeklyBriefingEmail: (opts: any) => string;
    };
    const to = req.body?.to || getEmailRecipient();
    if (!to) return res.status(400).json({ error: 'No recipient configured' });

    const html = renderWeeklyBriefingEmail({
      business: { name: 'Test Business' },
      period: new Date().toLocaleDateString(),
      health_score: 82,
      health_direction: 'stable',
      summary: 'This is a test email sent from Blueprint to verify your email configuration.',
      metrics: [
        { label: 'Sessions', value: '1,248', change_label: '+12%', direction: 'up' },
        { label: 'Keywords', value: '84', change_label: '+3', direction: 'up' },
        { label: 'PageSpeed', value: '74', change_label: '-2', direction: 'down' },
      ],
      tasks_completed: [],
      priorities: ['Review this test email', 'Check spam folder if needed', 'Configure your business notifications'],
      generated_at: new Date().toISOString(),
    });

    const result = await sendEmail({
      to, subject: 'Blueprint — Test Email', html,
    });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[email] test error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
