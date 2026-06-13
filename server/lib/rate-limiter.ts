/**
 * Rate-limit retry helper for connector API calls.
 */

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  label?: string;
}

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  statusText?: string;
  retryAfterMs?: number;
}

/** Transient statuses worth retrying: rate limits and gateway hiccups. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, label = 'API call' } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as HttpError;
      const status = e?.status ?? e?.statusCode ?? null;
      const isRetryable = status !== null && RETRYABLE_STATUSES.has(status);
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt || !isRetryable) throw err;

      // Honour the server's Retry-After hint when present (capped at 60s),
      // otherwise exponential backoff.
      const backoff = baseDelayMs * Math.pow(2, attempt);
      const delay = e.retryAfterMs !== undefined && Number.isFinite(e.retryAfterMs)
        ? Math.min(Math.max(e.retryAfterMs, 0), 60_000)
        : backoff;
      console.warn(`[rate-limiter] ${label} transient failure (status ${status}). Retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // TypeScript requires a return — this branch is unreachable (maxRetries >= 0
  // guarantees the loop always throws or returns before exhausting).
  throw new Error(`${label}: exceeded ${maxRetries} retries`);
}

class CheckedFetchError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, statusText: string, retryAfterMs?: number) {
    super(message);
    this.name = 'CheckedFetchError';
    this.status = status;
    this.statusText = statusText;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export async function checkedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).substring(0, 300); } catch {}
    throw new CheckedFetchError(
      `HTTP ${res.status} ${res.statusText} for ${url}: ${body}`,
      res.status,
      res.statusText,
      parseRetryAfter(res.headers.get('retry-after')),
    );
  }
  return res;
}
