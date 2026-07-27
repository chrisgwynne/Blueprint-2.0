/**
 * Blueprint Agent Protocol (BAP) — Connector Confidence & Identity Verification.
 *
 * Read-only: confidence is derived state, recomputed whenever a connector
 * syncs (see server/jobs/scheduler.ts and server/routes/connectors.ts) —
 * never directly authored via the API.
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET /businesses/:bid/connector-confidence            — list for a business
 *   GET /connectors/:connectorId/confidence               — one connector's confidence
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission, hasPermission } from '../bap/auth.js';
import { sendError } from '../bap/route-helpers.js';
import { listConnectorConfidence, getConnectorConfidence } from '../connectors/confidence.js';

const router = Router();

router.get('/businesses/:businessId/connector-confidence', requirePermission('connector_confidence:read'), (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  return res.json({ connector_confidence: listConnectorConfidence(businessId) });
});

router.get('/connectors/:connectorId/confidence', requirePermission('connector_confidence:read'), (req: Request, res: Response) => {
  const connectorId = String(req.params.connectorId);
  const connector = db.prepare('SELECT business_id FROM connectors WHERE id = ?').get(connectorId) as { business_id: string } | undefined;
  if (!connector) return sendError(req, res, 404, 'not_found', `Connector '${connectorId}' not found.`);

  const bapAgent = (req as unknown as Record<string, unknown>).bapAgent as Record<string, unknown>;
  if (!hasPermission(bapAgent, 'connector_confidence:read', connector.business_id)) {
    return sendError(req, res, 403, 'permission_denied', 'Permission denied: connector does not belong to an authorized business.');
  }

  const confidence = getConnectorConfidence(connectorId);
  if (!confidence) return sendError(req, res, 404, 'not_found', `No confidence score computed yet for connector '${connectorId}'.`);
  return res.json({ confidence });
});

export default router;
