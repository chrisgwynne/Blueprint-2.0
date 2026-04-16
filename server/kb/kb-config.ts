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

export interface KBConfig {
  mode?: string;
  root?: string;
  obsidian_vault_path?: string | null;
  obsidian_write_folders?: string[];
  initialized?: boolean;
  initialized_at?: string | null;
  total_pages?: number;
  last_ingest?: string | null;
  last_lint?: string | null;
  [key: string]: unknown;
}

interface Business {
  id: string;
  name: string;
  slug: string;
}

function configKey(businessId: string): string {
  return `kb_config_${businessId}`;
}

export function getKBConfig(businessId: string): KBConfig | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(configKey(businessId)) as { value: string } | null;
  if (!row?.value) return null;
  try { return JSON.parse(row.value) as KBConfig; } catch { return null; }
}

export function saveKBConfig(businessId: string, config: KBConfig): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(configKey(businessId), JSON.stringify(config));
}

export function touchKBConfig(businessId: string, patch: Partial<KBConfig>): void {
  const config = getKBConfig(businessId) ?? {} as KBConfig;
  saveKBConfig(businessId, { ...config, ...patch } as KBConfig);
}

/**
 * Get a business-scoped KBEngine, ensuring it's initialized on disk.
 * Returns null (not throws) if the business doesn't exist.
 */
export async function getKBForBusiness(
  businessId: string
): Promise<{ engine: KBEngine; business: Business; config: KBConfig } | null> {
  const business = db.prepare('SELECT id, name, slug FROM businesses WHERE id = ?').get(businessId) as Business | null;
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

  const root = config.root ?? join(KB_ROOT, business.slug);
  const engine = new KBEngine(root, business.slug, business.id);
  if (!config.initialized || !existsSync(join(root, 'WIKI.md'))) {
    await engine.init(business.name);
    config.initialized = true;
    config.initialized_at = new Date().toISOString();
    saveKBConfig(businessId, config);
  }

  return { engine, business, config };
}
