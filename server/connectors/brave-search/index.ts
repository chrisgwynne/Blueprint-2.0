/**
 * Brave Search connector.
 *
 * On-demand intelligence connector — agents call search() directly during
 * their runs. A lightweight scheduled sync stores weekly baseline results
 * so agents can read recent news/trends without spending quota every run.
 *
 * API: https://api.search.brave.com
 * Free tier: 2,000 queries/month
 */

import { safeFetch } from '../../lib/safe-fetch.js';

type Creds = Record<string, string | undefined>;

const BASE = 'https://api.search.brave.com/res/v1';

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  page_age?: string;
  extra_snippets?: string[];
}

interface BraveNewsResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  meta_url?: { netloc?: string };
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
  news?: { results?: BraveNewsResult[] };
}

function headers(apiKey: string): Record<string, string> {
  return {
    'X-Subscription-Token': apiKey,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
  };
}

const connector = {
  id: 'brave-search' as const,
  name: 'Brave Search',
  category: 'intelligence' as const,
  authType: 'apikey',
  icon: 'search',

  capabilities: {
    read: true,
    write: false,
    onDemand: true,
    pollingIntervalMinutes: 10080, // weekly baseline sync
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'Brave Search API Key',
      type: 'password',
      required: true,
      hint: 'Get from https://api.search.brave.com — free tier includes 2,000 queries/month.',
    },
    {
      id: 'country',
      label: 'Country',
      type: 'text',
      required: false,
      hint: 'Country code for results (e.g. GB, US). Defaults to GB.',
    },
  ],

  signalTypes: [] as string[],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
    try {
      const res = await safeFetch(
        `${BASE}/web/search?q=test&count=1`,
        { headers: headers(credentials.apiKey) },
        'connector:brave-search:healthCheck'
      );
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `Brave API returned ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = await res.json() as BraveSearchResponse;
      return { ok: true, details: { results_found: data.web?.results?.length ?? 0 } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  /**
   * Search the web. Called on-demand by agents via agentSearch().
   */
  async search(query: string, options: Record<string, unknown> = {}, credentials?: Creds): Promise<unknown> {
    const {
      count = 10,
      country = credentials?.country || 'GB',
      search_lang = 'en',
      freshness = null,
      result_filter = 'web',
    } = options as {
      count?: number;
      country?: string;
      search_lang?: string;
      freshness?: string | null;
      result_filter?: string;
    };

    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),
      country: country as string,
      search_lang: search_lang as string,
      result_filter: result_filter as string,
    });
    if (freshness) params.set('freshness', freshness as string);

    const res = await safeFetch(`${BASE}/web/search?${params}`, {
      headers: headers(credentials!.apiKey!),
    }, 'connector:brave-search:search');
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brave search failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as BraveSearchResponse;
    return {
      query,
      results: (data.web?.results ?? []).map((r: BraveWebResult) => ({
        title: r.title,
        url: r.url,
        description: r.description,
        published: r.page_age,
        extra_snippets: r.extra_snippets ?? [],
      })),
      news: (data.news?.results ?? []).map((r: BraveNewsResult) => ({
        title: r.title,
        url: r.url,
        description: r.description,
        published: r.age,
        source: r.meta_url?.netloc,
      })),
    };
  },

  /** Convenience wrapper: search with result_filter='news' and freshness='pw'. */
  async searchNews(query: string, options: Record<string, unknown> = {}, credentials?: Creds): Promise<unknown> {
    return this.search(query, {
      ...options,
      result_filter: 'news',
      freshness: (options['freshness'] as string | undefined) ?? 'pw',
    }, credentials);
  },

  /**
   * Weekly scheduled fetch — stores baseline search results so agents can
   * read recent news without spending quota on every scheduled run.
   */
  async fetch(_dataType: string, credentials: Creds, config?: Record<string, unknown>): Promise<unknown> {
    const keyword = (config?.['keyword'] as string | undefined) || 'ecommerce business trends';
    const country = (config?.['country'] as string | undefined) || credentials?.country || 'GB';

    const [industry, news] = await Promise.allSettled([
      this.search(`${keyword} 2025 trends`, { count: 5, country }, credentials),
      this.searchNews(keyword, { count: 5, country }, credentials),
    ]);

    return {
      industry_trends: industry.status === 'fulfilled' ? industry.value : null,
      recent_news: news.status === 'fulfilled' ? news.value : null,
      keyword,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as {
      industry_trends?: { results?: unknown[] };
      recent_news?: { news?: unknown[] };
    } | null | undefined;

    if (d?.industry_trends?.results?.length) {
      metrics.push({
        name: 'brave.industry_trends_data',
        value: d.industry_trends.results.length,
        data: d.industry_trends.results.slice(0, 5),
      });
    }
    if (d?.recent_news?.news?.length) {
      metrics.push({
        name: 'brave.recent_news_data',
        value: d.recent_news.news.length,
        data: d.recent_news.news.slice(0, 5),
      });
    }
    return metrics;
  },

  async getAuthUrl(_state?: string): Promise<string> { throw new Error('Brave Search uses API key auth, not OAuth.'); },
  async exchangeCode(_code?: string): Promise<never> { throw new Error('Brave Search uses API key auth, not OAuth.'); },
  async refreshToken(_credentials?: Creds): Promise<never> { throw new Error('Brave Search uses API key auth, not OAuth.'); },
};

export default connector;
