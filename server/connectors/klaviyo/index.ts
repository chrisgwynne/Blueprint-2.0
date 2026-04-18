/**
 * Klaviyo connector — apikey auth.
 *
 * Docs:  https://developers.klaviyo.com/en/reference/api_overview
 * Base:  https://a.klaviyo.com/api/
 *
 * Klaviyo is an email/SMS marketing platform typically paired with Shopify.
 * This connector surfaces the "why" behind orders (which flows and campaigns
 * drove revenue) that Shopify alone can't see.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

type Creds = Record<string, string | undefined>;

const BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-02-15';

function klaviyoHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: REVISION,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function klaviyoFetch(endpoint: string, apiKey: string, init: RequestInit = {}): ReturnType<typeof checkedFetch> {
  return checkedFetch(`${BASE}${endpoint}`, {
    ...init,
    headers: { ...klaviyoHeaders(apiKey), ...((init.headers as Record<string, string>) ?? {}) },
  });
}

const FLOW_NAME_PATTERNS: Record<string, RegExp> = {
  abandoned_cart:  /abandon(ed)?\s*cart/i,
  welcome:         /welcome|new\s*subscriber/i,
  post_purchase:   /post\s*purchase|thank\s*you|order\s*follow/i,
  win_back:        /win[-\s]?back|re[-\s]?engagement|lapsed/i,
  browse_abandon:  /browse\s*abandon/i,
};

function classifyFlow(name = ''): string | null {
  for (const [key, rx] of Object.entries(FLOW_NAME_PATTERNS)) {
    if (rx.test(name)) return key;
  }
  return null;
}

const connector = {
  id: 'klaviyo' as const,
  name: 'Klaviyo',
  category: 'email',
  authType: 'apikey',
  icon: 'mail',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360, // 6h — Klaviyo data doesn't change hourly
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'Private API Key',
      type: 'password',
      required: true,
      hint: 'Klaviyo → Account → Settings → API Keys. Use a Private API Key (not Public).',
    },
  ],

  signalTypes: [
    'klaviyo_open_rate_drop',
    'klaviyo_unsubscribe_spike',
    'klaviyo_abandoned_cart_opportunity',
    'klaviyo_revenue_drop',
    'klaviyo_list_growth_stalled',
    'klaviyo_low_click_rate',
  ],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      const res = await withRetry(
        () => klaviyoFetch('/accounts/', credentials.apiKey!),
        { label: 'Klaviyo healthCheck' }
      );
      const data = await res.json() as { data?: Array<Record<string, unknown>> };
      const account = Array.isArray(data?.data) ? data.data[0] : null;
      const attrs = account?.attributes as Record<string, unknown> | undefined;
      const contactInfo = attrs?.contact_information as Record<string, unknown> | undefined;
      return {
        ok: true,
        details: {
          account: (contactInfo?.organization_name as string | undefined) ?? null,
          timezone: (attrs?.timezone as string | undefined) ?? null,
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(_dataType: string, credentials: Creds, _params?: Record<string, unknown>): Promise<unknown> {
    if (!credentials?.apiKey) throw new Error('Klaviyo API key is required.');
    const apiKey = credentials.apiKey;

    // Resolve "placed order" conversion metric id once per fetch. Klaviyo
    // revenue reports require a metric id — this is the canonical one.
    let placedOrderMetricId: string | null = null;
    try {
      const res = await withRetry(
        () => klaviyoFetch('/metrics/', apiKey),
        { label: 'Klaviyo metrics' }
      );
      const body = await res.json() as { data?: Array<Record<string, unknown>> };
      const placed = (body?.data ?? []).find(
        (m) => ((m.attributes as Record<string, unknown> | undefined)?.name as string | undefined ?? '').toLowerCase() === 'placed order'
      );
      placedOrderMetricId = (placed?.id as string | undefined) ?? null;
    } catch (err) {
      console.warn('[klaviyo] failed to resolve Placed Order metric id:', (err as Error).message);
    }

    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // Campaigns (email, last 90 days)
    let campaigns: Array<Record<string, unknown>> = [];
    try {
      const campaignsRes = await withRetry(
        () => klaviyoFetch(
          `/campaigns/?filter=and(equals(messages.channel,'email'),greater-or-equal(send_time,'${ninetyDaysAgo}'))&fields[campaign]=name,status,send_time,archived,created_at,updated_at`,
          apiKey,
        ),
        { label: 'Klaviyo campaigns' }
      );
      const body = await campaignsRes.json() as { data?: Array<Record<string, unknown>> };
      campaigns = body?.data ?? [];
    } catch (err) {
      console.warn('[klaviyo] campaigns fetch failed:', (err as Error).message);
    }

    // Campaign values report (30d, if we have a conversion metric)
    let campaignValues: Array<Record<string, unknown>> = [];
    if (placedOrderMetricId) {
      try {
        const reportRes = await withRetry(
          () => klaviyoFetch('/campaign-values-reports/', apiKey, {
            method: 'POST',
            body: JSON.stringify({
              data: {
                type: 'campaign-values-report',
                attributes: {
                  timeframe: { key: 'last_30_days' },
                  conversion_metric_id: placedOrderMetricId,
                  statistics: [
                    'recipients', 'opens', 'opens_unique', 'clicks', 'clicks_unique',
                    'open_rate', 'click_rate', 'unsubscribes', 'unsubscribe_rate',
                    'conversions', 'conversion_value', 'revenue_per_recipient',
                  ],
                },
              },
            }),
          }),
          { label: 'Klaviyo campaign values' }
        );
        const body = await reportRes.json() as { data?: { attributes?: { results?: Array<Record<string, unknown>> } } };
        campaignValues = body?.data?.attributes?.results ?? [];
      } catch (err) {
        console.warn('[klaviyo] campaign values fetch failed:', (err as Error).message);
      }
    }

    // Live flows
    let flows: Array<Record<string, unknown>> = [];
    try {
      const flowsRes = await withRetry(
        () => klaviyoFetch(
          `/flows/?filter=equals(status,'live')&fields[flow]=name,status,trigger_type,created,updated`,
          apiKey,
        ),
        { label: 'Klaviyo flows' }
      );
      const body = await flowsRes.json() as { data?: Array<Record<string, unknown>> };
      flows = body?.data ?? [];
    } catch (err) {
      console.warn('[klaviyo] flows fetch failed:', (err as Error).message);
    }

    // Flow values report (30d)
    let flowValues: Array<Record<string, unknown>> = [];
    if (placedOrderMetricId) {
      try {
        const reportRes = await withRetry(
          () => klaviyoFetch('/flow-values-reports/', apiKey, {
            method: 'POST',
            body: JSON.stringify({
              data: {
                type: 'flow-values-report',
                attributes: {
                  timeframe: { key: 'last_30_days' },
                  conversion_metric_id: placedOrderMetricId,
                  statistics: [
                    'recipients', 'opens_unique', 'clicks_unique',
                    'conversions', 'conversion_value', 'revenue_per_recipient',
                  ],
                },
              },
            }),
          }),
          { label: 'Klaviyo flow values' }
        );
        const body = await reportRes.json() as { data?: { attributes?: { results?: Array<Record<string, unknown>> } } };
        flowValues = body?.data?.attributes?.results ?? [];
      } catch (err) {
        console.warn('[klaviyo] flow values fetch failed:', (err as Error).message);
      }
    }

    // Lists
    let lists: Array<Record<string, unknown>> = [];
    try {
      const listsRes = await withRetry(
        () => klaviyoFetch(`/lists/?fields[list]=name,created,opt_in_process`, apiKey),
        { label: 'Klaviyo lists' }
      );
      const body = await listsRes.json() as { data?: Array<Record<string, unknown>> };
      lists = body?.data ?? [];
    } catch (err) {
      console.warn('[klaviyo] lists fetch failed:', (err as Error).message);
    }

    return {
      placedOrderMetricId,
      campaigns,
      campaignValues,
      flows,
      flowValues,
      lists,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as Record<string, unknown> | null;
    const campaigns = Array.isArray(d?.campaigns) ? (d.campaigns as Array<Record<string, unknown>>) : [];
    const campaignValues = Array.isArray(d?.campaignValues) ? (d.campaignValues as Array<Record<string, unknown>>) : [];
    const flows = Array.isArray(d?.flows) ? (d.flows as Array<Record<string, unknown>>) : [];
    const flowValues = Array.isArray(d?.flowValues) ? (d.flowValues as Array<Record<string, unknown>>) : [];
    const lists = Array.isArray(d?.lists) ? (d.lists as Array<Record<string, unknown>>) : [];
    const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;

    // Campaigns sent in last 30 days
    const last30Epoch = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const sentRecent = campaigns.filter((c) => {
      const attrs = c.attributes as Record<string, unknown> | undefined;
      const s = attrs?.send_time as string | undefined;
      return (attrs?.status === 'Sent' || attrs?.status === 'sent')
        && s && new Date(s).getTime() >= last30Epoch;
    });

    // Build a map from campaign_id → values row so we can join metrics.
    const cvByCampaign = new Map<string, Record<string, unknown>>();
    for (const row of campaignValues) {
      const groupings = row?.groupings as Record<string, unknown> | undefined;
      const id = groupings?.campaign_id as string | undefined;
      if (id) cvByCampaign.set(id, (row?.statistics as Record<string, unknown>) ?? {});
    }

    // Aggregate open/click rate and revenue across sent campaigns.
    let openSum = 0, clickSum = 0, revenueSum = 0, unsubSum = 0, recipientsSum = 0, count = 0;
    const campaignRows: Array<Record<string, unknown>> = [];
    for (const c of sentRecent) {
      const attrs = c.attributes as Record<string, unknown> | undefined;
      const stats = cvByCampaign.get(c.id as string) ?? {};
      const recipients = Number(stats.recipients ?? 0);
      const openRate = Number(stats.open_rate ?? 0);
      const clickRate = Number(stats.click_rate ?? 0);
      const unsubs = Number(stats.unsubscribes ?? 0);
      const revenue = Number(stats.conversion_value ?? 0);
      openSum += openRate;
      clickSum += clickRate;
      revenueSum += revenue;
      unsubSum += unsubs;
      recipientsSum += recipients;
      count++;
      campaignRows.push({
        id: c.id,
        name: (attrs?.name as string | undefined) ?? '(unnamed)',
        send_time: (attrs?.send_time as string | undefined) ?? null,
        status: (attrs?.status as string | undefined) ?? null,
        recipients,
        open_rate: round(openRate, 4),
        click_rate: round(clickRate, 4),
        revenue: round(revenue, 2),
        unsubscribes: unsubs,
      });
    }

    const avgOpen  = count > 0 ? round(openSum / count, 4) : 0;
    const avgClick = count > 0 ? round(clickSum / count, 4) : 0;
    const unsubRate = recipientsSum > 0 ? round(unsubSum / recipientsSum, 4) : 0;
    const revenuePerEmail = recipientsSum > 0 ? round(revenueSum / recipientsSum, 4) : 0;

    // Flows
    const fvByFlow = new Map<string, Record<string, unknown>>();
    for (const row of flowValues) {
      const groupings = row?.groupings as Record<string, unknown> | undefined;
      const id = groupings?.flow_id as string | undefined;
      if (id) fvByFlow.set(id, (row?.statistics as Record<string, unknown>) ?? {});
    }

    let flowRevenueTotal = 0;
    const revenueByClass: Record<'abandoned_cart' | 'welcome' | 'post_purchase' | 'win_back' | 'browse_abandon', number> = { abandoned_cart: 0, welcome: 0, post_purchase: 0, win_back: 0, browse_abandon: 0 };
    const flowRows: Array<Record<string, unknown>> = [];
    for (const f of flows) {
      const attrs = f.attributes as Record<string, unknown> | undefined;
      const stats = fvByFlow.get(f.id as string) ?? {};
      const revenue = Number(stats.conversion_value ?? 0);
      const recipients = Number(stats.recipients ?? 0);
      flowRevenueTotal += revenue;
      const cls = classifyFlow(attrs?.name as string | undefined);
      if (cls && cls in revenueByClass) { const rc = revenueByClass as Record<string, number>; rc[cls] = (rc[cls] ?? 0) + revenue; }
      flowRows.push({
        id: f.id,
        name: (attrs?.name as string | undefined) ?? '(unnamed)',
        trigger_type: (attrs?.trigger_type as string | undefined) ?? null,
        status: (attrs?.status as string | undefined) ?? null,
        recipients,
        opens: Number(stats.opens_unique ?? 0),
        clicks: Number(stats.clicks_unique ?? 0),
        revenue: round(revenue, 2),
        revenue_per_recipient: round(Number(stats.revenue_per_recipient ?? 0), 4),
        class: cls,
      });
    }

    // Lists — sum member counts if available on attributes
    let totalSubscribers = 0;
    const listRows: Array<Record<string, unknown>> = [];
    for (const l of lists) {
      const attrs = (l.attributes ?? {}) as Record<string, unknown>;
      const profileCount = Number(attrs.profile_count ?? 0);
      totalSubscribers += profileCount;
      listRows.push({
        id: l.id,
        name: (attrs.name as string | undefined) ?? '(unnamed)',
        profile_count: profileCount,
        opt_in_process: (attrs.opt_in_process as string | undefined) ?? null,
        created: (attrs.created as string | undefined) ?? null,
      });
    }

    const totalAttributedRevenue = revenueSum + flowRevenueTotal;

    metrics.push(
      { name: 'klaviyo.campaigns_sent_30d',            value: sentRecent.length,              data: null },
      { name: 'klaviyo.campaign_open_rate',            value: avgOpen,                         data: null },
      { name: 'klaviyo.campaign_click_rate',           value: avgClick,                        data: null },
      { name: 'klaviyo.campaign_revenue_30d',          value: round(revenueSum, 2),            data: null },
      { name: 'klaviyo.flows_live_count',              value: flows.length,                    data: null },
      { name: 'klaviyo.flow_revenue_30d',              value: round(flowRevenueTotal, 2),      data: null },
      { name: 'klaviyo.flow_abandoned_cart_revenue',   value: round(revenueByClass.abandoned_cart, 2), data: null },
      { name: 'klaviyo.flow_welcome_revenue',          value: round(revenueByClass.welcome, 2), data: null },
      { name: 'klaviyo.flow_winback_revenue',          value: round(revenueByClass.win_back, 2), data: null },
      { name: 'klaviyo.total_subscribers',             value: totalSubscribers,                data: null },
      { name: 'klaviyo.unsubscribe_rate_30d',          value: unsubRate,                       data: null },
      { name: 'klaviyo.total_attributed_revenue_30d',  value: round(totalAttributedRevenue, 2), data: null },
      { name: 'klaviyo.revenue_per_email_sent',        value: revenuePerEmail,                 data: null },
    );

    // Rich data
    metrics.push(
      { name: 'klaviyo.campaigns_data', value: campaignRows.length, data: campaignRows.slice(0, 50) },
      { name: 'klaviyo.flows_data',     value: flowRows.length,     data: flowRows },
      { name: 'klaviyo.lists_data',     value: listRows.length,     data: listRows.slice(0, 50) },
    );

    return metrics;
  },

  async getAuthUrl(_state: string): Promise<string> { throw new Error('Klaviyo uses API key authentication, not OAuth.'); },
  async exchangeCode(_code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> { throw new Error('Klaviyo uses API key authentication, not OAuth.'); },
  async refreshToken(_credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> { throw new Error('Klaviyo uses API key authentication, not OAuth.'); },
};

export default connector;
