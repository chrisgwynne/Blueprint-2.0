/**
 * Blueprint Agent Protocol (BAP) — Gateway Routes.
 *
 * All routes live under /api/bap/v1/ and use BAP-Key header auth.
 * /register instead requires an authenticated dashboard session or a
 * valid X-Registration-Secret header (see bap/auth.ts) — it is NOT open.
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
 *   GET    /businesses/:bid/execution-jobs    — list execution jobs
 *   GET    /execution-jobs/:id                — execution job detail
 *   POST   /execution-jobs/:id/retry          — retry a stuck/dead-lettered job
 *   POST   /execution-jobs/:id/cancel         — cancel a queued/manual-review job
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
import type { Request, Response } from 'express';
import crypto from 'crypto';
import db, { generateId } from '../db/db.js';
import {
  generateApiKey, hashApiKey, keyPrefix,
  bapAuth, requirePermission, hasPermission,
  requireRegistrationAuth, filterGrantablePermissions, filterValidBusinessIds,
} from '../bap/auth.js';
import { bapRateLimit } from '../bap/rate-limiter.js';
import { isAuthenticated } from '../middleware/auth.js';
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from '../lib/ssrf-guard.js';
import { KBPathError } from '../kb/kb-engine.js';
import { bapRequestContext, parsePagination, paginationMeta, toIso, normalizeTimestamps, withRequiredIdempotency } from '../bap/route-helpers.js';
import { computeOutcomeStatus } from '../tasks/outcome-status.js';
import bapGoalsRouter from './bap-goals.js';
import bapConnectorsRouter from './bap-connectors.js';
import bapOutcomesRouter from './bap-outcomes.js';
import bapRunsRouter from './bap-runs.js';
import bapAuditRouter from './bap-audit.js';
import bapOpportunitiesRouter from './bap-opportunities.js';
import bapConflictsRouter from './bap-conflicts.js';
import bapDecisionsRouter from './bap-decisions.js';
import bapGraphRouter from './bap-graph.js';
import bapReviewRouter from './bap-review.js';
import bapBusinessProfileRouter from './bap-business-profile.js';
import bapActionRegistryRouter from './bap-action-registry.js';
import bapConnectorConfidenceRouter from './bap-connector-confidence.js';
import bapWorldModelRouter from './bap-world-model.js';
import bapSystemIssuesRouter from './bap-system-issues.js';
import bapTrustRouter from './bap-trust.js';

const router = Router();
// Every BAP call — including /register, before bapAuth even runs — gets a
// request/correlation ID (see route-helpers.ts). Mounted first so it's
// available to every route below, and to bapAuth's own audit-log insert.
router.use(bapRequestContext);

// ─── Helper ─────────────────────────────────────────────────────────────────

function safeJSON(val: unknown, fallback: unknown = []): unknown {
  if (Array.isArray(val) || (typeof val === 'object' && val !== null)) return val;
  if (!val) return fallback;
  try { return JSON.parse(val as string); } catch { return fallback; }
}

// Strip <think>...</think> reasoning blocks from content posted by external agents
// (e.g. Hermes using MiniMax-M2 / DeepSeek-R1 which emit chain-of-thought inline)
function stripThink(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || null;
}

function kanbanColumnForStatus(status: string): string {
  if (['proposed', 'deferred'].includes(status)) return 'backlog';
  if (['approved', 'manual_review', 'blocked'].includes(status)) return 'ready';
  if (['executing', 'draft_ready'].includes(status)) return 'doing';
  if (['complete', 'verified'].includes(status)) return 'done';
  if (['failed', 'rejected', 'cancelled'].includes(status)) return 'closed';
  return 'backlog';
}

function approvalStateForTask(row: Record<string, unknown>): string {
  const status = String(row.status ?? 'proposed');
  if (status === 'proposed' || status === 'deferred') return 'awaiting_approval';
  if (status === 'approved' || status === 'executing' || status === 'draft_ready' || status === 'manual_review' || status === 'blocked') return 'approved';
  if (status === 'rejected') return 'rejected';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'complete' || status === 'verified') return 'completed';
  return 'unknown';
}

function buildKanbanCard(row: Record<string, unknown>): Record<string, unknown> {
  const payload = safeJSON(row.action_payload, {}) as Record<string, unknown>;
  const riskEvidence = safeJSON(row.approval_risk_evidence, null) as Record<string, unknown> | null;
  const measurementPolicy = row.measurement_policy_id
    ? db.prepare('SELECT id, name, checkpoints_json, final_day, connector_freshness_hours FROM measurement_policies WHERE id = ?').get(String(row.measurement_policy_id)) ?? null
    : null;
  const acceptanceCriteria = payload.acceptance_criteria ?? payload.acceptanceCriteria ?? payload.success_criteria ?? payload.successCriteria ?? row.description ?? null;
  return normalizeTimestamps({
    blueprint_task_id: row.id,
    business_id: row.business_id,
    goal_id: row.goal_id ?? null,
    signal_id: row.signal_id ?? null,
    title: row.title,
    description: row.description ?? null,
    kanban_column: kanbanColumnForStatus(String(row.status ?? 'proposed')),
    task_status: row.status,
    approval_tier: row.trust_tier ?? null,
    approval_state: approvalStateForTask(row),
    approval_mode: row.approval_mode ?? null,
    approval_risk_evidence: riskEvidence,
    executor: payload.executor ?? row.assigned_to ?? null,
    action_type: row.action_type ?? null,
    action_payload: payload,
    acceptance_criteria: acceptanceCriteria,
    expected_outcome: row.expected_outcome ?? payload.expected_outcome ?? payload.expectedOutcome ?? null,
    measurement_policy: measurementPolicy ? { ...(measurementPolicy as Record<string, unknown>), checkpoints_json: safeJSON((measurementPolicy as Record<string, unknown>).checkpoints_json, []) } : null,
    priority: row.priority ?? null,
    confidence: row.confidence ?? null,
    proposed_by: row.proposed_by ?? null,
    external_reference: payload.external_reference ?? payload.externalReference ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }, ['created_at', 'updated_at']);
}

function businessRow(businessId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Record<string, unknown> | undefined;
}

// ─── REGISTRATION (requires session auth or X-Registration-Secret) ──────────

router.post('/register', bapRateLimit('register'), requireRegistrationAuth, async (req: Request, res: Response) => {
  try {
    const {
      name,
      description,
      owner,
      requested_permissions = [],
      business_access = [],
      webhook_url,
      webhook_events = [],
    } = req.body as {
      name?: string;
      description?: string;
      owner?: string;
      requested_permissions?: string[];
      business_access?: string[];
      webhook_url?: string;
      webhook_events?: string[];
    };

    if (!name) return res.status(400).json({ error: 'name is required.' });

    if (webhook_url) {
      try {
        await assertSafeWebhookUrl(webhook_url);
      } catch (err) {
        if (err instanceof UnsafeWebhookUrlError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }

    const id = `agt_${crypto.randomBytes(8).toString('hex')}`;
    const rawKey = generateApiKey();
    const hash = await hashApiKey(rawKey);
    const prefix = keyPrefix(rawKey);

    // Self-registration never grants a wildcard permission or wildcard
    // business access, regardless of what was requested — see
    // bap/auth.ts's filterGrantablePermissions/filterValidBusinessIds.
    // An operator can grant broader access afterwards via the dashboard.
    const permissions = filterGrantablePermissions(requested_permissions);
    const grantedBusinessAccess = filterValidBusinessIds(business_access);

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
      JSON.stringify(grantedBusinessAccess),
      webhook_url ?? null,
      webhookSecret,
      JSON.stringify(webhook_events),
    );

    return res.status(201).json({
      agent_id: id,
      api_key: rawKey,
      api_key_prefix: prefix,
      permissions,
      business_access: grantedBusinessAccess,
      webhook_secret: webhookSecret,
      message: 'Store your API key securely — it will not be shown again.',
    });
  } catch (err) {
    console.error('[BAP] Register error:', err);
    return res.status(500).json({ error: 'Registration failed.' });
  }
});

// ─── DISCOVERY (no auth — public info about this instance) ──────────────────

router.get('/discover', (_req: Request, res: Response) => {
  try {
    const discoveryPublic = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'bap_discovery_public'").get() as { value: string } | undefined)?.value ?? 'true'
    ) as boolean;
    // If discovery is disabled and no auth, return 404
    if (!discoveryPublic) return res.status(404).json({ error: 'Discovery disabled.' });

    const instanceName = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'instance_name'").get() as { value: string } | undefined)?.value ?? '"Blueprint"'
    ) as string;
    const connectors = (db.prepare(
      "SELECT DISTINCT type FROM connectors WHERE status = 'connected'"
    ).all() as Array<{ type: string }>).map(r => r.type);
    const agents = db.prepare('SELECT id, name, status FROM agents').all() as Array<{ id: string; name: string; status: string }>;
    const businesses = db.prepare('SELECT id, name, slug, type FROM businesses').all() as Array<{ id: string; name: string; slug: string; type: string }>;

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
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// All routes below require BAP-Key auth
// ═══════════════════════════════════════════════════════════════════════════
router.use(bapAuth);
router.use(bapRateLimit('default'));

// Phase 2 subsystems — split into separate files purely to keep this one
// from growing unboundedly (see each file's docstring), mounted here as
// sub-routers rather than independently in server/index.ts: mounting them
// independently at the same '/api/bap/v1' prefix would mean every one of
// their own bapAuth/rate-limit middleware re-runs (re-validating the key,
// writing a second bap_audit row) whenever a request falls through this
// router's own routes to reach one of theirs — Express runs a mounted
// router's unconditional middleware for every request under its prefix,
// not just ones matching its own routes. Mounting them here, after this
// router's own bapAuth has already run, means exactly one auth pass per
// request regardless of which subsystem ultimately handles it.
router.use(bapGoalsRouter);
router.use(bapConnectorsRouter);
router.use(bapOutcomesRouter);
router.use(bapRunsRouter);
router.use(bapAuditRouter);
router.use(bapOpportunitiesRouter);
router.use(bapConflictsRouter);
router.use(bapDecisionsRouter);
router.use(bapGraphRouter);
router.use(bapReviewRouter);
// Phase 2-INT — Autonomous Intelligence Foundation.
router.use(bapBusinessProfileRouter);
router.use(bapActionRegistryRouter);
router.use(bapConnectorConfidenceRouter);
router.use(bapWorldModelRouter);
router.use(bapSystemIssuesRouter);
router.use(bapTrustRouter);

// ─── DISCOVERY ──────────────────────────────────────────────────────────────

router.get('/me', (req: Request, res: Response) => {
  const a = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
  const businesses = (db.prepare('SELECT id, name, slug FROM businesses').all() as Array<{ id: string; name: string; slug: string }>)
    .filter((b) => {
      const access = safeJSON(a.business_access) as string[];
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

router.get('/capabilities', (_req: Request, res: Response) => {
  const connectors = (db.prepare(
    "SELECT DISTINCT type FROM connectors WHERE status = 'connected'"
  ).all() as Array<{ type: string }>).map((r) => r.type);
  const agents = db.prepare('SELECT id, name, status FROM agents').all() as Array<{ id: string; name: string; status: string }>;

  return res.json({
    version: '1.0.0',
    protocol: 'BAP',
    endpoints: [
      'POST /register', 'GET /me', 'GET /capabilities',
      'GET /businesses/:id/health',
      'GET|POST /businesses/:id/signals', 'GET|PATCH /signals/:id',
      'GET|POST /businesses/:id/tasks', 'GET /tasks/:id', 'GET /tasks/:id/history', 'PATCH /tasks/:id',
      'GET /businesses/:id/execution-jobs', 'GET /execution-jobs/:id',
      'POST /execution-jobs/:id/retry', 'POST /execution-jobs/:id/cancel',
      'GET|POST /businesses/:id/goals', 'GET|PATCH /goals/:id',
      'POST /goals/:id/archive', 'POST /goals/:id/check', 'GET /goals/:id/conflicts',
      'GET /businesses/:id/connectors', 'GET /connectors/:id',
      'GET /connectors/:id/syncs', 'POST /connectors/:id/sync',
      'GET /businesses/:id/outcomes', 'GET /tasks/:id/outcome',
      'GET /businesses/:id/runs', 'POST /runs/:id/cancel', 'POST /runs/:id/retry',
      'GET /businesses/:id/audit',
      'GET /businesses/:id/kb/file/*', 'GET /businesses/:id/kb/search',
      'POST /businesses/:id/kb/query', 'POST /businesses/:id/kb/write',
      'GET /businesses/:id/metrics', 'GET /businesses/:id/metrics/snapshot',
      'GET /businesses/:id/agents', 'POST /businesses/:id/agents/:id/run',
      'GET /runs/:id',
      'PUT /me/webhook', 'GET /me/webhook/deliveries', 'POST /me/webhook/deliveries/:id/retry',
    ],
    connectors_connected: connectors,
    internal_agents: agents.map((a) => ({ id: a.id, name: a.name, status: a.status })),
    kb_enabled: true,
  });
});

// ─── BUSINESS HEALTH ────────────────────────────────────────────────────────

router.get('/businesses/:businessId/health', requirePermission('signals:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = businessRow(businessId);
    if (!biz) return res.status(404).json({ error: 'Business not found.' });

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    // Signals summary
    const signalCounts: Record<string, number> & { total: number } = {
      total: 0, critical: 0, alert: 0, warning: 0, info: 0,
    };
    (db.prepare(
      "SELECT severity, COUNT(*) as n FROM signals WHERE business_id = ? AND status = 'open' GROUP BY severity"
    ).all(businessId) as Array<{ severity: string; n: number }>).forEach((r) => {
      signalCounts[r.severity] = r.n;
      signalCounts.total += r.n;
    });

    const topSignals = db.prepare(
      "SELECT id, title, severity, connector_id, confidence, created_at FROM signals WHERE business_id = ? AND status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'alert' THEN 2 WHEN 'warning' THEN 3 ELSE 4 END, created_at DESC LIMIT 5"
    ).all(businessId);

    // Tasks summary
    const taskCounts: Record<string, number> = {};
    (db.prepare(
      "SELECT status, COUNT(*) as n FROM tasks WHERE business_id = ? GROUP BY status"
    ).all(businessId) as Array<{ status: string; n: number }>).forEach((r) => { taskCounts[r.status] = r.n; });
    const completedRecent = (db.prepare(
      "SELECT COUNT(*) as n FROM tasks WHERE business_id = ? AND status IN ('complete','verified') AND completed_at >= ?"
    ).get(businessId, sevenDaysAgo) as { n: number } | undefined)?.n ?? 0;

    // Key metrics snapshot (latest per connector+metric)
    const metricsSnapshot: Record<string, Record<string, unknown>> = {};
    const connectors = db.prepare(
      "SELECT id, type, status FROM connectors WHERE business_id = ?"
    ).all(businessId) as Array<{ id: string; type: string; status: string }>;
    for (const c of connectors) {
      const latest = db.prepare(
        "SELECT metric_name, metric_value FROM metrics WHERE business_id = ? AND connector_id = ? AND metric_value IS NOT NULL ORDER BY recorded_at DESC LIMIT 20"
      ).all(businessId, c.id) as Array<{ metric_name: string; metric_value: unknown }>;
      if (latest.length > 0) {
        metricsSnapshot[c.type] = {};
        for (const m of latest) {
          metricsSnapshot[c.type]![m.metric_name] = m.metric_value;
        }
      }
    }

    // Last conductor run
    const lastRun = db.prepare(
      "SELECT started_at, status, tasks_proposed FROM agent_runs WHERE business_id = ? ORDER BY started_at DESC LIMIT 1"
    ).get(businessId) as { started_at: string; status: string; tasks_proposed: number | null } | undefined;
    const runsToday = (db.prepare(
      "SELECT COUNT(*) as n FROM agent_runs WHERE business_id = ? AND started_at >= ?"
    ).get(businessId, new Date().toISOString().slice(0, 10)) as { n: number } | undefined)?.n ?? 0;

    // Health score from last analysis
    const lastAnalysis = db.prepare(
      "SELECT health_score, completed_at FROM analysis_runs WHERE business_id = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 1"
    ).get(businessId) as { health_score: number | null; completed_at: string } | undefined;

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

const SIGNAL_SORT_COLUMNS = new Set(['created_at', 'resolved_at', 'severity', 'confidence']);

router.get('/businesses/:businessId/signals', requirePermission('signals:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const {
      q, severity, status = 'open', connector, type,
      created_from, created_to, sort = 'created_at', order = 'desc',
    } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId];
    if (q) {
      conditions.push('(title LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')');
      const term = likeTerm(String(q));
      params.push(term, term);
    }
    if (severity) {
      const sevArr = String(severity).split(',');
      conditions.push(`severity IN (${sevArr.map(() => '?').join(',')})`);
      params.push(...sevArr);
    }
    // Preserves the original default (open-only unless status=all is
    // explicitly requested) — additive filters below don't change this.
    if (status && status !== 'all') { conditions.push('status = ?'); params.push(String(status)); }
    if (connector) { conditions.push('connector_id = ?'); params.push(String(connector)); }
    if (type) {
      const arr = String(type).split(',');
      conditions.push(`type IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (created_from) { conditions.push('created_at >= ?'); params.push(String(created_from)); }
    if (created_to) { conditions.push('created_at <= ?'); params.push(String(created_to)); }

    const where = conditions.join(' AND ');
    const sortCol = SIGNAL_SORT_COLUMNS.has(String(sort)) ? String(sort) : 'created_at';
    const sortDir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);

    const total = (db.prepare(`SELECT COUNT(*) as n FROM signals WHERE ${where}`).get(...params) as { n: number } | undefined)?.n ?? 0;
    const signals = (db.prepare(
      `SELECT * FROM signals WHERE ${where} ORDER BY ${sortCol} ${sortDir}, id ${sortDir} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>).map((s) => normalizeTimestamps({
      ...s, data: safeJSON(s.data, {}), attribution_analysis: safeJSON(s.attribution_analysis, null),
    }, ['created_at', 'resolved_at', 'snoozed_until', 'do_not_act_until']));

    return res.json({
      signals, total, filters_applied: { severity, status, connector, type, q },
      pagination: paginationMeta(total, page, limit),
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /signals/:signalId — single-signal detail: evidence (the raw `data`
 * payload), attribution (the attribution_* columns, populated by
 * signals/ai-analysis.ts for some signal types), related signals (same
 * signal_clusters row, falling back to same connector+rule_id siblings),
 * related tasks, the source connector's freshness, and a resolution
 * history (audit_log entries for this signal).
 */
