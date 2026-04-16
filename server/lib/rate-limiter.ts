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
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, label = 'API call' } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as HttpError;
      const status = e?.status ?? e?.statusCode ?? null;
      const isRateLimit = status === 429 || status === 503;
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt || !isRateLimit) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[rate-limiter] ${label} rate limited (status ${status}). Retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
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

  constructor(message: string, status: number, statusText: string) {
    super(message);
    this.name = 'CheckedFetchError';
    this.status = status;
    this.statusText = statusText;
  }
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
    );
  }
  return res;
}
