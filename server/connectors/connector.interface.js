/**
 * Blueprint Connector Interface
 *
 * All connectors must export a default object conforming to this shape.
 * The connector is responsible for fetching data, checking auth health,
 * and handling OAuth flows where applicable.
 */

export default {
  /** Unique machine-readable identifier, e.g. 'gsc', 'ga4', 'pagespeed' */
  id: 'connector-id',

  /** Human-readable display name */
  name: 'Human Name',

  /** Category for grouping in the UI */
  category: 'seo|analytics|commerce|code|communication',

  /** How this connector authenticates */
  authType: 'oauth2|apikey|none',

  /** Icon identifier (maps to UI icon component) */
  icon: 'icon-name',

  capabilities: {
    /** Can read/fetch data from this service */
    read: true,
    /** Can write/mutate data in this service */
    write: false,
    /** Can receive webhook events */
    webhooks: false,
    /** How often (in minutes) this connector should be polled */
    pollingIntervalMinutes: 360,
  },

  /**
   * Signal rule IDs this connector produces data for.
   * Must match ids defined in server/signals/rules.js
   */
  signalTypes: [],

  /**
   * Verify that the provided credentials are valid and the service is reachable.
   * @param {Object} credentials - Decrypted credentials object
   * @returns {Promise<{ ok: boolean, error?: string, details?: any }>}
   */
  async healthCheck(credentials) {
    throw new Error('healthCheck() not implemented');
  },

  /**
   * Fetch data from the service.
   * @param {string} dataType - What type of data to fetch (connector-specific)
   * @param {Object} credentials - Decrypted credentials object
   * @param {Object} params - Additional fetch parameters (urls, date ranges, etc.)
   * @returns {Promise<any>} Fetched and normalised data
   */
  async fetch(dataType, credentials, params) {
    throw new Error('fetch() not implemented');
  },

  /**
   * Generate the OAuth2 authorisation URL.
   * Only required for authType: 'oauth2'
   * @param {string} state - CSRF state token
   * @returns {Promise<string>} Authorisation URL
   */
  async getAuthUrl(state) {
    throw new Error('getAuthUrl() not implemented');
  },

  /**
   * Exchange an authorisation code for access + refresh tokens.
   * Only required for authType: 'oauth2'
   * @param {string} code - The authorisation code from the OAuth callback
   * @returns {Promise<{ accessToken, refreshToken, expiresAt, scope? }>}
   */
  async exchangeCode(code) {
    throw new Error('exchangeCode() not implemented');
  },

  /**
   * Refresh an expired access token using a refresh token.
   * Only required for authType: 'oauth2'
   * @param {Object} credentials - Current credentials including refreshToken
   * @returns {Promise<{ accessToken, expiresAt }>} Updated token fields
   */
  async refreshToken(credentials) {
    throw new Error('refreshToken() not implemented');
  },
};
