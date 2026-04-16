/**
 * Meta Ads (Facebook + Instagram) connector.
 *
 * Pulls ad account, campaign, and insights data via the Meta Marketing API.
 * Auth: OAuth2 via Facebook Login — long-lived token (60 days).
 *
 * See README/docs for app setup instructions. Required env vars:
 *   META_APP_ID
 *   META_APP_SECRET
 *   META_REDIRECT_URI
 */
import fetch from 'node-fetch';

type Creds = Record<string, string | undefined>;

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';
const AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth';

const SCOPES = 'ads_read,read_insights,business_management';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

interface FetchLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface RetryError extends Error {
  status?: number;
}

async function withRetry(
  fn: () => Promise<FetchLike>,
  { retries = 3, backoffMs = 500 } = {},
): Promise<FetchLike> {
  let lastErr: RetryError | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fn();
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err: RetryError = new Error(`Meta API ${res.status}: ${text.substring(0, 300)}`);
        err.status = res.status;
        // Retry only on 429/5xx
        if (res.status === 429 || res.status >= 500) {
          throw err;
        }
        throw err;
      }
      return res;
    } catch (err) {
      lastErr = err as RetryError;
      if (i < retries - 1 && (lastErr.status === 429 || (lastErr.status !== undefined && lastErr.status >= 500) || !lastErr.status)) {
        await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, i)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Get number (safe parse, falls back to 0 for null/undefined/non-numeric).
 */
function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extract a named value from an `actions` or `action_values` array.
 */
function getAction(arr: unknown, actionType: string): number {
  if (!Array.isArray(arr)) return 0;
  const item = arr.find((a: { action_type?: string; value?: unknown }) => a.action_type === actionType);
  return num(item?.value);
}

// ─── Token management ────────────────────────────────────────────────────────

/**
 * Ensure the access token is valid. If it expires within 7 days, refresh it
 * via fb_exchange_token (Meta's long-lived token refresh flow).
 * Returns updated credentials (new `access_token` and `token_expires_at`).
 */
async function ensureFreshToken(credentials: Creds): Promise<Creds> {
  if (!credentials?.access_token) {
    throw new Error('Meta Ads: access_token missing. Re-authorise the connector.');
  }

  const expiresAt = Number(credentials.token_expires_at ?? 0);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  if (expiresAt > Date.now() + sevenDaysMs) {
    return credentials;
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    // Can't refresh without app credentials — caller must re-auth.
    throw new Error('Meta Ads: cannot refresh token — META_APP_ID/META_APP_SECRET not set.');
  }

  const url = `${GRAPH_BASE}/oauth/access_token?` + new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: credentials.access_token,
  });

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta token refresh failed: ${text.substring(0, 300)}`);
  }
  const json = await res.json() as { access_token: string; expires_in?: number };
  const newExpiresAt = Date.now() + (num(json.expires_in) || 60 * 24 * 60 * 60) * 1000;
  return {
    ...credentials,
    access_token: json.access_token,
    token_expires_at: String(newExpiresAt),
  };
}

// ─── API calls ───────────────────────────────────────────────────────────────

async function fetchAccount(credentials: Creds, config: Record<string, unknown>): Promise<unknown> {
  const creds = await ensureFreshToken(credentials);
  const accountId = (config.adAccountId as string | undefined) || credentials.ad_account_id;
  if (!accountId) throw new Error('Meta Ads: adAccountId is required (e.g. act_123456789).');

  const res = await withRetry(() => fetch(`${GRAPH_BASE}/${accountId}?` + new URLSearchParams({
    fields: 'id,name,currency,timezone_name,spend_cap,balance,account_status',
    access_token: creds.access_token!,
  })) as Promise<FetchLike>);
  return res.json();
}

async function fetchInsights(credentials: Creds, config: Record<string, unknown>): Promise<unknown> {
  const creds = await ensureFreshToken(credentials);
  const accountId = (config.adAccountId as string | undefined) || credentials.ad_account_id;
  if (!accountId) throw new Error('Meta Ads: adAccountId is required.');

  // 1) Account-level insights (last 30 days)
  const accountRes = await withRetry(() => fetch(`${GRAPH_BASE}/${accountId}/insights?` + new URLSearchParams({
    fields: [
      'impressions', 'reach', 'frequency',
      'clicks', 'unique_clicks', 'ctr', 'unique_ctr',
      'spend', 'cpm', 'cpc', 'cpp',
      'actions', 'action_values',
      'cost_per_action_type', 'purchase_roas',
      'video_view_rate', 'video_avg_time_watched_actions',
    ].join(','),
    date_preset: 'last_30d',
    access_token: creds.access_token!,
  })) as Promise<FetchLike>);
  const account = await accountRes.json();

  // 2) Campaign-level insights (last 30 days)
  const campaignsRes = await withRetry(() => fetch(`${GRAPH_BASE}/${accountId}/insights?` + new URLSearchParams({
    fields: [
      'campaign_name', 'campaign_id', 'objective',
      'impressions', 'reach', 'clicks', 'spend',
      'cpm', 'cpc', 'ctr', 'purchase_roas',
      'actions', 'action_values',
    ].join(','),
    level: 'campaign',
    date_preset: 'last_30d',
    limit: '20',
    access_token: creds.access_token!,
  })) as Promise<FetchLike>);
  const campaigns = await campaignsRes.json();

  // 3) Previous period (31-60 days ago) for comparison
  const prevRes = await withRetry(() => fetch(`${GRAPH_BASE}/${accountId}/insights?` + new URLSearchParams({
    fields: 'impressions,reach,clicks,spend,cpm,cpc,ctr,purchase_roas,actions,action_values',
    time_range: JSON.stringify({
      since: formatDate(daysAgo(60)),
      until: formatDate(daysAgo(31)),
    }),
    access_token: creds.access_token!,
  })) as Promise<FetchLike>);
  const previous = await prevRes.json();

  return { account, campaigns, previous };
}

async function fetchCampaigns(credentials: Creds, config: Record<string, unknown>): Promise<unknown> {
  const creds = await ensureFreshToken(credentials);
  const accountId = (config.adAccountId as string | undefined) || credentials.ad_account_id;
  if (!accountId) throw new Error('Meta Ads: adAccountId is required.');

  const res = await withRetry(() => fetch(`${GRAPH_BASE}/${accountId}/campaigns?` + new URLSearchParams({
    fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time',
    effective_status: JSON.stringify(['ACTIVE', 'PAUSED']),
    limit: '50',
    access_token: creds.access_token!,
  })) as Promise<FetchLike>);
  return res.json();
}

async function fetchAdSets(credentials: Creds, config: Record<string, unknown>): Promise<unknown> {
  const creds = await ensureFreshToken(credentials);
  const accountId = (config.adAccountId as string | undefined) || credentials.ad_account_id;
  if (!accountId) throw new Error('Meta Ads: adAccountId is required.');

  const res = await withRetry(() => fetch(`${GRAPH_BASE}/${accountId}/adsets?` + new URLSearchParams({
    fields: 'id,name,campaign_id,status,daily_budget,targeting,billing_event,optimization_goal',
    effective_status: JSON.stringify(['ACTIVE', 'PAUSED']),
    limit: '50',
    access_token: creds.access_token!,
  })) as Promise<FetchLike>);
  return res.json();
}

// ─── Connector interface ─────────────────────────────────────────────────────

const connector = {
  id: 'meta-ads' as const,
  name: 'Meta Ads',
  category: 'advertising',
  authType: 'oauth2_meta',
  icon: 'target',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    {
      id: 'adAccountId',
      label: 'Ad Account ID',
      type: 'text',
      required: true,
      hint: 'Format: act_XXXXXXXXXX — found in Meta Business Manager → Ad Accounts',
    },
  ],

  signalTypes: [
    'meta_roas_drop',
    'meta_cpm_spike',
    'meta_cpc_spike',
    'meta_spend_spike',
    'meta_reach_drop',
    'meta_campaign_failed',
    'meta_budget_exhausted',
    'meta_frequency_high',
  ],

  // ─── OAuth ────────────────────────────────────────────────────────────────

  async getAuthUrl(state: string): Promise<string> {
    const appId = process.env.META_APP_ID;
    if (!appId) throw new Error('META_APP_ID is not configured.');
    const redirectUri = process.env.META_REDIRECT_URI ||
      'http://localhost:4000/api/oauth/meta/callback';
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      response_type: 'code',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  /**
   * Exchange authorisation code for short-lived then long-lived token.
   * Returns: { access_token, token_expires_at, scope }
   */
  async exchangeCode(code: string): Promise<{ accessToken: string; expiresAt?: string; scope?: string }> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirectUri = process.env.META_REDIRECT_URI ||
      'http://localhost:4000/api/oauth/meta/callback';
    if (!appId || !appSecret) {
      throw new Error('META_APP_ID and META_APP_SECRET must be set.');
    }

    // 1) Short-lived token from code
    const shortRes = await fetch(`${GRAPH_BASE}/oauth/access_token?` + new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    }));
    if (!shortRes.ok) {
      const text = await shortRes.text();
      throw new Error(`Meta code exchange failed: ${text.substring(0, 300)}`);
    }
    const shortJson = await shortRes.json() as { access_token: string };

    // 2) Exchange for long-lived (60 days)
    const longRes = await fetch(`${GRAPH_BASE}/oauth/access_token?` + new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortJson.access_token,
    }));
    if (!longRes.ok) {
      const text = await longRes.text();
      throw new Error(`Meta long-lived exchange failed: ${text.substring(0, 300)}`);
    }
    const longJson = await longRes.json() as { access_token: string; expires_in?: number };

    const expiresIn = num(longJson.expires_in) || 60 * 24 * 60 * 60; // seconds
    return {
      accessToken: longJson.access_token,
      expiresAt: String(Date.now() + expiresIn * 1000),
      scope: SCOPES,
    };
  },

  async refreshToken(credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> {
    const refreshed = await ensureFreshToken({ ...credentials, token_expires_at: '0' });
    return {
      accessToken: refreshed.access_token!,
      expiresAt: refreshed.token_expires_at,
    };
  },

  // ─── Health check ─────────────────────────────────────────────────────────

  async healthCheck(credentials: Creds, config: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      const accountId = (config.adAccountId as string | undefined) || credentials?.ad_account_id;
      if (!accountId) {
        return { ok: false, error: 'Meta Ads: adAccountId not configured.' };
      }
      const creds = await ensureFreshToken(credentials);
      const res = await fetch(`${GRAPH_BASE}/${accountId}?` + new URLSearchParams({
        fields: 'id,name,account_status',
        access_token: creds.access_token!,
      }));
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `Meta API ${res.status}: ${body.substring(0, 200)}` };
      }
      const account = await res.json() as { name: string; id: string };
      return {
        ok: true,
        details: `Account ${account.name} (${account.id}) accessible.`,
        ...(creds.access_token !== credentials.access_token ? { refreshed_credentials: creds } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  // ─── Fetch (dispatcher) ──────────────────────────────────────────────────

  async fetch(dataType: string, credentials: Creds, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (dataType) {
      case 'account':   return fetchAccount(credentials, params);
      case 'campaigns': return fetchCampaigns(credentials, params);
      case 'adsets':    return fetchAdSets(credentials, params);
      case 'insights':
      case 'default':
      default:          return fetchInsights(credentials, params);
    }
  },

  // ─── Extract metrics ─────────────────────────────────────────────────────

  /**
   * Extract named metric rows from a fetched insights payload.
   * Called by the scheduler's sync loop (signature: extractMetrics(data, runAt)).
   * Returns array of { name, value, data }.
   */
  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    if (!data || typeof data !== 'object') return metrics;

    const d = data as {
      account?: { data?: Array<Record<string, unknown>> };
      previous?: { data?: Array<Record<string, unknown>> };
      campaigns?: { data?: Array<Record<string, unknown>> };
    };

    const current = d.account?.data?.[0] ?? {};
    const prev = d.previous?.data?.[0] ?? {};
    const campaignsData = d.campaigns?.data ?? [];

    const spend = num(current.spend);
    const revenue = getAction(current.action_values, 'purchase');
    const purchases = getAction(current.actions, 'purchase');
    const roas = spend > 0 ? revenue / spend : 0;

    const prevSpend = num(prev.spend);
    const prevRevenue = getAction(prev.action_values, 'purchase');
    const prevRoas = prevSpend > 0 ? prevRevenue / prevSpend : 0;

    metrics.push(
      { name: 'meta-ads.spend_30d',       value: spend,                          data: null },
      { name: 'meta-ads.revenue_30d',     value: revenue,                        data: null },
      { name: 'meta-ads.roas',            value: roas,                           data: null },
      { name: 'meta-ads.purchases_30d',   value: purchases,                      data: null },
      { name: 'meta-ads.impressions_30d', value: num(current.impressions),       data: null },
      { name: 'meta-ads.reach_30d',       value: num(current.reach),             data: null },
      { name: 'meta-ads.clicks_30d',      value: num(current.clicks),            data: null },
      { name: 'meta-ads.ctr',             value: num(current.ctr),               data: null },
      { name: 'meta-ads.cpm',             value: num(current.cpm),               data: null },
      { name: 'meta-ads.cpc',             value: num(current.cpc),               data: null },
      { name: 'meta-ads.frequency',       value: num(current.frequency),         data: null },
      { name: 'meta-ads.prev_spend_30d',  value: prevSpend,                      data: null },
      { name: 'meta-ads.prev_revenue_30d',value: prevRevenue,                    data: null },
      { name: 'meta-ads.prev_roas',       value: prevRoas,                       data: null },
      { name: 'meta-ads.prev_cpm',        value: num(prev.cpm),                  data: null },
      { name: 'meta-ads.prev_ctr',        value: num(prev.ctr),                  data: null },
    );

    if (campaignsData.length > 0) {
      metrics.push({
        name: 'meta-ads.campaigns_data',
        value: campaignsData.length,
        data: campaignsData.map(c => ({
          id: c.campaign_id,
          name: c.campaign_name,
          objective: c.objective,
          spend: num(c.spend),
          revenue: getAction(c.action_values, 'purchase'),
          purchases: getAction(c.actions, 'purchase'),
          impressions: num(c.impressions),
          reach: num(c.reach),
          clicks: num(c.clicks),
          ctr: num(c.ctr),
          cpm: num(c.cpm),
          cpc: num(c.cpc),
          roas: num(c.spend) > 0 ? getAction(c.action_values, 'purchase') / num(c.spend) : 0,
        })),
      });
    }

    return metrics;
  },
};

export default connector;
