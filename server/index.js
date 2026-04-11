import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Session Store (SQLite-backed) ──────────────────────────────────────────

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.db = options.db;
    this.ttl = options.ttl || 86400; // 24 hours in seconds

    // Prune expired sessions every 15 minutes
    setInterval(() => {
      try {
        this.db.prepare('DELETE FROM sessions WHERE expired <= ?').run(new Date().toISOString());
      } catch {}
    }, 15 * 60 * 1000).unref();
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (new Date(row.expired) <= new Date()) {
        this.destroy(sid, () => {});
        return callback(null, null);
      }
      let sess;
      try { sess = JSON.parse(row.sess); } catch { return callback(null, null); }
      callback(null, sess);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const maxAge = sess.cookie?.maxAge ?? this.ttl * 1000;
      const expired = new Date(Date.now() + (maxAge || this.ttl * 1000)).toISOString();
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
      `).run(sid, JSON.stringify(sess), expired);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sess, callback) {
    this.set(sid, sess, callback);
  }

  length(callback) {
    try {
      const count = this.db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE expired > ?').get(new Date().toISOString())?.cnt ?? 0;
      callback(null, count);
    } catch (err) {
      callback(err);
    }
  }

  clear(callback) {
    try {
      this.db.prepare('DELETE FROM sessions').run();
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 4000;

// Trust proxy (for correct IP behind reverse proxy)
app.set('trust proxy', 1);

// CORS
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4000').split(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: Origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Sessions
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error('[startup] CRITICAL: SESSION_SECRET environment variable is not set!');
}

app.use(session({
  secret: sessionSecret || 'blueprint-dev-secret-please-set-in-env',
  resave: false,
  saveUninitialized: false,
  store: new SqliteSessionStore({ db }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
  name: 'blueprint.sid',
}));

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch {}

  res.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    db: dbOk ? 'ok' : 'error',
    uptime: Math.round(process.uptime()),
  });
});

// Import and mount all route modules
const mountRoutes = async () => {
  const { default: authRoutes } = await import('./routes/auth.js');
  const { default: businessRoutes } = await import('./routes/businesses.js');
  const { default: dashboardRoutes } = await import('./routes/dashboard.js');
  const { default: signalsRoutes } = await import('./routes/signals.js');
  const { default: tasksRoutes } = await import('./routes/tasks.js');
  const { default: agentsRoutes } = await import('./routes/agents.js');
  const { default: connectorsRoutes } = await import('./routes/connectors.js');
  const { default: kbRoutes } = await import('./routes/kb.js');
  const { default: auditRoutes } = await import('./routes/audit.js');
  const { default: notificationsRoutes } = await import('./routes/notifications.js');
  const { default: oauthRoutes } = await import('./routes/oauth.js');
  const { default: connectorDataRoutes } = await import('./routes/connector-data.js');
  const { default: llmRoutes } = await import('./routes/llm.js');
  const { webhookHandler } = await import('./notifications/telegram.js');

  app.use('/api/auth', authRoutes);
  app.use('/api/oauth', oauthRoutes);
  app.use('/api/businesses', businessRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/signals', signalsRoutes);
  app.use('/api/tasks', tasksRoutes);
  app.use('/api/agents', agentsRoutes);
  app.use('/api/connectors', connectorsRoutes);
  app.use('/api/kb', kbRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/connector-data', connectorDataRoutes);
  app.use('/api/llm', llmRoutes);

  // System maintenance endpoint
  const { isAuthenticated: _isAuth } = await import('./middleware/auth.js');
  app.post('/api/system/db-init', _isAuth, async (req, res) => {
    try {
      const { execSync } = await import('child_process');
      const { resolve } = await import('path');
      const dbInitPath = resolve(__dirname, 'db/init.js');
      execSync(`bun ${dbInitPath}`, {
        env: { ...process.env },
        timeout: 15000,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[system] db-init error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Telegram webhook (no auth — validated by Telegram's IP or secret header)
  app.post('/api/telegram/webhook', (req, res, next) => {
    // Optional: validate secret token header
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (webhookSecret) {
      const providedSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (providedSecret !== webhookSecret) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    return webhookHandler(req, res).catch(next);
  });

  // Serve static client files in production
  if (process.env.NODE_ENV === 'production') {
    const clientDistPath = resolve(__dirname, '../client/dist');
    if (existsSync(clientDistPath)) {
      app.use(express.static(clientDistPath));
      app.get('*', (req, res) => {
        res.sendFile(resolve(clientDistPath, 'index.html'));
      });
    }
  }

  // 404 handler for unmatched API routes
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[express] Unhandled error:', err);

    if (err.message?.includes('CORS')) {
      return res.status(403).json({ error: err.message });
    }

    const status = err.status || err.statusCode || 500;
    const message = process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message;

    res.status(status).json({ error: message });
  });
};

// ─── Startup ─────────────────────────────────────────────────────────────────

async function start() {
  try {
    // Ensure data directory exists
    mkdirSync(resolve(__dirname, '../data'), { recursive: true });

    // Mount all routes
    await mountRoutes();

    // Start scheduler (after routes are ready)
    if (process.env.DISABLE_SCHEDULER !== 'true') {
      const { startScheduler } = await import('./jobs/scheduler.js');
      startScheduler();
    }

    // Start Telegram polling (non-blocking — reads bot config from business settings or env vars)
    try {
      const { startTelegramPolling } = await import('./notifications/telegram.js');
      startTelegramPolling();
    } catch (err) {
      console.warn('[startup] Telegram polling not started:', err.message);
    }

    // Build KB search index on startup
    try {
      const { listDocs } = await import('./kb/kb.js');
      const { buildIndex } = await import('./kb/search.js');
      const kbPath = process.env.KB_PATH || resolve(__dirname, '../kb');
      if (existsSync(kbPath)) {
        const docs = await listDocs(kbPath, null);
        buildIndex(docs);
      }
    } catch (err) {
      console.warn('[startup] KB index build failed (non-fatal):', err.message);
    }

    // Start server
    app.listen(PORT, () => {
      console.log(`[startup] Blueprint server running on http://localhost:${PORT}`);
      console.log(`[startup] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[startup] API health: http://localhost:${PORT}/api/health`);
    });
  } catch (err) {
    console.error('[startup] Fatal error during startup:', err);
    process.exit(1);
  }
}

start();

export default app;
