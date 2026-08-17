/**
 * Blueprint Agent Protocol (BAP) — Connectors.
 *
 * Closes the "connector status" gap from AUDIT-BAP-GAPS.md: previously an
 * agent could only infer a connector's health indirectly and unreliably
 * from the *absence* of expected metrics via GET .../metrics/snapshot —
 * there was no way to distinguish "this business genuinely has 0 orders"
 * from "the Shopify connector has been failing to sync for 3 days".
 *
 * Freshness/staleness is computed via server/connectors/freshness.ts — the
 * exact same live-recompute logic server/routes/system-health.ts (the
 * dashboard's System Health page) uses, so a BAP caller and a human
 * looking at the dashboard never see different answers to "is this stale".
 *
 * `credentials` (encrypted at rest) is never selected by any query in this
 * file — every SELECT uses an explicit column list that excludes it,
 * matching the pattern already used by server/routes/public-api.ts and
 * server/routes/bap.ts (see AUDIT-BAP-GAPS.md's credential-safety review).
 *
 * Endpoints:
 *   GET    /businesses/:bid/connectors        — list (freshness, config summary)
 *   GET    /connectors/:id                    — detail (health, sync stats)
 *   GET    /connectors/:id/syncs              — sync history (paginated, filterable)
 *   POST   /connectors/:id/sync               — trigger a sync now
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { bapRateLimit } from '../bap/rate-limiter.js';
import {
  parsePagination, paginationMeta, normalizeTimestamps,
  withRequiredIdempotency, sendError,
} from '../bap/route-helpers.js';
import { computeFreshness } from '../connectors/freshness.js';
import { isConnectorApplicable } from '../connectors/confidence.js';
import { explainConnectorHealth } from '../connectors/health.js';

// No blanket auth/rate-limit middleware here — see bap-goals.ts's
// docstring on this file's mounting inside bap.ts's already-authenticated
// router chain. The 'connectors:sync' rate limit below is per-route
// (distinct budget from the default), not the removed top-level one.
const router = Router();

// Explicit column list — never `credentials`. Matches public-api.ts's and
// bap.ts's existing convention rather than SELECT * + destructure-and-strip.
const CONNECTOR_SAFE_COLUMNS = 'id, business_id, type, name, status, last_sync, last_error, config, created_at';

function safeJSON<T>(val: unknown, fallback: T): T {
  if (Array.isArray(val) || (typeof val === 'object' && val !== null)) return val as T;
  if (!val) return fallback;
  try { return JSON.parse(val as string) as T; } catch { return fallback; }
}

/** config is not guaranteed secret-free by any code-level contract, but no current connector type puts a credential in it — see the module docstring for the credentials.ts finding this whitelist is based on. */
function summarizeConfig(config: unknown): Record<string, unknown> {
  const parsed = safeJSON<Record<string, unknown>>(config, {});
  const { url, siteUrl, propertyId, repos, owner, pollingIntervalMinutes, defaultDataType } = parsed;
  return { url, siteUrl, propertyId, repos, owner, pollingIntervalMinutes, defaultDataType };
}

// Issue #27: a never-used, ecommerce-only connector (e.g. google-merchant)
// on a non-ecommerce business surfaced as `status: 'disconnected'` —
// indistinguishable from a genuinely broken integration, causing false
// "this needs attention" noise for agents/operators. isConnectorApplicable()
// (server/connectors/confidence.ts) already encodes "was this ever synced,
// and if not, does the business's Business Profile business_type actually
// use this connector type" — reused here rather than a second copy of that
// logic, and the raw status is still returned as raw_status for anyone who
// wants ground truth.
function withFreshness(row: Record<string, unknown>): Record<string, unknown> {
  const freshness = computeFreshness(row);
  const applicable = isConnectorApplicable(
    { type: row.type as string, last_sync: row.last_sync as string | null },
    row.business_id as string,
  );
  // health_state/health_* are the issue #65 explainer surface — a superset
  // of `status` that also distinguishes permission_required (a scope/
  // permission fix, not a broken integration) and partial (synced, but the
  // last sync didn't capture everything) from the coarser freshness value
  // `status` already carries. `status` itself is left untouched below for
  // BAP-consumer backward compatibility.
  const health = explainConnectorHealth({
    id: row.id as string, business_id: row.business_id as string, type: row.type as string,
    name: row.name as string, status: row.status as string, last_sync: row.last_sync as string | null,
    last_error: row.last_error as string | null, config: row.config as Record<string, unknown>,
  });
  return normalizeTimestamps({
    id: row.id, business_id: row.business_id, type: row.type, name: row.name,
    status: applicable ? freshness.status : 'not_applicable', raw_status: row.status, last_sync: row.last_sync,
    last_error: row.last_error, config_summary: summarizeConfig(row.config),
    hours_since_sync: freshness.hours_since_sync,
    next_sync_in_minutes: freshness.next_sync_in_minutes,
    stale_threshold_hours: freshness.stale_threshold_hours,
    created_at: row.created_at,
    ...(applicable ? {} : { not_applicable_reason: `This connector type is not used by this business (business_type is not 'ecommerce') and has never synced.` }),
    health_state: health.state,
    health_summary: health.summary,
    health_impact: health.impact,
    health_next_step: health.next_step,
    health_coverage_complete: health.coverage_complete,
  }, ['last_sync', 'created_at']);
}

