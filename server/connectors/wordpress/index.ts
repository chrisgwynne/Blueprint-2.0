/**
 * WordPress connector — Application Password (Basic auth) since WP 5.6+.
 *
 * Docs: https://developer.wordpress.org/rest-api/
 * Endpoint base: {siteUrl}/wp-json/wp/v2
 *
 * Auth: HTTP Basic with username + application password.
 *       Generated at WordPress Admin → Users → Profile → Application Passwords.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

type Creds = Record<string, string | undefined>;

interface WpUser {
  name?: string;
  roles?: string[];
}

interface WpPost {
  date?: string;
}

interface WpPlugin {
  update?: string;
}

function authHeader(username: string, appPassword: string): string {
  return 'Basic ' + Buffer.from(`${username}:${appPassword}`).toString('base64');
}

function wpFetch(siteUrl: string, endpoint: string, credentials: Creds, init: RequestInit = {}): Promise<Response> {
  const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2${endpoint}`;
  return checkedFetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(credentials['username'] ?? '', credentials['appPassword'] ?? ''),
      Accept: 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

const connector = {
  id: 'wordpress' as const,
  name: 'WordPress',
  category: 'cms' as const,
  authType: 'basic' as const,
  icon: 'globe',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    { id: 'siteUrl',     label: 'Site URL',             type: 'url' as const,      required: true,  hint: 'e.g. https://yoursite.com (no trailing slash).' },
    { id: 'username',    label: 'WordPress Username',   type: 'text' as const,     required: true },
    { id: 'appPassword', label: 'Application Password', type: 'password' as const, required: true,  hint: 'Generate at WP Admin → Users → Profile → Application Passwords.' },
  ],

  signalTypes: ['wp_plugin_update_available', 'wp_posts_published_drop', 'wp_comments_spam_spike', 'wp_drafts_piling_up'],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.siteUrl || !credentials?.username || !credentials?.appPassword) {
        return { ok: false, error: 'siteUrl, username, and appPassword are required.' };
      }
      const res = await withRetry(
        () => wpFetch(credentials['siteUrl']!, '/users/me', credentials),
        { label: 'WordPress healthCheck' }
      );
      const me = await res.json() as WpUser;
      return { ok: true, details: { user: me?.name, roles: me?.roles ?? [] } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(_dataType: string, credentials: Creds, _params?: Record<string, unknown>): Promise<unknown> {
    if (!credentials?.siteUrl || !credentials?.username || !credentials?.appPassword) {
      throw new Error('WordPress siteUrl, username, and appPassword are required.');
    }

    const siteUrl = credentials['siteUrl']!;

    const requests = await Promise.all([
      withRetry(() => wpFetch(siteUrl, '/posts?per_page=20&status=publish&orderby=date', credentials), { label: 'WP recent posts' }),
      withRetry(() => wpFetch(siteUrl, '/posts?per_page=50&status=draft', credentials), { label: 'WP drafts' }).catch(() => null),
      withRetry(() => wpFetch(siteUrl, '/pages?per_page=50&status=publish', credentials), { label: 'WP pages' }).catch(() => null),
      withRetry(() => wpFetch(siteUrl, '/comments?per_page=20&status=approve', credentials), { label: 'WP approved comments' }).catch(() => null),
      withRetry(() => wpFetch(siteUrl, '/comments?per_page=20&status=spam', credentials), { label: 'WP spam comments' }).catch(() => null),
      withRetry(() => wpFetch(siteUrl, '/media?per_page=1', credentials), { label: 'WP media count' }).catch(() => null),
      // Plugins endpoint requires manage_plugins cap; may 401/403 for read-only users
      withRetry(() => wpFetch(siteUrl, '/plugins?per_page=100', credentials), { label: 'WP plugins' }).catch(() => null),
    ]);

    async function readJSONOrEmpty(res: Response | null): Promise<unknown[]> {
      if (!res) return [];
      try { return await res.json() as unknown[]; } catch { return []; }
    }

    const [
      recentPostsRes,
      draftsRes,
      pagesRes,
      approvedCommentsRes,
      spamCommentsRes,
      mediaRes,
      pluginsRes,
    ] = requests;

    const recentPosts = await readJSONOrEmpty(recentPostsRes);
    const drafts = await readJSONOrEmpty(draftsRes);
    const pages = await readJSONOrEmpty(pagesRes);
    const approvedComments = await readJSONOrEmpty(approvedCommentsRes);
    const spamComments = await readJSONOrEmpty(spamCommentsRes);
    const plugins = await readJSONOrEmpty(pluginsRes);

    // Media count from X-WP-Total header
    let mediaCount = 0;
    if (mediaRes) {
      const total = mediaRes.headers.get('x-wp-total');
      mediaCount = total ? parseInt(total, 10) : 0;
    }

    // Posts published count: also fetch X-WP-Total for /posts?status=publish
    let postsTotal = 0;
    try {
      const totalRes = await withRetry(
        () => wpFetch(siteUrl, '/posts?per_page=1&status=publish', credentials),
        { label: 'WP posts total' }
      );
      postsTotal = parseInt(totalRes.headers.get('x-wp-total') ?? '0', 10);
    } catch { /* non-fatal */ }

    return {
      recentPosts: Array.isArray(recentPosts) ? recentPosts : [],
      drafts: Array.isArray(drafts) ? drafts : [],
      pages: Array.isArray(pages) ? pages : [],
      approvedComments: Array.isArray(approvedComments) ? approvedComments : [],
      spamComments: Array.isArray(spamComments) ? spamComments : [],
      mediaCount,
      postsTotal,
      plugins: Array.isArray(plugins) ? plugins : [],
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as {
      recentPosts?: WpPost[];
      drafts?: unknown[];
      pages?: unknown[];
      approvedComments?: unknown[];
      spamComments?: unknown[];
      mediaCount?: number;
      postsTotal?: number;
      plugins?: WpPlugin[];
    } | null;

    const posts30dCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const posts30d = (d?.recentPosts ?? []).filter(p => {
      const ts = p.date ? new Date(p.date).getTime() : 0;
      return ts >= posts30dCutoff;
    }).length;

    const pluginsNeedingUpdate = (d?.plugins ?? []).filter(p => {
      // The plugins endpoint returns `update` field — empty string or absent if no update.
      return p.update && p.update !== 'none' && p.update !== '';
    });

    metrics.push(
      { name: 'wordpress.posts_published_total',    value: d?.postsTotal ?? 0,                       data: null },
      { name: 'wordpress.posts_published_30d',      value: posts30d,                                  data: null },
      { name: 'wordpress.posts_draft',              value: d?.drafts?.length ?? 0,                   data: null },
      { name: 'wordpress.pages_total',              value: d?.pages?.length ?? 0,                    data: null },
      { name: 'wordpress.comments_approved',        value: d?.approvedComments?.length ?? 0,         data: null },
      { name: 'wordpress.comments_spam',            value: d?.spamComments?.length ?? 0,             data: null },
      { name: 'wordpress.media_count',              value: d?.mediaCount ?? 0,                       data: null },
      { name: 'wordpress.plugins_total',            value: d?.plugins?.length ?? 0,                  data: null },
      { name: 'wordpress.plugins_update_available', value: pluginsNeedingUpdate.length,               data: null },
    );

    metrics.push(
      { name: 'wordpress.recent_posts_data',      value: d?.recentPosts?.length ?? 0, data: d?.recentPosts ?? [] },
      { name: 'wordpress.plugins_data',           value: d?.plugins?.length ?? 0,    data: d?.plugins ?? [] },
      { name: 'wordpress.plugins_needing_update', value: pluginsNeedingUpdate.length, data: pluginsNeedingUpdate },
    );

    return metrics;
  },

  async getAuthUrl(_state?: string): Promise<string> { throw new Error('WordPress uses Basic auth (Application Password), not OAuth.'); },
  async exchangeCode(_code?: string): Promise<never> { throw new Error('WordPress uses Basic auth (Application Password), not OAuth.'); },
  async refreshToken(_credentials?: Creds): Promise<never> { throw new Error('WordPress uses Basic auth (Application Password), not OAuth.'); },
};

export default connector;
