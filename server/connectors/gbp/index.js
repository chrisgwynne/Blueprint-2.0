/**
 * Google Business Profile (GBP) — STUB
 *
 * Placeholder so the connector registry doesn't 422 when activated.
 * Full implementation pending.
 */
const connector = {
  id: 'gbp',
  name: 'Google Business Profile',
  category: 'local',
  authType: 'oauth2',
  icon: 'map-pin',
  status: 'coming_soon',

  capabilities: {
    read: false,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 720,
  },

  signalTypes: [],
  configFields: [],

  async healthCheck() {
    return { ok: false, error: 'GBP connector not yet implemented.' };
  },

  async fetch() {
    throw new Error('GBP connector not yet implemented.');
  },

  extractMetrics() {
    return [];
  },

  async getAuthUrl() { throw new Error('GBP connector not yet implemented.'); },
  async exchangeCode() { throw new Error('GBP connector not yet implemented.'); },
  async refreshToken() { throw new Error('GBP connector not yet implemented.'); },
};

export default connector;
