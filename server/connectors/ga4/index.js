import fetch from 'node-fetch';

const GA4_BASE = 'https://analyticsdata.googleapis.com/v1beta/properties';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = 'https://www.googleapis.com/auth/analytics.readonly';

/**
 * Refresh the access token if it is about to expire.
 */
async function ensureFreshToken(credentials) {
  if (!credentials.expiresAt || Date.now() + 60_000 < credentials.expiresAt) {
    return credentials;
  }

  if (!credentials.refreshToken) {
    throw new Error('GA4 token expired and no refresh token available. Re-authorise the connector.');
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
    throw new Error(`GA4 token refresh failed: ${err.substring(0, 300)}`);
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
  id: 'ga4',
  name: 'Google Analytics 4',
  category: 'analytics',
  authType: 'oauth2',
  icon: 'bar-chart-2',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  signalTypes: ['traffic_drop', 'bounce_rate_spike', 'conversion_drop'],

  async healthCheck(credentials) {
    try {
      const creds = await ensureFreshToken(credentials);
      if (!credentials.propertyId) {
        return { ok: false, error: 'GA4 propertyId is not configured.' };
      }
      const res = await fetch(`${GA4_BASE}/${credentials.propertyId}/metadata`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `GA4 API error ${res.status}: ${body.substring(0, 200)}` };
      }
      return { ok: true, details: 'Property accessible.' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(dataType, credentials, params) {
    const creds = await ensureFreshToken(credentials);
    const propertyId = params.propertyId || credentials.propertyId;

    if (!propertyId) throw new Error('GA4 propertyId is required (in credentials or params).');

    if (dataType === 'report') {
      return fetchReport(creds, propertyId, params);
    }

    throw new Error(`GA4 connector does not support dataType '${dataType}'. Use 'report'.`);
  },

  async getAuthUrl(state) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID env var not set.');
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/oauth/google/callback';

    const queryParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    return `${AUTH_BASE}?${queryParams.toString()}`;
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
      throw new Error(`GA4 code exchange failed: ${err.substring(0, 300)}`);
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
    return ensureFreshToken({ ...credentials, expiresAt: 0 });
  },

  /**
   * Extract individual metric rows from a report fetch result.
   * Expects data in the shape returned by fetchReport:
   *   { current: {sessions, activeUsers, bounceRate, conversions},
   *     previous: {...}, topPages: [...], sources: [...], period }
   */
  extractMetrics(data, runAt) {
    const metrics = [];
    if (!data || !data.current) return metrics;

    const c = data.current;
    const p = data.previous ?? {};

    metrics.push(
      { name: 'ga4.sessions',       value: c.sessions ?? 0,       data: null },
      { name: 'ga4.sessions_prev',  value: p.sessions ?? 0,       data: null },
      { name: 'ga4.users',          value: c.activeUsers ?? 0,    data: null },
      { name: 'ga4.users_prev',     value: p.activeUsers ?? 0,    data: null },
      { name: 'ga4.bounce_rate',    value: c.bounceRate ?? 0,     data: null },
      { name: 'ga4.conversions',    value: c.conversions ?? 0,    data: null },
      { name: 'ga4.conversions_prev', value: p.conversions ?? 0,  data: null },
    );

    // Rich data
    if (Array.isArray(data.topPages) && data.topPages.length > 0) {
      metrics.push({ name: 'ga4.top_pages', value: data.topPages.length, data: data.topPages });
    }
    if (Array.isArray(data.sources) && data.sources.length > 0) {
      metrics.push({ name: 'ga4.traffic_sources', value: data.sources.length, data: data.sources });
    }

    return metrics;
  },
};

async function fetchReport(creds, propertyId, params) {
  const endDate = 'today';
  const startDate = params.startDate || '14daysAgo';
  const prevStartDate = params.prevStartDate || '28daysAgo';
  const prevEndDate = params.prevEndDate || '15daysAgo';

  const requestBody = {
    dateRanges: [
      { startDate, endDate },
      { startDate: prevStartDate, endDate: prevEndDate },
    ],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'bounceRate' },
      { name: 'conversions' },
    ],
    orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
  };

  const res = await fetch(`${GA4_BASE}/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 report error ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  const rows = data.rows ?? [];

  // Split rows into current (dateRange 0) and previous (dateRange 1)
  const currentRows = rows.filter(r => r.dimensionValues?.[0]?.value !== undefined && r.dataRangeIndex === undefined);
  // GA4 returns rows with dataRangeIndex field when multiple date ranges
  const allRows = rows;

  // Aggregate totals
  function aggregate(rangeIndex) {
    let sessions = 0, users = 0, bounceRate = 0, conversions = 0, count = 0;
    for (const row of allRows) {
      if (row.dataRangeIndex !== undefined && row.dataRangeIndex !== rangeIndex) continue;
      if (row.dataRangeIndex === undefined && rangeIndex !== 0) continue;
      sessions += parseFloat(row.metricValues?.[0]?.value ?? 0);
      users += parseFloat(row.metricValues?.[1]?.value ?? 0);
      bounceRate += parseFloat(row.metricValues?.[2]?.value ?? 0);
      conversions += parseFloat(row.metricValues?.[3]?.value ?? 0);
      count++;
    }
    return {
      sessions: Math.round(sessions),
      activeUsers: Math.round(users),
      bounceRate: count > 0 ? Math.round((bounceRate / count) * 100) / 100 : 0,
      conversions: Math.round(conversions),
    };
  }

  const current = aggregate(0);
  const previous = aggregate(1);

  // Top pages (requires a separate request)
  let topPages = [];
  try {
    const pagesRes = await fetch(`${GA4_BASE}/${propertyId}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'sessions' }, { name: 'bounceRate' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10,
      }),
    });

    if (pagesRes.ok) {
      const pagesData = await pagesRes.json();
      topPages = (pagesData.rows ?? []).map(row => ({
        path: row.dimensionValues?.[0]?.value,
        sessions: parseInt(row.metricValues?.[0]?.value ?? 0, 10),
        bounceRate: parseFloat(row.metricValues?.[1]?.value ?? 0),
      }));
    }
  } catch { /* non-fatal */ }

  // Traffic sources
  let sources = [];
  try {
    const sourcesRes = await fetch(`${GA4_BASE}/${propertyId}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      }),
    });

    if (sourcesRes.ok) {
      const sourcesData = await sourcesRes.json();
      sources = (sourcesData.rows ?? []).map(row => ({
        channel: row.dimensionValues?.[0]?.value,
        sessions: parseInt(row.metricValues?.[0]?.value ?? 0, 10),
      }));
    }
  } catch { /* non-fatal */ }

  return {
    current,
    previous,
    topPages,
    sources,
    period: { current: { start: startDate, end: endDate }, previous: { start: prevStartDate, end: prevEndDate } },
    fetchedAt: new Date().toISOString(),
  };
}

export default connector;
