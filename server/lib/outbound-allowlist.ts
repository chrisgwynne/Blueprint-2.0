/**
 * Outbound Allowlist — Layer 2 of Blueprint's prompt injection defence.
 */

import db from '../db/db.js';

// ─── Hardcoded defaults ───────────────────────────────────────────────────────

export const DEFAULT_ALLOWED_HOSTS: string[] = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.openrouter.ai',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'accounts.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'analyticsdata.googleapis.com',
  'searchconsole.googleapis.com',
  'pagespeedonline.googleapis.com',
  'mybusinessbusinessinformation.googleapis.com',
  'mybusinessaccountmanagement.googleapis.com',
  'googleads.googleapis.com',
  'shopify.com',
  'myshopify.com',
  'api.stripe.com',
  'graph.facebook.com',
  'api.facebook.com',
  'api.bufferapp.com',
  'api.buffer.com',
  'api.brevo.com',
  'a.klaviyo.com',
  'api.klaviyo.com',
  'api.search.brave.com',
  'api.tavily.com',
  'api.semrush.com',
  'api.uptimerobot.com',
  'api.stannp.com',
  'dashboard.stannp.com',
  'api.github.com',
  'github.com',
  'wordpress.com',
  'api.wix.com',
  'www.wixapis.com',
  'manage.wix.com',
  'api.todoist.com',
];

export const BLOCKED_HOSTS = new Set<string>([
  'webhook.site',
  'requestbin.com',
  'requestbin.io',
  'pipedream.net',
  'ngrok.io',
  'ngrok-free.app',
  'localhost.run',
  'serveo.net',
  'beeceptor.com',
  'postb.in',
  'typicode.com',
  'mockbin.org',
  'hookbin.com',
]);

const ALLOWLIST_SETTING_KEY = 'security_outbound_allowlist';
const ENFORCE_SETTING_KEY = 'security_outbound_enforcement';

// ─── Settings helpers ─────────────────────────────────────────────────────────

function readSetting<T>(key: string, fallback: T): T {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | null;
    if (!row) return fallback;
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(value));
}

export function getAllowedDomains(): string[] {
  const extra = readSetting<unknown>(ALLOWLIST_SETTING_KEY, []);
  const extraHosts = Array.isArray(extra) ? extra.filter((h): h is string => typeof h === 'string') : [];
  return Array.from(new Set([...DEFAULT_ALLOWED_HOSTS, ...extraHosts])).sort();
}

function getConnectorDomains(): string[] {
  try {
    const rows = db.prepare(`SELECT type, config FROM connectors`).all() as
      Array<{ type: string; config: string | null }>;
    const hosts = new Set<string>();
    for (const row of rows) {
      let config: Record<string, unknown> = {};
      try { config = row.config ? JSON.parse(row.config) as Record<string, unknown> : {}; } catch {}
      for (const key of ['storeDomain', 'store_domain', 'siteUrl', 'site_url', 'url', 'host', 'baseUrl', 'base_url', 'domain']) {
        const val = config[key];
        if (typeof val === 'string' && val.length > 0) {
          try {
            const hostname = val.includes('://') ? new URL(val).hostname : val.replace(/\/.*$/, '');
            if (hostname) hosts.add(hostname);
          } catch {}
        }
      }
    }
    return Array.from(hosts);
  } catch {
    return [];
  }
}

export function isEnforcementEnabled(): boolean {
  return readSetting<boolean>(ENFORCE_SETTING_KEY, true) !== false;
}

export function setEnforcementEnabled(enabled: boolean): void {
  writeSetting(ENFORCE_SETTING_KEY, !!enabled);
}

export function addToAllowlist(hostname: string): string[] {
  const h = normaliseHost(hostname);
  if (!h) throw new Error('Invalid hostname');
  const extra = readSetting<unknown>(ALLOWLIST_SETTING_KEY, []);
  const current = Array.isArray(extra) ? (extra as string[]) : [];
  if (current.includes(h)) return current;
  const next = [...current, h];
  writeSetting(ALLOWLIST_SETTING_KEY, next);
  return next;
}

export function removeFromAllowlist(hostname: string): string[] {
  const h = normaliseHost(hostname);
  const extra = readSetting<unknown>(ALLOWLIST_SETTING_KEY, []);
  const current = Array.isArray(extra) ? (extra as string[]) : [];
  const next = current.filter(x => x !== h);
  writeSetting(ALLOWLIST_SETTING_KEY, next);
  return next;
}

// ─── Matching logic ───────────────────────────────────────────────────────────

