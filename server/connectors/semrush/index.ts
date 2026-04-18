/**
 * SEMrush connector — apikey auth.
 *
 * Docs:  https://www.semrush.com/api-documentation/
 * Base:  https://api.semrush.com/
 *
 * Unlike GSC (what's already ranking) SEMrush tells us what *could* rank,
 * what competitors rank for that we don't, and where we sit in the broader
 * keyword landscape. Turns SEO Sentinel from reactive to proactive.
 *
 * Response format: CSV (semi-colon delimited). We parse it into objects.
 * SEMrush costs API units per call — polling interval kept conservative.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

type Creds = Record<string, string | undefined>;

const BASE = 'https://api.semrush.com/';

// Column code → friendly field name. See SEMrush docs for full list.
const COLS: Record<string, string> = {
  // domain_rank
  Dn: 'domain', Rk: 'rank', Or: 'organic_keywords', Ot: 'organic_traffic',
  Oc: 'organic_cost', Ad: 'paid_keywords', At: 'paid_traffic', Ac: 'paid_cost',
  Np: 'shared_keywords',
  // domain_organic
  Ph: 'keyword', Po: 'position', Pp: 'previous_position', Pd: 'position_difference',
  Nq: 'search_volume', Cp: 'cpc', Ur: 'url', Tr: 'traffic', Tc: 'traffic_cost',
  Co: 'competition', Nr: 'results_count', Td: 'trends',
};

function parseCSV(text: string, columns?: string): { rows: Array<Record<string, string | number>>; error: string | null } {
  if (!text || text.startsWith('ERROR')) return { rows: [], error: text?.trim() || null };
  const lines = String(text).trim().split('\n');
  if (lines.length === 0) return { rows: [], error: null };
  const header = lines[0]!.split(';');
  const fieldNames = columns
    ? columns.split(',').map((c) => COLS[c] ?? c)
    : header.map((h) => COLS[h] ?? h);
  const rows: Array<Record<string, string | number>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = (lines[i] ?? '').split(';');
    if (cols.length === 1 && !cols[0]) continue;
    const row: Record<string, string | number> = {};
    fieldNames.forEach((name, idx) => {
      const raw = cols[idx] ?? '';
      const asNum = Number(raw);
      row[name] = Number.isFinite(asNum) && raw !== '' ? asNum : raw;
    });
    rows.push(row);
  }
  return { rows, error: null };
}

async function semrushFetch(params: Record<string, string>, apiKey: string, label: string): Promise<string> {
  const qs = new URLSearchParams({ key: apiKey, ...params }).toString();
  const res = await withRetry(
    () => checkedFetch(`${BASE}?${qs}`),
    { label: `SEMrush ${label}` }
  );
  return res.text();
}

const connector = {
  id: 'semrush' as const,
  name: 'SEMrush',
  category: 'seo' as const,
  authType: 'apikey',
  icon: 'trending-up',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 1440, // daily — SEMrush data is not hourly-fresh
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      hint: 'SEMrush → Profile → Subscription info → API.',
    },
    {
      id: 'domain',
      label: 'Target Domain',
      type: 'text',
      required: true,
      placeholder: 'example.com',
      hint: 'Enter domain without protocol, e.g. localmarkers.co.uk',
    },
    {
      id: 'database',
      label: 'Regional Database',
      type: 'select',
      required: true,
      default: 'uk',
      options: [
        { value: 'uk', label: 'United Kingdom' },
        { value: 'us', label: 'United States' },
        { value: 'ie', label: 'Ireland' },
        { value: 'au', label: 'Australia' },
        { value: 'ca', label: 'Canada' },
      ],
    },
  ],

  signalTypes: [
    'semrush_rankings_drop',
    'semrush_traffic_value_drop',
    'semrush_competitor_surge',
    'semrush_keyword_opportunity',
    'semrush_backlink_growth',
    'semrush_traffic_milestone',
  ],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      if (!credentials?.domain) return { ok: false, error: 'Domain is required.' };
      const database = credentials.database || 'uk';
      const text = await semrushFetch({
        type: 'domain_rank',
        domain: credentials.domain,
        database,
        export_columns: 'Dn,Rk,Or,Ot',
      }, credentials.apiKey, 'healthCheck');

      if (text.startsWith('ERROR')) {
        return { ok: false, error: text.trim() };
      }
      const { rows } = parseCSV(text, 'Dn,Rk,Or,Ot');
      return {
        ok: true,
        details: {
          domain: credentials.domain,
          database,
          organic_keywords: rows[0]?.organic_keywords ?? null,
          organic_traffic: rows[0]?.organic_traffic ?? null,
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(_dataType: string, credentials: Creds, _params?: Record<string, unknown>): Promise<unknown> {
    if (!credentials?.apiKey) throw new Error('SEMrush API key is required.');
    if (!credentials?.domain) throw new Error('SEMrush domain is required.');
    const { apiKey, domain } = credentials;
    const database = credentials.database || 'uk';

    // Run all calls in parallel — each costs SEMrush API units, but they run
    // at most once a day per pollingIntervalMinutes.
    const results = await Promise.allSettled([
      semrushFetch({
        type: 'domain_rank', domain: domain!, database: database!,
        export_columns: 'Dn,Rk,Or,Ot,Oc,Ad,At,Ac',
      }, apiKey!, 'domain_rank'),
      semrushFetch({
        type: 'domain_organic', domain: domain!, database: database!,
        display_limit: '100', display_sort: 'tr_desc',
        export_columns: 'Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr,Tc,Co,Nr,Td',
      }, apiKey!, 'domain_organic'),
      semrushFetch({
        type: 'domain_organic_organic', domain: domain!, database: database!,
        display_limit: '5',
        export_columns: 'Dn,Np,Or,Ot,Oc,Ad',
      }, apiKey!, 'competitors'),
      semrushFetch({
        type: 'backlinks_overview', target: domain!, target_type: 'root_domain',
      }, apiKey!, 'backlinks'),
    ]);

    const [overviewRes, organicRes, competitorsRes, backlinksRes] = results;

    const overview = overviewRes.status === 'fulfilled'
      ? parseCSV(overviewRes.value, 'Dn,Rk,Or,Ot,Oc,Ad,At,Ac').rows[0] ?? null
      : null;
    const keywords = organicRes.status === 'fulfilled'
      ? parseCSV(organicRes.value, 'Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr,Tc,Co,Nr,Td').rows
      : [];
    const competitors = competitorsRes.status === 'fulfilled'
      ? parseCSV(competitorsRes.value, 'Dn,Np,Or,Ot,Oc,Ad').rows
      : [];
    const backlinks = backlinksRes.status === 'fulfilled'
      ? parseCSV(backlinksRes.value).rows[0] ?? null
      : null;

    return {
      overview,
      keywords,
      competitors,
      backlinks,
      database,
      domain,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as {
      overview?: Record<string, string | number>;
      keywords?: Array<Record<string, string | number>>;
      competitors?: Array<Record<string, string | number>>;
      backlinks?: Record<string, string | number>;
    };
    const overview = d?.overview ?? {};
    const keywords = Array.isArray(d?.keywords) ? d.keywords : [];
    const competitors = Array.isArray(d?.competitors) ? d.competitors : [];
    const backlinks = d?.backlinks ?? {};

    const domainRank       = Number(overview.rank ?? 0) || 0;
    const organicKeywords  = Number(overview.organic_keywords ?? 0) || 0;
    const organicTraffic   = Number(overview.organic_traffic ?? 0) || 0;
    const organicCost      = Number(overview.organic_cost ?? 0) || 0;

    const top3  = keywords.filter((k) => Number(k.position) <= 3).length;
    const top10 = keywords.filter((k) => Number(k.position) <= 10).length;
    const top20 = keywords.filter((k) => Number(k.position) > 10 && Number(k.position) <= 20).length;
    const gained = keywords.filter((k) => Number(k.position_difference) < 0).length;
    const lost   = keywords.filter((k) => Number(k.position_difference) > 0).length;

    // Page-2 opportunities: positions 11–20 with meaningful search volume.
    const opportunities = keywords
      .filter((k) => {
        const pos = Number(k.position);
        const vol = Number(k.search_volume);
        return pos >= 11 && pos <= 20 && vol >= 100;
      })
      .sort((a, b) => Number(b.search_volume) - Number(a.search_volume))
      .slice(0, 25);

    // Backlink fields in SEMrush response use snake_case column names.
    const backlinksTotal = Number(backlinks.backlinks ?? backlinks.total_backlinks ?? 0) || 0;
    const referringDomains = Number(backlinks.domains ?? backlinks.referring_domains ?? 0) || 0;

    // Competitor overlap average (Np = shared keywords count)
    const overlapAvg = competitors.length > 0
      ? Math.round(competitors.reduce((s, c) => s + (Number(c.shared_keywords) || 0), 0) / competitors.length)
      : 0;

    metrics.push(
      { name: 'semrush.domain_rank',                 value: domainRank, data: null },
      { name: 'semrush.organic_keywords_total',      value: organicKeywords, data: null },
      { name: 'semrush.organic_traffic_estimate',    value: organicTraffic, data: null },
      { name: 'semrush.organic_cost_estimate',       value: Math.round(organicCost * 100) / 100, data: null },
      { name: 'semrush.keywords_top3',               value: top3, data: null },
      { name: 'semrush.keywords_top10',              value: top10, data: null },
      { name: 'semrush.keywords_top20',              value: top20, data: null },
      { name: 'semrush.keywords_positions_gained_7d', value: gained, data: null },
      { name: 'semrush.keywords_positions_lost_7d',   value: lost, data: null },
      { name: 'semrush.backlinks_total',             value: backlinksTotal, data: null },
      { name: 'semrush.referring_domains',           value: referringDomains, data: null },
      { name: 'semrush.top_competitors_overlap',     value: overlapAvg, data: null },
    );

    // Rich data
    metrics.push(
      { name: 'semrush.top_keywords_data',  value: keywords.length, data: keywords.slice(0, 100) },
      { name: 'semrush.opportunities_data', value: opportunities.length, data: opportunities },
      { name: 'semrush.competitors_data',   value: competitors.length, data: competitors },
      { name: 'semrush.winners_losers_data', value: keywords.filter((k) => Number(k.position_difference) !== 0).length,
        data: [...keywords].sort((a, b) => Number(b.position_difference) - Number(a.position_difference)).slice(0, 25) },
    );

    return metrics;
  },

  async getAuthUrl(_state?: string): Promise<string> { throw new Error('SEMrush uses API key authentication, not OAuth.'); },
  async exchangeCode(_code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> { throw new Error('SEMrush uses API key authentication, not OAuth.'); },
  async refreshToken(_credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> { throw new Error('SEMrush uses API key authentication, not OAuth.'); },
};

export default connector;
