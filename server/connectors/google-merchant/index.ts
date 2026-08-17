/**
 * Google Merchant Center connector — OAuth2 + Merchant API (v1).
 *
 * Docs: https://developers.google.com/merchant/api
 *       https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.products
 *
 * Focuses on product & feed health: is the product feed processing cleanly,
 * are products disapproved, are there data-quality issues Google flagged —
 * not Shopping-ad performance (impressions/clicks/spend), which lives in
 * the Merchant API's separate Reports sub-API and isn't covered here.
 *
 * Google is sunsetting the legacy Content API for Shopping
 * (shoppingcontent.googleapis.com, sunset 2026-08-18) in favour of the
 * Merchant API (merchantapi.googleapis.com) — this connector targets the
 * new API directly rather than building against something already being
 * turned off.
 *
 * Scope `https://www.googleapis.com/auth/content` requires its own OAuth
 * consent (not bundled into the shared GSC/GA4 flow) — same reasoning as
 * the google-ads connector's dedicated `/api/oauth/google-merchant` route
 * pair in server/routes/oauth.ts, which this connector's getAuthUrl/
 * exchangeCode mirror.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';
import { readGoogleOAuthConfig } from '../../lib/google-oauth-config.js';

type Creds = Record<string, string | undefined>;

const API_BASE = 'https://merchantapi.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/content';

// Merchant API allows up to 1,000 products per page.
const PAGE_SIZE = 1000;

// This is a SAFETY CEILING only, not a coverage cap (issue #42). Pagination
// below runs until the API's `nextPageToken` is exhausted, so it covers the
// FULL catalogue for any realistically sized Merchant account. This ceiling
// exists purely to bound worst-case request volume against a runaway or
// misbehaving feed; if it's ever actually hit, the sync's coverage is
// explicitly marked incomplete (`coverageComplete: false`) rather than
// silently truncating the result set and reporting it as the whole account.
const PAGINATION_SAFETY_CEILING = 250_000;

interface DestinationStatus {
  reportingContext?: string;
  approvedCountries?: string[];
  disapprovedCountries?: string[];
}

interface ItemLevelIssue {
  code?: string;
  severity?: string;
  resolution?: string;
  attribute?: string;
  reportingContext?: string;
  description?: string;
  detail?: string;
  documentation?: string;
  applicableCountries?: string[];
}

interface MerchantProduct {
  name?: string;
  offerId?: string;
  contentLanguage?: string;
  feedLabel?: string;
  productAttributes?: { title?: string; price?: { amountMicros?: string; currencyCode?: string } };
  productStatus?: {
    destinationStatuses?: DestinationStatus[];
    itemLevelIssues?: ItemLevelIssue[];
  };
}

// The six destination surfaces Google reports disapprovals against
// separately. Folding all of these into one generic "disapproved" bucket
// (the pre-#42 behaviour) meant a product restricted only on Demand Gen or
// Discover looked identical to one actually blocked from Shopping ads and
// Free listings — the two destinations that matter for "does this show up
// as a shopping result at all".
export const TRACKED_DESTINATIONS = [
  'shoppingAds', 'freeListings', 'display', 'demandGen', 'videoYoutube', 'discover',
] as const;
export type DestinationKey = typeof TRACKED_DESTINATIONS[number];

export const DESTINATION_LABELS: Record<DestinationKey, string> = {
  shoppingAds: 'Shopping Ads',
  freeListings: 'Free Listings',
  display: 'Display',
  demandGen: 'Demand Gen',
  videoYoutube: 'Video/YouTube',
  discover: 'Discover',
};

// Merchant API `reportingContext` values, mapped onto the tracked
// destinations above. Anything not recognised here (e.g. LOCAL_INVENTORY_ADS,
// VEHICLE_ADS) is preserved in `otherDisapprovedContexts` rather than
// silently dropped or folded into one of the six tracked buckets.
const REPORTING_CONTEXT_TO_DESTINATION: Record<string, DestinationKey> = {
  SHOPPING_ADS: 'shoppingAds',
  FREE_LISTINGS: 'freeListings',
  FREE_LOCAL_LISTINGS: 'freeListings',
  FREE_LOCAL_VEHICLE_LISTINGS: 'freeListings',
  DISPLAY_ADS: 'display',
  DEMAND_GEN_ADS: 'demandGen',
  DISCOVERY_ADS: 'demandGen', // legacy name for what's now Demand Gen ads
  DEMAND_GEN_ADS_DISCOVER_SURFACE: 'discover',
  VIDEO_ADS: 'videoYoutube',
  YOUTUBE_SHOPPING: 'videoYoutube',
  YOUTUBE_SHOPPING_CHECKOUT: 'videoYoutube',
};

interface ProductSummary {
  id: string;
  title: string | null;
  /** Tracked destinations (see TRACKED_DESTINATIONS) with ≥1 disapproved country for this product. Empty = fine on every destination Google reported. */
  disapprovedDestinations: DestinationKey[];
  /** Disapproved reportingContexts that don't map to one of the six tracked destinations. */
  otherDisapprovedContexts: string[];
  hasErrorIssues: boolean;
  hasWarningIssues: boolean;
  issues: Array<{ code?: string; severity?: string; description?: string; reportingContext?: string }>;
}

