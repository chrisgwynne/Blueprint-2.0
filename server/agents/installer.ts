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
import { setLifecycleState, type AgentLifecycleState } from './agentLifecycle.js';
import { ROLE_SPECS } from './agentActivationRules.js';
import { recordInstallation, recordUninstallation } from './hiring/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname);
const TEMPLATES_DIR = resolve(__dirname, 'templates');
const ARCHIVE_DIR = resolve(__dirname, '_archive');

interface AgentProfile {
  status?: string;
  name?: string;
  [key: string]: unknown;
}

interface ReadinessResult {
  ready: boolean;
  status: string;
  missing_required?: string[];
  missing_preferred?: string[];
  [key: string]: unknown;
}

interface InstallResult {
  agentId: string;
  /** Legacy free-text status (kept for backward compat with existing callers). */
  status: 'active' | 'pending';
  /** Structured lifecycle state. A freshly hired agent is 'standby' (never
   *  auto-activated) or 'candidate' if its connectors aren't ready yet. */
  lifecycle_state: AgentLifecycleState;
  readiness: ReadinessResult;
  alreadyInstalled: boolean;
}

function templateExists(templateId: string): boolean {
  return existsSync(join(TEMPLATES_DIR, templateId, 'profile.yaml'));
}

function installedProfileExists(agentId: string): boolean {
  return existsSync(join(AGENTS_DIR, agentId, 'profile.yaml'));
}

/**
 * Install an agent from a template.
 *
 * @param templateId  — e.g. 'seo-sentinel'
 * @param businessId  — which business this agent serves
 * @param installedBy — actor id (e.g. 'human', 'conductor', 'bap:xyz')
 */
export function installAgent(
  templateId: string,
  businessId: string,
  installedBy = 'human',
): InstallResult {
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

  // 2. Run readiness check to decide the starting LIFECYCLE state.
  //    CRITICAL: hiring never auto-activates work. A ready agent lands in
  //    `standby` (installed, resting, will run only when activated by a
  //    matching trigger). An agent that isn't ready yet lands in `candidate`
  //    (legacy status 'pending') until its connectors are present + fresh.
  const readiness = checkAgentReadiness(templateId, businessId) as unknown as ReadinessResult;
  const startState: AgentLifecycleState = readiness.ready ? 'standby' : 'candidate';
  const legacyStatus: 'active' | 'pending' = readiness.ready ? 'active' : 'pending';

  // 3. Write the live profile with the correct runtime status. Preserve every
  //    other field that shipped with the template.
  const profilePath = join(liveDir, 'profile.yaml');
  let profile: AgentProfile;
  try {
    profile = (yaml.load(readFileSync(profilePath, 'utf8')) as AgentProfile) ?? {};
  } catch {
    profile = {};
  }
  profile.status = legacyStatus;
  writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 100, noRefs: true, sortKeys: false }));

  // 4. Upsert the agents DB row, seeding the structured scope from ROLE_SPECS.
  const spec = ROLE_SPECS[templateId];
  const existingRow = db.prepare('SELECT id FROM agents WHERE id = ?').get(templateId) as { id: string } | null;
  if (existingRow) {
    db.prepare(`
      UPDATE agents
      SET status = ?, profile_path = ?, name = ?, created_at = COALESCE(created_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `).run(legacyStatus, `server/agents/${templateId}/profile.yaml`, profile.name ?? templateId, templateId);
  } else {
    db.prepare(`
      INSERT INTO agents (id, profile_path, name, status, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(templateId, `server/agents/${templateId}/profile.yaml`, profile.name ?? templateId, legacyStatus);
  }

  // Seed structured scope/role columns (idempotent — always refreshed from the
  // canonical ROLE_SPECS so a re-install picks up updated scopes).
  if (spec) {
    try {
      db.prepare(`
        UPDATE agents SET
          role = ?, purpose = ?, requires_approval = ?,
          kb_scope = ?, tools_allowed = ?, data_sources_allowed = ?, task_types_allowed = ?
        WHERE id = ?
      `).run(
        spec.role, spec.purpose, spec.requires_approval ? 1 : 0,
        JSON.stringify(spec.kb_scope), JSON.stringify(spec.tools),
        JSON.stringify(spec.data_sources), JSON.stringify(spec.task_types),
        templateId,
      );
    } catch (err) {
      console.warn('[installer] scope seed failed (non-fatal):', (err as Error).message);
    }
  }

  // Set the structured lifecycle_state (bridges to legacy status). This is the
  // single place hiring transitions an agent into the working roster — into
  // standby, never straight into work.
  setLifecycleState(templateId, startState, installedBy, {
    businessId,
    reason: readiness.ready
      ? 'Hired and placed in standby — will activate only on a matching trigger.'
      : `Hired but waiting for: ${(readiness.missing_required ?? []).join(', ') || 'required connectors'}.`,
    metadata: { readiness_status: readiness.status },
  });

  // 4b. Record the PER-BUSINESS installation (issue #49). The `agents` table
  // is an instance-wide roster keyed by template id, so it cannot answer
  // "has THIS business hired this agent?" — conductor-hiring read it anyway
  // and treated one business's hire as everyone's. agent_installations is the
  // authoritative business-scoped record the hiring engine now reads.
  try {
    recordInstallation(businessId, templateId, {
      installedBy, lifecycleState: startState,
      metadata: { readiness_status: readiness.status },
    });
  } catch (err) {
    console.warn('[installer] installation record failed (non-fatal):', (err as Error).message);
  }

  // 5. Audit.
  try {
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (lower(hex(randomblob(16))), ?, 'agent', ?, 'install', ?, ?, CURRENT_TIMESTAMP)
    `).run(businessId, templateId, installedBy, JSON.stringify({
      status: legacyStatus,
      lifecycle_state: startState,
      readiness_status: readiness.status,
      missing_required: readiness.missing_required,
      missing_preferred: readiness.missing_preferred,
    }));
  } catch (err) {
    console.warn('[installer] audit insert failed:', (err as Error).message);
  }

  console.log(`[installer] Installed '${templateId}' for business ${businessId} → lifecycle=${startState} (status=${legacyStatus}, readiness=${readiness.status})`);

  return {
    agentId: templateId,
    status: legacyStatus,
    lifecycle_state: startState,
    readiness,
    alreadyInstalled,
  };
}

