/**
 * Stannp connector — apikey auth (HTTP Basic with apiKey as username).
 *
 * Docs: https://www.stannp.com/uk/direct-mail-api
 * Endpoint base depends on region:
 *   GB: https://dash.stannp.com/api/v1
 *   US: https://us.stannp.com/api/v1
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

function regionBase(region) {
  return region === 'us'
    ? 'https://us.stannp.com/api/v1'
    : 'https://dash.stannp.com/api/v1';
}

function authHeader(apiKey) {
  // Stannp uses HTTP Basic with apiKey as the username and an empty password
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
}

function stannpFetch(endpoint, credentials, init = {}) {
  return checkedFetch(`${regionBase(credentials.region)}${endpoint}`, {
    ...init,
    headers: {
      Authorization: authHeader(credentials.apiKey),
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

const connector = {
  id: 'stannp',
  name: 'Stannp',
  category: 'marketing',
  authType: 'apikey',
  icon: 'send',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 720,
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      hint: 'Stannp Dashboard → Settings → API',
    },
    {
      id: 'region',
      label: 'Region',
      type: 'select',
      required: true,
      options: ['gb', 'us'],
      default: 'gb',
    },
  ],

  signalTypes: ['low_campaign_balance', 'stannp_campaign_failed', 'stannp_delivery_rate_drop'],

  async healthCheck(credentials) {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      const res = await withRetry(
        () => stannpFetch('/users/me', credentials),
        { label: 'Stannp healthCheck' }
      );
      const data = await res.json();
      return {
        ok: true,
        details: {
          balance: data.data?.balance,
          currency: data.data?.currency,
          region: credentials.region ?? 'gb',
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.apiKey) throw new Error('Stannp API key is required.');

    const [meRes, campaignsRes] = await Promise.all([
      withRetry(() => stannpFetch('/users/me', credentials), { label: 'Stannp account' }),
      withRetry(
        () => stannpFetch('/campaigns/list?page=1&per_page=50', credentials),
        { label: 'Stannp campaigns' }
      ),
    ]);

    const meData = await meRes.json();
    const campaignsData = await campaignsRes.json();

    return {
      account: meData.data ?? null,
      campaigns: campaignsData.data ?? [],
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];
    const balance = parseFloat(data?.account?.balance ?? 0);

    // Period filter: campaigns from last 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = campaigns.filter(c => {
      const ts = c.created ? new Date(c.created).getTime() : 0;
      return ts >= thirtyDaysAgo;
    });

    const delivered = recent.filter(c => c.status === 'delivered').length;
    const pending = recent.filter(c => ['pending', 'processing'].includes(c.status)).length;

    let totalSent = 0, totalDelivered = 0, totalSpend = 0;
    for (const c of recent) {
      const recipients = parseInt(c.total_recipients ?? 0, 10);
      const cost = parseFloat(c.total_cost ?? 0);
      const deliveredCount = parseInt(c.delivered ?? recipients, 10);
      totalSent += recipients;
      totalDelivered += deliveredCount;
      totalSpend += cost;
    }
    const avgDeliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 1000) / 1000 : 0;

    metrics.push(
      { name: 'stannp.account_balance',     value: Math.round(balance * 100) / 100, data: null },
      { name: 'stannp.campaigns_total',     value: campaigns.length,                data: null },
      { name: 'stannp.campaigns_delivered', value: delivered,                       data: null },
      { name: 'stannp.campaigns_pending',   value: pending,                         data: null },
      { name: 'stannp.total_sent_30d',      value: totalSent,                       data: null },
      { name: 'stannp.avg_delivery_rate',   value: avgDeliveryRate,                 data: null },
      { name: 'stannp.total_spend_30d',     value: Math.round(totalSpend * 100) / 100, data: null },
    );

    metrics.push({ name: 'stannp.campaigns_data', value: campaigns.length, data: campaigns.slice(0, 50) });

    return metrics;
  },

  async getAuthUrl() { throw new Error('Stannp uses API key authentication, not OAuth.'); },
  async exchangeCode() { throw new Error('Stannp uses API key authentication, not OAuth.'); },
  async refreshToken() { throw new Error('Stannp uses API key authentication, not OAuth.'); },
};

export default connector;
