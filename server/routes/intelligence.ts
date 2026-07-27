/**
 * Autonomous Intelligence Foundation API (Phase 2-INT, session-authenticated).
 *
 * Dashboard-facing surface for the 5 new subsystems: Business Truth Layer,
 * Typed Action & Executor Registry, Connector Confidence, World Model, and
 * Blueprint System Issues. Mirrors the read/write split of their BAP
 * counterparts (bap-business-profile.ts, bap-action-registry.ts,
 * bap-connector-confidence.ts, bap-world-model.ts, bap-system-issues.ts).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import { getOrCreateBusinessProfile, updateBusinessProfile, type BusinessProfileUpdate } from '../business/business-profile.js';
import { listActionRegistryEntries, getActionRegistryEntry, upsertActionRegistryEntry, type ActionRegistryUpsert } from '../tasks/action-registry.js';
import { listConnectorConfidence, getConnectorConfidence } from '../connectors/confidence.js';
import { getCurrentWorldModel, getWorldModelHistory } from '../world-model/world-model.js';
import { listSystemIssues, getSystemIssue, updateSystemIssueStatus, type SystemIssueStatus } from '../system/system-issues.js';

const router = Router();
router.use(isAuthenticated);

// ─── Business Profile ────────────────────────────────────────────────────────

router.get('/business-profile/:businessId', (req: Request, res: Response) => {
  try {
    const profile = getOrCreateBusinessProfile(String(req.params.businessId));
    if (!profile) return res.status(404).json({ error: 'Business not found.' });
    return res.json({ profile });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.patch('/business-profile/:businessId', (req: Request, res: Response) => {
  try {
    const profile = updateBusinessProfile(String(req.params.businessId), req.body as BusinessProfileUpdate);
    if (!profile) return res.status(404).json({ error: 'Business not found.' });
    return res.json({ profile });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Action Registry ──────────────────────────────────────────────────────────

router.get('/action-registry', (_req: Request, res: Response) => {
  return res.json({ entries: listActionRegistryEntries() });
});

router.get('/action-registry/:actionType', (req: Request, res: Response) => {
  const entry = getActionRegistryEntry(String(req.params.actionType));
  if (!entry) return res.status(404).json({ error: `action_type '${req.params.actionType}' is not registered.` });
  return res.json({ entry });
});

router.put('/action-registry/:actionType', (req: Request, res: Response) => {
  try {
    const entry = upsertActionRegistryEntry(String(req.params.actionType), req.body as ActionRegistryUpsert);
    return res.json({ entry });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Connector Confidence ─────────────────────────────────────────────────────

router.get('/connector-confidence/:businessId', (req: Request, res: Response) => {
  return res.json({ connector_confidence: listConnectorConfidence(String(req.params.businessId)) });
});

router.get('/connector-confidence/connector/:connectorId', (req: Request, res: Response) => {
  const confidence = getConnectorConfidence(String(req.params.connectorId));
  if (!confidence) return res.status(404).json({ error: 'No confidence score computed yet for this connector.' });
  return res.json({ confidence });
});

// ─── World Model ──────────────────────────────────────────────────────────────

router.get('/world-model/:businessId', (req: Request, res: Response) => {
  const current = getCurrentWorldModel(String(req.params.businessId));
  if (!current) return res.status(404).json({ error: 'No World Model snapshot yet for this business.' });
  return res.json({ world_model: current });
});

router.get('/world-model/:businessId/history', (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  return res.json({ snapshots: getWorldModelHistory(String(req.params.businessId), limit) });
});

// ─── System Issues ────────────────────────────────────────────────────────────

router.get('/system-issues/:businessId', (req: Request, res: Response) => {
  const status = req.query.status ? String(req.query.status) as SystemIssueStatus : undefined;
  const issue_type = req.query.issue_type ? String(req.query.issue_type) : undefined;
  return res.json({ issues: listSystemIssues({ business_id: String(req.params.businessId), status, issue_type }) });
});

router.patch('/system-issues/issue/:issueId', (req: Request, res: Response) => {
  const existing = getSystemIssue(String(req.params.issueId));
  if (!existing) return res.status(404).json({ error: 'System issue not found.' });
  const status = (req.body as { status?: string })?.status as SystemIssueStatus | undefined;
  const validStatuses: SystemIssueStatus[] = ['open', 'acknowledged', 'resolved', 'dismissed'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${validStatuses.join(', ')}.` });
  }
  return res.json({ issue: updateSystemIssueStatus(String(req.params.issueId), status) });
});

export default router;
