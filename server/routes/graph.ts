/**
 * Knowledge Graph API (Phase 3, session-authenticated).
 *
 * Read-only mirror of server/routes/bap-graph.ts for the dashboard —
 * traversal, not keyword search, over server/brain/knowledge-graph.ts's
 * typed entity/edge graph. See that file's docstring for what's
 * automatically derived vs. manually-registered.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import { traverseGraph, deriveEdgesForBusiness } from '../brain/knowledge-graph.js';

const router = Router();
router.use(isAuthenticated);

const VALID_REF_TABLES = new Set(['goals', 'tasks', 'signals', 'decisions', 'kg_entities']);

router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { ref_table, ref_id, depth, edge_types } = req.query;
    if (!ref_table || !ref_id) {
      return res.status(400).json({ error: 'ref_table and ref_id are required (e.g. ref_table=goals&ref_id=<goal_id>).' });
    }
    if (!VALID_REF_TABLES.has(String(ref_table))) {
      return res.status(400).json({ error: `ref_table must be one of: ${Array.from(VALID_REF_TABLES).join(', ')}.` });
    }
    const graph = traverseGraph(businessId, { ref_table: String(ref_table), ref_id: String(ref_id) }, {
      depth: depth ? parseInt(String(depth), 10) : undefined,
      edgeTypes: edge_types ? String(edge_types).split(',') : undefined,
    });
    res.json({ ...graph, total_nodes: graph.nodes.length, total_edges: graph.edges.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:businessId/rebuild', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const result = deriveEdgesForBusiness(businessId);
    res.json({ business_id: businessId, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
