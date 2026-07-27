import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { encrypt, decrypt } from '../crypto.js';
import type { Connector } from '../types/db.js';
import { refreshConnectorConfidence } from '../connectors/confidence.js';
import { writeWorldModelSnapshot, getPreviousConnectorData } from '../world-model/world-model.js';

const router = Router();
router.use(isAuthenticated);

// Lazy-load connectors to avoid circular dependencies
async function getConnector(type: string): Promise<any> {
  try {
    const mod = await import(`../connectors/${type}/index.js`);
    return (mod as any).default;
  } catch {
    return null;
  }
}

/**
 * Run a sync against a connector row. Identical logic to POST /:id/sync but
 * callable from anywhere (e.g. immediately after creating a connector).
 * Fire-and-forget — never throws on the caller side.
 */
async function runConnectorSync(rowId: string): Promise<void> {
  const row = db.prepare('SELECT * FROM connectors WHERE id = ?').get(rowId) as Connector | undefined;
  if (!row) return;

  let connector: any;
  try {
    connector = await getConnector(row.type);
  } catch (err) {
    console.error(`[connectors] Cannot load connector type '${row.type}':`, (err as Error).message);
    return;
  }
  if (!connector) {
    console.error(`[connectors] Connector type '${row.type}' not supported.`);
    return;
  }

  const parsed = parseRow(row);
  const config: Record<string, unknown> = row.config ? JSON.parse(row.config as unknown as string) : {};
  // Operator precedence: || binds tighter than ?:, so the original
  //   config.defaultDataType || row.type === 'pagespeed' ? 'performance' : ...
  // collapsed to "performance" whenever defaultDataType was set. Wrap the
  // fallback ternary in parens so the user's stored value wins.
  const dataType: string = (config.defaultDataType as string | undefined) || (
    row.type === 'pagespeed' ? 'performance' :
    row.type === 'gsc' ? 'search_analytics' :
    row.type === 'ga4' ? 'report' :
    'report'
  );
  // If the connector itself has no URL configured (e.g. PageSpeed created
  // by the OAuth callback before the user saved a URL), fall back to the
  // business's website so syncs don't blow up on first run.
  if (!config.url) {
    try {
      const biz = db.prepare('SELECT settings FROM businesses WHERE id = ?').get(row.business_id) as { settings: string } | undefined;
      const bizSettings: Record<string, unknown> = biz?.settings ? JSON.parse(biz.settings) : {};
      if (bizSettings.website) config.url = bizSettings.website;
    } catch {}
  }
  const params: Record<string, unknown> = { ...config, businessId: row.business_id };

  try {
    const data = await connector.fetch(dataType, parsed?.credentials, params);
    const now = new Date().toISOString();

    if (typeof connector.extractMetrics === 'function') {
      const metrics: Array<{ name: string; value?: number | null; data?: unknown }> = connector.extractMetrics(data, now);
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
          now, now,
        );
      }
    }

    db.prepare(`
      INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_data, period_start, period_end, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(crypto.randomUUID(), row.business_id, row.id, `${row.type}_sync`, JSON.stringify(data), now, now);

    db.prepare(`UPDATE connectors SET status = 'connected', last_sync = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?`).run(row.id);
    console.log(`[connectors] Sync complete for ${row.name}`);

    try {
      db.prepare(
        `INSERT INTO connector_syncs (id, connector_id, status, created_at)
         VALUES (lower(hex(randomblob(16))), ?, 'complete', CURRENT_TIMESTAMP)`
      ).run(row.id);
    } catch {}

    try {
      const { onConnectorSyncSuccess } = await import('../connectors/post-sync.js') as unknown as {
        onConnectorSyncSuccess: (type: string, businessId: string) => void;
      };
      onConnectorSyncSuccess(row.type, row.business_id);
    } catch (err) {
      console.warn('[connectors] post-sync hook failed:', (err as Error).message);
    }

    try {
      const { runSignalEngine } = await import('../signals/signal-engine.js') as unknown as {
        runSignalEngine: (businessId: string, connectorId: string, data: unknown, prevData: unknown, type: string) => Promise<void>;
      };
      // "Connectors update the World Model, signals are generated from the
      // World Model" — previousData comes from the World Model's own
      // record of this connector's last-known data, not an ad-hoc second
      // query against the metrics table (see scheduler.ts's identical
      // change and world-model.ts's getPreviousConnectorData).
      const previousData = getPreviousConnectorData(row.business_id, row.id);
      const signalData = (row.type === 'pagespeed' && (data as any).mobile) ? (data as any).mobile : data;
      const prevSignalData = (row.type === 'pagespeed' && (previousData as any)?.mobile) ? (previousData as any).mobile : previousData;
      await runSignalEngine(row.business_id, row.id, signalData, prevSignalData, row.type);
    } catch (sigErr) {
      console.error(`[connectors] Signal engine error for ${row.name}:`, (sigErr as Error).message);
    }

    // World Model: connectors feed the World Model, not agents directly.
    try { refreshConnectorConfidence({ ...row, status: 'connected', last_sync: new Date().toISOString(), last_error: null }); } catch {}
    writeWorldModelSnapshot(row.business_id, 'connector_sync');
  } catch (err) {
    db.prepare(`UPDATE connectors SET status = 'error', last_error = ? WHERE id = ?`).run((err as Error).message.substring(0, 500), row.id);
    console.error(`[connectors] Sync error for ${row.name}:`, (err as Error).message);
  }
}

function parseRow(row: Connector | null): (Omit<Connector, 'credentials' | 'config'> & { credentials: Record<string, unknown>; config: Record<string, unknown> }) | null {
  if (!row) return null;
  let credentials: Record<string, unknown> = {};
  if (row.credentials) {
    try {
      const decrypted = decrypt(row.credentials as unknown as string);
      credentials = JSON.parse(decrypted);
    } catch {
      credentials = {};
    }
  }
  return {
    ...row,
    credentials,
    config: row.config ? JSON.parse(row.config as unknown as string) : {},
  };
}

function safeRow(row: Connector | null): (Omit<Connector, 'credentials' | 'config'> & { credentials: Record<string, string | null>; config: Record<string, unknown> }) | null {
  const parsed = parseRow(row);
  if (!parsed) return null;
  // Strip sensitive credential fields from API responses
  const { credentials, ...safe } = parsed;
  const safeCredentials: Record<string, string | null> = {};
  for (const key of Object.keys(credentials as Record<string, unknown>)) {
    // Redact values but show which keys are set
    safeCredentials[key] = (credentials as Record<string, unknown>)[key] ? '***' : null;
  }
  return { ...safe, credentials: safeCredentials };
}

/**
 * GET /api/connectors/:businessId
 */
router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM connectors WHERE business_id = ? ORDER BY name ASC
    `).all(req.params['businessId'] as string) as Connector[];
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
router.post('/', async (req: Request, res: Response) => {
  try {
    const { business_id, type, name, credentials = {}, config = {} } = req.body as {
      business_id?: string;
      type?: string;
      name?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
    };

    if (!business_id) return res.status(400).json({ error: 'business_id is required.' });
    if (!type) return res.status(400).json({ error: 'type is required.' });
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const encryptedCreds = encrypt(JSON.stringify(credentials));
    const id = generateId();

    db.prepare(`
      INSERT INTO connectors (id, business_id, type, name, credentials, status, config, created_at)
      VALUES (?, ?, ?, ?, ?, 'disconnected', ?, CURRENT_TIMESTAMP)
    `).run(id, business_id, type, name, encryptedCreds, JSON.stringify(config));

    const created = safeRow(db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Connector | null);
    audit(business_id, 'connector', id, 'create', (req.session as any).userId, null, created);

    // Auto-sync — fire-and-forget so the user doesn't have to click sync
    // after adding. Failures land in connectors.last_error and surface in
    // the UI; they don't block the create response.
    runConnectorSync(id).catch((err) => console.warn('[connectors] auto-sync after create failed:', (err as Error).message));

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
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Connector | undefined;
    if (!existing) return res.status(404).json({ error: 'Connector not found.' });

    const before = safeRow(existing);
    const { name, credentials, config, status } = req.body as {
      name?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
      status?: string;
    };

    const updates: string[] = [];
    const values: (string | number | boolean | null)[] = [];

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

    values.push(id);
    db.prepare(`UPDATE connectors SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const after = safeRow(db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Connector | null);
    audit(existing.business_id, 'connector', id, 'update', (req.session as any).userId, before, after);

    // If credentials or config changed, re-sync immediately so the user
    // sees results without having to click sync. Skip if only `name` or
    // `status` (e.g. pause) was edited.
    if (credentials !== undefined || config !== undefined) {
      runConnectorSync(id).catch((err) => console.warn('[connectors] auto-sync after update failed:', (err as Error).message));
    }

    return res.json(after);
  } catch (err) {
    console.error('[connectors] Update error:', err);
    return res.status(500).json({ error: 'Failed to update connector.' });
  }
});

/**
 * DELETE /api/connectors/:id
 */
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Connector | undefined;
    if (!existing) return res.status(404).json({ error: 'Connector not found.' });

    db.transaction(() => {
      db.prepare('DELETE FROM connector_syncs WHERE connector_id = ?').run(id);
      db.prepare('DELETE FROM metrics WHERE connector_id = ?').run(id);
      db.prepare('DELETE FROM signals WHERE connector_id = ?').run(id);
      db.prepare('DELETE FROM connectors WHERE id = ?').run(id);
    })();
    audit(existing.business_id, 'connector', id, 'delete', (req.session as any).userId, safeRow(existing), null);

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
router.post('/pagespeed/test', async (req: Request, res: Response) => {
  const { url, apiKey } = req.body as { url?: string; apiKey?: string };
  if (!url) return res.status(400).json({ error: 'url is required.' });

  try {
    const connector = await getConnector('pagespeed');
    if (!connector) return res.status(422).json({ error: 'PageSpeed connector not available.' });

    const data = await connector.fetch('performance', { apiKey: apiKey || null }, { url });
    return res.json({ ok: true, data });
  } catch (err) {
    console.error('[connectors] PageSpeed test error:', (err as Error).message);
    return res.status(422).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * GET /api/connectors/gsc/sites?businessId=...
 * Returns the list of GSC properties (sites + domain properties) the
 * authorised user has verified, sourced from their existing OAuth token
 * on any GSC/GA4/GBP connector. Used by the Configure UI to show a
 * dropdown of valid choices instead of letting the user type the wrong
 * variant of their URL.
 */
router.get('/gsc/sites', async (req: Request, res: Response) => {
  try {
    const businessId = String(req.query['businessId'] ?? '');
    if (!businessId) return res.status(400).json({ error: 'businessId is required.' });

    // Find any existing GSC connector for this business — it has the
    // OAuth refresh token we can borrow. (Falls back to GA4/GBP via
    // getValidGoogleAccessToken which scans all of them.)
    const { getValidGoogleAccessToken } = await import('../connectors/google-auth.js') as unknown as {
      getValidGoogleAccessToken: (businessId: string) => Promise<{ accessToken?: string } | null>;
    };
    const tok = await getValidGoogleAccessToken(businessId);
    if (!tok?.accessToken) {
      return res.status(409).json({ error: 'No connected Google account found for this business. Connect Google first.' });
    }

    const connector = await getConnector('gsc');
    if (!connector) return res.status(422).json({ error: 'GSC connector not available.' });

    const data = await connector.fetch('sites', { accessToken: tok.accessToken }, {});
    return res.json(data);
  } catch (err) {
    console.error('[connectors] GSC sites list error:', (err as Error).message);
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/connectors/:id/sync
 * Trigger a manual sync
 */
router.post('/:id/sync', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const row = db.prepare('SELECT id, name FROM connectors WHERE id = ?').get(id) as Pick<Connector, 'id' | 'name'> | undefined;
    if (!row) return res.status(404).json({ error: 'Connector not found.' });

    res.status(202).json({ ok: true, message: 'Sync started.' });

    // Fire-and-forget. runConnectorSync owns every step (metric writes,
    // connector_syncs row, post-sync hooks, signal engine, businessId
    // fallback) so the explicit sync route stays in lockstep with the
    // auto-sync path triggered by add/edit.
    runConnectorSync(row.id).catch((err: Error) =>
      console.warn(`[connectors] explicit sync failed for ${row.name}:`, err.message));
  } catch (err) {
    console.error('[connectors] Sync trigger error:', err);
    return res.status(500).json({ error: 'Failed to trigger sync.' });
  }
});

/**
 * GET /api/connectors/:id/health
 */
router.get('/:id/health', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const row = db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Connector | undefined;
    if (!row) return res.status(404).json({ error: 'Connector not found.' });

    const connector = await getConnector(row.type);
    if (!connector) {
      return res.status(422).json({ error: `Connector type '${row.type}' not supported.` });
    }

    const parsed = parseRow(row)!;
    const result: { ok: boolean; error?: string } = await connector.healthCheck(parsed.credentials);

    const status = result.ok ? 'connected' : 'error';
    db.prepare('UPDATE connectors SET status = ?, last_error = ? WHERE id = ?').run(
      status,
      result.ok ? null : (result.error ?? 'Health check failed'),
      row.id
    );

    return res.json({ ok: result.ok, details: result });
  } catch (err) {
    console.error('[connectors] Health check error:', err);
    db.prepare('UPDATE connectors SET status = ?, last_error = ? WHERE id = ?').run('error', (err as Error).message, req.params['id'] as string);
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * GET /api/connectors/:id/file-changes
 * Lists all approved-and-executed file writes for a server-access connector,
 * joined to their task titles so the Changes tab can show what each write was
 * for. Each row includes the backup id so a rollback task can reference it.
 */
router.get('/:id/file-changes', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const row = db.prepare('SELECT id, type FROM connectors WHERE id = ?').get(id) as Pick<Connector, 'id' | 'type'> | undefined;
    if (!row) return res.status(404).json({ error: 'Connector not found.' });
    if (row.type !== 'server-access') {
      return res.json([]);
    }
    const rows = db.prepare(`
      SELECT fb.id, fb.remote_path, fb.task_id, fb.backed_up_at, fb.content_hash,
             t.title as task_title, t.status as task_status
      FROM file_backups fb
      LEFT JOIN tasks t ON t.id = fb.task_id
      WHERE fb.connector_id = ?
      ORDER BY fb.backed_up_at DESC
      LIMIT 100
    `).all(id);
    return res.json(rows);
  } catch (err) {
    console.error('[connectors] file-changes error:', err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
