/**
 * Agent Search Tool
 *
 * Unified search interface for agent runs. Abstracts over Tavily and Brave
 * Search — agents call agentSearch() without caring which provider is live.
 * Prefer Tavily (full page content). Fall back to Brave. Fail gracefully
 * if neither is connected.
 */

import crypto from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { decrypt } from '../../crypto.js';
import { sanitiseExternalContent, recordInjectionDetection } from '../../lib/content-sanitiser.js';

export interface SearchResult {
  title: string;
  url: string;
  content?: string;
  snippet?: string;
  score?: number;
  description?: string;
  _injection_detected?: boolean;
}

interface SearchOptions {
  search_depth?: string;
  max_results?: number;
  count?: number;
  freshness?: string;
  [key: string]: unknown;
}

interface SearchMeta {
  agentId?: string | null;
  runId?: string | null;
}

interface SearchResponse {
  available: boolean;
  reason?: string;
  query: string;
  answer?: string;
  results: SearchResult[];
  connector_type?: string;
}

interface ConnectorRow {
  id: string;
  type: string;
  business_id: string;
  credentials: string | null;
  status: string;
  [key: string]: unknown;
}

/**
 * Execute a web search using the best available search connector.
 */
export async function agentSearch(
  query: string,
  options: SearchOptions = {},
  businessId: string,
  db: Database,
  meta: SearchMeta = {}
): Promise<SearchResponse> {
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
  `).get(businessId) as ConnectorRow | null;

  if (!row) {
    return { available: false, reason: 'No search connector configured', query, results: [] };
  }

  let credentials: Record<string, unknown> = {};
  try {
    credentials = row.credentials ? JSON.parse(decrypt(row.credentials)) : {};
  } catch {
    return { available: false, reason: 'Could not decrypt search connector credentials', query, results: [] };
  }

  const { default: connector } = await import(`../../connectors/${row.type}/index.js`);
  const result: SearchResponse & { results: SearchResult[] } = await connector.search(query, options, credentials);

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

  return { connector_type: row.type, ...result, available: true };
}

/**
 * Extract content from a specific URL using Tavily.
 * Returns null if Tavily is not connected.
 */
export async function agentExtract(
  url: string,
  businessId: string,
  db: Database
): Promise<unknown> {
  const row = db.prepare(`
    SELECT * FROM connectors
    WHERE business_id = ? AND type = 'tavily' AND status = 'active'
    LIMIT 1
  `).get(businessId) as ConnectorRow | null;

  if (!row) return null;

  let credentials: Record<string, unknown> = {};
  try {
    credentials = row.credentials ? JSON.parse(decrypt(row.credentials)) : {};
  } catch {
    return null;
  }

  const { default: connector } = await import('../../connectors/tavily/index.js');
  return connector.extract(url, credentials as Record<string, string | undefined>);
}
