import { Router } from 'express';
import crypto from 'crypto';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { encrypt, decrypt } from '../crypto.js';

const router = Router();
router.use(isAuthenticated);

// Lazy-load connectors to avoid circular dependencies
async function getConnector(type) {
  try {
    const mod = await import(`../connectors/${type}/index.js`);
    return mod.default;
  } catch {
    return null;
  }
}

function parseRow(row) {
  if (!row) return null;
  let credentials = {};
  if (row.credentials) {
    try {
      const decrypted = decrypt(row.credentials);
      credentials = JSON.parse(decrypted);
    } catch {
      credentials = {};
    }
  }
  return {
    ...row,
    credentials,
    config: row.config ? JSON.parse(row.config) : {},
  };
}

function safeRow(row) {
  const parsed = parseRow(row);
  if (!parsed) return null;
  // Strip sensitive credential fields from API responses
  const { credentials, ...safe } = parsed;
  const safeCredentials = {};
  for (const key of Object.keys(credentials)) {
    // Redact values but show which keys are set
    safeCredentials[key] = credentials[key] ? '***' : null;
  }
  return { ...safe, credentials: safeCredentials };
}

/**
 * GET /api/connectors/:businessId
 */
router.get('/:businessId', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM connectors WHERE business_id = ? ORDER BY name ASC
    `).all(req.params.businessId);
    return res.json(rows.map(safeRow));
  } catch (err) {
    console.error('[connectors] List error:', err);
    return res.status(500).json({ error: 'Failed to list connectors.' });
  }
});

/**
 * POST /api/connectors
 * Body: { business_id, type, name, credentials, config }
 */
router.post('/', async (req, res) => {
  try {
    const { business_id, type, name, credentials = {}, config = {} } = req.body;

    if (!business_id) return res.status(400).json({ error: 'business_id is required.' });
    if (!type) return res.status(400).json({ error: 'type is required.' });
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const encryptedCreds = encrypt(JSON.stringify(credentials));
    const id = generateId();

    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
      VALUES (?, ?, ?, ?, ?, 'disconnected', ?, CURRENT_TIMESTAMP)
    `).run(id, business_id, type, name, encryptedCreds, JSON.stringify(config));

    const created = safeRow(db.prepare('SELECT * FROM connectors WHERE id = ?').get(id));
    audit(business_id, 'connector', id, 'create', req.session.userId, null, created);

    return res.status(201).json(created);
  } catch (err) {
    console.error('[connectors] Create error:', err);
    return res.status(500).json({ error: 'Failed to create connector.' });
  }
});

/**
 * PATCH /api/connectors/:id
 * Update connector config or credentials
 */
