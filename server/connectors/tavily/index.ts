/**
 * Tavily connector.
 *
 * Purpose-built AI search: returns extracted page content, not just URLs.
 * On-demand intelligence connector — agents call search() during their runs.
 *
 * API: https://docs.tavily.com
 * Free tier: 1,000 searches/month
 */

import { safeFetch } from '../../lib/safe-fetch.js';

type Creds = Record<string, string | undefined>;

const BASE = 'https://api.tavily.com';

interface TavilySearchOptions {
  search_depth?: string;
  max_results?: number;
  include_raw_content?: boolean;
  include_images?: boolean;
  include_answer?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

interface TavilySearchResponse {
  answer?: string;
  results?: TavilyResult[];
}

interface TavilyExtractResponse {
  results?: unknown[];
}

const connector = {
  id: 'tavily' as const,
  name: 'Tavily',
  category: 'intelligence' as const,
  authType: 'apikey' as const,
  icon: 'search',

  capabilities: {
    read: true,
    write: false,
    onDemand: true,
    pollingIntervalMinutes: null as null, // no scheduled sync — pure on-demand
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'Tavily API Key',
      type: 'password' as const,
      required: true,
      hint: 'Get from https://tavily.com — free tier includes 1,000 searches/month. Purpose-built for AI agents.',
    },
  ],

  signalTypes: [] as string[],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
    try {
      const res = await safeFetch(`${BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: credentials.apiKey,
          query: 'test',
          max_results: 1,
          search_depth: 'basic',
          include_answer: false,
        }),
      }, 'connector:tavily:healthCheck');
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `Tavily returned ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = await res.json() as TavilySearchResponse;
      return { ok: true, details: { results_found: data.results?.length ?? 0 } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  /**
   * Search the web with AI-extracted page content.
   * Preferred over Brave when full page content is needed.
   *
   * search_depth='advanced' extracts more content but costs ~5× more API credits.
   */
  async search(query: string, options: TavilySearchOptions = {}, credentials: Creds): Promise<unknown> {
    const {
      search_depth = 'basic',
      max_results = 5,
      include_raw_content = false,
      include_images = false,
      include_answer = true,
      include_domains = [],
      exclude_domains = [],
    } = options;

    const res = await safeFetch(`${BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: credentials.apiKey,
        query,
        search_depth,
        max_results,
        include_raw_content,
        include_images,
        include_answer,
        include_domains,
        exclude_domains,
      }),
    }, 'connector:tavily:search');
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tavily search failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as TavilySearchResponse;
    return {
      query,
      answer: data.answer ?? null,
      results: (data.results ?? []).map(r => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        published: r.published_date,
      })),
    };
  },

  /**
   * Extract content from a specific URL.
   * Only available in Tavily — Brave does not support URL extraction.
   */
  async extract(url: string, credentials: Creds): Promise<unknown> {
    const res = await safeFetch(`${BASE}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: credentials.apiKey,
        urls: [url],
      }),
    }, 'connector:tavily:extract');
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tavily extract failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json() as TavilyExtractResponse;
    return data.results?.[0] ?? null;
  },

  // Tavily is pure on-demand — no scheduled fetch/extractMetrics
  async fetch(_dataType?: string, _credentials?: Creds, _params?: Record<string, unknown>): Promise<unknown> {
    return { fetchedAt: new Date().toISOString() };
  },
  extractMetrics(_data?: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> { return []; },

  async getAuthUrl(_state?: string): Promise<string> { throw new Error('Tavily uses API key auth, not OAuth.'); },
  async exchangeCode(_code?: string): Promise<never> { throw new Error('Tavily uses API key auth, not OAuth.'); },
  async refreshToken(_credentials?: Creds): Promise<never> { throw new Error('Tavily uses API key auth, not OAuth.'); },
};

export default connector;