function normaliseHost(host: string): string | null {
  if (typeof host !== 'string') return null;
  return host.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

function matchesAllowed(hostname: string, allowed: string[]): boolean {
  if (!hostname) return false;
  const h = normaliseHost(hostname);
  if (!h) return false;
  for (const entry of allowed) {
    const e = normaliseHost(entry);
    if (!e) continue;
    if (h === e) return true;
    if (h.endsWith('.' + e)) return true;
  }
  return false;
}

export interface OutboundCheckResult {
  allowed: boolean;
  hostname?: string | null;
  reason?: string;
}

export function isOutboundAllowed(url: string): OutboundCheckResult {
  if (typeof url !== 'string' || url.length === 0) {
    return { allowed: false, reason: 'invalid_url' };
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }

  const h = normaliseHost(hostname);
  if (!h) return { allowed: false, reason: 'invalid_url' };

  if (BLOCKED_HOSTS.has(h)) {
    return { allowed: false, hostname: h, reason: 'explicitly_blocked' };
  }
  for (const blocked of BLOCKED_HOSTS) {
    if (h.endsWith('.' + blocked)) {
      return { allowed: false, hostname: h, reason: 'explicitly_blocked' };
    }
  }

  if (!isEnforcementEnabled()) {
    return { allowed: true, hostname: h, reason: 'enforcement_disabled' };
  }

  const allowed = [...getAllowedDomains(), ...getConnectorDomains()];

  if (matchesAllowed(h, allowed)) {
    return { allowed: true, hostname: h };
  }

  return { allowed: false, hostname: h, reason: 'not_in_allowlist' };
}

// ─── Error class ──────────────────────────────────────────────────────────────

export interface SecurityErrorDetails {
  url?: string;
  hostname?: string | null;
  reason?: string;
  context?: string;
}

export class SecurityError extends Error {
  readonly details: SecurityErrorDetails;

  constructor(message: string, details: SecurityErrorDetails = {}) {
    super(message);
    this.name = 'SecurityError';
    this.details = details;
  }
}

// ─── Outbound log ─────────────────────────────────────────────────────────────

export interface OutboundLogEntry {
  url: string;
  hostname?: string | null;
  method?: string;
  context?: string;
  allowed: boolean;
  blockReason?: string;
  statusCode?: number | null;
}

export function logOutbound(entry: OutboundLogEntry): void {
  try {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `log-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`
      INSERT INTO outbound_log
        (id, url, hostname, method, context, allowed, block_reason, status_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      String(entry.url ?? '').slice(0, 1000),
      entry.hostname ?? null,
      entry.method ?? 'GET',
      entry.context ?? null,
      entry.allowed ? 1 : 0,
      entry.blockReason ?? null,
      entry.statusCode ?? null,
    );
  } catch (err) {
    try {
      console.warn('[security:outbound] Failed to log outbound call:', (err as Error).message);
    } catch {}
  }
}

export interface BlockedOutboundParams {
  businessId?: string | null;
  url: string;
  hostname?: string | null;
  reason?: string;
  context?: string;
  agentId?: string | null;
}

export function recordBlockedOutbound(params: BlockedOutboundParams): void {
  const { businessId = null, url, hostname, reason, context, agentId = null } = params;

  let effectiveBusinessId: string | null = businessId ?? null;
  if (!effectiveBusinessId) {
    try {
      const row = db.prepare('SELECT id FROM businesses ORDER BY created_at ASC LIMIT 1').get() as
        | { id: string }
        | null;
      effectiveBusinessId = row?.id ?? null;
    } catch {}
  }
  if (!effectiveBusinessId) return;

  try {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`
      INSERT INTO signals (
        id, business_id, connector_id, rule_id, type, severity,
        title, description, data, status, confidence, created_at, agent_id
      ) VALUES (?, ?, NULL, 'security:outbound_blocked', 'security_risk', 'critical',
                ?, ?, ?, 'open', 1.0, CURRENT_TIMESTAMP, ?)
    `).run(
      id,
      effectiveBusinessId,
      `Blocked outbound call to ${hostname ?? url}`,
      `A Blueprint component attempted an outbound HTTP call to ${hostname ?? url} ` +
      `(${reason}) from context '${context ?? 'unknown'}'. The call was blocked. ` +
      `Review recent agent activity and KB writes for signs of prompt injection.`,
      JSON.stringify({ url: String(url).slice(0, 500), hostname, reason, context }),
      agentId,
    );
  } catch (err) {
    try {
      console.warn('[security:outbound] Failed to record blocked-outbound signal:', (err as Error).message);
    } catch {}
  }
}
