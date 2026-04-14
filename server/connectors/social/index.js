/**
 * Facebook Pages + Instagram Business organic social connector.
 *
 * Reuses the Meta OAuth app (META_APP_ID / META_APP_SECRET) but requests
 * a different scope set than meta-ads. One connector row covers both
 * Facebook Pages and Instagram — either or both page IDs may be configured.
 *
 * Auth:   OAuth2 via Facebook Login (long-lived user token, 60 days)
 * API:    Graph API v19.0
 */
import fetch from 'node-fetch';

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';
const AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth';

const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'instagram_basic',
  'instagram_manage_insights',
  'business_management',
].join(',');

// ─── Helpers ────────────────────────────────────────────────────────────────

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function daysAgoUnix(n) {
  return Math.floor((Date.now() - n * 24 * 60 * 60 * 1000) / 1000);
}

function todayUnix() {
  return Math.floor(Date.now() / 1000);
}

async function withRetry(fn, { retries = 3, backoffMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fn();
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Graph API ${res.status}: ${text.substring(0, 300)}`);
        err.status = res.status;
        if (res.status === 429 || res.status >= 500) throw err;
        throw err;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1 && (err.status === 429 || err.status >= 500 || !err.status)) {
        await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, i)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function ensureFreshToken(credentials) {
  if (!credentials?.access_token) {
    throw new Error('Social: access_token missing. Re-authorise.');
  }
  const expiresAt = credentials.token_expires_at ?? 0;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (expiresAt > Date.now() + sevenDaysMs) return credentials;

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('Social: META_APP_ID/META_APP_SECRET required for token refresh.');
  }
  const url = `${GRAPH_BASE}/oauth/access_token?` + new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: credentials.access_token,
  });
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Social token refresh failed: ${(await res.text()).substring(0, 300)}`);
  }
  const json = await res.json();
  return {
    ...credentials,
    access_token: json.access_token,
    token_expires_at: Date.now() + (num(json.expires_in) || 60 * 24 * 60 * 60) * 1000,
  };
}

/**
 * Sum an array of insight data points: [{ value, end_time }] → total.
 */
function sumInsight(insightObj) {
  const values = insightObj?.values ?? [];
  return values.reduce((s, v) => s + num(v.value), 0);
}

function latestInsight(insightObj) {
  const values = insightObj?.values ?? [];
  return num(values[values.length - 1]?.value);
}

// ─── Connector ──────────────────────────────────────────────────────────────

