/**
 * Blueprint Connector Interface
 *
 * All connectors must export a default object conforming to this shape.
 * The connector is responsible for fetching data, checking auth health,
 * and handling OAuth flows where applicable.
 */

export interface ConnectorCapabilities {
  /** Can read/fetch data from this service */
  read: boolean;
  /** Can write/mutate data in this service */
  write: boolean;
  /** Can receive webhook events */
  webhooks: boolean;
  /** How often (in minutes) this connector should be polled */
  pollingIntervalMinutes: number;
}

export interface ConnectorInterface {
  /** Unique machine-readable identifier, e.g. 'gsc', 'ga4', 'pagespeed' */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Category for grouping in the UI */
  category: string;
  /** How this connector authenticates */
  authType: string;
  /** Icon identifier (maps to UI icon component) */
  icon: string;
  capabilities: ConnectorCapabilities;
  /**
   * Signal rule IDs this connector produces data for.
   * Must match ids defined in server/signals/rules.js
   */
  signalTypes: string[];
  healthCheck(credentials: Record<string, unknown>): Promise<{ ok: boolean; error?: string; details?: unknown }>;
  fetch(dataType: string, credentials: Record<string, unknown>, params: Record<string, unknown>): Promise<unknown>;
  getAuthUrl(state: string): Promise<string>;
  exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scope?: string }>;
  refreshToken(credentials: Record<string, unknown>): Promise<{ accessToken: string; expiresAt: number }>;
}

const connector: ConnectorInterface = {
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

  signalTypes: [],

  async healthCheck(credentials) {
    throw new Error('healthCheck() not implemented');
  },

  async fetch(dataType, credentials, params) {
    throw new Error('fetch() not implemented');
  },

  async getAuthUrl(state) {
    throw new Error('getAuthUrl() not implemented');
  },

  async exchangeCode(code) {
    throw new Error('exchangeCode() not implemented');
  },

  async refreshToken(credentials) {
    throw new Error('refreshToken() not implemented');
  },
};

export default connector;
