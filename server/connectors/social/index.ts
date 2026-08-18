/**
 * Facebook Pages + Instagram Business organic social connector.
 *
 * Reuses the Meta OAuth app (META_APP_ID / META_APP_SECRET) but requests
 * a different scope set than meta-ads. One connector row covers both
 * Facebook Pages and Instagram — either or both page IDs may be configured.
 *
 * Auth:   OAuth2 via Facebook Login (long-lived user token, 60 days)
 * API:    Graph API — version controlled via META_GRAPH_VERSION (default v25.0).
 *         Hard-coded v19.0 removed: issue #35 fix.
 *
 * Capabilities:
 *   read  — fetch page/IG metrics and post history
 *   write — publish posts via the publishing sub-module (see connectors/social/publishing.ts)
 *
 * Credential normalization:
 *   Stored in camelCase (accessToken / expiresAt) per ConnectorInterface contract.
 *   Legacy snake_case fields (access_token / token_expires_at) are read for backward
 *   compatibility and migrated to camelCase on first access.
 */
import fetch from 'node-fetch';
import { DEFAULT_GRAPH_VERSION, GRAPH_VERSIONS } from './graph-client.js';

type Creds = Record<string, string | undefined>;

function getGraphVersion(): string {
  const v = process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  if (!GRAPH_VERSIONS.includes(v as any)) {
    console.warn(`[social] META_GRAPH_VERSION "${v}" is not in the supported list. Using default ${DEFAULT_GRAPH_VERSION}.`);
    return DEFAULT_GRAPH_VERSION;
  }
  return v;
}

function graphBase(): string {
  return `https://graph.facebook.com/${getGraphVersion()}`;
}

function authUrl(): string {
  return `https://www.facebook.com/${getGraphVersion()}/dialog/oauth`;
}

// ─── Credential normalization ────────────────────────────────────────────────
// Stored as camelCase (accessToken, expiresAt) per ConnectorInterface.
// Legacy snake_case (access_token, token_expires_at) read for backward compat.

function normalizeToken(creds: Creds): string | undefined {
  return creds.accessToken || creds.access_token;
}

function normalizeExpiresAt(creds: Creds): number {
  return Number(creds.expiresAt || creds.token_expires_at || 0);
}

// Read scope: what this connector requests for analytics/insights
const READ_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'business_management',
];

// Write scope: additional permissions for content publishing
const WRITE_SCOPES = [
  'pages_manage_posts',
  'pages_manage_metadata',
];

const ALL_SCOPES = [...READ_SCOPES, ...WRITE_SCOPES].join(',');

// ─── Helpers ────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : 0;
}

function daysAgoUnix(n: number): number {
  return Math.floor((Date.now() - n * 24 * 60 * 60 * 1000) / 1000);
}

