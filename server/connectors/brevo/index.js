/**
 * Brevo (formerly Sendinblue) connector — apikey auth.
 *
 * Docs: https://developers.brevo.com/reference
 * Endpoint base: https://api.brevo.com/v3
 *
 * Auth: header `api-key: <key>`.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

const BASE = 'https://api.brevo.com/v3';

function brevoFetch(endpoint, apiKey, init = {}) {
  return checkedFetch(`${BASE}${endpoint}`, {
    ...init,
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

const connector = {
  id: 'brevo',
  name: 'Brevo',
  category: 'email',
  authType: 'apikey',
  icon: 'mail',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      hint: 'Brevo Dashboard → Settings → SMTP & API → API Keys',
    },
  ],

  signalTypes: ['open_rate_drop', 'unsubscribe_spike', 'bounce_rate_high'],

  async healthCheck(credentials) {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      const res = await withRetry(
        () => brevoFetch('/account', credentials.apiKey),
        { label: 'Brevo healthCheck' }
      );
      const data = await res.json();
      return {
        ok: true,
        details: {
          email: data.email,
          firstName: data.firstName,
          plan: Array.isArray(data.plan) ? data.plan[0]?.type : null,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.apiKey) throw new Error('Brevo API key is required.');
    const apiKey = credentials.apiKey;

    // Run all calls in parallel
    const [accountRes, campaignsRes, contactsRes, listsRes, smtpStatsRes] = await Promise.all([
      withRetry(() => brevoFetch('/account', apiKey), { label: 'Brevo account' }),
      withRetry(
        () => brevoFetch('/emailCampaigns?limit=50&offset=0&sort=desc', apiKey),
        { label: 'Brevo campaigns' }
      ),
      withRetry(() => brevoFetch('/contacts?limit=1', apiKey), { label: 'Brevo contacts count' }),
      withRetry(() => brevoFetch('/contacts/lists?limit=20', apiKey), { label: 'Brevo lists' }),
      withRetry(
        () => brevoFetch('/smtp/statistics/aggregatedReport?days=7', apiKey),
        { label: 'Brevo SMTP stats' }
      ).catch(() => null), // optional — some accounts don't have transactional
    ]);

    const account = await accountRes.json();
    const campaignsData = await campaignsRes.json();
    const contactsData = await contactsRes.json();
    const listsData = await listsRes.json();
    const smtp = smtpStatsRes ? await smtpStatsRes.json() : null;

    return {
      account,
      campaigns: campaignsData.campaigns ?? [],
      total_contacts: contactsData.count ?? 0,
      lists: listsData.lists ?? [],
      smtp_7d: smtp,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];

    // Filter to recently sent campaigns for averaging
    const sent = campaigns.filter(c => c.status === 'sent' && c.statistics?.globalStats);
    const last30dEpoch = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = sent.filter(c => {
      const ts = c.sentDate ? new Date(c.sentDate).getTime() : 0;
      return ts >= last30dEpoch;
    });

    // Aggregate stats
    let openRateSum = 0, clickRateSum = 0, unsubRateSum = 0, bounceRateSum = 0, count = 0;
    for (const c of recent) {
      const s = c.statistics?.globalStats ?? {};
      const delivered = s.delivered ?? 0;
      if (delivered === 0) continue;
      openRateSum   += (s.uniqueOpens ?? 0) / delivered * 100;
      clickRateSum  += (s.clicks ?? 0) / delivered * 100;
      unsubRateSum  += (s.unsubscriptions ?? 0) / delivered * 100;
      bounceRateSum += ((s.hardBounces ?? 0) + (s.softBounces ?? 0)) / delivered * 100;
      count++;
    }
    const round = n => Math.round(n * 100) / 100;
    const avgOpen   = count > 0 ? round(openRateSum / count) : 0;
    const avgClick  = count > 0 ? round(clickRateSum / count) : 0;
    const avgUnsub  = count > 0 ? round(unsubRateSum / count) : 0;
    const avgBounce = count > 0 ? round(bounceRateSum / count) : 0;

    metrics.push(
      { name: 'brevo.total_contacts',       value: data.total_contacts ?? 0, data: null },
      { name: 'brevo.campaigns_sent_30d',   value: recent.length,            data: null },
      { name: 'brevo.avg_open_rate',        value: avgOpen,                  data: null },
      { name: 'brevo.avg_click_rate',       value: avgClick,                 data: null },
      { name: 'brevo.avg_unsubscribe_rate', value: avgUnsub,                 data: null },
      { name: 'brevo.avg_bounce_rate',      value: avgBounce,                data: null },
    );

    // Transactional 7d if available
    if (data.smtp_7d) {
      metrics.push(
        { name: 'brevo.transactional_delivered_7d', value: data.smtp_7d.delivered ?? 0, data: null },
        { name: 'brevo.transactional_bounce_rate_7d', value: round(((data.smtp_7d.hardBounces ?? 0) + (data.smtp_7d.softBounces ?? 0)) / Math.max(data.smtp_7d.requests ?? 1, 1) * 100), data: null },
      );
    }

    // Rich data
    metrics.push(
      { name: 'brevo.campaigns_data', value: campaigns.length, data: campaigns.slice(0, 50) },
      { name: 'brevo.lists_data',     value: data.lists?.length ?? 0, data: data.lists ?? [] },
    );

    return metrics;
  },

  async getAuthUrl() { throw new Error('Brevo uses API key authentication, not OAuth.'); },
  async exchangeCode() { throw new Error('Brevo uses API key authentication, not OAuth.'); },
  async refreshToken() { throw new Error('Brevo uses API key authentication, not OAuth.'); },
};

export default connector;
