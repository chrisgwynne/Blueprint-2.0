/**
 * Blueprint Agent Protocol — Authentication.
 *
 * API keys use the format `bap_{base64url(24 random bytes)}` (~36 chars).
 * Stored as bcrypt hash in DB; only the first 12 chars (prefix) are stored
 * in plaintext for efficient lookup without a full table scan.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import type { Request, Response, NextFunction } from 'express';

// ─── Registration authorization ──────────────────────────────────────────────
//
// POST /register used to be fully open — anyone who could reach the HTTP
// port could self-register a BAP key with arbitrary requested permissions.
// It now requires ONE of:
//   (a) an authenticated dashboard session (the operator registering an
//       agent on their own behalf), or
//   (b) a shared `X-Registration-Secret` header matching the operator-
//       configured BAP_REGISTRATION_SECRET env var, for bootstrapping a
//       fully external agent (e.g. Hermes) that has no browser session.
// If BAP_REGISTRATION_SECRET is unset, only path (a) is available — this
// is the safe-by-default state with zero extra configuration.

export function isRegistrationAuthorized(req: Request): boolean {
  const sessionAuthed = Boolean((req.session as { userId?: unknown } | undefined)?.userId);
  if (sessionAuthed) return true;

  const configuredSecret = process.env.BAP_REGISTRATION_SECRET;
  if (!configuredSecret) return false;

  const provided = req.headers['x-registration-secret'];
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(configuredSecret);
  if (a.length !== b.length) return false; // avoid throwing in timingSafeEqual
  return crypto.timingSafeEqual(a, b);
}

export function requireRegistrationAuth(req: Request, res: Response, next: NextFunction): void {
  if (isRegistrationAuthorized(req)) return next();
  res.status(401).json({
    error:
      'Registration requires an authenticated dashboard session, or a valid X-Registration-Secret ' +
      'header matching the operator-configured BAP_REGISTRATION_SECRET. Self-service, unauthenticated ' +
      'registration is no longer permitted.',
  });
}

// ─── Grantable permissions ───────────────────────────────────────────────────
//
// Self-registration can never grant a wildcard permission (`*:*`,
// `resource:*`) or wildcard business access (`*`), regardless of what the
// caller requests or how they authenticated to /register. This is a hard
// floor, not a default — an operator who wants to grant broader access to
// a highly trusted agent already has full database/dashboard access to do
// so directly; the self-registration endpoint itself never grants it.
export const GRANTABLE_BAP_PERMISSIONS: readonly string[] = [
  'signals:read', 'signals:create',
  'tasks:read', 'tasks:propose', 'tasks:approve',
  'kb:read', 'kb:write',
  'metrics:read',
  'agents:read', 'agents:trigger',
];

export function filterGrantablePermissions(requested: unknown): string[] {
  if (!Array.isArray(requested)) return [];
  const allow = new Set(GRANTABLE_BAP_PERMISSIONS);
  return Array.from(new Set(requested.filter((p): p is string => typeof p === 'string' && allow.has(p))));
}

/**
 * Filter caller-supplied business IDs down to businesses that actually
 * exist. Silently drops '*' (wildcard business access is never granted by
 * self-registration) and unknown IDs. Returns [] (no access yet) rather
 * than erroring, so registration always succeeds — an operator can grant
 * access afterwards.
 */
export function filterValidBusinessIds(requested: unknown): string[] {
  if (!Array.isArray(requested)) return [];
  const ids = Array.from(new Set(requested.filter((b): b is string => typeof b === 'string' && b !== '*')));
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM businesses WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string }>;
  const valid = new Set(rows.map((r) => r.id));
  return ids.filter((id) => valid.has(id));
}

// ─── Key generation ─────────────────────────────────────────────────────────

export function generateApiKey(): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `bap_${random}`;
}

export function keyPrefix(key: string): string {
  return String(key).slice(0, 12);
}

export async function hashApiKey(key: string): Promise<string> {
  return Bun.password.hash(key, { algorithm: 'bcrypt', cost: 12 });
}

export async function verifyApiKey(rawKey: string, hash: string): Promise<boolean> {
  return Bun.password.verify(rawKey, hash);
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Look up and validate an incoming BAP API key.
 * Returns the agent row or null.
 */
export async function validateApiKey(rawKey: string): Promise<Record<string, unknown> | null> {
  if (!rawKey || !rawKey.startsWith('bap_')) return null;

  const prefix = keyPrefix(rawKey);
  const agent = db.prepare(
    'SELECT * FROM bap_agents WHERE api_key_prefix = ? AND status = ?'
  ).get(prefix, 'active') as Record<string, unknown> | null;

  if (!agent) return null;

  const valid = await verifyApiKey(rawKey, agent.api_key_hash as string);
  if (!valid) return null;

  // Update last_seen + call counter (non-blocking)
  try {
    db.prepare(
      'UPDATE bap_agents SET last_seen = CURRENT_TIMESTAMP, total_calls = total_calls + 1 WHERE id = ?'
    ).run(agent.id as string);
  } catch {}

  return agent;
}

// ─── Permissions ────────────────────────────────────────────────────────────

/**
 * Check whether an agent has a specific permission, optionally scoped
 * to a business.
 *
 * @param agent - row from bap_agents
 * @param permission - e.g. "signals:read", "tasks:propose"
 * @param businessId
 */
export function hasPermission(
  agent: Record<string, unknown>,
  permission: string,
  businessId: string | null = null
): boolean {
  const perms = safeJSON<string[]>(agent.permissions, []);
  const access = safeJSON<string[]>(agent.business_access, []);

  // Business access check
  if (businessId) {
    if (!access.includes('*') && !access.includes(businessId)) return false;
  }

  // Permission check — supports wildcards
  const [resource] = permission.split(':');
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
export async function bapAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Admin UI routes are mounted alongside BAP on the same router but use
  // session auth (isAuthenticated), not BAP-Key. Skip BAP auth for them so
  // the Settings → External Agents page can load without a BAP key.
  if (req.path.startsWith('/agents-admin')) return next();

  const rawKey =
    (req.headers['bap-key'] as string | undefined) ||
    (req.headers['authorization'] as string | undefined)?.replace(/^Bearer\s+/i, '');

  if (!rawKey) {
    res.status(401).json({ error: 'BAP-Key header required.' });
    return;
  }

  const agent = await validateApiKey(rawKey);
  if (!agent) {
    res.status(401).json({ error: 'Invalid or revoked API key.' });
    return;
  }

  (req as Request & { bapAgent: Record<string, unknown> }).bapAgent = agent;

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
        agent.id as string,
        req.method,
        req.path,
        (req.params as Record<string, string>)?.businessId ?? null,
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
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bapReq = req as Request & { bapAgent: Record<string, unknown> };
    const businessId =
      (req.params as Record<string, string>)?.businessId ??
      (req.body as Record<string, string>)?.businessId ??
      null;
    if (!hasPermission(bapReq.bapAgent, permission, businessId)) {
      res.status(403).json({
        error: `Permission denied: ${permission}`,
        your_permissions: safeJSON(bapReq.bapAgent.permissions, []),
      });
      return;
    }
    next();
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeJSON<T = unknown[]>(val: unknown, fallback: T): T {
  if (Array.isArray(val)) return val as unknown as T;
  if (!val) return fallback;
  try { return JSON.parse(val as string) as T; } catch { return fallback; }
}
