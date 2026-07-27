/**
 * SSRF guard for agent/user-configurable outbound destinations — currently
 * BAP webhook URLs.
 *
 * This is distinct from lib/outbound-allowlist.ts, which allowlists
 * Blueprint's OWN outbound calls to a fixed set of known third-party APIs
 * (connectors, LLM providers). A webhook URL is inherently arbitrary and
 * caller-supplied — it points at the external agent's own server, which
 * could legitimately be anywhere on the public internet — so an allowlist
 * of known hosts doesn't apply. The defense here is instead a denylist of
 * private/internal/reserved address space, applied to the DNS-resolved
 * address (not just the hostname string) so it can't be bypassed by a
 * public hostname that resolves to an internal IP (DNS rebinding).
 */
import { promises as dns } from 'dns';
import { isIP } from 'net';

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWebhookUrlError';
  }
}

function ipv4ToLong(ip: string): number {
  const parts = ip.split('.').map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function inIPv4Range(ip: string, base: string, prefixBits: number): boolean {
  const long = ipv4ToLong(ip);
  const baseLong = ipv4ToLong(base);
  const mask = prefixBits === 0 ? 0 : (~0 << (32 - prefixBits)) >>> 0;
  return (long & mask) === (baseLong & mask);
}

// RFC1918 + loopback + link-local (covers the 169.254.169.254 cloud
// metadata endpoint) + CGNAT + multicast/reserved.
const IPV4_PRIVATE_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPrivateIPv4(ip: string): boolean {
  return IPV4_PRIVATE_RANGES.some(([base, bits]) => inIPv4Range(ip, base, bits));
}

function isPrivateIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local fc00::/7
  if (h.startsWith('::ffff:')) {
    const v4 = h.slice('::ffff:'.length);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return false; // not a literal IP address
}

/**
 * Throws UnsafeWebhookUrlError if the URL is not a safe http(s) webhook
 * destination. Re-resolves DNS on every call (not just at registration
 * time) so a hostname that starts pointing somewhere safe and is later
 * repointed at an internal address is still caught on the next delivery.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new UnsafeWebhookUrlError('Invalid webhook URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeWebhookUrlError(`Webhook URL must use http:// or https:// (got "${url.protocol}").`);
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new UnsafeWebhookUrlError('Webhook URL has no hostname.');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new UnsafeWebhookUrlError('Webhook URL may not target localhost.');
  }

  // Literal IP in the URL — check directly, no DNS lookup needed.
  if (isIP(hostname)) {
    if (isPrivateOrReservedAddress(hostname)) {
      throw new UnsafeWebhookUrlError(`Webhook URL resolves to a private/reserved address (${hostname}).`);
    }
    return;
  }

  // Hostname — resolve and check every returned address so a public
  // domain that resolves (now, or via rebinding later) to an internal
  // address is rejected too.
  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new UnsafeWebhookUrlError(`Could not resolve webhook host: ${hostname}.`);
  }

  if (addresses.length === 0) {
    throw new UnsafeWebhookUrlError(`Could not resolve webhook host: ${hostname}.`);
  }

  for (const addr of addresses) {
    if (isPrivateOrReservedAddress(addr)) {
      throw new UnsafeWebhookUrlError(
        `Webhook URL host "${hostname}" resolves to a private/reserved address (${addr}).`
      );
    }
  }
}
