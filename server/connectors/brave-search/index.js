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

const BASE = 'https://api.search.brave.com/res/v1';

function headers(apiKey) {
  return {
    'X-Subscription-Token': apiKey,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
  };
}

const connector = {
  id: 'brave-search',
  name: 'Brave Search',
  category: 'intelligence',
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

  signalTypes: [],

  async healthCheck(credentials) {
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
      const data = await res.json();
      return { ok: true, details: { results_found: data.web?.results?.length ?? 0 } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Search the web. Called on-demand by agents via agentSearch().
   *
   * @param {string} query
   * @param {object} options
   * @param {object} credentials
   */
  async search(query, options = {}, credentials) {
    const {
      count = 10,
      country = credentials?.country || 'GB',
      search_lang = 'en',
      freshness = null,
      result_filter = 'web',
    } = options;

    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),
      country,
      search_lang,
      result_filter,
    });
    if (freshness) params.set('freshness', freshness);

    const res = await safeFetch(`${BASE}/web/search?${params}`, {
      headers: headers(credentials.apiKey),
    }, 'connector:brave-search:search');
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brave search failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    return {
      query,
      results: (data.web?.results ?? []).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description,
        published: r.page_age,
        extra_snippets: r.extra_snippets ?? [],
      })),
      news: (data.news?.results ?? []).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description,
        published: r.age,
        source: r.meta_url?.netloc,
      })),
    };
  },

  /** Convenience wrapper: search with result_filter='news' and freshness='pw'. */
  async searchNews(query, options = {}, credentials) {
    return this.search(query, {
      ...options,
      result_filter: 'news',
      freshness: options.freshness ?? 'pw',
    }, credentials);
  },

  /**
   * Weekly scheduled fetch — stores baseline search results so agents can
   * read recent news without spending quota on every scheduled run.
   */
  async fetch(_dataType, credentials, config) {
    const keyword = config?.keyword || 'ecommerce business trends';
    const country = config?.country || credentials?.country || 'GB';

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

  extractMetrics(data) {
    const metrics = [];
    if (data.industry_trends?.results?.length) {
      metrics.push({
        name: 'brave.industry_trends_data',
        value: data.industry_trends.results.length,
        data: data.industry_trends.results.slice(0, 5),
      });
    }
    if (data.recent_news?.news?.length) {
      metrics.push({
        name: 'brave.recent_news_data',
        value: data.recent_news.news.length,
        data: data.recent_news.news.slice(0, 5),
      });
    }
    return metrics;
  },

  async getAuthUrl() { throw new Error('Brave Search uses API key auth, not OAuth.'); },
  async exchangeCode() { throw new Error('Brave Search uses API key auth, not OAuth.'); },
  async refreshToken() { throw new Error('Brave Search uses API key auth, not OAuth.'); },
};

export default connector;
