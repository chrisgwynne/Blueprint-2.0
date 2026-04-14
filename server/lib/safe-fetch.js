/**
 * safeFetch — fetch() wrapper that enforces the outbound allowlist.
 *
 * Security-sensitive code paths (agents, investigation executor, self-healer,
 * search tools, connectors called from agent context) should call safeFetch()
 * instead of fetch(). Calls to non-allowlisted hostnames are:
 *   1. Logged to outbound_log
 *   2. Recorded as a critical security signal
 *   3. Rejected with SecurityError
 *
 * Calls to allowlisted hostnames pass through to native fetch() with a debug
 * entry in outbound_log capturing the response status.
 *
 * Fails closed by default: if the allowlist check itself throws, the call is
 * blocked rather than silently passed through.
 */

import {
  isOutboundAllowed,
  logOutbound,
  recordBlockedOutbound,
  SecurityError,
} from './outbound-allowlist.js';

/**
 * Drop-in replacement for global fetch() that enforces the allowlist.
 *
 * @param {string | URL} input
 * @param {RequestInit} [options]
 * @param {string | { context?: string, businessId?: string, agentId?: string }} [ctx]
 *   Either a string context label, or an object with more metadata for logs.
 * @returns {Promise<Response>}
 */
export async function safeFetch(input, options = {}, ctx = 'unknown') {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const method = (options && options.method) ? String(options.method).toUpperCase() : 'GET';

  const context = typeof ctx === 'string' ? ctx : (ctx?.context ?? 'unknown');
  const businessId = typeof ctx === 'object' ? ctx?.businessId ?? null : null;
  const agentId    = typeof ctx === 'object' ? ctx?.agentId    ?? null : null;

  let check;
  try {
    check = isOutboundAllowed(url);
  } catch (err) {
    // Fail closed.
    check = { allowed: false, reason: 'allowlist_error', hostname: null };
    try { console.error('[security:safe-fetch] Allowlist check threw:', err.message); } catch {}
  }

  if (!check.allowed) {
    // Log + signal + throw.
    logOutbound({
      url,
      hostname: check.hostname,
      method,
      context,
      allowed: false,
      blockReason: check.reason,
    });

    recordBlockedOutbound({
      businessId,
      url,
      hostname: check.hostname,
      reason: check.reason,
      context,
      agentId,
    });

    try {
      console.warn(
        `[security:safe-fetch] BLOCKED ${method} ${check.hostname ?? url} ` +
        `(${check.reason}) — context=${context}`
      );
    } catch {}

    throw new SecurityError(
      `Outbound call blocked: ${check.hostname ?? url} is not in the allowlist (${check.reason})`,
      { url, hostname: check.hostname, reason: check.reason, context }
    );
  }

  // Allowed — pass through.
  let response;
  try {
    response = await fetch(input, options);
  } catch (err) {
    logOutbound({
      url,
      hostname: check.hostname,
      method,
      context,
      allowed: true,
      statusCode: null,
    });
    throw err;
  }

  logOutbound({
    url,
    hostname: check.hostname,
    method,
    context,
    allowed: true,
    statusCode: response?.status ?? null,
  });

  return response;
}

export { SecurityError };
