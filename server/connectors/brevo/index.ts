/**
 * Brevo (formerly Sendinblue) connector — apikey auth.
 *
 * Docs: https://developers.brevo.com/reference
 * Endpoint base: https://api.brevo.com/v3
 *
 * Auth: header `api-key: <key>`.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

type Creds = Record<string, string | undefined>;

interface BrevoAccount {
  email?: string;
  firstName?: string;
  plan?: Array<{ type?: string }>;
}

interface BrevoGlobalStats {
  delivered?: number;
  uniqueOpens?: number;
  clicks?: number;
  unsubscriptions?: number;
  hardBounces?: number;
  softBounces?: number;
}

interface BrevoCampaign {
  status?: string;
  sentDate?: string;
  statistics?: {
    globalStats?: BrevoGlobalStats;
  };
}

interface BrevoCampaignsResponse {
  campaigns?: BrevoCampaign[];
}

interface BrevoContactsResponse {
  count?: number;
}

interface BrevoListsResponse {
  lists?: unknown[];
}

interface BrevoSmtpStats {
  delivered?: number;
  hardBounces?: number;
  softBounces?: number;
  requests?: number;
}

const BASE = 'https://api.brevo.com/v3';

function brevoFetch(endpoint: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
  return checkedFetch(`${BASE}${endpoint}`, {
    ...init,
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

const connector = {
  id: 'brevo' as const,
  name: 'Brevo',
  category: 'email' as const,
  authType: 'apikey' as const,
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
      type: 'password' as const,
      required: true,
      hint: 'Brevo Dashboard → Settings → SMTP & API → API Keys',
    },
  ],

  signalTypes: ['open_rate_drop', 'unsubscribe_spike', 'bounce_rate_high'],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      const res = await withRetry(
        () => brevoFetch('/account', credentials.apiKey!),
        { label: 'Brevo healthCheck' }
      );
      const data = await res.json() as BrevoAccount;
      return {
        ok: true,
        details: {
          email: data.email,
          firstName: data.firstName,
          plan: Array.isArray(data.plan) ? data.plan[0]?.type : null,
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(_dataType: string, credentials: Creds, _params?: Record<string, unknown>): Promise<unknown> {
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

    const account = await accountRes.json() as BrevoAccount;
    const campaignsData = await campaignsRes.json() as BrevoCampaignsResponse;
    const contactsData = await contactsRes.json() as BrevoContactsResponse;
    const listsData = await listsRes.json() as BrevoListsResponse;
    const smtp = smtpStatsRes ? await smtpStatsRes.json() as BrevoSmtpStats : null;

    return {
      account,
      campaigns: campaignsData.campaigns ?? [],
      total_contacts: contactsData.count ?? 0,
      lists: listsData.lists ?? [],
      smtp_7d: smtp,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as {
      campaigns?: BrevoCampaign[];
      total_contacts?: number;
      smtp_7d?: BrevoSmtpStats | null;
      lists?: unknown[];
    } | null;
    const campaigns = Array.isArray(d?.campaigns) ? d!.campaigns : [];

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
      const deliveredCount = s.delivered ?? 0;
      if (deliveredCount === 0) continue;
      openRateSum   += (s.uniqueOpens ?? 0) / deliveredCount * 100;
      clickRateSum  += (s.clicks ?? 0) / deliveredCount * 100;
      unsubRateSum  += (s.unsubscriptions ?? 0) / deliveredCount * 100;
      bounceRateSum += ((s.hardBounces ?? 0) + (s.softBounces ?? 0)) / deliveredCount * 100;
      count++;
    }
    const round = (n: number): number => Math.round(n * 100) / 100;
    const avgOpen   = count > 0 ? round(openRateSum / count) : 0;
    const avgClick  = count > 0 ? round(clickRateSum / count) : 0;
    const avgUnsub  = count > 0 ? round(unsubRateSum / count) : 0;
    const avgBounce = count > 0 ? round(bounceRateSum / count) : 0;

    metrics.push(
      { name: 'brevo.total_contacts',       value: d?.total_contacts ?? 0, data: null },
      { name: 'brevo.campaigns_sent_30d',   value: recent.length,          data: null },
      { name: 'brevo.avg_open_rate',        value: avgOpen,                data: null },
      { name: 'brevo.avg_click_rate',       value: avgClick,               data: null },
      { name: 'brevo.avg_unsubscribe_rate', value: avgUnsub,               data: null },
      { name: 'brevo.avg_bounce_rate',      value: avgBounce,              data: null },
    );

    // Transactional 7d if available
    if (d?.smtp_7d) {
      const smtp = d.smtp_7d;
      metrics.push(
        { name: 'brevo.transactional_delivered_7d', value: smtp.delivered ?? 0, data: null },
        { name: 'brevo.transactional_bounce_rate_7d', value: round(((smtp.hardBounces ?? 0) + (smtp.softBounces ?? 0)) / Math.max(smtp.requests ?? 1, 1) * 100), data: null },
      );
    }

    // Rich data
    metrics.push(
      { name: 'brevo.campaigns_data', value: campaigns.length, data: campaigns.slice(0, 50) },
      { name: 'brevo.lists_data',     value: d?.lists?.length ?? 0, data: d?.lists ?? [] },
    );

    return metrics;
  },

  async getAuthUrl(_state?: string): Promise<string> { throw new Error('Brevo uses API key authentication, not OAuth.'); },
  async exchangeCode(_code?: string): Promise<never> { throw new Error('Brevo uses API key authentication, not OAuth.'); },
  async refreshToken(_credentials?: Creds): Promise<never> { throw new Error('Brevo uses API key authentication, not OAuth.'); },
};

export default connector;
