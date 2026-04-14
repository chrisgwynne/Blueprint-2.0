/**
 * Wix connector — apikey auth.
 *
 * Docs:  https://dev.wix.com/docs/rest
 * Base:  https://www.wixapis.com
 *
 * Reads site properties, pages, blog posts, SEO, and (where plan allows)
 * analytics. Supports limited write-back for SEO fields only — never
 * structural changes. All writes still go through Blueprint's task-
 * approval flow via the executor.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

const BASE = 'https://www.wixapis.com';

function wixHeaders(credentials) {
  return {
    Authorization: credentials.apiKey,
    'wix-site-id': credentials.siteId ?? '',
    'wix-account-id': credentials.accountId ?? '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function wixFetch(endpoint, credentials, init = {}) {
  return checkedFetch(`${BASE}${endpoint}`, {
    ...init,
    headers: { ...wixHeaders(credentials), ...(init.headers ?? {}) },
  });
}

// ─── SEO audit helpers ──────────────────────────────────────────────────────

function pageSeoScore(page) {
  const seo = page?.seo ?? page?.seoData ?? {};
  const title = seo.title ?? page?.pageUriSEO ?? '';
  const desc = seo.description ?? '';
  const noindex = seo.noIndex === true || seo.noIndex === 'true';
  const titleLen = (title || '').length;
  const descLen = (desc || '').length;
  const url = page?.url ?? page?.pageUriSEO ?? '';
  const urlFriendly = !url.includes('?') && url === url.toLowerCase();

  const has_seo_title = titleLen > 0 && title.toLowerCase() !== 'page';
  const seo_title_ok = titleLen >= 30 && titleLen <= 60;
  const has_meta_description = descLen > 0;
  const meta_desc_ok = descLen >= 50 && descLen <= 160;

  const issues = [];
  if (!has_seo_title) issues.push('missing_seo_title');
  else if (!seo_title_ok) issues.push(titleLen > 60 ? 'title_too_long' : 'title_too_short');
  if (!has_meta_description) issues.push('missing_meta_description');
  else if (!meta_desc_ok) issues.push(descLen > 160 ? 'description_too_long' : 'description_too_short');
  if (noindex) issues.push('noindexed');
  if (!urlFriendly) issues.push('url_not_friendly');

  let score = 100;
  if (!has_seo_title) score -= 30;
  else if (!seo_title_ok) score -= 10;
  if (!has_meta_description) score -= 30;
  else if (!meta_desc_ok) score -= 10;
  if (noindex) score -= 20;
  if (!urlFriendly) score -= 10;

  return {
    pageId: page?.id ?? page?.pageId ?? null,
    pageTitle: page?.title ?? '(untitled)',
    pageUrl: url,
    has_seo_title,
    seo_title_length: titleLen,
    seo_title_ok,
    has_meta_description,
    meta_desc_length: descLen,
    meta_desc_ok,
    is_indexed: !noindex,
    url_friendly: urlFriendly,
    issues,
    score: Math.max(0, score),
  };
}

const connector = {
  id: 'wix',
  name: 'Wix',
  category: 'cms',
  authType: 'apikey',
  icon: 'globe',

  capabilities: {
    read: true,
    write: true,
    writeRequiresApproval: true,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      hint: 'Wix Dashboard → Settings → Advanced → API Keys. Create with Sites, Pages, Blog, SEO permissions.',
    },
    {
      id: 'siteId',
      label: 'Site ID',
      type: 'text',
      required: true,
      hint: 'Found in Wix Dashboard URL: manage.wix.com/dashboard/{SITE-ID}/home',
    },
    {
      id: 'accountId',
      label: 'Account ID',
      type: 'text',
      required: true,
      hint: 'Found in Wix Dashboard → Account Settings.',
    },
  ],

  signalTypes: [
    'wix_seo_issues',
    'wix_pages_noindexed',
    'wix_blog_inactive',
    'wix_seo_score_drop',
    'wix_seo_opportunity',
  ],

  async healthCheck(credentials) {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      if (!credentials?.siteId) return { ok: false, error: 'Site ID missing.' };
      const res = await withRetry(
        () => wixFetch('/site-properties/v4/properties', credentials, { method: 'GET' }),
        { label: 'Wix healthCheck' }
      );
      const data = await res.json();
      const props = data?.properties ?? data;
      return {
        ok: true,
        details: {
          site_name: props?.businessName ?? props?.siteDisplayName ?? null,
          locale: props?.locale ?? null,
          timezone: props?.timeZone ?? null,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.apiKey) throw new Error('Wix API key is required.');
    if (!credentials?.siteId) throw new Error('Wix Site ID is required.');

    // Run every API call in parallel, each as a best-effort. Some endpoints
    // are gated by Wix plan tier (analytics in particular) — we skip those
    // gracefully instead of failing the whole sync.
    const results = await Promise.allSettled([
      withRetry(() => wixFetch('/site-properties/v4/properties', credentials), { label: 'Wix properties' }),
      withRetry(() => wixFetch('/pages/v1/pages?paging.limit=100', credentials), { label: 'Wix pages' }),
      withRetry(
        () => wixFetch('/blog/v3/posts/query', credentials, {
          method: 'POST',
          body: JSON.stringify({
            paging: { limit: 50 },
            sort: [{ fieldName: 'publishedDate', order: 'DESC' }],
          }),
        }),
        { label: 'Wix blog posts' }
      ),
      withRetry(() => wixFetch('/analytics/v2/data-totals', credentials, {
        method: 'POST',
        body: JSON.stringify({
          measurementTypes: ['SESSIONS', 'TOTAL_SESSIONS', 'PAGE_VIEWS', 'BOUNCE_RATE', 'SESSION_DURATION', 'UNIQUE_VISITORS'],
          dateRange: { startDate: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0] },
        }),
      }), { label: 'Wix analytics' }),
    ]);

    const [propsRes, pagesRes, blogRes, analyticsRes] = results;

    const properties = propsRes.status === 'fulfilled'
      ? (await propsRes.value.json())?.properties ?? null : null;
    const pagesBody = pagesRes.status === 'fulfilled'
      ? await pagesRes.value.json() : { pages: [] };
    const pages = Array.isArray(pagesBody?.pages) ? pagesBody.pages : [];
    const blogBody = blogRes.status === 'fulfilled'
      ? await blogRes.value.json() : { posts: [] };
    const posts = Array.isArray(blogBody?.posts) ? blogBody.posts : [];
    const analyticsAvailable = analyticsRes.status === 'fulfilled';
    const analytics = analyticsAvailable ? await analyticsRes.value.json() : null;

    // Run SEO audit on every page
    const seoAudit = pages.map(pageSeoScore);

    return {
      properties,
      pages,
      posts,
      analytics,
      analyticsAvailable,
      seoAudit,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const pages = Array.isArray(data?.pages) ? data.pages : [];
    const posts = Array.isArray(data?.posts) ? data.posts : [];
    const audit = Array.isArray(data?.seoAudit) ? data.seoAudit : [];

    const noSeoTitle = audit.filter((a) => !a.has_seo_title).length;
    const noMetaDesc = audit.filter((a) => !a.has_meta_description).length;
    const noindexed = audit.filter((a) => !a.is_indexed).length;

    const last30 = Date.now() - 30 * 86400000;
    const published30d = posts.filter((p) => {
      const ts = p.publishedDate ? new Date(p.publishedDate).getTime() : 0;
      return p.status === 'PUBLISHED' && ts >= last30;
    }).length;
    const blogNoSeo = posts.filter((p) => {
      const seo = p.seo ?? {};
      return !(seo.title && seo.description);
    }).length;

    const seoScore = audit.length > 0
      ? Math.round(audit.reduce((s, a) => s + a.score, 0) / audit.length)
      : 100;

    // Analytics — shape varies by plan; extract what's there.
    const a = data?.analytics;
    const getTotal = (typeKey) => {
      if (!a) return null;
      const row = (a.totals ?? []).find((t) => (t.type ?? t.measurementType) === typeKey);
      return row ? Number(row.total ?? row.value ?? 0) : null;
    };
    const sessions = getTotal('TOTAL_SESSIONS') ?? getTotal('SESSIONS');
    const pageviews = getTotal('PAGE_VIEWS');
    const bounce = getTotal('BOUNCE_RATE');
    const duration = getTotal('SESSION_DURATION');

    metrics.push(
      { name: 'wix.total_pages',              value: pages.length, data: null },
      { name: 'wix.pages_no_seo_title',       value: noSeoTitle, data: null },
      { name: 'wix.pages_no_meta_description', value: noMetaDesc, data: null },
      { name: 'wix.pages_noindexed',          value: noindexed, data: null },
      { name: 'wix.blog_posts_total',         value: posts.length, data: null },
      { name: 'wix.blog_posts_published_30d', value: published30d, data: null },
      { name: 'wix.blog_posts_no_seo',        value: blogNoSeo, data: null },
      { name: 'wix.seo_score',                value: seoScore, data: null },
    );

    if (data?.analyticsAvailable) {
      metrics.push(
        { name: 'wix.sessions_30d',           value: sessions ?? 0, data: null },
        { name: 'wix.pageviews_30d',          value: pageviews ?? 0, data: null },
        { name: 'wix.bounce_rate',            value: bounce ?? 0, data: null },
        { name: 'wix.avg_session_duration',   value: duration ?? 0, data: null },
      );
    }

    const seoIssues = audit
      .filter((a) => a.issues.length > 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 50);

    metrics.push(
      { name: 'wix.pages_data',     value: pages.length, data: pages.slice(0, 100) },
      { name: 'wix.posts_data',     value: posts.length, data: posts.slice(0, 50) },
      { name: 'wix.seo_audit_data', value: audit.length, data: audit },
      { name: 'wix.seo_issues',     value: seoIssues.length, data: seoIssues },
    );

    return metrics;
  },

  // ─── Write-back: SEO fields only ─────────────────────────────────────────
  //
  // Called from the task executor after a human has approved the task. Never
  // call this directly from agent code — agents must propose a wix_seo_update
  // task which a human approves before execution reaches here.
  async updatePageSeo(credentials, { pageId, title, description }) {
    if (!pageId) throw new Error('pageId is required for updatePageSeo.');
    const body = { page: { id: pageId, seo: {} } };
    if (title !== undefined) body.page.seo.title = title;
    if (description !== undefined) body.page.seo.description = description;
    const res = await wixFetch(`/pages/v1/pages/${pageId}`, credentials, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return res.json();
  },

  async updatePostSeo(credentials, { postId, title, description, slug }) {
    if (!postId) throw new Error('postId is required for updatePostSeo.');
    const body = { post: { id: postId, seo: {} } };
    if (title !== undefined) body.post.seo.title = title;
    if (description !== undefined) body.post.seo.description = description;
    if (slug !== undefined) body.post.slug = slug;
    const res = await wixFetch(`/blog/v3/posts/${postId}`, credentials, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.json();
  },

  async getAuthUrl() { throw new Error('Wix uses API key authentication, not OAuth.'); },
  async exchangeCode() { throw new Error('Wix uses API key authentication, not OAuth.'); },
  async refreshToken() { throw new Error('Wix uses API key authentication, not OAuth.'); },
};

export default connector;
