/**
 * Blueprint Agent Protocol (BAP) — Gateway Routes.
 *
 * All routes live under /api/bap/v1/ and use BAP-Key header auth
 * (except /register which is open).
 *
 * Endpoints:
 *   POST   /register                          — create agent + issue key
 *   GET    /me                                — whoami + capabilities
 *   GET    /capabilities                      — instance info
 *   GET    /businesses/:bid/health            — full business health
 *   GET    /businesses/:bid/signals           — read signals
 *   POST   /businesses/:bid/signals           — create signal
 *   PATCH  /signals/:id                       — update signal status
 *   GET    /businesses/:bid/tasks             — read tasks
 *   POST   /businesses/:bid/tasks             — propose task
 *   PATCH  /tasks/:id                         — approve/reject
 *   GET    /businesses/:bid/kb/file/*         — read KB file
 *   GET    /businesses/:bid/kb/search         — search KB
 *   POST   /businesses/:bid/kb/query          — LLM query
 *   POST   /businesses/:bid/kb/write          — write KB file
 *   GET    /businesses/:bid/metrics           — read metrics
 *   GET    /businesses/:bid/metrics/snapshot  — latest snapshot
 *   GET    /businesses/:bid/agents            — list internal agents
 *   POST   /businesses/:bid/agents/:aid/run   — trigger agent run
 *   GET    /runs/:runId                       — run status
 *   PUT    /me/webhook                        — update webhook config
 *   GET    /me/webhook/deliveries             — list deliveries
 *   POST   /me/webhook/deliveries/:id/retry   — retry failed delivery
 */
import { Router } from 'express';
import crypto from 'crypto';
import db, { generateId } from '../db/db.js';
import {
  generateApiKey, hashApiKey, keyPrefix,
  bapAuth, requirePermission, hasPermission,
} from '../bap/auth.js';
import { bapRateLimit } from '../bap/rate-limiter.js';

const router = Router();

// ─── Helper ─────────────────────────────────────────────────────────────────