async function ensureFreshToken(credentials: Creds): Promise<Creds> {
  if (!credentials.expiresAt || Date.now() + 60_000 < Number(credentials.expiresAt)) {
    return credentials;
  }
  if (!credentials.refreshToken) {
    throw new Error('Google Merchant Center token expired and no refresh token available. Re-authorise the connector.');
  }
  const { clientId, clientSecret } = readGoogleOAuthConfig();
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
  const tokens = await res.json() as { access_token: string; expires_in?: number };
  return {
    ...credentials,
    accessToken: tokens.access_token,
    expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
}

export function summarizeProduct(p: MerchantProduct): ProductSummary {
  const id = p.name ?? p.offerId ?? 'unknown';
  const title = p.productAttributes?.title ?? null;
  const destinations = p.productStatus?.destinationStatuses ?? [];
  const issues = p.productStatus?.itemLevelIssues ?? [];

  const disapprovedDestinations = new Set<DestinationKey>();
  const otherDisapprovedContexts = new Set<string>();
  for (const d of destinations) {
    if ((d.disapprovedCountries?.length ?? 0) === 0) continue;
    const key = d.reportingContext ? REPORTING_CONTEXT_TO_DESTINATION[d.reportingContext] : undefined;
    if (key) disapprovedDestinations.add(key);
    else if (d.reportingContext) otherDisapprovedContexts.add(d.reportingContext);
  }

  const hasErrorIssues = issues.some((i) => (i.severity ?? '').toLowerCase() === 'error');
  const hasWarningIssues = issues.some((i) => (i.severity ?? '').toLowerCase() === 'warning');
  return {
    id,
    title,
    disapprovedDestinations: [...disapprovedDestinations],
    otherDisapprovedContexts: [...otherDisapprovedContexts],
    hasErrorIssues,
    hasWarningIssues,
    issues: issues.slice(0, 10).map((i) => ({ code: i.code, severity: i.severity, description: i.description, reportingContext: i.reportingContext })),
  };
}

interface ListProductsResult {
  products: ProductSummary[];
  offersScanned: number;
  /** False when the pagination safety ceiling was hit before the API ran out of pages — the products array is a partial snapshot, not the full account (issue #42). */
  coverageComplete: boolean;
}

async function listProducts(credentials: Creds, accountId: string): Promise<ListProductsResult> {
  const out: ProductSummary[] = [];
  let pageToken: string | undefined;
  let coverageComplete = true;

  do {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${API_BASE}/products/v1/accounts/${encodeURIComponent(accountId)}/products?${params.toString()}`;
    const res = await withRetry(
      () => checkedFetch(url, { headers: { Authorization: `Bearer ${credentials.accessToken}` } }),
      { label: 'Merchant API products.list' }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Merchant API products.list error ${res.status}: ${body.substring(0, 300)}`);
    }
    const data = await res.json() as { products?: MerchantProduct[]; nextPageToken?: string };
    for (const p of data.products ?? []) out.push(summarizeProduct(p));
    pageToken = data.nextPageToken;

    if (pageToken && out.length >= PAGINATION_SAFETY_CEILING) {
      coverageComplete = false;
      break;
    }
  } while (pageToken);

  return { products: out, offersScanned: out.length, coverageComplete };
}

