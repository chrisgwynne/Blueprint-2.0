/**
 * Agent installer.
 *
 * Copies a template from server/agents/templates/{id} to server/agents/{id},
 * creates/updates the agents DB row, and runs a readiness check so the new
 * agent lands in the correct status (active if all required connectors are
 * present and fresh, pending otherwise).
 *
 * Use this from:
 *   - onboarding / UI hire flow
 *   - executor.js 'hire_agent' action
 *   - admin install routes
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import db from '../db/db.js';
import { checkAgentReadiness } from './readiness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname);
const TEMPLATES_DIR = resolve(__dirname, 'templates');
const ARCHIVE_DIR = resolve(__dirname, '_archive');

function templateExists(templateId) {
  return existsSync(join(TEMPLATES_DIR, templateId, 'profile.yaml'));
}

function installedProfileExists(agentId) {
  return existsSync(join(AGENTS_DIR, agentId, 'profile.yaml'));
}

/**
 * Install an agent from a template.
 *
 * @param {string} templateId  — e.g. 'seo-sentinel'
 * @param {string} businessId  — which business this agent serves
 * @param {string} installedBy — actor id (e.g. 'human', 'conductor', 'bap:xyz')
 * @returns {{
 *   agentId: string,
 *   status: 'active' | 'pending',
 *   readiness: object,
 *   alreadyInstalled: boolean,
 * }}
 */
export function installAgent(templateId, businessId, installedBy = 'human') {
  if (!templateId) throw new Error('templateId is required');
  if (!businessId) throw new Error('businessId is required');
  if (!templateExists(templateId)) {
    throw new Error(`Template '${templateId}' not found at ${TEMPLATES_DIR}/${templateId}`);
  }

  const liveDir = join(AGENTS_DIR, templateId);
  const templateDir = join(TEMPLATES_DIR, templateId);
  const alreadyInstalled = installedProfileExists(templateId);

  // 1. Copy template files (non-destructive: only copy if missing on disk).
  //    On re-install of a retired agent we want to restore the template.
  if (!alreadyInstalled) {
    mkdirSync(liveDir, { recursive: true });
    cpSync(templateDir, liveDir, { recursive: true });
  }

  // 2. Run readiness check to decide starting status.
  const readiness = checkAgentReadiness(templateId, businessId);
  const startStatus = readiness.ready ? 'active' : 'pending';

  // 3. Write the live profile with the correct runtime status. Preserve every
  //    other field that shipped with the template.
  const profilePath = join(liveDir, 'profile.yaml');
  let profile;
  try {
    profile = yaml.load(readFileSync(profilePath, 'utf8')) ?? {};
  } catch {
    profile = {};
  }
  profile.status = startStatus;
  writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 100, noRefs: true, sortKeys: false }));

  // 4. Upsert the agents DB row.
  const existingRow = db.prepare('SELECT id FROM agents WHERE id = ?').get(templateId);
  if (existingRow) {
    db.prepare(`
      UPDATE agents
      SET status = ?, profile_path = ?, name = ?, created_at = COALESCE(created_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `).run(startStatus, `server/agents/${templateId}/profile.yaml`, profile.name ?? templateId, templateId);
  } else {
    db.prepare(`
      INSERT INTO agents (id, profile_path, name, status, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(templateId, `server/agents/${templateId}/profile.yaml`, profile.name ?? templateId, startStatus);
  }

  // 5. Audit.
  try {
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (lower(hex(randomblob(16))), ?, 'agent', ?, 'install', ?, ?, CURRENT_TIMESTAMP)
    `).run(businessId, templateId, installedBy, JSON.stringify({
      status: startStatus,
      readiness_status: readiness.status,
      missing_required: readiness.missing_required,
      missing_preferred: readiness.missing_preferred,
    }));
  } catch (err) {
    console.warn('[installer] audit insert failed:', err.message);
  }

  console.log(`[installer] Installed '${templateId}' for business ${businessId} → status=${startStatus} (readiness=${readiness.status})`);

  return {
    agentId: templateId,
    status: startStatus,
    readiness,
    alreadyInstalled,
  };
}

/**
 * Retire an agent. Does NOT delete its on-disk files or its past run rows —
 * those are preserved for audit. The agent simply stops running.
 */
export function uninstallAgent(agentId, uninstalledBy = 'human') {
  const liveDir = join(AGENTS_DIR, agentId);
  const profilePath = join(liveDir, 'profile.yaml');

  if (existsSync(profilePath)) {
    try {
      const profile = yaml.load(readFileSync(profilePath, 'utf8')) ?? {};
      profile.status = 'retired';
      writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 100, noRefs: true, sortKeys: false }));
    } catch (err) {
      console.warn('[installer] could not update profile status to retired:', err.message);
    }
  }

  db.prepare("UPDATE agents SET status = 'retired' WHERE id = ?").run(agentId);

  try {
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (lower(hex(randomblob(16))), NULL, 'agent', ?, 'retire', ?, ?, CURRENT_TIMESTAMP)
    `).run(agentId, uninstalledBy, JSON.stringify({}));
  } catch {}

  return { success: true, agentId };
}

/**
 * True if a given template has a live installation on disk AND an active
 * row in the DB (either 'active' or 'pending' — excludes retired).
 */
export function isAgentInstalled(agentId) {
  if (!installedProfileExists(agentId)) return false;
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId);
  return !!row && row.status !== 'retired';
}

/**
 * List every template id available for hire.
 */
export function listAvailableTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && templateExists(e.name))
    .map((e) => e.name);
}
