import { Router } from 'express';
import type { Request, Response } from 'express';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { runConductor } from '../agents/conductor.js';

const router = Router();
router.use(isAuthenticated);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    ...row,
    settings: row['settings'] ? JSON.parse(row['settings'] as string) : {},
  };
}

/**
 * GET /api/businesses
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const rows = db.prepare('SELECT * FROM businesses ORDER BY name ASC').all() as Record<string, unknown>[];
    return res.json(rows.map(parseRow));
  } catch (err) {
    console.error('[businesses] List error:', err);
    return res.status(500).json({ error: 'Failed to list businesses.' });
  }
});

/**
 * GET /api/businesses/:id
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const row = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params['id'] as string) as Record<string, unknown> | null;
    if (!row) return res.status(404).json({ error: 'Business not found.' });
    return res.json(parseRow(row));
  } catch (err) {
    console.error('[businesses] Get error:', err);
    return res.status(500).json({ error: 'Failed to get business.' });
  }
});

/**
 * POST /api/businesses
 *
 * Also auto-initializes a Karpathy-style KB for the new business in native mode
 * (KB lives at {KB_ROOT}/{slug}/). Failure to init the KB does not block the
 * business creation — it can be retried later via /api/kb/:businessId/init.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, type, description, settings } = req.body as {
      name?: string;
      type?: string;
      description?: string;
      settings?: unknown;
    };
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const id = generateId();
    let slug = slugify(name);

    // Ensure slug uniqueness
    let slugCandidate = slug;
    let attempt = 0;
    while (db.prepare('SELECT id FROM businesses WHERE slug = ?').get(slugCandidate)) {
      attempt++;
      slugCandidate = `${slug}-${attempt}`;
    }
    slug = slugCandidate;

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO businesses (id, name, slug, type, description, settings, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      slug,
      type ?? null,
      description ?? null,
      JSON.stringify(settings ?? {}),
      now,
      now
    );

    const created = parseRow(db.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as Record<string, unknown> | null);
    audit(id, 'business', id, 'create', (req.session as any).userId, null, created);

    // Auto-initialize KB (non-fatal if it fails)
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
        getKBForBusiness: (id: string) => Promise<unknown>;
      };
      await getKBForBusiness(id);
      console.log(`[businesses] KB initialized for new business ${slug}`);
    } catch (kbErr) {
      console.warn(`[businesses] KB auto-init failed for ${slug} (non-fatal):`, (kbErr as Error).message);
    }

    // Run Conductor immediately for the new business (fire-and-forget).
    // This ensures agents are visible and hiring analysis runs without waiting
    // for the next hourly cron tick.
    runConductor(id).catch(err =>
      console.warn(`[businesses] Initial conductor run failed for ${slug} (non-fatal):`, (err as Error).message)
    );

    return res.status(201).json(created);
  } catch (err) {
    console.error('[businesses] Create error:', err);
    return res.status(500).json({ error: 'Failed to create business.' });
  }
});

/**
 * PATCH /api/businesses/:id
 */
router.patch('/:id', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as Record<string, unknown> | null;
    if (!existing) return res.status(404).json({ error: 'Business not found.' });

    const before = parseRow(existing);
    const { name, type, description, settings } = req.body as {
      name?: string;
      type?: string;
      description?: string;
      settings?: unknown;
    };

    const updates: string[] = [];
    const values: any[] = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (type !== undefined) { updates.push('type = ?'); values.push(type); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (settings !== undefined) { updates.push('settings = ?'); values.push(JSON.stringify(settings)); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided.' });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE businesses SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const after = parseRow(db.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as Record<string, unknown> | null);
    audit(id, 'business', id, 'update', (req.session as any).userId, before, after);

    return res.json(after);
  } catch (err) {
    console.error('[businesses] Update error:', err);
    return res.status(500).json({ error: 'Failed to update business.' });
  }
});

/**
 * DELETE /api/businesses/:id
 */
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as Record<string, unknown> | null;
    if (!existing) return res.status(404).json({ error: 'Business not found.' });

    const before = parseRow(existing);

    // Cascade delete all child rows in dependency order so FK constraints are satisfied.
    // Tables with FK chains (e.g. task_events → tasks) must be cleared leaf-first.
    db.transaction(() => {
      // Leaf tables that reference tasks/signals/connectors
      db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(id);
      db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(id);
      db.prepare(`DELETE FROM chat_reactions WHERE message_id IN (SELECT id FROM chat_messages WHERE business_id = ?)`).run(id);
      db.prepare(`DELETE FROM connector_syncs WHERE connector_id IN (SELECT id FROM connectors WHERE business_id = ?)`).run(id);

      // Tables that directly reference businesses (or have business_id without constraint)
      const directTables = [
        'agent_runs', 'analysis_runs', 'signals', 'tasks', 'missions',
        'metrics', 'signal_clusters', 'chat_messages', 'chat_conversations',
        'notifications', 'kb_docs', 'scenarios', 'conflicts', 'retrospectives',
        'goal_suggestions', 'goal_checks', 'goals', 'projects',
        'workflows', 'workflow_runs', 'workflow_step_runs',
        'action_memory', 'seasonal_patterns', 'investigations',
        'file_backups', 'server_file_cache', 'baselines', 'roi_snapshots',
        'counterfactual_estimates', 'attribution_records', 'connector_gaps',
        'intelligence_events', 'job_queue',
      ];
      for (const table of directTables) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE business_id = ?`).run(id);
        } catch {
          // Table may not exist in this DB version — skip safely
        }
      }

      // Delete connectors last (signals/metrics reference them)
      db.prepare('DELETE FROM connectors WHERE business_id = ?').run(id);

      // Finally the business itself
      db.prepare('DELETE FROM businesses WHERE id = ?').run(id);
    })();

    audit(id, 'business', id, 'delete', (req.session as any).userId, before, null);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[businesses] Delete error:', err);
    return res.status(500).json({ error: 'Failed to delete business.' });
  }
});

export default router;
