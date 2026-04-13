import fetch from 'node-fetch';
import { getValidGoogleAccessToken } from '../google-auth.js';

const PSI_BASE = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIES = ['PERFORMANCE', 'ACCESSIBILITY', 'SEO', 'BEST_PRACTICES'];

/**
 * Resolve which auth method to use for a PageSpeed request, in priority:
 *   1. OAuth token from any connected GSC/GA4/GBP connector for this business
 *   2. Connector-specific PageSpeed API key
 *   3. Env PAGESPEED_API_KEY
 *   4. No auth (low anonymous quota)
 *
 * The businessId is plumbed through `params` because the connector framework
 * doesn't pass it to fetch() by default — see scheduler/post-sync wiring.
 */
async function resolveAuth(credentials, params) {
  const businessId = params?.businessId || credentials?.businessId;
  if (businessId) {
    try {
      const tok = await getValidGoogleAccessToken(businessId);
      if (tok?.accessToken) return { accessToken: tok.accessToken };
    } catch (err) {
      console.warn('[pagespeed] OAuth lookup failed, falling back to api key:', err.message);
    }
  }
  const apiKey = credentials?.apiKey || process.env.PAGESPEED_API_KEY || null;
  return { apiKey };
}
const SKIP_AUDIT_IDS = new Set([
  'screenshot-thumbnails', 'final-screenshot', 'full-page-screenshot', 'network-requests',
  'network-rtt', 'network-server-latency', 'main-thread-tasks', 'diagnostics',
]);

async function runStrategy(url, strategy, auth) {
  const { apiKey, accessToken } = auth ?? {};
  const categoryQuery = CATEGORIES.map(c => `category=${c}`).join('&');
  // Bearer token (OAuth) takes precedence over api key. With either, you
  // get the per-user quota; with neither, you get the small anonymous quota.
  const keyParam = (!accessToken && apiKey) ? `&key=${encodeURIComponent(apiKey)}` : '';
  const apiUrl = `${PSI_BASE}?url=${encodeURIComponent(url)}&strategy=${strategy}&${categoryQuery}${keyParam}`;

  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(apiUrl, { headers });
  if (!res.ok) {
    const body = await res.text();

    // Google's "API key not valid" error is deliberately ambiguous — it
    // fires for a revoked key, a key for a different project, a wrong
    // key, OR (most commonly) the PageSpeed Insights API not being
    // enabled on this key's Cloud project. Surface the real causes so
    // the user doesn't chase the wrong thing.
    if (res.status === 400 && /API key not valid/i.test(body)) {
      const hint = apiKey
        ? 'An API key was sent but Google rejected it. Most common causes: '
          + '(1) the PageSpeed Insights API is not enabled on the Google Cloud '
          + 'project that owns this key — enable it at '
          + 'https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com. '
          + '(2) the key is restricted to other APIs or to specific referrers/IPs. '
          + '(3) the key was regenerated or revoked. '
          + 'Create a fresh unrestricted key under APIs & Services → Credentials.'
        : 'No API key was sent. Add one in Connectors → PageSpeed → Edit.';
      throw new Error(`PageSpeed API rejected the request (${strategy}): ${hint}`);
    }

    if ((res.status === 403 || res.status === 429) && /quota|rate/i.test(body)) {
      // Project number 583797351490 is Google's PUBLIC anonymous PSI
      // project — if it appears in the error, the request was treated as
      // anonymous (no OAuth token, no api key) and we hit the per-IP
      // shared quota. That means our auth wasn't applied.
      const anonymous = /583797351490/.test(body);
      const usedAuth = accessToken ? 'OAuth bearer token' : (apiKey ? 'API key' : 'no auth');
      const hint = anonymous
        ? 'Request was treated as anonymous (no OAuth or API key reached PageSpeed). '
          + 'Most likely cause: no Google connector is connected for this business yet, OR '
          + 'PageSpeed Insights API is not enabled on your Google Cloud project. '
          + 'Enable it at https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com '
          + 'on the same project that owns your OAuth client (Settings → Google OAuth shows the Client ID).'
        : `Authenticated as ${usedAuth} but Google still rejected on quota. `
          + 'Daily limit reset at midnight Pacific. Add a billing account to your Cloud project to raise the limit.';
      throw new Error(`PageSpeed quota exceeded (${strategy}, status ${res.status}). ${hint}`);
    }

    throw new Error(`PageSpeed API error ${res.status} (${strategy}): ${body.substring(0, 300)}`);
  }

  const data = await res.json();
  return parseResult(data, strategy);
}

function numericMs(audit) {
  return audit?.numericValue != null ? Math.round(audit.numericValue) : null;
}