/**
 * Retire an agent. Does NOT delete its on-disk files or its past run rows —
 * those are preserved for audit. The agent simply stops running.
 */
export function uninstallAgent(
  agentId: string,
  uninstalledBy = 'human',
  businessId?: string,
): { success: boolean; agentId: string } {
  const liveDir = join(AGENTS_DIR, agentId);
  const profilePath = join(liveDir, 'profile.yaml');

  if (existsSync(profilePath)) {
    try {
      const profile = (yaml.load(readFileSync(profilePath, 'utf8')) as AgentProfile) ?? {};
      profile.status = 'retired';
      writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 100, noRefs: true, sortKeys: false }));
    } catch (err) {
      console.warn('[installer] could not update profile status to retired:', (err as Error).message);
    }
  }

  // Archive via the lifecycle state machine (sets status='retired' through the
  // legacy bridge and records the transition event).
  try {
    setLifecycleState(agentId, 'archived', uninstalledBy, { reason: 'Agent retired/uninstalled.' });
  } catch {
    db.prepare("UPDATE agents SET status = 'retired' WHERE id = ?").run(agentId);
  }

  // Mirror the retirement into the per-business installation record so a
  // retired agent stops counting as installed for that business (#49). Scoped
  // to one business when the caller knows which; otherwise every business's
  // record for this agent, since the on-disk agent is gone for all of them.
  try {
    if (businessId) {
      recordUninstallation(businessId, agentId);
    } else {
      db.prepare(`
        UPDATE agent_installations SET status = 'uninstalled', uninstalled_at = CURRENT_TIMESTAMP
         WHERE agent_id = ? AND status = 'installed'
      `).run(agentId);
    }
  } catch (err) {
    console.warn('[installer] uninstall record failed (non-fatal):', (err as Error).message);
  }

  try {
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (lower(hex(randomblob(16))), ?, 'agent', ?, 'retire', ?, ?, CURRENT_TIMESTAMP)
    `).run(businessId ?? null, agentId, uninstalledBy, JSON.stringify({}));
  } catch {}

  return { success: true, agentId };
}

/**
 * True if a given template has a live installation on disk AND an active
 * row in the DB (either 'active' or 'pending' — excludes retired).
 */
export function isAgentInstalled(agentId: string): boolean {
  if (!installedProfileExists(agentId)) return false;
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | null;
  return !!row && row.status !== 'retired';
}

/**
 * List every template id available for hire.
 */
export function listAvailableTemplates(): string[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && templateExists(e.name))
    .map((e) => e.name);
}
