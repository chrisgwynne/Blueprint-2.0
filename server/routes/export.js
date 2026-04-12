/**
 * Data export endpoints.
 *
 * All exports require session auth and stream as downloads.
 * No credentials are ever included in exports.
 */
import { Router } from 'express';
import { isAuthenticated } from '../middleware/auth.js';
import db from '../db/db.js';
import { createReadStream, existsSync } from 'fs';
import { resolve, join } from 'path';

const router = Router();
router.use(isAuthenticated);

// ─── Helpers ────────────────────────────────────────────────────────────────

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(...fields) {
  return fields.map(csvEscape).join(',') + '\n';
}

function setDownloadHeaders(res, filename, contentType = 'text/csv') {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

// ─── Metrics CSV ────────────────────────────────────────────────────────────

router.get('/:businessId/metrics', (req, res) => {
  try {
    const { connector } = req.query;
    const filename = `metrics-${req.params.businessId.slice(0, 8)}-${new Date().toISOString().split('T')[0]}.csv`;
    setDownloadHeaders(res, filename);

    res.write(csvRow('recorded_at', 'connector_type', 'metric_name', 'metric_value'));

    const conditions = ['m.business_id = ?', 'm.metric_value IS NOT NULL'];
    const params = [req.params.businessId];
    if (connector) {
      conditions.push("c.type = ?");
      params.push(connector);
    }

    const rows = db.prepare(`
      SELECT m.recorded_at, c.type as connector_type, m.metric_name, m.metric_value
      FROM metrics m
      LEFT JOIN connectors c ON c.id = m.connector_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.recorded_at DESC
    `).all(...params);

    for (const row of rows) {
      res.write(csvRow(row.recorded_at, row.connector_type ?? 'custom', row.metric_name, row.metric_value));
    }

    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tasks CSV ──────────────────────────────────────────────────────────────

router.get('/:businessId/tasks', (req, res) => {
  try {
    const filename = `tasks-${req.params.businessId.slice(0, 8)}-${new Date().toISOString().split('T')[0]}.csv`;
    setDownloadHeaders(res, filename);

    res.write(csvRow('id', 'title', 'proposed_by', 'action_type', 'status', 'priority', 'trust_tier', 'confidence', 'created_at', 'completed_at', 'outcome'));

    const rows = db.prepare(
      'SELECT id, title, proposed_by, action_type, status, priority, trust_tier, confidence, created_at, completed_at, outcome FROM tasks WHERE business_id = ? ORDER BY created_at DESC'
    ).all(req.params.businessId);

    for (const row of rows) {
      res.write(csvRow(row.id, row.title, row.proposed_by, row.action_type, row.status, row.priority, row.trust_tier, row.confidence, row.created_at, row.completed_at, row.outcome));
    }

    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Signals CSV ────────────────────────────────────────────────────────────

router.get('/:businessId/signals', (req, res) => {
  try {
    const filename = `signals-${req.params.businessId.slice(0, 8)}-${new Date().toISOString().split('T')[0]}.csv`;
    setDownloadHeaders(res, filename);

    res.write(csvRow('id', 'type', 'severity', 'title', 'rule_id', 'status', 'confidence', 'created_at', 'resolved_at'));

    const rows = db.prepare(
      'SELECT id, type, severity, title, rule_id, status, confidence, created_at, resolved_at FROM signals WHERE business_id = ? ORDER BY created_at DESC'
    ).all(req.params.businessId);

    for (const row of rows) {
      res.write(csvRow(row.id, row.type, row.severity, row.title, row.rule_id, row.status, row.confidence, row.created_at, row.resolved_at));
    }

    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Agent runs CSV ─────────────────────────────────────────────────────────

router.get('/:businessId/agent-runs', (req, res) => {
  try {
    const filename = `agent-runs-${req.params.businessId.slice(0, 8)}-${new Date().toISOString().split('T')[0]}.csv`;
    setDownloadHeaders(res, filename);

    res.write(csvRow('id', 'agent_id', 'trigger', 'status', 'tasks_proposed', 'signals_detected', 'cost_usd', 'started_at', 'completed_at'));

    const rows = db.prepare(
      'SELECT id, agent_id, trigger, status, tasks_proposed, signals_detected, cost_usd, started_at, completed_at FROM agent_runs WHERE business_id = ? ORDER BY started_at DESC'
    ).all(req.params.businessId);

    for (const row of rows) {
      res.write(csvRow(row.id, row.agent_id, row.trigger, row.status, row.tasks_proposed, row.signals_detected, row.cost_usd, row.started_at, row.completed_at));
    }

    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Full DB export (JSON) ──────────────────────────────────────────────────

router.get('/database', (req, res) => {
  try {
    const filename = `blueprint-db-${new Date().toISOString().split('T')[0]}.json`;
    setDownloadHeaders(res, filename, 'application/json');

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);

    const dump = {};
    for (const table of tables) {
      // Skip sensitive data
      if (table === 'sessions') continue;

      const rows = db.prepare(`SELECT * FROM ${table} LIMIT 10000`).all();

      // Strip credential fields
      dump[table] = rows.map(row => {
        const cleaned = { ...row };
        if (cleaned.credentials) cleaned.credentials = '[REDACTED]';
        if (cleaned.api_key_hash) cleaned.api_key_hash = '[REDACTED]';
        if (cleaned.key_hash) cleaned.key_hash = '[REDACTED]';
        if (cleaned.webhook_secret) cleaned.webhook_secret = '[REDACTED]';
        return cleaned;
      });
    }

    res.json({ exported_at: new Date().toISOString(), tables: dump });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
