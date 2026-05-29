/**
 * Read-only tool registry for the agent tool-loop.
 *
 * Every tool here is strictly READ-ONLY (`readOnly: true`). There are NO write
 * tools by construction — writes stay behind the executor + approval gate. The
 * tool-loop dispatches ONLY through this map and refuses any name not present,
 * so this file is the complete allowlist of what an in-loop agent can do.
 *
 * Each tool lazy-imports its dependencies inside `run()` so importing this
 * module is side-effect free (no DB connection at import time) — which lets the
 * loop unit-test against a fake registry without booting SQLite.
 */

export interface ToolContext {
  businessId: string;
  agentId?: string;
  runId?: string;
}

export type ToolResult =
  | { ok: true; observation: string }
  | { ok: false; error: string };

export interface Tool {
  name: string;
  /** One-line description shown to the model in the system prompt. */
  description: string;
  /** Human-readable args spec for the system prompt (e.g. "{ query: string, limit?: number }"). */
  args: string;
  /** Always true — this registry contains read-only tools only. */
  readOnly: true;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const MAX_TOOL_OUTPUT = 6000; // tools pre-truncate; the loop truncates again.

function clip(s: string, n = MAX_TOOL_OUTPUT): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const kbSearch: Tool = {
  name: 'kb_search',
  description: 'Search the business knowledge base (past investigations, decisions, company context) for relevant notes.',
  args: '{ query: string, limit?: number }',
  readOnly: true,
  async run(ctx, args): Promise<ToolResult> {
    const query = asString(args.query);
    if (!query) return { ok: false, error: 'kb_search requires a non-empty "query" string.' };
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 20) : 8;
    try {
      const { getKBForBusiness } = await import('../../kb/kb-config.js');
      const result = await getKBForBusiness(ctx.businessId);
      const engine = result?.engine;
      if (!engine) return { ok: true, observation: 'No knowledge base is configured for this business.' };
      const hits = await engine.search(query, limit) as Array<{ path: string; matches: { line: number; text: string }[] }>;
      if (!hits.length) return { ok: true, observation: `No KB documents matched "${query}".` };
      const rendered = hits.map(h =>
        `### ${h.path}\n${h.matches.map(m => `  L${m.line}: ${m.text}`).join('\n')}`
      ).join('\n\n');
      return { ok: true, observation: clip(rendered) };
    } catch (err) {
      return { ok: false, error: `kb_search failed: ${(err as Error).message}` };
    }
  },
};

const webSearch: Tool = {
  name: 'web_search',
  description: 'Search the public web for external facts, benchmarks, or documentation. Returns summarised, sanitised results.',
  args: '{ query: string, depth?: "basic" | "advanced" }',
  readOnly: true,
  async run(ctx, args): Promise<ToolResult> {
    const query = asString(args.query);
    if (!query) return { ok: false, error: 'web_search requires a non-empty "query" string.' };
    // Cap query length — defence against a model trying to smuggle large
    // (potentially sensitive) payloads out via the search query string.
    if (query.length > 400) return { ok: false, error: 'web_search query too long (max 400 chars).' };
    const depth = args.depth === 'advanced' ? 'advanced' : 'basic';
    try {
      const [{ agentSearch }, dbMod] = await Promise.all([
        import('./search.js'),
        import('../../db/db.js'),
      ]);
      const db = dbMod.default;
      const r = await agentSearch(query, { search_depth: depth }, ctx.businessId, db, { agentId: ctx.agentId, runId: ctx.runId });
      if (!r.available) return { ok: true, observation: `Web search unavailable: ${r.reason ?? 'no search connector configured'}.` };
      const top = (r.results ?? []).slice(0, 4).map(res =>
        `**${res.title}** (${res.url})\n${(res.content || res.description || '').slice(0, 300)}`
      ).join('\n\n');
      return { ok: true, observation: clip(`${r.answer ? `Summary: ${r.answer}\n\n` : ''}${top || 'No results.'}`) };
    } catch (err) {
      return { ok: false, error: `web_search failed: ${(err as Error).message}` };
    }
  },
};

