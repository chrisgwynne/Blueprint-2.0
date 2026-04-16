import { readFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import crypto from 'crypto';
import db, { generateId } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');
const TEMPLATES_DIR = join(AGENTS_DIR, 'templates');

function initSchema(): void {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Additive migrations — tolerate "duplicate column" errors for re-runs
  const migrations = [
    // Outcome attribution (Feature 4)
    "ALTER TABLE tasks ADD COLUMN target_metric TEXT",
    "ALTER TABLE tasks ADD COLUMN target_metric_baseline REAL",
    // Signal clustering (Feature 2)
    "ALTER TABLE signals ADD COLUMN cluster_id TEXT REFERENCES signal_clusters(id)",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); }
    catch (err: any) {
      if (!/duplicate column|already exists/i.test(err.message)) {
        console.warn('[db:init] migration warning:', err.message);
      }
    }
  }
  console.log('[db:init] Schema applied successfully.');
}

function seedSettings(): void {
  const defaults: Array<{ key: string; value: any }> = [
    { key: 'app.name', value: 'Blueprint' },
    { key: 'app.version', value: '0.1.0' },
    { key: 'scheduler.enabled', value: true },
    { key: 'scheduler.conductor_interval_hours', value: 1 },
    { key: 'scheduler.connector_check_interval_minutes', value: 15 },
    { key: 'agents.default_trust_tier', value: 'yellow' },
    { key: 'agents.default_approval_mode', value: 'requires_approval' },
    { key: 'notifications.telegram.enabled', value: false },
    // Blueprint system GitHub — for self-healing and connector discovery issues/PRs.
    // SEPARATE from business GitHub connectors (which are per-business in connectors table).
    // Owner/repo are hardcoded in server/lib/blueprint-github.js and are not configurable.
    { key: 'blueprint_github_token',   value: process.env.BLUEPRINT_GITHUB_TOKEN || '' },
    { key: 'blueprint_github_enabled', value: true },
  ];

  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO NOTHING
  `);

  const seedAll = db.transaction(() => {
    for (const { key, value } of defaults) {
      upsert.run(key, JSON.stringify(value));
    }
  });

  seedAll();
  console.log('[db:init] Default settings seeded.');
}

function seedAgentProfiles(): void {
  const upsert = db.prepare(`
    INSERT INTO agents (id, profile_path, name, status, created_at)
    VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `);
  upsert.run('conductor', 'server/agents/conductor/profile.yaml', 'Conductor');
  console.log('[db:init] Conductor seeded (only agent on fresh install).');
}

function preInstallCoreAgents(): void {
  const coreAgents = ['conductor'];

  for (const agentId of coreAgents) {
    const liveDir = join(AGENTS_DIR, agentId);
    const templateDir = join(TEMPLATES_DIR, agentId);

    // Already installed — skip
    if (existsSync(join(liveDir, 'profile.yaml'))) {
      console.log(`[db:init] Agent '${agentId}' already installed — skipping.`);
      continue;
    }

    // Template must exist
    if (!existsSync(templateDir)) {
      console.warn(`[db:init] Template for '${agentId}' not found at ${templateDir} — skipping pre-install.`);
      continue;
    }

    mkdirSync(liveDir, { recursive: true });
    cpSync(templateDir, liveDir, { recursive: true });
    console.log(`[db:init] Agent '${agentId}' pre-installed from template.`);
  }
}

try {
  initSchema();
  seedSettings();
  seedAgentProfiles();
  preInstallCoreAgents();
  // No default business seeded — the onboarding wizard creates it so the
  // user goes through the proper setup flow on first login.
  console.log('[db:init] Database initialisation complete.');
  process.exit(0);
} catch (err) {
  console.error('[db:init] Fatal error:', err);
  process.exit(1);
}