function parseResult(data, strategy) {
  const cats = data.lighthouseResult?.categories ?? {};
  const audits = data.lighthouseResult?.audits ?? {};

  const scores = {
    performance: Math.round((cats.performance?.score ?? 0) * 100),
    accessibility: Math.round((cats.accessibility?.score ?? 0) * 100),
    seo: Math.round((cats.seo?.score ?? 0) * 100),
    bestPractices: Math.round((cats['best-practices']?.score ?? 0) * 100),
  };

  const cls = audits['cumulative-layout-shift']?.numericValue;
  const cwv = {
    lcp: numericMs(audits['largest-contentful-paint']),
    fid: numericMs(audits['max-potential-fid']),
    cls: cls != null ? Math.round(cls * 1000) / 1000 : null,
    fcp: numericMs(audits['first-contentful-paint']),
    ttfb: numericMs(audits['server-response-time']),
    speedIndex: numericMs(audits['speed-index']),
    tti: numericMs(audits['interactive']),
    tbt: numericMs(audits['total-blocking-time']),
  };

  // Opportunities — audits where details.type === 'opportunity' with savings
  const opportunities = [];
  for (const [id, audit] of Object.entries(audits)) {
    if (audit.details?.type === 'opportunity') {
      const savingsMs = audit.details?.overallSavingsMs ?? 0;
      if (savingsMs > 0) {
        opportunities.push({
          id,
          title: audit.title,
          description: audit.description,
          savingsMs: Math.round(savingsMs),
          score: audit.score,
        });
      }
    }
  }
  opportunities.sort((a, b) => b.savingsMs - a.savingsMs);

  // Diagnostics — non-passing audits that aren't opportunities or skipped
  const diagnostics = [];
  for (const [id, audit] of Object.entries(audits)) {
    if (SKIP_AUDIT_IDS.has(id)) continue;
    if (audit.details?.type === 'opportunity') continue;
    if (audit.score !== null && audit.score !== undefined && audit.score < 0.9) {
      diagnostics.push({
        id,
        title: audit.title,
        score: audit.score,
        displayValue: audit.displayValue ?? null,
      });
    }
  }
  diagnostics.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  return { strategy, scores, cwv, opportunities, diagnostics };
}

const connector = {
  id: 'pagespeed',
  name: 'Google PageSpeed',
  category: 'seo',
  authType: 'apikey',
  icon: 'zap',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 1440,
  },

  signalTypes: [
    'pagespeed_regression', 'cwv_lcp_failing', 'cwv_cls_failing',
    'cwv_fid_failing', 'score_drop_mobile', 'opportunities_detected',
  ],

  async healthCheck(credentials, config = {}) {
    const url = config?.url || credentials?.url;
    if (!url) return { ok: false, error: 'No URL configured. Set a URL in the connector config.' };

    try {
      const auth = await resolveAuth(credentials, config);
      const result = await runStrategy(url, 'mobile', auth);
      return {
        ok: true,
        details: {
          url,
          performance: result.scores.performance,
          seo: result.scores.seo,
          accessibility: result.scores.accessibility,
          lcp_ms: result.cwv.lcp,
          authMethod: auth.accessToken ? 'oauth' : (auth.apiKey ? 'apikey' : 'anonymous'),
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Fetch both mobile + desktop strategies in parallel.
   * Returns: { url, mobile: { strategy, scores, cwv, opportunities, diagnostics }, desktop: {...}, fetchedAt }
   */
  async fetch(dataType, credentials, params) {
    const url = params?.url || credentials?.url;
    if (!url) throw new Error('URL is required. Configure a URL for the PageSpeed connector.');

    const auth = await resolveAuth(credentials, params);

    const [mobile, desktop] = await Promise.all([
      runStrategy(url, 'mobile', auth),
      runStrategy(url, 'desktop', auth),
    ]);

    return { url, mobile, desktop, fetchedAt: new Date().toISOString(), authMethod: auth.accessToken ? 'oauth' : (auth.apiKey ? 'apikey' : 'anonymous') };
  },

  /**
   * Extract individual metric rows from a fetch result.
   * Called by the scheduler after fetch() to write named metric rows to the DB.
   * Returns array of { name, value, data }
   */
  extractMetrics(data, runAt) {
    const metrics = [];
    for (const strategy of ['mobile', 'desktop']) {
      const s = data[strategy];
      if (!s) continue;
      const p = `pagespeed.${strategy}`;

      metrics.push(
        { name: `${p}.performance_score`,    value: s.scores.performance,   data: s.scores },
        { name: `${p}.accessibility_score`,  value: s.scores.accessibility,  data: null },
        { name: `${p}.best_practices_score`, value: s.scores.bestPractices,  data: null },
        { name: `${p}.seo_score`,            value: s.scores.seo,            data: null },
      );

      const cwv = s.cwv;
      if (cwv.lcp        != null) metrics.push({ name: `${p}.lcp_ms`,          value: cwv.lcp,        data: null });
      if (cwv.fid        != null) metrics.push({ name: `${p}.fid_ms`,          value: cwv.fid,        data: null });
      if (cwv.cls        != null) metrics.push({ name: `${p}.cls`,             value: cwv.cls,        data: null });
      if (cwv.fcp        != null) metrics.push({ name: `${p}.fcp_ms`,          value: cwv.fcp,        data: null });
      if (cwv.ttfb       != null) metrics.push({ name: `${p}.ttfb_ms`,         value: cwv.ttfb,       data: null });
      if (cwv.speedIndex != null) metrics.push({ name: `${p}.speed_index_ms`,  value: cwv.speedIndex, data: null });
      if (cwv.tti        != null) metrics.push({ name: `${p}.tti_ms`,          value: cwv.tti,        data: null });
      if (cwv.tbt        != null) metrics.push({ name: `${p}.tbt_ms`,          value: cwv.tbt,        data: null });

      if (s.opportunities.length > 0) {
        metrics.push({ name: `${p}.opportunities`, value: s.opportunities.length, data: s.opportunities });
      }
      if (s.diagnostics.length > 0) {
        metrics.push({ name: `${p}.diagnostics`, value: s.diagnostics.length, data: s.diagnostics });
      }
    }
    return metrics;
  },

  async getAuthUrl() { throw new Error('PageSpeed uses API key authentication, not OAuth.'); },
  async exchangeCode() { throw new Error('PageSpeed uses API key authentication, not OAuth.'); },
  async refreshToken() { throw new Error('PageSpeed uses API key authentication, not OAuth.'); },
};

export default connector;
