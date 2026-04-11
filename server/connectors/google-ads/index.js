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

const API_VERSION = 'v17';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/adwords';

async function ensureFreshToken(credentials) {
  if (!credentials.expiresAt || Date.now() + 60_000 < credentials.expiresAt) {
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
  const tokens = await res.json();
  return {
    ...credentials,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

function buildHeaders(credentials, customerId, managerAccountId) {
  const headers = {
    Authorization: `Bearer ${credentials.accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    'Content-Type': 'application/json',
  };
  if (managerAccountId) {
    headers['login-customer-id'] = String(managerAccountId).replace(/-/g, '');
  }
  return headers;
}

async function gaqlQuery(query, credentials, customerId, managerAccountId) {
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
  return res.json();
}

const connector = {
  id: 'google-ads',
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

  async healthCheck(credentials) {
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
      const row = data.results?.[0];
      return {
        ok: true,
        details: {
          customer_id: row?.customer?.id,
          name: row?.customer?.descriptiveName,
          currency: row?.customer?.currencyCode,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, params) {
    if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN env var is not set.');
    }
    const customerId = params?.customerId || credentials?.customerId;
    if (!customerId) throw new Error('Google Ads customerId is required.');

    const fresh = await ensureFreshToken(credentials);
    const managerAccountId = params?.managerAccountId || credentials?.managerAccountId;

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
      ).catch(() => ({ results: [] })),
      gaqlQuery(
        `SELECT
           metrics.clicks, metrics.impressions, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value,
           metrics.average_cpc, metrics.ctr
         FROM customer
         WHERE segments.date BETWEEN '2025-03-01' AND '2025-03-31'`,
        fresh, customerId, managerAccountId
      ).catch(() => ({ results: [] })),
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
      ).catch(() => ({ results: [] })),
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
      ).catch(() => ({ results: [] })),
    ]);

    function aggregateMetrics(results) {
      let clicks = 0, impressions = 0, costMicros = 0, conversions = 0, value = 0;
      let ctrSum = 0, cpcSum = 0, isSum = 0, count = 0;
      for (const row of results.results ?? []) {
        const m = row.metrics ?? {};
        clicks += parseInt(m.clicks ?? 0, 10);
        impressions += parseInt(m.impressions ?? 0, 10);
        costMicros += parseInt(m.costMicros ?? 0, 10);
        conversions += parseFloat(m.conversions ?? 0);
        value += parseFloat(m.conversionsValue ?? 0);
        ctrSum += parseFloat(m.ctr ?? 0);
        cpcSum += parseFloat(m.averageCpc ?? 0);
        isSum += parseFloat(m.searchImpressionShare ?? 0);
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

    const campaignsList = (campaigns.results ?? []).map(row => {
      const m = row.metrics ?? {};
      const c = row.campaign ?? {};
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        channel: c.advertisingChannelType,
        clicks: parseInt(m.clicks ?? 0, 10),
        impressions: parseInt(m.impressions ?? 0, 10),
        cost: parseInt(m.costMicros ?? 0, 10) / 1_000_000,
        conversions: parseFloat(m.conversions ?? 0),
        conversion_value: parseFloat(m.conversionsValue ?? 0),
        ctr: parseFloat(m.ctr ?? 0),
        avg_cpc: parseFloat(m.averageCpc ?? 0) / 1_000_000,
        impression_share: parseFloat(m.searchImpressionShare ?? 0),
      };
    });

    const keywordsList = (keywords.results ?? []).map(row => {
      const m = row.metrics ?? {};
      const c = row.adGroupCriterion ?? {};
      return {
        text: c.keyword?.text,
        quality_score: c.qualityInfo?.qualityScore ?? null,
        clicks: parseInt(m.clicks ?? 0, 10),
        impressions: parseInt(m.impressions ?? 0, 10),
        cost_micros: parseInt(m.costMicros ?? 0, 10),
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

  extractMetrics(data, _runAt) {
    const metrics = [];
    const t = data?.totals ?? {};
    const round = n => Math.round(n * 100) / 100;

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
      { name: 'google-ads.campaigns_data', value: data?.campaigns?.length ?? 0, data: data?.campaigns ?? [] },
      { name: 'google-ads.keywords_data',  value: data?.keywords?.length ?? 0,  data: data?.keywords ?? [] },
    );

    return metrics;
  },

  async getAuthUrl(state) {
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

  async exchangeCode(code) {
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
    const tokens = await res.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
    };
  },

  async refreshToken(credentials) {
    return ensureFreshToken({ ...credentials, expiresAt: 0 });
  },
};

export default connector;
