/**
 * safeFetch — fetch() wrapper that enforces the outbound allowlist.
 */

import {
  isOutboundAllowed,
  logOutbound,
  recordBlockedOutbound,
  SecurityError,
} from './outbound-allowlist.js';
import { guardSimulationSideEffect, isSimulating } from '../simulation/simulation-context.js';

/** Host only — a blocked-effect record should never carry a URL's query string. */
function hostOf(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

export type SafeFetchContext =
  | string
  | { context?: string; businessId?: string; agentId?: string };

export async function safeFetch(
  input: string | URL,
  options: RequestInit = {},
  ctx: SafeFetchContext = 'unknown',
): Promise<Response> {
  const url = typeof input === 'string' ? input : input?.href ?? String(input);
  const method = options.method ? String(options.method).toUpperCase() : 'GET';

  // #67: the single outbound chokepoint. Every connector mutation, provider
  // call and third-party write in Blueprint goes through safeFetch, so
  // blocking here is what makes 'performs no external writes' true in
  // general rather than true for the paths someone remembered to check.
  // Reads are blocked too: a preview reasons about the snapshot it declared,
  // and silently reaching live for more would defeat the freshness reporting.
  //
  // Behind an isSimulating() check so the URL is not re-parsed on every
  // outbound request in normal operation — this is a hot path.
  if (isSimulating()) {
    const host = hostOf(url);
    guardSimulationSideEffect(
      'http.outbound', host,
      `an outbound ${method} request to ${host ?? 'an external host'}`,
    );
  }

  const context = typeof ctx === 'string' ? ctx : (ctx?.context ?? 'unknown');
  const businessId = typeof ctx === 'object' ? (ctx?.businessId ?? null) : null;
  const agentId = typeof ctx === 'object' ? (ctx?.agentId ?? null) : null;

  let check: ReturnType<typeof isOutboundAllowed>;
  try {
    check = isOutboundAllowed(url);
  } catch (err) {
    check = { allowed: false, reason: 'allowlist_error', hostname: null };
    try { console.error('[security:safe-fetch] Allowlist check threw:', (err as Error).message); } catch {}
  }

  if (!check.allowed) {
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

  let response: Response;
  try {
    response = await fetch(input, options);
  } catch (err) {
    logOutbound({ url, hostname: check.hostname, method, context, allowed: true, statusCode: null });
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
