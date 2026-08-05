import fetch from 'node-fetch';
import { readGoogleOAuthConfig } from '../../lib/google-oauth-config.js';
import { sessionsWeightedAverage } from '../metrics-math.js';

type Creds = Record<string, string | undefined>;

const GA4_BASE = 'https://analyticsdata.googleapis.com/v1beta/properties';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = 'https://www.googleapis.com/auth/analytics.readonly';

/**
 * Refresh the access token if it is about to expire.
 */
async function ensureFreshToken(credentials: Creds): Promise<Creds> {
  if (!credentials.expiresAt || Date.now() + 60_000 < Number(credentials.expiresAt)) {
    return credentials;
  }

  if (!credentials.refreshToken) {
    throw new Error('GA4 token expired and no refresh token available. Re-authorise the connector.');
  }

  const { clientId, clientSecret } = readGoogleOAuthConfig();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: clientId || credentials.clientId || '',
    client_secret: clientSecret || credentials.clientSecret || '',
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

  const tokens = await res.json() as { access_token: string; expires_in?: number };
  return {
    ...credentials,
    accessToken: tokens.access_token,
    expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
}

function dateString(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

const connector = {
  id: 'ga4' as const,
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

  async healthCheck(credentials: Creds, config: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      const creds = await ensureFreshToken(credentials);
      const propertyId = (config.propertyId as string | undefined) || credentials.propertyId;
      if (!propertyId) {
        return { ok: false, error: 'GA4 propertyId is not configured.' };
      }
      const res = await fetch(`${GA4_BASE}/${propertyId}/metadata`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `GA4 API error ${res.status}: ${body.substring(0, 200)}` };
      }
      return { ok: true, details: 'Property accessible.' };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(dataType: string, credentials: Creds, params?: Record<string, unknown>): Promise<unknown> {
    const creds = await ensureFreshToken(credentials);
    const propertyId = (params?.propertyId as string | undefined) || credentials.propertyId;

    if (!propertyId) throw new Error('GA4 propertyId is required (in credentials or params).');

    if (dataType === 'report') {
      return fetchReport(creds, propertyId, params ?? {});
    }

    throw new Error(`GA4 connector does not support dataType '${dataType}'. Use 'report'.`);
  },

  async getAuthUrl(state: string): Promise<string> {
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

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> {
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

    const tokens = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      scope: tokens.scope,
    };
  },

  async refreshToken(credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> {
    return ensureFreshToken({ ...credentials, expiresAt: '0' }) as Promise<{ accessToken: string; expiresAt?: string }>;
  },

  /**
   * Extract individual metric rows from a report fetch result.
   * Expects data in the shape returned by fetchReport:
   *   { current: {sessions, activeUsers, bounceRate, conversions},
   *     previous: {...}, topPages: [...], sources: [...], period }
   */
  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as Record<string, unknown> | null;
    if (!d || !d.current) return metrics;

    const c = d.current as Record<string, number>;
    const p = (d.previous ?? {}) as Record<string, number>;

    metrics.push(
      { name: 'ga4.sessions',         value: c.sessions ?? 0,      data: null },
      { name: 'ga4.sessions_prev',     value: p.sessions ?? 0,      data: null },
      { name: 'ga4.users',             value: c.activeUsers ?? 0,   data: null },
      { name: 'ga4.users_prev',        value: p.activeUsers ?? 0,   data: null },
      { name: 'ga4.bounce_rate',       value: c.bounceRate ?? 0,    data: null },
      { name: 'ga4.conversions',       value: c.conversions ?? 0,   data: null },
      { name: 'ga4.conversions_prev',  value: p.conversions ?? 0,   data: null },
    );

    // Rich data
    if (Array.isArray(d.topPages) && d.topPages.length > 0) {
      metrics.push({ name: 'ga4.top_pages', value: d.topPages.length, data: d.topPages });
    }
    if (Array.isArray(d.sources) && d.sources.length > 0) {
      metrics.push({ name: 'ga4.traffic_sources', value: d.sources.length, data: d.sources });
    }

    return metrics;
  },
};

async function fetchReport(creds: Creds, propertyId: string, params: Record<string, unknown>): Promise<unknown> {
  const endDate = 'today';
  const startDate = (params.startDate as string | undefined) || '14daysAgo';
  const prevStartDate = (params.prevStartDate as string | undefined) || '28daysAgo';
  const prevEndDate = (params.prevEndDate as string | undefined) || '15daysAgo';

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

  const data = await res.json() as { rows?: Array<Record<string, unknown>> };
  const rows = (data.rows ?? []) as Array<Record<string, unknown>>;

  // GA4 returns rows with dataRangeIndex field when multiple date ranges
  const allRows = rows;

  // Aggregate totals
  function aggregate(rangeIndex: number): { sessions: number; activeUsers: number; bounceRate: number; conversions: number } {
    let sessions = 0, users = 0, conversions = 0;
    const bouncePairs: Array<{ value: number; weight: number }> = [];
    for (const row of allRows) {
      if (row.dataRangeIndex !== undefined && row.dataRangeIndex !== rangeIndex) continue;
      if (row.dataRangeIndex === undefined && rangeIndex !== 0) continue;
      const metricValues = row.metricValues as Array<Record<string, string>> | undefined;
      const rowSessions = parseFloat((metricValues?.[0]?.value ?? '0') as string);
      sessions += rowSessions;
      users += parseFloat((metricValues?.[1]?.value ?? '0') as string);
      // bounceRate is a per-row ratio — weight it by that row's sessions rather
      // than taking an unweighted mean of daily rates (which skewed the signal).
      bouncePairs.push({ value: parseFloat((metricValues?.[2]?.value ?? '0') as string), weight: rowSessions });
      conversions += parseFloat((metricValues?.[3]?.value ?? '0') as string);
    }
    return {
      sessions: Math.round(sessions),
      activeUsers: Math.round(users),
      bounceRate: Math.round(sessionsWeightedAverage(bouncePairs) * 100) / 100,
      conversions: Math.round(conversions),
    };
  }

  const current = aggregate(0);
  const previous = aggregate(1);

  // Top pages (requires a separate request)
  let topPages: Array<unknown> = [];
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
      const pagesData = await pagesRes.json() as { rows?: Array<Record<string, unknown>> };
      topPages = (pagesData.rows ?? []).map(row => {
        const dimensionValues = row.dimensionValues as Array<Record<string, string>> | undefined;
        const metricValues = row.metricValues as Array<Record<string, string>> | undefined;
        return {
          path: dimensionValues?.[0]?.value,
          sessions: parseInt((metricValues?.[0]?.value ?? '0') as string, 10),
          bounceRate: parseFloat((metricValues?.[1]?.value ?? '0') as string),
        };
      });
    }
  } catch { /* non-fatal */ }

  // Traffic sources
  let sources: Array<unknown> = [];
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
      const sourcesData = await sourcesRes.json() as { rows?: Array<Record<string, unknown>> };
      sources = (sourcesData.rows ?? []).map(row => {
        const dimensionValues = row.dimensionValues as Array<Record<string, string>> | undefined;
        const metricValues = row.metricValues as Array<Record<string, string>> | undefined;
        return {
          channel: dimensionValues?.[0]?.value,
          sessions: parseInt((metricValues?.[0]?.value ?? '0') as string, 10),
        };
      });
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