router.get('/signals/:signalId', requirePermission('signals:read'), (req: Request, res: Response) => {
  try {
    const signalId = String(req.params.signalId);
    const row = db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: `Signal '${signalId}' not found.` });

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'signals:read', row.business_id as string)) {
      return res.status(403).json({ error: 'Permission denied: signal does not belong to an authorized business.' });
    }

    const signal = normalizeTimestamps({
      ...row, data: safeJSON(row.data, {}), attribution_analysis: safeJSON(row.attribution_analysis, null),
    }, ['created_at', 'resolved_at', 'snoozed_until', 'do_not_act_until']);

    const cluster = db.prepare(
      "SELECT id, signal_ids, likely_cause, recommendation FROM signal_clusters WHERE business_id = ? AND signal_ids LIKE ?"
    ).get(row.business_id as string, `%"${signalId}"%`) as { id: string; signal_ids: string; likely_cause: string | null; recommendation: string | null } | undefined;

    let relatedSignals: Array<Record<string, unknown>>;
    if (cluster) {
      const ids = (safeJSON(cluster.signal_ids, []) as string[]).filter((id) => id !== signalId);
      relatedSignals = ids.length
        ? db.prepare(`SELECT id, title, severity, status, created_at FROM signals WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<Record<string, unknown>>
        : [];
    } else {
      // Fallback heuristic: other open signals from the same connector +
      // rule (i.e. the same underlying detector), most recent first.
      relatedSignals = db.prepare(
        `SELECT id, title, severity, status, created_at FROM signals
         WHERE business_id = ? AND rule_id = ? AND connector_id IS ? AND id != ?
         ORDER BY created_at DESC LIMIT 10`
      ).all(row.business_id as string, row.rule_id as string, row.connector_id as string | null, signalId) as Array<Record<string, unknown>>;
    }

    const relatedTasks = db.prepare(
      'SELECT id, title, status, action_type, created_at FROM tasks WHERE signal_id = ? ORDER BY created_at DESC'
    ).all(signalId) as Array<Record<string, unknown>>;

    const connector = row.connector_id
      ? db.prepare('SELECT id, type, status, last_sync, last_error FROM connectors WHERE id = ?').get(row.connector_id as string) as Record<string, unknown> | undefined
      : null;

    const resolutionHistory = (db.prepare(
      "SELECT action, actor, before_state, after_state, created_at FROM audit_log WHERE entity_type = 'signal' AND entity_id = ? ORDER BY created_at ASC"
    ).all(signalId) as Array<Record<string, unknown>>).map((r) => normalizeTimestamps({
      action: r.action, actor: r.actor, created_at: r.created_at,
      from_status: safeJSON(r.before_state, null) ? (safeJSON(r.before_state, {}) as Record<string, unknown>).status ?? null : null,
      to_status: safeJSON(r.after_state, null) ? (safeJSON(r.after_state, {}) as Record<string, unknown>).status ?? null : null,
    }, ['created_at']));

    return res.json({
      signal,
      evidence: signal.data,
      attribution: {
        primary_cause: row.attribution_primary_cause ?? null,
        primary_confidence: row.attribution_primary_confidence ?? null,
        recommendation: row.attribution_recommendation ?? null,
        analysis: signal.attribution_analysis,
      },
      related_signals: (cluster
        ? relatedSignals.map((s) => ({ ...s, relation: 'cluster', cluster_id: cluster.id }))
        : relatedSignals.map((s) => ({ ...s, relation: 'same_detector' }))
      ).map((s) => normalizeTimestamps(s, ['created_at'])),
      related_tasks: relatedTasks.map((t) => normalizeTimestamps(t, ['created_at'])),
      connector_freshness: connector ? normalizeTimestamps(connector, ['last_sync']) : null,
      resolution_history: resolutionHistory,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/businesses/:businessId/signals', requirePermission('signals:create'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { type, severity, title, description, data, confidence, connector_id, goal_id } = req.body as {
      type?: string;
      severity?: string;
      title?: string;
      description?: string;
      data?: Record<string, unknown>;
      confidence?: number;
      connector_id?: string;
      goal_id?: string;
    };

    if (!title || !severity || !type) {
      return res.status(400).json({ error: 'type, severity, and title are required.' });
    }
    if (goal_id) {
      const goal = db.prepare('SELECT id FROM goals WHERE id = ? AND business_id = ?').get(goal_id, businessId);
      if (!goal) return res.status(400).json({ error: `Goal '${goal_id}' not found for this business.` });
    }

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;

    await withRequiredIdempotency(req, res, 'signals:create', async () => {
      const id = generateId();
      db.prepare(`
        INSERT INTO signals (id, business_id, connector_id, goal_id, rule_id, type, severity,
                             title, description, data, status, confidence, agent_id, created_at)
        VALUES (?, ?, ?, ?, 'bap_external', ?, ?, ?, ?, ?, 'open', ?, ?, CURRENT_TIMESTAMP)
      `).run(
        id, businessId, connector_id ?? null, goal_id ?? null,
        type, severity, stripThink(title) ?? title, stripThink(description),
        JSON.stringify(data ?? {}), confidence ?? null,
        bapAgent.id as string
      );

      // Dispatch webhook for signal.created
      try {
        const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js') as unknown as {
          dispatchWebhookEvent: (event: string, payload: Record<string, unknown>) => void;
        };
        dispatchWebhookEvent('signal.created', {
          signal_id: id, business_id: businessId, type, severity, title, confidence,
        });
        if (severity === 'critical') {
          dispatchWebhookEvent('signal.critical', {
            signal_id: id, business_id: businessId, type, severity, title, confidence,
          });
        }
      } catch {}

      // Phase 3 — fire-and-forget signal-vs-goal conflict check, same
      // pattern as bap-goals.ts's post-create conflict check.
      import('../brain/conflict-engine.js')
        .then((m) => (m as unknown as { checkSignalGoalConflicts: (s: Record<string, unknown>, bid: string) => Promise<unknown> })
          .checkSignalGoalConflicts({ id, title, description, type, severity }, businessId))
        .catch(() => {});

      return { status: 201, body: { signal_id: id, created: true } };
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.patch('/signals/:signalId', requirePermission('signals:read'), async (req: Request, res: Response) => {
  try {
    const signalId = String(req.params.signalId);
    const { status, note } = req.body as { status?: string; note?: string };
    const existing = db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Signal not found.' });

    // The route above only confirmed the caller holds `signals:read` for
    // *some* business (there's no :businessId in this path for the coarse
    // check to scope to). Re-check against the signal's actual business
    // now that we know it, closing the cross-tenant IDOR this route used
    // to have.
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'signals:read', existing.business_id as string)) {
      return res.status(403).json({ error: 'Permission denied: signal does not belong to an authorized business.' });
    }

    if (!status) return res.status(400).json({ error: 'status is required.' });

    await withRequiredIdempotency(req, res, 'signals:update', async () => {
      const updates = ['status = ?'];
      const values: any[] = [status];
      if (status === 'resolved') updates.push('resolved_at = CURRENT_TIMESTAMP');
      values.push(signalId);
      db.prepare(`UPDATE signals SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      return { status: 200, body: { signal_id: signalId, status, updated: true } };
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ─── TASKS ──────────────────────────────────────────────────────────────────

const TASK_SORT_COLUMNS = new Set(['created_at', 'updated_at', 'priority', 'status', 'confidence']);

/**
 * Escape SQLite LIKE wildcards (`%`, `_`) in caller-supplied search text so
 * a title containing e.g. "50% off" doesn't silently behave as a wildcard
 * match — not a security issue (parameterized either way), just correctness.
 */
function likeTerm(raw: string): string {
  return `%${raw.replace(/[%_]/g, (c) => `\\${c}`)}%`;
}

router.get('/businesses/:businessId/tasks', requirePermission('tasks:read'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const {
      q, status, priority, action_type, created_by, assigned_agent,
      signal_id, goal_id, created_from, created_to,
      sort = 'created_at', order = 'desc',
    } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId];

    if (q) {
      conditions.push('(title LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')');
      const term = likeTerm(String(q));
      params.push(term, term);
    }
    if (status) {
      const arr = String(status).split(',');
      conditions.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (priority) {
      const arr = String(priority).split(',');
      conditions.push(`priority IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (action_type) {
      const arr = String(action_type).split(',');
      conditions.push(`action_type IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (created_by) {
      const arr = String(created_by).split(',');
      conditions.push(`proposed_by IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (assigned_agent) {
      const arr = String(assigned_agent).split(',');
      conditions.push(`assigned_to IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (signal_id) { conditions.push('signal_id = ?'); params.push(String(signal_id)); }
    if (created_from) { conditions.push('created_at >= ?'); params.push(String(created_from)); }
    if (created_to) { conditions.push('created_at <= ?'); params.push(String(created_to)); }

    // goal_id is a real FK (Phase 3) — see PHASE3.md. Previously this was
    // a best-effort proxy through the shared project_id column.
    if (goal_id) { conditions.push('goal_id = ?'); params.push(String(goal_id)); }

    const where = conditions.join(' AND ');
    const sortCol = TASK_SORT_COLUMNS.has(String(sort)) ? String(sort) : 'created_at';
    const sortDir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);

    const total = (db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = (db.prepare(
      `SELECT * FROM tasks WHERE ${where} ORDER BY ${sortCol} ${sortDir}, id ${sortDir} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>).map((t) => normalizeTimestamps({
      ...t,
      action_payload: safeJSON(t.action_payload, {}),
      outcome_data: safeJSON(t.outcome_data, null),
    }, ['created_at', 'updated_at', 'approved_at', 'started_at', 'completed_at']));

    return res.json({ tasks: rows, total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /tasks/:taskId/kanban-card - canonical Blueprint-to-Hermes card projection. */
router.get('/tasks/:taskId/kanban-card', requirePermission('tasks:read'), (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: `Task '${taskId}' not found.` });

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'tasks:read', row.business_id as string)) {
      return res.status(403).json({ error: 'Permission denied: task does not belong to an authorized business.' });
    }

    return res.json({ card: buildKanbanCard(row) });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /businesses/:businessId/kanban-cards - business-scoped card sync feed for Hermes. */
router.get('/businesses/:businessId/kanban-cards', requirePermission('tasks:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { status, updated_from } = req.query;
    const conditions: string[] = ['business_id = ?'];
    const params: Array<string | number | null> = [businessId];
    if (status) {
      const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length) {
        conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (updated_from) { conditions.push('updated_at >= ?'); params.push(String(updated_from)); }
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const where = conditions.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Record<string, unknown>>;
    return res.json({ cards: rows.map(buildKanbanCard), total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
/**
 * GET /tasks/:taskId - single-task detail. No :businessId in the path, so ownership is re-derived from the fetched row.
 */
router.get('/tasks/:taskId', requirePermission('tasks:read'), (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: `Task '${taskId}' not found.` });

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'tasks:read', row.business_id as string)) {
      return res.status(403).json({ error: 'Permission denied: task does not belong to an authorized business.' });
    }

    const task = normalizeTimestamps({
      ...row,
      action_payload: safeJSON(row.action_payload, {}),
      outcome_data: safeJSON(row.outcome_data, null),
      rollback_data: safeJSON(row.rollback_data, null),
    }, ['created_at', 'updated_at', 'approved_at', 'started_at', 'completed_at']);

    const linkedSignal = row.signal_id
      ? db.prepare('SELECT id, type, severity, title, status, confidence, created_at FROM signals WHERE id = ?').get(row.signal_id as string) ?? null
      : null;

    // Real FK (Phase 3) — a task links to at most one goal directly, plus
    // any other active goals still reachable via the legacy project_id
    // proxy for tasks created before the FK existed.
    const directGoal = row.goal_id
      ? db.prepare("SELECT id, title, status, progress_pct FROM goals WHERE id = ? AND business_id = ?").get(row.goal_id as string, row.business_id as string)
      : null;
    const proxyGoals = row.project_id
      ? db.prepare("SELECT id, title, status, progress_pct FROM goals WHERE project_id = ? AND business_id = ? AND status != 'cancelled' AND id != ?").all(row.project_id as string, row.business_id as string, (row.goal_id as string | null) ?? '')
      : [];
    const linkedGoals = [directGoal, ...proxyGoals].filter(Boolean);

    const jobs = (db.prepare(
      `SELECT id, status, attempt_count, max_attempts, lease_owner, lease_expires_at,
              external_reference, last_error, result, created_at, updated_at
       FROM execution_jobs WHERE task_id = ? ORDER BY created_at DESC`
    ).all(taskId) as Array<Record<string, unknown>>).map((j) => normalizeTimestamps({
      ...j,
      external_reference: safeJSON(j.external_reference, null),
      result: safeJSON(j.result, null),
    }, ['created_at', 'updated_at', 'lease_expires_at']) as Record<string, unknown>);

    const outcomeChecks = db.prepare(
      'SELECT check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, verdict_detail FROM task_outcomes WHERE task_id = ? ORDER BY weeks_after ASC'
    ).all(taskId) as Array<Record<string, unknown>>;

    const auditCount = (db.prepare(
      "SELECT COUNT(*) as n FROM audit_log WHERE entity_type = 'task' AND entity_id = ?"
    ).get(taskId) as { n: number }).n;
    const lastAudit = db.prepare(
      "SELECT action, actor, created_at FROM audit_log WHERE entity_type = 'task' AND entity_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(taskId) as { action: string; actor: string; created_at: string } | undefined;

    const childTasks = db.prepare(
      'SELECT id, title, status, action_type FROM tasks WHERE parent_task_id = ?'
    ).all(taskId) as Array<Record<string, unknown>>;
    const parentTask = row.parent_task_id
      ? db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(row.parent_task_id as string) ?? null
      : null;

    return res.json({
      task,
      approval: {
        status: row.status,
        approved_by: row.approved_by ?? null,
        approved_at: toIso(row.approved_at),
        rejection_reason: row.rejection_reason ?? null,
        trust_tier: row.trust_tier,
        approval_mode: row.approval_mode,
      },
      execution: {
        status: row.status,
        started_at: toIso(row.started_at),
        completed_at: toIso(row.completed_at),
        active_job_id: jobs.find((j) => ['queued', 'leased', 'executing', 'manual_review'].includes(String(j.status)))?.id ?? null,
        jobs,
      },
      linked_signal: linkedSignal,
      linked_goals: linkedGoals,
      dependencies: { parent_task: parentTask, child_tasks: childTasks },
      outcome: {
        target_metric: row.target_metric ?? null,
        target_metric_baseline: row.target_metric_baseline ?? null,
        checks: outcomeChecks,
        ...computeOutcomeStatus({
          task_status: row.status as string,
          target_metric: (row.target_metric as string | null) ?? null,
          completed_at: (row.completed_at as string | null) ?? null,
          checks: outcomeChecks as unknown as Array<{ weeks_after: number; verdict: string | null }>,
        }),
      },
      audit_summary: { total_events: auditCount, last_action: lastAudit ? { action: lastAudit.action, actor: lastAudit.actor, at: toIso(lastAudit.created_at) } : null },
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /tasks/:taskId/history — the task_events narrative timeline (same data the dashboard task-detail page shows). */
router.get('/tasks/:taskId/history', requirePermission('tasks:read'), async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId);
    const taskRow = db.prepare('SELECT business_id FROM tasks WHERE id = ?').get(taskId) as { business_id: string } | undefined;
    if (!taskRow) return res.status(404).json({ error: `Task '${taskId}' not found.` });

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'tasks:read', taskRow.business_id)) {
      return res.status(403).json({ error: 'Permission denied: task does not belong to an authorized business.' });
    }

    const { getTaskEvents } = await import('../tasks/task-events.js') as unknown as {
      getTaskEvents: (taskId: string) => Array<Record<string, unknown>>;
    };
    const events = getTaskEvents(taskId).map((e) => normalizeTimestamps(e, ['created_at']));
    return res.json({ task_id: taskId, events });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/businesses/:businessId/tasks', requirePermission('tasks:propose'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const {
      title, description, action_type, priority = 'p2', confidence,
      estimated_impact, signal_id, goal_id, assigned_to, action_payload,
    } = req.body as {
      title?: string;
      description?: string;
      action_type?: string;
      priority?: string;
      confidence?: number;
      estimated_impact?: string;
      signal_id?: string;
      goal_id?: string;
      assigned_to?: string;
      action_payload?: Record<string, unknown>;
    };

    if (!title) return res.status(400).json({ error: 'title is required.' });

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;

    await withRequiredIdempotency(req, res, 'tasks:propose', async () => {
      const { createTask } = await import('../tasks/task-queue.js') as unknown as {
        createTask: (opts: Record<string, unknown>) => Record<string, unknown>;
      };
      const { createTaskEvent } = await import('../tasks/task-events.js') as unknown as {
        createTaskEvent: (taskId: string, type: string, actor: string, msg: string, meta: Record<string, unknown>) => void;
      };

      const task = createTask({
        business_id: businessId,
        signal_id: signal_id ?? null,
        goal_id: goal_id ?? null,
        title: stripThink(title) ?? title,
        description: stripThink(description),
        proposed_by: `bap:${bapAgent.id as string}`,
        assigned_to: assigned_to ?? null,
        action_type: action_type ?? null,
        action_payload: action_payload ?? {},
        trust_tier: (bapAgent.default_trust_tier as string | undefined) ?? 'yellow',
        priority,
        confidence: confidence ?? null,
        estimated_impact: estimated_impact ?? null,
        approval_mode: 'requires_approval',
      });

      createTaskEvent(
        task.id as string, 'created', `bap:${bapAgent.id as string}`,
        `Task proposed by external agent "${bapAgent.name as string}"`,
        { source: 'bap', agent_id: bapAgent.id }
      );

      return {
        status: 201,
        body: { task_id: task.id, status: task.status, trust_tier: task.trust_tier, approval_required: true },
      };
    });
  } catch (err) {
    if ((err as Error).message.includes('not found')) return res.status(400).json({ error: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.patch('/tasks/:taskId', requirePermission('tasks:approve'), async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId);
    const { action, note, reason } = req.body as { action?: string; note?: string; reason?: string };
    if (!action || !['approve', 'reject', 'cancel'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve", "reject", or "cancel".' });
    }

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;

    // Same issue as PATCH /signals/:id — this path has no :businessId for
    // the coarse permission check to scope to. Look the task up first and
    // re-check against its actual business before approving/rejecting or
    // (for approve) executing it, closing the cross-tenant IDOR.
    const taskRow = db.prepare('SELECT business_id FROM tasks WHERE id = ?').get(taskId) as { business_id: string } | undefined;
    if (!taskRow) return res.status(404).json({ error: `Task '${taskId}' not found.` });
    if (!hasPermission(bapAgent, 'tasks:approve', taskRow.business_id)) {
      return res.status(403).json({ error: 'Permission denied: task does not belong to an authorized business.' });
    }

    await withRequiredIdempotency(req, res, 'tasks:approve', async () => {
      const { approveTask, rejectTask, cancelTask } = await import('../tasks/task-queue.js') as unknown as {
        approveTask: (id: string, actor: string) => Record<string, unknown>;
        rejectTask: (id: string, actor: string, reason: string) => Record<string, unknown>;
        cancelTask: (id: string, actor: string, reason?: string) => Record<string, unknown>;
      };
      const { createTaskEvent } = await import('../tasks/task-events.js') as unknown as {
        createTaskEvent: (taskId: string, type: string, actor: string, msg: string, meta: Record<string, unknown>) => void;
      };

      let task: Record<string, unknown>;
      if (action === 'approve') {
        // approveTask() atomically enqueues a durable execution job and
        // wakes the worker itself — no separate executeTask() call here.
        // This is the same function the dashboard and Telegram call; see
        // task-queue.ts's approveTask docstring for why that unification
        // matters (it's what makes Telegram approvals actually execute).
        task = approveTask(taskId, `bap:${bapAgent.id as string}`);
        createTaskEvent(taskId, 'approved', `bap:${bapAgent.id as string}`, note ?? 'Approved via BAP', {});
      } else if (action === 'reject') {
        task = rejectTask(taskId, `bap:${bapAgent.id as string}`, note ?? '');
        createTaskEvent(taskId, 'rejected', `bap:${bapAgent.id as string}`, note ?? 'Rejected via BAP', {});
      } else {
        // cancel — only valid from proposed/approved/manual_review (see
        // task-queue.ts:cancelTask); also cancels any active execution job.
        task = cancelTask(taskId, `bap:${bapAgent.id as string}`, reason ?? note ?? '');
        createTaskEvent(taskId, 'status_changed', `bap:${bapAgent.id as string}`, note ?? reason ?? 'Cancelled via BAP', { new_status: 'cancelled' });
      }

      return { status: 200, body: { task_id: taskId, status: task.status, action } };
    });
  } catch (err) {
    if ((err as Error).message.includes('not found')) return res.status(404).json({ error: (err as Error).message });
    if ((err as Error).message.includes('Cannot')) return res.status(422).json({ error: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ─── EXECUTION JOBS (operational visibility/control over approved-task runs) ─

router.get('/businesses/:businessId/execution-jobs', requirePermission('tasks:read'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { status, limit, page } = req.query;

    const { listExecutionJobs } = await import('../tasks/execution-jobs.js') as unknown as {
      listExecutionJobs: (businessId: string, filters: { status?: string[]; limit?: number; page?: number }) =>
        { jobs: unknown[]; total: number; page: number; limit: number; pages: number };
    };

    const result = listExecutionJobs(businessId, {
      status: status ? String(status).split(',') : undefined,
      limit: limit ? parseInt(String(limit), 10) : undefined,
      page: page ? parseInt(String(page), 10) : undefined,
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/execution-jobs/:jobId', requirePermission('tasks:read'), async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const { getExecutionJob } = await import('../tasks/execution-jobs.js') as unknown as {
      getExecutionJob: (id: string) => Record<string, unknown> | null;
    };
    const job = getExecutionJob(jobId);
    if (!job) return res.status(404).json({ error: `Execution job '${jobId}' not found.` });

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'tasks:read', job.business_id as string)) {
      return res.status(403).json({ error: 'Permission denied: execution job does not belong to an authorized business.' });
    }

    return res.json({ job });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/execution-jobs/:jobId/retry', requirePermission('tasks:approve'), async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const { getExecutionJob, retryJob } = await import('../tasks/execution-jobs.js') as unknown as {
      getExecutionJob: (id: string) => Record<string, unknown> | null;
      retryJob: (id: string) => boolean;
    };
    const job = getExecutionJob(jobId);
    if (!job) return res.status(404).json({ error: `Execution job '${jobId}' not found.` });

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'tasks:approve', job.business_id as string)) {
      return res.status(403).json({ error: 'Permission denied: execution job does not belong to an authorized business.' });
    }

    await withRequiredIdempotency(req, res, 'execution-jobs:retry', async () => {
      const retried = retryJob(jobId);
      if (!retried) {
        return {
          status: 409,
          body: { error: `Job '${jobId}' is not in a retryable state (dead_letter, manual_review, or cancelled).` },
        };
      }
      // Wake the worker immediately rather than waiting for the next cron
      // tick — same lazy-import pattern as task-queue.ts's approveTask, to
      // avoid a circular dependency at module load time.
      import('../jobs/scheduler.js')
        .then((m) => { (m as unknown as { runExecutionWorkerTickNow?: () => void }).runExecutionWorkerTickNow?.(); })
        .catch(() => {});
      return { status: 200, body: { job_id: jobId, status: 'queued', retried: true } };
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/execution-jobs/:jobId/cancel', requirePermission('tasks:approve'), async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const { getExecutionJob, cancelJob } = await import('../tasks/execution-jobs.js') as unknown as {
      getExecutionJob: (id: string) => Record<string, unknown> | null;
      cancelJob: (id: string) => boolean;
    };
    const job = getExecutionJob(jobId);
    if (!job) return res.status(404).json({ error: `Execution job '${jobId}' not found.` });

    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'tasks:approve', job.business_id as string)) {
      return res.status(403).json({ error: 'Permission denied: execution job does not belong to an authorized business.' });
    }

    await withRequiredIdempotency(req, res, 'execution-jobs:cancel', async () => {
      const cancelled = cancelJob(jobId);
      if (!cancelled) {
        return {
          status: 409,
          body: { error: `Job '${jobId}' is not in a cancellable state (queued or manual_review).` },
        };
      }
      return { status: 200, body: { job_id: jobId, status: 'cancelled', cancelled: true } };
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ─── KNOWLEDGE BASE ─────────────────────────────────────────────────────────

router.get('/businesses/:businessId/kb/file/*', requirePermission('kb:read'), async (req: Request, res: Response) => {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
      getKBForBusiness: (businessId: string) => Promise<{ engine: Record<string, (...args: any[]) => Promise<unknown>> } | null>;
    };
    const result = await getKBForBusiness(String(req.params.businessId));
    if (!result) return res.status(404).json({ error: 'Business not found or KB not initialized.' });

    const filePath = (req.params as unknown as Record<string, string>)[0];
    const file = await result.engine['readFile']!(filePath);
    const backlinks = await result.engine['getBacklinks']!(filePath);

    return res.json({ ...(file as Record<string, unknown>), backlinks });
  } catch (err) {
    if (err instanceof KBPathError) return res.status(400).json({ error: err.message });
    if ((err as Error).message.includes('not found')) return res.status(404).json({ error: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/businesses/:businessId/kb/search', requirePermission('kb:read'), async (req: Request, res: Response) => {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
      getKBForBusiness: (businessId: string) => Promise<{ engine: Record<string, (...args: any[]) => Promise<unknown>> } | null>;
    };
    const result = await getKBForBusiness(String(req.params.businessId));
    if (!result) return res.status(404).json({ error: 'KB not initialized.' });

    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const results = await result.engine['search']!(String(q), parseInt(String(req.query.limit ?? '20'), 10) || 20);
    return res.json({ results, query: q });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/businesses/:businessId/kb/query',
  requirePermission('kb:read'), bapRateLimit('kb:query'),
  async (req: Request, res: Response) => {
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
        getKBForBusiness: (businessId: string) => Promise<{ engine: Record<string, unknown> } | null>;
      };
      const { KBAgent } = await import('../kb/kb-agent.js') as unknown as {
        KBAgent: new (engine: Record<string, unknown>) => {
          query: (q: string, opts: Record<string, unknown>) => Promise<{ answer: string; sourcesRead: unknown; filedPath?: string }>;
        };
      };

      const result = await getKBForBusiness(String(req.params.businessId));
      if (!result) return res.status(404).json({ error: 'KB not initialized.' });

      const { question, file_result, context } = req.body as { question?: string; file_result?: boolean; context?: string };
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
      return res.status(500).json({ error: (err as Error).message });
    }
  }
);

router.post('/businesses/:businessId/kb/write',
  requirePermission('kb:write'), bapRateLimit('kb:write'),
  async (req: Request, res: Response) => {
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
        getKBForBusiness: (businessId: string) => Promise<{
          engine: {
            writeFile: (path: string, content: string, frontmatter: unknown, msg: string) => Promise<Record<string, unknown>>;
          };
        } | null>;
      };
      const result = await getKBForBusiness(String(req.params.businessId));
      if (!result) return res.status(404).json({ error: 'KB not initialized.' });

      const { path: filePath, content, frontmatter, commit_message } = req.body as {
        path?: string;
        content?: string;
        frontmatter?: unknown;
        commit_message?: string;
      };
      if (!filePath || content === undefined) {
        return res.status(400).json({ error: 'path and content are required.' });
      }

      const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;

      await withRequiredIdempotency(req, res, 'kb:write', async () => {
        const written = await result.engine.writeFile(
          filePath, content,
          frontmatter ?? null,
          commit_message ?? `bap: ${bapAgent.name as string} wrote ${filePath}`
        );
        return { status: 200, body: { ...written } };
      });
    } catch (err) {
      if (err instanceof KBPathError) return res.status(400).json({ error: err.message });
      return res.status(500).json({ error: (err as Error).message });
    }
  }
);

// ─── METRICS ────────────────────────────────────────────────────────────────

router.get('/businesses/:businessId/metrics', requirePermission('metrics:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { connector, metric, limit = '10' } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId];
    if (connector) { conditions.push('connector_id IN (SELECT id FROM connectors WHERE type = ? AND business_id = ?)'); params.push(String(connector), businessId); }
    if (metric) { conditions.push('metric_name = ?'); params.push(String(metric)); }

    const where = conditions.join(' AND ');
    const lim = Math.min(parseInt(String(limit), 10) || 10, 100);
    const rows = (db.prepare(
      `SELECT metric_name, metric_value, metric_data, recorded_at FROM metrics WHERE ${where} ORDER BY recorded_at DESC LIMIT ?`
    ).all(...params, lim) as Array<Record<string, unknown>>).map((r) => ({ ...r, metric_data: safeJSON(r.metric_data, null) }));

    return res.json({ metrics: rows });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/businesses/:businessId/metrics/snapshot', requirePermission('metrics:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const connectors = db.prepare(
      "SELECT id, type FROM connectors WHERE business_id = ? AND status = 'connected'"
    ).all(businessId) as Array<{ id: string; type: string }>;

    const snapshot: Record<string, Record<string, unknown>> = {};
    for (const c of connectors) {
      const latest = db.prepare(
        "SELECT metric_name, metric_value FROM metrics WHERE business_id = ? AND connector_id = ? AND metric_value IS NOT NULL ORDER BY recorded_at DESC LIMIT 30"
      ).all(businessId, c.id) as Array<{ metric_name: string; metric_value: unknown }>;
      if (latest.length > 0) {
        snapshot[c.type] = {};
        for (const m of latest) {
          // Use short name (strip connector prefix if present)
          const shortName = m.metric_name.includes('.')
            ? m.metric_name.split('.').slice(1).join('.')
            : m.metric_name;
          snapshot[c.type]![shortName] = m.metric_value;
        }
      }
    }

    return res.json({ snapshot_at: new Date().toISOString(), connectors: snapshot });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ─── INTERNAL AGENT CONTROL ─────────────────────────────────────────────────

router.get('/businesses/:businessId/agents', requirePermission('agents:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    // Internal agents (the `agents` table) are a shared, instance-wide
    // roster — there is no per-business row to filter on. The previous
    // query returned each agent's *global* run_count/total_cost_usd,
    // which leaked aggregate usage/spend covering every business on the
    // instance to a caller authorized for only one of them. Compute the
    // run count/cost/last-run scoped to the caller's own business instead
    // via agent_runs (which is genuinely business-scoped) so the response
    // only reflects data about the business the caller has access to.
    // `acceptance_rate` has no clean per-business equivalent and is
    // dropped from this response rather than leaked.
    const agents = db.prepare(`
      SELECT
        a.id, a.name, a.status,
        (SELECT MAX(ar.started_at) FROM agent_runs ar WHERE ar.agent_id = a.id AND ar.business_id = ?) AS last_run,
        a.next_run,
        (SELECT COUNT(*) FROM agent_runs ar WHERE ar.agent_id = a.id AND ar.business_id = ?) AS run_count,
        (SELECT COALESCE(SUM(ar.cost_usd), 0) FROM agent_runs ar WHERE ar.agent_id = a.id AND ar.business_id = ?) AS total_cost_usd
      FROM agents a
    `).all(businessId, businessId, businessId);
    return res.json({ agents });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/businesses/:businessId/agents/:agentId/run',
  requirePermission('agents:trigger'), bapRateLimit('agents:trigger'),
  async (req: Request, res: Response) => {
    try {
      const businessId = String(req.params.businessId);
      const agentId = String(req.params.agentId);
      const biz = businessRow(businessId);
      if (!biz) return res.status(404).json({ error: 'Business not found.' });

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
      if (!agent) return res.status(404).json({ error: `Agent '${agentId}' not found.` });

      const { runAgent } = await import('../agents/agent-runner.js') as unknown as {
        runAgent: (agentId: string, businessId: string, trigger: string, triggerId: unknown) => Promise<unknown>;
      };
      // Fire-and-forget — return immediately with run_id
      const runId = generateId();
      const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
      db.prepare(`
        INSERT INTO agent_runs (id, agent_id, business_id, trigger, trigger_id, status, started_at)
        VALUES (?, ?, ?, 'bap', ?, 'running', CURRENT_TIMESTAMP)
      `).run(runId, agentId, businessId, bapAgent.id as string);

      // Run in background
      runAgent(agentId, businessId, 'bap', bapAgent.id).catch((err: Error) => {
        console.error(`[BAP] Agent run ${agentId} failed:`, err.message);
      });

      return res.status(202).json({
        run_id: runId,
        agent_id: agentId,
        status: 'queued',
        estimated_start: 'immediate',
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
);

router.get('/runs/:runId', (req: Request, res: Response) => {
  try {
    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(String(req.params.runId)) as Record<string, unknown> | undefined;
    if (!run) return res.status(404).json({ error: 'Run not found.' });

    // This route previously had no permission check at all — any agent
    // holding any valid, active API key could read any business's run
    // reasoning/cost by ID. Require agents:read scoped to the run's
    // actual business now that we know it.
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    if (!hasPermission(bapAgent, 'agents:read', run.business_id as string)) {
      return res.status(403).json({
        error: 'Permission denied: agents:read',
        your_permissions: (() => {
          try { return JSON.parse(String(bapAgent.permissions ?? '[]')); } catch { return []; }
        })(),
      });
    }

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
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ─── WEBHOOK MANAGEMENT ────────────────────────────────────────────────────

router.put('/me/webhook', async (req: Request, res: Response) => {
  try {
    const { url, secret, events } = req.body as { url?: string; secret?: string; events?: string[] };
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    const agentId = bapAgent.id as string;

    if (url) {
      try {
        await assertSafeWebhookUrl(url);
      } catch (err) {
        if (err instanceof UnsafeWebhookUrlError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    if (url !== undefined) { updates.push('webhook_url = ?'); values.push(url); }
    if (secret !== undefined) { updates.push('webhook_secret = ?'); values.push(secret); }
    if (events !== undefined) { updates.push('webhook_events = ?'); values.push(JSON.stringify(events)); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Provide at least one of: url, secret, events.' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(agentId);
    db.prepare(`UPDATE bap_agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT webhook_url, webhook_events FROM bap_agents WHERE id = ?').get(agentId) as Record<string, unknown>;
    return res.json({
      ok: true,
      webhook_url: updated.webhook_url,
      webhook_events: safeJSON(updated.webhook_events),
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/me/webhook/deliveries', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    const rows = db.prepare(
      'SELECT id, event_type, delivery_status, attempts, response_code, created_at, last_attempt FROM bap_webhook_deliveries WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(bapAgent.id as string, limit);
    return res.json({ deliveries: rows });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/me/webhook/deliveries/:deliveryId/retry', async (req: Request, res: Response) => {
  try {
    const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
    const row = db.prepare(
      'SELECT * FROM bap_webhook_deliveries WHERE id = ? AND agent_id = ?'
    ).get(String(req.params.deliveryId), bapAgent.id as string) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: 'Delivery not found.' });

    db.prepare(
      "UPDATE bap_webhook_deliveries SET delivery_status = 'retrying', next_retry = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(row.id as string);

    const { retryPendingDeliveries } = await import('../bap/webhook-dispatcher.js') as unknown as {
      retryPendingDeliveries: () => Promise<void>;
    };
    retryPendingDeliveries().catch(() => {});

    return res.json({ delivery_id: row.id, status: 'retrying' });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin routes — used by the Settings UI (session auth, NOT BAP key)
// Mounted alongside the BAP routes but guarded by isAuthenticated.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/agents-admin', isAuthenticated, (req: Request, res: Response) => {
  try {
    const agents = (db.prepare(
      'SELECT id, name, description, owner, api_key_prefix, status, permissions, business_access, default_trust_tier, webhook_url, webhook_events, last_seen, total_calls, created_at FROM bap_agents ORDER BY created_at DESC'
    ).all() as Array<Record<string, unknown>>).map((a) => ({
      ...a,
      permissions: safeJSON(a.permissions),
      business_access: safeJSON(a.business_access),
      webhook_events: safeJSON(a.webhook_events),
    }));
    return res.json({ agents });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.patch('/agents-admin/:agentId', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const agentId = String(req.params.agentId);
    const agent = db.prepare('SELECT id FROM bap_agents WHERE id = ?').get(agentId) as { id: string } | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const { business_access, permissions, webhook_url, webhook_events, name, description } = req.body as {
      business_access?: string[];
      permissions?: string[];
      webhook_url?: string;
      webhook_events?: string[];
      name?: string;
      description?: string;
    };

    const updates: string[] = [];
    const params: unknown[] = [];

    if (Array.isArray(business_access)) {
      const valid = filterValidBusinessIds(business_access);
      updates.push('business_access = ?');
      params.push(JSON.stringify(valid));
    }
    if (Array.isArray(permissions)) {
      const granted = filterGrantablePermissions(permissions);
      updates.push('permissions = ?');
      params.push(JSON.stringify(granted));
    }
    if (typeof webhook_url === 'string') {
      updates.push('webhook_url = ?');
      params.push(webhook_url || null);
    }
    if (Array.isArray(webhook_events)) {
      updates.push('webhook_events = ?');
      params.push(JSON.stringify(webhook_events));
    }
    if (typeof name === 'string' && name.trim()) {
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (typeof description === 'string') {
      updates.push('description = ?');
      params.push(description || null);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(agentId);
    db.prepare(`UPDATE bap_agents SET ${updates.join(', ')} WHERE id = ?`).run(...(params as import('bun:sqlite').SQLQueryBindings[]));

    const updated = db.prepare(
      'SELECT id, name, description, owner, api_key_prefix, status, permissions, business_access, webhook_url, last_seen, total_calls, created_at FROM bap_agents WHERE id = ?'
    ).get(agentId) as Record<string, unknown> | undefined;

    return res.json({
      ...updated,
      permissions: safeJSON(updated?.permissions as string) as string[],
      business_access: safeJSON(updated?.business_access as string) as string[],
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/agents-admin/:agentId/revoke', isAuthenticated, (req: Request, res: Response) => {
  try {
    const agentId = String(req.params.agentId);
    db.prepare("UPDATE bap_agents SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(agentId);
    return res.json({ ok: true, agent_id: agentId, status: 'revoked' });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/agents-admin/:agentId/audit', isAuthenticated, (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const rows = db.prepare(
      'SELECT id, method, endpoint, business_id, status_code, duration_ms, created_at FROM bap_audit WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(String(req.params.agentId), limit);
    return res.json({ calls: rows });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/agents-admin/:agentId/deliveries', isAuthenticated, (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const rows = db.prepare(
      'SELECT id, event_type, delivery_status, attempts, response_code, created_at, last_attempt FROM bap_webhook_deliveries WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(String(req.params.agentId), limit);
    return res.json({ deliveries: rows });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
