import { readFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import crypto from 'crypto';
import db, { generateId } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');
const TEMPLATES_DIR = join(AGENTS_DIR, 'templates');

function initSchema() {
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
    catch (err) {
      if (!/duplicate column|already exists/i.test(err.message)) {
        console.warn('[db:init] migration warning:', err.message);
      }
    }
  }
  console.log('[db:init] Schema applied successfully.');
}

function seedSettings() {
  const defaults = [
    { key: 'app.name', value: 'Blueprint' },
    { key: 'app.version', value: '0.1.0' },
    { key: 'scheduler.enabled', value: true },
    { key: 'scheduler.conductor_interval_hours', value: 1 },
    { key: 'scheduler.connector_check_interval_minutes', value: 15 },
    { key: 'agents.default_trust_tier', value: 'yellow' },
    { key: 'agents.default_approval_mode', value: 'requires_approval' },
    { key: 'notifications.telegram.enabled', value: false },
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

function seedAgentProfiles() {
  // All 12 agents — core 4 pre-installed, rest available as templates
  const agents = [
    // ── Core agents (pre-installed) ──────────────────────────────────────────
    { id: 'conductor',     name: 'Conductor',     core: true  },
    { id: 'seo-sentinel',  name: 'SEO Sentinel',  core: true  },
    { id: 'quill',         name: 'Quill',         core: true  },
    { id: 'trend-spotter', name: 'Trend Spotter', core: true  },
    // ── Optional agents (install from templates) ─────────────────────────────
    { id: 'velocity',      name: 'Velocity',      core: false },
    { id: 'ledger',        name: 'Ledger',        core: false },
    { id: 'merchant',      name: 'Merchant',      core: false },
    { id: 'sentinel',      name: 'Sentinel',      core: false },
    { id: 'researcher',    name: 'Researcher',    core: false },
    { id: 'reporter',      name: 'Reporter',      core: false },
    { id: 'dev',           name: 'Dev',           core: false },
    { id: 'outreach',      name: 'Outreach',      core: false },
  ];

  const upsert = db.prepare(`
    INSERT INTO agents (id, profile_path, name, status, created_at)
    VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `);

  const seedAll = db.transaction(() => {
    for (const agent of agents) {
      upsert.run(
        agent.id,
        `server/agents/${agent.id}/profile.yaml`,
        agent.name,
      );
    }
  });

  seedAll();
  console.log('[db:init] Agent profiles seeded (12 total).');
}

function preInstallCoreAgents() {
  const coreAgents = ['conductor', 'seo-sentinel', 'quill', 'trend-spotter'];

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

function seedDefaultBusiness() {
  const existing = db.prepare('SELECT COUNT(*) as n FROM businesses').get();
  if (existing.n > 0) {
    console.log('[db:init] Business already exists — skipping seed.');
    return;
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO businesses (id, name, slug, type, description, settings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id,
    'My Business',
    'my-business',
    'general',
    'Default business — rename in Settings',
    '{}'
  );
  console.log(`[db:init] Default business seeded (id: ${id}).`);
}

try {
  initSchema();
  seedSettings();
  seedAgentProfiles();
  preInstallCoreAgents();
  seedDefaultBusiness();
  console.log('[db:init] Database initialisation complete.');
  process.exit(0);
} catch (err) {
  console.error('[db:init] Fatal error:', err);
  process.exit(1);
}
