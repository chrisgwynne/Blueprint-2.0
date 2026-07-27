import fetch from 'node-fetch';
import { readGoogleOAuthConfig } from '../../lib/google-oauth-config.js';

type Creds = Record<string, string | undefined>;

const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly';

/**
 * Refresh the access token if it is about to expire.
 * Returns updated credentials (caller should persist them).
 */
async function ensureFreshToken(credentials: Creds): Promise<Creds> {
  if (!credentials.expiresAt || Date.now() + 60_000 < Number(credentials.expiresAt)) {
    return credentials; // still valid
  }

  if (!credentials.refreshToken) {
    throw new Error('GSC token expired and no refresh token available. Re-authorise the connector.');
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
    throw new Error(`GSC token refresh failed: ${err.substring(0, 300)}`);
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
  id: 'gsc' as const,
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

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      const creds = await ensureFreshToken(credentials);
      const res = await fetch(`${GSC_BASE}/sites`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `GSC API error ${res.status}: ${body.substring(0, 200)}` };
      }
      const data = await res.json() as { siteEntry?: unknown[] };
      return { ok: true, details: { sites: data.siteEntry?.length ?? 0 } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(dataType: string, credentials: Creds, params?: Record<string, unknown>): Promise<unknown> {
    const creds = await ensureFreshToken(credentials);

    if (dataType === 'sites') {
      return fetchSites(creds);
    }
    if (dataType === 'search_analytics') {
      return fetchSearchAnalytics(creds, params ?? {});
    }
    if (dataType === 'sitemaps') {
      return fetchSitemaps(creds, params ?? {});
    }
    if (dataType === 'url_inspection') {
      return fetchUrlInspection(creds, params ?? {});
    }
    throw new Error(`GSC connector does not support dataType '${dataType}'.`);
  },

  async getAuthUrl(state: string): Promise<string> {
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
      throw new Error(`GSC code exchange failed: ${err.substring(0, 300)}`);
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
    return ensureFreshToken({ ...credentials, expiresAt: '0' }) as Promise<{ accessToken: string; expiresAt?: string }>; // force refresh
  },

  /**
   * Extract individual metric rows from a search_analytics fetch result.
   * Expects data in the shape returned by fetchSearchAnalytics:
   *   { current: [{query, clicks, impressions, ctr, position}], previous: [...], period }
   */
  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as Record<string, unknown> | null;
    const current = Array.isArray(d?.current) ? (d.current as Array<Record<string, number>>) : [];
    const previous = Array.isArray(d?.previous) ? (d.previous as Array<Record<string, number | string>>) : [];

    if (current.length === 0) return metrics;

    // Aggregates
    const totalClicks = current.reduce((s, k) => s + (k.clicks || 0), 0);
    const totalImpressions = current.reduce((s, k) => s + (k.impressions || 0), 0);
    const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    const avgPosition = current.length > 0
      ? current.reduce((s, k) => s + (k.position || 0), 0) / current.length
      : 0;

    metrics.push(
      { name: 'gsc.total_clicks',      value: totalClicks,                            data: null },
      { name: 'gsc.total_impressions', value: totalImpressions,                       data: null },
      { name: 'gsc.avg_ctr',           value: Math.round(avgCtr * 10000) / 10000,     data: null },
      { name: 'gsc.avg_position',      value: Math.round(avgPosition * 100) / 100,    data: null },
      { name: 'gsc.keyword_count',     value: current.length,                         data: null },
    );

    // Rich data: top keywords (current period)
    metrics.push({ name: 'gsc.keywords', value: current.length, data: current.slice(0, 100) });

    // Position movements vs previous period (>3 position swing)
    const prevByQuery = new Map(previous.map(k => [k.query as string, k]));
    const movers = current
      .map(k => {
        const prev = prevByQuery.get(k.query as unknown as string);
        if (!prev) return null;
        const delta = ((prev.position as number) || 0) - (k.position || 0); // positive = improved
        return { ...k, position_change: Math.round(delta * 100) / 100 };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

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

/**
 * List every site (URL or domain property) the authorised user has
 * verified in Search Console. Used by the connector setup UI to show a
 * dropdown of valid choices instead of letting the user type the wrong
 * variant (http vs https, www vs apex, missing trailing slash etc.).
 */
async function fetchSites(creds: Creds): Promise<unknown> {
  const res = await fetch(`${GSC_BASE}/sites`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GSC sites list error ${res.status}: ${body.substring(0, 200)}`);
  }
  const data = await res.json() as { siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> };
  // Normalise to a clean shape; sort owner/full first so the most useful
  // properties surface at the top of the dropdown.
  const out = (data.siteEntry ?? []).map((s) => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel,
  }));
  const rank: Record<string, number> = { siteOwner: 0, siteFullUser: 1, siteRestrictedUser: 2, siteUnverifiedUser: 3 };
  out.sort((a, b) => (rank[a.permissionLevel] ?? 9) - (rank[b.permissionLevel] ?? 9));
  return { sites: out };
}

async function fetchSearchAnalytics(creds: Creds, params: Record<string, unknown>): Promise<unknown> {
  const siteUrl = params.siteUrl as string | undefined;
  if (!siteUrl) throw new Error('params.siteUrl is required.');

  const endDate = dateString(3); // GSC has ~3 day delay
  const startDateCurrent = dateString(10);
  const startDatePrev = dateString(17);
  const endDatePrev = dateString(11);

  async function query(startDate: string, endDate: string): Promise<Array<Record<string, unknown>>> {
    // Paginate. GSC allows up to 25000 rows/request; the old code took only the
    // top 50 by clicks, so avg_position / CTR / keyword-opportunity metrics were
    // computed on a tiny slice. Page through up to MAX_ROWS keywords.
    const PAGE = 1000;
    const MAX_ROWS = 5000;
    const out: Array<Record<string, unknown>> = [];
    let startRow = 0;

    while (out.length < MAX_ROWS) {
      const body = {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit: PAGE,
        startRow,
        orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
      };

      const res = await fetch(
        `${GSC_BASE}/sites/${encodeURIComponent(siteUrl!)}/searchAnalytics/query`,
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
        // 403 "sufficient permission for site" almost always means the URL
        // variant doesn't match what was verified in Search Console
        // (http vs https, www vs apex, trailing slash).
        if (res.status === 403 && /sufficient permission for site/i.test(err)) {
          throw new Error(
            `GSC: this Google account isn't verified for '${siteUrl}'. ` +
            'Search Console treats http vs https and www vs the apex domain as separate properties. ' +
            'Open Settings → Connectors → your GSC connector → Configure to pick from your verified sites, ' +
            'or add a Domain property in Search Console to cover all variants.'
          );
        }
        throw new Error(`GSC search analytics error ${res.status}: ${err.substring(0, 300)}`);
      }

      const data = await res.json() as { rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> };
      const page = data.rows ?? [];
      for (const row of page) {
        out.push({
          query: row.keys[0],
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        });
      }
      if (page.length < PAGE) break; // last page
      startRow += PAGE;
    }

    return out;
  }

  const [current, previous] = await Promise.all([
    query(startDateCurrent, endDate),
    query(startDatePrev, endDatePrev),
  ]);

  return { current, previous, period: { current: { start: startDateCurrent, end: endDate }, previous: { start: startDatePrev, end: endDatePrev } } };
}

async function fetchSitemaps(creds: Creds, params: Record<string, unknown>): Promise<unknown> {
  const siteUrl = params.siteUrl as string | undefined;
  if (!siteUrl) throw new Error('params.siteUrl is required.');

  const res = await fetch(
    `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
    { headers: { Authorization: `Bearer ${creds.accessToken}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GSC sitemaps error ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json() as { sitemap?: unknown[] };
  return { sitemaps: data.sitemap ?? [] };
}

async function fetchUrlInspection(creds: Creds, params: Record<string, unknown>): Promise<unknown> {
  const siteUrl = params.siteUrl as string | undefined;
  const inspectionUrl = params.inspectionUrl as string | undefined;
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
