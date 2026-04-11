import fetch from 'node-fetch';

const PSI_BASE = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIES = ['PERFORMANCE', 'ACCESSIBILITY', 'SEO', 'BEST_PRACTICES'];
const SKIP_AUDIT_IDS = new Set([
  'screenshot-thumbnails', 'final-screenshot', 'full-page-screenshot', 'network-requests',
  'network-rtt', 'network-server-latency', 'main-thread-tasks', 'diagnostics',
]);

async function runStrategy(url, strategy, apiKey) {
  const categoryQuery = CATEGORIES.map(c => `category=${c}`).join('&');
  const keyParam = apiKey ? `&key=${encodeURIComponent(apiKey)}` : '';
  const apiUrl = `${PSI_BASE}?url=${encodeURIComponent(url)}&strategy=${strategy}&${categoryQuery}${keyParam}`;

  const res = await fetch(apiUrl);
  if (!res.ok) {
    const body = await res.text();
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
      const apiKey = credentials?.apiKey || process.env.PAGESPEED_API_KEY || null;
      const result = await runStrategy(url, 'mobile', apiKey);
      return {
        ok: true,
        details: {
          url,
          performance: result.scores.performance,
          seo: result.scores.seo,
          accessibility: result.scores.accessibility,
          lcp_ms: result.cwv.lcp,
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

    // Priority: connector-specific key → env var fallback
    const apiKey = credentials?.apiKey || process.env.PAGESPEED_API_KEY || null;

    const [mobile, desktop] = await Promise.all([
      runStrategy(url, 'mobile', apiKey),
      runStrategy(url, 'desktop', apiKey),
    ]);

    return { url, mobile, desktop, fetchedAt: new Date().toISOString() };
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