router.get('/businesses/:businessId/connectors', requirePermission('connectors:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { type, status } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (type) {
      const arr = String(type).split(',');
      conditions.push(`type IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (status) {
      const arr = String(status).split(',');
      conditions.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM connectors WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = db.prepare(
      `SELECT ${CONNECTOR_SAFE_COLUMNS} FROM connectors WHERE ${where} ORDER BY type ASC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>;

    return res.json({ connectors: rows.map(withFreshness), total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

function loadConnectorOr404(req: Request, res: Response, connectorId: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT ${CONNECTOR_SAFE_COLUMNS} FROM connectors WHERE id = ?`).get(connectorId) as Record<string, unknown> | undefined;
  if (!row) { sendError(req, res, 404, 'not_found', `Connector '${connectorId}' not found.`); return null; }
  const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
  if (!hasPermission(bapAgent, 'connectors:read', row.business_id as string)) {
    sendError(req, res, 403, 'permission_denied', 'Permission denied: connector does not belong to an authorized business.');
    return null;
  }
  return row;
}

router.get('/connectors/:connectorId', requirePermission('connectors:read'), (req: Request, res: Response) => {
  try {
    const row = loadConnectorOr404(req, res, String(req.params.connectorId));
    if (!row) return;

    const syncStats = db.prepare(
      `SELECT
         COUNT(*) as total_syncs,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_syncs,
         SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as complete_syncs,
         AVG(duration_ms) as avg_duration_ms,
         MAX(created_at) as last_sync_attempt_at
       FROM connector_syncs WHERE connector_id = ?`
    ).get(row.id as string) as Record<string, unknown>;

    const metricsStored = (db.prepare('SELECT COUNT(*) as n FROM metrics WHERE connector_id = ?').get(row.id as string) as { n: number }).n;

    return res.json({
      connector: withFreshness(row),
      sync_stats: normalizeTimestamps({
        total_syncs: syncStats.total_syncs ?? 0,
        failed_syncs: syncStats.failed_syncs ?? 0,
        complete_syncs: syncStats.complete_syncs ?? 0,
        avg_duration_ms: syncStats.avg_duration_ms != null ? Math.round(Number(syncStats.avg_duration_ms)) : null,
        last_sync_attempt_at: syncStats.last_sync_attempt_at,
      }, ['last_sync_attempt_at']),
      metrics_stored: metricsStored,
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/connectors/:connectorId/syncs', requirePermission('connectors:read'), (req: Request, res: Response) => {
  try {
    const row = loadConnectorOr404(req, res, String(req.params.connectorId));
    if (!row) return;

    const { status } = req.query;
    const conditions = ['connector_id = ?'];
    const params: any[] = [row.id]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (status) {
      const arr = String(status).split(',');
      conditions.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM connector_syncs WHERE ${where}`).get(...params) as { n: number }).n;
    const syncs = (db.prepare(
      `SELECT id, status, records_fetched, metrics_stored, error, duration_ms, created_at FROM connector_syncs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>).map((s) => normalizeTimestamps(s, ['created_at']));

    return res.json({ syncs, total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/connectors/:connectorId/sync', requirePermission('connectors:sync'), bapRateLimit('connectors:sync'), async (req: Request, res: Response) => {
  try {
    const row = loadConnectorOr404(req, res, String(req.params.connectorId));
    if (!row) return;

    await withRequiredIdempotency(req, res, 'connectors:sync', async () => {
      // syncConnector() records its own connector_syncs row (running ->
      // complete/failed) and dispatches connector.sync.complete/error BAP
      // webhooks itself — see jobs/scheduler.ts. Fire-and-forget, same
      // async-trigger shape as POST .../agents/:id/run.
      const { syncConnector } = await import('../jobs/scheduler.js') as unknown as {
        syncConnector: (connector: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
      };
      const fullRow = db.prepare('SELECT * FROM connectors WHERE id = ?').get(row.id as string) as Record<string, unknown>;
      syncConnector(fullRow).catch(() => {});

      return { status: 202, body: { connector_id: row.id, status: 'syncing', message: 'Sync triggered. Poll GET /connectors/:id/syncs for status.' } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