const gscQuery: Tool = {
  name: 'gsc_query',
  description: 'Query Google Search Console: dataType "search_analytics" (queries/pages/CTR/position), "sites", "sitemaps", or "url_inspection".',
  args: '{ dataType: string, params?: object }',
  readOnly: true,
  async run(ctx, args): Promise<ToolResult> {
    const dataType = asString(args.dataType);
    if (!dataType) return { ok: false, error: 'gsc_query requires a "dataType" string.' };
    const params = (args.params && typeof args.params === 'object') ? args.params as Record<string, unknown> : {};
    try {
      const [{ loadConnectorByType }, gscMod] = await Promise.all([
        import('../../connectors/credentials.js'),
        import('../../connectors/gsc/index.js'),
      ]);
      const { credentials } = loadConnectorByType(ctx.businessId, 'gsc');
      const data = await gscMod.default.fetch(dataType, credentials as Record<string, string | undefined>, params);
      return { ok: true, observation: clip(JSON.stringify(data, null, 2)) };
    } catch (err) {
      return { ok: false, error: `gsc_query failed: ${(err as Error).message}` };
    }
  },
};

const ga4Query: Tool = {
  name: 'ga4_query',
  description: 'Query Google Analytics 4 for a traffic/engagement report (sessions, users, conversions, top pages, sources).',
  args: '{ params?: object }',
  readOnly: true,
  async run(ctx, args): Promise<ToolResult> {
    const params = (args.params && typeof args.params === 'object') ? args.params as Record<string, unknown> : {};
    try {
      const [{ loadConnectorByType }, ga4Mod] = await Promise.all([
        import('../../connectors/credentials.js'),
        import('../../connectors/ga4/index.js'),
      ]);
      const { credentials } = loadConnectorByType(ctx.businessId, 'ga4');
      const data = await ga4Mod.default.fetch('report', credentials as Record<string, string | undefined>, params);
      return { ok: true, observation: clip(JSON.stringify(data, null, 2)) };
    } catch (err) {
      return { ok: false, error: `ga4_query failed: ${(err as Error).message}` };
    }
  },
};

const readServerFile: Tool = {
  name: 'read_server_file',
  description: 'Read one text file from the connected server within the allowed root. Refuses files that look like secrets.',
  args: '{ path: string }',
  readOnly: true,
  async run(ctx, args): Promise<ToolResult> {
    const path = asString(args.path);
    if (!path) return { ok: false, error: 'read_server_file requires a "path" string.' };
    try {
      const [{ loadConnectorByType }, saMod] = await Promise.all([
        import('../../connectors/credentials.js'),
        import('../../connectors/server-access/index.js'),
      ]);
      const { credentials } = loadConnectorByType(ctx.businessId, 'server-access');
      const result = await saMod.default.readFile(credentials as Record<string, string | undefined>, path) as {
        content?: string; refused?: boolean; reason?: string;
      };
      // The connector refuses files containing secrets. Surface a redacted
      // notice — NEVER serialise the result object (it may carry matched
      // secret patterns) when refused.
      if (result?.refused) {
        return { ok: true, observation: `File "${path}" was refused by the server connector (reason: ${result.reason ?? 'blocked'}). Its contents are not available.` };
      }
      return { ok: true, observation: clip(`File: ${path}\n\n${result?.content ?? '(empty)'}`) };
    } catch (err) {
      return { ok: false, error: `read_server_file failed: ${(err as Error).message}` };
    }
  },
};

export const TOOL_REGISTRY: Record<string, Tool> = {
  kb_search: kbSearch,
  web_search: webSearch,
  gsc_query: gscQuery,
  ga4_query: ga4Query,
  read_server_file: readServerFile,
};

/** Render the tool list for the system prompt. */
export function describeTools(registry: Record<string, Tool> = TOOL_REGISTRY): string {
  return Object.values(registry)
    .map(t => `- ${t.name}${t.args ? ` ${t.args}` : ''} — ${t.description}`)
    .join('\n');
}
