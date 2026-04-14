/**
 * Outbound Allowlist — Layer 2 of Blueprint's prompt injection defence.
 *
 * Agents should only be able to make outbound HTTP calls to known, trusted
 * destinations. Even if a prompt injection succeeds in hijacking the LLM, an
 * attempt to POST exfiltrated data to an attacker-controlled domain will be
 * blocked at the HTTP layer, because the LLM cannot influence this list.
 *
 * The allowlist is union of:
 *   1. Hardcoded defaults (this file) — all known Blueprint connector APIs.
 *   2. Settings-stored list — added through the Security Settings UI.
 *   3. Dynamic allowlist — hostnames derived from connector config (e.g. a
 *      custom Shopify store domain, a user-configured WordPress URL).
 *
 * BLOCKED_OUTBOUND is a deny-list that beats the allowlist. Data collection
 * endpoints like webhook.site get added here regardless of other rules.
 */

import db from '../db/db.js';

// ─── Hardcoded defaults ───────────────────────────────────────────────────────

// LLM providers + all connector API domains Blueprint speaks to out of the box.
export const DEFAULT_ALLOWED_HOSTS = [
  // LLM providers
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.openrouter.ai',
  // Local providers
  'localhost',
  '127.0.0.1',
  '0.0.0.0',

  // Google APIs (Analytics, Search Console, OAuth, PageSpeed, etc.)
  'accounts.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'analyticsdata.googleapis.com',
  'searchconsole.googleapis.com',
  'pagespeedonline.googleapis.com',
  'mybusinessbusinessinformation.googleapis.com',
  'mybusinessaccountmanagement.googleapis.com',
  'googleads.googleapis.com',

  // Shopify
  'shopify.com',
  'myshopify.com',

  // Payments
  'api.stripe.com',

  // Social / ads
  'graph.facebook.com',
  'api.facebook.com',
  'api.bufferapp.com',
  'api.buffer.com',

  // Email
  'api.brevo.com',
  'a.klaviyo.com',
  'api.klaviyo.com',

  // Search / research
  'api.search.brave.com',
  'api.tavily.com',
  'api.semrush.com',

  // Uptime / monitoring
  'api.uptimerobot.com',

  // Mail
  'api.stannp.com',
  'dashboard.stannp.com',

  // Dev / source control
  'api.github.com',
  'github.com',

  // CMS / commerce (these also accept user-provided custom domains via
  // connector config — those are merged in at runtime)
  'wordpress.com',
  'api.wix.com',
  'www.wixapis.com',
  'manage.wix.com',

  // Todoist
  'api.todoist.com',
];

