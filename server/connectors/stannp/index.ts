/**
 * Stannp connector — apikey auth (HTTP Basic with apiKey as username).
 *
 * Docs: https://www.stannp.com/uk/direct-mail-api
 * Endpoint base depends on region:
 *   GB: https://dash.stannp.com/api/v1
 *   US: https://us.stannp.com/api/v1
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

type Creds = Record<string, string | undefined>;

interface StannpUserData {
  balance?: string | number;
  currency?: string;
}

interface StannpUserResponse {
  data?: StannpUserData;
}

interface StannpCampaign {
  status?: string;
  created?: string;
  total_recipients?: string | number;
  total_cost?: string | number;
  delivered?: string | number;
}

interface StannpCampaignsResponse {
  data?: StannpCampaign[];
}

function regionBase(region: string | undefined): string {
  return region === 'us'
    ? 'https://us.stannp.com/api/v1'
    : 'https://dash.stannp.com/api/v1';
}

function authHeader(apiKey: string): string {
  // Stannp uses HTTP Basic with apiKey as the username and an empty password
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
}

function stannpFetch(endpoint: string, credentials: Creds, init: RequestInit = {}): Promise<Response> {
  return checkedFetch(`${regionBase(credentials['region'])}${endpoint}`, {
    ...init,
    headers: {
      Authorization: authHeader(credentials['apiKey'] ?? ''),
      Accept: 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

const connector = {
  id: 'stannp' as const,
  name: 'Stannp',
  category: 'marketing' as const,
  authType: 'apikey' as const,
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
      type: 'password' as const,
      required: true,
      hint: 'Stannp Dashboard → Settings → API',
    },
    {
      id: 'region',
      label: 'Region',
      type: 'select' as const,
      required: true,
      options: ['gb', 'us'],
      default: 'gb',
    },
  ],

  signalTypes: ['low_campaign_balance', 'stannp_campaign_failed', 'stannp_delivery_rate_drop'],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      const res = await withRetry(
        () => stannpFetch('/users/me', credentials),
        { label: 'Stannp healthCheck' }
      );
      const data = await res.json() as StannpUserResponse;
      return {
        ok: true,
        details: {
          balance: data.data?.balance,
          currency: data.data?.currency,
          region: credentials['region'] ?? 'gb',
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(_dataType: string, credentials: Creds, _params?: Record<string, unknown>): Promise<unknown> {
    if (!credentials?.apiKey) throw new Error('Stannp API key is required.');

    const [meRes, campaignsRes] = await Promise.all([
      withRetry(() => stannpFetch('/users/me', credentials), { label: 'Stannp account' }),
      withRetry(
        () => stannpFetch('/campaigns/list?page=1&per_page=50', credentials),
        { label: 'Stannp campaigns' }
      ),
    ]);

    const meData = await meRes.json() as StannpUserResponse;
    const campaignsData = await campaignsRes.json() as StannpCampaignsResponse;

    return {
      account: meData.data ?? null,
      campaigns: campaignsData.data ?? [],
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as { campaigns?: StannpCampaign[]; account?: StannpUserData } | null;
    const campaigns = Array.isArray(d?.campaigns) ? d!.campaigns : [];
    const balance = parseFloat(String(d?.account?.balance ?? 0));

    // Period filter: campaigns from last 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = campaigns.filter(c => {
      const ts = c.created ? new Date(c.created).getTime() : 0;
      return ts >= thirtyDaysAgo;
    });

    const delivered = recent.filter(c => c.status === 'delivered').length;
    const pending = recent.filter(c => ['pending', 'processing'].includes(c.status ?? '')).length;

    let totalSent = 0, totalDelivered = 0, totalSpend = 0;
    for (const c of recent) {
      const recipients = parseInt(String(c.total_recipients ?? 0), 10);
      const cost = parseFloat(String(c.total_cost ?? 0));
      const deliveredCount = parseInt(String(c.delivered ?? recipients), 10);
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

  async getAuthUrl(_state?: string): Promise<string> { throw new Error('Stannp uses API key authentication, not OAuth.'); },
  async exchangeCode(_code?: string): Promise<never> { throw new Error('Stannp uses API key authentication, not OAuth.'); },
  async refreshToken(_credentials?: Creds): Promise<never> { throw new Error('Stannp uses API key authentication, not OAuth.'); },
};

export default connector;
