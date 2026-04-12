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
  const { default: bapRoutes } = await import('./routes/bap.js');
  const { default: publicApiRoutes } = await import('./routes/public-api.js');
  const { default: exportRoutes } = await import('./routes/export.js');
  const { default: systemHealthRoutes } = await import('./routes/system-health.js');
  const { default: outcomesRoutes } = await import('./routes/outcomes.js');
  const { default: chatRoutes } = await import('./routes/chat.js');
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
  app.use('/api/bap/v1', bapRoutes);
  app.use('/api/v1', publicApiRoutes);
  app.use('/api/export', exportRoutes);
  app.use('/api/system', systemHealthRoutes);
  app.use('/api/outcomes', outcomesRoutes);
  app.use('/api/chat', chatRoutes);

  // API key management (session auth — used by Settings UI)
  const { isAuthenticated: _isAuth } = await import('./middleware/auth.js');
  const { createApiKeyRecord } = await import('./routes/public-api.js');

  // ─── Instance settings (no auth — used by frontend on load) ────────────
  app.get('/api/settings/instance', (_req, res) => {
    const get = (k, d) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      return row ? JSON.parse(row.value) : d;
    };
    res.json({
      name: get('instance_name', 'Blueprint'),
      accent_color: get('instance_accent_color', '#3b82f6'),
      discovery_public: get('bap_discovery_public', true),
    });
  });

  // ─── System Health Endpoint ─────────────────────────────────────────────
  app.get('/api/system/health', _isAuth, async (req, res) => {
    try {
      const startTime = process.uptime();

      // DB health
      const tableCount = db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'").get()?.n ?? 0;
      const dbPath = process.env.DATABASE_PATH || './data/blueprint.db';
      let dbSizeMB = 0;
      try {
        const { statSync } = await import('fs');
        dbSizeMB = Math.round(statSync(dbPath).size / 1048576 * 10) / 10;
      } catch {}

      // Connectors
      const connectors = db.prepare(`
        SELECT c.id, c.type, c.status, c.last_sync, c.last_error, b.name as business
        FROM connectors c JOIN businesses b ON c.business_id = b.id
      `).all().map(c => {
        const hoursSince = c.last_sync ? (Date.now() - new Date(c.last_sync).getTime()) / 3600000 : null;
        const thresholds = { pagespeed: 48, gsc: 24, ga4: 12, shopify: 12, uptimerobot: 2 };
        const threshold = thresholds[c.type] ?? 24;
        return {
          id: c.id, type: c.type, business: c.business,
          status: c.status === 'connected' && hoursSince > threshold ? 'stale' : c.status,
          last_sync: c.last_sync, hours_since_sync: hoursSince ? Math.round(hoursSince * 10) / 10 : null,
          stale_threshold_hours: threshold, last_error: c.last_error,
        };
      });

      // Agents
      const conductorRow = db.prepare("SELECT last_run FROM agents WHERE id = 'conductor'").get();
      const failCount24h = db.prepare(
        "SELECT COUNT(*) as n FROM agent_runs WHERE status = 'failed' AND started_at > datetime('now', '-24 hours')"
      ).get()?.n ?? 0;
      const runCount24h = db.prepare(
        "SELECT COUNT(*) as n FROM agent_runs WHERE started_at > datetime('now', '-24 hours')"
      ).get()?.n ?? 0;
      const consecutiveFails = db.prepare(
        "SELECT status FROM agent_runs WHERE agent_id = 'conductor' ORDER BY started_at DESC LIMIT 5"
      ).all();
      const conductorConsecFails = consecutiveFails.findIndex(r => r.status !== 'failed');

      // Costs
      const todayCost = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as t FROM cost_daily WHERE date = date('now')").get()?.t ?? 0;
      const monthCost = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as t FROM cost_daily WHERE date >= date('now','start of month')").get()?.t ?? 0;
      const budget = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'cost_monthly_budget_usd'").get()?.value ?? '20');
      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      const dayOfMonth = new Date().getDate();
      const forecastEnd = dayOfMonth > 0 ? (monthCost / dayOfMonth) * daysInMonth : 0;

      // Paused?
      const paused = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'agents_globally_paused'").get()?.value ?? 'false');

      // Overall status
      const hasError = connectors.some(c => c.status === 'error');
      const hasStale = connectors.some(c => c.status === 'stale');
      const conductorFailing = conductorConsecFails >= 3 || (conductorConsecFails === -1 && consecutiveFails.length >= 3);
      const budgetCritical = budget > 0 && (monthCost / budget) >= 0.9;

      let status = 'healthy';
      if (hasError || conductorFailing || budgetCritical) status = 'critical';
      else if (hasStale || failCount24h > 0 || paused) status = 'degraded';

      res.json({
        status,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        uptime_seconds: Math.round(startTime),
        agents_paused: paused,
        database: { status: 'ok', size_mb: dbSizeMB, tables: tableCount },
        connectors,
        agents: {
          conductor_last_run: conductorRow?.last_run ?? null,
          conductor_consecutive_failures: conductorFailing ? (conductorConsecFails === -1 ? consecutiveFails.length : conductorConsecFails) : 0,
          conductor_status: conductorFailing ? 'failing' : 'ok',
          total_runs_24h: runCount24h,
          total_failures_24h: failCount24h,
        },
        costs: {
          today_usd: Math.round(todayCost * 100) / 100,
          this_month_usd: Math.round(monthCost * 100) / 100,
          monthly_budget_usd: budget,
          budget_used_pct: budget > 0 ? Math.round((monthCost / budget) * 100) : 0,
          forecast_month_end_usd: Math.round(forecastEnd * 100) / 100,
        },
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // ─── Kill switch endpoints ──────────────────────────────────────────────
  app.post('/api/settings/agents/pause', _isAuth, (req, res) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('agents_globally_paused', 'true', CURRENT_TIMESTAMP)").run();
    try {
      import('./bap/webhook-dispatcher.js').then(m =>
        m.dispatchWebhookEvent('system.agents_paused', { paused: true })
      );
    } catch {}
    res.json({ ok: true, agents_paused: true });
  });

  app.post('/api/settings/agents/resume', _isAuth, (req, res) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('agents_globally_paused', 'false', CURRENT_TIMESTAMP)").run();
    res.json({ ok: true, agents_paused: false });
  });

  app.get('/api/admin/api-keys', _isAuth, (_req, res) => {
    const keys = db.prepare('SELECT id, name, key_prefix, scopes, rate_limit, last_used, total_calls, expires_at, created_at FROM api_keys ORDER BY created_at DESC').all();
    res.json({ keys: keys.map((k) => ({ ...k, scopes: JSON.parse(k.scopes ?? '[]') })) });
  });

  app.post('/api/admin/api-keys', _isAuth, async (req, res) => {
    try {
      const { name, scopes = ['read'], rate_limit = 1000, expires_at } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required.' });
      const result = await createApiKeyRecord(name, scopes, rate_limit, expires_at ?? null);
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/api-keys/:id', _isAuth, (req, res) => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // System maintenance endpoint
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

    // KB engines are now business-scoped and lazy-initialized on first access
    // (see /server/kb/kb-engine.js + /server/routes/kb.js). No global index
    // to build at startup.

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