// Hosts that are always blocked regardless of any allowlist entry. Common
// request-logging / webhook-inspection endpoints that make ideal exfiltration
// targets for injected agents.
export const BLOCKED_HOSTS = new Set([
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

// ─── Settings-backed allowlist ────────────────────────────────────────────────

function readSetting(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(value));
}

/**
 * Return the union of default + settings-stored allowed hostnames.
 *
 * @returns {string[]}
 */
export function getAllowedDomains() {
  const extra = readSetting(ALLOWLIST_SETTING_KEY, []);
  const extraHosts = Array.isArray(extra) ? extra.filter(h => typeof h === 'string') : [];
  return Array.from(new Set([...DEFAULT_ALLOWED_HOSTS, ...extraHosts])).sort();
}

/**
 * Merge connector-config hostnames (custom Shopify stores, custom WordPress
 * installs, custom Wix domains, user-entered FTP/SSH hosts) with the static
 * allowlist. Called at runtime by the allowlist check so newly-added
 * connectors don't need a code change.
 */
function getConnectorDomains() {
  try {
    const rows = db.prepare(`SELECT type, config FROM connectors`).all();
    const hosts = new Set();
    for (const row of rows) {
      let config = {};
      try { config = row.config ? JSON.parse(row.config) : {}; } catch {}
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

/**
 * Is outbound enforcement on? Default: true. Toggleable via Settings →
 * Security so an operator can temporarily disable if they hit a false block.
 *
 * @returns {boolean}
 */
export function isEnforcementEnabled() {
  return readSetting(ENFORCE_SETTING_KEY, true) !== false;
}

export function setEnforcementEnabled(enabled) {
  writeSetting(ENFORCE_SETTING_KEY, !!enabled);
}

/**
 * Add a hostname to the settings-backed allowlist.
 *
 * @param {string} hostname
 */
export function addToAllowlist(hostname) {
  const h = normaliseHost(hostname);
  if (!h) throw new Error('Invalid hostname');
  const extra = readSetting(ALLOWLIST_SETTING_KEY, []);
  const current = Array.isArray(extra) ? extra : [];
  if (current.includes(h)) return current;
  const next = [...current, h];
  writeSetting(ALLOWLIST_SETTING_KEY, next);
  return next;
}

/**
 * Remove a hostname from the settings-backed allowlist. Defaults cannot be
 * removed — they are baked into the code.
 */
export function removeFromAllowlist(hostname) {
  const h = normaliseHost(hostname);
  const extra = readSetting(ALLOWLIST_SETTING_KEY, []);
  const current = Array.isArray(extra) ? extra : [];
  const next = current.filter(x => x !== h);
  writeSetting(ALLOWLIST_SETTING_KEY, next);
  return next;
}

// ─── Matching logic ───────────────────────────────────────────────────────────

function normaliseHost(host) {
  if (typeof host !== 'string') return null;
  return host.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

function matchesAllowed(hostname, allowed) {
  if (!hostname) return false;
  const h = normaliseHost(hostname);
  for (const entry of allowed) {
    const e = normaliseHost(entry);
    if (!e) continue;
    if (h === e) return true;
    // Allow subdomain match on allowlist entries: `shopify.com` covers
    // `mystore.myshopify.com` only if an entry is `myshopify.com`. We do NOT
    // do naive suffix on `shopify.com` — we require the exact allowed host
    // OR a suffix on a registered domain name in the list.
    if (h.endsWith('.' + e)) return true;
  }
  return false;
}

/**
 * Decide whether an outbound URL is permitted.
 *
 * @param {string} url
 * @returns {{ allowed: boolean, hostname?: string, reason?: string }}
 */
export function isOutboundAllowed(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return { allowed: false, reason: 'invalid_url' };
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }

  const h = normaliseHost(hostname);
  if (!h) return { allowed: false, reason: 'invalid_url' };

  // Explicit deny-list beats everything else.
  if (BLOCKED_HOSTS.has(h)) {
    return { allowed: false, hostname: h, reason: 'explicitly_blocked' };
  }
  for (const blocked of BLOCKED_HOSTS) {
    if (h.endsWith('.' + blocked)) {
      return { allowed: false, hostname: h, reason: 'explicitly_blocked' };
    }
  }

  // Enforcement disabled → permissive (but still log).
  if (!isEnforcementEnabled()) {
    return { allowed: true, hostname: h, reason: 'enforcement_disabled' };
  }

  const allowed = [
    ...getAllowedDomains(),
    ...getConnectorDomains(),
  ];

  if (matchesAllowed(h, allowed)) {
    return { allowed: true, hostname: h };
  }

  return { allowed: false, hostname: h, reason: 'not_in_allowlist' };
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class SecurityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SecurityError';
    this.details = details;
  }
}

// ─── Outbound log ─────────────────────────────────────────────────────────────

/**
 * Append a row to outbound_log. Fire-and-forget — never throws.
 *
 * @param {{
 *   url: string,
 *   hostname?: string,
 *   method?: string,
 *   context?: string,
 *   allowed: boolean,
 *   blockReason?: string,
 *   statusCode?: number,
 * }} entry
 */
export function logOutbound(entry) {
  try {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
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
      console.warn('[security:outbound] Failed to log outbound call:', err.message);
    } catch {}
  }
}

/**
 * Record a blocked outbound attempt as a critical security signal.
 * Fire-and-forget; never throws.
 */
export function recordBlockedOutbound({ businessId = null, url, hostname, reason, context, agentId = null }) {
  // signals.business_id is NOT NULL. If no business context is supplied, fall
  // back to the primary business so the operator still sees the signal in
  // their dashboard. Skip silently if there is no business at all (fresh
  // install pre-onboarding).
  let effectiveBusinessId = businessId;
  if (!effectiveBusinessId) {
    try {
      const row = db.prepare('SELECT id FROM businesses ORDER BY created_at ASC LIMIT 1').get();
      effectiveBusinessId = row?.id ?? null;
    } catch {}
  }
  if (!effectiveBusinessId) return;

  try {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
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
      console.warn('[security:outbound] Failed to record blocked-outbound signal:', err.message);
    } catch {}
  }
}
