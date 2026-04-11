/**
 * GitHub — STUB
 *
 * Placeholder so the connector registry doesn't 422 when activated.
 * Full implementation pending.
 */
const connector = {
  id: 'github',
  name: 'GitHub',
  category: 'code',
  authType: 'oauth2',
  icon: 'git-branch',
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
    return { ok: false, error: 'GitHub connector not yet implemented.' };
  },

  async fetch() {
    throw new Error('GitHub connector not yet implemented.');
  },

  extractMetrics() {
    return [];
  },

  async getAuthUrl() { throw new Error('GitHub connector not yet implemented.'); },
  async exchangeCode() { throw new Error('GitHub connector not yet implemented.'); },
  async refreshToken() { throw new Error('GitHub connector not yet implemented.'); },
};

export default connector;
