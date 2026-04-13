/**
 * Agent readiness check.
 *
 * An agent is only allowed to run when the connectors it depends on are
 * connected AND have synced successfully at least once within a reasonable
 * staleness window. This prevents the class of bugs where agents run against
 * empty data, hallucinate findings, and pollute the KB.
 *
 * Public API:
 *   checkAgentReadiness(agentId, businessId)
 *     → { ready, status, missing_required, missing_preferred, last_sync_ages, reason }
 *
 * Status values:
 *   'ready'                   — all required connectors active AND fresh
 *   'missing_connectors'      — at least one required connector is not installed or disconnected
 *   'connectors_never_synced' — installed but no successful sync yet
 *   'connectors_stale'        — last successful sync older than STALE_HOURS
 *   'paused'                  — agent profile/DB status = paused or disabled
 *   'retired'                 — agent has been uninstalled
 *   'not_installed'           — agent has no profile on disk
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import db from '../db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname);

// An installed connector that hasn't synced in 48h is considered stale — the
// agent skips rather than working with old data.
const STALE_HOURS = 48;

/**
 * Resolve required/preferred connector types from a profile. Supports both
 * naming conventions in use across the codebase:
 *   connectors_required / connectors_optional   (existing profiles)
 *   required_connectors / preferred_connectors  (redesign spec alias)
 */
function extractConnectorSpec(profile) {
  const required = profile?.required_connectors ?? profile?.connectors_required ?? [];
  const preferred = profile?.preferred_connectors ?? profile?.connectors_optional ?? [];
  return {
    required: Array.isArray(required) ? required : [],
    preferred: Array.isArray(preferred) ? preferred : [],
  };
}

function loadProfile(agentId) {
  const profilePath = join(AGENTS_DIR, agentId, 'profile.yaml');
  if (!existsSync(profilePath)) return null;
  try { return yaml.load(readFileSync(profilePath, 'utf8')); }
  catch { return null; }
}

/**
 * For a given business and connector type, returns the latest connector row
 * and its last-successful-sync timestamp (or null if never synced).
 */
function getConnectorStatus(businessId, connectorType) {
  const connector = db.prepare(
    `SELECT id, type, status, last_sync
     FROM connectors
     WHERE business_id = ? AND type = ? AND status != 'disconnected'
     ORDER BY created_at DESC LIMIT 1`
  ).get(businessId, connectorType);

  if (!connector) return { connector: null, last_success_at: null };

  const lastSync = db.prepare(
    `SELECT created_at FROM connector_syncs
     WHERE connector_id = ? AND status = 'complete'
     ORDER BY created_at DESC LIMIT 1`
  ).get(connector.id);

  return {
    connector,
    last_success_at: lastSync?.created_at ?? connector.last_sync ?? null,
  };
}

function hoursSince(isoLike) {
  if (!isoLike) return null;
  // SQLite CURRENT_TIMESTAMP is naive UTC — coerce with a trailing Z.
  const iso = typeof isoLike === 'string' && !/[zZ]|[+-]\d{2}/.test(isoLike)
    ? isoLike.replace(' ', 'T') + 'Z'
    : isoLike;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3600_000;
}

function readAgentRowStatus(agentId) {
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId);
  return row?.status ?? null;
}

export function checkAgentReadiness(agentId, businessId) {
  const profile = loadProfile(agentId);
  if (!profile) {
    return {
      ready: false,
      status: 'not_installed',
      missing_required: [],
      missing_preferred: [],
      last_sync_ages: {},
      reason: `Agent '${agentId}' has no profile installed on disk.`,
    };
  }

  const dbStatus = readAgentRowStatus(agentId);
  if (profile.status === 'retired' || dbStatus === 'retired') {
    return {
      ready: false,
      status: 'retired',
      missing_required: [],
      missing_preferred: [],
      last_sync_ages: {},
      reason: `Agent '${agentId}' has been retired.`,
    };
  }
  if (profile.status === 'paused' || dbStatus === 'paused' || dbStatus === 'disabled') {
    return {
      ready: false,
      status: 'paused',
      missing_required: [],
      missing_preferred: [],
      last_sync_ages: {},
      reason: `Agent '${agentId}' is paused.`,
    };
  }

  const { required, preferred } = extractConnectorSpec(profile);

  // Agents with no connector dependencies (conductor, researcher, quill with
  // no required list) are always ready — there's nothing to wait for.
  if (required.length === 0 && preferred.length === 0) {
    return {
      ready: true,
      status: 'ready',
      missing_required: [],
      missing_preferred: [],
      last_sync_ages: {},
      reason: 'No connector dependencies.',
    };
  }

  const missingRequired = [];
  const missingPreferred = [];
  const neverSynced = [];
  const staleRequired = [];
  const lastSyncAges = {};

  for (const type of required) {
    const { connector, last_success_at } = getConnectorStatus(businessId, type);
    if (!connector) {
      missingRequired.push(type);
      lastSyncAges[type] = null;
      continue;
    }
    const age = hoursSince(last_success_at);
    lastSyncAges[type] = age;
    if (age === null) {
      neverSynced.push(type);
    } else if (age > STALE_HOURS) {
      staleRequired.push(type);
    }
  }

  for (const type of preferred) {
    const { connector, last_success_at } = getConnectorStatus(businessId, type);
    if (!connector) {
      missingPreferred.push(type);
      lastSyncAges[type] = null;
    } else {
      lastSyncAges[type] = hoursSince(last_success_at);
    }
  }

  if (missingRequired.length > 0) {
    return {
      ready: false,
      status: 'missing_connectors',
      missing_required: missingRequired,
      missing_preferred: missingPreferred,
      last_sync_ages: lastSyncAges,
      reason: `Required connector${missingRequired.length > 1 ? 's' : ''} not connected: ${missingRequired.join(', ')}.`,
    };
  }

  if (neverSynced.length > 0) {
    return {
      ready: false,
      status: 'connectors_never_synced',
      missing_required: [],
      missing_preferred: missingPreferred,
      last_sync_ages: lastSyncAges,
      reason: `Required connector${neverSynced.length > 1 ? 's have' : ' has'} never completed a successful sync: ${neverSynced.join(', ')}.`,
    };
  }

  if (staleRequired.length > 0) {
    return {
      ready: false,
      status: 'connectors_stale',
      missing_required: [],
      missing_preferred: missingPreferred,
      last_sync_ages: lastSyncAges,
      reason: `Required connector data is stale (> ${STALE_HOURS}h old): ${staleRequired.join(', ')}.`,
    };
  }

  return {
    ready: true,
    status: 'ready',
    missing_required: [],
    missing_preferred: missingPreferred,
    last_sync_ages: lastSyncAges,
    reason: missingPreferred.length > 0
      ? `Ready. Optional connectors not available: ${missingPreferred.join(', ')}.`
      : 'Ready. All required connectors available and fresh.',
  };
}

/**
 * Check every 'pending' agent for a business. Returns those that are now
 * ready to promote to 'active'.
 */
export function findPromotableAgents(businessId) {
  const pending = db.prepare(
    `SELECT id FROM agents WHERE status = 'pending'`
  ).all();
  const promotable = [];
  for (const row of pending) {
    const r = checkAgentReadiness(row.id, businessId);
    if (r.ready) promotable.push({ id: row.id, readiness: r });
  }
  return promotable;
}
