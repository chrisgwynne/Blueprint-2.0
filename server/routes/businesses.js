import { Router } from 'express';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { runConductor } from '../agents/conductor.js';

const router = Router();
router.use(isAuthenticated);

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    settings: row.settings ? JSON.parse(row.settings) : {},
  };
}

/**
 * GET /api/businesses
 */
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM businesses ORDER BY name ASC').all();
    return res.json(rows.map(parseRow));
  } catch (err) {
    console.error('[businesses] List error:', err);
    return res.status(500).json({ error: 'Failed to list businesses.' });
  }
});

/**
 * GET /api/businesses/:id
 */
router.get('/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
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
router.post('/', async (req, res) => {
  try {
    const { name, type, description, settings } = req.body;
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

    const created = parseRow(db.prepare('SELECT * FROM businesses WHERE id = ?').get(id));
    audit(id, 'business', id, 'create', req.session.userId, null, created);

    // Auto-initialize KB (non-fatal if it fails)
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js');
      await getKBForBusiness(id);
      console.log(`[businesses] KB initialized for new business ${slug}`);
    } catch (kbErr) {
      console.warn(`[businesses] KB auto-init failed for ${slug} (non-fatal):`, kbErr.message);
    }

    // Run Conductor immediately for the new business (fire-and-forget).
    // This ensures agents are visible and hiring analysis runs without waiting
    // for the next hourly cron tick.
    runConductor(id).catch(err =>
      console.warn(`[businesses] Initial conductor run failed for ${slug} (non-fatal):`, err.message)
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
router.patch('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Business not found.' });

    const before = parseRow(existing);
    const { name, type, description, settings } = req.body;

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (type !== undefined) { updates.push('type = ?'); values.push(type); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (settings !== undefined) { updates.push('settings = ?'); values.push(JSON.stringify(settings)); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided.' });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(req.params.id);

    db.prepare(`UPDATE businesses SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const after = parseRow(db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id));
    audit(req.params.id, 'business', req.params.id, 'update', req.session.userId, before, after);

    return res.json(after);
  } catch (err) {
    console.error('[businesses] Update error:', err);
    return res.status(500).json({ error: 'Failed to update business.' });
  }
});

/**
 * DELETE /api/businesses/:id
 */
router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Business not found.' });

    const before = parseRow(existing);

    // Hard delete
    db.prepare('DELETE FROM businesses WHERE id = ?').run(req.params.id);
    audit(req.params.id, 'business', req.params.id, 'delete', req.session.userId, before, null);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[businesses] Delete error:', err);
    return res.status(500).json({ error: 'Failed to delete business.' });
  }
});

export default router;