const connector = {
  id: 'social',
  name: 'Facebook & Instagram',
  category: 'social',
  authType: 'oauth2',
  icon: 'share-2',

  capabilities: {
    read: true,
    write: false,
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

  async getAuthUrl(state) {
    const appId = process.env.META_APP_ID;
    if (!appId) throw new Error('META_APP_ID is not configured.');
    const redirectUri = process.env.SOCIAL_REDIRECT_URI
      || process.env.META_REDIRECT_URI?.replace('/meta/callback', '/social/callback')
      || 'http://localhost:4000/api/oauth/social/callback';
    return `${AUTH_URL}?` + new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      response_type: 'code',
      state,
    });
  },

  async exchangeCode(code) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirectUri = process.env.SOCIAL_REDIRECT_URI
      || process.env.META_REDIRECT_URI?.replace('/meta/callback', '/social/callback')
      || 'http://localhost:4000/api/oauth/social/callback';
    if (!appId || !appSecret) {
      throw new Error('META_APP_ID and META_APP_SECRET must be set.');
    }

    const shortRes = await fetch(`${GRAPH_BASE}/oauth/access_token?` + new URLSearchParams({
      client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code,
    }));
    if (!shortRes.ok) throw new Error(`Social code exchange failed: ${(await shortRes.text()).substring(0, 300)}`);
    const shortJson = await shortRes.json();

    const longRes = await fetch(`${GRAPH_BASE}/oauth/access_token?` + new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortJson.access_token,
    }));
    if (!longRes.ok) throw new Error(`Social long-token exchange failed: ${(await longRes.text()).substring(0, 300)}`);
    const longJson = await longRes.json();

    return {
      access_token: longJson.access_token,
      token_expires_at: Date.now() + (num(longJson.expires_in) || 60 * 24 * 60 * 60) * 1000,
      scope: SCOPES,
    };
  },

  async refreshToken(credentials) {
    return ensureFreshToken({ ...credentials, token_expires_at: 0 });
  },

  async healthCheck(credentials, config = {}) {
    try {
      const creds = await ensureFreshToken(credentials);
      const fbId = config.facebookPageId || credentials?.facebookPageId;
      const igId = config.instagramAccountId || credentials?.instagramAccountId;
      if (!fbId && !igId) {
        return { ok: false, error: 'At least one of Facebook Page ID or Instagram Account ID must be configured.' };
      }
      if (fbId) {
        const res = await fetch(`${GRAPH_BASE}/${fbId}?` + new URLSearchParams({
          fields: 'name,fan_count', access_token: creds.access_token,
        }));
        if (!res.ok) return { ok: false, error: `Facebook Page ${fbId}: ${(await res.text()).substring(0, 200)}` };
      }
      if (igId) {
        const res = await fetch(`${GRAPH_BASE}/${igId}?` + new URLSearchParams({
          fields: 'name,followers_count', access_token: creds.access_token,
        }));
        if (!res.ok) return { ok: false, error: `Instagram ${igId}: ${(await res.text()).substring(0, 200)}` };
      }
      return {
        ok: true,
        details: { facebook: !!fbId, instagram: !!igId },
        refreshed_credentials: creds.access_token !== credentials.access_token ? creds : undefined,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, params = {}) {
    const creds = await ensureFreshToken(credentials);
    const fbId = params?.facebookPageId || credentials?.facebookPageId;
    const igId = params?.instagramAccountId || credentials?.instagramAccountId;
    const token = creds.access_token;

    const since = daysAgoUnix(30);
    const until = todayUnix();

    const out = { facebook: null, instagram: null, fetchedAt: new Date().toISOString() };

    // ─── Facebook Page ────────────────────────────────────────────────────
    if (fbId) {
      try {
        const [pageRes, insightsRes, postsRes] = await Promise.all([
          withRetry(() => fetch(`${GRAPH_BASE}/${fbId}?` + new URLSearchParams({
            fields: 'name,fan_count,followers_count', access_token: token,
          }))),
          withRetry(() => fetch(`${GRAPH_BASE}/${fbId}/insights?` + new URLSearchParams({
            metric: 'page_impressions,page_impressions_unique,page_post_engagements,page_views_total,page_video_views',
            period: 'day', since, until, access_token: token,
          })).catch(() => null)),
          withRetry(() => fetch(`${GRAPH_BASE}/${fbId}/posts?` + new URLSearchParams({
            fields: 'id,message,created_time,permalink_url,shares',
            limit: '25', access_token: token,
          }))),
        ]);

        const page = await pageRes.json();
        const insights = insightsRes ? await insightsRes.json() : { data: [] };
        const postsBody = await postsRes.json();
        const posts = postsBody?.data ?? [];

        // Per-post insights (best-effort)
        const postStats = [];
        for (const p of posts.slice(0, 15)) {
          try {
            const piRes = await fetch(`${GRAPH_BASE}/${p.id}/insights?` + new URLSearchParams({
              metric: 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_total',
              access_token: token,
            }));
            if (!piRes.ok) continue;
            const pi = await piRes.json();
            const findMetric = (n) => pi.data?.find((d) => d.name === n)?.values?.[0]?.value ?? 0;
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

        const getMetric = (n) => insights.data?.find((d) => d.name === n);

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
        console.warn('[social] facebook fetch failed:', err.message);
      }
    }

    // ─── Instagram ────────────────────────────────────────────────────────
    if (igId) {
      try {
        const [igRes, insightsRes, mediaRes] = await Promise.all([
          withRetry(() => fetch(`${GRAPH_BASE}/${igId}?` + new URLSearchParams({
            fields: 'name,username,followers_count,media_count', access_token: token,
          }))),
          withRetry(() => fetch(`${GRAPH_BASE}/${igId}/insights?` + new URLSearchParams({
            metric: 'impressions,reach,profile_views,website_clicks',
            period: 'day', since, until, access_token: token,
          })).catch(() => null)),
          withRetry(() => fetch(`${GRAPH_BASE}/${igId}/media?` + new URLSearchParams({
            fields: 'id,caption,media_type,timestamp,permalink',
            limit: '30', access_token: token,
          }))),
        ]);

        const ig = await igRes.json();
        const insights = insightsRes ? await insightsRes.json() : { data: [] };
        const mediaBody = await mediaRes.json();
        const media = mediaBody?.data ?? [];

        const mediaStats = [];
        for (const m of media.slice(0, 20)) {
          try {
            const miRes = await fetch(`${GRAPH_BASE}/${m.id}/insights?` + new URLSearchParams({
              metric: m.media_type === 'VIDEO' ? 'reach,likes,comments,shares,saved,video_views'
                                               : 'reach,likes,comments,shares,saved',
              access_token: token,
            }));
            if (!miRes.ok) continue;
            const mi = await miRes.json();
            const findMetric = (n) => mi.data?.find((d) => d.name === n)?.values?.[0]?.value ?? 0;
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

        const getMetric = (n) => insights.data?.find((d) => d.name === n);

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
        console.warn('[social] instagram fetch failed:', err.message);
      }
    }

    return out;
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const round = (n, p = 4) => Math.round(n * 10 ** p) / 10 ** p;

    // ─── Facebook metrics ─────────────────────────────────────────────────
    if (data?.facebook) {
      const fb = data.facebook;
      const postsArr = Array.isArray(fb.posts) ? fb.posts : [];
      const avgPostReach = postsArr.length > 0
        ? Math.round(postsArr.reduce((s, p) => s + p.reach, 0) / postsArr.length)
        : 0;
      const avgPostEngagement = postsArr.length > 0
        ? Math.round(postsArr.reduce((s, p) => s + p.engaged_users, 0) / postsArr.length)
        : 0;
      const engagementRate = fb.reach_30d > 0 ? round(fb.engagements_30d / fb.reach_30d, 4) : 0;
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
    if (data?.instagram) {
      const ig = data.instagram;
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
