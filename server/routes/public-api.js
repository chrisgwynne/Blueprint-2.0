/**
 * Blueprint Public API — /api/v1/
 *
 * General-purpose REST API for integrations, Zapier, custom scripts.
 * Authenticated via `Authorization: Bearer bpk_xxx` header.
 *
 * Separate from BAP (which is for autonomous agents) — this is for
 * tools, webhooks, and developers pushing data in or pulling data out.
 */
import { Router } from 'express';
import crypto from 'crypto';
import db, { generateId } from '../db/db.js';

const router = Router();

// ─── Auth ───────────────────────────────────────────────────────────────────

function keyPrefix(key) { return String(key).slice(0, 12); }

async function apiKeyAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer bpk_')) {
    return res.status(401).json({ error: 'Authorization: Bearer bpk_xxx header required.' });
  }
  const rawKey = header.replace('Bearer ', '');
  const prefix = keyPrefix(rawKey);

  const row = db.prepare('SELECT * FROM api_keys WHERE key_prefix = ?').get(prefix);
  if (!row) return res.status(401).json({ error: 'Invalid API key.' });

  // Verify hash
  const valid = await Bun.password.verify(rawKey, row.key_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid API key.' });

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: 'API key expired.' });
  }

  // Update last_used + counter
  db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP, total_calls = total_calls + 1 WHERE id = ?').run(row.id);

  req.apiKey = row;
  req.apiKeyScopes = safeJSON(row.scopes, ['read']);
  next();
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiKeyScopes.includes(scope) && !req.apiKeyScopes.includes('admin')) {
      return res.status(403).json({ error: `Scope "${scope}" required.` });
    }
    next();
  };
}

// Simple per-key rate limiter (in-memory sliding window)
const windows = new Map();
function rateLimit(req, res, next) {
  const keyId = req.apiKey?.id ?? req.ip;
  const limit = req.apiKey?.rate_limit ?? 1000;
  const windowMs = 3600_000; // 1 hour
  const now = Date.now();
  const key = `apk:${keyId}`;

  if (!windows.has(key)) windows.set(key, []);
  const calls = windows.get(key).filter((t) => now - t < windowMs);
  calls.push(now);
  windows.set(key, calls);

  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - calls.length)));

  if (calls.length > limit) {
    return res.status(429).json({ error: 'Rate limit exceeded.', retry_after_seconds: 3600 });
  }
  next();
}

router.use(apiKeyAuth);
router.use(rateLimit);

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeJSON(val, fallback = []) {
  if (Array.isArray(val) || (typeof val === 'object' && val !== null)) return val;
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

// ─── System ─────────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

router.get('/version', (_req, res) => {
  res.json({ version: '1.0.0', protocol: 'Blueprint Public API v1' });
});

// ─── Businesses ─────────────────────────────────────────────────────────────

router.get('/businesses', (_req, res) => {
  const rows = db.prepare('SELECT id, name, slug, type, description, created_at FROM businesses').all();
  res.json({ businesses: rows });
});

router.get('/businesses/:id', (req, res) => {
  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Business not found.' });
  res.json({ business: { ...biz, settings: safeJSON(biz.settings, {}) } });
});

// ─── Signals ────────────────────────────────────────────────────────────────

router.get('/businesses/:id/signals', (req, res) => {
  const { status = 'open', severity, limit = 50 } = req.query;
  const conditions = ['business_id = ?'];
  const params = [req.params.id];
  if (status && status !== 'all') { conditions.push('status = ?'); params.push(status); }
  if (severity) { conditions.push('severity = ?'); params.push(severity); }
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const rows = db.prepare(`SELECT * FROM signals WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...params, lim);
  res.json({ signals: rows.map((r) => ({ ...r, data: safeJSON(r.data, {}) })) });
});

router.post('/businesses/:id/signals', requireScope('write'), (req, res) => {
  const { type = 'external', severity = 'info', title, description, data, confidence } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required.' });
  const id = generateId();
  db.prepare(`
    INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, data, status, confidence, agent_id, created_at)
    VALUES (?, ?, 'api_external', ?, ?, ?, ?, ?, 'open', ?, 'api', CURRENT_TIMESTAMP)
  `).run(id, req.params.id, type, severity, title, description ?? null, JSON.stringify(data ?? {}), confidence ?? null);

  try {
    import('../bap/webhook-dispatcher.js').then((m) =>
      m.dispatchWebhookEvent('signal.created', { signal_id: id, business_id: req.params.id, type, severity, title, confidence })
    );
  } catch {}

  res.status(201).json({ signal_id: id, created: true });
});

router.get('/signals/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM signals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Signal not found.' });
  res.json({ signal: { ...row, data: safeJSON(row.data, {}) } });
});

router.patch('/signals/:id', requireScope('write'), (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required.' });
  db.prepare('UPDATE signals SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

router.get('/businesses/:id/tasks', (req, res) => {
  const { status, limit = 50 } = req.query;
  const conditions = ['business_id = ?'];
  const params = [req.params.id];
  if (status) { conditions.push('status = ?'); params.push(status); }
  const rows = db.prepare(`SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, Math.min(parseInt(limit, 10) || 50, 200));
  res.json({ tasks: rows.map((r) => ({ ...r, action_payload: safeJSON(r.action_payload, {}), outcome_data: safeJSON(r.outcome_data, null) })) });
});

