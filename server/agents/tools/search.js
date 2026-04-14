/**
 * Agent Search Tool
 *
 * Unified search interface for agent runs. Abstracts over Tavily and Brave
 * Search — agents call agentSearch() without caring which provider is live.
 * Prefer Tavily (full page content). Fall back to Brave. Fail gracefully
 * if neither is connected.
 */

import crypto from 'node:crypto';
import { decrypt } from '../../crypto.js';
import { sanitiseExternalContent, recordInjectionDetection } from '../../lib/content-sanitiser.js';

/**
 * Execute a web search using the best available search connector.
 *
 * @param {string} query
 * @param {object} options - search_depth, max_results/count, freshness, etc.
 * @param {string} businessId
 * @param {import('bun:sqlite').Database} db
 * @param {object} [meta] - optional { agentId, runId } for usage logging
 * @returns {Promise<{ available: boolean, reason?: string, query: string, answer?: string, results: Array }>}
 */
export async function agentSearch(query, options = {}, businessId, db, meta = {}) {
  const row = db.prepare(`
    SELECT * FROM connectors
    WHERE business_id = ?
      AND type IN ('tavily', 'brave-search')
      AND status = 'active'
    ORDER BY
      CASE type
        WHEN 'tavily'       THEN 1
        WHEN 'brave-search' THEN 2
      END
    LIMIT 1
  `).get(businessId);

  if (!row) {
    return { available: false, reason: 'No search connector configured', query, results: [] };
  }

  let credentials = {};
  try {
    credentials = row.credentials ? JSON.parse(decrypt(row.credentials)) : {};
  } catch {
    return { available: false, reason: 'Could not decrypt search connector credentials', query, results: [] };
  }

  const { default: connector } = await import(`../../connectors/${row.type}/index.js`);
  const result = await connector.search(query, options, credentials);

  // Sanitise external content before it flows into any agent prompt.
  // Search results are the highest-risk ingestion point in Blueprint — a
  // malicious page can embed prompt-injection payloads that, if not filtered,
  // could steer the downstream LLM run.
  if (result && Array.isArray(result.results)) {
    for (const r of result.results) {
      if (r.content) {
        const sanitised = sanitiseExternalContent(r.content, r.url ?? 'search_result');
        r.content = sanitised.content;
        if (sanitised.injection_detected) {
          r._injection_detected = true;
          recordInjectionDetection(db, {
            businessId,
            source: r.url ?? `search:${row.type}`,
            patternsFound: sanitised.patterns_found,
            patternNames: sanitised.pattern_names,
            connectorId: row.id,
            agentId: meta.agentId ?? null,
          });
        }
      }
      if (r.description) {
        const sDesc = sanitiseExternalContent(r.description, r.url ?? 'search_result_description');
        r.description = sDesc.content;
        if (sDesc.injection_detected) r._injection_detected = true;
      }
    }
  }
  if (result && typeof result.answer === 'string' && result.answer.length > 0) {
    const sAnswer = sanitiseExternalContent(result.answer, `search:${row.type}:answer`);
    result.answer = sAnswer.content;
  }

  // Log usage
  try {
    db.prepare(`
      INSERT INTO search_log
        (id, business_id, connector_id, query, results_count, search_depth, agent_id, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      crypto.randomUUID(),
      businessId,
      row.id,
      query,
      result.results?.length ?? 0,
      options.search_depth ?? 'basic',
      meta.agentId ?? null,
      meta.runId ?? null,
    );
  } catch {}

  return { available: true, connector_type: row.type, ...result };
}

/**
 * Extract content from a specific URL using Tavily.
 * Returns null if Tavily is not connected.
 *
 * @param {string} url
 * @param {string} businessId
 * @param {import('bun:sqlite').Database} db
 */
export async function agentExtract(url, businessId, db) {
  const row = db.prepare(`
    SELECT * FROM connectors
    WHERE business_id = ? AND type = 'tavily' AND status = 'active'
    LIMIT 1
  `).get(businessId);

  if (!row) return null;

  let credentials = {};
  try {
    credentials = row.credentials ? JSON.parse(decrypt(row.credentials)) : {};
  } catch {
    return null;
  }

  const { default: connector } = await import('../../connectors/tavily/index.js');
  return connector.extract(url, credentials);
}
