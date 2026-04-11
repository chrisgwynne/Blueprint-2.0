/**
 * Rate-limit retry helper for connector API calls.
 *
 * Wraps an async function so that 429 (Too Many Requests) and 503 (Service
 * Unavailable) responses are retried with exponential backoff. Other errors
 * propagate immediately.
 *
 * Usage:
 *   const data = await withRetry(
 *     () => apiFetch('/endpoint', credentials),
 *     { label: 'Brevo campaigns', maxRetries: 3 }
 *   );
 */

/**
 * @param {() => Promise<any>} fn - async function to execute
 * @param {{ maxRetries?: number, baseDelayMs?: number, label?: string }} [options]
 * @returns {Promise<any>}
 */
export async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelayMs = 1000, label = 'API call' } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status ?? err?.statusCode ?? null;
      const isRateLimit = status === 429 || status === 503;
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt || !isRateLimit) throw err;

      // Exponential backoff: 1s, 2s, 4s, 8s
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[rate-limiter] ${label} rate limited (status ${status}). Retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Wrap fetch() so that non-2xx responses become errors with a `status` field
 * (so withRetry can detect them) and the response body is included in the
 * error message for debugging.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function checkedFetch(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).substring(0, 300); } catch {}
    const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}: ${body}`);
    err.status = res.status;
    err.statusText = res.statusText;
    throw err;
  }
  return res;
}
