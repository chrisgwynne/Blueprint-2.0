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

type Creds = Record<string, string | undefined>;

const BASE = 'https://api.bufferapp.com/1';
const AUTH_BASE = 'https://bufferapp.com/oauth2/authorize';
const TOKEN_URL = 'https://api.bufferapp.com/1/oauth2/token.json';

function bufferFetch(endpoint: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(`${BASE}${endpoint}`);
  // Buffer accepts access_token as a query param on all endpoints.
  url.searchParams.set('access_token', accessToken);
  return checkedFetch(url.toString(), init) as Promise<Response>;
}

interface BufferProfile {
  id: string;
  service: string;
  service_username: string;
  statistics?: { followers?: number };
}

interface BufferUpdate {
  id: string;
  text?: string;
  sent_at?: number;
  created_at?: number;
  due_at?: number;
  scheduled_at?: number;
  service?: string;
  service_username?: string;
  profile_id?: string;
  media?: unknown;
  statistics?: {
    reach?: number; clicks?: number; favorites?: number;
    retweets?: number; comments?: number; shares?: number; mentions?: number;
  };
}

const connector = {
  id: 'buffer' as const,
  name: 'Buffer',
  category: 'social' as const,
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

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.accessToken) return { ok: false, error: 'Access token missing.' };
      const res = await withRetry(
        () => bufferFetch('/user.json', credentials.accessToken!),
        { label: 'Buffer healthCheck' }
      );
      const data = await res.json() as { name?: string; email?: string };
      return {
        ok: true,
        details: { name: data?.name ?? null, email: data?.email ?? null },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async getAuthUrl(_state?: string): Promise<string> {
    const clientId = process.env.BUFFER_CLIENT_ID;
    if (!clientId) throw new Error('BUFFER_CLIENT_ID env var not set.');
    const redirectUri = process.env.BUFFER_REDIRECT_URI
      || 'http://localhost:4000/api/oauth/buffer/callback';
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: _state ?? '',
    });
    return `${AUTH_BASE}?${params.toString()}`;
  },

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> {
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
    const tokens = await res.json() as { access_token?: string };
    return {
      accessToken: tokens.access_token!,
      refreshToken: undefined, // Buffer tokens don't expire
      expiresAt: undefined,
    };
  },

  async refreshToken(credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> {
    return { accessToken: credentials.accessToken! };
  },

  async fetch(_dataType: string, credentials: Creds, _params?: Record<string, unknown>): Promise<unknown> {
    if (!credentials?.accessToken) throw new Error('Buffer access token is required.');
    const token = credentials.accessToken;

    // 1. Connected profiles
    let profiles: BufferProfile[] = [];
    try {
      const res = await withRetry(
        () => bufferFetch('/profiles.json', token),
        { label: 'Buffer profiles' }
      );
      const body = await res.json() as BufferProfile[] | unknown;
      profiles = Array.isArray(body) ? body as BufferProfile[] : [];
    } catch (err) {
      console.warn('[buffer] profiles fetch failed:', (err as Error).message);
    }

    // 2. Per-profile: sent + pending updates
    const sentUpdates: BufferUpdate[] = [];
    const pendingUpdates: BufferUpdate[] = [];
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
        const sentBody = await sentRes.json() as { updates?: BufferUpdate[] };
        const pendBody = await pendRes.json() as { updates?: BufferUpdate[] };
        const sent = (sentBody?.updates ?? []).map((u) => ({
          ...u, profile_id: p.id, service: p.service, service_username: p.service_username,
        }));
        const pend = (pendBody?.updates ?? []).map((u) => ({
          ...u, profile_id: p.id, service: p.service, service_username: p.service_username,
        }));
        sentUpdates.push(...sent);
        pendingUpdates.push(...pend);
      } catch (err) {
        console.warn(`[buffer] updates fetch for ${p.service} failed:`, (err as Error).message);
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

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as {
      profiles?: Array<{ id: string; service: string; service_username: string; followers?: number | null }>;
      sentUpdates?: BufferUpdate[];
      pendingUpdates?: BufferUpdate[];
    };
    const profiles = Array.isArray(d?.profiles) ? d.profiles : [];
    const sent = Array.isArray(d?.sentUpdates) ? d.sentUpdates : [];
    const pending = Array.isArray(d?.pendingUpdates) ? d.pendingUpdates : [];

    const last30Epoch = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const last7Epoch = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

    const sent30 = sent.filter((u) => (u.sent_at ?? u.created_at ?? 0) >= last30Epoch);
    const sent7 = sent.filter((u) => (u.sent_at ?? u.created_at ?? 0) >= last7Epoch);

    // Engagement = reach + clicks + favorites + retweets + comments + shares
    const engagement = (u: BufferUpdate): number => {
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
    const byPlatform: Record<string, { count: number; eng: number }> = {};
    for (const u of sent30) {
      const key = u.service || 'unknown';
      if (!byPlatform[key]) byPlatform[key] = { count: 0, eng: 0 };
      byPlatform[key].count++;
      byPlatform[key].eng += engagement(u);
    }

    let topPlatform: string | null = null;
    let topAvg = 0;
    for (const [platform, stats] of Object.entries(byPlatform)) {
      const avg = stats.count > 0 ? stats.eng / stats.count : 0;
      if (avg > topAvg) { topAvg = avg; topPlatform = platform; }
    }

    const nextPost = pending
      .map((u) => u.due_at ?? u.scheduled_at)
      .filter(Boolean)
      .sort((a, b) => (a as number) - (b as number))[0] ?? null;
    const nextPostIso = nextPost ? new Date((nextPost as number) * 1000).toISOString() : null;

    metrics.push(
      { name: 'buffer.profiles_connected',     value: profiles.length, data: null },
      { name: 'buffer.posts_published_30d',    value: sent30.length, data: null },
      { name: 'buffer.posts_scheduled_pending', value: pending.length, data: null },
      { name: 'buffer.avg_post_engagement_30d', value: avgEng, data: null },
      { name: 'buffer.avg_clicks_per_post',    value: avgClicks, data: null },
      { name: 'buffer.top_performing_platform', value: topPlatform ? 1 : 0, data: { platform: topPlatform, avg_engagement: Math.round(topAvg) } },
      { name: 'buffer.posting_frequency_7d',   value: sent7.length, data: null },
      { name: 'buffer.next_scheduled_post',    value: (nextPost as number) ?? 0, data: { iso: nextPostIso } },
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
