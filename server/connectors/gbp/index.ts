/**
 * Google Business Profile (GBP) connector — uses Google OAuth.
 *
 * Required scope: https://www.googleapis.com/auth/business.manage
 *
 * APIs:
 *   - mybusinessaccountmanagement (v1)   — list accounts
 *   - mybusinessbusinessinformation (v1) — list/get locations
 *   - mybusiness (v4 legacy)             — reviews, posts, photos
 *   - businessprofileperformance (v1)    — performance metrics
 *   - mybusinessqanda (v1)               — Q&A
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';
import { readGoogleOAuthConfig } from '../../lib/google-oauth-config.js';

type Creds = Record<string, string | undefined>;

const ACCOUNT_MGMT  = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const BUSINESS_INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const LEGACY        = 'https://mybusiness.googleapis.com/v4';
const PERFORMANCE   = 'https://businessprofileperformance.googleapis.com/v1';
const QANDA         = 'https://mybusinessqanda.googleapis.com/v1';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const AUTH_BASE     = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE         = 'https://www.googleapis.com/auth/business.manage';

type ProviderName =
  | 'account-management'
  | 'business-information'
  | 'legacy-reviews'
  | 'legacy-posts'
  | 'legacy-media'
  | 'performance'
  | 'qanda'
  | 'oauth-token';

type ProviderErrorLike = {
  status?: unknown;
  statusCode?: unknown;
  retryAfterMs?: unknown;
};

class GbpProviderError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(provider: ProviderName, cause: unknown) {
    const source = (cause && typeof cause === 'object' ? cause : {}) as ProviderErrorLike;
    const candidate = source.status ?? source.statusCode;
    const status = typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : undefined;
    super(`GBP provider request failed (provider=${provider} status=${status ?? 'unknown'})`);
    this.name = 'GbpProviderError';
    this.status = status;
    this.retryAfterMs = typeof source.retryAfterMs === 'number' ? source.retryAfterMs : undefined;
  }
}

function providerError(provider: ProviderName, cause: unknown): GbpProviderError {
  return cause instanceof GbpProviderError ? cause : new GbpProviderError(provider, cause);
}

async function ensureFreshToken(credentials: Creds): Promise<Creds> {
  if (!credentials.expiresAt || Date.now() + 60_000 < Number(credentials.expiresAt)) {
    return credentials;
  }
  if (!credentials.refreshToken) {
    throw new Error('GBP token expired and no refresh token available. Re-authorise the connector.');
  }

  const { clientId, clientSecret } = readGoogleOAuthConfig();
  let tokens: { access_token: string; expires_in?: number };
  try {
    const res = await checkedFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: clientId || credentials.clientId || '',
        client_secret: clientSecret || credentials.clientSecret || '',
      }),
    });
    tokens = await res.json() as { access_token: string; expires_in?: number };
  } catch (err) {
    throw providerError('oauth-token', err);
  }
  return {
    ...credentials,
    accessToken: tokens.access_token,
    expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
}

function authHeaders(credentials: Creds): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: 'application/json',
  };
}

async function gbpRequest(
  url: string,
  credentials: Creds,
  provider: ProviderName,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  try {
    const res = await withRetry(
      () => checkedFetch(url, {
        ...init,
        headers: { ...authHeaders(credentials), ...(init.headers ?? {}) },
      }),
      { label: `GBP ${provider}` },
    );
    return await res.json() as Record<string, unknown>;
  } catch (err) {
    throw providerError(provider, err);
  }
}

function gbpFetch(url: string, credentials: Creds, provider: ProviderName): Promise<Record<string, unknown>> {
  return gbpRequest(url, credentials, provider);
}

const connector = {
  id: 'gbp' as const,
  name: 'Google Business Profile',
  category: 'local',
  authType: 'oauth2',
  icon: 'map-pin',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    { id: 'accountId',  label: 'GBP Account',     type: 'text', required: true,
      hint: 'Format: accounts/{number}. Use listAccounts() during setup to discover.' },
    { id: 'locationId', label: 'Business Location', type: 'text', required: true,
      hint: 'Format: locations/{number}. Use listLocations(accountId) to discover.' },
  ],

  signalTypes: [
    'gbp_rating_drop', 'gbp_negative_review', 'gbp_review_unanswered',
    'gbp_views_drop', 'gbp_calls_drop', 'gbp_search_drop',
    'gbp_no_recent_posts', 'gbp_unanswered_questions',
  ],

  async healthCheck(credentials: Creds, config: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.accessToken) return { ok: false, error: 'Access token missing.' };
      const fresh = await ensureFreshToken(credentials);
      const accountId = (config.accountId as string | undefined) || credentials.accountId;
      const locationId = (config.locationId as string | undefined) || credentials.locationId;
      if (!accountId || !locationId) return { ok: false, error: 'GBP accountId and locationId are not configured.' };
      const data = await gbpFetch(`${ACCOUNT_MGMT}/accounts`, fresh, 'account-management');
      const accounts = (data.accounts as Array<Record<string, unknown>>) || [];
      const cleanAccount = accountId.startsWith('accounts/') ? accountId : `accounts/${accountId}`;
      const cleanLocation = locationId.replace(/^locations\//, '');
      const locations = await this.listLocations(cleanAccount, fresh);
      const matched = locations.some((location) => {
        const name = String((location as Record<string, unknown>).name ?? '');
        return name === `${cleanAccount}/locations/${cleanLocation}` || name.endsWith(`/locations/${cleanLocation}`);
      });
      if (!matched) return { ok: false, error: 'Configured GBP location is not accessible to this grant.' };
      return {
        ok: true,
        details: {
          accounts: accounts.length,
          configured_location: `${cleanAccount}/locations/${cleanLocation}`,
          first_account: (accounts[0]?.accountName as string | undefined) ?? null,
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  /**
   * Helper for setup UI: list available GBP accounts.
   */
  async listAccounts(credentials: Creds): Promise<unknown[]> {
    const fresh = await ensureFreshToken(credentials);
    const data = await gbpFetch(`${ACCOUNT_MGMT}/accounts`, fresh, 'account-management');
    return (data.accounts as unknown[]) || [];
  },

  /**
   * Helper for setup UI: list locations under an account.
   */
  async listLocations(accountId: string, credentials: Creds): Promise<unknown[]> {
    const fresh = await ensureFreshToken(credentials);
    const readMask = 'name,title,storefrontAddress,websiteUri,openInfo';
    const data = await gbpFetch(
      `${BUSINESS_INFO}/${accountId}/locations?readMask=${encodeURIComponent(readMask)}`,
      fresh,
      'business-information',
    );
    return (data.locations as unknown[]) || [];
  },

  async fetch(_dataType: string, credentials: Creds, params?: Record<string, unknown>): Promise<unknown> {
    if (!credentials?.accessToken) throw new Error('GBP access token is required.');
    const fresh = await ensureFreshToken(credentials);
    const accountId  = (params?.accountId as string | undefined)  ?? credentials.accountId;
    const locationId = (params?.locationId as string | undefined) ?? credentials.locationId;
    if (!accountId || !locationId) {
      throw new Error('GBP accountId and locationId are required.');
    }

    // Strip prefix if user passed full path
    const cleanLocId = String(locationId).replace(/^locations\//, '');
    const cleanAccId = String(accountId).startsWith('accounts/') ? accountId : `accounts/${accountId}`;

    // Run all reads in parallel — each catches its own errors so one failure
    // doesn't sink the whole sync (legacy API endpoints can be flaky).
    // Failed sections are logged and reported in `partial_failures` so the
    // sync layer and dashboard can tell "no reviews" apart from "reviews
    // fetch failed".
    const partialFailures: Array<{ section: string; error: string }> = [];
    const fallback = <T>(section: string, provider: ProviderName, value: T) => (err: unknown): T => {
      const message = providerError(provider, err).message;
      partialFailures.push({ section, error: message });
      console.warn(`[gbp] ${section} fetch failed: ${message}`);
      return value;
    };

    const [location, reviews, insights, posts, photos, qa] = await Promise.all([
      // Location details
      gbpFetch(
        `${BUSINESS_INFO}/locations/${cleanLocId}?readMask=${encodeURIComponent('name,title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,openInfo,profile,metadata')}`,
        fresh,
        'business-information',
      ).catch(fallback('location', 'business-information', null)),

      // Reviews (legacy v4)
      gbpFetch(
        `${LEGACY}/${cleanAccId}/locations/${cleanLocId}/reviews?pageSize=50`,
        fresh,
        'legacy-reviews',
      ).catch(fallback('reviews', 'legacy-reviews', { reviews: [], averageRating: 0, totalReviewCount: 0 })),

      // Performance API v1 replaces the removed v4 reportInsights endpoint.
      (async () => {
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - 28 * 86400000);
        try {
          const query = new URLSearchParams();
          for (const metric of [
            'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
            'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
            'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
            'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
            'WEBSITE_CLICKS',
            'CALL_CLICKS',
            'BUSINESS_DIRECTION_REQUESTS',
          ]) query.append('dailyMetrics', metric);
          query.set('dailyRange.start_date.year', String(startDate.getUTCFullYear()));
          query.set('dailyRange.start_date.month', String(startDate.getUTCMonth() + 1));
          query.set('dailyRange.start_date.day', String(startDate.getUTCDate()));
          query.set('dailyRange.end_date.year', String(endDate.getUTCFullYear()));
          query.set('dailyRange.end_date.month', String(endDate.getUTCMonth() + 1));
          query.set('dailyRange.end_date.day', String(endDate.getUTCDate()));
          return await gbpFetch(
            `${PERFORMANCE}/locations/${cleanLocId}:fetchMultiDailyMetricsTimeSeries?${query.toString()}`,
            fresh,
            'performance',
          );
        } catch (err) {
          return fallback('insights', 'performance', { multiDailyMetricTimeSeries: [] })(err);
        }
      })(),

      // Posts
      gbpFetch(
        `${LEGACY}/${cleanAccId}/locations/${cleanLocId}/localPosts?pageSize=20`,
        fresh,
        'legacy-posts',
      ).catch(fallback('posts', 'legacy-posts', { localPosts: [] })),

      // Photos / media
      gbpFetch(
        `${LEGACY}/${cleanAccId}/locations/${cleanLocId}/media?pageSize=50`,
        fresh,
        'legacy-media',
      ).catch(fallback('photos', 'legacy-media', { mediaItems: [] })),

      // Q&A
      gbpFetch(
        `${QANDA}/locations/${cleanLocId}/questions?pageSize=10&answersPerQuestion=5`,
        fresh,
        'qanda',
      ).catch(fallback('qa', 'qanda', { questions: [] })),
    ]);

    const reviewsData = reviews as Record<string, unknown>;
    const insightsData = insights as Record<string, unknown>;
    const postsData = posts as Record<string, unknown>;
    const photosData = photos as Record<string, unknown>;
    const qaData = qa as Record<string, unknown>;

    return {
      location,
      reviews: reviewsData ?? { reviews: [], averageRating: 0, totalReviewCount: 0 },
      insights: insightsData ?? { locationMetrics: [] },
      posts: postsData?.localPosts ?? [],
      photos: photosData?.mediaItems ?? [],
      qa: qaData?.questions ?? [],
      partial_failures: partialFailures,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as Record<string, unknown> | null;
    const reviews = (d?.reviews ?? { reviews: [], averageRating: 0, totalReviewCount: 0 }) as Record<string, unknown>;
    const reviewList = (reviews.reviews ?? []) as Array<Record<string, unknown>>;

    // Preserve the existing metric schema while accepting both historical
    // reportInsights payloads and current Performance API time series.
    const getPerformanceTotal = (metricIds: string[]): number => {
      const insights = d?.insights as Record<string, unknown> | undefined;
      const groups = insights?.multiDailyMetricTimeSeries as Array<Record<string, unknown>> | undefined;
      let total = 0;
      for (const group of groups ?? []) {
        const series = group.dailyMetricTimeSeries as Array<Record<string, unknown>> | undefined;
        for (const metricSeries of series ?? []) {
          if (!metricIds.includes(String(metricSeries.dailyMetric ?? ''))) continue;
          const timeSeries = metricSeries.timeSeries as Record<string, unknown> | undefined;
          const values = timeSeries?.datedValues as Array<Record<string, unknown>> | undefined;
          for (const point of values ?? []) {
            const value = Number(point.value ?? 0);
            if (Number.isFinite(value)) total += value;
          }
        }
      }
      return total;
    };

    const getInsightTotal = (metricId: string): number => {
      const insights = d?.insights as Record<string, unknown> | undefined;
      const locationMetrics = insights?.locationMetrics as Array<Record<string, unknown>> | undefined;
      const loc = locationMetrics?.[0];
      const metricValues = loc?.metricValues as Array<Record<string, unknown>> | undefined;
      const m = metricValues?.find(v => v.metric === metricId);
      const totalValue = m?.totalValue as Record<string, unknown> | undefined;
      if (totalValue?.value !== undefined) return parseInt(String(totalValue.value), 10) || 0;

      const modernMetrics: Record<string, string[]> = {
        VIEWS_MAPS: ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
        VIEWS_SEARCH: ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
        ACTIONS_WEBSITE: ['WEBSITE_CLICKS'],
        ACTIONS_PHONE: ['CALL_CLICKS'],
        ACTIONS_DRIVING_DIRECTIONS: ['BUSINESS_DIRECTION_REQUESTS'],
      };
      return getPerformanceTotal(modernMetrics[metricId] ?? []);
    };

    // Star rating breakdown
    const stars: Record<'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE', number> = { ONE: 0, TWO: 0, THREE: 0, FOUR: 0, FIVE: 0 };
    let unansweredReviews = 0;
    for (const r of reviewList) {
      const rating = r.starRating as string | undefined;
      if (rating && rating in stars) { const s = stars as Record<string, number>; s[rating] = (s[rating] ?? 0) + 1; }
      if (!r.reviewReply) unansweredReviews++;
    }

    // Post freshness
    const posts = (d?.posts ?? []) as Array<Record<string, unknown>>;
    const livePosts = posts.filter(p => p.state === 'LIVE');
    const sortedLive = [...livePosts].sort((a, b) =>
      new Date(b.createTime as string).getTime() - new Date(a.createTime as string).getTime()
    );
    const daysSincePost = sortedLive.length > 0
      ? Math.floor((Date.now() - new Date(sortedLive[0]!.createTime as string).getTime()) / 86400000)
      : 999;

    // Unanswered Q&A
    const qa = (d?.qa ?? []) as Array<Record<string, unknown>>;
    const unansweredQA = qa.filter(q => !q.topAnswers || (q.topAnswers as unknown[]).length === 0).length;

    const queriesDirect   = getInsightTotal('QUERIES_DIRECT');
    const queriesIndirect = getInsightTotal('QUERIES_INDIRECT');
    const viewsMaps       = getInsightTotal('VIEWS_MAPS');
    const viewsSearch     = getInsightTotal('VIEWS_SEARCH');

    metrics.push(
      { name: 'gbp.avg_rating',         value: (reviews.averageRating as number) ?? 0,    data: null },
      { name: 'gbp.total_reviews',      value: (reviews.totalReviewCount as number) ?? 0, data: null },
      { name: 'gbp.unanswered_reviews', value: unansweredReviews,                          data: null },
      { name: 'gbp.reviews_1star',      value: stars.ONE,                                  data: null },
      { name: 'gbp.reviews_2star',      value: stars.TWO,                                  data: null },
      { name: 'gbp.reviews_3star',      value: stars.THREE,                                data: null },
      { name: 'gbp.reviews_4star',      value: stars.FOUR,                                 data: null },
      { name: 'gbp.reviews_5star',      value: stars.FIVE,                                 data: null },
      { name: 'gbp.queries_direct',     value: queriesDirect,                              data: null },
      { name: 'gbp.queries_indirect',   value: queriesIndirect,                            data: null },
      { name: 'gbp.queries_total',      value: queriesDirect + queriesIndirect,            data: null },
      { name: 'gbp.views_maps',         value: viewsMaps,                                  data: null },
      { name: 'gbp.views_search',       value: viewsSearch,                                data: null },
      { name: 'gbp.views_total',        value: viewsMaps + viewsSearch,                    data: null },
      { name: 'gbp.actions_website',    value: getInsightTotal('ACTIONS_WEBSITE'),         data: null },
      { name: 'gbp.actions_phone',      value: getInsightTotal('ACTIONS_PHONE'),           data: null },
      { name: 'gbp.actions_directions', value: getInsightTotal('ACTIONS_DRIVING_DIRECTIONS'), data: null },
      { name: 'gbp.photo_views',        value: getInsightTotal('PHOTOS_VIEWS_MERCHANT'),   data: null },
      { name: 'gbp.photo_count',        value: getInsightTotal('PHOTOS_COUNT_MERCHANT'),   data: null },
      { name: 'gbp.posts_live',         value: livePosts.length,                           data: null },
      { name: 'gbp.days_since_post',    value: daysSincePost,                              data: null },
      { name: 'gbp.unanswered_qa',      value: unansweredQA,                               data: null },
    );

    // Rich data
    const photosArr = d?.photos as Array<unknown> | undefined;
    metrics.push(
      { name: 'gbp.location_data', value: d?.location ? 1 : 0,      data: d?.location ?? null },
      { name: 'gbp.reviews_data',  value: reviewList.length,          data: reviewList },
      { name: 'gbp.posts_data',    value: posts.length,               data: posts },
      { name: 'gbp.photos_data',   value: photosArr?.length ?? 0,     data: photosArr ?? [] },
      { name: 'gbp.qa_data',       value: qa.length,                  data: qa },
    );

    return metrics;
  },

  async getAuthUrl(state: string): Promise<string> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID env var not set.');
    const redirectUri = process.env.GBP_REDIRECT_URI ||
      (process.env.GOOGLE_REDIRECT_URI?.replace('/google/callback', '/gbp/callback')) ||
      'http://localhost:4000/api/oauth/gbp/callback';
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

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GBP_REDIRECT_URI ||
      (process.env.GOOGLE_REDIRECT_URI?.replace('/google/callback', '/gbp/callback')) ||
      'http://localhost:4000/api/oauth/gbp/callback';
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
    }
    let tokens: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    try {
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
      tokens = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    } catch (err) {
      throw providerError('oauth-token', err);
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || undefined,
      expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      scope: tokens.scope,
    };
  },

  async refreshToken(credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> {
    return ensureFreshToken({ ...credentials, expiresAt: '0' }) as Promise<{ accessToken: string; expiresAt?: string }>;
  },
};

export default connector;
