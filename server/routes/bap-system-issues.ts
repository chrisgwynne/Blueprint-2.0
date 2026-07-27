/**
 * Blueprint Agent Protocol (BAP) — Blueprint System Issues.
 *
 * The audit trail for "why didn't Blueprint act" — raised when action
 * validation fails, a connector's confidence is too low to trust, etc.
 * (see server/system/system-issues.ts).
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET   /businesses/:bid/system-issues       — list (filterable)
 *   PATCH /system-issues/:id                   — acknowledge/resolve/dismiss
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import { listSystemIssues, getSystemIssue, updateSystemIssueStatus, type SystemIssueStatus } from '../system/system-issues.js';

const router = Router();

const VALID_STATUSES: SystemIssueStatus[] = ['open', 'acknowledged', 'resolved', 'dismissed'];

router.get('/businesses/:businessId/system-issues', requirePermission('system_issues:read'), (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  const status = req.query.status ? String(req.query.status) as SystemIssueStatus : undefined;
  const issue_type = req.query.issue_type ? String(req.query.issue_type) : undefined;
  return res.json({ issues: listSystemIssues({ business_id: businessId, status, issue_type }) });
});

router.patch('/system-issues/:issueId', requirePermission('system_issues:update'), (req: Request, res: Response) => {
  const issueId = String(req.params.issueId);
  const existing = getSystemIssue(issueId);
  if (!existing) return sendError(req, res, 404, 'not_found', `System issue '${issueId}' not found.`);

  const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
  if (existing.business_id && !hasPermission(bapAgent, 'system_issues:update', existing.business_id)) {
    return sendError(req, res, 403, 'permission_denied', 'Permission denied: system issue does not belong to an authorized business.');
  }

  const status = (req.body as { status?: string })?.status as SystemIssueStatus | undefined;
  if (!status || !VALID_STATUSES.includes(status)) {
    return sendError(req, res, 400, 'validation_error', `status must be one of ${VALID_STATUSES.join(', ')}.`);
  }

  return res.json({ issue: updateSystemIssueStatus(issueId, status) });
});

export default router;
