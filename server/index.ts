import { config as loadEnv } from 'dotenv';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import db, { DB_PATH } from './db/db.js';
import { isProductionAdminPasswordUnsafe } from './lib/startup-checks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from the repo root regardless of which directory the server
// process was launched from (bun run --cwd server sets CWD to server/).
loadEnv({ path: resolve(__dirname, '../.env') });

// ─── Session Store (SQLite-backed) ──────────────────────────────────────────

class SqliteSessionStore extends session.Store {
  private db: typeof db;
  private ttl: number;

  constructor(options: { db: typeof db; ttl?: number }) {
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

  get(sid: string, callback: (err: any, session?: session.SessionData | null) => void): void {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid) as { sess: string; expired: string } | undefined;
      if (!row) return callback(null, null);
      if (new Date(row.expired) <= new Date()) {
        this.destroy(sid, () => {});
        return callback(null, null);
      }
      let sess: session.SessionData;
      try { sess = JSON.parse(row.sess) as session.SessionData; } catch { return callback(null, null); }
      callback(null, sess);
    } catch (err) {
      callback(err);
    }
  }

  set(sid: string, sess: session.SessionData, callback?: (err?: any) => void): void {
    try {
      const maxAge = (sess.cookie as any)?.maxAge ?? this.ttl * 1000;
      const expired = new Date(Date.now() + (maxAge || this.ttl * 1000)).toISOString();
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
      `).run(sid, JSON.stringify(sess), expired);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  destroy(sid: string, callback?: (err?: any) => void): void {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  touch(sid: string, sess: session.SessionData, callback?: () => void): void {
    this.set(sid, sess, callback);
  }

  length(callback: (err: any, length?: number) => void): void {
    try {
      const count = (this.db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE expired > ?').get(new Date().toISOString()) as any)?.cnt ?? 0;
      callback(null, count);
    } catch (err) {
      callback(err);
    }
  }

  clear(callback?: (err?: any) => void): void {
    try {
      this.db.prepare('DELETE FROM sessions').run();
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
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
  if (process.env.NODE_ENV === 'production') {
    console.error('[startup] FATAL: SESSION_SECRET must be set in production. Refusing to start with a guessable session secret.');
    process.exit(1);
  }
  console.error('[startup] CRITICAL: SESSION_SECRET environment variable is not set! Using an insecure dev-only fallback.');
}

// Admin credentials — refuse to start in production with a known-default
// password (the .env.example placeholder is 'changeme'), or with none set
// at all. Mirrors the SESSION_SECRET fail-closed check above.
if (isProductionAdminPasswordUnsafe(process.env.NODE_ENV, process.env.ADMIN_PASSWORD)) {
  console.error(
    '[startup] FATAL: ADMIN_PASSWORD must be set to a non-default value in production. ' +
    'Refusing to start with a default/guessable admin password.'
  );
  process.exit(1);
}

app.use(session({
  secret: sessionSecret || 'blueprint-dev-secret-please-set-in-env',
  resave: false,
  saveUninitialized: false,
  store: new SqliteSessionStore({ db }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
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
  // bap.ts mounts server/routes/bap-{goals,connectors,outcomes,runs,audit}.js
  // internally as sub-routers (see its own docstring) — mounting them
  // separately here too would duplicate bapAuth's work per request.
  const { default: bapRoutes } = await import('./routes/bap.js');
  const { default: publicApiRoutes } = await import('./routes/public-api.js');
  const { default: exportRoutes } = await import('./routes/export.js');
  const { default: systemHealthRoutes } = await import('./routes/system-health.js');
  const { default: outcomesRoutes } = await import('./routes/outcomes.js');
  const { default: receiptsRoutes } = await import('./routes/receipts.js');
  const { default: digestRoutes } = await import('./routes/digest.js');
  // Explanations (#60) — "why did Blueprint do this?" for tasks, decision
  // memory rows and hiring decisions. A pure read over the records #53,
  // #61, #63, #66, #68 and #70 already author; it computes nothing new.
  const { default: explanationsRoutes } = await import('./routes/explanations.js');
  const { default: chatRoutes } = await import('./routes/chat.js');
  const { default: workflowsRoutes } = await import('./routes/workflows.js');
  const { default: goalsRoutes } = await import('./routes/goals.js');
  const { default: projectsRoutes } = await import('./routes/projects.js');
  const { default: timelineRoutes } = await import('./routes/timeline.js');
  const { default: agentStatusRoutes } = await import('./routes/agent-status.js');
  const { default: agentSettingsRoutes } = await import('./routes/agent-settings.js');
  const { default: roiRoutes } = await import('./routes/roi.js');
  const { default: brainRoutes } = await import('./routes/brain.js');
  const { default: scenariosRoutes } = await import('./routes/scenarios.js');
  const { default: comparisonsRoutes } = await import('./routes/comparisons.js');
  const { default: conflictsRoutes } = await import('./routes/conflicts.js');
  const { default: retrospectivesRoutes } = await import('./routes/retrospectives.js');
  const { default: investigationsRoutes } = await import('./routes/investigations.js');
  const { default: goalSuggestionsRoutes } = await import('./routes/goal-suggestions.js');
  const { default: securityRoutes } = await import('./routes/security.js');
  // Phase 3 — session-authenticated mirrors of the BAP-only Phase 3
  // surfaces (bap-decisions.ts, bap-graph.ts, bap-review.ts), for the
  // dashboard. Same underlying engines, isAuthenticated instead of a BAP
  // key — see each file's docstring.
  const { default: decisionsRoutes } = await import('./routes/decisions.js');
  // Decision Centre (#61) — the pending-review queue. decisions.ts above is
  // the read-only "why did we decide this" history; this is what still needs
  // a human, derived from tasks and classified by the #68 operating policy.
  const { default: decisionQueueRoutes } = await import('./routes/decision-queue.js');
  // Executive command centre (#59) — the cross-business decision view. The
  // one deliberately multi-business read in the dashboard API; it joins the
  // decision queue, receipts, ROI and connector health that the per-business
  // surfaces above already own, and computes nothing of its own.
  const { default: commandCentreRoutes } = await import('./routes/command-centre.js');
  const { default: graphRoutes } = await import('./routes/graph.js');
  const { default: reviewRoutes } = await import('./routes/review.js');
  // Phase 2-INT — Autonomous Intelligence Foundation: Business Profile,
  // Action Registry, Connector Confidence, World Model, System Issues.
  const { default: intelligenceRoutes } = await import('./routes/intelligence.js');
  const { default: trustRoutes } = await import('./routes/trust.js');
  const { default: operatingPoliciesRoutes } = await import('./routes/operating-policies.js');
  const { default: socialPublishingRoutes } = await import('./routes/social-publishing.js');
  const { default: socialMediaServingRoutes } = await import('./routes/social-media-serving.js');
  const { sseHandler } = await import('./lib/sse-bus.js');
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
  app.use('/api/receipts', receiptsRoutes);
  app.use('/api/digest', digestRoutes);
  app.use('/api/explanations', explanationsRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/workflows', workflowsRoutes);
  app.use('/api/goals', goalsRoutes);
  app.use('/api/projects', projectsRoutes);
  app.use('/api/timeline', timelineRoutes);
  app.use('/api/agents-status', agentStatusRoutes);
  app.use('/api/agent-settings', agentSettingsRoutes);
  app.use('/api/roi', roiRoutes);
  app.use('/api/brain', brainRoutes);
  app.use('/api/scenarios', scenariosRoutes);
  app.use('/api/comparisons', comparisonsRoutes);
  app.use('/api/conflicts', conflictsRoutes);
  app.use('/api/retrospectives', retrospectivesRoutes);
  app.use('/api/investigations', investigationsRoutes);
  app.use('/api/goal-suggestions', goalSuggestionsRoutes);
  app.use('/api/security', securityRoutes);
  app.use('/api/decisions', decisionsRoutes);
  app.use('/api/decision-queue', decisionQueueRoutes);
  app.use('/api/command-centre', commandCentreRoutes);
  app.use('/api/graph', graphRoutes);
  app.use('/api/review', reviewRoutes);
  app.use('/api/intelligence', intelligenceRoutes);
  app.use('/api/trust', trustRoutes);
  app.use('/api/operating-policies', operatingPoliciesRoutes);
  app.use('/api/social-publishing', socialPublishingRoutes);
  // Public media serving — no auth, secured by HMAC-signed time-limited URLs
  app.use('/social-media', socialMediaServingRoutes);
  app.get('/api/dashboard/stream/:businessId', (req, res, next) => {
    // Session-authed — uses same cookie
    if (!(req.session as any)?.userId) return res.status(401).json({ error: 'Unauthorized' });
    sseHandler(req, res);
  });

  // API key management (session auth — used by Settings UI)
  const { isAuthenticated: _isAuth } = await import('./middleware/auth.js');
  const { createApiKeyRecord } = await import('./routes/public-api.js');

  // ─── Instance settings (no auth — used by frontend on load) ────────────
  app.get('/api/settings/instance', (_req, res) => {
    const get = (k: string, d: unknown) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined;
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
      const tableCount = (db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'").get() as any)?.n ?? 0;
      // Reuse the DB module's own resolved path rather than independently
      // re-resolving DATABASE_PATH here — see server/db/db.ts /
      // server/db/resolve-db-path.ts (issue #41).
      const dbPath = DB_PATH;
      let dbSizeMB = 0;
      try {
        const { statSync } = await import('fs');
        dbSizeMB = Math.round(statSync(dbPath).size / 1048576 * 10) / 10;
      } catch {}

      // Connectors
      const connectors = (db.prepare(`
        SELECT c.id, c.type, c.status, c.last_sync, c.last_error, b.name as business
        FROM connectors c JOIN businesses b ON c.business_id = b.id
      `).all() as { id: string; type: string; status: string; last_sync: string | null; last_error: string | null; business: string }[]).map(c => {
        const hoursSince = c.last_sync ? (Date.now() - new Date(c.last_sync).getTime()) / 3600000 : null;
        const thresholds: Record<string, number> = { pagespeed: 48, gsc: 24, ga4: 12, shopify: 12, uptimerobot: 2 };
        const threshold = thresholds[c.type] ?? 24;
        return {
          id: c.id, type: c.type, business: c.business,
          status: c.status === 'connected' && hoursSince !== null && hoursSince > threshold ? 'stale' : c.status,
          last_sync: c.last_sync, hours_since_sync: hoursSince ? Math.round(hoursSince * 10) / 10 : null,
          stale_threshold_hours: threshold, last_error: c.last_error,
        };
      });

      // Agents
      const conductorRow = db.prepare("SELECT last_run FROM agents WHERE id = 'conductor'").get() as any;
      const failCount24h = (db.prepare(
        "SELECT COUNT(*) as n FROM agent_runs WHERE status = 'failed' AND started_at > datetime('now', '-24 hours')"
      ).get() as any)?.n ?? 0;
      const runCount24h = (db.prepare(
        "SELECT COUNT(*) as n FROM agent_runs WHERE started_at > datetime('now', '-24 hours')"
      ).get() as any)?.n ?? 0;
      const consecutiveFails = db.prepare(
        "SELECT status FROM agent_runs WHERE agent_id = 'conductor' ORDER BY started_at DESC LIMIT 5"
      ).all() as { status: string }[];
      const conductorConsecFails = consecutiveFails.findIndex((r: { status: string }) => r.status !== 'failed');

      // Costs
      const todayCost = (db.prepare("SELECT COALESCE(SUM(cost_usd),0) as t FROM cost_daily WHERE date = date('now')").get() as any)?.t ?? 0;
      const monthCost = (db.prepare("SELECT COALESCE(SUM(cost_usd),0) as t FROM cost_daily WHERE date >= date('now','start of month')").get() as any)?.t ?? 0;
      const budget = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'cost_monthly_budget_usd'").get() as any)?.value ?? '20');
      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      const dayOfMonth = new Date().getDate();
      const forecastEnd = dayOfMonth > 0 ? (monthCost / dayOfMonth) * daysInMonth : 0;

      // Paused?
      const paused = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'agents_globally_paused'").get() as any)?.value ?? 'false');

      // Overall status
      const hasError = connectors.some((c: { status: string }) => c.status === 'error');
      const hasStale = connectors.some((c: { status: string }) => c.status === 'stale');
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
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // ─── Kill switch endpoints ──────────────────────────────────────────────
  app.post('/api/settings/agents/pause', _isAuth, (req, res) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('agents_globally_paused', 'true', CURRENT_TIMESTAMP)").run();
    try {
      import('./bap/webhook-dispatcher.js').then((m: any) =>
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
    const keys = db.prepare('SELECT id, name, key_prefix, scopes, rate_limit, last_used, total_calls, expires_at, created_at FROM api_keys ORDER BY created_at DESC').all() as any[];
    res.json({ keys: keys.map((k) => ({ ...k, scopes: JSON.parse(k.scopes ?? '[]') })) });
  });

  app.post('/api/admin/api-keys', _isAuth, async (req, res) => {
    try {
      const { name, scopes = ['read'], rate_limit = 1000, expires_at } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required.' });
      const result = await createApiKeyRecord(name, scopes, rate_limit, expires_at ?? null);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/api-keys/:id', _isAuth, (req, res) => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id as string);
    res.json({ ok: true });
  });

  // ─── Blueprint GitHub settings ─────────────────────────────────────────────
  app.get('/api/settings/blueprint-github/status', _isAuth, async (req, res) => {
    try {
      const { isBlueprintGitHubConfigured } = await import('./lib/blueprint-github.js');
      const status = await isBlueprintGitHubConfigured(db);
      res.json(status);
    } catch (err: any) {
      res.json({ configured: false, error: err.message });
    }
  });

  app.post('/api/settings/blueprint-github', _isAuth, (req, res) => {
    const { token, enabled } = req.body ?? {};
    const upsert = db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    if (token   !== undefined) upsert.run('blueprint_github_token',   JSON.stringify(token));
    if (enabled !== undefined) upsert.run('blueprint_github_enabled', JSON.stringify(Boolean(enabled)));
    res.json({ ok: true });
  });

  app.post('/api/settings/blueprint-github/test', _isAuth, async (req, res) => {
    try {
      const { isBlueprintGitHubConfigured } = await import('./lib/blueprint-github.js');
      const status = await isBlueprintGitHubConfigured(db);
      res.json(status);
    } catch (err: any) {
      res.json({ configured: false, error: err.message });
    }
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
    } catch (err: any) {
      console.error('[system] db-init error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Telegram webhook (no auth — validated by Telegram's IP or secret header)
  app.post('/api/telegram/webhook', (req, res, next) => {
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (webhookSecret) {
      const providedSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (providedSecret !== webhookSecret) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    return webhookHandler(req, res).catch(next);
  });

  // Docs routes — served at /docs, no auth required
  const { serveDoc, serveDocIndex, searchDocs } = await import('./docs/docs-engine.js');
  app.use('/docs/assets', express.static(resolve(__dirname, '../docs/assets')));
  app.get('/docs/search', searchDocs);
  app.get('/docs', serveDocIndex);
  app.get('/docs/:section', serveDocIndex);
  app.get('/docs/:section/:page', serveDoc);

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
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
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

async function start(): Promise<void> {
  // Declared before the shutdown handlers below so a signal arriving during
  // startup doesn't hit a temporal-dead-zone ReferenceError.
  let server: ReturnType<typeof app.listen> | undefined;
  try {
    // Ensure data directory exists
    mkdirSync(resolve(__dirname, '../data'), { recursive: true });

    // Mount all routes
    await mountRoutes();

    // Ensure Conductor agent is seeded and installed (idempotent — safe on every boot)
    try {
      const { existsSync: fsExists, mkdirSync: fsMkdir, cpSync, readFileSync: fsRead, writeFileSync: fsWrite } = await import('fs');
      const { resolve: fsResolve, join: fsJoin } = await import('path');
      const yaml = (await import('js-yaml')).default;
      const AGENTS_DIR = fsResolve(__dirname, 'agents');
      const TEMPLATES_DIR = fsJoin(AGENTS_DIR, 'templates');
      const liveDir = fsJoin(AGENTS_DIR, 'conductor');
      const templateDir = fsJoin(TEMPLATES_DIR, 'conductor');
      const liveProfile = fsJoin(liveDir, 'profile.yaml');

      if (!fsExists(liveProfile) && fsExists(templateDir)) {
        fsMkdir(liveDir, { recursive: true });
        cpSync(templateDir, liveDir, { recursive: true });
      }

      db.prepare(`
        INSERT INTO agents (id, profile_path, name, status, created_at)
        VALUES ('conductor', 'server/agents/conductor/profile.yaml', 'Conductor', 'active', CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO NOTHING
      `).run();

      console.log('[startup] Conductor ready.');
    } catch (err: any) {
      console.warn('[startup] Conductor seed skipped:', err.message);
    }

    // Seed built-in workflows for businesses with none (idempotent)
    try {
      const { seedAllBusinesses } = await import('./workflows/built-in-templates.js') as any;
      seedAllBusinesses();
    } catch (err: any) {
      console.warn('[startup] workflow seed skipped:', err.message);
    }

    // Brain — seed action_windows (idempotent)
    try {
      const { seedActionWindows } = await import('./brain/action-windows.js') as any;
      seedActionWindows();
    } catch (err: any) {
      console.warn('[startup] action-windows seed skipped:', err.message);
    }

    // Start scheduler (after routes are ready)
    if (process.env.DISABLE_SCHEDULER !== 'true') {
      const { startScheduler } = await import('./jobs/scheduler.js');
      startScheduler();
    }

    // Start Telegram polling
    try {
      const { startTelegramPolling, stopTelegramPolling } = await import('./notifications/telegram.js');
      startTelegramPolling();

      // Graceful shutdown — stop polling and close the server cleanly
      const shutdown = async (signal: string) => {
        console.log(`[startup] Received ${signal}, shutting down gracefully...`);
        stopTelegramPolling();
        if (server) {
          server.close(() => {
            console.log('[startup] HTTP server closed.');
            process.exit(0);
          });
          // Force exit after 10s if graceful close hangs
          setTimeout(() => { console.error('[startup] Force-exit after timeout.'); process.exit(1); }, 10_000);
        } else {
          process.exit(0);
        }
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (err: any) {
      console.warn('[startup] Telegram polling not started:', err.message);
    }

    // Start server
    server = app.listen(PORT, () => {
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