function todayUnix(): number {
  return Math.floor(Date.now() / 1000);
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
        const err: RetryError = new Error(`Graph API ${res.status}: ${text.substring(0, 300)}`);
        err.status = res.status;
        if (res.status === 429 || res.status >= 500) throw err;
        throw err;
      }
      return res;
    } catch (err) {
      lastErr = err as RetryError;
      if (i < retries - 1 && (lastErr.status === 429 || (lastErr.status !== undefined && lastErr.status >= 500) || !lastErr.status)) {
        await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, i)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function ensureFreshToken(credentials: Creds): Promise<Creds> {
  const token = normalizeToken(credentials);
  if (!token) {
    throw new Error('Social: access token missing. Re-authorise the connector.');
  }
  const expiresAt = normalizeExpiresAt(credentials);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (expiresAt > Date.now() + sevenDaysMs) return credentials;

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('Social: META_APP_ID/META_APP_SECRET required for token refresh. Re-authorise if refresh is unavailable.');
  }
  const url = `${graphBase()}/oauth/access_token?` + new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: token,
  });
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Social token refresh failed (status ${res.status}). Re-authorise the connector.`);
  }
  const json = await res.json() as { access_token: string; expires_in?: number };
  const newExpiresAt = String(Date.now() + (num(json.expires_in) || 60 * 24 * 60 * 60) * 1000);
  // Return normalized camelCase AND preserve legacy keys for backward compat
  return {
    ...credentials,
    accessToken: json.access_token,
    expiresAt: newExpiresAt,
    // Preserve snake_case aliases for any legacy consumer
    access_token: json.access_token,
    token_expires_at: newExpiresAt,
  };
}

interface InsightObj {
  values?: Array<{ value: unknown; end_time?: string }>;
}

/**
 * Sum an array of insight data points: [{ value, end_time }] → total.
 */
function sumInsight(insightObj: InsightObj | undefined): number {
  const values = insightObj?.values ?? [];
  return values.reduce((s, v) => s + num(v.value), 0);
}

function latestInsight(insightObj: InsightObj | undefined): number {
  const values = insightObj?.values ?? [];
  return num(values[values.length - 1]?.value);
}

// ─── Connector ──────────────────────────────────────────────────────────────

const connector = {
  id: 'social' as const,
  name: 'Facebook & Instagram',
  category: 'social',
  authType: 'oauth2',
  icon: 'share-2',

  capabilities: {
    read: true,
    write: true, // Facebook Pages + Instagram publishing via publishing.ts
    webhooks: false,
    pollingIntervalMinutes: 360, // 6h
  },

  configFields: [
    {
      id: 'facebookPageId',
      label: 'Facebook Page ID',
      type: 'text',
      required: false,
      hint: 'Facebook Page → About → Page ID. Leave blank if not using Facebook.',
    },
    {
      id: 'instagramAccountId',
      label: 'Instagram Business Account ID',
      type: 'text',
      required: false,
      hint: 'Instagram → Settings → Account → Linked Accounts. Must be a Business account.',
    },
  ],

  signalTypes: [
    'fb_reach_drop',
    'ig_follower_loss',
    'ig_engagement_drop',
    'social_posting_gap',
    'ig_website_clicks_opportunity',
    'fb_high_performing_post',
  ],

  async getAuthUrl(state: string): Promise<string> {
    const appId = process.env.META_APP_ID;
    if (!appId) throw new Error('META_APP_ID is not configured. Add it to your environment variables.');
    const redirectUri = process.env.SOCIAL_REDIRECT_URI
      || process.env.META_REDIRECT_URI?.replace('/meta/callback', '/social/callback')
      || `http://localhost:${process.env.PORT || 4000}/api/oauth/social/callback`;
    return `${authUrl()}?` + new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: ALL_SCOPES,
      response_type: 'code',
      state,
    });
  },

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirectUri = process.env.SOCIAL_REDIRECT_URI
      || process.env.META_REDIRECT_URI?.replace('/meta/callback', '/social/callback')
      || `http://localhost:${process.env.PORT || 4000}/api/oauth/social/callback`;
    if (!appId || !appSecret) {
      throw new Error('META_APP_ID and META_APP_SECRET must be set to exchange OAuth codes.');
    }

    const shortRes = await fetch(`${graphBase()}/oauth/access_token?` + new URLSearchParams({
      client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code,
    }));
    if (!shortRes.ok) {
      throw new Error(`Social code exchange failed (${shortRes.status}). Check redirect URI matches the app configuration.`);
    }
    const shortJson = await shortRes.json() as { access_token: string };

    const longRes = await fetch(`${graphBase()}/oauth/access_token?` + new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortJson.access_token,
    }));
    if (!longRes.ok) {
      throw new Error(`Social long-lived token exchange failed (${longRes.status}).`);
    }
    const longJson = await longRes.json() as { access_token: string; expires_in?: number };
    const expiresAt = String(Date.now() + (num(longJson.expires_in) || 60 * 24 * 60 * 60) * 1000);

    return {
      accessToken: longJson.access_token,
      expiresAt,
      scope: ALL_SCOPES,
    };
  },

  async refreshToken(credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> {
    // Force refresh by temporarily zeroing out the expiry
    const forceExpired = { ...credentials, accessToken: undefined, expiresAt: '0', token_expires_at: '0' };
    const refreshed = await ensureFreshToken(forceExpired);
    return {
      accessToken: normalizeToken(refreshed)!,
      expiresAt: refreshed.expiresAt || refreshed.token_expires_at,
    };
  },

  async healthCheck(credentials: Creds, config: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      const creds = await ensureFreshToken(credentials);
      const token = normalizeToken(creds)!;
      const fbId = (config.facebookPageId as string | undefined) || credentials?.facebookPageId;
      const igId = (config.instagramAccountId as string | undefined) || credentials?.instagramAccountId;
      if (!fbId && !igId) {
        return { ok: false, error: 'At least one of Facebook Page ID or Instagram Account ID must be configured.' };
      }
      if (fbId) {
        const res = await fetch(`${graphBase()}/${fbId}?` + new URLSearchParams({
          fields: 'name,fan_count', access_token: token,
        }));
        if (!res.ok) return { ok: false, error: `Facebook Page ${fbId} health check failed.` };
      }
      if (igId) {
        const res = await fetch(`${graphBase()}/${igId}?` + new URLSearchParams({
          fields: 'name,followers_count', access_token: token,
        }));
        if (!res.ok) return { ok: false, error: `Instagram account ${igId} health check failed.` };
      }
      const tokenRefreshed = normalizeToken(creds) !== normalizeToken(credentials);
      return {
        ok: true,
        details: { facebook: !!fbId, instagram: !!igId, graphVersion: getGraphVersion() },
        ...(tokenRefreshed ? { refreshed_credentials: creds } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(_dataType: string, credentials: Creds, params: Record<string, unknown> = {}): Promise<unknown> {
    const creds = await ensureFreshToken(credentials);
    const fbId = (params?.facebookPageId as string | undefined) || credentials?.facebookPageId;
    const igId = (params?.instagramAccountId as string | undefined) || credentials?.instagramAccountId;
    const token = normalizeToken(creds)!;

    const since = daysAgoUnix(30);
    const until = todayUnix();

    const out: {
      facebook: null | Record<string, unknown>;
      instagram: null | Record<string, unknown>;
      fetchedAt: string;
    } = { facebook: null, instagram: null, fetchedAt: new Date().toISOString() };

    // ─── Facebook Page ────────────────────────────────────────────────────
    if (fbId) {
      try {
        const [pageRes, insightsRes, postsRes] = await Promise.all([
          withRetry(() => fetch(`${graphBase()}/${fbId}?` + new URLSearchParams({
            fields: 'name,fan_count,followers_count', access_token: token,
          })) as Promise<FetchLike>),
          withRetry(() => fetch(`${graphBase()}/${fbId}/insights?` + new URLSearchParams({
            metric: 'page_impressions,page_impressions_unique,page_post_engagements,page_views_total,page_video_views',
            period: 'day', since: String(since), until: String(until), access_token: token,
          })) as Promise<FetchLike>).catch(() => null),
          withRetry(() => fetch(`${graphBase()}/${fbId}/posts?` + new URLSearchParams({
            fields: 'id,message,created_time,permalink_url,shares',
            limit: '25', access_token: token,
          })) as Promise<FetchLike>),
        ]);

        const page = await pageRes.json() as { name: string; fan_count?: number; followers_count?: number };
        const insights = insightsRes ? await insightsRes.json() as { data?: Array<{ name: string } & InsightObj> } : { data: [] };
        const postsBody = await postsRes.json() as { data?: Array<{ id: string; message?: string; created_time: string; permalink_url: string; shares?: { count: number } }> };
        const posts = postsBody?.data ?? [];

        // Per-post insights (best-effort)
        const postStats: Array<Record<string, unknown>> = [];
        for (const p of posts.slice(0, 15)) {
          try {
            const piRes = await fetch(`${graphBase()}/${p.id}/insights?` + new URLSearchParams({
              metric: 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_total',
              access_token: token,
            }));
            if (!piRes.ok) continue;
            const pi = await piRes.json() as { data?: Array<{ name: string; values?: Array<{ value: unknown }> }> };
            const findMetric = (n: string) => pi.data?.find((d) => d.name === n)?.values?.[0]?.value ?? 0;
            postStats.push({
              id: p.id,
              message: (p.message || '').slice(0, 200),
              created_time: p.created_time,
              permalink_url: p.permalink_url,
              shares: num(p.shares?.count),
              impressions: num(findMetric('post_impressions')),
              reach: num(findMetric('post_impressions_unique')),
              engaged_users: num(findMetric('post_engaged_users')),
              clicks: num(findMetric('post_clicks')),
              reactions: num(findMetric('post_reactions_total')),
            });
          } catch {}
        }

        const getMetric = (n: string) => insights.data?.find((d) => d.name === n);

        out.facebook = {
          page_id: fbId,
          name: page.name,
          followers: num(page.fan_count ?? page.followers_count),
          impressions_30d: sumInsight(getMetric('page_impressions')),
          reach_30d: sumInsight(getMetric('page_impressions_unique')),
          engagements_30d: sumInsight(getMetric('page_post_engagements')),
          views_30d: sumInsight(getMetric('page_views_total')),
          video_views_30d: sumInsight(getMetric('page_video_views')),
          posts: postStats,
        };
      } catch (err) {
        console.warn('[social] facebook fetch failed:', (err as Error).message);
      }
    }

    // ─── Instagram ────────────────────────────────────────────────────────
    if (igId) {
      try {
        const [igRes, insightsRes, mediaRes] = await Promise.all([
          withRetry(() => fetch(`${graphBase()}/${igId}?` + new URLSearchParams({
            fields: 'name,username,followers_count,media_count', access_token: token,
          })) as Promise<FetchLike>),
          withRetry(() => fetch(`${graphBase()}/${igId}/insights?` + new URLSearchParams({
            metric: 'impressions,reach,profile_views,website_clicks',
            period: 'day', since: String(since), until: String(until), access_token: token,
          })) as Promise<FetchLike>).catch(() => null),
          withRetry(() => fetch(`${graphBase()}/${igId}/media?` + new URLSearchParams({
            fields: 'id,caption,media_type,timestamp,permalink',
            limit: '30', access_token: token,
          })) as Promise<FetchLike>),
        ]);

        const ig = await igRes.json() as { name: string; username: string; followers_count?: number; media_count?: number };
        const insights = insightsRes ? await insightsRes.json() as { data?: Array<{ name: string } & InsightObj> } : { data: [] };
        const mediaBody = await mediaRes.json() as { data?: Array<{ id: string; caption?: string; media_type: string; timestamp: string; permalink: string }> };
        const media = mediaBody?.data ?? [];

        const mediaStats: Array<Record<string, unknown>> = [];
        for (const m of media.slice(0, 20)) {
          try {
            const miRes = await fetch(`${graphBase()}/${m.id}/insights?` + new URLSearchParams({
              metric: m.media_type === 'VIDEO' ? 'reach,likes,comments,shares,saved,video_views'
                                               : 'reach,likes,comments,shares,saved',
              access_token: token,
            }));
            if (!miRes.ok) continue;
            const mi = await miRes.json() as { data?: Array<{ name: string; values?: Array<{ value: unknown }> }> };
            const findMetric = (n: string) => mi.data?.find((d) => d.name === n)?.values?.[0]?.value ?? 0;
            mediaStats.push({
              id: m.id,
              caption: (m.caption || '').slice(0, 200),
              media_type: m.media_type,
              timestamp: m.timestamp,
              permalink: m.permalink,
              reach: num(findMetric('reach')),
              likes: num(findMetric('likes')),
              comments: num(findMetric('comments')),
              shares: num(findMetric('shares')),
              saved: num(findMetric('saved')),
              video_views: num(findMetric('video_views')),
            });
          } catch {}
        }

        const getMetric = (n: string) => insights.data?.find((d) => d.name === n);

        out.instagram = {
          ig_id: igId,
          name: ig.name,
          username: ig.username,
          followers: num(ig.followers_count),
          media_count: num(ig.media_count),
          impressions_30d: sumInsight(getMetric('impressions')),
          reach_30d: sumInsight(getMetric('reach')),
          profile_views_30d: sumInsight(getMetric('profile_views')),
          website_clicks_30d: sumInsight(getMetric('website_clicks')),
          media: mediaStats,
        };
      } catch (err) {
        console.warn('[social] instagram fetch failed:', (err as Error).message);
      }
    }

    return out;
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const round = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p;

    const d = data as {
      facebook?: {
        followers?: number;
        reach_30d?: number;
        impressions_30d?: number;
        engagements_30d?: number;
        views_30d?: number;
        posts?: Array<{ reach: number; engaged_users: number }>;
      };
      instagram?: {
        followers?: number;
        reach_30d?: number;
        impressions_30d?: number;
        profile_views_30d?: number;
        website_clicks_30d?: number;
        media?: Array<{ reach: number; likes: number; comments: number; saved: number; shares: number; media_type: string; video_views: number }>;
      };
    } | null;

    // ─── Facebook metrics ─────────────────────────────────────────────────
    if (d?.facebook) {
      const fb = d.facebook;
      const postsArr = Array.isArray(fb.posts) ? fb.posts : [];
      const avgPostReach = postsArr.length > 0
        ? Math.round(postsArr.reduce((s, p) => s + p.reach, 0) / postsArr.length)
        : 0;
      const avgPostEngagement = postsArr.length > 0
        ? Math.round(postsArr.reduce((s, p) => s + p.engaged_users, 0) / postsArr.length)
        : 0;
      const engagementRate = (fb.reach_30d ?? 0) > 0 ? round((fb.engagements_30d ?? 0) / fb.reach_30d!, 4) : 0;
      const topPostReach = postsArr.reduce((m, p) => Math.max(m, p.reach), 0);

      metrics.push(
        { name: 'fb.page_followers',            value: fb.followers ?? 0, data: null },
        { name: 'fb.page_reach_30d',            value: fb.reach_30d ?? 0, data: null },
        { name: 'fb.page_impressions_30d',      value: fb.impressions_30d ?? 0, data: null },
        { name: 'fb.page_engaged_users_30d',    value: fb.engagements_30d ?? 0, data: null },
        { name: 'fb.page_engagement_rate',      value: engagementRate, data: null },
        { name: 'fb.page_views_30d',            value: fb.views_30d ?? 0, data: null },
        { name: 'fb.posts_published_30d',       value: postsArr.length, data: null },
        { name: 'fb.avg_post_reach',            value: avgPostReach, data: null },
        { name: 'fb.avg_post_engagement',       value: avgPostEngagement, data: null },
        { name: 'fb.top_post_reach',            value: topPostReach, data: null },
        { name: 'fb.recent_posts_data',         value: postsArr.length, data: postsArr },
      );
    }

    // ─── Instagram metrics ────────────────────────────────────────────────
    if (d?.instagram) {
      const ig = d.instagram;
      const mediaArr = Array.isArray(ig.media) ? ig.media : [];
      const avgReach = mediaArr.length > 0
        ? Math.round(mediaArr.reduce((s, m) => s + m.reach, 0) / mediaArr.length)
        : 0;
      // Engagement per post = (likes + comments + saved + shares) / reach
      const engagementRates = mediaArr
        .filter((m) => m.reach > 0)
        .map((m) => (m.likes + m.comments + m.saved + m.shares) / m.reach);
      const avgEngagementRate = engagementRates.length > 0
        ? round(engagementRates.reduce((s, r) => s + r, 0) / engagementRates.length, 4)
        : 0;
      const reels = mediaArr.filter((m) => m.media_type === 'VIDEO');
      const avgReelViews = reels.length > 0
        ? Math.round(reels.reduce((s, m) => s + m.video_views, 0) / reels.length)
        : 0;

      metrics.push(
        { name: 'ig.followers',                 value: ig.followers ?? 0, data: null },
        { name: 'ig.reach_30d',                 value: ig.reach_30d ?? 0, data: null },
        { name: 'ig.impressions_30d',           value: ig.impressions_30d ?? 0, data: null },
        { name: 'ig.profile_views_30d',         value: ig.profile_views_30d ?? 0, data: null },
        { name: 'ig.website_clicks_30d',        value: ig.website_clicks_30d ?? 0, data: null },
        { name: 'ig.posts_published_30d',       value: mediaArr.length, data: null },
        { name: 'ig.avg_post_reach',            value: avgReach, data: null },
        { name: 'ig.avg_post_engagement_rate',  value: avgEngagementRate, data: null },
        { name: 'ig.avg_reel_views',            value: avgReelViews, data: null },
        { name: 'ig.recent_posts_data',         value: mediaArr.length, data: mediaArr },
      );
      // follower_growth_30d — requires prior value; left to the metrics
      // table time-series query to derive (current - 30-day-prior).
      metrics.push({ name: 'ig.follower_growth_30d', value: 0, data: { note: 'derived from time series' } });
    }

    return metrics;
  },
};

export default connector;
