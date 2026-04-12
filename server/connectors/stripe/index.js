/**
 * Stripe connector — apikey auth.
 *
 * Use a Restricted Key with read-only access to: charges, customers,
 * subscriptions, invoices, payment_intents, refunds, balance.
 *
 * Docs: https://stripe.com/docs/api
 */
import Stripe from 'stripe';

function getClient(credentials) {
  if (!credentials?.apiKey) throw new Error('Stripe API key is required.');
  return new Stripe(credentials.apiKey, { apiVersion: '2024-06-20' });
}

function calculateMRR(subscriptions) {
  let mrr = 0;
  for (const sub of subscriptions) {
    const item = sub.items?.data?.[0];
    if (!item) continue;
    const amount = (item.price?.unit_amount ?? 0) / 100;
    const interval = item.price?.recurring?.interval;
    const intervalCount = item.price?.recurring?.interval_count ?? 1;
    if (interval === 'month') mrr += amount / intervalCount;
    else if (interval === 'year') mrr += amount / (12 * intervalCount);
    else if (interval === 'week') mrr += amount * (52 / 12) / intervalCount;
    else if (interval === 'day') mrr += amount * (365 / 12) / intervalCount;
  }
  return mrr;
}

const connector = {
  id: 'stripe',
  name: 'Stripe',
  category: 'payments',
  authType: 'apikey',
  icon: 'credit-card',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'Stripe Secret Key',
      type: 'password',
      required: true,
      hint: 'Use a Restricted Key with read-only access. Dashboard → Developers → API Keys → Create restricted key.',
    },
    {
      id: 'currency',
      label: 'Currency',
      type: 'select',
      required: true,
      options: ['gbp', 'usd', 'eur'],
      default: 'gbp',
    },
  ],

  signalTypes: [
    'stripe_mrr_drop', 'stripe_failed_payments', 'stripe_refund_spike', 'stripe_revenue_drop',
  ],

  async healthCheck(credentials) {
    try {
      const stripe = getClient(credentials);
      const balance = await stripe.balance.retrieve();
      return {
        ok: true,
        details: {
          available: balance.available?.[0] ?? null,
          pending: balance.pending?.[0] ?? null,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    const stripe = getClient(credentials);
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;

    const [
      balance,
      chargesPage,
      subscriptionsPage,
      invoicesPage,
      paymentIntentsPage,
      refundsPage,
      customersPage,
    ] = await Promise.all([
      stripe.balance.retrieve().catch(() => null),
      stripe.charges.list({ limit: 100, created: { gte: since } }).catch(() => ({ data: [] })),
      stripe.subscriptions.list({ limit: 100, status: 'active' }).catch(() => ({ data: [] })),
      stripe.invoices.list({ limit: 100, created: { gte: since } }).catch(() => ({ data: [] })),
      stripe.paymentIntents.list({ limit: 100, created: { gte: since } }).catch(() => ({ data: [] })),
      stripe.refunds.list({ limit: 100, created: { gte: since } }).catch(() => ({ data: [] })),
      stripe.customers.list({ limit: 100 }).catch(() => ({ data: [] })),
    ]);

    return {
      balance,
      charges: chargesPage.data ?? [],
      subscriptions: subscriptionsPage.data ?? [],
      invoices: invoicesPage.data ?? [],
      payment_intents: paymentIntentsPage.data ?? [],
      refunds: refundsPage.data ?? [],
      customers: customersPage.data ?? [],
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const charges = Array.isArray(data?.charges) ? data.charges : [];
    const subscriptions = Array.isArray(data?.subscriptions) ? data.subscriptions : [];
    const refunds = Array.isArray(data?.refunds) ? data.refunds : [];
    const customers = Array.isArray(data?.customers) ? data.customers : [];
    const intents = Array.isArray(data?.payment_intents) ? data.payment_intents : [];

    // Successful charges → revenue (in major units, e.g. £)
    const successCharges = charges.filter(c => c.paid && c.status === 'succeeded' && !c.refunded);
    const revenue30d = successCharges.reduce((s, c) => s + (c.amount ?? 0) / 100, 0);

    // Refunds total (in major units)
    const refunds30d = refunds.reduce((s, r) => s + (r.amount ?? 0) / 100, 0);
    const netRevenue30d = revenue30d - refunds30d;

    const failedPayments30d = intents.filter(pi =>
      pi.status === 'requires_payment_method' || pi.status === 'canceled'
    ).length;

    const mrr = calculateMRR(subscriptions);
    const arr = mrr * 12;

    const round = n => Math.round(n * 100) / 100;
    const aov = successCharges.length > 0 ? revenue30d / successCharges.length : 0;
    const refundRate = revenue30d > 0 ? (refunds30d / revenue30d) * 100 : 0;

    // New customers in last 30 days
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
    const newCustomers30d = customers.filter(c => (c.created ?? 0) >= cutoff).length;

    metrics.push(
      { name: 'stripe.mrr',                   value: round(mrr),            data: null },
      { name: 'stripe.arr',                   value: round(arr),            data: null },
      { name: 'stripe.revenue_30d',           value: round(revenue30d),     data: null },
      { name: 'stripe.refunds_30d',           value: round(refunds30d),     data: null },
      { name: 'stripe.net_revenue_30d',       value: round(netRevenue30d),  data: null },
      { name: 'stripe.failed_payments_30d',   value: failedPayments30d,     data: null },
      { name: 'stripe.active_subscriptions',  value: subscriptions.length,  data: null },
      { name: 'stripe.new_customers_30d',     value: newCustomers30d,       data: null },
      { name: 'stripe.avg_order_value',       value: round(aov),            data: null },
      { name: 'stripe.refund_rate',           value: round(refundRate),     data: null },
      { name: 'stripe.charges_count_30d',     value: successCharges.length, data: null },
    );

    metrics.push(
      { name: 'stripe.charges_data',       value: charges.length,       data: charges.slice(0, 100) },
      { name: 'stripe.subscriptions_data', value: subscriptions.length, data: subscriptions.slice(0, 100) },
      { name: 'stripe.customers_data',     value: customers.length,     data: customers.slice(0, 100) },
      { name: 'stripe.refunds_data',       value: refunds.length,       data: refunds.slice(0, 50) },
    );

    return metrics;
  },

  async getAuthUrl() { throw new Error('Stripe uses API key authentication, not OAuth.'); },
  async exchangeCode() { throw new Error('Stripe uses API key authentication, not OAuth.'); },
  async refreshToken() { throw new Error('Stripe uses API key authentication, not OAuth.'); },
};

export default connector;
