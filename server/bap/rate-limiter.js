/**
 * Blueprint Agent Protocol — Per-agent rate limiter.
 *
 * Simple in-memory sliding-window counter. For production at scale,
 * swap with Redis or SQLite-backed windows.
 */

const windows = new Map(); // key → number[]

const LIMITS = {
  default:           { calls: 60,  windowMs: 60_000 },
  'kb:write':        { calls: 20,  windowMs: 60_000 },
  'kb:query':        { calls: 10,  windowMs: 60_000 },
  'agents:trigger':  { calls: 5,   windowMs: 60_000 },
  register:          { calls: 5,   windowMs: 300_000 }, // 5 registrations per 5 min
};

/**
 * Express middleware factory.
 *
 * @param {string} limitKey - maps to LIMITS entry; defaults to 'default'
 */
export function bapRateLimit(limitKey = 'default') {
  return (req, res, next) => {
    const agentId = req.bapAgent?.id ?? req.ip;
    const key = `${agentId}:${limitKey}`;
    const limit = LIMITS[limitKey] ?? LIMITS.default;
    const now = Date.now();

    if (!windows.has(key)) windows.set(key, []);
    const calls = windows.get(key).filter((t) => now - t < limit.windowMs);
    calls.push(now);
    windows.set(key, calls);

    res.setHeader('X-RateLimit-Limit', String(limit.calls));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit.calls - calls.length)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + limit.windowMs) / 1000)));

    if (calls.length > limit.calls) {
      return res.status(429).json({
        error: 'Rate limit exceeded.',
        retry_after_seconds: Math.ceil(limit.windowMs / 1000),
      });
    }

    next();
  };
}
