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

type Creds = Record<string, string | undefined>;

const API_BASE = 'https://merchantapi.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/content';

// Merchant API allows up to 1,000 products per page; page through up to
// MAX_PRODUCTS so a merchant with a very large catalogue doesn't turn one
// sync into an unbounded number of requests.
const PAGE_SIZE = 250;
const MAX_PRODUCTS = 5000;

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

interface ProductSummary {
  id: string;
  title: string | null;
  disapproved: boolean;
  hasErrorIssues: boolean;
  hasWarningIssues: boolean;
  issues: Array<{ code?: string; severity?: string; description?: string }>;
}

async function ensureFreshToken(credentials: Creds): Promise<Creds> {
  if (!credentials.expiresAt || Date.now() + 60_000 < Number(credentials.expiresAt)) {
    return credentials;
  }
  if (!credentials.refreshToken) {
    throw new Error('Google Merchant Center token expired and no refresh token available. Re-authorise the connector.');
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
  const disapproved = destinations.some((d) => (d.disapprovedCountries?.length ?? 0) > 0);
  const hasErrorIssues = issues.some((i) => (i.severity ?? '').toLowerCase() === 'error');
  const hasWarningIssues = issues.some((i) => (i.severity ?? '').toLowerCase() === 'warning');
  return {
    id, title, disapproved, hasErrorIssues, hasWarningIssues,
    issues: issues.slice(0, 10).map((i) => ({ code: i.code, severity: i.severity, description: i.description })),
  };
}

async function listProducts(credentials: Creds, accountId: string): Promise<ProductSummary[]> {
  const out: ProductSummary[] = [];
  let pageToken: string | undefined;

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
  } while (pageToken && out.length < MAX_PRODUCTS);

  return out;
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

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.accessToken) return { ok: false, error: 'Access token missing.' };
      const accountId = credentials.accountId;
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
    const products = await listProducts(fresh, accountId);

    return {
      accountId,
      products,
      totalProductCount: products.length,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const d = data as { products?: ProductSummary[]; totalProductCount?: number } | null;
    const products = d?.products ?? [];
    const disapproved = products.filter((p) => p.disapproved);
    const withErrorIssues = products.filter((p) => p.hasErrorIssues);
    const active = products.filter((p) => !p.disapproved && !p.hasErrorIssues);

    return [
      { name: 'google-merchant.total_products',                     value: d?.totalProductCount ?? products.length, data: null },
      { name: 'google-merchant.active_products',                    value: active.length,                            data: null },
      { name: 'google-merchant.disapproved_products',                value: disapproved.length,                       data: null },
      { name: 'google-merchant.products_with_data_quality_issues',   value: withErrorIssues.length,                   data: null },
      { name: 'google-merchant.products_data',                      value: products.length,                          data: products },
    ];
  },

  async getAuthUrl(state: string): Promise<string> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID env var not set.');
    const redirectUri = process.env.GOOGLE_MERCHANT_REDIRECT_URI || 'http://localhost:4000/api/oauth/google-merchant/callback';
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
    const redirectUri = process.env.GOOGLE_MERCHANT_REDIRECT_URI || 'http://localhost:4000/api/oauth/google-merchant/callback';
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
