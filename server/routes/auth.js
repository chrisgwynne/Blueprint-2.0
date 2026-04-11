import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();

// Hash the env password once at module load time
let passwordHash = null;

async function getPasswordHash() {
  if (passwordHash) return passwordHash;
  const rawPassword = process.env.ADMIN_PASSWORD;
  if (!rawPassword) {
    throw new Error('ADMIN_PASSWORD environment variable is not set.');
  }
  passwordHash = await bcrypt.hash(rawPassword, 12);
  return passwordHash;
}

// Warm up hash on startup
getPasswordHash().catch(err => console.warn('[auth] Warning:', err.message));

/**
 * POST /api/auth/login
 * Body: { username, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
    if (username !== expectedUsername) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const rawPassword = process.env.ADMIN_PASSWORD;
    if (!rawPassword) {
      return res.status(500).json({ error: 'Server authentication is not configured.' });
    }

    const valid = await bcrypt.compare(password, await getPasswordHash());
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    req.session.userId = username;
    req.session.loginAt = new Date().toISOString();

    return res.json({ ok: true, username });
  } catch (err) {
    console.error('[auth] Login error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
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
router.get('/me', isAuthenticated, (req, res) => {
  return res.json({ username: req.session.userId, loginAt: req.session.loginAt });
});

export default router;
