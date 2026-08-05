/**
 * Secure, signed, expiring, one-time OAuth state for the social connector.
 *
 * Protects against:
 *   - CSRF (state is unguessable)
 *   - Cross-business substitution (businessId bound in signature)
 *   - Session hijacking (userId bound in signature)
 *   - State tampering (HMAC-SHA256 signature covers the entire payload)
 *   - Replay attacks (nonce consumed on first use, stored in-process map with TTL)
 *   - Expiry (state has a short TTL, default 10 minutes)
 */
import crypto from 'crypto';
import db, { generateId } from '../../db/db.js';

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

export interface OAuthStatePayload {
  businessId: string;
  userId: string;
  type: string;
  family?: string;
  types?: string[];
  sessionHash?: string;
  config?: Record<string, unknown>;
}

interface InternalStatePayload extends OAuthStatePayload {
  nonce: string;
  expiresAt: number;
}

const DEFAULT_TTL_SECONDS = 600; // 10 minutes

function getHmacKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 10) {
    throw new OAuthStateError('SESSION_SECRET is required to generate OAuth state.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function sign(payload: InternalStatePayload): string {
  const key = getHmacKey();
  const data = JSON.stringify(payload);
  const encoded = Buffer.from(data).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verify(token: string): InternalStatePayload {
  const dot = token.lastIndexOf('.');
  if (dot < 1) throw new OAuthStateError('Invalid state format.');
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = getHmacKey();
  const expectedSig = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  const actual = Buffer.from(sig);
  const expected = Buffer.from(expectedSig);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new OAuthStateError('State signature invalid — possible tampering or wrong key.');
  }

  let payload: InternalStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new OAuthStateError('State payload could not be decoded.');
  }
  return payload;
}

// oauth_nonces table is created by db.ts STARTUP_MIGRATIONS (no lazy init needed)

/**
 * Create a signed, expiring OAuth state token.
 * @param payload - The state payload (businessId, userId, type)
 * @param ttlSeconds - Token TTL in seconds (default 600 = 10 minutes)
 */
export async function createOAuthState(
  payload: OAuthStatePayload,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  // Eagerly validate config so callers get a clear error on startup
  getHmacKey();
  if (payload.types !== undefined) {
    if (!Array.isArray(payload.types) || payload.types.length === 0 || payload.types.some(type => typeof type !== 'string' || !type.trim())) {
      throw new OAuthStateError('OAuth state connector types must be a non-empty array.');
    }
    const normalized = payload.types.map(type => type.trim());
    if (new Set(normalized).size !== normalized.length) throw new OAuthStateError('OAuth state connector types must not contain duplicates.');
    payload = { ...payload, types: normalized };
  }

  const nonce = generateId();
  const expiresAt = Date.now() + ttlSeconds * 1000;


  db.prepare(
    `INSERT INTO oauth_nonces (nonce, expires_at) VALUES (?, ?)`,
  ).run(nonce, new Date(expiresAt).toISOString());

  const internal: InternalStatePayload = { ...payload, nonce, expiresAt };
  return sign(internal);
}

/**
 * Validate a signed OAuth state token.
 * Throws OAuthStateError on any failure.
 *
 * @param token - The raw state string from the OAuth callback
 * @param expectedUserId - The userId that initiated the flow (from session)
 * @param expectedBusinessId - The businessId the flow was initiated for
 * @returns The original OAuthStatePayload on success
 */
export async function validateOAuthState(
  token: string,
  expectedUserId: string,
  expectedBusinessId: string,
  options: { expectedType?: string; expectedFamily?: string; expectedTypes?: string[]; expectedSessionHash?: string } = {},
): Promise<OAuthStatePayload> {
  let payload: InternalStatePayload;
  try {
    payload = verify(token);
  } catch (err) {
    throw err instanceof OAuthStateError ? err : new OAuthStateError(String(err));
  }

  if (payload.expiresAt < Date.now()) {
    throw new OAuthStateError('OAuth state has expired. Please restart the authorisation flow.');
  }

  if (payload.userId !== expectedUserId) {
    throw new OAuthStateError('OAuth state was not initiated by this user (session mismatch).');
  }

  if (payload.businessId !== expectedBusinessId) {
    throw new OAuthStateError('OAuth state business does not match the expected business (cross-business substitution attempt).');
  }

  if (options.expectedType && payload.type !== options.expectedType) {
    throw new OAuthStateError('OAuth state connector type does not match this callback.');
  }

  if (options.expectedFamily && payload.family !== options.expectedFamily) {
    throw new OAuthStateError('OAuth state connector family does not match this callback.');
  }

  if (options.expectedSessionHash && payload.sessionHash !== options.expectedSessionHash) {
    throw new OAuthStateError('OAuth state live session does not match this callback.');
  }

  if (options.expectedTypes !== undefined) {
    const actualTypes = payload.types;
    if (!Array.isArray(actualTypes) || actualTypes.length === 0 || actualTypes.some(type => typeof type !== 'string' || !type.trim())) {
      throw new OAuthStateError('OAuth state connector types must be a non-empty exact set.');
    }
    const actual = actualTypes.map(type => type.trim());
    const expected = options.expectedTypes.map(type => type.trim());
    if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length || expected.length === 0) {
      throw new OAuthStateError('OAuth state connector types must be a non-empty exact set without duplicates.');
    }
    const actualSorted = [...actual].sort();
    const expectedSorted = [...expected].sort();
    if (actualSorted.length !== expectedSorted.length || actualSorted.some((type, index) => type !== expectedSorted[index])) {
      throw new OAuthStateError('OAuth state connector types do not exactly match this callback.');
    }
  }

  // Atomic one-time consumption: only one concurrent process can succeed.
  // UPDATE WHERE used_at IS NULL + changes===1 prevents replay under concurrent requests
  // (SELECT-then-UPDATE would allow two processes to both observe unused_at=NULL and both succeed).
  const nowIso = new Date().toISOString();
  const consumed = db.prepare(
    `UPDATE oauth_nonces SET used_at = CURRENT_TIMESTAMP
     WHERE nonce = ? AND used_at IS NULL AND expires_at > ?`,
  ).run(payload.nonce, nowIso);

  if (consumed.changes !== 1) {
    // Distinguish between "unknown", "already used" and "expired" for user-facing messages.
    // This read is safe: even if a concurrent request reads "used_at IS NULL" here,
    // it will also fail the atomic UPDATE above and reach this diagnostic branch.
    const row = db.prepare(
      `SELECT used_at, expires_at FROM oauth_nonces WHERE nonce = ?`,
    ).get(payload.nonce) as { used_at: string | null; expires_at: string } | null;

    if (!row) {
      throw new OAuthStateError('OAuth state nonce is unknown or has already expired (replay prevention).');
    }
    if (row.used_at) {
      throw new OAuthStateError('OAuth state nonce has already been used (replay attempt).');
    }
    throw new OAuthStateError('OAuth state nonce has expired.');
  }

  return {
    businessId: payload.businessId,
    userId: payload.userId,
    type: payload.type,
    family: payload.family,
    types: payload.types,
    sessionHash: payload.sessionHash,
    config: payload.config,
  };
}

/** Housekeeping — prune consumed/expired nonces. Call from scheduler. */
export function pruneExpiredNonces(): number {

  const nowIso = new Date().toISOString();
  const result = db.prepare(`DELETE FROM oauth_nonces WHERE expires_at < ?`).run(nowIso);
  return result.changes ?? 0;
}
