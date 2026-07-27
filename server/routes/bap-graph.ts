/**
 * Blueprint Agent Protocol (BAP) — Knowledge Graph (Phase 3).
 *
 * Traversal, not keyword search: given a starting entity (a goal, task,
 * signal, decision, or outcome — anything with a real backing table),
 * walk the typed edges (caused/supports/blocks/depends_on/relates_to/
 * mentions/supersedes/contradicts/improves/regresses) out to a bounded
 * depth. See server/brain/knowledge-graph.ts's docstring for what's
 * automatically derived vs. manually-registered (competitor/product/
 * customer/campaign/person nodes have no automatic extraction pipeline).
 *
 * No auth/rate-limit middleware here — mounted as a sub-router inside
 * bap.ts's already-authenticated chain (see bap-goals.ts's docstring).
 *
 * Endpoints:
 *   GET    /businesses/:bid/graph          — traverse from a starting entity
 *   POST   /businesses/:bid/graph/rebuild  — recompute derived edges now
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { requirePermission } from '../bap/auth.js';
import { withRequiredIdempotency, sendError } from '../bap/route-helpers.js';
import { traverseGraph, deriveEdgesForBusiness } from '../brain/knowledge-graph.js';

const router = Router();

// ref_table values a caller can address a starting entity by — the same
// tables Phase 3's derivation actually populates (see knowledge-graph.ts).
const VALID_REF_TABLES = new Set(['goals', 'tasks', 'signals', 'decisions', 'kg_entities']);

router.get('/businesses/:businessId/graph', requirePermission('graph:read'), (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!biz) return sendError(req, res, 404, 'not_found', 'Business not found.');

    const { ref_table, ref_id, depth, edge_types } = req.query;
    if (!ref_table || !ref_id) {
      return sendError(req, res, 400, 'validation_error', 'ref_table and ref_id are required (e.g. ref_table=goals&ref_id=<goal_id>).');
    }
    if (!VALID_REF_TABLES.has(String(ref_table))) {
      return sendError(req, res, 400, 'validation_error', `ref_table must be one of: ${Array.from(VALID_REF_TABLES).join(', ')}.`);
    }

    const graph = traverseGraph(businessId, { ref_table: String(ref_table), ref_id: String(ref_id) }, {
      depth: depth ? parseInt(String(depth), 10) : undefined,
      edgeTypes: edge_types ? String(edge_types).split(',') : undefined,
    });

    return res.json({ ...graph, total_nodes: graph.nodes.length, total_edges: graph.edges.length });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

router.post('/businesses/:businessId/graph/rebuild', requirePermission('graph:trigger'), async (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(businessId);
    if (!biz) return sendError(req, res, 404, 'not_found', 'Business not found.');

    await withRequiredIdempotency(req, res, 'graph:rebuild', async () => {
      const result = deriveEdgesForBusiness(businessId);
      return { status: 200, body: { business_id: businessId, ...result } };
    });
  } catch (err) {
    return sendError(req, res, 500, 'internal_error', (err as Error).message);
  }
});

export default router;
