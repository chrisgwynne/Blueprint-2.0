/**
 * Stripe — STUB
 *
 * Placeholder so the connector registry doesn't 422 when activated.
 * Full implementation pending.
 */
const connector = {
  id: 'stripe',
  name: 'Stripe',
  category: 'payments',
  authType: 'apikey',
  icon: 'credit-card',
  status: 'coming_soon',

  capabilities: {
    read: false,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  signalTypes: [],
  configFields: [],

  async healthCheck() {
    return { ok: false, error: 'Stripe connector not yet implemented.' };
  },

  async fetch() {
    throw new Error('Stripe connector not yet implemented.');
  },

  extractMetrics() {
    return [];
  },

  async getAuthUrl() { throw new Error('Stripe connector not yet implemented.'); },
  async exchangeCode() { throw new Error('Stripe connector not yet implemented.'); },
  async refreshToken() { throw new Error('Stripe connector not yet implemented.'); },
};

export default connector;
