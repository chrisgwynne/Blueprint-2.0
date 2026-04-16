/**
 * Security routes — status + allowlist management for the Settings UI.
 *
 * See server/lib/{content-sanitiser,outbound-allowlist,safe-fetch,security-monitor}.js
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  DEFAULT_ALLOWED_HOSTS,
  BLOCKED_HOSTS,
  getAllowedDomains,
  addToAllowlist,
  removeFromAllowlist,
  isEnforcementEnabled,
  setEnforcementEnabled,
} from '../lib/outbound-allowlist.js';

const router = Router();
router.use(isAuthenticated);

function readBoolSetting(key: string, fallback: boolean): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
    if (!row) return fallback;
    return JSON.parse(row.value) !== false;
  } catch { return fallback; }
}

function writeBoolSetting(key: string, value: boolean): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(!!value));
}

// ─── GET /api/security/status ─────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  try {
    const allowed = getAllowedDomains();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

    const injectionCount = (db.prepare(`
      SELECT COUNT(*) as n FROM signals
      WHERE type = 'security_risk'
        AND rule_id = 'security:injection_detected'
        AND created_at > ?
    `).get(thirtyDaysAgo) as any)?.n ?? 0;

    const blockedOutboundCount = (db.prepare(`
      SELECT COUNT(*) as n FROM outbound_log
      WHERE allowed = 0 AND created_at > ?
    `).get(thirtyDaysAgo) as any)?.n ?? 0;

    const anomalousOutputCount = (db.prepare(`
      SELECT COUNT(*) as n FROM signals
      WHERE type = 'security_risk'
        AND rule_id = 'security:anomalous_output'
        AND created_at > ?
    `).get(thirtyDaysAgo) as any)?.n ?? 0;

    const totalOutbound = (db.prepare(`
      SELECT COUNT(*) as n FROM outbound_log
      WHERE created_at > ?
    `).get(thirtyDaysAgo) as any)?.n ?? 0;

    return res.json({
      layers: {
        outbound_allowlist: {
          active: isEnforcementEnabled(),
          allowed_count: allowed.length,
        },
        content_sanitisation: {
          active: readBoolSetting('security_sanitisation_enabled', true),
          injections_detected_30d: injectionCount,
        },
        kb_access_scoping: {
          active: readBoolSetting('security_kb_scan_enabled', true),
        },
        output_monitoring: {
          active: readBoolSetting('security_output_monitor_enabled', true),
          blocks_30d: anomalousOutputCount,
        },
      },
      stats: {
        outbound_blocked_30d: blockedOutboundCount,
        outbound_total_30d: totalOutbound,
        injections_detected_30d: injectionCount,
        anomalous_outputs_blocked_30d: anomalousOutputCount,
      },
    });
  } catch (err) {
    console.error('[security] status error:', err);
    return res.status(500).json({ error: 'Failed to load security status' });
  }
});

// ─── GET /api/security/allowlist ──────────────────────────────────────────────

router.get('/allowlist', (_req: Request, res: Response) => {
  try {
    const all = getAllowedDomains();
    const defaults = new Set(DEFAULT_ALLOWED_HOSTS);
    return res.json({
      enforcement: isEnforcementEnabled(),
      allowed: all.map(host => ({ host, source: defaults.has(host) ? 'default' : 'custom' })),
      blocked: Array.from(BLOCKED_HOSTS),
    });
  } catch (err) {
    console.error('[security] allowlist error:', err);
    return res.status(500).json({ error: 'Failed to load allowlist' });
  }
});

// ─── POST /api/security/allowlist ─────────────────────────────────────────────

router.post('/allowlist', (req: Request, res: Response) => {
  try {
    const { hostname } = req.body ?? {};
    if (!hostname || typeof hostname !== 'string') {
      return res.status(400).json({ error: 'hostname required' });
    }
    addToAllowlist(hostname);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// ─── DELETE /api/security/allowlist/:hostname ─────────────────────────────────

router.delete('/allowlist/:hostname', (req: Request, res: Response) => {
  try {
    const host = String(req.params.hostname);
    if (DEFAULT_ALLOWED_HOSTS.includes(host)) {
      return res.status(400).json({ error: 'Default hosts cannot be removed' });
    }
    removeFromAllowlist(host);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// ─── POST /api/security/enforcement ───────────────────────────────────────────

router.post('/enforcement', (req: Request, res: Response) => {
  try {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean' });
    }
    setEnforcementEnabled(enabled);
    return res.json({ ok: true, enforcement: enabled });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// ─── POST /api/security/toggle ────────────────────────────────────────────────

router.post('/toggle', (req: Request, res: Response) => {
  const { key, enabled } = req.body ?? {};
  const allowedKeys = new Set([
    'security_sanitisation_enabled',
    'security_kb_scan_enabled',
    'security_output_monitor_enabled',
  ]);
  if (!allowedKeys.has(key)) return res.status(400).json({ error: 'invalid key' });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  try {
    writeBoolSetting(key, enabled);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/security/events ─────────────────────────────────────────────────

router.get('/events', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const rows = db.prepare(`
      SELECT id, rule_id, severity, title, description, data, status, created_at, business_id, agent_id
      FROM signals
      WHERE type = 'security_risk'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as any[];

    const events = rows.map(r => ({
      ...r,
      data: (() => { try { return JSON.parse(r.data); } catch { return null; } })(),
    }));

    return res.json({ events });
  } catch (err) {
    console.error('[security] events error:', err);
    return res.status(500).json({ error: 'Failed to load security events' });
  }
});

// ─── GET /api/security/outbound-log ──────────────────────────────────────────

router.get('/outbound-log', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const onlyBlocked = req.query.blocked === '1' || req.query.blocked === 'true';
    const rows = db.prepare(`
      SELECT id, url, hostname, method, context, allowed, block_reason, status_code, created_at
      FROM outbound_log
      ${onlyBlocked ? 'WHERE allowed = 0' : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    return res.json({ entries: rows });
  } catch (err) {
    console.error('[security] outbound-log error:', err);
    return res.status(500).json({ error: 'Failed to load outbound log' });
  }
});

export default router;
