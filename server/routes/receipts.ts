/**
 * Verified action receipts — dashboard readback (issue #70).
 *
 * Read-only by design. Receipts are written only by the approval/execution
 * path (server/tasks/action-receipts.ts); nothing an HTTP caller does can
 * author or edit one, because a record you can edit is not evidence.
 *
 * Every response goes through toReceiptView(), which redacts a second time
 * on the way out — so a row written before a redaction rule existed still
 * cannot leak a credential through this API.
 *
 * Endpoints:
 *   GET /api/receipts/:businessId              — list (filterable, paginated) + state summary
 *   GET /api/receipts/:businessId/task/:taskId — every receipt for one task (all approved versions)
 *   GET /api/receipts/:businessId/:receiptId   — single receipt detail
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import {
  listReceipts, listReceiptsForTask, getReceipt, receiptStateSummary, toReceiptView,
  RECEIPT_SCHEMA_VERSION,
} from '../tasks/action-receipts.js';

const router = Router();
router.use(isAuthenticated);

function parseList(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  const values = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { receipts, total, page, limit, pages } = listReceipts(businessId, {
      state: parseList(req.query.state),
      action_type: parseList(req.query.action_type),
      result_status: parseList(req.query.result_status),
      task_id: req.query.task_id ? String(req.query.task_id) : undefined,
      page: parseInt(String(req.query.page ?? ''), 10) || 1,
      limit: parseInt(String(req.query.limit ?? ''), 10) || 50,
    });

    return res.json({
      receipt_schema_version: RECEIPT_SCHEMA_VERSION,
      receipts: receipts.map(toReceiptView),
      summary: receiptStateSummary(businessId),
      pagination: { page, limit, total, pages },
    });
  } catch (err) {
    console.error('[receipts] List error:', err);
    return res.status(500).json({ error: 'Failed to list action receipts.' });
  }
});

router.get('/:businessId/task/:taskId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const taskId = String(req.params.taskId);
    // Business scoping is applied to the rows themselves, never assumed
    // from the path — a receipt belonging to another business is invisible
    // here even if its task ID is guessed correctly.
    const receipts = listReceiptsForTask(taskId).filter((r) => r.business_id === businessId);
    return res.json({
      receipt_schema_version: RECEIPT_SCHEMA_VERSION,
      receipts: receipts.map(toReceiptView),
    });
  } catch (err) {
    console.error('[receipts] Task receipts error:', err);
    return res.status(500).json({ error: 'Failed to load receipts for task.' });
  }
});

router.get('/:businessId/:receiptId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const receipt = getReceipt(String(req.params.receiptId));
    if (!receipt || receipt.business_id !== businessId) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    return res.json({ receipt_schema_version: RECEIPT_SCHEMA_VERSION, receipt: toReceiptView(receipt) });
  } catch (err) {
    console.error('[receipts] Detail error:', err);
    return res.status(500).json({ error: 'Failed to load action receipt.' });
  }
});

export default router;
