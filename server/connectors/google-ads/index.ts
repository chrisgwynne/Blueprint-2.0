/**
 * Google Ads connector — OAuth2 + GAQL.
 *
 * Docs: https://developers.google.com/google-ads/api/docs/start
 *       https://developers.google.com/google-ads/api/docs/query/overview
 *
 * Auth flow uses the same Google OAuth, with scope `https://www.googleapis.com/auth/adwords`.
 * Requires a developer token from Google Ads (free, apply at ads.google.com manager accounts).
 *
 * NOTE: cost_micros is in micros — divide by 1,000,000 to get currency value.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

type Creds = Record<string, string | undefined>;

const API_VERSION = 'v17';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/adwords';

async function ensureFreshToken(credentials: Creds): Promise<Creds> {
  if (!credentials.expiresAt || Date.now() + 60_000 < Number(credentials.expiresAt)) {
    return credentials;
  }
  if (!credentials.refreshToken) {
    throw new Error('Google Ads token expired and no refresh token available. Re-authorise the connector.');
  }
  const res = await checkedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    }),
  });
  const tokens = await res.json() as { access_token: string; expires_in?: number };
  return {
    ...credentials,
    accessToken: tokens.access_token,
    expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
}

function buildHeaders(credentials: Creds, customerId: string, managerAccountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    'Content-Type': 'application/json',
  };
  if (managerAccountId) {
    headers['login-customer-id'] = String(managerAccountId).replace(/-/g, '');
  }
  return headers;
}

async function gaqlQuery(query: string, credentials: Creds, customerId: string, managerAccountId?: string): Promise<Record<string, unknown>> {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${cleanCustomerId}/googleAds:search`;
  const res = await withRetry(
    () => checkedFetch(url, {
      method: 'POST',
      headers: buildHeaders(credentials, cleanCustomerId, managerAccountId),
      body: JSON.stringify({ query }),
    }),
    { label: 'Google Ads GAQL' }
  );
  return res.json() as Promise<Record<string, unknown>>;
}

const connector = {
  id: 'google-ads' as const,
  name: 'Google Ads',
  category: 'advertising',
  authType: 'oauth2',
  icon: 'trending-up',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    { id: 'customerId',       label: 'Customer ID',        type: 'text', required: true,
      hint: 'Numbers only, no dashes. Top-right corner in Google Ads.' },
    { id: 'managerAccountId', label: 'Manager Account ID', type: 'text', required: false,
      hint: 'Only if accessing via an MCC account.' },
  ],

  signalTypes: [
    'google_ads_roas_drop', 'google_ads_spend_spike', 'google_ads_cpa_increase',
    'google_ads_impression_share_drop', 'google_ads_low_quality_scores',
  ],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.accessToken) return { ok: false, error: 'Access token missing.' };
      if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
        return { ok: false, error: 'GOOGLE_ADS_DEVELOPER_TOKEN env var not set.' };
      }
      const customerId = credentials.customerId;
      if (!customerId) return { ok: false, error: 'customerId not configured.' };

      const fresh = await ensureFreshToken(credentials);
      const data = await gaqlQuery(
        `SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1`,
        fresh,
        customerId,
        credentials.managerAccountId
      );
      const results = data.results as Array<Record<string, unknown>> | undefined;
      const row = results?.[0] as Record<string, Record<string, unknown>> | undefined;
      return {
        ok: true,
        details: {
          customer_id: row?.customer?.id,
          name: row?.customer?.descriptiveName,
          currency: row?.customer?.currencyCode,
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(_dataType: string, credentials: Creds, params?: Record<string, unknown>): Promise<unknown> {
    if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN env var is not set.');
    }
    const customerId = (params?.customerId as string | undefined) || credentials?.customerId;
    if (!customerId) throw new Error('Google Ads customerId is required.');

    const fresh = await ensureFreshToken(credentials);
    const managerAccountId = (params?.managerAccountId as string | undefined) || credentials?.managerAccountId;

    // Previous comparison window: the 30 days immediately before the
    // LAST_30_DAYS window used for the current totals.
    const isoDay = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const prevStart = isoDay(60);
    const prevEnd = isoDay(31);

    const logSwallow = (label: string) => (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[google-ads] ${label} query failed for customer ${customerId}: ${message.substring(0, 300)}`);
      return { results: [] };
    };

    // Run all GAQL queries in parallel
    const [accountTotals, accountTotalsPrev, campaigns, keywords] = await Promise.all([
      gaqlQuery(
        `SELECT
           metrics.clicks, metrics.impressions, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value,
           metrics.average_cpc, metrics.ctr, metrics.search_impression_share
         FROM customer
         WHERE segments.date DURING LAST_30_DAYS`,
        fresh, customerId, managerAccountId
      ).catch(logSwallow('account totals')),
      gaqlQuery(
        `SELECT
           metrics.clicks, metrics.impressions, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value,
           metrics.average_cpc, metrics.ctr
         FROM customer
         WHERE segments.date BETWEEN '${prevStart}' AND '${prevEnd}'`,
        fresh, customerId, managerAccountId
      ).catch(logSwallow('previous-period totals')),
      gaqlQuery(
        `SELECT
           campaign.id, campaign.name, campaign.status,
           campaign.advertising_channel_type,
           metrics.clicks, metrics.impressions, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value,
           metrics.ctr, metrics.average_cpc,
           metrics.search_impression_share
         FROM campaign
         WHERE segments.date DURING LAST_30_DAYS
           AND campaign.status = 'ENABLED'
         ORDER BY metrics.cost_micros DESC
         LIMIT 20`,
        fresh, customerId, managerAccountId
      ).catch(logSwallow('campaigns')),
      gaqlQuery(
        `SELECT
           ad_group_criterion.keyword.text,
           ad_group_criterion.quality_info.quality_score,
           metrics.clicks, metrics.impressions, metrics.cost_micros
         FROM keyword_view
         WHERE segments.date DURING LAST_30_DAYS
           AND ad_group_criterion.status = 'ENABLED'
         ORDER BY metrics.cost_micros DESC
         LIMIT 50`,
        fresh, customerId, managerAccountId
      ).catch(logSwallow('keywords')),
    ]);

    function aggregateMetrics(results: Record<string, unknown>): Record<string, number> {
      let clicks = 0, impressions = 0, costMicros = 0, conversions = 0, value = 0;
      let ctrSum = 0, cpcSum = 0, isSum = 0, count = 0;
      for (const row of (results.results as Array<Record<string, Record<string, unknown>>> ?? [])) {
        const m = row.metrics ?? {};
        clicks += parseInt(String(m.clicks ?? 0), 10);
        impressions += parseInt(String(m.impressions ?? 0), 10);
        costMicros += parseInt(String(m.costMicros ?? 0), 10);
        conversions += parseFloat(String(m.conversions ?? 0));
        value += parseFloat(String(m.conversionsValue ?? 0));
        ctrSum += parseFloat(String(m.ctr ?? 0));
        cpcSum += parseFloat(String(m.averageCpc ?? 0));
        isSum += parseFloat(String(m.searchImpressionShare ?? 0));
        count++;
      }
      const cost = costMicros / 1_000_000;
      return {
        clicks,
        impressions,
        cost,
        conversions,
        conversion_value: value,
        avg_cpc: count > 0 ? cpcSum / count / 1_000_000 : 0,
        avg_ctr: count > 0 ? ctrSum / count : 0,
        impression_share: count > 0 ? isSum / count : 0,
        roas: cost > 0 ? value / cost : 0,
        cpa: conversions > 0 ? cost / conversions : 0,
      };
    }

    const totals = aggregateMetrics(accountTotals);
    const totalsPrev = aggregateMetrics(accountTotalsPrev);

    const campaignsList = ((campaigns.results as Array<Record<string, Record<string, unknown>>> ?? [])).map(row => {
      const m = row.metrics ?? {};
      const c = row.campaign ?? {};
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        channel: c.advertisingChannelType,
        clicks: parseInt(String(m.clicks ?? 0), 10),
        impressions: parseInt(String(m.impressions ?? 0), 10),
        cost: parseInt(String(m.costMicros ?? 0), 10) / 1_000_000,
        conversions: parseFloat(String(m.conversions ?? 0)),
        conversion_value: parseFloat(String(m.conversionsValue ?? 0)),
        ctr: parseFloat(String(m.ctr ?? 0)),
        avg_cpc: parseFloat(String(m.averageCpc ?? 0)) / 1_000_000,
        impression_share: parseFloat(String(m.searchImpressionShare ?? 0)),
      };
    });

    const keywordsList = ((keywords.results as Array<Record<string, unknown>> ?? [])).map(row => {
      const m = (row.metrics ?? {}) as Record<string, unknown>;
      const c = (row.adGroupCriterion ?? {}) as Record<string, unknown>;
      const keyword = c.keyword as Record<string, unknown> | undefined;
      const qualityInfo = c.qualityInfo as Record<string, unknown> | undefined;
      return {
        text: keyword?.text,
        quality_score: qualityInfo?.qualityScore ?? null,
        clicks: parseInt(String(m.clicks ?? 0), 10),
        impressions: parseInt(String(m.impressions ?? 0), 10),
        cost_micros: parseInt(String(m.costMicros ?? 0), 10),
      };
    });

    return {
      totals,
      totals_prev: totalsPrev,
      campaigns: campaignsList,
      keywords: keywordsList,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as Record<string, unknown> | null;
    const t = (d?.totals ?? {}) as Record<string, number>;
    const round = (n: number) => Math.round(n * 100) / 100;

    metrics.push(
      { name: 'google-ads.total_spend_30d',            value: round(t.cost ?? 0),               data: null },
      { name: 'google-ads.total_clicks_30d',           value: t.clicks ?? 0,                    data: null },
      { name: 'google-ads.total_impressions_30d',      value: t.impressions ?? 0,               data: null },
      { name: 'google-ads.total_conversions_30d',      value: round(t.conversions ?? 0),        data: null },
      { name: 'google-ads.total_conversion_value_30d', value: round(t.conversion_value ?? 0),   data: null },
      { name: 'google-ads.avg_cpc',                    value: round(t.avg_cpc ?? 0),            data: null },
      { name: 'google-ads.avg_ctr',                    value: round(t.avg_ctr ?? 0),            data: null },
      { name: 'google-ads.roas',                       value: round(t.roas ?? 0),               data: null },
      { name: 'google-ads.cpa',                        value: round(t.cpa ?? 0),                data: null },
      { name: 'google-ads.impression_share',           value: round(t.impression_share ?? 0),   data: null },
    );

    metrics.push(
      { name: 'google-ads.campaigns_data', value: (d?.campaigns as Array<unknown> | undefined)?.length ?? 0, data: d?.campaigns ?? [] },
      { name: 'google-ads.keywords_data',  value: (d?.keywords as Array<unknown> | undefined)?.length ?? 0,  data: d?.keywords ?? [] },
    );

    return metrics;
  },

  async getAuthUrl(state: string): Promise<string> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID env var not set.');
    const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI || 'http://localhost:4000/api/oauth/google-ads/callback';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state: state ?? '',
    });
    return `${AUTH_BASE}?${params.toString()}`;
  },

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI || 'http://localhost:4000/api/oauth/google-ads/callback';
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
    }
    const res = await checkedFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const tokens = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || undefined,
      expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      scope: tokens.scope,
    };
  },

  async refreshToken(credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> {
    return ensureFreshToken({ ...credentials, expiresAt: '0' }) as Promise<{ accessToken: string; expiresAt?: string }>;
  },
};

export default connector;
