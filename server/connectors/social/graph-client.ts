/**
 * Typed Meta Graph API client for the social connector.
 *
 * Design choices:
 * - Version is configurable via META_GRAPH_VERSION env var with a validated allow-list
 * - Access tokens are sent in Authorization headers, never in query-string URLs
 * - App secret is never included in error messages (redacted)
 * - Retries only on 429/5xx; 4xx errors are permanent failures
 * - Custom fetchFn injection for tests
 */
import nodeFetch from 'node-fetch';

export const GRAPH_VERSIONS = ['v20.0', 'v21.0', 'v22.0', 'v25.0'] as const;
export const DEFAULT_GRAPH_VERSION: string = 'v25.0';

export type GraphVersion = (typeof GRAPH_VERSIONS)[number];

export class GraphApiError extends Error {
  public readonly status: number;
  public readonly isRetryable: boolean;
  public readonly code?: number;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
    this.isRetryable = status === 429 || status >= 500;
    this.code = code;
  }
}

type FetchFn = typeof nodeFetch;

interface RequestOptions {
  fetchFn?: FetchFn;
  retries?: number;
  backoffMs?: number;
}

interface PageAccount {
  id: string;
  name: string;
  category?: string;
  tasks?: string[];
  access_token?: string;
}

interface InstagramAccount {
  id: string;
  username: string;
  account_type: 'BUSINESS' | 'CREATOR' | 'PERSONAL' | string;
  followers_count?: number;
  profile_picture_url?: string;
}

type Creds = Record<string, string | undefined>;

export class GraphClient {
  public readonly version: string;
  private readonly accessToken: string;
  private readonly graphBase: string;

  constructor(creds: Creds) {
    const appId = process.env.META_APP_ID;
    if (!appId) throw new Error('META_APP_ID is required to use GraphClient.');

    const configuredVersion = process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
    if (!GRAPH_VERSIONS.includes(configuredVersion as GraphVersion)) {
      throw new Error(
        `Unsupported Meta Graph API version "${configuredVersion}". ` +
        `Supported versions: ${GRAPH_VERSIONS.join(', ')}. ` +
        `Set META_GRAPH_VERSION to a supported value or remove it to use the default (${DEFAULT_GRAPH_VERSION}).`,
      );
    }

    this.version = configuredVersion;
    this.graphBase = `https://graph.facebook.com/${configuredVersion}`;

    const token = creds.access_token || creds.accessToken;
    if (!token) throw new Error('GraphClient: access_token is required.');
    this.accessToken = token;
  }

  private redact(message: string): string {
    // Redact the access token and any app secret pattern from error messages
    let msg = message.replace(new RegExp(this.accessToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
    const appSecret = process.env.META_APP_SECRET;
    if (appSecret) {
      msg = msg.replace(new RegExp(appSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
    }
    return msg;
  }

  async get(
    path: string,
    params: Record<string, string> = {},
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const { fetchFn = nodeFetch as unknown as FetchFn, retries = 3, backoffMs = 500 } = opts;
    // Token goes in Authorization header, not query string
    const url = `${this.graphBase}${path}?` + new URLSearchParams(params);

    let lastErr: GraphApiError | undefined;
    for (let i = 0; i <= retries; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** (i - 1)));
      }
      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await (fetchFn as any)(url, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
      } catch (err) {
        // Redact token from network-level error messages (e.g. URL in node-fetch errors)
        throw new GraphApiError(this.redact(`Network error: ${(err as Error).message}`), 0);
      }
      if (res.ok) return res.json();

      const text = await res.text().catch(() => '');
      let code: number | undefined;
      try { code = (JSON.parse(text) as any)?.error?.code; } catch {}
      const err = new GraphApiError(
        this.redact(`Graph API ${res.status}: ${text.substring(0, 300)}`),
        res.status,
        code,
      );
      lastErr = err;
      if (!err.isRetryable) throw err;
    }
    throw lastErr!;
  }

  async post(
    path: string,
    body: Record<string, string | number | boolean | null>,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const { fetchFn = nodeFetch as unknown as FetchFn, retries = 2, backoffMs = 500 } = opts;
    // Token goes in Authorization header, not query string
    const url = `${this.graphBase}${path}`;

    let lastErr: GraphApiError | undefined;
    for (let i = 0; i <= retries; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** (i - 1)));
      }
      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await (fetchFn as any)(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new GraphApiError(this.redact(`Network error: ${(err as Error).message}`), 0);
      }
      if (res.ok) return res.json();

      const text = await res.text().catch(() => '');
      let code: number | undefined;
      try { code = (JSON.parse(text) as any)?.error?.code; } catch {}
      const err = new GraphApiError(
        this.redact(`Graph API ${res.status}: ${text.substring(0, 300)}`),
        res.status,
        code,
      );
      lastErr = err;
      if (!err.isRetryable) throw err;
    }
    throw lastErr!;
  }

  /** List Facebook Pages the user manages. */
  async listManagedPages(opts: RequestOptions = {}): Promise<PageAccount[]> {
    const data = await this.get('/me/accounts', {
      fields: 'id,name,category,tasks,access_token',
      limit: '100',
    }, opts) as { data?: PageAccount[] };
    return data?.data ?? [];
  }

  /** Get the Instagram Business/Creator account linked to a Facebook Page. Returns null if not linked or if personal. */
  async getInstagramAccountForPage(
    pageId: string,
    opts: RequestOptions = {},
  ): Promise<InstagramAccount | null> {
    const data = await this.get(`/${pageId}`, {
      fields: 'instagram_business_account{id,username,account_type,followers_count,profile_picture_url}',
    }, opts) as { instagram_business_account?: InstagramAccount };

    const igAccount = data?.instagram_business_account;
    if (!igAccount) return null;

    const type = igAccount.account_type?.toUpperCase();
    if (type !== 'BUSINESS' && type !== 'CREATOR') {
      return null; // Reject personal accounts
    }
    return igAccount;
  }

  /**
   * Exchange a short-lived token for a long-lived token.
   * Sends credentials in POST body (application/x-www-form-urlencoded) to avoid
   * the app secret appearing in the request URL.
   */
  async exchangeForLongLivedToken(
    shortToken: string,
    opts: RequestOptions = {},
  ): Promise<{ access_token: string; expires_in: number }> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) throw new Error('META_APP_ID and META_APP_SECRET required for token exchange.');

    const { fetchFn = nodeFetch as unknown as FetchFn } = opts;
    // Use POST with form-encoded body to keep app secret out of the URL
    const body = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    });
    const res = await (fetchFn as any)(`${this.graphBase}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GraphApiError(
        this.redact(`Token exchange failed: ${text.substring(0, 300)}`),
        res.status,
      );
    }
    return res.json() as Promise<{ access_token: string; expires_in: number }>;
  }

  /**
   * Verify token info (app validation, scope checking).
   * Uses the app access token in the Authorization header to avoid leaking the app secret.
   */
  async debugToken(
    tokenToInspect: string,
    opts: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) throw new Error('META_APP_ID and META_APP_SECRET required for token debug.');

    const { fetchFn = nodeFetch as unknown as FetchFn } = opts;
    // Use Authorization header for the app access token; input_token goes as query param
    const url = `${this.graphBase}/debug_token?` + new URLSearchParams({ input_token: tokenToInspect });
    const res = await (fetchFn as any)(url, {
      headers: { Authorization: `Bearer ${appId}|${appSecret}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GraphApiError(this.redact(`Token debug failed: ${text.substring(0, 300)}`), res.status);
    }
    const body = await res.json() as { data?: Record<string, unknown> };
    return body?.data ?? {};
  }
}
