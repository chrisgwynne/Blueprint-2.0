import { Database } from 'bun:sqlite';
import { resolve, dirname } from 'path';
import crypto from 'crypto';
import { mkdirSync } from 'fs';

// Resolve relative to cwd (project root when run via `bun server/...` or from server/)
const _root = process.env.DATABASE_PATH
  ? dirname(resolve(process.env.DATABASE_PATH))
  : resolve(process.cwd(), '../data');

const DB_PATH = process.env.DATABASE_PATH || resolve(process.cwd(), '../data/blueprint.db');

// Ensure data directory exists
try {
  mkdirSync(_root, { recursive: true });
} catch (_) {}

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

export function generateId() {
  return crypto.randomUUID();
}

/**
 * Write an audit log entry.
 */
export function audit(
  businessId,
  entityType,
  entityId,
  action,
  actor,
  beforeState = null,
  afterState = null,
  metadata = null
) {
  db.prepare(`
    INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, before_state, after_state, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    generateId(),
    businessId ?? null,
    entityType,
    entityId,
    action,
    actor,
    beforeState !== null ? JSON.stringify(beforeState) : null,
    afterState !== null ? JSON.stringify(afterState) : null,
    metadata !== null ? JSON.stringify(metadata) : null
  );
}

export default db;
