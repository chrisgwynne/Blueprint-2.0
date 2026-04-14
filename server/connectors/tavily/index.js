/**
 * Tavily connector.
 *
 * Purpose-built AI search: returns extracted page content, not just URLs.
 * On-demand intelligence connector — agents call search() during their runs.
 *
 * API: https://docs.tavily.com
 * Free tier: 1,000 searches/month
 */

const BASE = 'https://api.tavily.com';

const connector = {
  id: 'tavily',
  name: 'Tavily',
  category: 'intelligence',
  authType: 'apikey',
  icon: 'search',

  capabilities: {
    read: true,
    write: false,
    onDemand: true,
    pollingIntervalMinutes: null, // no scheduled sync — pure on-demand
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'Tavily API Key',
      type: 'password',
      required: true,
      hint: 'Get from https://tavily.com — free tier includes 1,000 searches/month. Purpose-built for AI agents.',
    },
  ],

  signalTypes: [],

  async healthCheck(credentials) {
    if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
    try {
      const res = await fetch(`${BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: credentials.apiKey,
          query: 'test',
          max_results: 1,
          search_depth: 'basic',
          include_answer: false,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `Tavily returned ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = await res.json();
      return { ok: true, details: { results_found: data.results?.length ?? 0 } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Search the web with AI-extracted page content.
   * Preferred over Brave when full page content is needed.
   *
   * search_depth='advanced' extracts more content but costs ~5× more API credits.
   */
  async search(query, options = {}, credentials) {
    const {
      search_depth = 'basic',
      max_results = 5,
      include_raw_content = false,
      include_images = false,
      include_answer = true,
      include_domains = [],
      exclude_domains = [],
    } = options;

    const res = await fetch(`${BASE}/search`, {
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
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tavily search failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json();
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
  async extract(url, credentials) {
    const res = await fetch(`${BASE}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: credentials.apiKey,
        urls: [url],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tavily extract failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.results?.[0] ?? null;
  },

  // Tavily is pure on-demand — no scheduled fetch/extractMetrics
  async fetch() {
    return { fetchedAt: new Date().toISOString() };
  },
  extractMetrics() { return []; },

  async getAuthUrl() { throw new Error('Tavily uses API key auth, not OAuth.'); },
  async exchangeCode() { throw new Error('Tavily uses API key auth, not OAuth.'); },
  async refreshToken() { throw new Error('Tavily uses API key auth, not OAuth.'); },
};

export default connector;
