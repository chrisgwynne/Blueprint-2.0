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

function authHeader(username, appPassword) {
  return 'Basic ' + Buffer.from(`${username}:${appPassword}`).toString('base64');
}

function wpFetch(siteUrl, endpoint, credentials, init = {}) {
  const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2${endpoint}`;
  return checkedFetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(credentials.username, credentials.appPassword),
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

const connector = {
  id: 'wordpress',
  name: 'WordPress',
  category: 'cms',
  authType: 'basic',
  icon: 'globe',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    { id: 'siteUrl',     label: 'Site URL',                 type: 'url',      required: true,  hint: 'e.g. https://yoursite.com (no trailing slash).' },
    { id: 'username',    label: 'WordPress Username',       type: 'text',     required: true },
    { id: 'appPassword', label: 'Application Password',     type: 'password', required: true,  hint: 'Generate at WP Admin → Users → Profile → Application Passwords.' },
  ],

  signalTypes: ['wp_plugin_update_available', 'wp_posts_published_drop', 'wp_comments_spam_spike', 'wp_drafts_piling_up'],

  async healthCheck(credentials) {
    try {
      if (!credentials?.siteUrl || !credentials?.username || !credentials?.appPassword) {
        return { ok: false, error: 'siteUrl, username, and appPassword are required.' };
      }
      const res = await withRetry(
        () => wpFetch(credentials.siteUrl, '/users/me', credentials),
        { label: 'WordPress healthCheck' }
      );
      const me = await res.json();
      return { ok: true, details: { user: me?.name, roles: me?.roles ?? [] } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.siteUrl || !credentials?.username || !credentials?.appPassword) {
      throw new Error('WordPress siteUrl, username, and appPassword are required.');
    }

    const requests = await Promise.all([
      withRetry(() => wpFetch(credentials.siteUrl, '/posts?per_page=20&status=publish&orderby=date', credentials), { label: 'WP recent posts' }),
      withRetry(() => wpFetch(credentials.siteUrl, '/posts?per_page=50&status=draft', credentials), { label: 'WP drafts' }).catch(() => null),
      withRetry(() => wpFetch(credentials.siteUrl, '/pages?per_page=50&status=publish', credentials), { label: 'WP pages' }).catch(() => null),
      withRetry(() => wpFetch(credentials.siteUrl, '/comments?per_page=20&status=approve', credentials), { label: 'WP approved comments' }).catch(() => null),
      withRetry(() => wpFetch(credentials.siteUrl, '/comments?per_page=20&status=spam', credentials), { label: 'WP spam comments' }).catch(() => null),
      withRetry(() => wpFetch(credentials.siteUrl, '/media?per_page=1', credentials), { label: 'WP media count' }).catch(() => null),
      // Plugins endpoint requires manage_plugins cap; may 401/403 for read-only users
      withRetry(() => wpFetch(credentials.siteUrl, '/plugins?per_page=100', credentials), { label: 'WP plugins' }).catch(() => null),
    ]);

    async function readJSONOrEmpty(res) {
      if (!res) return [];
      try { return await res.json(); } catch { return []; }
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
        () => wpFetch(credentials.siteUrl, '/posts?per_page=1&status=publish', credentials),
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

  extractMetrics(data, _runAt) {
    const metrics = [];
    const posts30dCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const posts30d = (data?.recentPosts ?? []).filter(p => {
      const ts = p.date ? new Date(p.date).getTime() : 0;
      return ts >= posts30dCutoff;
    }).length;

    const pluginsNeedingUpdate = (data?.plugins ?? []).filter(p => {
      // The plugins endpoint returns `update` field — empty string or absent if no update.
      return p.update && p.update !== 'none' && p.update !== '';
    });

    metrics.push(
      { name: 'wordpress.posts_published_total',    value: data?.postsTotal ?? 0,                       data: null },
      { name: 'wordpress.posts_published_30d',      value: posts30d,                                    data: null },
      { name: 'wordpress.posts_draft',              value: data?.drafts?.length ?? 0,                   data: null },
      { name: 'wordpress.pages_total',              value: data?.pages?.length ?? 0,                    data: null },
      { name: 'wordpress.comments_approved',        value: data?.approvedComments?.length ?? 0,         data: null },
      { name: 'wordpress.comments_spam',            value: data?.spamComments?.length ?? 0,             data: null },
      { name: 'wordpress.media_count',              value: data?.mediaCount ?? 0,                       data: null },
      { name: 'wordpress.plugins_total',            value: data?.plugins?.length ?? 0,                  data: null },
      { name: 'wordpress.plugins_update_available', value: pluginsNeedingUpdate.length,                 data: null },
    );

    metrics.push(
      { name: 'wordpress.recent_posts_data',     value: data?.recentPosts?.length ?? 0, data: data?.recentPosts ?? [] },
      { name: 'wordpress.plugins_data',          value: data?.plugins?.length ?? 0,    data: data?.plugins ?? [] },
      { name: 'wordpress.plugins_needing_update', value: pluginsNeedingUpdate.length, data: pluginsNeedingUpdate },
    );

    return metrics;
  },

  async getAuthUrl() { throw new Error('WordPress uses Basic auth (Application Password), not OAuth.'); },
  async exchangeCode() { throw new Error('WordPress uses Basic auth (Application Password), not OAuth.'); },
  async refreshToken() { throw new Error('WordPress uses Basic auth (Application Password), not OAuth.'); },
};

export default connector;
