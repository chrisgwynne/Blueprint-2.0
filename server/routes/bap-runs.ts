/**
 * Blueprint Agent Protocol (BAP) — Agent Runs (list / cancel / retry).
 *
 * server/routes/bap.ts already has the trigger route
 * (`POST /businesses/:bid/agents/:agentId/run`) and single-run detail
 * (`GET /runs/:id`) — left in place there rather than relocated here, to
 * avoid touching already-tested code for pure file-organization reasons.
 * This file adds what's genuinely missing (AUDIT-BAP-GAPS.md): a list
 * endpoint, and operator-style control (cancel/retry) matching the
 * execution_jobs precedent from Phase 1.
 *
 * Two honesty notes, since both differ from how they'd work for a
 * durable execution_jobs job:
 *   - Cancel is a DB-status flip only (`running` -> `cancelled`, CAS via
 *     `WHERE status = 'running'`). server/agents/agent-runner.ts's
 *     runAgent() has no abort signal or mid-run checkpoint anywhere in its
 *     call chain (LLM call -> optional second-pass search -> task
 *     creation) — cancelling stops Blueprint from *treating* the run as
 *     active, it does not interrupt the in-flight LLM call or task
 *     creation already under way.
 *   - Retry re-triggers with the same (agent_id, business_id) — nothing
 *     about a past run's exact inputs is snapshotted for a true replay
 *     (unlike execution_jobs, which stores the job payload verbatim).
 *
 * Endpoints:
 *   GET    /businesses/:bid/runs              — list (filterable, paginated)
 *   POST   /runs/:id/cancel                   — mark cancelled (see above)
 *   POST   /runs/:id/retry                    — re-trigger the same agent/business
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db, { generateId } from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { bapRateLimit } from '../bap/rate-limiter.js';
import { parsePagination, paginationMeta, normalizeTimestamps, withRequiredIdempotency, sendError } from '../bap/route-helpers.js';

// No blanket auth/rate-limit middleware here — see bap-goals.ts's
// docstring on this file's mounting inside bap.ts's already-authenticated
// router chain. The 'agents:trigger' rate limit on retry below is
// per-route (distinct budget from the default), not the removed one.
const router = Router();

const RUN_TIMESTAMP_KEYS = ['started_at', 'completed_at'] as const;

router.get('/businesses/:businessId/runs', requirePermission('agents:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { agent_id, status, trigger } = req.query;

    const conditions = ['business_id = ?'];
    const params: any[] = [businessId]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (agent_id) { conditions.push('agent_id = ?'); params.push(String(agent_id)); }
    if (status) {
      const arr = String(status).split(',');
      conditions.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (trigger) {
      const arr = String(trigger).split(',');
      conditions.push(`trigger IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const total = (db.prepare(`SELECT COUNT(*) as n FROM agent_runs WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = (db.prepare(
      `SELECT id, agent_id, business_id, trigger, trigger_id, status, cost_usd, signals_detected, tasks_proposed, started_at, completed_at, error
       FROM agent_runs WHERE ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>).map((r) => normalizeTimestamps(r, RUN_TIMESTAMP_KEYS));

    return res.json({ runs: rows, total, pagination: paginationMeta(total, page, limit) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

function loadRunOr404(req: Request, res: Response, runId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
  if (!row) { sendError(req, res, 404, 'not_found', `Run '${runId}' not found.`); return null; }
  const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
  if (!hasPermission(bapAgent, 'agents:read', row.business_id as string)) {
    sendError(req, res, 403, 'permission_denied', 'Permission denied: run does not belong to an authorized business.');
    return null;
  }
  return row;
}

router.post('/runs/:runId/cancel', requirePermission('agents:trigger'), async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const row = loadRunOr404(req, res, runId);
    if (!row) return;

    await withRequiredIdempotency(req, res, 'runs:cancel', async () => {
      const result = db.prepare(
        "UPDATE agent_runs SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, error = 'Cancelled via BAP' WHERE id = ? AND status = 'running'"
      ).run(runId);
      if (!result.changes) {
        return { status: 409, body: { error: `Run '${runId}' is not in 'running' status (already finished or cancelled).` } };
      }
      return {
        status: 200,
        body: {
          run_id: runId, status: 'cancelled',
          note: 'This marks the run as cancelled for tracking/cost-cap purposes. It does not interrupt an in-flight LLM call or task creation already under way — see route docstring.',
        },
      };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/runs/:runId/retry', requirePermission('agents:trigger'), bapRateLimit('agents:trigger'), async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const row = loadRunOr404(req, res, runId);
    if (!row) return;
    if (row.status !== 'failed') {
      return sendError(req, res, 422, 'conflict', `Run '${runId}' is not 'failed' (status: '${row.status}') — only failed runs can be retried.`);
    }

    await withRequiredIdempotency(req, res, 'runs:retry', async () => {
      const { runAgent } = await import('../agents/agent-runner.js') as unknown as {
        runAgent: (agentId: string, businessId: string, trigger: string, triggerId: unknown) => Promise<unknown>;
      };
      const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
      const newRunId = generateId();
      db.prepare(`
        INSERT INTO agent_runs (id, agent_id, business_id, trigger, trigger_id, status, started_at)
        VALUES (?, ?, ?, 'bap', ?, 'running', CURRENT_TIMESTAMP)
      `).run(newRunId, row.agent_id as string, row.business_id as string, bapAgent.id as string);

      runAgent(row.agent_id as string, row.business_id as string, 'bap', bapAgent.id).catch((err: Error) => {
        console.error(`[BAP] Retried agent run ${row.agent_id as string} failed:`, err.message);
      });

      return {
        status: 202,
        body: { run_id: newRunId, retried_from: runId, agent_id: row.agent_id, status: 'queued' },
      };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
