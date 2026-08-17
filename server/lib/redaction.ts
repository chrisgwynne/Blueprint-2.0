/**
 * Secret redaction for durable, human-readable records.
 *
 * Generalises the key-shaped redaction convention already used at the BAP
 * audit readback boundary (server/routes/bap-audit.ts) and the value-shaped
 * scrubbing used for provider errors (server/lib/provider-errors.ts) into
 * one reusable sanitiser, so a record that is BOTH persisted and read back
 * (action receipts, issue #70) can be sanitised once at write time and
 * again at read time without two divergent implementations.
 *
 * Three independent defences, applied together:
 *
 *   1. Key-shaped — any object key that looks like a credential
 *      (`credential`, `secret`, `token`, `password`, `api_key`,
 *      `authorization`, ...) has its value replaced with `[redacted]`,
 *      whatever the value is.
 *   2. Value-shaped — string values are scrubbed for known credential
 *      formats (Bearer headers, `sk-`/`AIza`/`ghp_`/`shpat_`/`xoxb-`/
 *      `bap_` prefixed keys, PEM private key blocks, secret-bearing query
 *      parameters). This catches a credential that arrived under an
 *      innocuous key name.
 *   3. Shape-bounded — raw provider bodies are never kept: keys that
 *      typically carry an unparsed provider response or full document body
 *      are replaced with `[omitted]`, long strings are truncated, and
 *      depth/breadth are capped. A receipt is a summary of what happened,
 *      not a mirror of the provider's wire format.
 *
 * Redaction is deliberately lossy and one-way: nothing here is reversible,
 * and callers must never rely on a redacted value round-tripping.
 */

/**
 * Object keys whose *value* is replaced wholesale with `[redacted]`.
 * Deliberately narrower than "anything containing `token`" so that benign
 * accounting fields (`token_count`, `total_tokens`) survive — a receipt
 * that silently redacts its own cost figures is less trustworthy, not more.
 */
const SECRET_KEY_PATTERN = new RegExp(
  [
    'credential',
    'secret',
    'password',
    'passphrase',
    'api[_-]?key',
    'access[_-]?key',
    'private[_-]?key',
    '^authorization$',
    '^auth$',
    'cookie',
    'session[_-]?id',
    'signature',
    '^bearer$',
    '^token$',
    '(?:access|refresh|auth|api|bearer|id|session|webhook|bot|page)[_-]?token',
    'token[_-]?(?:value|secret|hash)',
  ].join('|'),
  'i',
);

/**
 * Object keys that typically carry a raw provider payload or an entire
 * document body. Receipts summarise; they never mirror provider wire
 * formats, so these are dropped rather than merely scrubbed.
 */
const RAW_BODY_KEY_PATTERN =
  /^(?:raw|raw_body|raw_response|raw_request|response_body|request_body|body|body_html|html|html_body|content_html|payload_raw|stack|stacktrace|headers)$/i;

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, 'Basic [redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted-github-token]'],
  [/\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]{8,}/g, '[redacted-shopify-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[redacted-slack-token]'],
  [/\bAIza[0-9A-Za-z_-]{16,}/g, '[redacted-google-key]'],
  [/\bsk-[A-Za-z0-9._-]{12,}/gi, '[redacted-provider-key]'],
  [/\bbap_[A-Za-z0-9_-]{16,}/g, '[redacted-bap-key]'],
  // Secrets smuggled through a URL's query string.
  [/([?&](?:key|api[_-]?key|token|access[_-]?token|password|secret|sig|signature)=)[^&\s"']+/gi, '$1[redacted]'],
];

export const REDACTED = '[redacted]';
export const OMITTED = '[omitted]';

export interface RedactOptions {
  /** Longest string kept verbatim before truncation. Default 500. */
  maxStringLength?: number;
  /** Deepest nesting kept. Deeper values collapse to `[truncated]`. Default 6. */
  maxDepth?: number;
  /** Most array entries kept. Default 50. */
  maxArrayLength?: number;
  /** Most object keys kept per level. Default 60. */
  maxKeys?: number;
}

const DEFAULTS: Required<RedactOptions> = {
  maxStringLength: 500,
  maxDepth: 6,
  maxArrayLength: 50,
  maxKeys: 60,
};

/** Scrub known credential formats out of a free-text string. */
export function redactSensitiveText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

/**
 * Deep-clone `value` with secrets removed and size bounded. Safe to call on
 * anything — cycles, class instances and non-JSON values all degrade to a
 * plain, serialisable summary rather than throwing.
 */
export function redactSensitive<T = unknown>(value: unknown, options: RedactOptions = {}): T {
  const opts = { ...DEFAULTS, ...options };
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): unknown {
    if (node === null || node === undefined) return node ?? null;

    const type = typeof node;
    if (type === 'string') return truncate(redactSensitiveText(node as string), opts.maxStringLength);
    if (type === 'number' || type === 'boolean') return node;
    if (type === 'bigint') return String(node);
    if (type === 'function' || type === 'symbol') return OMITTED;

    if (node instanceof Date) return node.toISOString();
    if (node instanceof Error) return truncate(redactSensitiveText(node.message), opts.maxStringLength);

    if (depth >= opts.maxDepth) return '[truncated]';

    if (Array.isArray(node)) {
      if (seen.has(node)) return '[circular]';
      seen.add(node);
      const kept = node.slice(0, opts.maxArrayLength).map((item) => walk(item, depth + 1));
      if (node.length > opts.maxArrayLength) kept.push(`[${node.length - opts.maxArrayLength} more omitted]`);
      seen.delete(node);
      return kept;
    }

    if (type === 'object') {
      if (seen.has(node as object)) return '[circular]';
      seen.add(node as object);
      const out: Record<string, unknown> = {};
      const entries = Object.entries(node as Record<string, unknown>);
      for (const [key, val] of entries.slice(0, opts.maxKeys)) {
        if (SECRET_KEY_PATTERN.test(key)) { out[key] = REDACTED; continue; }
        if (RAW_BODY_KEY_PATTERN.test(key)) { out[key] = OMITTED; continue; }
        out[key] = walk(val, depth + 1);
      }
      if (entries.length > opts.maxKeys) out['__omitted_keys'] = entries.length - opts.maxKeys;
      seen.delete(node as object);
      return out;
    }

    return String(node);
  }

  return walk(value, 0) as T;
}

/**
 * Convenience wrapper for the common "sanitise a JSON-ish record or null"
 * case, returning null (rather than `{}`) when there is nothing to store.
 */
export function redactRecord(value: unknown, options: RedactOptions = {}): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { value: redactSensitive(value, options) };
  }
  const out = redactSensitive<Record<string, unknown>>(value, options);
  return out && typeof out === 'object' ? out : null;
}

/** True if a string still contains anything matching a known secret format. */
export function containsSensitiveText(input: string): boolean {
  return VALUE_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}
