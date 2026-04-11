import fetch from 'node-fetch';

const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly';

/**
 * Refresh the access token if it is about to expire.
 * Returns updated credentials (caller should persist them).
 */
async function ensureFreshToken(credentials) {
  if (!credentials.expiresAt || Date.now() + 60_000 < credentials.expiresAt) {
    return credentials; // still valid
  }

  if (!credentials.refreshToken) {
    throw new Error('GSC token expired and no refresh token available. Re-authorise the connector.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID || credentials.clientId || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || credentials.clientSecret || '',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GSC token refresh failed: ${err.substring(0, 300)}`);
  }

  const tokens = await res.json();
  return {
    ...credentials,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

function dateString(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

const connector = {
  id: 'gsc',
  name: 'Google Search Console',
  category: 'seo',
  authType: 'oauth2',
  icon: 'search',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  signalTypes: ['ranking_drop_keyword', 'keyword_surge', 'crawl_error_spike', 'ctr_below_threshold'],

  async healthCheck(credentials) {
    try {
      const creds = await ensureFreshToken(credentials);
      const res = await fetch(`${GSC_BASE}/sites`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `GSC API error ${res.status}: ${body.substring(0, 200)}` };
      }
      const data = await res.json();
      return { ok: true, details: { sites: data.siteEntry?.length ?? 0 } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(dataType, credentials, params) {
    const creds = await ensureFreshToken(credentials);

    if (dataType === 'search_analytics') {
      return fetchSearchAnalytics(creds, params);
    }
    if (dataType === 'sitemaps') {
      return fetchSitemaps(creds, params);
    }
    if (dataType === 'url_inspection') {
      return fetchUrlInspection(creds, params);
    }
    throw new Error(`GSC connector does not support dataType '${dataType}'.`);
  },

  async getAuthUrl(state) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID env var not set.');
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/oauth/google/callback';

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    return `${AUTH_BASE}?${params.toString()}`;
  },

  async exchangeCode(code) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/oauth/google/callback';

    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GSC code exchange failed: ${err.substring(0, 300)}`);
    }

    const tokens = await res.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
    };
  },

  async refreshToken(credentials) {
    return ensureFreshToken({ ...credentials, expiresAt: 0 }); // force refresh
  },

  /**
   * Extract individual metric rows from a search_analytics fetch result.
   * Expects data in the shape returned by fetchSearchAnalytics:
   *   { current: [{query, clicks, impressions, ctr, position}], previous: [...], period }
   */
  extractMetrics(data, runAt) {
    const metrics = [];
    const current = Array.isArray(data?.current) ? data.current : [];
    const previous = Array.isArray(data?.previous) ? data.previous : [];

    if (current.length === 0) return metrics;

    // Aggregates
    const totalClicks = current.reduce((s, k) => s + (k.clicks || 0), 0);
    const totalImpressions = current.reduce((s, k) => s + (k.impressions || 0), 0);
    const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    const avgPosition = current.length > 0
      ? current.reduce((s, k) => s + (k.position || 0), 0) / current.length
      : 0;

    metrics.push(
      { name: 'gsc.total_clicks',      value: totalClicks,                  data: null },
      { name: 'gsc.total_impressions', value: totalImpressions,             data: null },
      { name: 'gsc.avg_ctr',           value: Math.round(avgCtr * 10000) / 10000, data: null },
      { name: 'gsc.avg_position',      value: Math.round(avgPosition * 100) / 100, data: null },
      { name: 'gsc.keyword_count',     value: current.length,               data: null },
    );

    // Rich data: top keywords (current period)
    metrics.push({ name: 'gsc.keywords', value: current.length, data: current.slice(0, 100) });

    // Position movements vs previous period (>3 position swing)
    const prevByQuery = new Map(previous.map(k => [k.query, k]));
    const movers = current
      .map(k => {
        const prev = prevByQuery.get(k.query);
        if (!prev) return null;
        const delta = (prev.position || 0) - (k.position || 0); // positive = improved
        return { ...k, position_change: Math.round(delta * 100) / 100 };
      })
      .filter(Boolean);

    const keywordsUp = movers.filter(k => k.position_change > 3).sort((a, b) => b.position_change - a.position_change);
    const keywordsDown = movers.filter(k => k.position_change < -3).sort((a, b) => a.position_change - b.position_change);

    metrics.push(
      { name: 'gsc.keywords_up',   value: keywordsUp.length,   data: keywordsUp.slice(0, 50) },
      { name: 'gsc.keywords_down', value: keywordsDown.length, data: keywordsDown.slice(0, 50) },
    );

    // Opportunities: high impressions (>500) but low CTR (<2%)
    const opportunities = current
      .filter(k => (k.impressions || 0) > 500 && (k.ctr || 0) < 0.02)
      .sort((a, b) => (b.impressions || 0) - (a.impressions || 0));

    metrics.push({ name: 'gsc.opportunities', value: opportunities.length, data: opportunities.slice(0, 50) });

    return metrics;
  },
};

async function fetchSearchAnalytics(creds, params) {
  const siteUrl = params.siteUrl;
  if (!siteUrl) throw new Error('params.siteUrl is required.');

  const endDate = dateString(3); // GSC has ~3 day delay
  const startDateCurrent = dateString(10);
  const startDatePrev = dateString(17);
  const endDatePrev = dateString(11);

  async function query(startDate, endDate) {
    const body = {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit: 50,
      orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
    };

    const res = await fetch(
      `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GSC search analytics error ${res.status}: ${err.substring(0, 300)}`);
    }

    const data = await res.json();
    return (data.rows ?? []).map(row => ({
      query: row.keys[0],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));
  }

  const [current, previous] = await Promise.all([
    query(startDateCurrent, endDate),
    query(startDatePrev, endDatePrev),
  ]);

  return { current, previous, period: { current: { start: startDateCurrent, end: endDate }, previous: { start: startDatePrev, end: endDatePrev } } };
}

async function fetchSitemaps(creds, params) {
  const siteUrl = params.siteUrl;
  if (!siteUrl) throw new Error('params.siteUrl is required.');

  const res = await fetch(
    `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GSC sitemaps error ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  return { sitemaps: data.sitemap ?? [] };
}

async function fetchUrlInspection(creds, params) {
  const { siteUrl, inspectionUrl } = params;
  if (!siteUrl || !inspectionUrl) throw new Error('params.siteUrl and params.inspectionUrl are required.');

  const res = await fetch(
    'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GSC URL inspection error ${res.status}: ${err.substring(0, 300)}`);
  }

  return res.json();
}

export default connector;
