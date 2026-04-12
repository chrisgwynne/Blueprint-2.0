/**
 * Blueprint Agent Protocol — Authentication.
 *
 * API keys use the format `bap_{base64url(24 random bytes)}` (~36 chars).
 * Stored as bcrypt hash in DB; only the first 12 chars (prefix) are stored
 * in plaintext for efficient lookup without a full table scan.
 */
import crypto from 'crypto';
import db from '../db/db.js';

// ─── Key generation ─────────────────────────────────────────────────────────

export function generateApiKey() {
  const random = crypto.randomBytes(24).toString('base64url');
  return `bap_${random}`;
}

export function keyPrefix(key) {
  return String(key).slice(0, 12);
}

export async function hashApiKey(key) {
  return Bun.password.hash(key, { algorithm: 'bcrypt', cost: 12 });
}

export async function verifyApiKey(rawKey, hash) {
  return Bun.password.verify(rawKey, hash);
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Look up and validate an incoming BAP API key.
 * Returns the agent row or null.
 */
export async function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('bap_')) return null;

  const prefix = keyPrefix(rawKey);
  const agent = db.prepare(
    'SELECT * FROM bap_agents WHERE api_key_prefix = ? AND status = ?'
  ).get(prefix, 'active');

  if (!agent) return null;

  const valid = await verifyApiKey(rawKey, agent.api_key_hash);
  if (!valid) return null;

  // Update last_seen + call counter (non-blocking)
  try {
    db.prepare(
      'UPDATE bap_agents SET last_seen = CURRENT_TIMESTAMP, total_calls = total_calls + 1 WHERE id = ?'
    ).run(agent.id);
  } catch {}

  return agent;
}

// ─── Permissions ────────────────────────────────────────────────────────────

/**
 * Check whether an agent has a specific permission, optionally scoped
 * to a business.
 *
 * @param {Object} agent - row from bap_agents
 * @param {string} permission - e.g. "signals:read", "tasks:propose"
 * @param {string|null} businessId
 * @returns {boolean}
 */
export function hasPermission(agent, permission, businessId = null) {
  const perms = safeJSON(agent.permissions, []);
  const access = safeJSON(agent.business_access, []);

  // Business access check
  if (businessId) {
    if (!access.includes('*') && !access.includes(businessId)) return false;
  }

  // Permission check — supports wildcards
  const [resource, action] = permission.split(':');
  return (
    perms.includes(permission) ||
    perms.includes(`${resource}:*`) ||
    perms.includes('*:*')
  );
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Express middleware — validates BAP-Key header, attaches req.bapAgent,
 * logs the call to bap_audit on response finish.
 */
export async function bapAuth(req, res, next) {
  const rawKey =
    req.headers['bap-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  if (!rawKey) {
    return res.status(401).json({ error: 'BAP-Key header required.' });
  }

  const agent = await validateApiKey(rawKey);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid or revoked API key.' });
  }

  req.bapAgent = agent;

  // Audit log on response finish
  const auditId = crypto.randomUUID();
  const start = Date.now();

  res.on('finish', () => {
    try {
      db.prepare(`
        INSERT INTO bap_audit (id, agent_id, method, endpoint, business_id,
                               status_code, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        auditId,
        agent.id,
        req.method,
        req.path,
        req.params?.businessId ?? null,
        res.statusCode,
        Date.now() - start
      );
    } catch {}
  });

  next();
}

/**
 * Middleware factory — checks a specific permission.
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    const businessId = req.params?.businessId ?? req.body?.businessId ?? null;
    if (!hasPermission(req.bapAgent, permission, businessId)) {
      return res.status(403).json({
        error: `Permission denied: ${permission}`,
        your_permissions: safeJSON(req.bapAgent.permissions, []),
      });
    }
    next();
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeJSON(val, fallback = []) {
  if (Array.isArray(val)) return val;
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}
