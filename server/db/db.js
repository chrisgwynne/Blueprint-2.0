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

// ─── Idempotent additive migrations (safe on every startup) ──────────────────
// Silently applies columns/tables added after initial schema.sql deployment.
const STARTUP_MIGRATIONS = [
  // Signal clustering (Feature 2)
  `CREATE TABLE IF NOT EXISTS signal_clusters (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    likely_cause TEXT,
    recommendation TEXT,
    severity TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT DEFAULT 'open',
    signal_ids JSON NOT NULL,
    created_by TEXT DEFAULT 'conductor',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signal_clusters_business_status ON signal_clusters(business_id, status)`,
  `ALTER TABLE signals ADD COLUMN cluster_id TEXT`,
  // Outcome attribution (Feature 4)
  `ALTER TABLE tasks ADD COLUMN target_metric TEXT`,
  `ALTER TABLE tasks ADD COLUMN target_metric_baseline REAL`,
  // Chat (Feature 3)
  `CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    title TEXT,
    type TEXT DEFAULT 'human',
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived_at DATETIME
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    mentions JSON DEFAULT '[]',
    attachments JSON DEFAULT '[]',
    metadata JSON DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS chat_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    reactor_id TEXT NOT NULL,
    reaction TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
];
for (const sql of STARTUP_MIGRATIONS) {
  try { db.exec(sql); }
  catch (err) {
    if (!/duplicate column|already exists/i.test(err.message)) {
      console.warn('[db] startup migration warning:', err.message);
    }
  }
}

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