function safeJSON(val, fallback = []) {
  if (Array.isArray(val) || (typeof val === 'object' && val !== null)) return val;
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

function businessRow(businessId) {
  return db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
}

// ─── REGISTRATION (open — no auth required) ─────────────────────────────────

router.post('/register', bapRateLimit('register'), async (req, res) => {
  try {
    const {
      name,
      description,
      owner,
      requested_permissions = [],
      business_access = ['*'],
      webhook_url,
      webhook_events = [],
    } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required.' });

    const id = `agt_${crypto.randomBytes(8).toString('hex')}`;
    const rawKey = generateApiKey();
    const hash = await hashApiKey(rawKey);
    const prefix = keyPrefix(rawKey);

    // For personal Blueprint instances, grant all requested permissions.
    // A future multi-tenant mode could add admin approval here.
    const permissions = Array.isArray(requested_permissions) ? requested_permissions : [];

    // Generate a webhook secret if a URL is provided
    const webhookSecret = webhook_url
      ? crypto.randomBytes(32).toString('hex')
      : null;

    db.prepare(`
      INSERT INTO bap_agents (id, name, description, owner, api_key_hash, api_key_prefix,
                              status, permissions, business_access, webhook_url,
                              webhook_secret, webhook_events, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id, name, description ?? null, owner ?? null,
      hash, prefix,
      JSON.stringify(permissions),
      JSON.stringify(business_access),
      webhook_url ?? null,
      webhookSecret,
      JSON.stringify(webhook_events),
    );

    return res.status(201).json({
      agent_id: id,
      api_key: rawKey,
      api_key_prefix: prefix,
      permissions,
      business_access,
      webhook_secret: webhookSecret,
      message: 'Store your API key securely — it will not be shown again.',
    });
  } catch (err) {
    console.error('[BAP] Register error:', err);
    return res.status(500).json({ error: 'Registration failed.' });
  }
});

// ─── DISCOVERY (no auth — public info about this instance) ──────────────────

router.get('/discover', (_req, res) => {
  try {
    const discoveryPublic = JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key = 'bap_discovery_public'").get()?.value ?? 'true'
    );
    // If discovery is disabled and no auth, return 404
    if (!discoveryPublic) return res.status(404).json({ error: 'Discovery disabled.' });

    const instanceName = JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key = 'instance_name'").get()?.value ?? '"Blueprint"'
    );
    const connectors = db.prepare(
      "SELECT DISTINCT type FROM connectors WHERE status = 'connected'"
    ).all().map(r => r.type);
    const agents = db.prepare('SELECT id, name, status FROM agents').all();
    const businesses = db.prepare('SELECT id, name, slug, type FROM businesses').all();

    return res.json({
      blueprint_version: '1.0.0',
      instance_name: instanceName,
      businesses: businesses.map(b => ({ id: b.id, name: b.name, slug: b.slug, type: b.type })),
      connectors_available: connectors,
      agents_active: agents.filter(a => a.status === 'active').map(a => a.id),
      bap_version: '1.0',
      register_endpoint: '/api/bap/v1/register',
      capabilities: {
        kb_enabled: true,
        write_back_enabled: true,
        webhook_supported: true,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// All routes below require BAP-Key auth
// ═══════════════════════════════════════════════════════════════════════════
router.use(bapAuth);
router.use(bapRateLimit('default'));

// ─── DISCOVERY ──────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  const a = req.bapAgent;
  const businesses = db.prepare('SELECT id, name, slug FROM businesses').all()
    .filter((b) => {
      const access = safeJSON(a.business_access);
      return access.includes('*') || access.includes(b.id);
    });

  return res.json({
    agent_id: a.id,
    name: a.name,
    description: a.description,
    status: a.status,
    permissions: safeJSON(a.permissions),
    business_access: safeJSON(a.business_access),
    webhook_configured: !!a.webhook_url,
    last_seen: a.last_seen,
    total_calls: a.total_calls,
    businesses,
  });
});

router.get('/capabilities', (_req, res) => {
  const connectors = db.prepare(
    "SELECT DISTINCT type FROM connectors WHERE status = 'connected'"
  ).all().map((r) => r.type);
  const agents = db.prepare('SELECT id, name, status FROM agents').all();

  return res.json({
    version: '1.0.0',
    protocol: 'BAP',
    endpoints: [
      'POST /register', 'GET /me', 'GET /capabilities',
      'GET /businesses/:id/health',
      'GET|POST /businesses/:id/signals', 'PATCH /signals/:id',
      'GET|POST /businesses/:id/tasks', 'PATCH /tasks/:id',
      'GET /businesses/:id/kb/file/*', 'GET /businesses/:id/kb/search',
      'POST /businesses/:id/kb/query', 'POST /businesses/:id/kb/write',
      'GET /businesses/:id/metrics', 'GET /businesses/:id/metrics/snapshot',
      'GET /businesses/:id/agents', 'POST /businesses/:id/agents/:id/run',
      'GET /runs/:id',
      'PUT /me/webhook', 'GET /me/webhook/deliveries',
    ],
    connectors_connected: connectors,
    internal_agents: agents.map((a) => ({ id: a.id, name: a.name, status: a.status })),
    kb_enabled: true,
  });
});

// ─── BUSINESS HEALTH ────────────────────────────────────────────────────────

router.get('/businesses/:businessId/health', requirePermission('signals:read'), (req, res) => {
  try {
    const { businessId } = req.params;
    const biz = businessRow(businessId);
    if (!biz) return res.status(404).json({ error: 'Business not found.' });

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    // Signals summary
    const signalCounts = {
      total: 0, critical: 0, alert: 0, warning: 0, info: 0,
    };
    db.prepare(
      "SELECT severity, COUNT(*) as n FROM signals WHERE business_id = ? AND status = 'open' GROUP BY severity"
    ).all(businessId).forEach((r) => {
      signalCounts[r.severity] = r.n;
      signalCounts.total += r.n;
    });

    const topSignals = db.prepare(
      "SELECT id, title, severity, connector_id, confidence, created_at FROM signals WHERE business_id = ? AND status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'alert' THEN 2 WHEN 'warning' THEN 3 ELSE 4 END, created_at DESC LIMIT 5"
    ).all(businessId);

    // Tasks summary
    const taskCounts = {};
    db.prepare(
      "SELECT status, COUNT(*) as n FROM tasks WHERE business_id = ? GROUP BY status"
    ).all(businessId).forEach((r) => { taskCounts[r.status] = r.n; });
    const completedRecent = db.prepare(
      "SELECT COUNT(*) as n FROM tasks WHERE business_id = ? AND status IN ('complete','verified') AND completed_at >= ?"
    ).get(businessId, sevenDaysAgo)?.n ?? 0;

    // Key metrics snapshot (latest per connector+metric)
    const metricsSnapshot = {};
    const connectors = db.prepare(
      "SELECT id, type, status FROM connectors WHERE business_id = ?"
    ).all(businessId);
    for (const c of connectors) {
      const latest = db.prepare(
        "SELECT metric_name, metric_value FROM metrics WHERE business_id = ? AND connector_id = ? AND metric_value IS NOT NULL ORDER BY recorded_at DESC LIMIT 20"
      ).all(businessId, c.id);
      if (latest.length > 0) {
        metricsSnapshot[c.type] = {};
        for (const m of latest) {
          metricsSnapshot[c.type][m.metric_name] = m.metric_value;
        }
      }
    }

    // Last conductor run
    const lastRun = db.prepare(
      "SELECT started_at, status, tasks_proposed FROM agent_runs WHERE business_id = ? ORDER BY started_at DESC LIMIT 1"
    ).get(businessId);
    const runsToday = db.prepare(
      "SELECT COUNT(*) as n FROM agent_runs WHERE business_id = ? AND started_at >= ?"
    ).get(businessId, new Date().toISOString().split('T')[0])?.n ?? 0;

    // Health score from last analysis
    const lastAnalysis = db.prepare(
      "SELECT health_score, completed_at FROM analysis_runs WHERE business_id = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 1"
    ).get(businessId);

    return res.json({
      business: { id: biz.id, name: biz.name, slug: biz.slug, type: biz.type },
      health_score: lastAnalysis?.health_score ?? null,
      period: 'last_7_days',
      signals: { ...signalCounts, top_signals: topSignals },
      tasks: {
        proposed: taskCounts.proposed ?? 0,
        approved: taskCounts.approved ?? 0,
        executing: taskCounts.executing ?? 0,
        completed_7d: completedRecent,
        pending_approval: taskCounts.proposed ?? 0,
      },
      metrics: metricsSnapshot,
      agents: {
        last_run: lastRun?.started_at ?? null,
        runs_today: runsToday,
        tasks_proposed_today: lastRun?.tasks_proposed ?? 0,
      },
    });
  } catch (err) {
    console.error('[BAP] Health error:', err);
    return res.status(500).json({ error: 'Failed to build health summary.' });
  }
});

// ─── SIGNALS ────────────────────────────────────────────────────────────────

router.get('/businesses/:businessId/signals', requirePermission('signals:read'), (req, res) => {
  try {
    const { businessId } = req.params;
    const { severity, status = 'open', limit = 50, connector } = req.query;

    const conditions = ['business_id = ?'];
    const params = [businessId];
    if (severity) { conditions.push(`severity IN (${severity.split(',').map(() => '?').join(',')})`); params.push(...severity.split(',')); }
    if (status && status !== 'all') { conditions.push('status = ?'); params.push(status); }
    if (connector) { conditions.push('connector_id = ?'); params.push(connector); }

    const where = conditions.join(' AND ');
    const lim = Math.min(parseInt(limit, 10) || 50, 200);

    const signals = db.prepare(
      `SELECT * FROM signals WHERE ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, lim).map((s) => ({ ...s, data: safeJSON(s.data, {}) }));

    const total = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE ${where}`).get(...params)?.n ?? 0;

    return res.json({ signals, total, filters_applied: { severity, status, connector } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/businesses/:businessId/signals', requirePermission('signals:create'), async (req, res) => {
  try {
    const { businessId } = req.params;
    const { type, severity, title, description, data, confidence, connector_id } = req.body;
    if (!title || !severity || !type) {
      return res.status(400).json({ error: 'type, severity, and title are required.' });
    }

    const id = generateId();
    db.prepare(`
      INSERT INTO signals (id, business_id, connector_id, rule_id, type, severity,
                           title, description, data, status, confidence, agent_id, created_at)
      VALUES (?, ?, ?, 'bap_external', ?, ?, ?, ?, ?, 'open', ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id, businessId, connector_id ?? null,
      type, severity, title, description ?? null,
      JSON.stringify(data ?? {}), confidence ?? null,
      req.bapAgent.id
    );

    // Dispatch webhook for signal.created
    try {
      const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js');
      dispatchWebhookEvent('signal.created', {
        signal_id: id, business_id: businessId, type, severity, title, confidence,
      });
      if (severity === 'critical') {
        dispatchWebhookEvent('signal.critical', {
          signal_id: id, business_id: businessId, type, severity, title, confidence,
        });
      }
    } catch {}

    return res.status(201).json({ signal_id: id, created: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/signals/:signalId', requirePermission('signals:read'), (req, res) => {
  try {
    const { signalId } = req.params;
    const { status, note } = req.body;
    const existing = db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId);
    if (!existing) return res.status(404).json({ error: 'Signal not found.' });
    if (!status) return res.status(400).json({ error: 'status is required.' });

    const updates = ['status = ?'];
    const values = [status];
    if (status === 'resolved') updates.push('resolved_at = CURRENT_TIMESTAMP');
    values.push(signalId);
    db.prepare(`UPDATE signals SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    return res.json({ signal_id: signalId, status, updated: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── TASKS ──────────────────────────────────────────────────────────────────

router.get('/businesses/:businessId/tasks', requirePermission('tasks:read'), (req, res) => {
  try {
    const { businessId } = req.params;
    const { status, priority, limit = 50 } = req.query;

    const conditions = ['business_id = ?'];
    const params = [businessId];
    if (status) { conditions.push(`status IN (${status.split(',').map(() => '?').join(',')})`); params.push(...status.split(',')); }
    if (priority) { conditions.push(`priority IN (${priority.split(',').map(() => '?').join(',')})`); params.push(...priority.split(',')); }

    const where = conditions.join(' AND ');
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const tasks = db.prepare(
      `SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, lim).map((t) => ({
      ...t,
      action_payload: safeJSON(t.action_payload, {}),
      outcome_data: safeJSON(t.outcome_data, null),
    }));

    return res.json({ tasks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/businesses/:businessId/tasks', requirePermission('tasks:propose'), async (req, res) => {
  try {
    const { businessId } = req.params;
    const {
      title, description, action_type, priority = 'p2', confidence,
      estimated_impact, signal_id, assigned_to, action_payload,
    } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required.' });

    const { createTask } = await import('../tasks/task-queue.js');
    const { createTaskEvent } = await import('../tasks/task-events.js');

    const task = createTask({
      business_id: businessId,
      signal_id: signal_id ?? null,
      title,
      description: description ?? null,
      proposed_by: `bap:${req.bapAgent.id}`,
      assigned_to: assigned_to ?? null,
      action_type: action_type ?? null,
      action_payload: action_payload ?? {},
      trust_tier: req.bapAgent.default_trust_tier ?? 'yellow',
      priority,
      confidence: confidence ?? null,
      estimated_impact: estimated_impact ?? null,
      approval_mode: 'requires_approval',
    });

    createTaskEvent(
      task.id, 'created', `bap:${req.bapAgent.id}`,
      `Task proposed by external agent "${req.bapAgent.name}"`,
      { source: 'bap', agent_id: req.bapAgent.id }
    );

    return res.status(201).json({
      task_id: task.id,
      status: task.status,
      trust_tier: task.trust_tier,
      approval_required: true,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/tasks/:taskId', requirePermission('tasks:approve'), async (req, res) => {
  try {
    const { taskId } = req.params;
    const { action, note } = req.body;
    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve" or "reject".' });
    }

    const { approveTask, rejectTask } = await import('../tasks/task-queue.js');
    const { createTaskEvent } = await import('../tasks/task-events.js');

    let task;
    if (action === 'approve') {
      task = approveTask(taskId, `bap:${req.bapAgent.id}`);
      createTaskEvent(taskId, 'approved', `bap:${req.bapAgent.id}`, note ?? 'Approved via BAP', {});

      // Fire executor for executable types
      const { executeTask, isExecutable } = await import('../tasks/executor.js');
      if (task && isExecutable(task.action_type)) {
        executeTask(task.id).catch(() => {});
      }
    } else {
      task = rejectTask(taskId, `bap:${req.bapAgent.id}`, note ?? '');
      createTaskEvent(taskId, 'rejected', `bap:${req.bapAgent.id}`, note ?? 'Rejected via BAP', {});
    }

    return res.json({ task_id: taskId, status: task.status, action });
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    if (err.message.includes('Cannot')) return res.status(422).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── KNOWLEDGE BASE ─────────────────────────────────────────────────────────

router.get('/businesses/:businessId/kb/file/*', requirePermission('kb:read'), async (req, res) => {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(req.params.businessId);
    if (!result) return res.status(404).json({ error: 'Business not found or KB not initialized.' });

    const filePath = req.params[0];
    const file = await result.engine.readFile(filePath);
    const backlinks = await result.engine.getBacklinks(filePath);

    return res.json({ ...file, backlinks });
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/businesses/:businessId/kb/search', requirePermission('kb:read'), async (req, res) => {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(req.params.businessId);
    if (!result) return res.status(404).json({ error: 'KB not initialized.' });

    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const results = await result.engine.search(String(q), parseInt(req.query.limit, 10) || 20);
    return res.json({ results, query: q });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/businesses/:businessId/kb/query',
  requirePermission('kb:read'), bapRateLimit('kb:query'),
  async (req, res) => {
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js');
      const { KBAgent } = await import('../kb/kb-agent.js');

      const result = await getKBForBusiness(req.params.businessId);
      if (!result) return res.status(404).json({ error: 'KB not initialized.' });

      const { question, file_result, context } = req.body;
      if (!question) return res.status(400).json({ error: 'question is required.' });

      const agent = new KBAgent(result.engine);
      const answer = await agent.query(
        context ? `Context: ${context}\n\nQuestion: ${question}` : question,
        { fileResult: !!file_result }
      );

      return res.json({
        answer: answer.answer,
        sources_read: answer.sourcesRead,
        filed_as: answer.filedPath ?? null,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
);

router.post('/businesses/:businessId/kb/write',
  requirePermission('kb:write'), bapRateLimit('kb:write'),
  async (req, res) => {
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js');
      const result = await getKBForBusiness(req.params.businessId);
      if (!result) return res.status(404).json({ error: 'KB not initialized.' });

      const { path: filePath, content, frontmatter, commit_message } = req.body;
      if (!filePath || content === undefined) {
        return res.status(400).json({ error: 'path and content are required.' });
      }

      const written = await result.engine.writeFile(
        filePath, content,
        frontmatter ?? null,
        commit_message ?? `bap: ${req.bapAgent.name} wrote ${filePath}`
      );

      return res.json({ ...written });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
);

// ─── METRICS ────────────────────────────────────────────────────────────────

router.get('/businesses/:businessId/metrics', requirePermission('metrics:read'), (req, res) => {
  try {
    const { businessId } = req.params;
    const { connector, metric, limit = 10 } = req.query;

    const conditions = ['business_id = ?'];
    const params = [businessId];
    if (connector) { conditions.push('connector_id IN (SELECT id FROM connectors WHERE type = ? AND business_id = ?)'); params.push(connector, businessId); }
    if (metric) { conditions.push('metric_name = ?'); params.push(metric); }

    const where = conditions.join(' AND ');
    const lim = Math.min(parseInt(limit, 10) || 10, 100);
    const rows = db.prepare(
      `SELECT metric_name, metric_value, metric_data, recorded_at FROM metrics WHERE ${where} ORDER BY recorded_at DESC LIMIT ?`
    ).all(...params, lim).map((r) => ({ ...r, metric_data: safeJSON(r.metric_data, null) }));

    return res.json({ metrics: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/businesses/:businessId/metrics/snapshot', requirePermission('metrics:read'), (req, res) => {
  try {
    const { businessId } = req.params;
    const connectors = db.prepare(
      "SELECT id, type FROM connectors WHERE business_id = ? AND status = 'connected'"
    ).all(businessId);

    const snapshot = {};
    for (const c of connectors) {
      const latest = db.prepare(
        "SELECT metric_name, metric_value FROM metrics WHERE business_id = ? AND connector_id = ? AND metric_value IS NOT NULL ORDER BY recorded_at DESC LIMIT 30"
      ).all(businessId, c.id);
      if (latest.length > 0) {
        snapshot[c.type] = {};
        for (const m of latest) {
          // Use short name (strip connector prefix if present)
          const shortName = m.metric_name.includes('.')
            ? m.metric_name.split('.').slice(1).join('.')
            : m.metric_name;
          snapshot[c.type][shortName] = m.metric_value;
        }
      }
    }

    return res.json({ snapshot_at: new Date().toISOString(), connectors: snapshot });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── INTERNAL AGENT CONTROL ─────────────────────────────────────────────────

router.get('/businesses/:businessId/agents', requirePermission('agents:read'), (req, res) => {
  try {
    const agents = db.prepare('SELECT id, name, status, last_run, next_run, run_count, total_cost_usd, acceptance_rate FROM agents').all();
    return res.json({ agents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/businesses/:businessId/agents/:agentId/run',
  requirePermission('agents:trigger'), bapRateLimit('agents:trigger'),
  async (req, res) => {
    try {
      const { businessId, agentId } = req.params;
      const biz = businessRow(businessId);
      if (!biz) return res.status(404).json({ error: 'Business not found.' });

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
      if (!agent) return res.status(404).json({ error: `Agent '${agentId}' not found.` });

      const { runAgent } = await import('../agents/agent-runner.js');
      // Fire-and-forget — return immediately with run_id
      const runId = generateId();
      db.prepare(`
        INSERT INTO agent_runs (id, agent_id, business_id, trigger, trigger_id, status, started_at)
        VALUES (?, ?, ?, 'bap', ?, 'running', CURRENT_TIMESTAMP)
      `).run(runId, agentId, businessId, req.bapAgent.id);

      // Run in background
      runAgent(agentId, businessId, 'bap', req.bapAgent.id).catch((err) => {
        console.error(`[BAP] Agent run ${agentId} failed:`, err.message);
      });

      return res.status(202).json({
        run_id: runId,
        agent_id: agentId,
        status: 'queued',
        estimated_start: 'immediate',
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
);

router.get('/runs/:runId', (req, res) => {
  try {
    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    return res.json({
      run_id: run.id,
      agent_id: run.agent_id,
      business_id: run.business_id,
      status: run.status,
      tasks_proposed: run.tasks_proposed,
      signals_detected: run.signals_detected,
      cost_usd: run.cost_usd,
      started_at: run.started_at,
      completed_at: run.completed_at,
      reasoning: run.reasoning,
      error: run.error,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK MANAGEMENT ────────────────────────────────────────────────────

router.put('/me/webhook', (req, res) => {
  try {
    const { url, secret, events } = req.body;
    const agentId = req.bapAgent.id;

    const updates = [];
    const values = [];
    if (url !== undefined) { updates.push('webhook_url = ?'); values.push(url); }
    if (secret !== undefined) { updates.push('webhook_secret = ?'); values.push(secret); }
    if (events !== undefined) { updates.push('webhook_events = ?'); values.push(JSON.stringify(events)); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Provide at least one of: url, secret, events.' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(agentId);
    db.prepare(`UPDATE bap_agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT webhook_url, webhook_events FROM bap_agents WHERE id = ?').get(agentId);
    return res.json({
      ok: true,
      webhook_url: updated.webhook_url,
      webhook_events: safeJSON(updated.webhook_events),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/me/webhook/deliveries', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const rows = db.prepare(
      'SELECT id, event_type, delivery_status, attempts, response_code, created_at, last_attempt FROM bap_webhook_deliveries WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(req.bapAgent.id, limit);
    return res.json({ deliveries: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/me/webhook/deliveries/:deliveryId/retry', async (req, res) => {
  try {
    const row = db.prepare(
      'SELECT * FROM bap_webhook_deliveries WHERE id = ? AND agent_id = ?'
    ).get(req.params.deliveryId, req.bapAgent.id);
    if (!row) return res.status(404).json({ error: 'Delivery not found.' });

    db.prepare(
      "UPDATE bap_webhook_deliveries SET delivery_status = 'retrying', next_retry = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(row.id);

    const { retryPendingDeliveries } = await import('../bap/webhook-dispatcher.js');
    retryPendingDeliveries().catch(() => {});

    return res.json({ delivery_id: row.id, status: 'retrying' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin routes — used by the Settings UI (session auth, NOT BAP key)
// Mounted alongside the BAP routes but guarded by isAuthenticated.
// ═══════════════════════════════════════════════════════════════════════════

import { isAuthenticated } from '../middleware/auth.js';

router.get('/agents-admin', isAuthenticated, (req, res) => {
  try {
    const agents = db.prepare(
      'SELECT id, name, description, owner, api_key_prefix, status, permissions, business_access, default_trust_tier, webhook_url, webhook_events, last_seen, total_calls, created_at FROM bap_agents ORDER BY created_at DESC'
    ).all().map((a) => ({
      ...a,
      permissions: safeJSON(a.permissions),
      business_access: safeJSON(a.business_access),
      webhook_events: safeJSON(a.webhook_events),
    }));
    return res.json({ agents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/agents-admin/:agentId/revoke', isAuthenticated, (req, res) => {
  try {
    const { agentId } = req.params;
    db.prepare("UPDATE bap_agents SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(agentId);
    return res.json({ ok: true, agent_id: agentId, status: 'revoked' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/agents-admin/:agentId/audit', isAuthenticated, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = db.prepare(
      'SELECT id, method, endpoint, business_id, status_code, duration_ms, created_at FROM bap_audit WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(req.params.agentId, limit);
    return res.json({ calls: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/agents-admin/:agentId/deliveries', isAuthenticated, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = db.prepare(
      'SELECT id, event_type, delivery_status, attempts, response_code, created_at, last_attempt FROM bap_webhook_deliveries WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(req.params.agentId, limit);
    return res.json({ deliveries: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
