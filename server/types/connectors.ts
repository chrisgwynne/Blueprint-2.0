// ─── Connector interface and related types ────────────────────────────────────
// Source of truth: server/connectors/connector.interface.js

export type ConnectorId =
  | 'brave-search'
  | 'brevo'
  | 'buffer'
  | 'ga4'
  | 'gbp'
  | 'github'
  | 'google-ads'
  | 'gsc'
  | 'kirby'
  | 'klaviyo'
  | 'meta-ads'
  | 'pagespeed'
  | 'semrush'
  | 'server-access'
  | 'shopify'
  | 'social'
  | 'stannp'
  | 'stripe'
  | 'tavily'
  | 'todoist'
  | 'uptimerobot'
  | 'wix'
  | 'wordpress';

export type ConnectorCategory =
  | 'seo'
  | 'analytics'
  | 'commerce'
  | 'code'
  | 'communication'
  | 'advertising'
  | 'hosting'
  | 'monitoring'
  | 'search'
  | 'intelligence'
  | 'marketing'
  | 'email';

export type ConnectorAuthType = 'oauth2' | 'apikey' | 'none';

export interface ConnectorCapabilities {
  read: boolean;
  write: boolean;
  webhooks: boolean;
  pollingIntervalMinutes: number | null;
  /** brave-search and tavily only — not polled on schedule, called on demand */
  onDemand?: boolean;
}

export interface ConnectorHealthResult {
  ok: boolean;
  error?: string;
  details?: unknown;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

export interface OAuthRefreshResult {
  accessToken: string;
  expiresAt?: string;
}

export interface MetricExtractionResult {
  metric_name: string;
  metric_value?: number | null;
  metric_data?: Record<string, unknown>;
  period_start?: string;
  period_end?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published_at?: string;
  source?: string;
  score?: number;
}

export interface ConnectorConfigField {
  id: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select' | 'textarea';
  required?: boolean;
  hint?: string;
  options?: string[];
  placeholder?: string;
  default?: string;
}

/** @deprecated Use ConnectorConfigField */
export type ConnectorFieldSpec = ConnectorConfigField;

// ── Core connector interface ───────────────────────────────────────────────────
// All 23 connectors must implement healthCheck + fetch.
// All other methods are optional; see deviations below.

export interface BlueprintConnector {
  id: ConnectorId;
  name: string;
  category: ConnectorCategory;
  authType: ConnectorAuthType;
  icon: string;
  capabilities: ConnectorCapabilities;
  signalTypes: string[];
  /** Field definitions for the credentials form in the UI */
  configFields?: ConnectorConfigField[];

  healthCheck(
    credentials: Record<string, unknown>
  ): Promise<ConnectorHealthResult>;

  fetch(
    dataType: string,
    credentials: Record<string, unknown>,
    params?: Record<string, unknown>
  ): Promise<unknown>;

  // ── OAuth2 — only required when authType === 'oauth2' ──────────────────────
  getAuthUrl?(state: string): Promise<string>;
  exchangeCode?(code: string): Promise<OAuthTokenResult>;
  refreshToken?(credentials: Record<string, unknown>): Promise<OAuthRefreshResult>;

  // ── extractMetrics — ~20/23 connectors implement this ─────────────────────
  extractMetrics?(
    data: unknown,
    runAt?: string
  ): MetricExtractionResult[];

  // ── brave-search + tavily ──────────────────────────────────────────────────
  search?(
    query: string,
    options?: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<SearchResult[]>;

  searchNews?(
    query: string,
    options?: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<SearchResult[]>;

  // ── github ────────────────────────────────────────────────────────────────
  createIssue?(
    credentials: Record<string, unknown>,
    owner: string,
    repo: string,
    params: { title: string; body?: string; labels?: string[] }
  ): Promise<unknown>;

  createPR?(
    credentials: Record<string, unknown>,
    owner: string,
    repo: string,
    params: { title: string; body?: string; head: string; base?: string; draft?: boolean }
  ): Promise<unknown>;

  // ── gbp ───────────────────────────────────────────────────────────────────
  listAccounts?(
    credentials: Record<string, unknown>
  ): Promise<unknown[]>;

  listLocations?(
    accountId: string,
    credentials: Record<string, unknown>
  ): Promise<unknown[]>;
}

/** Registry mapping connector type strings to loaded connector modules */
export type ConnectorRegistry = Map<ConnectorId, BlueprintConnector>;