async function getAccount(credentials: Creds, accountId: string): Promise<Record<string, unknown>> {
  const url = `${API_BASE}/accounts/v1/accounts/${encodeURIComponent(accountId)}`;
  const res = await withRetry(
    () => checkedFetch(url, { headers: { Authorization: `Bearer ${credentials.accessToken}` } }),
    { label: 'Merchant API accounts.get' }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Merchant API accounts.get error ${res.status}: ${body.substring(0, 300)}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

const connector = {
  id: 'google-merchant' as const,
  name: 'Google Merchant Center',
  category: 'commerce',
  authType: 'oauth2',
  icon: 'store',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    { id: 'accountId', label: 'Merchant Center Account ID', type: 'text', required: true,
      hint: 'Numbers only, no dashes. Merchant Center → Settings → Account information (top-right corner shows it too).' },
  ],

  signalTypes: [
    'merchant_products_disapproved', 'merchant_feed_data_quality_issues', 'merchant_product_count_drop',
  ],

  async healthCheck(credentials: Creds, config: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.accessToken) return { ok: false, error: 'Access token missing.' };
      const accountId = (config.accountId as string | undefined) || credentials.accountId;
      if (!accountId) return { ok: false, error: 'accountId not configured.' };

      const fresh = await ensureFreshToken(credentials);
      const account = await getAccount(fresh, accountId);
      return {
        ok: true,
        details: {
          account_id: account.accountId ?? accountId,
          name: account.accountName,
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(_dataType: string, credentials: Creds, params?: Record<string, unknown>): Promise<unknown> {
    const accountId = (params?.accountId as string | undefined) || credentials?.accountId;
    if (!accountId) throw new Error('Google Merchant Center accountId is required.');

    const fresh = await ensureFreshToken(credentials);
    const { products, offersScanned, coverageComplete } = await listProducts(fresh, accountId);

    return {
      accountId,
      products,
      totalProductCount: products.length,
      offersScanned,
      coverageComplete,
      // Merchant API's products.list doesn't return a total-catalogue count,
      // so a percentage is only knowable once pagination has genuinely
      // exhausted every page (100%). When the safety ceiling truncated the
      // scan we report `null` rather than fabricate a percentage —
      // `coverageComplete` is the authoritative signal downstream must key
      // off of (issue #42).
      coveragePercent: coverageComplete ? 100 : null,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const d = data as {
      products?: ProductSummary[];
      totalProductCount?: number;
      offersScanned?: number;
      coverageComplete?: boolean;
      coveragePercent?: number | null;
    } | null;
    const products = d?.products ?? [];
    const disapprovedAnyDestination = products.filter(
      (p) => p.disapprovedDestinations.length > 0 || p.otherDisapprovedContexts.length > 0
    );
    const withErrorIssues = products.filter((p) => p.hasErrorIssues);
    const active = products.filter(
      (p) => p.disapprovedDestinations.length === 0 && p.otherDisapprovedContexts.length === 0 && !p.hasErrorIssues
    );

    const metrics: Array<{ name: string; value: number; data: unknown }> = [
      { name: 'google-merchant.total_products',                          value: d?.totalProductCount ?? products.length,             data: null },
      { name: 'google-merchant.offers_scanned',                          value: d?.offersScanned ?? products.length,                 data: null },
      // No data at all (e.g. before the first successful sync) must never
      // read as "complete coverage" by default — only an explicit `true`
      // from a completed fetch() counts.
      { name: 'google-merchant.coverage_complete',                       value: d && d.coverageComplete !== false ? 1 : 0,           data: { coveragePercent: d?.coveragePercent ?? null } },
      { name: 'google-merchant.active_products',                         value: active.length,                                        data: null },
      // Informational only — NOT destination-specific, so nothing downstream
      // may treat this alone as evidence a product is blocked from Shopping
      // (issue #42). Use the per-destination metrics below for that.
      { name: 'google-merchant.disapproved_products_any_destination',    value: disapprovedAnyDestination.length,                    data: null },
      { name: 'google-merchant.products_with_data_quality_issues',       value: withErrorIssues.length,                              data: null },
      { name: 'google-merchant.products_data',                           value: products.length,                                     data: products },
    ];

    for (const key of TRACKED_DESTINATIONS) {
      metrics.push({
        name: `google-merchant.disapproved_products.${key}`,
        value: products.filter((p) => p.disapprovedDestinations.includes(key)).length,
        data: null,
      });
    }

    return metrics;
  },

  async getAuthUrl(state: string): Promise<string> {
    const { clientId } = readGoogleOAuthConfig();
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID env var not set.');
    const { redirectUri: googleRedirect } = readGoogleOAuthConfig();
    const redirectUri = process.env.GOOGLE_MERCHANT_REDIRECT_URI ||
      googleRedirect.replace('/api/oauth/google/callback', '/api/oauth/google-merchant/callback');
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
    const { clientId, clientSecret, redirectUri: googleRedirect } = readGoogleOAuthConfig();
    const redirectUri = process.env.GOOGLE_MERCHANT_REDIRECT_URI ||
      googleRedirect.replace('/api/oauth/google/callback', '/api/oauth/google-merchant/callback');
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
    const tokens = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
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
