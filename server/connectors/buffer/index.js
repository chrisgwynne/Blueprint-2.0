/**
 * Buffer connector — OAuth2 auth.
 *
 * Docs:  https://buffer.com/developers/api
 * Base:  https://api.bufferapp.com/1/
 *
 * Buffer schedules posts across social platforms. This connector gives
 * Blueprint visibility of the publishing queue + past performance, so the
 * brain can correlate traffic/social movement with specific post timings.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

const BASE = 'https://api.bufferapp.com/1';
const AUTH_BASE = 'https://bufferapp.com/oauth2/authorize';
const TOKEN_URL = 'https://api.bufferapp.com/1/oauth2/token.json';

function bufferFetch(endpoint, accessToken, init = {}) {
  const url = new URL(`${BASE}${endpoint}`);
  // Buffer accepts access_token as a query param on all endpoints.
  url.searchParams.set('access_token', accessToken);
  return checkedFetch(url.toString(), init);
}

const connector = {
  id: 'buffer',
  name: 'Buffer',
  category: 'social',
  authType: 'oauth2',
  icon: 'calendar',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 120, // 2h — schedule changes a few times a day
  },

  configFields: [],  // credentials captured via OAuth flow

  signalTypes: [
    'buffer_queue_empty',
    'buffer_posting_gap',
    'buffer_low_engagement',
    'buffer_content_opportunity',
    'buffer_schedule_ahead',
  ],

  async healthCheck(credentials) {
    try {
      if (!credentials?.accessToken) return { ok: false, error: 'Access token missing.' };
      const res = await withRetry(
        () => bufferFetch('/user.json', credentials.accessToken),
        { label: 'Buffer healthCheck' }
      );
      const data = await res.json();
      return {
        ok: true,
        details: { name: data?.name ?? null, email: data?.email ?? null },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async getAuthUrl(state) {
    const clientId = process.env.BUFFER_CLIENT_ID;
    if (!clientId) throw new Error('BUFFER_CLIENT_ID env var not set.');
    const redirectUri = process.env.BUFFER_REDIRECT_URI
      || 'http://localhost:4000/api/oauth/buffer/callback';
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: state ?? '',
    });
    return `${AUTH_BASE}?${params.toString()}`;
  },

  async exchangeCode(code) {
    const clientId = process.env.BUFFER_CLIENT_ID;
    const clientSecret = process.env.BUFFER_CLIENT_SECRET;
    const redirectUri = process.env.BUFFER_REDIRECT_URI
      || 'http://localhost:4000/api/oauth/buffer/callback';
    if (!clientId || !clientSecret) {
      throw new Error('BUFFER_CLIENT_ID and BUFFER_CLIENT_SECRET must be set.');
    }
    const res = await checkedFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await res.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: null, // Buffer tokens don't expire
      expiresAt: null,
    };
  },

  async refreshToken(credentials) {
    return credentials;
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.accessToken) throw new Error('Buffer access token is required.');
    const token = credentials.accessToken;

    // 1. Connected profiles
    let profiles = [];
    try {
      const res = await withRetry(
        () => bufferFetch('/profiles.json', token),
        { label: 'Buffer profiles' }
      );
      const body = await res.json();
      profiles = Array.isArray(body) ? body : [];
    } catch (err) {
      console.warn('[buffer] profiles fetch failed:', err.message);
    }

    // 2. Per-profile: sent + pending updates
    const sentUpdates = [];
    const pendingUpdates = [];
    for (const p of profiles) {
      try {
        const [sentRes, pendRes] = await Promise.all([
          withRetry(
            () => bufferFetch(`/profiles/${p.id}/updates/sent.json?count=50&page=1`, token),
            { label: `Buffer sent ${p.service}` }
          ),
          withRetry(
            () => bufferFetch(`/profiles/${p.id}/updates/pending.json?count=50`, token),
            { label: `Buffer pending ${p.service}` }
          ),
        ]);
        const sentBody = await sentRes.json();
        const pendBody = await pendRes.json();
        const sent = (sentBody?.updates ?? []).map((u) => ({
          ...u, profile_id: p.id, service: p.service, service_username: p.service_username,
        }));
        const pend = (pendBody?.updates ?? []).map((u) => ({
          ...u, profile_id: p.id, service: p.service, service_username: p.service_username,
        }));
        sentUpdates.push(...sent);
        pendingUpdates.push(...pend);
      } catch (err) {
        console.warn(`[buffer] updates fetch for ${p.service} failed:`, err.message);
      }
    }

    return {
      profiles: profiles.map((p) => ({
        id: p.id,
        service: p.service,
        service_username: p.service_username,
        followers: p.statistics?.followers ?? null,
      })),
      sentUpdates,
      pendingUpdates,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const sent = Array.isArray(data?.sentUpdates) ? data.sentUpdates : [];
    const pending = Array.isArray(data?.pendingUpdates) ? data.pendingUpdates : [];

    const last30Epoch = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const last7Epoch = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

    const sent30 = sent.filter((u) => (u.sent_at ?? u.created_at ?? 0) >= last30Epoch);
    const sent7 = sent.filter((u) => (u.sent_at ?? u.created_at ?? 0) >= last7Epoch);

    // Engagement = reach + clicks + favorites + retweets + comments + shares
    const engagement = (u) => {
      const s = u.statistics ?? {};
      return (s.reach ?? 0) + (s.clicks ?? 0) + (s.favorites ?? 0)
           + (s.retweets ?? 0) + (s.comments ?? 0) + (s.shares ?? 0)
           + (s.mentions ?? 0);
    };

    const engSum30 = sent30.reduce((s, u) => s + engagement(u), 0);
    const clickSum30 = sent30.reduce((s, u) => s + (u.statistics?.clicks ?? 0), 0);
    const avgEng = sent30.length > 0 ? Math.round(engSum30 / sent30.length) : 0;
    const avgClicks = sent30.length > 0 ? Math.round(clickSum30 / sent30.length * 10) / 10 : 0;

    // Per-platform breakdown
    const byPlatform = {};
    for (const u of sent30) {
      const key = u.service || 'unknown';
      if (!byPlatform[key]) byPlatform[key] = { count: 0, eng: 0 };
      byPlatform[key].count++;
      byPlatform[key].eng += engagement(u);
    }

    let topPlatform = null;
    let topAvg = 0;
    for (const [platform, stats] of Object.entries(byPlatform)) {
      const avg = stats.count > 0 ? stats.eng / stats.count : 0;
      if (avg > topAvg) { topAvg = avg; topPlatform = platform; }
    }

    const nextPost = pending
      .map((u) => u.due_at ?? u.scheduled_at)
      .filter(Boolean)
      .sort((a, b) => a - b)[0] ?? null;
    const nextPostIso = nextPost ? new Date(nextPost * 1000).toISOString() : null;

    metrics.push(
      { name: 'buffer.profiles_connected',     value: profiles.length, data: null },
      { name: 'buffer.posts_published_30d',    value: sent30.length, data: null },
      { name: 'buffer.posts_scheduled_pending', value: pending.length, data: null },
      { name: 'buffer.avg_post_engagement_30d', value: avgEng, data: null },
      { name: 'buffer.avg_clicks_per_post',    value: avgClicks, data: null },
      { name: 'buffer.top_performing_platform', value: topPlatform ?? 0, data: { platform: topPlatform, avg_engagement: Math.round(topAvg) } },
      { name: 'buffer.posting_frequency_7d',   value: sent7.length, data: null },
      { name: 'buffer.next_scheduled_post',    value: nextPost ?? 0, data: { iso: nextPostIso } },
    );

    // Per-platform metric rows
    for (const [platform, stats] of Object.entries(byPlatform)) {
      metrics.push(
        { name: `buffer.${platform}_posts_30d`, value: stats.count, data: null },
        {
          name: `buffer.${platform}_avg_engagement`,
          value: stats.count > 0 ? Math.round(stats.eng / stats.count) : 0,
          data: null,
        },
      );
    }

    // Rich data
    metrics.push(
      { name: 'buffer.profiles_data',      value: profiles.length, data: profiles },
      {
        name: 'buffer.scheduled_queue',
        value: pending.length,
        data: pending
          .sort((a, b) => (a.due_at ?? 0) - (b.due_at ?? 0))
          .slice(0, 50)
          .map((u) => ({
            id: u.id,
            text: (u.text || '').slice(0, 200),
            scheduled_at: u.due_at,
            scheduled_at_iso: u.due_at ? new Date(u.due_at * 1000).toISOString() : null,
            service: u.service,
            service_username: u.service_username,
            media: u.media ?? null,
          })),
      },
      {
        name: 'buffer.recent_posts_data',
        value: sent30.length,
        data: sent30.slice(0, 50).map((u) => ({
          id: u.id,
          text: (u.text || '').slice(0, 200),
          sent_at: u.sent_at ?? u.created_at,
          sent_at_iso: u.sent_at ? new Date(u.sent_at * 1000).toISOString() : null,
          service: u.service,
          service_username: u.service_username,
          reach: u.statistics?.reach ?? 0,
          clicks: u.statistics?.clicks ?? 0,
          engagement: engagement(u),
        })),
      },
    );

    return metrics;
  },
};

export default connector;
