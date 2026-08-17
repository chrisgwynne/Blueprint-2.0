/**
 * Blueprint Agent Protocol (BAP) — Verified action receipts (issue #70).
 *
 * The permission-scoped readback surface for receipts. Two independent
 * gates, matching the convention every other business-scoped BAP route
 * uses (see bap-outcomes.ts):
 *
 *   1. `requirePermission('receipts:read')` — the agent must hold the
 *      grant AND have the path's business in its `business_access` list
 *      (bap/auth.ts:hasPermission resolves :businessId from the route).
 *   2. For ID-addressed lookups, where the path carries no business, the
 *      row's own `business_id` is re-checked against the agent's access
 *      before anything is returned — an agent scoped to business B can
 *      never read business A's receipt by guessing a receipt or task ID.
 *
 * Read-only: no BAP route writes a receipt. Receipts are produced by the
 * approval/execution path itself (server/tasks/action-receipts.ts); an
 * agent-authored receipt would be a claim, not evidence.
 *
 * Endpoints:
 *   GET /businesses/:bid/receipts     — list (filterable, paginated)
 *   GET /tasks/:taskId/receipts       — every receipt for one task
 *   GET /receipts/:receiptId          — single receipt detail
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { parsePagination, paginationMeta, sendError } from '../bap/route-helpers.js';
import {
  listReceipts, listReceiptsForTask, getReceipt, receiptStateSummary, toReceiptView,
  RECEIPT_SCHEMA_VERSION,
} from '../tasks/action-receipts.js';

// No blanket auth/rate-limit middleware here — see bap-goals.ts's docstring
// on this file's mounting inside bap.ts's already-authenticated router chain.
const router = Router();

function parseList(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  const values = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function agentOf(req: Request): Record<string, unknown> {
  return (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
}

router.get('/businesses/:businessId/receipts', requirePermission('receipts:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const result = listReceipts(businessId, {
      state: parseList(req.query.state),
      action_type: parseList(req.query.action_type),
      result_status: parseList(req.query.result_status),
      task_id: req.query.task_id ? String(req.query.task_id) : undefined,
      page,
      limit,
    });

    return res.json({
      receipt_schema_version: RECEIPT_SCHEMA_VERSION,
      receipts: result.receipts.map(toReceiptView),
      summary: receiptStateSummary(businessId),
      total: result.total,
      pagination: paginationMeta(result.total, result.page, result.limit),
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/tasks/:taskId/receipts', requirePermission('receipts:read'), (req: Request, res: Response) => {
  try {
    const receipts = listReceiptsForTask(String(req.params.taskId));
    if (!receipts.length) {
      return sendError(req, res, 404, 'not_found', `No receipts found for task '${req.params.taskId}'.`);
    }
    // The path carries no business ID, so authorization is decided by the
    // rows themselves — every receipt must belong to a business this agent
    // may read, or the whole request is denied.
    const agent = agentOf(req);
    const authorized = receipts.every((r) => hasPermission(agent, 'receipts:read', r.business_id));
    if (!authorized) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: task does not belong to an authorized business.');
    }
    return res.json({
      receipt_schema_version: RECEIPT_SCHEMA_VERSION,
      receipts: receipts.map(toReceiptView),
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.get('/receipts/:receiptId', requirePermission('receipts:read'), (req: Request, res: Response) => {
  try {
    const receipt = getReceipt(String(req.params.receiptId));
    if (!receipt) return sendError(req, res, 404, 'not_found', `Receipt '${req.params.receiptId}' not found.`);
    if (!hasPermission(agentOf(req), 'receipts:read', receipt.business_id)) {
      return sendError(req, res, 403, 'permission_denied', 'Permission denied: receipt does not belong to an authorized business.');
    }
    return res.json({ receipt_schema_version: RECEIPT_SCHEMA_VERSION, receipt: toReceiptView(receipt) });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
