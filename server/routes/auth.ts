import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';

import { isAuthenticated } from '../middleware/auth.js';
import db from '../db/db.js';

const router = Router();

/**
 * Generate a catch-up notification summarising what happened while the user was away.
 */
async function generateCatchUpNotification(hoursSince: number): Promise<void> {
  const since = new Date(Date.now() - hoursSince * 3600000).toISOString();

  const signalCount = (db.prepare(
    "SELECT COUNT(*) as n FROM signals WHERE created_at > ? AND status = 'open'"
  ).get(since) as any)?.n ?? 0;
  const tasksCompleted = (db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE completed_at > ?"
  ).get(since) as any)?.n ?? 0;
  const tasksPending = (db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE status = 'proposed'"
  ).get() as any)?.n ?? 0;
  const criticalSignals = (db.prepare(
    "SELECT COUNT(*) as n FROM signals WHERE created_at > ? AND severity = 'critical' AND status = 'open'"
  ).get(since) as any)?.n ?? 0;

  const hours = Math.round(hoursSince);
  let summary = `You were away for ${hours} hours. `;
  if (criticalSignals > 0) summary += `${criticalSignals} critical signal${criticalSignals > 1 ? 's' : ''} need attention. `;
  if (signalCount > 0) summary += `${signalCount} new signal${signalCount > 1 ? 's' : ''} detected. `;
  if (tasksCompleted > 0) summary += `${tasksCompleted} task${tasksCompleted > 1 ? 's' : ''} completed by agents. `;
  if (tasksPending > 0) summary += `${tasksPending} task${tasksPending > 1 ? 's' : ''} waiting for approval.`;

  db.prepare(`
    INSERT INTO notifications (id, severity, title, body, created_at)
    VALUES (lower(hex(randomblob(16))), ?, 'While you were away', ?, CURRENT_TIMESTAMP)
  `).run(criticalSignals > 0 ? 'alert' : 'info', summary.trim());
}

// Hash the env password once at module load time
let passwordHash: string | null = null;

async function getPasswordHash(): Promise<string> {
  if (passwordHash) return passwordHash;
  const rawPassword = process.env['ADMIN_PASSWORD'];
  if (!rawPassword) {
    throw new Error('ADMIN_PASSWORD environment variable is not set.');
  }
  const hash = await bcrypt.hash(rawPassword, 12);
  passwordHash = hash;
  return hash;
}

// Warm up hash on startup
getPasswordHash().catch(err => console.warn('[auth] Warning:', (err as Error).message));

/**
 * POST /api/auth/login
 * Body: { username, password }
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const expectedUsername = process.env['ADMIN_USERNAME'] || 'admin';
    if (username !== expectedUsername) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const rawPassword = process.env['ADMIN_PASSWORD'];
    if (!rawPassword) {
      return res.status(500).json({ error: 'Server authentication is not configured.' });
    }

    const valid = await bcrypt.compare(password, await getPasswordHash());
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    (req.session as any).userId = username;
    (req.session as any).loginAt = new Date().toISOString();

    // Track last login for catch-up briefing
    const lastLoginRow = db.prepare("SELECT value FROM settings WHERE key = 'last_login'").get() as { value: string } | null;
    const hoursSinceLogin = lastLoginRow
      ? (Date.now() - new Date(JSON.parse(lastLoginRow.value) as string).getTime()) / 3600000
      : 999;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('last_login', ?, CURRENT_TIMESTAMP)")
      .run(JSON.stringify(new Date().toISOString()));

    // Generate catch-up if away >24h (async, non-blocking)
    if (hoursSinceLogin > 24) {
      generateCatchUpNotification(hoursSinceLogin).catch(() => {});
    }

    return res.json({ ok: true, username });
  } catch (err) {
    console.error('[auth] Login error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy(err => {
    if (err) {
      console.error('[auth] Session destroy error:', err);
      return res.status(500).json({ error: 'Failed to log out.' });
    }
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
});

/**
 * GET /api/auth/me
 */
router.get('/me', isAuthenticated, (req: Request, res: Response) => {
  return res.json({ username: (req.session as any).userId, loginAt: (req.session as any).loginAt });
});

export default router;
