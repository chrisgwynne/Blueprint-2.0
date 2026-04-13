/**
 * One-off cleanup: flag KB entries written before their source agent's
 * required connectors had a successful sync.
 *
 * Before the readiness gate landed, agents could run against empty data and
 * write speculative reasoning into the KB. Those entries are now indistinguishable
 * from real findings unless we mark them. This script does not delete anything
 * — it sets kb_docs.review_status='flagged' + review_reason so a human can
 * audit them.
 *
 * Usage:
 *   bun run server/scripts/flag-pre-connector-kb.js
 *
 * Idempotent: entries already flagged keep their reason; entries now clean
 * (source connector synced before the KB entry) are left at review_status='ok'.
 *
 * Derivation rules for "which agent wrote this KB entry":
 *   1. frontmatter.created_by or frontmatter.agent_id, if set
 *   2. tags array — one of the tags matches a known agent id (agent-runner.js
 *      writes [agent-run, agentId, trigger])
 *   3. path prefix — e.g. /kb/seo/* → seo-sentinel
 *
 * Entries we can't attribute to an agent are left alone.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import db from '../db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '..', 'agents', 'templates');

// Map KB path prefixes to the agent most likely to have written them.
// Signals-style agent runs are written to signals/agent-*.md (agent-runner.js
// writeFile path). Anything else we fall back to frontmatter/tags.
const PATH_PREFIX_TO_AGENT = [
  { prefix: 'signals/agent-seo-sentinel-', agent: 'seo-sentinel' },
  { prefix: 'signals/agent-merchant-',     agent: 'merchant' },
  { prefix: 'signals/agent-trend-spotter-', agent: 'trend-spotter' },
  { prefix: 'signals/agent-velocity-',     agent: 'velocity' },
  { prefix: 'signals/agent-ledger-',       agent: 'ledger' },
  { prefix: 'signals/agent-sentinel-',     agent: 'sentinel' },
  { prefix: 'signals/agent-dev-',          agent: 'dev' },
  { prefix: 'signals/agent-outreach-',     agent: 'outreach' },
  { prefix: 'signals/agent-quill-',        agent: 'quill' },
  { prefix: 'signals/agent-reporter-',     agent: 'reporter' },
  { prefix: 'signals/agent-researcher-',   agent: 'researcher' },
  // Any other path prefix is left unattributed.
];

function loadTemplateConnectorSpec(agentId) {
  const path = join(TEMPLATES_DIR, agentId, 'profile.yaml');
  if (!existsSync(path)) return { required: [] };
  try {
    const profile = yaml.load(readFileSync(path, 'utf8')) ?? {};
    const required = profile.required_connectors ?? profile.connectors_required ?? [];
    return { required: Array.isArray(required) ? required : [] };
  } catch {
    return { required: [] };
  }
}

function safeJSON(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function knownAgentIds() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
}

function deriveAgent(kbDoc, knownAgents) {
  const fm = safeJSON(kbDoc.frontmatter, {});
  if (fm.created_by && knownAgents.includes(fm.created_by)) return fm.created_by;
  if (fm.agent_id && knownAgents.includes(fm.agent_id)) return fm.agent_id;

  const tags = safeJSON(kbDoc.tags, []);
  if (Array.isArray(tags)) {
    const hit = tags.find((t) => knownAgents.includes(t));
    if (hit) return hit;
  }

  for (const { prefix, agent } of PATH_PREFIX_TO_AGENT) {
    if (kbDoc.path?.startsWith(prefix)) return agent;
  }
  return null;
}

/**
 * For a given business and connector type, return the earliest successful
 * sync timestamp, or null if there was never a successful sync.
 */
function firstSuccessfulSync(businessId, connectorType) {
  const row = db.prepare(
    `SELECT MIN(cs.created_at) as first_ok
     FROM connector_syncs cs
     JOIN connectors c ON c.id = cs.connector_id
     WHERE c.business_id = ? AND c.type = ? AND cs.status = 'complete'`
  ).get(businessId, connectorType);
  return row?.first_ok ?? null;
}

function main() {
  const docs = db.prepare('SELECT * FROM kb_docs').all();
  if (docs.length === 0) {
    console.log('[flag-pre-connector-kb] No kb_docs rows — nothing to do.');
    return;
  }

  const agents = knownAgentIds();
  const specCache = new Map();
  const firstSyncCache = new Map();

  let flagged = 0;
  let alreadyFlagged = 0;
  let unattributed = 0;
  let cleared = 0;
  let skippedOk = 0;

  const update = db.prepare(`
    UPDATE kb_docs
    SET review_status = ?, review_reason = ?, created_by = COALESCE(?, created_by)
    WHERE id = ?
  `);

  for (const doc of docs) {
    const agentId = deriveAgent(doc, agents);
    if (!agentId) {
      unattributed++;
      continue;
    }

    if (!specCache.has(agentId)) {
      specCache.set(agentId, loadTemplateConnectorSpec(agentId));
    }
    const { required } = specCache.get(agentId);
    if (required.length === 0) {
      // Agent has no required connectors (conductor, quill, researcher etc.)
      // — nothing could have been "pre-connector" for it.
      skippedOk++;
      continue;
    }

    if (!doc.business_id) {
      // KB entry not scoped to a business — can't verify connector timing.
      unattributed++;
      continue;
    }

    // Flag if at least one required connector either never synced OR first
    // synced AFTER this KB doc was created.
    let reasonParts = [];
    for (const type of required) {
      const cacheKey = `${doc.business_id}::${type}`;
      if (!firstSyncCache.has(cacheKey)) {
        firstSyncCache.set(cacheKey, firstSuccessfulSync(doc.business_id, type));
      }
      const firstOk = firstSyncCache.get(cacheKey);
      if (!firstOk) {
        reasonParts.push(`${type} has never successfully synced`);
      } else if (doc.created_at && new Date(doc.created_at) < new Date(firstOk)) {
        reasonParts.push(`${type} first synced ${firstOk} — after this entry was written`);
      }
    }

    if (reasonParts.length > 0) {
      if (doc.review_status === 'flagged') {
        alreadyFlagged++;
      } else {
        flagged++;
      }
      update.run(
        'flagged',
        `Created before required connector data was available: ${reasonParts.join('; ')}.`,
        agentId,
        doc.id,
      );
    } else {
      // All required connectors synced successfully before this KB entry was
      // written — leave as 'ok' and record the author so future audits can
      // trace it.
      skippedOk++;
      if (doc.created_by !== agentId) {
        db.prepare('UPDATE kb_docs SET created_by = ? WHERE id = ?').run(agentId, doc.id);
        cleared++;
      }
    }
  }

  console.log('[flag-pre-connector-kb] Summary:');
  console.log(`  Total KB docs scanned:       ${docs.length}`);
  console.log(`  Newly flagged pre-connector: ${flagged}`);
  console.log(`  Already flagged (no change): ${alreadyFlagged}`);
  console.log(`  Clean (connector was live):  ${skippedOk}`);
  console.log(`  created_by backfilled:       ${cleared}`);
  console.log(`  Unattributed (left alone):   ${unattributed}`);
}

main();
