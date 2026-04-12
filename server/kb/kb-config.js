/**
 * Shared KB config helpers — used by routes, scheduler, agent-runner.
 * Stored in the settings table under key `kb_config_{businessId}`.
 */
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import db from '../db/db.js';
import { KBEngine } from './kb-engine.js';

export const KB_ROOT = process.env.KB_PATH ||
  resolve(process.env.PROJECT_ROOT ?? process.cwd(), '../kb');

function configKey(businessId) {
  return `kb_config_${businessId}`;
}

export function getKBConfig(businessId) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(configKey(businessId));
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function saveKBConfig(businessId, config) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(configKey(businessId), JSON.stringify(config));
}

export function touchKBConfig(businessId, patch) {
  const config = getKBConfig(businessId) ?? {};
  saveKBConfig(businessId, { ...config, ...patch });
}

/**
 * Get a business-scoped KBEngine, ensuring it's initialized on disk.
 * Returns null (not throws) if the business doesn't exist.
 */
export async function getKBForBusiness(businessId) {
  const business = db.prepare('SELECT id, name, slug FROM businesses WHERE id = ?').get(businessId);
  if (!business) return null;

  let config = getKBConfig(businessId);
  if (!config) {
    config = {
      mode: 'native',
      root: join(KB_ROOT, business.slug),
      obsidian_vault_path: null,
      obsidian_write_folders: ['blueprint/'],
      initialized: false,
      initialized_at: null,
      total_pages: 0,
      last_ingest: null,
      last_lint: null,
    };
    saveKBConfig(businessId, config);
  }

  const engine = new KBEngine(config.root, business.slug);
  if (!config.initialized || !existsSync(join(config.root, 'WIKI.md'))) {
    await engine.init(business.name);
    config.initialized = true;
    config.initialized_at = new Date().toISOString();
    saveKBConfig(businessId, config);
  }

  return { engine, business, config };
}
