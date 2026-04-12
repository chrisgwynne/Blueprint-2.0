/**
 * Google Business Profile (GBP) connector — uses Google OAuth.
 *
 * Required scope: https://www.googleapis.com/auth/business.manage
 *
 * APIs:
 *   - mybusinessaccountmanagement (v1)   — list accounts
 *   - mybusinessbusinessinformation (v1) — list/get locations
 *   - mybusiness (v4 legacy)             — reviews, insights, posts, photos, Q&A
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

const ACCOUNT_MGMT  = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const BUSINESS_INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const LEGACY        = 'https://mybusiness.googleapis.com/v4';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const AUTH_BASE     = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE         = 'https://www.googleapis.com/auth/business.manage';

async function ensureFreshToken(credentials) {
  if (!credentials.expiresAt || Date.now() + 60_000 < credentials.expiresAt) {
    return credentials;
  }
  if (!credentials.refreshToken) {
    throw new Error('GBP token expired and no refresh token available. Re-authorise the connector.');
  }
  const res = await checkedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    }),
  });
  const tokens = await res.json();
  return {
    ...credentials,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

function authHeaders(credentials) {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: 'application/json',
  };
}

async function gbpFetch(url, credentials) {
  const res = await withRetry(
    () => checkedFetch(url, { headers: authHeaders(credentials) }),
    { label: 'GBP fetch' }
  );
  return res.json();
}

const connector = {
  id: 'gbp',
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

  async healthCheck(credentials) {
    try {
      if (!credentials?.accessToken) return { ok: false, error: 'Access token missing.' };
      const fresh = await ensureFreshToken(credentials);
      const data = await gbpFetch(`${ACCOUNT_MGMT}/accounts`, fresh);
      const accounts = data.accounts || [];
      return {
        ok: true,
        details: {
          accounts: accounts.length,
          first_account: accounts[0]?.accountName ?? null,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Helper for setup UI: list available GBP accounts.
   */
  async listAccounts(credentials) {
    const fresh = await ensureFreshToken(credentials);
    const data = await gbpFetch(`${ACCOUNT_MGMT}/accounts`, fresh);
    return data.accounts || [];
  },

  /**
   * Helper for setup UI: list locations under an account.
   */
  async listLocations(credentials, accountId) {
    const fresh = await ensureFreshToken(credentials);
    const readMask = 'name,title,storefrontAddress,websiteUri,businessStatus';
    const data = await gbpFetch(
      `${BUSINESS_INFO}/${accountId}/locations?readMask=${encodeURIComponent(readMask)}`,
      fresh
    );
    return data.locations || [];
  },

  async fetch(_dataType, credentials, params) {
    if (!credentials?.accessToken) throw new Error('GBP access token is required.');
    const fresh = await ensureFreshToken(credentials);
    const accountId  = params?.accountId  ?? credentials.accountId;
    const locationId = params?.locationId ?? credentials.locationId;
    if (!accountId || !locationId) {
      throw new Error('GBP accountId and locationId are required.');
    }

    // Strip prefix if user passed full path
    const cleanLocId = String(locationId).replace(/^locations\//, '');
    const cleanAccId = String(accountId).startsWith('accounts/') ? accountId : `accounts/${accountId}`;
    const fullLocationName = `${cleanAccId}/locations/${cleanLocId}`;

    // Run all reads in parallel — each catches its own errors so one failure
    // doesn't sink the whole sync (legacy API endpoints can be flaky).
    const [location, reviews, insights, posts, photos, qa] = await Promise.all([
      // Location details
      gbpFetch(
        `${BUSINESS_INFO}/locations/${cleanLocId}?readMask=${encodeURIComponent('name,title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,businessStatus,profile,metadata')}`,
        fresh
      ).catch(() => null),

      // Reviews (legacy v4)
      gbpFetch(
        `${LEGACY}/${cleanAccId}/locations/${cleanLocId}/reviews?pageSize=50`,
        fresh
      ).catch(() => ({ reviews: [], averageRating: 0, totalReviewCount: 0 })),

      // Insights (legacy v4 reportInsights — POST)
      (async () => {
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - 28 * 86400000);
        try {
          const res = await withRetry(
            () => checkedFetch(`${LEGACY}/${cleanAccId}/locations:reportInsights`, {
              method: 'POST',
              headers: {
                ...authHeaders(fresh),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                locationNames: [fullLocationName],
                basicRequest: {
                  metricRequests: [
                    'QUERIES_DIRECT', 'QUERIES_INDIRECT',
                    'VIEWS_MAPS', 'VIEWS_SEARCH',
                    'ACTIONS_WEBSITE', 'ACTIONS_PHONE', 'ACTIONS_DRIVING_DIRECTIONS',
                    'PHOTOS_VIEWS_MERCHANT', 'PHOTOS_COUNT_MERCHANT',
                    'LOCAL_POST_VIEWS_SEARCH',
                  ].map(m => ({ metric: m })),
                  timeRange: {
                    startTime: startDate.toISOString(),
                    endTime: endDate.toISOString(),
                  },
                },
              }),
            }),
            { label: 'GBP insights' }
          );
          return res.json();
        } catch {
          return { locationMetrics: [] };
        }
      })(),

      // Posts
      gbpFetch(
        `${LEGACY}/${cleanAccId}/locations/${cleanLocId}/localPosts?pageSize=20`,
        fresh
      ).catch(() => ({ localPosts: [] })),

      // Photos / media
      gbpFetch(
        `${LEGACY}/${cleanAccId}/locations/${cleanLocId}/media?pageSize=50`,
        fresh
      ).catch(() => ({ mediaItems: [] })),

      // Q&A
      gbpFetch(
        `${LEGACY}/locations/${cleanLocId}/questions?pageSize=20&answersPerQuestion=5`,
        fresh
      ).catch(() => ({ questions: [] })),
    ]);

    return {
      location,
      reviews: reviews ?? { reviews: [], averageRating: 0, totalReviewCount: 0 },
      insights: insights ?? { locationMetrics: [] },
      posts: posts?.localPosts ?? [],
      photos: photos?.mediaItems ?? [],
      qa: qa?.questions ?? [],
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const reviews = data?.reviews ?? { reviews: [], averageRating: 0, totalReviewCount: 0 };
    const reviewList = reviews.reviews ?? [];

    // Insight totals — drill into the response shape
    const getInsightTotal = (metricId) => {
      const loc = data?.insights?.locationMetrics?.[0];
      const m = loc?.metricValues?.find(v => v.metric === metricId);
      return parseInt(m?.totalValue?.value ?? 0, 10);
    };

    // Star rating breakdown
    const stars = { ONE: 0, TWO: 0, THREE: 0, FOUR: 0, FIVE: 0 };
    let unansweredReviews = 0;
    for (const r of reviewList) {
      if (stars[r.starRating] !== undefined) stars[r.starRating]++;
      if (!r.reviewReply) unansweredReviews++;
    }

    // Post freshness
    const livePosts = (data?.posts ?? []).filter(p => p.state === 'LIVE');
    const sortedLive = [...livePosts].sort((a, b) =>
      new Date(b.createTime).getTime() - new Date(a.createTime).getTime()
    );
    const daysSincePost = sortedLive.length > 0
      ? Math.floor((Date.now() - new Date(sortedLive[0].createTime).getTime()) / 86400000)
      : 999;

    // Unanswered Q&A
    const unansweredQA = (data?.qa ?? []).filter(q => !q.topAnswers || q.topAnswers.length === 0).length;

    const queriesDirect   = getInsightTotal('QUERIES_DIRECT');
    const queriesIndirect = getInsightTotal('QUERIES_INDIRECT');
    const viewsMaps       = getInsightTotal('VIEWS_MAPS');
    const viewsSearch     = getInsightTotal('VIEWS_SEARCH');

    metrics.push(
      { name: 'gbp.avg_rating',         value: reviews.averageRating ?? 0,    data: null },
      { name: 'gbp.total_reviews',      value: reviews.totalReviewCount ?? 0, data: null },
      { name: 'gbp.unanswered_reviews', value: unansweredReviews,             data: null },
      { name: 'gbp.reviews_1star',      value: stars.ONE,                     data: null },
      { name: 'gbp.reviews_2star',      value: stars.TWO,                     data: null },
      { name: 'gbp.reviews_3star',      value: stars.THREE,                   data: null },
      { name: 'gbp.reviews_4star',      value: stars.FOUR,                    data: null },
      { name: 'gbp.reviews_5star',      value: stars.FIVE,                    data: null },
      { name: 'gbp.queries_direct',     value: queriesDirect,                 data: null },
      { name: 'gbp.queries_indirect',   value: queriesIndirect,               data: null },
      { name: 'gbp.queries_total',      value: queriesDirect + queriesIndirect, data: null },
      { name: 'gbp.views_maps',         value: viewsMaps,                     data: null },
      { name: 'gbp.views_search',       value: viewsSearch,                   data: null },
      { name: 'gbp.views_total',        value: viewsMaps + viewsSearch,       data: null },
      { name: 'gbp.actions_website',    value: getInsightTotal('ACTIONS_WEBSITE'),    data: null },
      { name: 'gbp.actions_phone',      value: getInsightTotal('ACTIONS_PHONE'),      data: null },
      { name: 'gbp.actions_directions', value: getInsightTotal('ACTIONS_DRIVING_DIRECTIONS'), data: null },
      { name: 'gbp.photo_views',        value: getInsightTotal('PHOTOS_VIEWS_MERCHANT'),      data: null },
      { name: 'gbp.photo_count',        value: getInsightTotal('PHOTOS_COUNT_MERCHANT'),      data: null },
      { name: 'gbp.posts_live',         value: livePosts.length,              data: null },
      { name: 'gbp.days_since_post',    value: daysSincePost,                 data: null },
      { name: 'gbp.unanswered_qa',      value: unansweredQA,                  data: null },
    );

    // Rich data
    metrics.push(
      { name: 'gbp.location_data', value: data?.location ? 1 : 0, data: data?.location ?? null },
      { name: 'gbp.reviews_data',  value: reviewList.length,      data: reviewList },
      { name: 'gbp.posts_data',    value: data?.posts?.length ?? 0, data: data?.posts ?? [] },
      { name: 'gbp.photos_data',   value: data?.photos?.length ?? 0, data: data?.photos ?? [] },
      { name: 'gbp.qa_data',       value: data?.qa?.length ?? 0,    data: data?.qa ?? [] },
    );

    return metrics;
  },

  async getAuthUrl(state) {
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

  async exchangeCode(code) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GBP_REDIRECT_URI ||
      (process.env.GOOGLE_REDIRECT_URI?.replace('/google/callback', '/gbp/callback')) ||
      'http://localhost:4000/api/oauth/gbp/callback';
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
    }
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
    const tokens = await res.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
    };
  },

  async refreshToken(credentials) {
    return ensureFreshToken({ ...credentials, expiresAt: 0 });
  },
};

export default connector;