router.patch('/:id', async (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM connectors WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Connector not found.' });

    const before = safeRow(existing);
    const { name, credentials, config, status } = req.body;

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    if (credentials !== undefined) {
      updates.push('credentials = ?');
      values.push(encrypt(JSON.stringify(credentials)));
    }
    if (config !== undefined) {
      updates.push('config = ?');
      values.push(JSON.stringify(config));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields provided.' });

    values.push(req.params.id);
    db.prepare(`UPDATE connectors SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const after = safeRow(db.prepare('SELECT * FROM connectors WHERE id = ?').get(req.params.id));
    audit(existing.business_id, 'connector', req.params.id, 'update', req.session.userId, before, after);

    return res.json(after);
  } catch (err) {
    console.error('[connectors] Update error:', err);
    return res.status(500).json({ error: 'Failed to update connector.' });
  }
});

/**
 * DELETE /api/connectors/:id
 */
router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM connectors WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Connector not found.' });

    db.prepare('DELETE FROM connectors WHERE id = ?').run(req.params.id);
    audit(existing.business_id, 'connector', req.params.id, 'delete', req.session.userId, safeRow(existing), null);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[connectors] Delete error:', err);
    return res.status(500).json({ error: 'Failed to delete connector.' });
  }
});

/**
 * POST /api/connectors/pagespeed/test
 * Live test for PageSpeed — runs a real fetch and returns scores immediately.
 * Body: { url, apiKey? }
 */
router.post('/pagespeed/test', async (req, res) => {
  const { url, apiKey } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required.' });

  try {
    const connector = await getConnector('pagespeed');
    if (!connector) return res.status(422).json({ error: 'PageSpeed connector not available.' });

    const data = await connector.fetch('performance', { apiKey: apiKey || null }, { url });
    return res.json({ ok: true, data });
  } catch (err) {
    console.error('[connectors] PageSpeed test error:', err.message);
    return res.status(422).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/connectors/:id/sync
 * Trigger a manual sync
 */
router.post('/:id/sync', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM connectors WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found.' });

    const connector = await getConnector(row.type);
    if (!connector) {
      return res.status(422).json({ error: `Connector type '${row.type}' not supported.` });
    }

    const parsed = parseRow(row);
    const config = row.config ? JSON.parse(row.config) : {};
    const dataType = config.defaultDataType || row.type === 'pagespeed' ? 'performance' : (row.type === 'gsc' ? 'search_analytics' : 'report');
    const params = { ...config };

    res.status(202).json({ ok: true, message: 'Sync started.' });

    // Fire-and-forget sync with individual metric storage
    (async () => {
      try {
        const data = await connector.fetch(dataType, parsed.credentials, params);
        const now = new Date().toISOString();

        // Write individual named metric rows if connector supports it
        if (typeof connector.extractMetrics === 'function') {
          const metrics = connector.extractMetrics(data, now);
          for (const m of metrics) {
            db.prepare(`
              INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, metric_data, period_start, period_end, recorded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(
              crypto.randomUUID(),
              row.business_id,
              row.id,
              m.name,
              m.value ?? null,
              m.data ? JSON.stringify(m.data) : null,
              now,
              now,
            );
          }
        }

        // Always write a blob summary row for the signal engine + history
        db.prepare(`
          INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_data, period_start, period_end, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          crypto.randomUUID(),
          row.business_id,
          row.id,
          `${row.type}_sync`,
          JSON.stringify(data),
          now,
          now,
        );

        db.prepare(`UPDATE connectors SET status = 'connected', last_sync = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?`).run(row.id);
        console.log(`[connectors] Sync complete for ${row.name}`);

        // Record this sync so readiness checks can see it
        try {
          db.prepare(
            `INSERT INTO connector_syncs (id, connector_id, status, created_at)
             VALUES (lower(hex(randomblob(16))), ?, 'complete', CURRENT_TIMESTAMP)`
          ).run(row.id);
        } catch {}

        // Post-sync orchestration: promote pending agents, hiring analysis,
        // queue data-ready agent runs. Fire-and-forget — sync is done.
        try {
          const { onConnectorSyncSuccess } = await import('../connectors/post-sync.js');
          onConnectorSyncSuccess(row.type, row.business_id);
        } catch (err) {
          console.warn('[connectors] post-sync hook failed:', err.message);
        }

        // Run signal engine
        try {
          const { runSignalEngine } = await import('../signals/signal-engine.js');
          const prevMetric = db.prepare(`
            SELECT metric_data FROM metrics
            WHERE business_id = ? AND connector_id = ? AND metric_name = ?
            ORDER BY recorded_at DESC LIMIT 1 OFFSET 1
          `).get(row.business_id, row.id, `${row.type}_sync`);

          let previousData = null;
          if (prevMetric?.metric_data) {
            try { previousData = JSON.parse(prevMetric.metric_data); } catch {}
          }

          // For pagespeed, pass mobile data directly to match signal rule expectations
          const signalData = (row.type === 'pagespeed' && data.mobile) ? data.mobile : data;
          const prevSignalData = (row.type === 'pagespeed' && previousData?.mobile) ? previousData.mobile : previousData;

          await runSignalEngine(row.business_id, row.id, signalData, prevSignalData, row.type);
        } catch (sigErr) {
          console.error(`[connectors] Signal engine error for ${row.name}:`, sigErr.message);
        }
      } catch (err) {
        db.prepare(`UPDATE connectors SET status = 'error', last_error = ? WHERE id = ?`).run(err.message.substring(0, 500), row.id);
        console.error(`[connectors] Sync error for ${row.name}:`, err.message);
      }
    })();
  } catch (err) {
    console.error('[connectors] Sync trigger error:', err);
    return res.status(500).json({ error: 'Failed to trigger sync.' });
  }
});

/**
 * GET /api/connectors/:id/health
 */
router.get('/:id/health', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM connectors WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Connector not found.' });

    const connector = await getConnector(row.type);
    if (!connector) {
      return res.status(422).json({ error: `Connector type '${row.type}' not supported.` });
    }

    const parsed = parseRow(row);
    const result = await connector.healthCheck(parsed.credentials);

    const status = result.ok ? 'connected' : 'error';
    db.prepare('UPDATE connectors SET status = ?, last_error = ? WHERE id = ?').run(
      status,
      result.ok ? null : (result.error ?? 'Health check failed'),
      row.id
    );

    return res.json({ ok: result.ok, details: result });
  } catch (err) {
    console.error('[connectors] Health check error:', err);
    db.prepare('UPDATE connectors SET status = ?, last_error = ? WHERE id = ?').run('error', err.message, req.params.id);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