router.post('/businesses/:id/tasks', requireScope('write'), (req, res) => {
  try {
    const { createTask } = require('../tasks/task-queue.js');
    const { title, description, action_type, priority = 'p2', confidence, estimated_impact } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required.' });
    const task = createTask({
      business_id: req.params.id, title, description, proposed_by: `api:${req.apiKey.id}`,
      action_type, priority, confidence, estimated_impact, trust_tier: 'yellow',
    });
    res.status(201).json({ task_id: task.id, status: task.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Task not found.' });
  const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at').all(req.params.id);
  res.json({ task: { ...row, action_payload: safeJSON(row.action_payload, {}), outcome_data: safeJSON(row.outcome_data, null) }, events });
});

router.patch('/tasks/:id/approve', requireScope('admin'), async (req, res) => {
  try {
    const { approveTask } = await import('../tasks/task-queue.js');
    const task = approveTask(req.params.id, `api:${req.apiKey.id}`);
    res.json({ task_id: task.id, status: task.status });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 422).json({ error: err.message });
  }
});

router.patch('/tasks/:id/reject', requireScope('admin'), async (req, res) => {
  try {
    const { rejectTask } = await import('../tasks/task-queue.js');
    const task = rejectTask(req.params.id, `api:${req.apiKey.id}`, req.body.reason ?? '');
    res.json({ task_id: task.id, status: task.status });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 422).json({ error: err.message });
  }
});

// ─── Metrics ────────────────────────────────────────────────────────────────

router.get('/businesses/:id/metrics', (req, res) => {
  const connectors = db.prepare("SELECT id, type FROM connectors WHERE business_id = ? AND status = 'connected'").all(req.params.id);
  const snapshot = {};
  for (const c of connectors) {
    const latest = db.prepare('SELECT metric_name, metric_value FROM metrics WHERE business_id = ? AND connector_id = ? AND metric_value IS NOT NULL ORDER BY recorded_at DESC LIMIT 30')
      .all(req.params.id, c.id);
    if (latest.length > 0) {
      snapshot[c.type] = {};
      for (const m of latest) snapshot[c.type][m.metric_name] = m.metric_value;
    }
  }
  // Include custom metrics
  const custom = db.prepare("SELECT metric_name, metric_value, metric_data, recorded_at FROM metrics WHERE business_id = ? AND metric_name LIKE 'custom.%' ORDER BY recorded_at DESC LIMIT 50")
    .all(req.params.id);
  if (custom.length > 0) {
    snapshot.custom = {};
    for (const m of custom) snapshot.custom[m.metric_name] = m.metric_value;
  }
  res.json({ snapshot_at: new Date().toISOString(), connectors: snapshot });
});

/**
 * POST /api/v1/businesses/:id/metrics — push custom metrics
 * Body: { source: "zapier", metrics: [{ name: "custom.foo", value: 42, data: null }] }
 */
router.post('/businesses/:id/metrics', requireScope('write'), (req, res) => {
  const { source = 'api', metrics } = req.body;
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return res.status(400).json({ error: 'metrics array is required.' });
  }
  const businessId = req.params.id;
  const now = new Date().toISOString();
  let stored = 0;
  for (const m of metrics.slice(0, 100)) {
    if (!m.name) continue;
    const name = m.name.startsWith('custom.') ? m.name : `custom.${m.name}`;
    db.prepare(`
      INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, metric_data, period_start, period_end, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      crypto.randomUUID(), businessId, `api:${source}`,
      name, m.value ?? null, m.data ? JSON.stringify(m.data) : null,
      now, now
    );
    stored++;
  }
  res.json({ stored, source });
});

// ─── Zapier / Make webhook receiver ─────────────────────────────────────────

router.post('/businesses/:id/ingest/zapier', requireScope('write'), async (req, res) => {
  const { type, data } = req.body;
  if (!type || !data) return res.status(400).json({ error: 'type and data are required.' });
  const businessId = req.params.id;

  try {
    if (type === 'signal') {
      const id = generateId();
      db.prepare(`
        INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, data, status, confidence, agent_id, created_at)
        VALUES (?, ?, 'zapier', ?, ?, ?, ?, ?, 'open', ?, 'zapier', CURRENT_TIMESTAMP)
      `).run(id, businessId, data.type ?? 'external', data.severity ?? 'info',
        data.title ?? 'Zapier signal', data.description ?? null,
        JSON.stringify(data), data.confidence ?? null);
      return res.status(201).json({ type: 'signal', signal_id: id });
    }

    if (type === 'metric') {
      const name = data.name?.startsWith('custom.') ? data.name : `custom.${data.name ?? 'zapier_metric'}`;
      db.prepare(`
        INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, metric_data, recorded_at)
        VALUES (?, ?, 'zapier', ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(crypto.randomUUID(), businessId, name, data.value ?? null, data.data ? JSON.stringify(data.data) : null);
      return res.status(201).json({ type: 'metric', name });
    }

    if (type === 'task') {
      const { createTask } = await import('../tasks/task-queue.js');
      const task = createTask({
        business_id: businessId, title: data.title ?? 'Zapier task',
        description: data.description ?? null, proposed_by: 'zapier',
        action_type: data.action_type ?? 'investigation', priority: data.priority ?? 'p2',
        trust_tier: 'yellow',
      });
      return res.status(201).json({ type: 'task', task_id: task.id });
    }

    return res.status(400).json({ error: 'type must be "signal", "metric", or "task".' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── KB ─────────────────────────────────────────────────────────────────────

router.get('/businesses/:id/kb/search', async (req, res) => {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(req.params.id);
    if (!result) return res.status(404).json({ error: 'KB not initialized.' });
    const results = await result.engine.search(String(req.query.q ?? ''), 20);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/businesses/:id/kb/file/*', async (req, res) => {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(req.params.id);
    if (!result) return res.status(404).json({ error: 'KB not initialized.' });
    const file = await result.engine.readFile(req.params[0]);
    res.json(file);
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

router.post('/businesses/:id/kb/file/*', requireScope('write'), async (req, res) => {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(req.params.id);
    if (!result) return res.status(404).json({ error: 'KB not initialized.' });
    const written = await result.engine.writeFile(req.params[0], req.body.content, req.body.frontmatter ?? null, req.body.commit_message);
    res.json(written);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Connectors ─────────────────────────────────────────────────────────────

router.get('/businesses/:id/connectors', (req, res) => {
  const rows = db.prepare('SELECT id, type, name, status, last_sync, last_error, config FROM connectors WHERE business_id = ?').all(req.params.id);
  res.json({ connectors: rows.map((r) => ({ ...r, config: safeJSON(r.config, {}) })) });
});

router.post('/businesses/:id/connectors/:connectorId/sync', requireScope('write'), async (req, res) => {
  try {
    // Fire-and-forget sync
    const { syncConnector } = await import('../jobs/scheduler.js');
    const connector = db.prepare('SELECT * FROM connectors WHERE id = ? AND business_id = ?').get(req.params.connectorId, req.params.id);
    if (!connector) return res.status(404).json({ error: 'Connector not found.' });
    syncConnector(connector).catch(() => {});
    res.json({ ok: true, status: 'syncing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

// ─── Key management (used by admin UI) ──────────────────────────────────────

export function generatePublicApiKey() {
  const random = crypto.randomBytes(24).toString('base64url');
  return `bpk_${random}`;
}

export async function createApiKeyRecord(name, scopes = ['read'], rateLimit = 1000, expiresAt = null) {
  const rawKey = generatePublicApiKey();
  const hash = await Bun.password.hash(rawKey, { algorithm: 'bcrypt', cost: 12 });
  const prefix = keyPrefix(rawKey);
  const id = generateId();
  db.prepare(`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, rate_limit, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, name, hash, prefix, JSON.stringify(scopes), rateLimit, expiresAt);
  return { id, api_key: rawKey, prefix, name, scopes, rate_limit: rateLimit };
}
